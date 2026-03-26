import test from 'node:test';
import assert from 'node:assert/strict';

import type { CodexThreadInput, ConversationRecord, SessionAttachmentRecord, SessionRecord } from '../types.js';
import { createTurnStartService } from './turn-start-service.js';

type TurnRecord = ConversationRecord | SessionRecord;

function buildAttachment(overrides: Partial<SessionAttachmentRecord> = {}): SessionAttachmentRecord {
  return {
    id: overrides.id ?? 'attachment-1',
    ownerKind: overrides.ownerKind ?? 'session',
    ownerId: overrides.ownerId ?? 'owner-1',
    sessionId: overrides.sessionId ?? 'session-1',
    ownerUserId: overrides.ownerUserId ?? 'owner-1',
    ownerUsername: overrides.ownerUsername ?? 'owner',
    kind: overrides.kind ?? 'file',
    filename: overrides.filename ?? 'note.txt',
    mimeType: overrides.mimeType ?? 'text/plain',
    sizeBytes: overrides.sizeBytes ?? 12,
    storagePath: overrides.storagePath ?? '/tmp/note.txt',
    extractedText: overrides.extractedText ?? 'note',
    consumedAt: overrides.consumedAt ?? null,
    createdAt: overrides.createdAt ?? '2026-01-01T00:00:00.000Z',
  };
}

function buildChatSession(): ConversationRecord {
  return {
    id: 'chat-1',
    ownerUserId: 'owner-1',
    ownerUsername: 'owner',
    sessionType: 'chat',
    threadId: 'thread-chat',
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
    model: 'gpt-5-codex',
    reasoningEffort: 'high',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    rolePresetId: 'preset-1',
    recoveryState: 'ready',
    retryable: false,
  };
}

function buildCodeSession(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id: overrides.id ?? 'code-1',
    ownerUserId: overrides.ownerUserId ?? 'owner-1',
    ownerUsername: overrides.ownerUsername ?? 'owner',
    sessionType: 'code',
    executor: overrides.executor ?? 'codex',
    workspaceId: overrides.workspaceId ?? 'workspace-1',
    threadId: overrides.threadId ?? 'thread-code',
    activeTurnId: overrides.activeTurnId ?? null,
    title: overrides.title ?? 'Code',
    autoTitle: overrides.autoTitle ?? false,
    workspace: overrides.workspace ?? '/tmp/code',
    archivedAt: overrides.archivedAt ?? null,
    securityProfile: overrides.securityProfile ?? 'repo-write',
    approvalMode: overrides.approvalMode ?? 'detailed',
    networkEnabled: overrides.networkEnabled ?? false,
    fullHostEnabled: overrides.fullHostEnabled ?? false,
    status: overrides.status ?? 'idle',
    lastIssue: overrides.lastIssue ?? null,
    hasTranscript: overrides.hasTranscript ?? false,
    model: overrides.model ?? 'gpt-5-codex',
    reasoningEffort: overrides.reasoningEffort ?? 'high',
    createdAt: overrides.createdAt ?? '2026-01-01T00:00:00.000Z',
    updatedAt: overrides.updatedAt ?? '2026-01-01T00:00:00.000Z',
  };
}

