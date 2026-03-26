import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildChatBootstrapPayload,
  chatConversationUiStatus,
  toApiChatConversation,
  unavailableChatConversationPatch,
} from './chat-presentation.js';
import type { ConversationRecord, UserRecord } from './types.js';

function buildUser(): UserRecord {
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
  };
}

function buildConversation(overrides: Partial<ConversationRecord> = {}): ConversationRecord {
  return {
    id: 'conversation-1',
    ownerUserId: 'user-1',
    ownerUsername: 'owner',
    sessionType: 'chat',
    threadId: 'thread-1',
    activeTurnId: null,
    title: 'Chat',
    autoTitle: false,
    workspace: '/tmp/chat',
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
    rolePresetId: 'preset-1',
    recoveryState: 'ready',
    retryable: false,
    ...overrides,
  };
}

test('chat presentation computes UI status and maps role preset ids', () => {
  const conversation = buildConversation({
    status: 'running',
    activeTurnId: 'turn-1',
    hasTranscript: true,
  });

  assert.equal(chatConversationUiStatus(conversation), 'processing');

  const payload = toApiChatConversation(conversation, {
    normalizeRolePresetId: (value) => value === 'preset-1' ? value : null,
  });

  assert.equal(payload.uiStatus, 'processing');
  assert.equal(payload.rolePresetId, 'preset-1');
});

test('chat presentation builds stale patches for interrupted conversations', () => {
  const patch = unavailableChatConversationPatch(
    buildConversation({
      activeTurnId: 'turn-1',
      status: 'running',
      lastIssue: null,
    }),
    'Interrupted before completion.',
    'Thread missing.',
  );

  assert.deepEqual(patch, {
    activeTurnId: null,
    status: 'error',
    recoveryState: 'stale',
    retryable: true,
    lastIssue: 'Interrupted before completion.',
    networkEnabled: false,
  });
});

test('chat presentation builds bootstrap payloads with normalized conversation summaries', () => {
  const conversation = buildConversation({
    hasTranscript: true,
  });

  const payload = buildChatBootstrapPayload({
    currentUser: buildUser(),
    conversations: [conversation],
    rolePresets: [{
      id: 'preset-1',
      label: 'Preset',
      description: null,
      isDefault: true,
    }],
    defaultRolePresetId: 'preset-1',
    availableModes: ['chat'],
    defaultMode: 'chat',
    availableModels: [],
    defaultModel: 'gpt-5',
    defaultReasoningEffort: 'medium',
    normalizeRolePresetId: (value) => value ?? null,
  });

  assert.equal(payload.defaults.rolePresetId, 'preset-1');
  assert.equal(payload.conversations[0]?.id, 'conversation-1');
  assert.equal(payload.conversations[0]?.uiStatus, 'completed');
});
