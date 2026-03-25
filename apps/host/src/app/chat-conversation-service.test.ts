import test from 'node:test';
import assert from 'node:assert/strict';

import type { ConversationRecord, ModelOption, UserRecord } from '../types.js';
import {
  ChatConversationServiceError,
  createChatConversationService,
} from './chat-conversation-service.js';

type ChatConversationServiceOptions = Parameters<typeof createChatConversationService>[0];

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

function buildConversation(overrides?: Partial<ConversationRecord>): ConversationRecord {
  return {
    id: 'conversation-1',
    ownerUserId: 'user-1',
    ownerUsername: 'owner',
    sessionType: 'chat',
    threadId: 'thread-1',
    activeTurnId: null,
    title: 'New chat',
    autoTitle: true,
    workspace: '/tmp/chat',
    archivedAt: null,
    securityProfile: 'repo-write',
    approvalMode: 'less-approval',
    networkEnabled: false,
    fullHostEnabled: false,
    status: 'idle',
    recoveryState: 'ready',
    retryable: false,
    lastIssue: null,
    hasTranscript: false,
    model: 'gpt-5-default',
    reasoningEffort: 'medium',
    rolePresetId: 'preset-default',
    createdAt: '2026-02-01T00:00:00.000Z',
    updatedAt: '2026-02-01T00:00:00.000Z',
    ...overrides,
  };
}

function buildModel(model = 'gpt-5-default'): ModelOption {
  return {
    id: model,
    displayName: model,
    model,
    description: `${model} description`,
    isDefault: model === 'gpt-5-default',
    hidden: false,
    defaultReasoningEffort: 'medium',
    supportedReasoningEfforts: ['low', 'medium', 'high'],
  };
}

function createHarness() {
  const threadStarts: Array<{ cwd: string; securityProfile: string; model?: string | null }> = [];
  const persisted: ConversationRecord[] = [];
  const histories: string[] = [];
  const updates: Array<Partial<ConversationRecord>> = [];
  const models = [buildModel('gpt-5-default'), buildModel('gpt-5-codex')];

  const options: ChatConversationServiceOptions = {
    codex: {
      async startThread(options: { cwd: string; securityProfile: string; model?: string | null }) {
        threadStarts.push(options);
        return { thread: { id: 'thread-new' } };
      },
    },
    async ensureChatWorkspace() {
      return { path: '/tmp/chat' };
    },
    async persistConversation(conversation: ConversationRecord) {
      persisted.push(conversation);
    },
    async ensureConversationHistory(conversation: ConversationRecord) {
      histories.push(conversation.id);
    },
    async updateConversation(conversation: ConversationRecord, patch: Partial<ConversationRecord>) {
      updates.push(patch);
      return {
        ...conversation,
        ...patch,
      };
    },
    currentDefaultModel: () => 'gpt-5-default',
    currentDefaultEffort: () => 'medium',
    defaultChatTitle: () => 'New chat',
    trimOptional: (value: unknown) => {
      const next = typeof value === 'string' ? value.trim() : '';
      return next || null;
    },
    normalizeReasoningEffort: (value: unknown) => (
      value === 'low' || value === 'medium' || value === 'high'
        ? value
        : null
    ),
    findModelOption: (model: string | null | undefined) => models.find((entry) => entry.model === model) ?? null,
    preferredReasoningEffortForModel: (modelOption: ModelOption) => (
      modelOption.supportedReasoningEfforts.includes('high') ? 'high' : 'medium'
    ),
    async loadChatRolePresetConfig() {
      return {
        defaultPresetId: 'preset-default',
        presets: [
          { id: 'preset-default', label: 'Default', description: null, promptText: 'default prompt' },
          { id: 'preset-alt', label: 'Alt', description: null, promptText: 'alt prompt' },
        ],
      };
    },
    normalizeChatRolePresetId: (value: string | null | undefined, config) => (
      config.presets.some((entry) => entry.id === value) ? value ?? null : null
    ),
    randomId: () => 'conversation-new',
    now: () => '2026-02-01T00:00:00.000Z',
  };

  return {
    options,
    service: createChatConversationService(options),
    threadStarts,
    persisted,
    histories,
    updates,
  };
}

test('chat conversation service creates a conversation with defaults', async () => {
  const harness = createHarness();
  const result = await harness.service.createConversation(buildUser(), {});

  assert.equal(result.id, 'conversation-new');
  assert.equal(result.title, 'New chat');
  assert.equal(result.autoTitle, true);
  assert.equal(result.model, 'gpt-5-default');
  assert.equal(result.reasoningEffort, 'medium');
  assert.equal(result.rolePresetId, 'preset-default');
  assert.deepEqual(harness.threadStarts, [{
    cwd: '/tmp/chat',
    securityProfile: 'repo-write',
    model: 'gpt-5-default',
  }]);
  assert.equal(harness.persisted.length, 1);
  assert.deepEqual(harness.histories, ['conversation-new']);
});

