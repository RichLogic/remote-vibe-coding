import test from 'node:test';
import assert from 'node:assert/strict';

import Fastify from 'fastify';

import { registerSessionRoutes } from './session-routes.js';
import type {
  ConversationRecord,
  ModelOption,
  SessionAttachmentSummary,
  SessionRecord,
  UserRecord,
  WorkspaceSummary,
} from '../types.js';

function buildUser(): UserRecord {
  return {
    id: 'user-1',
    username: 'owner',
    roles: ['user', 'developer'],
    preferredMode: 'developer',
    isAdmin: false,
    allowedSessionTypes: ['chat', 'code'],
    canUseFullHost: false,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

function buildConversation(overrides: Partial<ConversationRecord> = {}): ConversationRecord {
  return {
    id: 'conversation-1',
    ownerUserId: 'user-1',
    ownerUsername: 'owner',
    sessionType: 'chat',
    threadId: 'thread-1',
    activeTurnId: 'turn-1',
    title: 'Chat',
    autoTitle: false,
    workspace: '/tmp/chat',
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
    rolePresetId: null,
    recoveryState: 'ready',
    retryable: false,
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
    activeTurnId: null,
    title: 'Session 1',
    autoTitle: false,
    workspace: '/tmp/workspace',
    archivedAt: null,
    securityProfile: 'repo-write',
    approvalMode: 'detailed',
    networkEnabled: false,
    fullHostEnabled: false,
    status: 'idle',
    lastIssue: null,
    hasTranscript: false,
    model: 'gpt-5',
    reasoningEffort: 'medium',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function buildWorkspace(): WorkspaceSummary {
  return {
    id: 'workspace-1',
    name: 'workspace-1',
    path: '/tmp/workspace',
    visible: true,
    sortOrder: 0,
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

function buildAttachmentSummary(): SessionAttachmentSummary {
  return {
    id: 'attachment-1',
    kind: 'file',
    filename: 'note.txt',
    mimeType: 'text/plain',
    sizeBytes: 10,
    url: '/api/sessions/session-1/attachments/attachment-1/content',
    createdAt: '2026-01-01T00:00:00.000Z',
  };
}

function createHarness(overrides: Partial<Parameters<typeof registerSessionRoutes>[1]> = {}) {
  const currentUser = buildUser();
  const chatConversation = buildConversation();
  const codingSession = buildSession();
  const createChatCalls: Array<{ userId: string; sessionType: unknown }> = [];
  const stopChatCalls: string[] = [];

  const deps: Parameters<typeof registerSessionRoutes>[1] = {
    getRequestUser: () => currentUser,
    getOwnedRecordOrReply: async (_userId, recordId) => (
      recordId === chatConversation.id ? chatConversation : codingSession
    ),
    buildSessionDetailResponse: async (session) => ({ session }),
    buildSessionTranscriptResponse: async () => ({ items: [], nextCursor: null, total: 0 }),
    attachmentKindFromUpload: () => 'file',
    sanitizeAttachmentFilename: (filename) => filename,
    extractAttachmentText: async () => null,
    addAttachment: async () => {},
    attachmentSummary: () => buildAttachmentSummary(),
    getAttachment: () => null,
    removeAttachment: async () => true,
    normalizeSessionType: (value) => value === 'chat' ? 'chat' : 'code',
    trimOptional: (value) => {
      const next = typeof value === 'string' ? value.trim() : '';
      return next || null;
    },
    userCanCreateSessionType: () => true,
    normalizeWorkspaceFolderName: (value) => typeof value === 'string' ? value.trim() || null : null,
    ensureUserWorkspace: async () => buildWorkspace(),
    getOwnedWorkspace: async () => buildWorkspace(),
    errorMessage: (error) => error instanceof Error ? error.message : String(error),
    createChatConversation: async (user, input) => {
      createChatCalls.push({ userId: user.id, sessionType: input.sessionType });
      return buildConversation({ title: input.title ?? 'Chat' });
    },
    createDeveloperSession: async () => codingSession,
    restartSessionThread: async (session) => session,
    createForkedSession: async (_user, session) => ({ ...session, id: 'forked-session' }),
    createForkedConversation: async (_user, conversation) => ({ ...conversation, id: 'forked-conversation' }),
    updateRecord: async (record, patch) => ({ ...record, ...patch }) as ConversationRecord | SessionRecord,
    normalizeSecurityProfile: () => 'repo-write',
    normalizeApprovalMode: () => 'detailed',
    updateConversationPreferences: async (conversation) => conversation,
    renameConversation: async (conversation, input) => ({
      ...conversation,
      title: input.title ?? conversation.title,
      autoTitle: false,
    }),
    archiveConversation: async (conversation) => ({ ...conversation, archivedAt: '2026-01-02T00:00:00.000Z' }),
    restoreConversation: async (conversation) => ({ ...conversation, archivedAt: null }),
    clearApprovals: () => {},
    deleteConversationState: async () => {},
    deleteConversationHistory: async () => {},
    deleteCodingSession: async () => {},
    deleteStoredAttachments: async () => {},
    listAttachments: () => [],
    createChatMessage: async (conversation) => ({
      turn: { id: 'turn-2' },
      conversation: { ...conversation, activeTurnId: 'turn-2' },
    }),
    stopChatTurn: async (conversation) => {
      stopChatCalls.push(conversation.id);
      return { ...conversation, activeTurnId: null, status: 'idle' };
    },
    startTurnWithAutoRestart: async (session) => ({
      turn: { id: 'turn-2' },
      session: { ...session, activeTurnId: 'turn-2' },
    }),
    interruptTurn: async () => {},
    addLiveEvent: () => {},
    isThreadUnavailableError: () => false,
    staleSessionMessage: 'Session is stale.',
    getApprovals: () => [],
    respondToRuntime: async () => {},
    removeApproval: () => {},
    updateCodingSession: async (_sessionId, patch) => ({ ...codingSession, ...patch }),
    currentDefaultModel: () => 'gpt-5',
    findModelOption: (model) => buildModelOption(model),
    normalizeReasoningEffort: (value) => typeof value === 'string' ? value as ModelOption['defaultReasoningEffort'] : null,
    preferredReasoningEffortForModel: () => 'medium',
    ...overrides,
  };

  return {
    app: Fastify(),
    deps,
    createChatCalls,
    stopChatCalls,
  };
}

test('session routes create chat sessions through the chat service', async (t) => {
  const harness = createHarness();
  registerSessionRoutes(harness.app, harness.deps);
  t.after(() => harness.app.close());

  const response = await harness.app.inject({
    method: 'POST',
    url: '/api/sessions',
    payload: {
      sessionType: 'chat',
      title: 'New chat',
    },
  });

  assert.equal(response.statusCode, 201);
  assert.deepEqual(harness.createChatCalls, [{
    userId: 'user-1',
    sessionType: 'chat',
  }]);
  assert.equal(response.json().session.sessionType, 'chat');
});

test('session routes stop chat sessions through the chat turn service', async (t) => {
  const harness = createHarness();
  registerSessionRoutes(harness.app, harness.deps);
  t.after(() => harness.app.close());

  const response = await harness.app.inject({
    method: 'POST',
    url: '/api/sessions/conversation-1/stop',
  });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(harness.stopChatCalls, ['conversation-1']);
  assert.equal(response.json().session.activeTurnId, null);
});

test('session routes use the code session executor when updating preferences', async (t) => {
  const findModelCalls: Array<{ model: string; executor: string | undefined }> = [];
  const harness = createHarness({
    getOwnedRecordOrReply: async () => buildSession({
      executor: 'claude-code',
      model: null,
    }),
    currentDefaultModel: (executor) => executor === 'claude-code' ? 'claude-code-main' : 'gpt-5',
    findModelOption: (model, executor) => {
      findModelCalls.push({ model, executor });
      return buildModelOption(model);
    },
  });
  registerSessionRoutes(harness.app, harness.deps);
  t.after(() => harness.app.close());

  const response = await harness.app.inject({
    method: 'PATCH',
    url: '/api/sessions/session-1/preferences',
    payload: {},
  });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(findModelCalls, [{
    model: 'claude-code-main',
    executor: 'claude-code',
  }]);
});
