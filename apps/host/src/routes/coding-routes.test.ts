import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { URLSearchParams } from 'node:url';

import Fastify from 'fastify';

import { CodingWorkspaceServiceError } from '../app/coding-workspace-service.js';
import { registerCodingRoutes } from './coding-routes.js';
import type { ModelOption, SessionRecord, UserRecord, WorkspaceSummary } from '../types.js';

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

function buildWorkspace(overrides: Partial<WorkspaceSummary> = {}): WorkspaceSummary {
  return {
    id: 'workspace-1',
    name: 'workspace-1',
    path: '/tmp/workspace',
    visible: true,
    sortOrder: 0,
    ...overrides,
  };
}

function buildSession(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id: 'session-1',
    ownerUserId: 'user-1',
    ownerUsername: 'owner',
    sessionType: 'code',
    executor: 'codex',
    workspaceId: 'workspace-1',
    threadId: 'thread-1',
    activeTurnId: 'turn-1',
    title: 'Session 1',
    autoTitle: false,
    workspace: '/tmp/workspace',
    archivedAt: null,
    securityProfile: 'repo-write',
    approvalMode: 'detailed',
    networkEnabled: false,
    fullHostEnabled: false,
    status: 'running',
    lastIssue: null,
    hasTranscript: true,
    model: 'gpt-5',
    reasoningEffort: 'medium',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function buildModelOption(model = 'gpt-5'): ModelOption {
  return {
    id: model,
    displayName: model,
    model,
    description: 'test model',
    isDefault: true,
    hidden: false,
    defaultReasoningEffort: 'medium',
    supportedReasoningEfforts: ['low', 'medium', 'high'],
  };
}

function createHarness(overrides: Partial<Parameters<typeof registerCodingRoutes>[1]> = {}) {
  const session = buildSession();
  const updateCalls: Array<Partial<SessionRecord>> = [];
  const liveEvents: Array<{ id: string; method: string; summary: string; createdAt: string }> = [];

  const deps: Parameters<typeof registerCodingRoutes>[1] = {
    getRequestUser: () => buildUser(),
    userCanUseMode: (_user, mode) => mode === 'developer',
    buildCodingBootstrapResponse: async (currentUser) => ({ currentUser }) as never,
    listUserWorkspaces: async () => ({
      root: '/tmp',
      workspaces: [buildWorkspace()],
    }),
    toCodingWorkspaceSummary: (workspace) => workspace as never,
    createCodingWorkspace: async () => ({
      workspace: buildWorkspace(),
      workspaceState: {
        root: '/tmp',
        workspaces: [buildWorkspace()],
      },
    }),
    getOwnedCodingWorkspaceOrReply: async () => buildWorkspace(),
    updateCodingWorkspace: async () => ({
      workspace: buildWorkspace(),
      workspaceState: {
        root: '/tmp',
        workspaces: [buildWorkspace()],
      },
    }),
    reorderWorkspaceList: async () => ({
      workspaceRoot: '/tmp',
      workspaces: [buildWorkspace()],
    }),
    createDeveloperSession: async () => session,
    errorMessage: (error) => error instanceof Error ? error.message : String(error),
    getOwnedCodingSessionOrReply: async () => session,
    buildCodingSessionDetailResponse: async (currentSession) => ({ session: currentSession }) as never,
    buildCodingSessionTranscriptResponse: async () => ({ items: [], nextCursor: null, total: 0 }) as never,
    attachmentKindFromUpload: () => 'file',
    sanitizeAttachmentFilename: (filename) => filename,
    extractAttachmentText: async () => null,
    addAttachment: async () => {},
    codingAttachmentSummary: (attachment) => ({
      id: attachment.id,
      kind: attachment.kind,
      filename: attachment.filename,
      mimeType: attachment.mimeType,
      sizeBytes: attachment.sizeBytes,
      url: '/attachment',
      createdAt: attachment.createdAt,
    }),
    getAttachment: () => null,
    removeAttachment: async () => true,
    deleteStoredAttachments: async () => {},
    trimOptional: (value) => {
      const next = typeof value === 'string' ? value.trim() : '';
      return next || null;
    },
    normalizeWorkspaceFolderName: (value) => {
      const next = typeof value === 'string' ? value.trim() : '';
      return next || null;
    },
    ensureUserWorkspace: async () => buildWorkspace(),
    normalizeSecurityProfile: () => 'repo-write',
    normalizeApprovalMode: () => 'detailed',
    isExecutorSupported: (executor) => executor === 'codex' || executor === 'claude-code',
    normalizeExecutor: (value) => value === 'claude-code' ? 'claude-code' : 'codex',
    updateCodingSession: async (_sessionId, patch) => {
      updateCalls.push(patch);
      return { ...session, ...patch };
    },
    currentDefaultModel: () => 'gpt-5',
    findModelOption: (model) => buildModelOption(model),
    normalizeReasoningEffort: (value) => typeof value === 'string' ? value as SessionRecord['reasoningEffort'] : null,
    preferredReasoningEffortForModel: () => 'medium',
    restartSessionThread: async (currentSession) => currentSession,
    createForkedSession: async () => ({ ...session, id: 'forked-session' }),
    listAttachments: () => [],
    deleteCodingSession: async () => {},
    startTurnWithAutoRestart: async (currentSession) => ({
      turn: { id: 'turn-2' },
      session: { ...currentSession, activeTurnId: 'turn-2' },
    }),
    isThreadUnavailableError: () => false,
    staleSessionMessage: 'Session is stale.',
    interruptTurn: async () => {},
    addLiveEvent: (_sessionId, event) => {
      liveEvents.push(event);
    },
    getApprovals: () => [],
    respondToRuntime: async () => {},
    removeApproval: () => {},
    ...overrides,
  };

  return {
    app: Fastify(),
    deps,
    updateCalls,
    liveEvents,
  };
}

async function createWorkspaceFixture() {
  const root = await mkdtemp(join(tmpdir(), 'rvc-coding-routes-'));
  await mkdir(join(root, 'src'), { recursive: true });
  await mkdir(join(root, 'docs'), { recursive: true });
  await writeFile(join(root, 'README.md'), '# Hello\n', 'utf8');
  await writeFile(join(root, 'src', 'index.ts'), 'export const answer = 42;\n', 'utf8');
  return root;
}

test('coding routes reject bootstrap requests when developer access is unavailable', async (t) => {
  const harness = createHarness({
    userCanUseMode: () => false,
  });
  registerCodingRoutes(harness.app, harness.deps);
  t.after(() => harness.app.close());

  const response = await harness.app.inject({
    method: 'GET',
    url: '/api/coding/bootstrap',
  });

  assert.equal(response.statusCode, 403);
  assert.deepEqual(response.json(), {
    error: 'Developer access required.',
  });
});

test('coding routes use the session executor when resolving model preferences', async (t) => {
  const findModelCalls: Array<{ model: string; executor: string | undefined }> = [];
  const harness = createHarness({
    getOwnedCodingSessionOrReply: async () => buildSession({
      executor: 'claude-code',
      model: null,
    }),
    currentDefaultModel: (executor) => executor === 'claude-code' ? 'claude-code-main' : 'gpt-5',
    findModelOption: (model, executor) => {
      findModelCalls.push({ model, executor });
      return buildModelOption(model);
    },
  });
  registerCodingRoutes(harness.app, harness.deps);
  t.after(() => harness.app.close());

  const response = await harness.app.inject({
    method: 'PATCH',
    url: '/api/coding/sessions/session-1/preferences',
    payload: {},
  });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(findModelCalls, [{
    model: 'claude-code-main',
    executor: 'claude-code',
  }]);
});

test('coding routes restart the thread when switching executors from preferences', async (t) => {
  const findModelCalls: Array<{ model: string; executor: string | undefined }> = [];
  const restartCalls: Array<{ session: SessionRecord; reason: string | undefined }> = [];
  const harness = createHarness({
    getOwnedCodingSessionOrReply: async () => buildSession({
      activeTurnId: null,
      status: 'idle',
      executor: 'codex',
      model: 'gpt-5-codex',
    }),
    currentDefaultModel: (executor) => executor === 'claude-code' ? 'claude-code-main' : 'gpt-5-codex',
    findModelOption: (model, executor) => {
      findModelCalls.push({ model, executor });
      return buildModelOption(model);
    },
    restartSessionThread: async (currentSession, reason) => {
      restartCalls.push({ session: currentSession, reason });
      return {
        ...currentSession,
        threadId: 'thread-2',
        activeTurnId: null,
        status: 'idle',
      };
    },
  });
  registerCodingRoutes(harness.app, harness.deps);
  t.after(() => harness.app.close());

  const response = await harness.app.inject({
    method: 'PATCH',
    url: '/api/coding/sessions/session-1/preferences',
    payload: {
      executor: 'claude-code',
    },
  });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(findModelCalls, [{
    model: 'claude-code-main',
    executor: 'claude-code',
  }]);
  assert.deepEqual(harness.updateCalls, [{
    executor: 'claude-code',
    model: 'claude-code-main',
    reasoningEffort: 'medium',
    approvalMode: 'detailed',
  }]);
  assert.equal(restartCalls[0]?.session.executor, 'claude-code');
  assert.equal(restartCalls[0]?.session.model, 'claude-code-main');
  assert.equal(restartCalls[0]?.reason, 'Executor changed. Started a fresh thread for this session.');
  assert.equal(response.json().session.threadId, 'thread-2');
});

test('coding routes map workspace service errors when creating workspaces', async (t) => {
  const harness = createHarness({
    createCodingWorkspace: async () => {
      throw new CodingWorkspaceServiceError('workspace already exists', 409);
    },
  });
  registerCodingRoutes(harness.app, harness.deps);
  t.after(() => harness.app.close());

  const response = await harness.app.inject({
    method: 'POST',
    url: '/api/coding/workspaces',
    payload: {
      name: 'repo',
    },
  });

  assert.equal(response.statusCode, 409);
  assert.deepEqual(response.json(), {
    error: 'workspace already exists',
  });
});

test('coding routes mark sessions stale when stopping a turn hits a missing thread', async (t) => {
  const staleError = Object.assign(new Error('missing thread'), { stale: true });
  const harness = createHarness({
    interruptTurn: async () => {
      throw staleError;
    },
    isThreadUnavailableError: (error) => error === staleError,
  });
  registerCodingRoutes(harness.app, harness.deps);
  t.after(() => harness.app.close());

  const response = await harness.app.inject({
    method: 'POST',
    url: '/api/coding/sessions/session-1/stop',
  });

  assert.equal(response.statusCode, 409);
  assert.equal(harness.updateCalls.length, 1);
  assert.deepEqual(harness.updateCalls[0], {
    activeTurnId: null,
    status: 'stale',
    lastIssue: 'Session is stale.',
    networkEnabled: false,
  });
  assert.equal(response.json().error, 'Session is stale.');
});

test('coding routes list workspace tree entries for file browsing', async (t) => {
  const workspaceRoot = await createWorkspaceFixture();
  t.after(async () => {
    await rm(workspaceRoot, { recursive: true, force: true });
  });

  const harness = createHarness({
    getOwnedCodingWorkspaceOrReply: async () => buildWorkspace({ path: workspaceRoot }),
  });
  registerCodingRoutes(harness.app, harness.deps);
  t.after(() => harness.app.close());

  const response = await harness.app.inject({
    method: 'GET',
    url: '/api/coding/workspaces/workspace-1/tree',
  });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), {
    workspaceId: 'workspace-1',
    path: '',
    entries: [
      { path: 'docs', name: 'docs', kind: 'directory', sizeBytes: null },
      { path: 'src', name: 'src', kind: 'directory', sizeBytes: null },
      { path: 'README.md', name: 'README.md', kind: 'file', sizeBytes: 8 },
    ],
  });
});

