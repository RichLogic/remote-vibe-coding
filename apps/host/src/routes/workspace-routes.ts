import { type FastifyInstance, type FastifyRequest } from 'fastify';

import type { CreateWorkspaceRequest, UpdateWorkspaceRequest, UserRecord, WorkspaceSummary } from '../types.js';

interface WorkspaceRoutesDependencies {
  getRequestUser: (request: FastifyRequest) => UserRecord;
  userCanUseMode: (user: UserRecord, mode: 'chat' | 'developer') => boolean;
  userWorkspaceRoot: (username: string, userId: string) => string;
  listUserWorkspaces: (username: string, userId: string) => Promise<{
    root: string;
    workspaces: WorkspaceSummary[];
  }>;
  normalizeWorkspaceFolderName: (value: unknown) => string | null;
  ensureUserWorkspace: (
    username: string,
    userId: string,
    workspaceName: string,
  ) => Promise<WorkspaceSummary>;
  errorMessage: (error: unknown) => string;
  getOwnedWorkspace: (workspaceId: string, userId: string) => Promise<WorkspaceSummary | null>;
  updateWorkspace: (
    workspaceId: string,
    patch: Partial<WorkspaceSummary>,
  ) => Promise<WorkspaceSummary | null>;
}

export function registerWorkspaceRoutes(app: FastifyInstance, deps: WorkspaceRoutesDependencies) {
  app.get('/api/workspaces', async (request) => {
    const currentUser = deps.getRequestUser(request);
    if (!deps.userCanUseMode(currentUser, 'developer')) {
      return {
        workspaceRoot: deps.userWorkspaceRoot(currentUser.username, currentUser.id),
        workspaces: [],
      };
    }
    const workspaceState = await deps.listUserWorkspaces(currentUser.username, currentUser.id);
    return {
      workspaceRoot: workspaceState.root,
      workspaces: workspaceState.workspaces,
    };
  });

  app.post('/api/workspaces', async (request, reply) => {
    const currentUser = deps.getRequestUser(request);
    if (!deps.userCanUseMode(currentUser, 'developer')) {
      reply.code(403);
      return { error: 'Developer access required.' };
    }
    const body = (request.body ?? {}) as CreateWorkspaceRequest;
    const workspaceName = deps.normalizeWorkspaceFolderName(body.name);
    if (!workspaceName) {
      reply.code(400);
      return { error: 'Workspace name is required.' };
    }

    try {
      const workspace = await deps.ensureUserWorkspace(currentUser.username, currentUser.id, workspaceName);
      const workspaceState = await deps.listUserWorkspaces(currentUser.username, currentUser.id);
      return {
        workspace,
        workspaceRoot: workspaceState.root,
        workspaces: workspaceState.workspaces,
      };
    } catch (error) {
      reply.code(400);
      return { error: deps.errorMessage(error) };
    }
  });

  app.patch('/api/workspaces/:workspaceId', async (request, reply) => {
    const currentUser = deps.getRequestUser(request);
    if (!deps.userCanUseMode(currentUser, 'developer')) {
      reply.code(403);
      return { error: 'Developer access required.' };
    }

    const { workspaceId } = request.params as { workspaceId: string };
    const workspace = await deps.getOwnedWorkspace(workspaceId, currentUser.id);
    if (!workspace) {
      reply.code(404);
      return { error: 'Workspace not found.' };
    }

    const body = (request.body ?? {}) as UpdateWorkspaceRequest;
    const patch: Partial<WorkspaceSummary> = {};

    if (Object.prototype.hasOwnProperty.call(body, 'visible')) {
      patch.visible = Boolean(body.visible);
    }
    if (Object.prototype.hasOwnProperty.call(body, 'sortOrder')) {
      if (typeof body.sortOrder !== 'number' || !Number.isFinite(body.sortOrder)) {
        reply.code(400);
        return { error: 'Workspace sort order must be a number.' };
      }
      patch.sortOrder = Math.max(0, Math.trunc(body.sortOrder));
    }

    const nextWorkspace = await deps.updateWorkspace(workspace.id, patch);
    if (!nextWorkspace) {
      reply.code(404);
      return { error: 'Workspace not found.' };
    }

    const workspaceState = await deps.listUserWorkspaces(currentUser.username, currentUser.id);
    return {
      workspace: nextWorkspace,
      workspaceRoot: workspaceState.root,
      workspaces: workspaceState.workspaces,
    };
  });
}
