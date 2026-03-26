import test from 'node:test';
import assert from 'node:assert/strict';

import type { ConversationRecord, SessionAttachmentRecord } from '../types.js';
import { ChatTurnServiceError, createChatTurnService } from './chat-turn-service.js';

type ChatTurnServiceOptions = Parameters<typeof createChatTurnService>[0];

function buildConversation(overrides?: Partial<ConversationRecord>): ConversationRecord {
  const { executor = 'codex', ...rest } = overrides ?? {};
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
    recoveryState: 'ready',
    retryable: false,
    lastIssue: null,
    hasTranscript: false,
    model: 'gpt-5-default',
    reasoningEffort: 'medium',
    rolePresetId: null,
    createdAt: '2026-02-01T00:00:00.000Z',
    updatedAt: '2026-02-01T00:00:00.000Z',
    ...rest,
  };
}

function buildAttachment(
  id: string,
  overrides?: Partial<SessionAttachmentRecord>,
): SessionAttachmentRecord {
  return {
    id,
    ownerKind: 'conversation',
    ownerId: 'conversation-1',
    sessionId: 'conversation-1',
    ownerUserId: 'user-1',
    ownerUsername: 'owner',
    kind: 'file',
    filename: `${id}.txt`,
    mimeType: 'text/plain',
    sizeBytes: 10,
    storagePath: `/tmp/${id}.txt`,
    extractedText: null,
    consumedAt: null,
    createdAt: '2026-02-01T00:00:00.000Z',
    ...overrides,
  };
}

function createHarness() {
  const attachments = new Map<string, SessionAttachmentRecord>([
    ['attachment-1', buildAttachment('attachment-1')],
    ['attachment-2', buildAttachment('attachment-2')],
  ]);
  const turnStarts: Array<{
    conversationId: string;
    prompt: string | null;
    attachmentIds: string[];
  }> = [];
  const interrupts: Array<{ threadId: string; turnId: string }> = [];
  const liveEvents: Array<{ id: string; method: string; summary: string; createdAt: string }> = [];
  const updates: Array<Partial<ConversationRecord>> = [];

  const options: ChatTurnServiceOptions = {
    store: {
      getAttachment(conversationId: string, attachmentId: string) {
        assert.equal(conversationId, 'conversation-1');
        return attachments.get(attachmentId) ?? null;
      },
      addLiveEvent(sessionId, event) {
        assert.equal(sessionId, 'conversation-1');
        liveEvents.push(event);
      },
    },
    async interruptTurn(_conversation, threadId: string, turnId: string) {
      interrupts.push({ threadId, turnId });
    },
    async startTurnWithAutoRestart(conversation, prompt, nextAttachments) {
      turnStarts.push({
        conversationId: conversation.id,
        prompt,
        attachmentIds: nextAttachments.map((attachment) => attachment.id),
      });
      return {
        turn: { id: 'turn-new' },
        session: {
          ...conversation,
          activeTurnId: 'turn-new',
          status: 'running',
        },
      };
    },
    async updateConversation(conversation, patch) {
      updates.push(patch);
      return {
        ...conversation,
        ...patch,
      };
    },
    isThreadUnavailableError: (error) => (
      error instanceof Error && error.message.includes('thread not loaded')
    ),
    unavailableConversationPatch: () => ({
      activeTurnId: null,
      status: 'error',
      recoveryState: 'stale',
      retryable: true,
      lastIssue: 'This turn was interrupted before it finished. Send the next prompt to retry.',
      networkEnabled: false,
    }),
    errorMessage: (error) => error instanceof Error ? error.message : String(error),
    staleSessionMessage: 'Codex runtime restarted. The next prompt will create a fresh thread.',
    randomId: () => 'event-1',
    now: () => '2026-02-01T00:00:00.000Z',
  };

  return {
    attachments,
    turnStarts,
    interrupts,
    liveEvents,
    updates,
    service: createChatTurnService(options),
    options,
  };
}

test('chat turn service requires a prompt or attachment', async () => {
  const harness = createHarness();

  await assert.rejects(
    harness.service.createMessage(buildConversation(), {}),
    (error: unknown) => {
      assert.ok(error instanceof ChatTurnServiceError);
      assert.equal(error.statusCode, 400);
      assert.equal(error.message, 'Prompt or attachment is required.');
      return true;
    },
  );
});