test('chat conversation service clears role preset when explicitly blank', async () => {
  const harness = createHarness();
  const result = await harness.service.createConversation(buildUser(), {
    title: '  hello  ',
    rolePresetId: '   ',
    model: 'gpt-5-codex',
    reasoningEffort: 'high',
  });

  assert.equal(result.title, 'hello');
  assert.equal(result.autoTitle, false);
  assert.equal(result.rolePresetId, null);
  assert.equal(result.model, 'gpt-5-codex');
  assert.equal(result.reasoningEffort, 'high');
});

test('chat conversation service rejects unknown role preset ids', async () => {
  const harness = createHarness();

  await assert.rejects(
    harness.service.createConversation(buildUser(), { rolePresetId: 'missing' }),
    (error: unknown) => {
      assert.ok(error instanceof ChatConversationServiceError);
      assert.equal(error.statusCode, 400);
      assert.equal(error.message, 'Unknown role preset.');
      return true;
    },
  );
});

test('chat conversation service wraps workspace provisioning errors', async () => {
  const harness = createHarness();
  const service = createChatConversationService({
    ...harness.options,
    ensureChatWorkspace: async () => {
      throw new Error('workspace failed');
    },
  });

  await assert.rejects(
    service.createConversation(buildUser(), {}),
    (error: unknown) => {
      assert.ok(error instanceof ChatConversationServiceError);
      assert.equal(error.statusCode, 400);
      assert.equal(error.message, 'workspace failed');
      return true;
    },
  );
});

test('chat conversation service renames conversations', async () => {
  const harness = createHarness();
  const conversation = buildConversation();
  const result = await harness.service.renameConversation(conversation, { title: '  Renamed  ' });

  assert.equal(result.title, 'Renamed');
  assert.equal(result.autoTitle, false);
  assert.deepEqual(harness.updates[0], {
    title: 'Renamed',
    autoTitle: false,
  });
});

test('chat conversation service rejects empty conversation titles', async () => {
  const harness = createHarness();

  await assert.rejects(
    harness.service.renameConversation(buildConversation(), { title: '   ' }),
    /Conversation title is required\./,
  );
});

test('chat conversation service updates preferences and preserves preset when omitted', async () => {
  const harness = createHarness();
  const conversation = buildConversation({
    model: 'gpt-5-default',
    reasoningEffort: 'medium',
    rolePresetId: 'preset-alt',
  });
  const result = await harness.service.updateConversationPreferences(conversation, {
    model: 'gpt-5-codex',
    reasoningEffort: 'low',
  });

  assert.equal(result.model, 'gpt-5-codex');
  assert.equal(result.reasoningEffort, 'low');
  assert.equal(result.rolePresetId, 'preset-alt');
});

test('chat conversation service falls back to preferred effort and can clear role preset', async () => {
  const harness = createHarness();
  const result = await harness.service.updateConversationPreferences(buildConversation(), {
    model: 'gpt-5-codex',
    reasoningEffort: 'none',
    rolePresetId: '',
  });

  assert.equal(result.reasoningEffort, 'high');
  assert.equal(result.rolePresetId, null);
});

test('chat conversation service rejects unknown models', async () => {
  const harness = createHarness();

  await assert.rejects(
    harness.service.updateConversationPreferences(buildConversation(), { model: 'missing-model' }),
    (error: unknown) => {
      assert.ok(error instanceof ChatConversationServiceError);
      assert.equal(error.statusCode, 400);
      assert.equal(error.message, 'Unknown model.');
      return true;
    },
  );
});

test('chat conversation service archives and restores conversations', async () => {
  const harness = createHarness();
  const archived = await harness.service.archiveConversation(buildConversation({
    activeTurnId: 'turn-1',
    status: 'running',
    networkEnabled: true,
    lastIssue: 'boom',
  }));
  const restored = await harness.service.restoreConversation({
    ...archived,
    archivedAt: '2026-02-01T00:00:00.000Z',
  });

  assert.equal(archived.archivedAt, '2026-02-01T00:00:00.000Z');
  assert.equal(archived.activeTurnId, null);
  assert.equal(archived.status, 'idle');
  assert.equal(archived.networkEnabled, false);
  assert.equal(restored.archivedAt, null);
  assert.equal(restored.status, 'idle');
  assert.equal(restored.lastIssue, null);
});
