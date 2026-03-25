import { randomUUID } from 'node:crypto';

import type { JsonRpcServerRequest } from '../codex-app-server.js';
import type { ConversationRecord, PendingApproval, SessionEvent, SessionRecord } from '../types.js';

type TurnRecord = ConversationRecord | SessionRecord;

interface CodexResponder {
  respond(id: number | string, result: unknown): Promise<unknown>;
}

interface ApprovalStore {
  addApproval(approval: PendingApproval): void;
  addLiveEvent(sessionId: string, event: SessionEvent): void;
}

interface CodingSessionRepository {
  updateSession(sessionId: string, patch: Partial<SessionRecord>): Promise<unknown>;
}

interface CreateCodexServerRequestHandlerOptions {
  codex: CodexResponder;
  store: ApprovalStore;
  coding: CodingSessionRepository;
  findRecordByThreadId: (threadId: string) => Promise<TurnRecord | null>;
  updateRecord: (record: TurnRecord, patch: Partial<TurnRecord>) => Promise<TurnRecord | null>;
  approvalTitle: (method: string) => string;
  approvalRisk: (method: string, params: Record<string, unknown>) => string;
  blockedChatPermissionReason: (params: unknown) => string | null | undefined;
  requestedPermissionsFromParams: (params: unknown) => Record<string, unknown>;
  randomId?: () => string;
  now?: () => string;
}

function extractThreadId(params: unknown): string | null {
  if (!params || typeof params !== 'object') return null;
  const record = params as Record<string, unknown>;
  if (typeof record.threadId === 'string') return record.threadId;
  if (record.thread && typeof record.thread === 'object') {
    const thread = record.thread as Record<string, unknown>;
    if (typeof thread.id === 'string') return thread.id;
  }
  return null;
}

function isConversation(record: TurnRecord): record is ConversationRecord {
  return record.sessionType === 'chat';
}

export function createCodexServerRequestHandler(options: CreateCodexServerRequestHandlerOptions) {
  const randomId = options.randomId ?? (() => randomUUID());
  const now = options.now ?? (() => new Date().toISOString());

  return async function handleServerRequest(message: JsonRpcServerRequest) {
    const threadId = extractThreadId(message.params);
    if (!threadId) {
      await options.codex.respond(message.id, { decision: 'cancel' });
      return;
    }

    const session = await options.findRecordByThreadId(threadId);
    if (!session) {
      await options.codex.respond(message.id, { decision: 'cancel' });
      return;
    }

    if (isConversation(session)) {
      if (message.method === 'item/fileChange/requestApproval') {
        await options.codex.respond(message.id, { decision: 'accept' });
        return;
      }

      if (message.method === 'item/permissions/requestApproval') {
        const blockedReason = options.blockedChatPermissionReason(message.params);
        if (!blockedReason) {
          await options.codex.respond(message.id, {
            permissions: options.requestedPermissionsFromParams(message.params),
            scope: 'turn',
          });
          await options.updateRecord(session, {
            networkEnabled: true,
            lastIssue: null,
          });
          options.store.addLiveEvent(session.id, {
            id: randomId(),
            method: 'session/chat-permission-granted',
            summary: 'Automatically granted a safe extra permission request.',
            createdAt: now(),
          });
          return;
        }

        await options.codex.respond(message.id, {
          permissions: {},
          scope: 'turn',
        });
        options.store.addLiveEvent(session.id, {
          id: randomId(),
          method: 'session/chat-permission-blocked',
          summary: blockedReason,
          createdAt: now(),
        });
        return;
      }

      if (message.method === 'item/commandExecution/requestApproval') {
        await options.codex.respond(message.id, { decision: 'decline' });
      } else {
        await options.codex.respond(message.id, { decision: 'cancel' });
      }

      options.store.addLiveEvent(session.id, {
        id: randomId(),
        method: 'session/chat-tool-blocked',
        summary: 'Blocked a tool or permission request in a chat-only session.',
        createdAt: now(),
      });
      return;
    }

    const createdAt = now();
    const approval: PendingApproval = {
      id: String(message.id),
      sessionId: session.id,
      rpcRequestId: message.id,
      method: message.method,
      title: options.approvalTitle(message.method),
      risk: options.approvalRisk(message.method, (message.params ?? {}) as Record<string, unknown>),
      scopeOptions: ['once', 'session'],
      source: 'codex',
      payload: message.params ?? {},
      createdAt,
    };

    options.store.addApproval(approval);
    options.store.addLiveEvent(session.id, {
      id: randomId(),
      method: message.method,
      summary: approval.title,
      createdAt,
    });
    await options.coding.updateSession(session.id, { status: 'needs-approval', lastIssue: null });
  };
}