function createHarness() {
  const restartCalls: Array<{ sessionId: string; summary?: string }> = [];
  const prefaceCalls: Array<{ sessionId: string; recoveryPreface: string | null }> = [];
  const buildInputCalls: Array<{ prompt: string | null; attachmentIds: string[]; prefaceText: string | null | undefined }> = [];
  const updates: Array<{ recordId: string; patch: Partial<TurnRecord> }> = [];
  const consumed: Array<{ sessionId: string; attachmentIds: string[] }> = [];
  const persistedMessages: Array<{ sessionId: string; prompt: string | null; turnId: string; recoveryNeeded: boolean }> = [];
  const codexCalls: Array<{
    threadId: string;
    input: CodexThreadInput[];
    options?: {
      model?: string | null;
      effort?: SessionRecord['reasoningEffort'] | null;
      approvalMode?: SessionRecord['approvalMode'];
      securityProfile?: SessionRecord['securityProfile'];
    };
  }> = [];
  const currentRecords = new Map<string, TurnRecord>();
  let startTurnCallCount = 0;
  let throwThreadUnavailableOnce = false;

  const startTurnWithAutoRestart = createTurnStartService({
    chatRuntime: {
      async startTurn(threadId, input, options) {
        codexCalls.push({
          threadId,
          input,
          ...(options ? { options } : {}),
        });
        startTurnCallCount += 1;
        if (throwThreadUnavailableOnce && startTurnCallCount === 1) {
          throw new Error('thread not loaded');
        }
        return { turn: { id: `turn-${startTurnCallCount}`, status: 'running' } };
      },
    },
    runtimeForExecutor: () => ({
      async startTurn(threadId, input, options) {
        codexCalls.push({
          threadId,
          input,
          ...(options ? { options } : {}),
        });
        startTurnCallCount += 1;
        if (throwThreadUnavailableOnce && startTurnCallCount === 1) {
          throw new Error('thread not loaded');
        }
        return { turn: { id: `turn-${startTurnCallCount}`, status: 'running' } };
      },
    }),
    async restartSessionThread(session, summary) {
      restartCalls.push({
        sessionId: session.id,
        ...(summary ? { summary } : {}),
      });
      const restarted = {
        ...session,
        threadId: `${session.threadId}-restarted-${restartCalls.length}`,
        status: 'idle',
        recoveryState: session.sessionType === 'chat' ? 'ready' : undefined,
      } as TurnRecord;
      currentRecords.set(session.id, restarted);
      return restarted;
    },
    async getCurrentRecord(recordId) {
      return currentRecords.get(recordId) ?? null;
    },
    async prepareConversationRecoveryState() {
      return {
        recoveryNeeded: true,
        threadGeneration: 7,
        prefaceText: 'recovery memory',
      };
    },
    async resolveConversationPreface(conversation, recoveryPrefaceText) {
      prefaceCalls.push({ sessionId: conversation.id, recoveryPreface: recoveryPrefaceText });
      return recoveryPrefaceText ? `preface:${recoveryPrefaceText}` : null;
    },
    buildTurnInput(prompt, attachments, options) {
      buildInputCalls.push({
        prompt,
        attachmentIds: attachments.map((attachment) => attachment.id),
        prefaceText: options?.prefaceText,
      });
      return [{ type: 'text', text: options?.prefaceText ?? prompt ?? '', text_elements: [] }];
    },
    async updateRecord(record, patch) {
      updates.push({ recordId: record.id, patch });
      const next = { ...record, ...patch } as TurnRecord;
      currentRecords.set(record.id, next);
      return next;
    },
    async markAttachmentsConsumed(sessionId, attachmentIds) {
      consumed.push({ sessionId, attachmentIds });
    },
    async persistConversationUserTurn(conversation, prompt, _attachments, turnId, recovery) {
      persistedMessages.push({
        sessionId: conversation.id,
        prompt,
        turnId,
        recoveryNeeded: recovery.recoveryNeeded,
      });
    },
    isThreadUnavailableError(error) {
      return error instanceof Error && error.message.includes('thread not loaded');
    },
  });

  return {
    startTurnWithAutoRestart,
    restartCalls,
    prefaceCalls,
    buildInputCalls,
    updates,
    consumed,
    persistedMessages,
    codexCalls,
    currentRecords,
    setThreadUnavailableOnce() {
      throwThreadUnavailableOnce = true;
    },
  };
}

test('turn start service starts chat turns, builds preface, and persists the user message', async () => {
  const harness = createHarness();
  const session = buildChatSession();
  harness.currentRecords.set(session.id, session);
  const attachments = [buildAttachment({ sessionId: session.id, ownerKind: 'conversation' })];

  const result = await harness.startTurnWithAutoRestart(session, 'hello', attachments);

  assert.equal(result.turn.turn.id, 'turn-1');
  assert.equal(result.session.activeTurnId, 'turn-1');
  assert.deepEqual(harness.prefaceCalls, [{ sessionId: 'chat-1', recoveryPreface: 'recovery memory' }]);
  assert.deepEqual(harness.buildInputCalls, [{
    prompt: 'hello',
    attachmentIds: ['attachment-1'],
    prefaceText: 'preface:recovery memory',
  }]);
  assert.deepEqual(harness.consumed, [{ sessionId: 'chat-1', attachmentIds: ['attachment-1'] }]);
  assert.deepEqual(harness.persistedMessages, [{
    sessionId: 'chat-1',
    prompt: 'hello',
    turnId: 'turn-1',
    recoveryNeeded: true,
  }]);
});

test('turn start service restarts stale sessions before starting a turn', async () => {
  const harness = createHarness();
  const session = buildCodeSession({ status: 'stale', threadId: 'thread-stale' });
  harness.currentRecords.set(session.id, session);

  const result = await harness.startTurnWithAutoRestart(session, 'fix bug', []);

  assert.equal(result.session.threadId, 'thread-stale-restarted-1');
  assert.deepEqual(harness.restartCalls, [{
    sessionId: 'code-1',
    summary: 'Automatically created a fresh thread before sending the next prompt.',
  }]);
  assert.equal(harness.codexCalls[0]?.threadId, 'thread-stale-restarted-1');
});

test('turn start service retries after thread-unavailable errors', async () => {
  const harness = createHarness();
  harness.setThreadUnavailableOnce();
  const session = buildCodeSession({ threadId: 'thread-retry' });
  harness.currentRecords.set(session.id, {
    ...session,
    threadId: 'thread-retry-current',
  });

  const result = await harness.startTurnWithAutoRestart(session, 'retry me', []);

  assert.equal(result.turn.turn.id, 'turn-2');
  assert.deepEqual(harness.restartCalls, [{
    sessionId: 'code-1',
    summary: 'Automatically created a fresh thread after a runtime reset.',
  }]);
  assert.equal(harness.codexCalls.length, 2);
  assert.equal(harness.codexCalls[1]?.threadId, 'thread-retry-restarted-1');
});
