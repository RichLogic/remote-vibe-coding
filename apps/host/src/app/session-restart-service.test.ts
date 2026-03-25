import test from 'node:test';
import assert from 'node:assert/strict';

import type { ConversationRecord, SessionEvent, SessionRecord } from '../types.js';
import { createSessionRestartService } from './session-restart-service.js';

type TurnRecord = ConversationRecord | SessionRecord;

function buildChatSession(): ConversationRecord {
  return {
    id: 'chat-1',
    ownerUserId: 'owner-1',
    ownerUsername: 'owner',
    sessionType: 'chat',
    threadId: 'thread-chat-old',
    activeTurnId: 'turn-chat',
    title: 'Chat',
    autoTitle: false,
    workspace: '/tmp/old-chat',
    archivedAt: null,
    securityProfile: 'repo-write',
    approvalMode: 'less-approval',
    networkEnabled: true,
    fullHostEnabled: false,
    status: 'error',
    lastIssue: 'old issue',
    hasTranscript: true,
    model: 'gpt-5-codex',
    reasoningEffort: 'high',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    rolePresetId: null,
    recoveryState: 'stale',
    retryable: true,
  };
}

function buildCodeSession(): SessionRecord {
  return {
    id: 'code-1',
    ownerUserId: 'owner-1',
    ownerUsername: 'owner',
    sessionType: 'code',
    workspaceId: 'workspace-1',
    threadId: 'thread-code-old',
    activeTurnId: 'turn-code',
    title: 'Code',
    autoTitle: false,
    workspace: '/tmp/code',
    archivedAt: null,
    securityProfile: 'repo-write',
    approvalMode: 'less-approval',
    networkEnabled: true,
    fullHostEnabled: false,
    status: 'error',
    lastIssue: 'old issue',
    hasTranscript: true,
    model: 'gpt-5-codex',
    reasoningEffort: 'high',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

function createHarness() {
  const threadStarts: Array<{ cwd: string; securityProfile: string; model?: string | null }> = [];
  const events: Array<{ sessionId: string; event: SessionEvent }> = [];
  const updates: Array<{ recordId: string; patch: Partial<TurnRecord> }> = [];
  const rotations: Array<{ conversationId: string; nextThreadId: string }> = [];
  const clears = {
    approvals: [] as string[],
    liveEvents: [] as string[],
  };

  const restartSessionThread = createSessionRestartService({
    codex: {
      async startThread(options) {
        threadStarts.push(options);
        return { thread: { id: `next-thread-${threadStarts.length}` } };
      },
    },
    store: {
      clearApprovals(sessionId) {
        clears.approvals.push(sessionId);
      },
      clearLiveEvents(sessionId) {
        clears.liveEvents.push(sessionId);
      },
      addLiveEvent(sessionId, event) {
        events.push({ sessionId, event });
      },
    },
    async ensureChatWorkspace() {
      return { path: '/tmp/chat-workspace' };
    },
    async rotateConversationThread(conversation, nextThreadId) {
      rotations.push({ conversationId: conversation.id, nextThreadId });
    },
    async updateRecord(record, patch) {
      updates.push({ recordId: record.id, patch });
      return { ...record, ...patch } as TurnRecord;
    },
    randomId: () => 'event-1',
    now: () => '2026-01-02T00:00:00.000Z',
  });

  return { restartSessionThread, threadStarts, events, updates, rotations, clears };
}

test('session restart service rotates chat threads and resets chat state', async () => {
  const harness = createHarness();
  const result = await harness.restartSessionThread(buildChatSession(), 'Restarted chat');

  assert.deepEqual(harness.threadStarts, [{
    cwd: '/tmp/chat-workspace',
    securityProfile: 'repo-write',
    model: 'gpt-5-codex',
  }]);
  assert.deepEqual(harness.rotations, [{
    conversationId: 'chat-1',
    nextThreadId: 'next-thread-1',
  }]);
  assert.deepEqual(harness.clears.approvals, ['chat-1']);
  assert.deepEqual(harness.clears.liveEvents, ['chat-1']);
  assert.equal(harness.events[0]?.event.method, 'session/restarted');
  assert.equal(result.threadId, 'next-thread-1');
  assert.equal(result.workspace, '/tmp/chat-workspace');
  assert.equal(result.status, 'idle');
  assert.equal((result as ConversationRecord).recoveryState, 'ready');
});

test('session restart service reuses coding workspace and does not rotate conversation state', async () => {
  const harness = createHarness();
  const result = await harness.restartSessionThread(buildCodeSession());

  assert.deepEqual(harness.threadStarts, [{
    cwd: '/tmp/code',
    securityProfile: 'repo-write',
    model: 'gpt-5-codex',
  }]);
  assert.deepEqual(harness.rotations, []);
  assert.equal(result.threadId, 'next-thread-1');
  assert.equal(result.workspace, '/tmp/code');
  assert.equal(result.status, 'idle');
  assert.equal((result as SessionRecord).networkEnabled, false);
});
