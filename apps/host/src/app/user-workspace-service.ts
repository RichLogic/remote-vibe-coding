import { mkdir, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

import type { WorkspaceRecord, WorkspaceSummary } from '../types.js';

interface WorkspaceStorePort {
  listWorkspacesForUser(userId: string): Array<WorkspaceRecord>;
}

interface WorkspaceCodingPort {
  listWorkspacesForUser(userId: string): Promise<WorkspaceRecord[]>;
  updateWorkspace(
    workspaceId: string,
    patch: {
      ownerUsername: string;
      name: string;
      visible: boolean;
      sortOrder: number;
      updatedAt: string;
    },
  ): Promise<unknown>;
  createWorkspace(workspace: WorkspaceRecord): Promise<WorkspaceRecord>;
  findWorkspaceByPathForUser(userId: string, path: string): Promise<WorkspaceRecord | null>;
}

interface UserWorkspaceServiceOptions {
  workspaceRoot: string;
  normalizeWorkspaceSegment: (value: string | null | undefined, fallback: string) => string;
  normalizeWorkspaceFolderName: (value: unknown) => string | null;
  ensureWorkspaceExists: (cwd: string) => Promise<void>;
  cloneWorkspaceInto: (gitUrl: string, workspacePath: string) => Promise<void>;
  now?: () => string;
  randomId?: () => string;
}

interface SyncWorkspaceDependencies {
  store: WorkspaceStorePort;
  coding: WorkspaceCodingPort;
}

interface CodingOnlyDependencies {
  coding: WorkspaceCodingPort;
}

function toWorkspaceSummary(record: WorkspaceRecord): WorkspaceSummary {
  return {
    id: record.id,
    name: record.name,
    path: record.path,
    visible: record.visible,
    sortOrder: record.sortOrder,
  };
}

export function createUserWorkspaceService(options: UserWorkspaceServiceOptions) {
  const now = options.now ?? (() => new Date().toISOString());
  const randomId = options.randomId ?? (() => crypto.randomUUID());

  function userWorkspaceRoot(username: string, userId: string) {
    return join(
      options.workspaceRoot,
      options.normalizeWorkspaceSegment(username, `user-${userId.slice(0, 8)}`),
    );
  }

  async function ensureUserWorkspaceRoot(username: string, userId: string) {
    const root = userWorkspaceRoot(username, userId);
    await mkdir(root, { recursive: true });
    return root;
  }

  async function syncUserWorkspaceRecords(
    username: string,
    userId: string,
    dependencies: SyncWorkspaceDependencies,
  ) {
    const root = await ensureUserWorkspaceRoot(username, userId);
    const [existingWorkspaces, legacyWorkspaces, entries] = await Promise.all([
      dependencies.coding.listWorkspacesForUser(userId),
      Promise.resolve(dependencies.store.listWorkspacesForUser(userId)),
      readdir(root, { withFileTypes: true }),
    ]);

    const existingByPath = new Map(existingWorkspaces.map((workspace) => [workspace.path, workspace]));
    const legacyByPath = new Map(
      legacyWorkspaces
        .filter((workspace) => workspace.path.startsWith(`${root}/`))
        .map((workspace) => [workspace.path, workspace]),
    );

    const directories = entries
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
      .map((entry) => {
        const path = join(root, entry.name);
        const existing = existingByPath.get(path) ?? null;
        const legacy = legacyByPath.get(path) ?? null;
        return {
          path,
          existing,
          id: existing?.id ?? legacy?.id ?? randomId(),
          name: existing?.name ?? legacy?.name ?? entry.name,
          visible: existing?.visible ?? legacy?.visible ?? true,
          sortHint: existing?.sortOrder ?? legacy?.sortOrder ?? Number.MAX_SAFE_INTEGER,
          createdAt: existing?.createdAt ?? legacy?.createdAt ?? now(),
          updatedAt: existing?.updatedAt ?? legacy?.updatedAt ?? now(),
        };
      })
      .sort((left, right) => {
        if (left.sortHint !== right.sortHint) {
          return left.sortHint - right.sortHint;
        }
        return left.name.localeCompare(right.name);
      });

    await Promise.all(directories.map(async (directory, index) => {
      if (directory.existing) {
        if (
          directory.existing.ownerUsername === username
          && directory.existing.name === directory.name
          && directory.existing.visible === directory.visible
          && directory.existing.sortOrder === index
        ) {
          return;
        }

        await dependencies.coding.updateWorkspace(directory.existing.id, {
          ownerUsername: username,
          name: directory.name,
          visible: directory.visible,
          sortOrder: index,
          updatedAt: now(),
        });
        return;
      }

      await dependencies.coding.createWorkspace({
        id: directory.id,
        ownerUserId: userId,
        ownerUsername: username,
        name: directory.name,
        path: directory.path,
        visible: directory.visible,
        sortOrder: index,
        createdAt: directory.createdAt,
        updatedAt: directory.updatedAt,
      });
    }));

    return {
      root,
      workspacePaths: new Set(directories.map((directory) => directory.path)),
    };
  }

  async function listUserWorkspaces(
    username: string,
    userId: string,
    dependencies: SyncWorkspaceDependencies,
  ): Promise<{ root: string; workspaces: WorkspaceSummary[] }> {
    const { root, workspacePaths } = await syncUserWorkspaceRecords(username, userId, dependencies);
    const workspaces = (await dependencies.coding.listWorkspacesForUser(userId))
      .filter((workspace) => workspacePaths.has(workspace.path))
      .map(toWorkspaceSummary);
    return { root, workspaces };
  }

  async function ensureUserWorkspace(
    username: string,
    userId: string,
    workspaceName: string,
    dependencies: CodingOnlyDependencies,
  ) {
    const root = await ensureUserWorkspaceRoot(username, userId);
    const workspace = join(root, workspaceName);
    await mkdir(workspace, { recursive: true });
    await options.ensureWorkspaceExists(workspace);
    const existing = await dependencies.coding.findWorkspaceByPathForUser(userId, workspace);
    const timestamp = now();
    const record = existing ?? await dependencies.coding.createWorkspace({
      id: randomId(),
      ownerUserId: userId,
      ownerUsername: username,
      name: workspaceName,
      path: workspace,
      visible: true,
      sortOrder: (await dependencies.coding.listWorkspacesForUser(userId)).length,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    return {
      root,
      ...toWorkspaceSummary(record),
    };
  }

  function workspaceNameFromGitUrl(gitUrl: string) {
    const trimmed = gitUrl.trim();
    const match = trimmed.match(/([^/:]+?)(?:\.git)?$/i);
    if (!match?.[1]) {
      return null;
    }
    return options.normalizeWorkspaceFolderName(match[1]);
  }

  async function cloneWorkspaceFromGit(
    username: string,
    userId: string,
    gitUrl: string,
    dependencies: CodingOnlyDependencies,
  ) {
    const workspaceName = workspaceNameFromGitUrl(gitUrl);
    if (!workspaceName) {
      throw new Error('Could not derive a workspace name from the Git remote.');
    }

    const root = await ensureUserWorkspaceRoot(username, userId);
    const workspacePath = join(root, workspaceName);
    const existing = await dependencies.coding.findWorkspaceByPathForUser(userId, workspacePath);
    if (existing) {
      throw new Error('Workspace already exists.');
    }

    const alreadyExistsOnDisk = await stat(workspacePath)
      .then((info) => info.isDirectory())
      .catch(() => false);
    if (alreadyExistsOnDisk) {
      throw new Error('Workspace folder already exists.');
    }

    await options.cloneWorkspaceInto(gitUrl, workspacePath);
    await options.ensureWorkspaceExists(workspacePath);

    const timestamp = now();
    const record = await dependencies.coding.createWorkspace({
      id: randomId(),
      ownerUserId: userId,
      ownerUsername: username,
      name: workspaceName,
      path: workspacePath,
      visible: true,
      sortOrder: (await dependencies.coding.listWorkspacesForUser(userId)).length,
      createdAt: timestamp,
      updatedAt: timestamp,
    });

    return {
      root,
      ...toWorkspaceSummary(record),
    };
  }

  return {
    userWorkspaceRoot,
    syncUserWorkspaceRecords,
    listUserWorkspaces,
    ensureUserWorkspace,
    cloneWorkspaceFromGit,
  };
}
