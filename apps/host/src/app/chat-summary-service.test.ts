import test from 'node:test';
import assert from 'node:assert/strict';

import type { ChatMessageRecord } from '../chat-history.js';
import type { CodexThread, ConversationRecord } from '../types.js';
import { generateChatConversationSummary } from './chat-summary-service.js';

function buildConversation(overrides: Partial<ConversationRecord> = {}): ConversationRecord {
  return {
    id: 'conversation-1',
    ownerUserId: 'user-1',
    ownerUsername: 'owner',
    sessionType: 'chat',
    executor: 'claude-code',
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
    recoveryState: 'ready',
    retryable: false,
    lastIssue: null,
    hasTranscript: true,
    model: 'sonnet',
    reasoningEffort: 'high',
    rolePresetId: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function buildMessage(body: string): ChatMessageRecord {
  return {
    id: 'message-1',
    conversationId: 'conversation-1',
    ownerUserId: 'user-1',
    seq: 1,
    threadGeneration: 1,
    role: 'user',
    body,
    attachments: [],
    sourceThreadId: null,
    sourceTurnId: null,
    sourceItemId: null,
    dedupeKey: null,
    createdAt: '2026-01-01T00:00:00.000Z',
  };
}

test('generateChatConversationSummary uses the supplied summary runtime configuration', async () => {
  const threadStarts: Array<{ cwd: string; securityProfile: string; model?: string | null }> = [];
  const turnStarts: Array<{
    threadId: string;
    inputText: string;
    model?: string | null | undefined;
    effort?: string | null | undefined;
  }> = [];
  const waits: Array<{ threadId: string; turnId: string; executor: string }> = [];
  const summaryThread: CodexThread = {
    id: 'summary-thread',
    preview: 'summary',
    cwd: '/tmp/chat',
    name: 'chat',
    path: '/tmp/chat',
    cliVersion: null,
    source: 'codex',
    modelProvider: 'openai',
    status: { type: 'idle' },
    updatedAt: 1,
    turns: [{
      id: 'summary-turn',
      status: 'completed',
      error: null,
      items: [],
    }],
  };

  const result = await generateChatConversationSummary(
    buildConversation(),
    null,
    [buildMessage('Summarize this conversation')],
    {
      summaryRuntime: {
        async startThread(options) {
          threadStarts.push(options);
          return { thread: { id: 'summary-thread' } };
        },
        async startTurn(threadId, input, options) {
          turnStarts.push({
            threadId,
            inputText: input[0]?.type === 'text' ? input[0].text : '',
            model: options?.model,
            effort: options?.effort,
          });
          return { turn: { id: 'summary-turn', status: 'running' } };
        },
      },
      summaryExecutor: 'codex',
      summaryModel: 'gpt-5.4',
      summaryEffort: 'xhigh',
      buildSummaryPrompt: (_existingSummary, messages) => `Summarize: ${messages[0]?.body ?? ''}`,
      textThreadInput: (text) => ({
        type: 'text',
        text,
        text_elements: [],
      }),
      waitForTurnThread: async (threadId, turnId, executor) => {
        waits.push({ threadId, turnId, executor });
        return summaryThread;
      },
      assistantTextFromTurn: () => '  compact summary  ',
    },
  );

  assert.equal(result, 'compact summary');
  assert.deepEqual(threadStarts, [{
    cwd: '/tmp/chat',
    securityProfile: 'read-only',
    model: 'gpt-5.4',
  }]);
  assert.deepEqual(turnStarts, [{
    threadId: 'summary-thread',
    inputText: 'Summarize: Summarize this conversation',
    model: 'gpt-5.4',
    effort: 'xhigh',
  }]);
  assert.deepEqual(waits, [{
    threadId: 'summary-thread',
    turnId: 'summary-turn',
    executor: 'codex',
  }]);
});

test('generateChatConversationSummary returns the existing summary when there are no messages', async () => {
  const result = await generateChatConversationSummary(
    buildConversation(),
    '  existing summary  ',
    [],
    {
      summaryRuntime: {
        async startThread() {
          throw new Error('should not start a thread');
        },
        async startTurn() {
          throw new Error('should not start a turn');
        },
      },
      summaryExecutor: 'codex',
      summaryModel: 'gpt-5.4',
      summaryEffort: 'xhigh',
      buildSummaryPrompt: () => '',
      textThreadInput: () => ({
        type: 'text',
        text: '',
        text_elements: [],
      }),
      waitForTurnThread: async () => {
        throw new Error('should not wait for a thread');
      },
      assistantTextFromTurn: () => null,
    },
  );

  assert.equal(result, 'existing summary');
});
