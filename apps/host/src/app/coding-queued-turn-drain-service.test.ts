import test from 'node:test';
import assert from 'node:assert/strict';

import type { QueuedCodingTurnRecord } from '../coding/repository.js';
import type { SessionAttachmentRecord, SessionEvent, SessionRecord } from '../types.js';
import {
  QUEUED_ATTACHMENT_ERROR,
  createCodingQueuedTurnDrainService,
} from './coding-queued-turn-drain-service.js';

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
    title: 'Session',
    autoTitle: false,
    workspace: '/tmp/workspace',
    archivedAt: null,
    securityProfile: 'repo-write',
    approvalMode: 'detailed',
    networkEnabled: false,
    fullHostEnabled: false,
    status: 'idle',
    lastIssue: null,
    hasTranscript: true,
    model: 'gpt-5-codex',
    reasoningEffort: 'high',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function buildQueuedTurn(overrides: Partial<QueuedCodingTurnRecord> = {}): QueuedCodingTurnRecord {
  return {
    id: 'queued-1',
    sessionId: 'session-1',
    ownerUserId: 'user-1',
    prompt: 'follow-up',
    attachmentIds: ['attachment-1'],
    status: 'queued',
    queuedAfterTurnId: 'turn-1',
    createdAt: '2026-01-01T00:10:00.000Z',
    updatedAt: '2026-01-01T00:10:00.000Z',
    ...overrides,
  };
}

function buildAttachment(overrides: Partial<SessionAttachmentRecord> = {}): SessionAttachmentRecord {
  return {
    id: 'attachment-1',
    ownerKind: 'session',
    ownerId: 'session-1',
    sessionId: 'session-1',
    ownerUserId: 'user-1',
    ownerUsername: 'owner',
    kind: 'file',
    filename: 'notes.txt',
    mimeType: 'text/plain',
    sizeBytes: 12,
    storagePath: '/tmp/notes.txt',
    extractedText: null,
    consumedAt: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function createHarness(overrides?: {
  session?: SessionRecord | null;
  queuedTurn?: QueuedCodingTurnRecord | null;
  attachment?: SessionAttachmentRecord | null;
  startError?: Error | null;
}) {
  const startedTurns: Array<{ prompt: string | null; attachmentIds: string[] }> = [];
  const updatedSessions: Array<Partial<SessionRecord>> = [];
  const liveEvents: SessionEvent[] = [];
  const deletedQueuedTurns: string[] = [];
  const resetQueuedTurns: string[] = [];

  const drain = createCodingQueuedTurnDrainService({
    async getSession() {
      return overrides?.session ?? buildSession();
    },
    async claimNextQueuedTurn() {
      return overrides?.queuedTurn ?? buildQueuedTurn();
    },
    async resetQueuedTurnToQueued(_sessionId, queuedTurnId) {
      resetQueuedTurns.push(queuedTurnId);
      return buildQueuedTurn({ id: queuedTurnId });
    },
    async deleteQueuedTurn(_sessionId, queuedTurnId) {
      deletedQueuedTurns.push(queuedTurnId);
      return true;
    },
    getAttachment() {
      return overrides?.attachment === undefined ? buildAttachment() : overrides.attachment;
    },
    async startTurnWithAutoRestart(_session, prompt, attachments) {
      if (overrides?.startError) {
        throw overrides.startError;
      }
      startedTurns.push({
        prompt,
        attachmentIds: attachments.map((attachment) => attachment.id),
      });
    },
    async updateCodingSession(_sessionId, patch) {
      updatedSessions.push(patch);
      return { ...buildSession(), ...patch };
    },
    addLiveEvent(_sessionId, event) {
      liveEvents.push(event);
    },
    errorMessage(error) {
      return error instanceof Error ? error.message : String(error);
    },
    randomId: () => 'event-1',
    now: () => '2026-01-02T00:00:00.000Z',
  });

  return {
    drain,
    startedTurns,
    updatedSessions,
    liveEvents,
    deletedQueuedTurns,
    resetQueuedTurns,
  };
}

test('queued turn drain service starts the next queued turn for idle sessions', async () => {
  const harness = createHarness();

  const result = await harness.drain('session-1');

  assert.equal(result, true);
  assert.deepEqual(harness.startedTurns, [{
    prompt: 'follow-up',
    attachmentIds: ['attachment-1'],
  }]);
  assert.deepEqual(harness.deletedQueuedTurns, ['queued-1']);
  assert.equal(harness.updatedSessions.length, 0);
});

test('queued turn drain service does nothing when the session is not idle', async () => {
  const harness = createHarness({
    session: buildSession({
      activeTurnId: 'turn-2',
      status: 'running',
    }),
  });

  const result = await harness.drain('session-1');

  assert.equal(result, false);
  assert.equal(harness.startedTurns.length, 0);
  assert.equal(harness.deletedQueuedTurns.length, 0);
});

test('queued turn drain service restores queued turns when auto-start fails', async () => {
  const harness = createHarness({
    startError: new Error('runtime start failed'),
  });

  const result = await harness.drain('session-1');

  assert.equal(result, false);
  assert.deepEqual(harness.resetQueuedTurns, ['queued-1']);
  assert.deepEqual(harness.updatedSessions, [{
    activeTurnId: null,
    status: 'error',
    lastIssue: 'runtime start failed',
  }]);
  assert.deepEqual(harness.liveEvents, [{
    id: 'event-1',
    method: 'turn/queued-start-failed',
    summary: 'runtime start failed',
    createdAt: '2026-01-02T00:00:00.000Z',
  }]);
});

test('queued turn drain service fails queued turns with missing attachments', async () => {
  const harness = createHarness({
    attachment: null,
  });

  const result = await harness.drain('session-1');

  assert.equal(result, false);
  assert.deepEqual(harness.resetQueuedTurns, ['queued-1']);
  assert.deepEqual(harness.updatedSessions, [{
    activeTurnId: null,
    status: 'error',
    lastIssue: QUEUED_ATTACHMENT_ERROR,
  }]);
  assert.equal(harness.liveEvents[0]?.summary, QUEUED_ATTACHMENT_ERROR);
});
