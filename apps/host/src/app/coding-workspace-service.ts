import type {
  CreateCodingWorkspaceRequest,
  ReorderCodingWorkspacesRequest,
  UpdateCodingWorkspaceRequest,
} from '../coding/types.js';
import type { UserRecord, WorkspaceSummary } from '../types.js';

export class CodingWorkspaceServiceError extends Error {
  constructor(message: string, readonly statusCode: number) {
    super(message);
    this.name = 'CodingWorkspaceServiceError';
  }
}

interface WorkspaceState {
  root: string;
  workspaces: WorkspaceSummary[];
}

interface CreateCodingWorkspaceServiceOptions {
  cloneWorkspaceFromGit: (username: string, userId: string, gitUrl: string) => Promise<WorkspaceSummary>;
  ensureUserWorkspace: (username: string, userId: string, workspaceName: string) => Promise<WorkspaceSummary>;
  listUserWorkspaces: (username: string, userId: string) => Promise<WorkspaceState>;
  updateWorkspace: (
    workspaceId: string,
    patch: Partial<WorkspaceSummary>,
  ) => Promise<WorkspaceSummary | null>;
  reorderWorkspaces: (userId: string, workspaceIds: string[]) => Promise<WorkspaceSummary[]>;
  normalizeWorkspaceFolderName: (value: unknown) => string | null;
  trimOptional: (value: unknown) => string | null;
  errorMessage: (error: unknown) => string;
}

export function createCodingWorkspaceService(options: CreateCodingWorkspaceServiceOptions) {
  async function createWorkspace(currentUser: UserRecord, input: CreateCodingWorkspaceRequest) {
    const source = input.source === 'git' ? 'git' : 'empty';

    try {
      const workspace = source === 'git'
        ? await createGitWorkspace(currentUser, input)
        : await createEmptyWorkspace(currentUser, input);
      const workspaceState = await options.listUserWorkspaces(currentUser.username, currentUser.id);
      return {
        workspace,
        workspaceState,
      };
    } catch (error) {
      if (error instanceof CodingWorkspaceServiceError) {
        throw error;
      }
      const message = options.errorMessage(error);
      throw new CodingWorkspaceServiceError(message, message.includes('already exists') ? 409 : 400);
    }
  }

  async function updateWorkspace(
    currentUser: UserRecord,
    workspace: WorkspaceSummary,
    input: UpdateCodingWorkspaceRequest,
  ) {
    const patch: Partial<WorkspaceSummary> = {};
    if (Object.prototype.hasOwnProperty.call(input, 'visible')) {
      patch.visible = Boolean(input.visible);
    }

    const nextWorkspace = await options.updateWorkspace(workspace.id, patch);
    if (!nextWorkspace) {
      throw new CodingWorkspaceServiceError('Workspace not found.', 404);
    }

    const workspaceState = await options.listUserWorkspaces(currentUser.username, currentUser.id);
    return {
      workspace: nextWorkspace,
      workspaceState,
    };
  }

  async function reorderWorkspaceList(currentUser: UserRecord, input: ReorderCodingWorkspacesRequest) {
    const nextWorkspaceIds = Array.isArray(input.workspaceIds)
      ? input.workspaceIds.filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
      : [];
    const workspaceState = await options.listUserWorkspaces(currentUser.username, currentUser.id);
    const currentWorkspaceIds = workspaceState.workspaces.map((workspace) => workspace.id);

    if (new Set(nextWorkspaceIds).size !== nextWorkspaceIds.length) {
      throw new CodingWorkspaceServiceError('Workspace order contains duplicates.', 400);
    }

    if (
      nextWorkspaceIds.length !== currentWorkspaceIds.length
      || nextWorkspaceIds.some((workspaceId) => !currentWorkspaceIds.includes(workspaceId))
    ) {
      throw new CodingWorkspaceServiceError('Workspace order must include every workspace exactly once.', 400);
    }

    const workspaces = await options.reorderWorkspaces(currentUser.id, nextWorkspaceIds);
    return {
      workspaceRoot: workspaceState.root,
      workspaces,
    };
  }

  async function createGitWorkspace(currentUser: UserRecord, input: CreateCodingWorkspaceRequest) {
    const gitUrl = options.trimOptional(input.gitUrl);
    if (!gitUrl) {
      throw new CodingWorkspaceServiceError('Git repository URL is required.', 400);
    }
    return options.cloneWorkspaceFromGit(currentUser.username, currentUser.id, gitUrl);
  }

  async function createEmptyWorkspace(currentUser: UserRecord, input: CreateCodingWorkspaceRequest) {
    const workspaceName = options.normalizeWorkspaceFolderName(input.name);
    if (!workspaceName) {
      throw new CodingWorkspaceServiceError('Workspace name is required.', 400);
    }
    return options.ensureUserWorkspace(currentUser.username, currentUser.id, workspaceName);
  }

  return {
    createWorkspace,
    updateWorkspace,
    reorderWorkspaceList,
  };
}
