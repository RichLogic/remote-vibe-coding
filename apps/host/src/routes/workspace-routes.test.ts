import test from 'node:test';
import assert from 'node:assert/strict';

import Fastify from 'fastify';

import { registerWorkspaceRoutes } from './workspace-routes.js';
import type { UserRecord, WorkspaceSummary } from '../types.js';

function buildUser(overrides: Partial<UserRecord> = {}): UserRecord {
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
    ...overrides,
  };
}

function buildWorkspace(id = 'workspace-1', overrides: Partial<WorkspaceSummary> = {}): WorkspaceSummary {
  return {
    id,
    name: id,
    path: `/tmp/${id}`,
    visible: true,
    sortOrder: 0,
    ...overrides,
  };
}

function createHarness(overrides: Partial<Parameters<typeof registerWorkspaceRoutes>[1]> = {}) {
  const ensureCalls: Array<{ username: string; userId: string; workspaceName: string }> = [];
  const updateCalls: Array<{ workspaceId: string; patch: Partial<WorkspaceSummary> }> = [];
  const user = buildUser();

  const deps: Parameters<typeof registerWorkspaceRoutes>[1] = {
    getRequestUser: () => user,
    userCanUseMode: (currentUser, mode) => currentUser.roles.includes('developer') && mode === 'developer',
    userWorkspaceRoot: (username, userId) => `/workspaces/${username}-${userId}`,
    listUserWorkspaces: async () => ({
      root: '/workspaces/owner-user-1',
      workspaces: [buildWorkspace()],
    }),
    normalizeWorkspaceFolderName: (value) => {
      const next = typeof value === 'string' ? value.trim() : '';
      return next || null;
    },
    ensureUserWorkspace: async (username, userId, workspaceName) => {
      ensureCalls.push({ username, userId, workspaceName });
      return buildWorkspace('workspace-2', { name: workspaceName, path: `/tmp/${workspaceName}` });
    },
    errorMessage: (error) => error instanceof Error ? error.message : String(error),
    getOwnedWorkspace: async () => buildWorkspace(),
    updateWorkspace: async (workspaceId, patch) => {
      updateCalls.push({ workspaceId, patch });
      return buildWorkspace(workspaceId, patch);
    },
    ...overrides,
  };

  return {
    app: Fastify(),
    deps,
    ensureCalls,
    updateCalls,
  };
}

test('workspace routes return an empty workspace list for non-developers', async (t) => {
  const harness = createHarness({
    getRequestUser: () => buildUser({
      roles: ['user'],
      preferredMode: 'chat',
      allowedSessionTypes: ['chat'],
    }),
    userCanUseMode: () => false,
  });
  registerWorkspaceRoutes(harness.app, harness.deps);
  t.after(() => harness.app.close());

  const response = await harness.app.inject({
    method: 'GET',
    url: '/api/workspaces',
  });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), {
    workspaceRoot: '/workspaces/owner-user-1',
    workspaces: [],
  });
});

test('workspace routes create workspaces and refresh state', async (t) => {
  const harness = createHarness();
  registerWorkspaceRoutes(harness.app, harness.deps);
  t.after(() => harness.app.close());

  const response = await harness.app.inject({
    method: 'POST',
    url: '/api/workspaces',
    payload: { name: 'repo' },
  });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(harness.ensureCalls, [{
    username: 'owner',
    userId: 'user-1',
    workspaceName: 'repo',
  }]);
  assert.equal(response.json().workspace.name, 'repo');
});

test('workspace routes validate workspace sort order updates', async (t) => {
  const harness = createHarness();
  registerWorkspaceRoutes(harness.app, harness.deps);
  t.after(() => harness.app.close());

  const response = await harness.app.inject({
    method: 'PATCH',
    url: '/api/workspaces/workspace-1',
    payload: { sortOrder: 'invalid' },
  });

  assert.equal(response.statusCode, 400);
  assert.deepEqual(response.json(), {
    error: 'Workspace sort order must be a number.',
  });
  assert.equal(harness.updateCalls.length, 0);
});