test('chat turn service rejects missing or consumed attachments', async () => {
  const harness = createHarness();
  harness.attachments.set('attachment-2', buildAttachment('attachment-2', {
    consumedAt: '2026-02-01T00:00:00.000Z',
  }));

  await assert.rejects(
    harness.service.createMessage(buildConversation(), {
      attachmentIds: ['missing', 'attachment-2'],
    }),
    /One or more attachments are missing or already used\./,
  );
});

test('chat turn service starts turns with trimmed prompts and deduped attachments', async () => {
  const harness = createHarness();
  const result = await harness.service.createMessage(buildConversation(), {
    prompt: '  Hello world  ',
    attachmentIds: ['attachment-1', 'attachment-1', 'attachment-2'],
  });

  assert.deepEqual(harness.turnStarts, [{
    conversationId: 'conversation-1',
    prompt: 'Hello world',
    attachmentIds: ['attachment-1', 'attachment-2'],
  }]);
  assert.deepEqual(result, {
    turn: { id: 'turn-new' },
    conversation: {
      ...buildConversation(),
      activeTurnId: 'turn-new',
      status: 'running',
    },
  });
});

test('chat turn service patches conversation state when turn start fails', async () => {
  const harness = createHarness();
  const service = createChatTurnService({
    ...harness.options,
    async startTurnWithAutoRestart() {
      throw new Error('start failed');
    },
  });

  await assert.rejects(
    service.createMessage(buildConversation(), { prompt: 'hi' }),
    (error: unknown) => {
      assert.ok(error instanceof ChatTurnServiceError);
      assert.equal(error.statusCode, 500);
      assert.equal(error.message, 'start failed');
      return true;
    },
  );
  assert.deepEqual(harness.updates[0], {
    activeTurnId: null,
    status: 'error',
    recoveryState: 'ready',
    retryable: true,
    lastIssue: 'start failed',
  });
});

test('chat turn service blocks stop when there is no active turn', async () => {
  const harness = createHarness();

  await assert.rejects(
    harness.service.stopTurn(buildConversation({ activeTurnId: null, status: 'idle' })),
    /does not have an active turn to stop/i,
  );
});

test('chat turn service interrupts active turns and records a live event', async () => {
  const harness = createHarness();
  const result = await harness.service.stopTurn(buildConversation());

  assert.deepEqual(harness.interrupts, [{
    threadId: 'thread-1',
    turnId: 'turn-1',
  }]);
  assert.deepEqual(harness.liveEvents, [{
    id: 'event-1',
    method: 'turn/interrupted',
    summary: 'Stopped the active turn.',
    createdAt: '2026-02-01T00:00:00.000Z',
  }]);
  assert.equal(result.activeTurnId, null);
  assert.equal(result.status, 'idle');
  assert.equal(result.lastIssue, 'Stopped by user.');
});

test('chat turn service marks stale sessions when the runtime thread is gone', async () => {
  const harness = createHarness();
  const service = createChatTurnService({
    ...harness.options,
    async interruptTurn() {
      throw new Error('thread not loaded');
    },
  });

  await assert.rejects(
    service.stopTurn(buildConversation()),
    (error: unknown) => {
      assert.ok(error instanceof ChatTurnServiceError);
      assert.equal(error.statusCode, 409);
      assert.equal(error.message, 'Codex runtime restarted. The next prompt will create a fresh thread.');
      assert.equal(error.conversation?.recoveryState, 'stale');
      return true;
    },
  );
});

test('chat turn service patches error state when interrupting fails', async () => {
  const harness = createHarness();
  const service = createChatTurnService({
    ...harness.options,
    async interruptTurn() {
      throw new Error('interrupt failed');
    },
  });

  await assert.rejects(
    service.stopTurn(buildConversation()),
    (error: unknown) => {
      assert.ok(error instanceof ChatTurnServiceError);
      assert.equal(error.statusCode, 500);
      assert.equal(error.message, 'interrupt failed');
      return true;
    },
  );
  assert.deepEqual(harness.updates[0], {
    activeTurnId: null,
    status: 'error',
    recoveryState: 'ready',
    retryable: true,
    lastIssue: 'interrupt failed',
  });
});
