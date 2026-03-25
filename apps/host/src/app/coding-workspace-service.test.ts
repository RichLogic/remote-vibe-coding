import test from 'node:test';
import assert from 'node:assert/strict';

import type {
  CreateCodingWorkspaceRequest,
  ReorderCodingWorkspacesRequest,
  UpdateCodingWorkspaceRequest,
} from '../coding/types.js';
import type { UserRecord, WorkspaceSummary } from '../types.js';
import {
  CodingWorkspaceServiceError,
  createCodingWorkspaceService,
} from './coding-workspace-service.js';

type CodingWorkspaceServiceOptions = Parameters<typeof createCodingWorkspaceService>[0];

function buildUser(): UserRecord {
  return {
    id: 'user-1',
    username: 'owner',
    roles: ['developer'],
    preferredMode: 'developer',
    isAdmin: false,
    allowedSessionTypes: ['code'],
    canUseFullHost: false,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

function buildWorkspace(id: string, overrides?: Partial<WorkspaceSummary>): WorkspaceSummary {
  return {
    id,
    name: id,
    path: `/tmp/${id}`,
    visible: true,
    sortOrder: 0,
    ...overrides,
  };
}

function createHarness() {
  const createGitCalls: Array<{ username: string; userId: string; gitUrl: string }> = [];
  const ensureCalls: Array<{ username: string; userId: string; workspaceName: string }> = [];
  const updateCalls: Array<{ workspaceId: string; patch: Partial<WorkspaceSummary> }> = [];
  const reorderCalls: Array<{ userId: string; workspaceIds: string[] }> = [];
  const workspaces = [
    buildWorkspace('workspace-1', { sortOrder: 0 }),
    buildWorkspace('workspace-2', { sortOrder: 1 }),
  ];

  const options: CodingWorkspaceServiceOptions = {
    async cloneWorkspaceFromGit(username, userId, gitUrl) {
      createGitCalls.push({ username, userId, gitUrl });
      return buildWorkspace('workspace-git');
    },
    async ensureUserWorkspace(username, userId, workspaceName) {
      ensureCalls.push({ username, userId, workspaceName });
      return buildWorkspace('workspace-empty', { name: workspaceName, path: `/tmp/${workspaceName}` });
    },
    async listUserWorkspaces() {
      return {
        root: '/tmp',
        workspaces,
      };
    },
    async updateWorkspace(workspaceId, patch) {
      updateCalls.push({ workspaceId, patch });
      return buildWorkspace(workspaceId, patch);
    },
    async reorderWorkspaces(userId, workspaceIds) {
      reorderCalls.push({ userId, workspaceIds });
      return workspaceIds.map((workspaceId, index) => buildWorkspace(workspaceId, { sortOrder: index }));
    },
    normalizeWorkspaceFolderName: (value) => {
      const next = typeof value === 'string' ? value.trim() : '';
      return next && !next.includes('/') ? next : null;
    },
    trimOptional: (value) => {
      const next = typeof value === 'string' ? value.trim() : '';
      return next || null;
    },
    errorMessage: (error) => error instanceof Error ? error.message : String(error),
  };

  return {
    createGitCalls,
    ensureCalls,
    updateCalls,
    reorderCalls,
    service: createCodingWorkspaceService(options),
    options,
  };
}

test('coding workspace service creates empty workspaces and returns refreshed state', async () => {
  const harness = createHarness();
  const result = await harness.service.createWorkspace(buildUser(), {
    name: 'repo',
  } as CreateCodingWorkspaceRequest);

  assert.deepEqual(harness.ensureCalls, [{
    username: 'owner',
    userId: 'user-1',
    workspaceName: 'repo',
  }]);
  assert.equal(result.workspace.name, 'repo');
  assert.equal(result.workspaceState.root, '/tmp');
  assert.equal(result.workspaceState.workspaces.length, 2);
});

test('coding workspace service requires a git url for git imports', async () => {
  const harness = createHarness();

  await assert.rejects(
    harness.service.createWorkspace(buildUser(), {
      source: 'git',
    } as CreateCodingWorkspaceRequest),
    (error: unknown) => {
      assert.ok(error instanceof CodingWorkspaceServiceError);
      assert.equal(error.statusCode, 400);
      assert.equal(error.message, 'Git repository URL is required.');
      return true;
    },
  );
});

test('coding workspace service creates git workspaces', async () => {
  const harness = createHarness();
  const result = await harness.service.createWorkspace(buildUser(), {
    source: 'git',
    gitUrl: ' https://github.com/openai/example.git ',
  } as CreateCodingWorkspaceRequest);

  assert.deepEqual(harness.createGitCalls, [{
    username: 'owner',
    userId: 'user-1',
    gitUrl: 'https://github.com/openai/example.git',
  }]);
  assert.equal(result.workspace.id, 'workspace-git');
});

test('coding workspace service maps create conflicts to 409', async () => {
  const harness = createHarness();
  const service = createCodingWorkspaceService({
    ...harness.options,
    async ensureUserWorkspace() {
      throw new Error('workspace already exists');
    },
  });

  await assert.rejects(
    service.createWorkspace(buildUser(), { name: 'repo' } as CreateCodingWorkspaceRequest),
    (error: unknown) => {
      assert.ok(error instanceof CodingWorkspaceServiceError);
      assert.equal(error.statusCode, 409);
      assert.equal(error.message, 'workspace already exists');
      return true;
    },
  );
});

test('coding workspace service updates visibility and refreshes workspace state', async () => {
  const harness = createHarness();
  const result = await harness.service.updateWorkspace(
    buildUser(),
    buildWorkspace('workspace-1'),
    { visible: false } as UpdateCodingWorkspaceRequest,
  );

  assert.deepEqual(harness.updateCalls, [{
    workspaceId: 'workspace-1',
    patch: { visible: false },
  }]);
  assert.equal(result.workspace.visible, false);
  assert.equal(result.workspaceState.workspaces.length, 2);
});

test('coding workspace service raises 404 when updates lose the workspace', async () => {
  const harness = createHarness();
  const service = createCodingWorkspaceService({
    ...harness.options,
    async updateWorkspace() {
      return null;
    },
  });

  await assert.rejects(
    service.updateWorkspace(
      buildUser(),
      buildWorkspace('workspace-1'),
      {} as UpdateCodingWorkspaceRequest,
    ),
    (error: unknown) => {
      assert.ok(error instanceof CodingWorkspaceServiceError);
      assert.equal(error.statusCode, 404);
      assert.equal(error.message, 'Workspace not found.');
      return true;
    },
  );
});

test('coding workspace service rejects duplicate reorder payloads', async () => {
  const harness = createHarness();

  await assert.rejects(
    harness.service.reorderWorkspaceList(buildUser(), {
      workspaceIds: ['workspace-1', 'workspace-1'],
    } as ReorderCodingWorkspacesRequest),
    /contains duplicates/i,
  );
});

test('coding workspace service rejects incomplete reorder payloads', async () => {
  const harness = createHarness();

  await assert.rejects(
    harness.service.reorderWorkspaceList(buildUser(), {
      workspaceIds: ['workspace-1'],
    } as ReorderCodingWorkspacesRequest),
    /include every workspace exactly once/i,
  );
});

test('coding workspace service reorders workspace lists', async () => {
  const harness = createHarness();
  const result = await harness.service.reorderWorkspaceList(buildUser(), {
    workspaceIds: ['workspace-2', 'workspace-1'],
  } as ReorderCodingWorkspacesRequest);

  assert.deepEqual(harness.reorderCalls, [{
    userId: 'user-1',
    workspaceIds: ['workspace-2', 'workspace-1'],
  }]);
  assert.equal(result.workspaceRoot, '/tmp');
  assert.deepEqual(result.workspaces.map((workspace) => workspace.id), ['workspace-2', 'workspace-1']);
});
