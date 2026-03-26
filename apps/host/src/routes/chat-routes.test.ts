import test from 'node:test';
import assert from 'node:assert/strict';

import Fastify from 'fastify';

import { ChatConversationServiceError } from '../app/chat-conversation-service.js';
import { ChatTurnServiceError } from '../app/chat-turn-service.js';
import { registerChatRoutes } from './chat-routes.js';
import type { ConversationRecord, UserRecord } from '../types.js';

function buildUser(overrides: Partial<UserRecord> = {}): UserRecord {
  return {
    id: 'user-1',
    username: 'owner',
    roles: ['user'],
    preferredMode: 'chat',
    isAdmin: false,
    allowedSessionTypes: ['chat'],
    canUseFullHost: false,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function buildConversation(overrides: Partial<ConversationRecord> = {}): ConversationRecord {
  const { executor = 'codex', ...rest } = overrides;
  return {
    id: 'conversation-1',
    ownerUserId: 'user-1',
    ownerUsername: 'owner',
    sessionType: 'chat',
    executor,
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
    ...rest,
  };
}

function createHarness(overrides: Partial<Parameters<typeof registerChatRoutes>[1]> = {}) {
  const conversation = buildConversation();
  const deps: Parameters<typeof registerChatRoutes>[1] = {
    getRequestUser: () => buildUser(),
    userCanUseMode: (_user, mode) => mode === 'chat',
    listConversationRecordsForUser: async () => [conversation],
    repairPendingChatAutoTitles: async () => {},
    loadChatRolePresetConfig: async () => ({
      defaultPresetId: null,
      presets: [],
    }),
    apiRolePresets: () => [],
    buildChatBootstrapResponse: (currentUser, conversations) => ({
      currentUser,
      conversations,
    }) as never,
    getOwnedConversationOrReply: async () => conversation,
    readSessionThread: async () => ({
      session: conversation,
      thread: null,
    }),
    syncConversationMirror: async (currentConversation) => currentConversation,
    syncConversationHistoryFromThread: async () => {},
    countMessages: async () => 1,
    updateConversation: async (_currentConversation, patch) => ({ ...conversation, ...patch }),
    buildChatConversationDetailPayload: (currentConversation, thread, transcriptTotal) => ({
      conversation: {
        id: currentConversation.id,
        kind: 'chat-conversation',
      },
      thread,
      transcriptTotal,
      draftAttachments: [],
    }) as never,
    toThreadSummary: () => null,
    normalizeTranscriptLimit: () => 20,
    pageMessages: async () => ({
      items: [],
      nextCursor: null,
      total: 0,
    }),
    chatMessageToApiTranscriptEntry: (message) => message as never,
    compactChatLiveEvents: (events) => events,
    getLiveEvents: () => [],
    attachmentKindFromUpload: () => 'file',
    sanitizeAttachmentFilename: (filename) => filename,
    extractAttachmentText: async () => null,
    addAttachment: async () => {},
    chatAttachmentSummary: (attachment) => ({
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
    createChatConversation: async () => buildConversation(),
    renameConversation: async () => conversation,
    updateConversationPreferences: async () => conversation,
    restartSessionThread: async (currentConversation) => currentConversation,
    archiveConversation: async () => ({ ...conversation, archivedAt: '2026-01-02T00:00:00.000Z' }),
    restoreConversation: async () => ({ ...conversation, archivedAt: null }),
    createForkedConversation: async () => ({ ...conversation, id: 'forked-conversation' }),
    errorMessage: (error) => error instanceof Error ? error.message : String(error),
    listAttachments: () => [],
    deleteConversationState: async () => {},
    deleteConversationHistory: async () => {},
    deleteStoredAttachments: async () => {},
    createChatMessage: async () => ({
      turn: { id: 'turn-2' },
      conversation: buildConversation({ activeTurnId: 'turn-2' }),
    }),
    stopChatTurn: async () => buildConversation({ activeTurnId: null, status: 'idle' }),
    toApiChatConversationRecord: (currentConversation) => ({
      id: currentConversation.id,
      kind: 'chat-conversation',
    }) as never,
    ...overrides,
  };

  return {
    app: Fastify(),
    deps,
  };
}

test('chat routes reject bootstrap requests when chat access is unavailable', async (t) => {
  const harness = createHarness({
    userCanUseMode: () => false,
  });
  registerChatRoutes(harness.app, harness.deps);
  t.after(() => harness.app.close());

  const response = await harness.app.inject({
    method: 'GET',
    url: '/api/chat/bootstrap',
  });

  assert.equal(response.statusCode, 403);
  assert.deepEqual(response.json(), {
    error: 'Chat access required.',
  });
});

test('chat routes map conversation service errors when creating conversations', async (t) => {
  const harness = createHarness({
    createChatConversation: async () => {
      throw new ChatConversationServiceError('Unknown role preset.', 400);
    },
  });
  registerChatRoutes(harness.app, harness.deps);
  t.after(() => harness.app.close());

  const response = await harness.app.inject({
    method: 'POST',
    url: '/api/chat/conversations',
    payload: {
      title: 'Chat',
    },
  });

  assert.equal(response.statusCode, 400);
  assert.deepEqual(response.json(), {
    error: 'Unknown role preset.',
  });
});

test('chat routes include patched conversations when stop fails with a chat turn error', async (t) => {
  const patchedConversation = buildConversation({
    activeTurnId: null,
    status: 'error',
    lastIssue: 'Session is stale.',
  });
  const harness = createHarness({
    stopChatTurn: async () => {
      throw new ChatTurnServiceError('Session is stale.', 409, patchedConversation);
    },
    toApiChatConversationRecord: (currentConversation) => ({
      id: currentConversation.id,
      status: currentConversation.status,
      kind: 'chat-conversation',
    }) as never,
  });
  registerChatRoutes(harness.app, harness.deps);
  t.after(() => harness.app.close());

  const response = await harness.app.inject({
    method: 'POST',
    url: '/api/chat/conversations/conversation-1/stop',
  });

  assert.equal(response.statusCode, 409);
  assert.deepEqual(response.json(), {
    error: 'Session is stale.',
    conversation: {
      id: 'conversation-1',
      status: 'error',
      kind: 'chat-conversation',
    },
  });
});
