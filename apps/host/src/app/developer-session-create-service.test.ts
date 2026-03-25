import test from 'node:test';
import assert from 'node:assert/strict';

import type { UserRecord, WorkspaceSummary } from '../types.js';
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

function createHarness() {
  const threadStarts: Array<{ cwd: string; securityProfile: string; model?: string | null }> = [];
  const persisted: Array<{ id: string; title: string; securityProfile: string; approvalMode: string }> = [];

  const createDeveloperSession = createDeveloperSessionService({
    codex: {
      async startThread(options) {
        threadStarts.push(options);
        return { thread: { id: 'thread-1' } };
      },
    },
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
    currentDefaultModel: () => 'gpt-5-default',
    currentDefaultEffort: () => 'medium',
    defaultCodingSessionTitle: (index = 1) => `Session ${index}`,
    trimOptional: (value) => {
      const next = typeof value === 'string' ? value.trim() : '';
      return next || null;
    },
    normalizeReasoningEffort: (value) => value === 'high' ? 'high' : null,
    normalizeSecurityProfile: (value) => value === 'full-host' || value === 'read-only' ? value : 'repo-write',
    normalizeApprovalMode: (value) => value === 'full-approval' ? 'full-approval' : 'less-approval',
    randomId: () => 'session-1',
    now: () => '2026-02-01T00:00:00.000Z',
  });

  return { createDeveloperSession, threadStarts, persisted };
}

test('developer session create service builds a default titled coding session', async () => {
  const harness = createHarness();
  const result = await harness.createDeveloperSession(buildUser(), buildWorkspace(), {});

  assert.equal(result.title, 'Session 3');
  assert.equal(result.autoTitle, true);
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
    approvalMode: 'full-approval',
  });

  assert.equal(result.title, 'Custom title');
  assert.equal(result.autoTitle, false);
  assert.equal(result.securityProfile, 'repo-write');
  assert.equal(result.approvalMode, 'full-approval');
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
