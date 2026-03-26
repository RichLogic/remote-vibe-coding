import test from 'node:test';
import assert from 'node:assert/strict';

import type { ModelOption, UserRecord, WorkspaceSummary } from '../types.js';
import { createDeveloperSessionService } from './developer-session-create-service.js';

function buildUser(canUseFullHost = false): UserRecord {
  return {
    id: 'owner-1',
    username: 'owner',
    roles: ['developer'],
    preferredMode: 'developer',
    isAdmin: false,
    allowedSessionTypes: ['code'],
    canUseFullHost,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

function buildWorkspace(): WorkspaceSummary {
  return {
    id: 'workspace-1',
    name: 'repo',
    path: '/tmp/repo',
    visible: true,
    sortOrder: 0,
  };
}

function buildModelOption(model: string, options?: {
  isDefault?: boolean;
  supportedReasoningEfforts?: ModelOption['supportedReasoningEfforts'];
  defaultReasoningEffort?: ModelOption['defaultReasoningEffort'];
}): ModelOption {
  return {
    id: model,
    displayName: model,
    model,
    description: `${model} description`,
    isDefault: options?.isDefault ?? false,
    hidden: false,
    defaultReasoningEffort: options?.defaultReasoningEffort ?? 'medium',
    supportedReasoningEfforts: options?.supportedReasoningEfforts ?? ['medium', 'high'],
  };
}

function createHarness(overrides: {
  isExecutorSupported?: (executor: 'codex' | 'claude-code') => boolean;
  currentDefaultModel?: (executor?: 'codex' | 'claude-code') => string;
  findModelOption?: (model: string, executor?: 'codex' | 'claude-code') => ModelOption | null;
} = {}) {
  const threadStarts: Array<{ cwd: string; securityProfile: string; model?: string | null }> = [];
  const persisted: Array<{ id: string; title: string; securityProfile: string; approvalMode: string }> = [];
  const requestedExecutors: string[] = [];

  const createDeveloperSession = createDeveloperSessionService({
    isExecutorSupported: overrides.isExecutorSupported ?? ((executor) => executor === 'codex'),
    runtimeForExecutor: (executor) => ({
      async startThread(options) {
        requestedExecutors.push(executor);
        threadStarts.push(options);
        return { thread: { id: 'thread-1' } };
      },
    }),
    async countSessionsForWorkspace() {
      return 2;
    },
    async persistSession(session) {
      persisted.push({
        id: session.id,
        title: session.title,
        securityProfile: session.securityProfile,
        approvalMode: session.approvalMode,
      });
    },
    currentDefaultExecutor: () => 'codex',
    currentDefaultModel: overrides.currentDefaultModel ?? ((executor) => (
      executor === 'claude-code' ? 'claude-code-main' : 'gpt-5-default'
    )),
    defaultCodingSessionTitle: (index = 1) => `Session ${index}`,
    trimOptional: (value) => {
      const next = typeof value === 'string' ? value.trim() : '';
      return next || null;
    },
    normalizeExecutor: (value) => value === 'claude-code' ? 'claude-code' : 'codex',
    normalizeReasoningEffort: (value) => value === 'high' ? 'high' : null,
    findModelOption: overrides.findModelOption ?? ((model, executor) => {
      if (executor === 'claude-code') {
        return model === 'claude-code-main'
          ? buildModelOption(model, { isDefault: true })
          : null;
      }
      return buildModelOption(model, { isDefault: model === 'gpt-5-default' });
    }),
    preferredReasoningEffortForModel: (modelOption) => modelOption.defaultReasoningEffort,
    normalizeSecurityProfile: (value) => value === 'full-host' || value === 'read-only' ? value : 'repo-write',
    normalizeApprovalMode: (value) => value === 'full-auto' ? 'full-auto' : 'detailed',
    randomId: () => 'session-1',
    now: () => '2026-02-01T00:00:00.000Z',
  });

  return { createDeveloperSession, threadStarts, persisted, requestedExecutors };
}

test('developer session create service builds a default titled coding session', async () => {
  const harness = createHarness();
  const result = await harness.createDeveloperSession(buildUser(), buildWorkspace(), {});

  assert.equal(result.title, 'Session 3');
  assert.equal(result.autoTitle, true);
  assert.equal(result.executor, 'codex');
  assert.equal(result.model, 'gpt-5-default');
  assert.equal(result.reasoningEffort, 'medium');
  assert.deepEqual(harness.threadStarts, [{
    cwd: '/tmp/repo',
    securityProfile: 'repo-write',
    model: 'gpt-5-default',
  }]);
  assert.equal(harness.persisted.length, 1);
});

test('developer session create service normalizes read-only and respects explicit preferences', async () => {
  const harness = createHarness();
  const result = await harness.createDeveloperSession(buildUser(), buildWorkspace(), {
    title: '  Custom title  ',
    model: 'gpt-5-codex',
    reasoningEffort: 'high',
    securityProfile: 'read-only',
    approvalMode: 'full-auto',
  });

  assert.equal(result.title, 'Custom title');
  assert.equal(result.autoTitle, false);
  assert.equal(result.securityProfile, 'repo-write');
  assert.equal(result.approvalMode, 'full-auto');
  assert.equal(result.reasoningEffort, 'high');
});

test('developer session create service blocks unauthorized full-host sessions', async () => {
  const harness = createHarness();

  await assert.rejects(
    harness.createDeveloperSession(buildUser(false), buildWorkspace(), {
      securityProfile: 'full-host',
    }),
    /do not have permission to create full-host sessions/i,
  );
});

test('developer session create service allows full-host for authorized users', async () => {
  const harness = createHarness();
  const result = await harness.createDeveloperSession(buildUser(true), buildWorkspace(), {
    securityProfile: 'full-host',
  });

  assert.equal(result.securityProfile, 'full-host');
  assert.equal(result.fullHostEnabled, true);
});

test('developer session create service chooses the runtime for the requested executor', async () => {
  const harness = createHarness();

  await assert.rejects(
    harness.createDeveloperSession(buildUser(), buildWorkspace(), {
      executor: 'claude-code',
    }),
    /executor "claude-code" is not available/i,
  );
});

test('developer session create service chooses executor-specific defaults when the executor is available', async () => {
  const harness = createHarness({
    isExecutorSupported: () => true,
  });
  const result = await harness.createDeveloperSession(buildUser(), buildWorkspace(), {
    executor: 'claude-code',
  });

  assert.equal(result.executor, 'claude-code');
  assert.equal(result.model, 'claude-code-main');
  assert.equal(result.reasoningEffort, 'medium');
  assert.deepEqual(harness.requestedExecutors, ['claude-code']);
});

test('developer session create service rejects unknown models for the requested executor', async () => {
  const harness = createHarness({
    currentDefaultModel: () => 'unknown-model',
    findModelOption: () => null,
  });

  await assert.rejects(
    harness.createDeveloperSession(buildUser(), buildWorkspace(), {}),
    /unknown model/i,
  );
});
