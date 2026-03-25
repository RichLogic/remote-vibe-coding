import test from 'node:test';
import assert from 'node:assert/strict';

import type { JsonRpcNotification } from '../codex-app-server.js';
import type { CodexThread, ConversationRecord, SessionEvent, SessionRecord } from '../types.js';
import { createCodexNotificationHandler } from './codex-notification-handler.js';

type TurnRecord = ConversationRecord | SessionRecord;

function buildChatSession(): ConversationRecord {
  return {
    id: 'chat-1',
    ownerUserId: 'owner-1',
    ownerUsername: 'owner',
    sessionType: 'chat',
    threadId: 'thread-chat',
    activeTurnId: 'turn-1',
    title: 'Chat',
    autoTitle: false,
    workspace: '/tmp/chat',
    archivedAt: null,
    securityProfile: 'repo-write',
    approvalMode: 'less-approval',
    networkEnabled: false,
    fullHostEnabled: false,
    status: 'running',
    lastIssue: null,
    hasTranscript: true,
    model: 'gpt-5-codex',
    reasoningEffort: 'high',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    rolePresetId: null,
    recoveryState: 'ready',
    retryable: false,
  };
}

function buildCodeSession(): SessionRecord {
  return {
    id: 'code-1',
    ownerUserId: 'owner-1',
    ownerUsername: 'owner',
    sessionType: 'code',
    workspaceId: 'workspace-1',
    threadId: 'thread-code',
    activeTurnId: 'turn-2',
    title: 'Code',
    autoTitle: false,
    workspace: '/tmp/code',
    archivedAt: null,
    securityProfile: 'repo-write',
    approvalMode: 'less-approval',
    networkEnabled: false,
    fullHostEnabled: false,
    status: 'running',
    lastIssue: null,
    hasTranscript: true,
    model: 'gpt-5-codex',
    reasoningEffort: 'high',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

function createHarness(session: TurnRecord | null, overrides?: {
  approvals?: Array<{ id: string }>;
  latestReply?: string | null;
  transitionOnly?: boolean;
  currentRecord?: TurnRecord | null;
}) {
  const liveEvents: Array<{ sessionId: string; event: SessionEvent }> = [];
  const updatedRecords: Array<{ recordId: string; patch: Partial<TurnRecord> }> = [];
  const autoTitles = {
    chat: [] as Array<{ sessionId: string; thread: CodexThread | null | undefined }>,
    coding: [] as Array<{ sessionId: string; thread: CodexThread | null | undefined }>,
  };
  const syncedConversations: Array<{ sessionId: string; thread: CodexThread | null }> = [];
  const thread = { id: session?.threadId ?? 'thread-missing', items: [] } as unknown as CodexThread;

  const handler = createCodexNotificationHandler({
    store: {
      addLiveEvent(sessionId, event) {
        liveEvents.push({ sessionId, event });
      },
      getApprovals() {
        return overrides?.approvals ?? [];
      },
    },
    async findRecordByThreadId(threadId) {
      return session && session.threadId === threadId ? session : null;
    },
    async updateRecord(record, patch) {
      updatedRecords.push({ recordId: record.id, patch });
      return { ...record, ...patch } as TurnRecord;
    },
    async getCurrentRecord() {
      return overrides?.currentRecord ?? session;
    },
    async readSessionThread(currentSession) {
      return { session: currentSession, thread };
    },
    async maybeAutoTitleChatSession(targetSession, threadOverride) {
      autoTitles.chat.push({ sessionId: targetSession.id, thread: threadOverride });
    },
    async maybeAutoTitleCodingSession(targetSession, threadOverride) {
      autoTitles.coding.push({ sessionId: targetSession.id, thread: threadOverride });
    },
    async syncConversationHistoryFromThread(conversation, currentThread) {
      syncedConversations.push({ sessionId: conversation.id, thread: currentThread });
    },
    latestMeaningfulChatReplyFromTurn() {
      return Object.prototype.hasOwnProperty.call(overrides ?? {}, 'latestReply')
        ? overrides?.latestReply ?? null
        : 'final answer';
    },
    isTransitionOnlyChatReply() {
      return overrides?.transitionOnly ?? false;
    },
    summarizeNotification(method) {
      return `summary:${method}`;
    },
    emptyReplyMessage: 'Chat turn ended before returning a real answer.',
    randomId: () => 'event-1',
    now: () => '2026-01-02T00:00:00.000Z',
  });

  return { handler, liveEvents, updatedRecords, autoTitles, syncedConversations };
}

test('Codex notification handler updates session status on thread status changes', async () => {
  const harness = createHarness(buildCodeSession());
  await harness.handler({
    method: 'thread/status/changed',
    params: {
      threadId: 'thread-code',
      status: { type: 'idle' },
    },
  } satisfies JsonRpcNotification);

  assert.equal(harness.liveEvents[0]?.event.summary, 'summary:thread/status/changed');
  assert.deepEqual(harness.updatedRecords[0], {
    recordId: 'code-1',
    patch: { status: 'idle', lastIssue: null, activeTurnId: null },
  });
});

test('Codex notification handler marks coding sessions as needing approval after completion', async () => {
  const harness = createHarness(buildCodeSession(), {
    approvals: [{ id: 'approval-1' }],
  });
  await harness.handler({
    method: 'turn/completed',
    params: { threadId: 'thread-code' },
  } satisfies JsonRpcNotification);

  assert.deepEqual(harness.updatedRecords[0], {
    recordId: 'code-1',
    patch: { activeTurnId: null, status: 'needs-approval', lastIssue: null },
  });
  assert.deepEqual(harness.autoTitles.coding, [{ sessionId: 'code-1', thread: undefined }]);
});

test('Codex notification handler syncs chat history and flags empty replies', async () => {
  const chatSession = buildChatSession();
  const harness = createHarness(chatSession, {
    latestReply: null,
    currentRecord: chatSession,
  });
  await harness.handler({
    method: 'turn/completed',
    params: { threadId: 'thread-chat' },
  } satisfies JsonRpcNotification);

  assert.deepEqual(harness.updatedRecords[0], {
    recordId: 'chat-1',
    patch: {
      activeTurnId: null,
      status: 'idle',
      recoveryState: 'ready',
      retryable: false,
      lastIssue: null,
    },
  });
  assert.deepEqual(harness.syncedConversations, [{
    sessionId: 'chat-1',
    thread: { id: 'thread-chat', items: [] } as unknown as CodexThread,
  }]);
  assert.equal(harness.updatedRecords[1]?.patch.status, 'error');
  assert.equal(harness.liveEvents[1]?.event.method, 'session/chat-empty-reply');
  assert.equal(harness.autoTitles.chat.length, 2);
});

test('Codex notification handler records explicit error details', async () => {
  const chatSession = buildChatSession();
  const harness = createHarness(chatSession, {
    currentRecord: {
      ...chatSession,
      status: 'error',
      lastIssue: 'HTTP error: 500 Internal Server Error',
    },
  });

  await harness.handler({
    method: 'error',
    params: {
      threadId: 'thread-chat',
      error: {
        message: 'HTTP error: 500 Internal Server Error',
      },
    },
  } satisfies JsonRpcNotification);

  assert.deepEqual(harness.updatedRecords[0], {
    recordId: 'chat-1',
    patch: {
      activeTurnId: null,
      status: 'error',
      recoveryState: 'ready',
      retryable: true,
      lastIssue: 'summary:error',
    },
  });
});

test('Codex notification handler preserves existing chat errors on completion', async () => {
  const chatSession = {
    ...buildChatSession(),
    status: 'error' as const,
    lastIssue: 'HTTP error: 500 Internal Server Error',
  };
  const harness = createHarness(chatSession, {
    latestReply: null,
    currentRecord: chatSession,
  });

  await harness.handler({
    method: 'turn/completed',
    params: { threadId: 'thread-chat' },
  } satisfies JsonRpcNotification);

  assert.deepEqual(harness.updatedRecords[0], {
    recordId: 'chat-1',
    patch: {
      activeTurnId: null,
      status: 'error',
      recoveryState: 'ready',
      retryable: true,
    },
  });
  assert.equal(harness.updatedRecords.length, 1);
});

test('Codex notification handler ignores notifications without a matching thread', async () => {
  const harness = createHarness(null);
  await harness.handler({
    method: 'turn/completed',
    params: { threadId: 'missing-thread' },
  } satisfies JsonRpcNotification);

  assert.deepEqual(harness.liveEvents, []);
  assert.deepEqual(harness.updatedRecords, []);
});
