import test from 'node:test';
import assert from 'node:assert/strict';

import type { JsonRpcServerRequest } from '../codex-app-server.js';
import type { ConversationRecord, PendingApproval, SessionEvent, SessionRecord } from '../types.js';
import { createCodexServerRequestHandler } from './codex-server-request-handler.js';

type TurnRecord = ConversationRecord | SessionRecord;

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
    approvalMode: 'less-approval',
    networkEnabled: false,
    fullHostEnabled: false,
    status: 'idle',
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
    activeTurnId: null,
    title: 'Code',
    autoTitle: false,
    workspace: '/tmp/code',
    archivedAt: null,
    securityProfile: 'repo-write',
    approvalMode: 'less-approval',
    networkEnabled: false,
    fullHostEnabled: false,
    status: 'idle',
    lastIssue: null,
    hasTranscript: true,
    model: 'gpt-5-codex',
    reasoningEffort: 'high',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

function createHarness(session: TurnRecord | null) {
  const responses: Array<{ id: number | string; result: unknown }> = [];
  const approvals: PendingApproval[] = [];
  const liveEvents: Array<{ sessionId: string; event: SessionEvent }> = [];
  const updatedRecords: Array<{ recordId: string; patch: Partial<TurnRecord> }> = [];
  const codingUpdates: Array<{ sessionId: string; patch: Partial<SessionRecord> }> = [];

  const handler = createCodexServerRequestHandler({
    codex: {
      async respond(id, result) {
        responses.push({ id, result });
      },
    },
    store: {
      addApproval(approval) {
        approvals.push(approval);
      },
      addLiveEvent(sessionId, event) {
        liveEvents.push({ sessionId, event });
      },
    },
    coding: {
      async updateSession(sessionId, patch) {
        codingUpdates.push({ sessionId, patch });
      },
    },
    async findRecordByThreadId(threadId) {
      return session && session.threadId === threadId ? session : null;
    },
    async updateRecord(record, patch) {
      updatedRecords.push({ recordId: record.id, patch });
      return { ...record, ...patch } as TurnRecord;
    },
    approvalTitle(method) {
      return `title:${method}`;
    },
    approvalRisk(method) {
      return `risk:${method}`;
    },
    blockedChatPermissionReason(params) {
      return (params as { blocked?: string } | undefined)?.blocked ?? null;
    },
    requestedPermissionsFromParams(params) {
      return ((params as { permissions?: Record<string, unknown> } | undefined)?.permissions) ?? {};
    },
    randomId: () => 'event-1',
    now: () => '2026-01-02T00:00:00.000Z',
  });

  return { handler, responses, approvals, liveEvents, updatedRecords, codingUpdates };
}

test('Codex server request handler cancels requests without a thread mapping', async () => {
  const harness = createHarness(null);
  await harness.handler({
    id: 'rpc-1',
    method: 'item/commandExecution/requestApproval',
    params: {},
  } satisfies JsonRpcServerRequest);

  assert.deepEqual(harness.responses, [{ id: 'rpc-1', result: { decision: 'cancel' } }]);
});

test('Codex server request handler auto-accepts chat file approvals', async () => {
  const harness = createHarness(buildChatSession());
  await harness.handler({
    id: 'rpc-2',
    method: 'item/fileChange/requestApproval',
    params: { threadId: 'thread-chat' },
  } satisfies JsonRpcServerRequest);

  assert.deepEqual(harness.responses, [{ id: 'rpc-2', result: { decision: 'accept' } }]);
  assert.deepEqual(harness.liveEvents, []);
});

test('Codex server request handler grants safe chat permissions and updates the session', async () => {
  const harness = createHarness(buildChatSession());
  await harness.handler({
    id: 'rpc-3',
    method: 'item/permissions/requestApproval',
    params: {
      threadId: 'thread-chat',
      permissions: { web: true },
    },
  } satisfies JsonRpcServerRequest);

  assert.deepEqual(harness.responses, [{ id: 'rpc-3', result: { permissions: { web: true }, scope: 'turn' } }]);
  assert.deepEqual(harness.updatedRecords, [{
    recordId: 'chat-1',
    patch: { networkEnabled: true, lastIssue: null },
  }]);
  assert.equal(harness.liveEvents[0]?.event.method, 'session/chat-permission-granted');
});

test('Codex server request handler blocks unsafe chat permissions', async () => {
  const harness = createHarness(buildChatSession());
  await harness.handler({
    id: 'rpc-4',
    method: 'item/permissions/requestApproval',
    params: {
      threadId: 'thread-chat',
      blocked: 'Blocked package installation request.',
    },
  } satisfies JsonRpcServerRequest);

  assert.deepEqual(harness.responses, [{ id: 'rpc-4', result: { permissions: {}, scope: 'turn' } }]);
  assert.deepEqual(harness.updatedRecords, []);
  assert.equal(harness.liveEvents[0]?.event.summary, 'Blocked package installation request.');
});

test('Codex server request handler stores coding approvals and marks the session as pending', async () => {
  const harness = createHarness(buildCodeSession());
  await harness.handler({
    id: 'rpc-5',
    method: 'item/commandExecution/requestApproval',
    params: {
      threadId: 'thread-code',
      command: 'npm install',
    },
  } satisfies JsonRpcServerRequest);

  assert.equal(harness.responses.length, 0);
  assert.equal(harness.approvals.length, 1);
  assert.equal(harness.approvals[0]?.title, 'title:item/commandExecution/requestApproval');
  assert.deepEqual(harness.codingUpdates, [{
    sessionId: 'code-1',
    patch: { status: 'needs-approval', lastIssue: null },
  }]);
  assert.equal(harness.liveEvents[0]?.event.summary, 'title:item/commandExecution/requestApproval');
});