test('coding routes preview workspace files and reject traversal outside the workspace', async (t) => {
  const workspaceRoot = await createWorkspaceFixture();
  t.after(async () => {
    await rm(workspaceRoot, { recursive: true, force: true });
  });

  const harness = createHarness({
    getOwnedCodingWorkspaceOrReply: async () => buildWorkspace({ path: workspaceRoot }),
  });
  registerCodingRoutes(harness.app, harness.deps);
  t.after(() => harness.app.close());

  const previewResponse = await harness.app.inject({
    method: 'GET',
    url: '/api/coding/workspaces/workspace-1/file?path=src/index.ts',
  });

  assert.equal(previewResponse.statusCode, 200);
  assert.deepEqual(previewResponse.json(), {
    workspaceId: 'workspace-1',
    path: 'src/index.ts',
    name: 'index.ts',
    mimeType: 'text/plain; charset=utf-8',
    sizeBytes: 26,
    previewable: true,
    truncated: false,
    content: 'export const answer = 42;\n',
    downloadUrl: '/api/coding/workspaces/workspace-1/file/content?path=src%2Findex.ts&download=1',
  });

  const traversalResponse = await harness.app.inject({
    method: 'GET',
    url: '/api/coding/workspaces/workspace-1/file?path=../secret.txt',
  });

  assert.equal(traversalResponse.statusCode, 400);
  assert.deepEqual(traversalResponse.json(), {
    error: 'Path must stay inside the workspace.',
  });
});

test('coding routes preview workspace files from absolute in-workspace paths', async (t) => {
  const workspaceRoot = await createWorkspaceFixture();
  t.after(async () => {
    await rm(workspaceRoot, { recursive: true, force: true });
  });

  const harness = createHarness({
    getOwnedCodingWorkspaceOrReply: async () => buildWorkspace({ path: workspaceRoot }),
  });
  registerCodingRoutes(harness.app, harness.deps);
  t.after(() => harness.app.close());

  const query = new URLSearchParams({
    path: join(workspaceRoot, 'src', 'index.ts'),
  }).toString();
  const previewResponse = await harness.app.inject({
    method: 'GET',
    url: `/api/coding/workspaces/workspace-1/file?${query}`,
  });

  assert.equal(previewResponse.statusCode, 200);
  assert.deepEqual(previewResponse.json(), {
    workspaceId: 'workspace-1',
    path: 'src/index.ts',
    name: 'index.ts',
    mimeType: 'text/plain; charset=utf-8',
    sizeBytes: 26,
    previewable: true,
    truncated: false,
    content: 'export const answer = 42;\n',
    downloadUrl: '/api/coding/workspaces/workspace-1/file/content?path=src%2Findex.ts&download=1',
  });
});
