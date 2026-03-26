import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { WorkspaceRecord } from '../types.js';
import { createUserWorkspaceService } from './user-workspace-service.js';

function buildWorkspace(
  root: string,
  name: string,
  overrides: Partial<WorkspaceRecord> = {},
): WorkspaceRecord {
  return {
    id: `${name}-id`,
    ownerUserId: 'user-1',
    ownerUsername: 'owner',
    name,
    path: join(root, name),
    visible: true,
    sortOrder: 0,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function normalizeWorkspaceSegment(value: string | null | undefined, fallback: string) {
  const normalized = (value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');

  if (!normalized || normalized === '.' || normalized === '..') {
    return fallback;
  }

  return normalized;
}

test('user workspace service syncs discovered directories with coding records and legacy metadata', async (t) => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'rvc-workspace-sync-'));
  t.after(async () => {
    await rm(workspaceRoot, { recursive: true, force: true });
  });

  const service = createUserWorkspaceService({
    workspaceRoot,
    normalizeWorkspaceSegment,
    normalizeWorkspaceFolderName: (value) => typeof value === 'string' ? value.trim() || null : null,
    ensureWorkspaceExists: async (cwd) => {
      const info = await stat(cwd);
      assert.ok(info.isDirectory());
    },
    cloneWorkspaceInto: async () => {},
    now: () => '2026-01-01T00:00:00.000Z',
    randomId: () => 'generated-id',
  });

  const root = service.userWorkspaceRoot('Owner', 'user-1');
  await mkdir(join(root, 'alpha'), { recursive: true });
  await mkdir(join(root, 'beta'), { recursive: true });
  await mkdir(join(root, '.hidden'), { recursive: true });

  const codingRecords = [
    buildWorkspace(root, 'alpha', {
      id: 'alpha-id',
      ownerUsername: 'Owner',
      sortOrder: 1,
    }),
  ];
  const createCalls: WorkspaceRecord[] = [];

  const result = await service.listUserWorkspaces('Owner', 'user-1', {
    store: {
      listWorkspacesForUser: () => [
        buildWorkspace(root, 'beta', {
          id: 'beta-legacy',
          name: 'Beta Custom',
          visible: false,
          sortOrder: 0,
        }),
      ],
    },
    coding: {
      async listWorkspacesForUser() {
        return [...codingRecords].sort((left, right) => left.sortOrder - right.sortOrder);
      },
      async updateWorkspace() {
        throw new Error('updateWorkspace should not be called in this scenario');
      },
      async createWorkspace(workspace) {
        createCalls.push(workspace);
        codingRecords.push(workspace);
        return workspace;
      },
      async findWorkspaceByPathForUser() {
        return null;
      },
    },
  });

  assert.equal(result.root, root);
  assert.deepEqual(createCalls, [
    buildWorkspace(root, 'beta', {
      id: 'beta-legacy',
      ownerUsername: 'Owner',
      name: 'Beta Custom',
      visible: false,
      sortOrder: 0,
    }),
  ]);
  assert.deepEqual(result.workspaces, [
    {
      id: 'beta-legacy',
      name: 'Beta Custom',
      path: join(root, 'beta'),
      visible: false,
      sortOrder: 0,
    },
    {
      id: 'alpha-id',
      name: 'alpha',
      path: join(root, 'alpha'),
      visible: true,
      sortOrder: 1,
    },
  ]);
});

test('user workspace service provisions missing workspaces on disk and in coding storage', async (t) => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'rvc-workspace-ensure-'));
  t.after(async () => {
    await rm(workspaceRoot, { recursive: true, force: true });
  });

  const service = createUserWorkspaceService({
    workspaceRoot,
    normalizeWorkspaceSegment,
    normalizeWorkspaceFolderName: (value) => typeof value === 'string' ? value.trim() || null : null,
    ensureWorkspaceExists: async (cwd) => {
      const info = await stat(cwd);
      assert.ok(info.isDirectory());
    },
    cloneWorkspaceInto: async () => {},
    now: () => '2026-01-01T00:00:00.000Z',
    randomId: () => 'workspace-new',
  });

  const createdRecords: WorkspaceRecord[] = [];
  const result = await service.ensureUserWorkspace('Owner', 'user-1', 'repo', {
    coding: {
      async listWorkspacesForUser() {
        return createdRecords;
      },
      async updateWorkspace() {
        throw new Error('updateWorkspace should not be called in this scenario');
      },
      async createWorkspace(workspace) {
        createdRecords.push(workspace);
        return workspace;
      },
      async findWorkspaceByPathForUser() {
        return null;
      },
    },
  });

  assert.equal(result.id, 'workspace-new');
  assert.equal(result.name, 'repo');
  assert.ok((await stat(result.path)).isDirectory());
  assert.deepEqual(createdRecords, [
    {
      id: 'workspace-new',
      ownerUserId: 'user-1',
      ownerUsername: 'Owner',
      name: 'repo',
      path: result.path,
      visible: true,
      sortOrder: 0,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    },
  ]);
});
