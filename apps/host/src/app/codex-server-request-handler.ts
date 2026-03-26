import { randomUUID } from 'node:crypto';
import { isAbsolute, relative, resolve } from 'node:path';

import type { ConversationRecord, PendingApproval, SessionEvent, SessionRecord } from '../types.js';
import type { AgentRuntimeServerRequest, RuntimeApprovalResponder } from './agent-runtime.js';

type TurnRecord = ConversationRecord | SessionRecord;

interface ApprovalStore {
  addApproval(approval: PendingApproval): void;
  addLiveEvent(sessionId: string, event: SessionEvent): void;
}

interface CodingSessionRepository {
  updateSession(sessionId: string, patch: Partial<SessionRecord>): Promise<unknown>;
}

interface CreateRuntimeServerRequestHandlerOptions {
  runtime: RuntimeApprovalResponder;
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

function isTruthyPermissionValue(value: unknown) {
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    return value !== 0;
  }
  if (typeof value === 'string') {
    return value !== '' && value !== '0' && value.toLowerCase() !== 'false';
  }
  return value != null;
}

function isNetworkOnlyPermissionRequest(permissions: Record<string, unknown>) {
  const entries = Object.entries(permissions);
  if (entries.length === 0) {
    return false;
  }

  return entries.every(([key, value]) => (
    (key === 'web' || key === 'network' || key === 'internet')
    && isTruthyPermissionValue(value)
  ));
}

function collectRequestedPaths(value: unknown, result: string[] = []) {
  if (!value || typeof value !== 'object') {
    return result;
  }

  if (Array.isArray(value)) {
    for (const entry of value) {
      collectRequestedPaths(entry, result);
    }
    return result;
  }

  const record = value as Record<string, unknown>;
  if (typeof record.path === 'string') {
    result.push(record.path);
  }

  if (Array.isArray(record.paths)) {
    for (const entry of record.paths) {
      if (typeof entry === 'string') {
        result.push(entry);
      } else {
        collectRequestedPaths(entry, result);
      }
    }
  }

  if (Array.isArray(record.changes)) {
    for (const entry of record.changes) {
      collectRequestedPaths(entry, result);
    }
  }

  for (const [key, entry] of Object.entries(record)) {
    if (key === 'path' || key === 'paths' || key === 'changes') {
      continue;
    }
    collectRequestedPaths(entry, result);
  }

  return result;
}

function isWorkspacePath(workspace: string, filePath: string) {
  const trimmedPath = filePath.trim();
  if (!trimmedPath) {
    return false;
  }

  const normalizedWorkspace = resolve(workspace);
  const normalizedPath = isAbsolute(trimmedPath)
    ? resolve(trimmedPath)
    : resolve(normalizedWorkspace, trimmedPath);
  const relativePath = relative(normalizedWorkspace, normalizedPath);
  return relativePath === '' || (!relativePath.startsWith('..') && !isAbsolute(relativePath));
}

function isWorkspaceScopedFileChangeRequest(params: unknown, workspace: string) {
  const requestedPaths = collectRequestedPaths(params);
  return requestedPaths.length > 0 && requestedPaths.every((filePath) => isWorkspacePath(workspace, filePath));
}

export function createRuntimeServerRequestHandler(options: CreateRuntimeServerRequestHandlerOptions) {
  const randomId = options.randomId ?? (() => randomUUID());
  const now = options.now ?? (() => new Date().toISOString());

  return async function handleServerRequest(message: AgentRuntimeServerRequest) {
    const threadId = extractThreadId(message.params);
    if (!threadId) {
      await options.runtime.respond(message.id, { decision: 'cancel' });
      return;
    }

    const session = await options.findRecordByThreadId(threadId);
    if (!session) {
      await options.runtime.respond(message.id, { decision: 'cancel' });
      return;
    }

    if (isConversation(session)) {
      if (message.method === 'item/fileChange/requestApproval') {
        await options.runtime.respond(message.id, { decision: 'accept' });
        return;
      }

      if (message.method === 'item/permissions/requestApproval') {
        const blockedReason = options.blockedChatPermissionReason(message.params);
        if (!blockedReason) {
          await options.runtime.respond(message.id, {
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

        await options.runtime.respond(message.id, {
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
        await options.runtime.respond(message.id, { decision: 'decline' });
      } else {
        await options.runtime.respond(message.id, { decision: 'cancel' });
      }

      options.store.addLiveEvent(session.id, {
        id: randomId(),
        method: 'session/chat-tool-blocked',
        summary: 'Blocked a tool or permission request in a chat-only session.',
        createdAt: now(),
      });
      return;
    }

    if (session.approvalMode !== 'detailed') {
      if (message.method === 'item/commandExecution/requestApproval') {
        await options.runtime.respond(message.id, { decision: 'accept' });
        return;
      }

      if (message.method === 'item/fileChange/requestApproval') {
        if (
          session.approvalMode === 'full-auto'
          || isWorkspaceScopedFileChangeRequest(message.params, session.workspace)
        ) {
          await options.runtime.respond(message.id, { decision: 'accept' });
          return;
        }
      }

      if (message.method === 'item/permissions/requestApproval') {
        const permissions = options.requestedPermissionsFromParams(message.params);
        const networkOnlyPermissionRequest = isNetworkOnlyPermissionRequest(permissions);
        if (
          session.approvalMode === 'full-auto'
          || networkOnlyPermissionRequest
        ) {
          await options.runtime.respond(message.id, {
            permissions,
            scope: 'turn',
          });
          if (networkOnlyPermissionRequest) {
            await options.coding.updateSession(session.id, {
              networkEnabled: true,
              lastIssue: null,
            });
          }
          return;
        }
      }

      if (session.approvalMode === 'full-auto') {
        await options.runtime.respond(message.id, { decision: 'accept' });
        return;
      }
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
      source: isConversation(session) ? 'codex' : session.executor,
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

export const createCodexServerRequestHandler = createRuntimeServerRequestHandler;
