import test from 'node:test';
import assert from 'node:assert/strict';

import type { ConversationRecord, SessionRecord, UserRecord } from '../types.js';
import { createSessionForkService } from './session-fork-service.js';

function buildUser(): UserRecord {
  return {
    id: 'owner-1',
    username: 'owner',
    roles: ['user', 'developer', 'admin'],
    preferredMode: 'developer',
    isAdmin: true,
    allowedSessionTypes: ['chat', 'code'],
    canUseFullHost: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

function buildCodeSession(): SessionRecord {
  return {
    id: 'code-source',
    ownerUserId: 'owner-1',
    ownerUsername: 'owner',
    sessionType: 'code',
    executor: 'codex',
    workspaceId: 'workspace-1',
    threadId: 'thread-source',
    activeTurnId: null,
    title: 'Implement auth',
    autoTitle: false,
    workspace: '/tmp/code',
    archivedAt: null,
    securityProfile: 'full-host',
    approvalMode: 'detailed',
    networkEnabled: true,
    fullHostEnabled: true,
    status: 'idle',
    lastIssue: null,
    hasTranscript: true,
    model: 'gpt-5-codex',
    reasoningEffort: 'high',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

function buildChatConversation(): ConversationRecord {
  return {
    id: 'chat-source',
    ownerUserId: 'owner-1',
    ownerUsername: 'owner',
    sessionType: 'chat',
    executor: 'codex',
    threadId: 'thread-chat-source',
    activeTurnId: null,
    title: 'Planning',
    autoTitle: false,
    workspace: '/tmp/chat',
    archivedAt: null,
    securityProfile: 'repo-write',
    approvalMode: 'detailed',
    networkEnabled: false,
    fullHostEnabled: false,
    status: 'idle',
    recoveryState: 'ready',
    retryable: false,
    lastIssue: null,
    hasTranscript: true,
    model: null,
    reasoningEffort: null,
    rolePresetId: 'preset-1',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

function createHarness() {
  const threadStarts: Array<{ cwd: string; securityProfile: string; model?: string | null }> = [];
  const persisted = {
    sessions: [] as SessionRecord[],
    conversations: [] as ConversationRecord[],
  };

  const service = createSessionForkService({
    chatRuntime: {
      async startThread(options) {
        threadStarts.push(options);
        return { thread: { id: `thread-${threadStarts.length}` } };
      },
    },
    runtimeForExecutor: () => ({
      async startThread(options) {
        threadStarts.push(options);
        return { thread: { id: `thread-${threadStarts.length}` } };
      },
    }),
    async ensureChatWorkspace() {
      return { path: '/tmp/chat-workspace' };
    },
    async persistForkedSession(session) {
      persisted.sessions.push(session);
    },
    async persistForkedConversation(conversation) {
      persisted.conversations.push(conversation);
    },
    currentDefaultModel: () => 'gpt-5-default',
    currentDefaultEffort: () => 'medium',
    nextForkedSessionTitle: (title) => `${title} (fork)`,
    randomId: () => 'fork-id',
    now: () => '2026-02-01T00:00:00.000Z',
  });

  return { service, threadStarts, persisted };
}

test('session fork service forks coding sessions with inherited execution settings', async () => {
  const harness = createHarness();
  const result = await harness.service.createForkedSession(buildUser(), buildCodeSession());

  assert.deepEqual(harness.threadStarts, [{
    cwd: '/tmp/code',
    securityProfile: 'full-host',
    model: 'gpt-5-codex',
  }]);
  assert.equal(result.id, 'fork-id');
  assert.equal(result.executor, 'codex');
  assert.equal(result.title, 'Implement auth (fork)');
  assert.equal(result.fullHostEnabled, true);
  assert.equal(harness.persisted.sessions.length, 1);
});

test('session fork service forks chat conversations with chat defaults and ensured workspace', async () => {
  const harness = createHarness();
  const result = await harness.service.createForkedConversation(buildUser(), buildChatConversation());

  assert.deepEqual(harness.threadStarts, [{
    cwd: '/tmp/chat-workspace',
    securityProfile: 'repo-write',
    model: 'gpt-5-default',
  }]);
  assert.equal(result.workspace, '/tmp/chat-workspace');
  assert.equal(result.title, 'Planning (fork)');
  assert.equal(result.reasoningEffort, 'medium');
  assert.equal(result.rolePresetId, 'preset-1');
  assert.equal(harness.persisted.conversations.length, 1);
});
