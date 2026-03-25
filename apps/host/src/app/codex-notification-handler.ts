import { randomUUID } from 'node:crypto';

import type { JsonRpcNotification } from '../codex-app-server.js';
import type { CodexThread, ConversationRecord, SessionEvent, SessionRecord, SessionStatus } from '../types.js';

type TurnRecord = ConversationRecord | SessionRecord;

interface NotificationStore {
  addLiveEvent(sessionId: string, event: SessionEvent): void;
  getApprovals(sessionId: string): Array<{ id: string }>;
}

interface ThreadState {
  session: TurnRecord;
  thread: CodexThread | null;
}

interface CreateCodexNotificationHandlerOptions {
  store: NotificationStore;
  findRecordByThreadId: (threadId: string) => Promise<TurnRecord | null>;
  updateRecord: (record: TurnRecord, patch: Partial<TurnRecord>) => Promise<TurnRecord | null>;
  getCurrentRecord: (recordId: string) => Promise<TurnRecord | null>;
  readSessionThread: (session: TurnRecord) => Promise<ThreadState>;
  maybeAutoTitleChatSession: (session: TurnRecord, threadOverride?: CodexThread | null) => Promise<unknown>;
  maybeAutoTitleCodingSession: (session: SessionRecord, threadOverride?: CodexThread | null) => Promise<unknown>;
  syncConversationHistoryFromThread: (conversation: ConversationRecord, thread: CodexThread | null) => Promise<unknown>;
  latestMeaningfulChatReplyFromTurn: (thread: CodexThread, turnId: string) => string | null;
  isTransitionOnlyChatReply: (text: string) => boolean;
  summarizeNotification: (method: string, params: Record<string, unknown>) => string;
  emptyReplyMessage: string;
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

function isDeveloperSession(record: TurnRecord): record is SessionRecord {
  return record.sessionType === 'code';
}

export function createCodexNotificationHandler(options: CreateCodexNotificationHandlerOptions) {
  const randomId = options.randomId ?? (() => randomUUID());
  const now = options.now ?? (() => new Date().toISOString());

  return async function handleNotification(message: JsonRpcNotification) {
    const threadId = extractThreadId(message.params);
    if (!threadId) return;

    const session = await options.findRecordByThreadId(threadId);
    if (!session) return;

    const summary = options.summarizeNotification(message.method, (message.params ?? {}) as Record<string, unknown>);

    options.store.addLiveEvent(session.id, {
      id: randomId(),
      method: message.method,
      summary,
      createdAt: now(),
    });

    if (message.method === 'error') {
      const lastIssue = summary === 'error' ? 'Codex reported an error.' : summary;
      if (isConversation(session)) {
        await options.updateRecord(session, {
          activeTurnId: null,
          status: 'error',
          recoveryState: 'ready',
          retryable: true,
          lastIssue,
        });
      } else {
        await options.updateRecord(session, {
          activeTurnId: null,
          status: 'error',
          lastIssue,
        });
      }
      return;
    }

    if (message.method === 'thread/status/changed') {
      const statusType = String(((message.params as Record<string, unknown>).status as { type?: string } | undefined)?.type ?? '');
      const nextStatus: SessionStatus = statusType === 'active'
        ? 'running'
        : statusType === 'idle'
          ? 'idle'
          : statusType === 'systemError'
            ? 'error'
            : session.status;
      if (isConversation(session)) {
        await options.updateRecord(session, {
          status: nextStatus,
          recoveryState: 'ready',
          retryable: nextStatus === 'error' ? true : false,
          ...(nextStatus === 'error'
            ? {}
            : { lastIssue: null }),
          ...((statusType === 'idle' || statusType === 'systemError') ? { activeTurnId: null } : {}),
        });
      } else {
        await options.updateRecord(session, {
          status: nextStatus,
          ...(nextStatus === 'error'
            ? {}
            : { lastIssue: null }),
          ...((statusType === 'idle' || statusType === 'systemError') ? { activeTurnId: null } : {}),
        });
      }
      return;
    }

    if (message.method !== 'turn/completed') {
      return;
    }

    const completedTurnId = session.activeTurnId;
    const nextStatus: SessionStatus = session.status === 'error'
      ? 'error'
      : isDeveloperSession(session) && options.store.getApprovals(session.id).length > 0
        ? 'needs-approval'
        : 'idle';

    let nextSession: TurnRecord;
    if (isConversation(session)) {
      nextSession = (await options.updateRecord(session, {
        activeTurnId: null,
        status: nextStatus,
        recoveryState: 'ready',
        retryable: nextStatus === 'error' ? true : false,
        ...(nextStatus === 'error'
          ? {}
          : { lastIssue: null }),
      })) ?? {
        ...session,
        activeTurnId: null,
        status: nextStatus,
        recoveryState: 'ready',
        retryable: nextStatus === 'error' ? true : false,
      };
    } else {
      nextSession = (await options.updateRecord(session, {
        activeTurnId: null,
        status: nextStatus,
        ...(nextStatus === 'error'
          ? {}
          : { lastIssue: null }),
      })) ?? {
        ...session,
        activeTurnId: null,
        status: nextStatus,
      };
    }

    if (isConversation(nextSession)) {
      const latestSession = await options.getCurrentRecord(nextSession.id);
      if (latestSession && isConversation(latestSession)) {
        const threadState = await options.readSessionThread(latestSession);
        if (isConversation(threadState.session)) {
          await options.maybeAutoTitleChatSession(threadState.session, threadState.thread);
          await options.syncConversationHistoryFromThread(threadState.session, threadState.thread);

          if (completedTurnId && threadState.thread) {
            const latestReply = options.latestMeaningfulChatReplyFromTurn(threadState.thread, completedTurnId);
            if (
              threadState.session.status !== 'error'
              && !threadState.session.lastIssue
              && (!latestReply || options.isTransitionOnlyChatReply(latestReply))
            ) {
              await options.updateRecord(threadState.session, {
                status: 'error',
                recoveryState: 'ready',
                retryable: true,
                lastIssue: options.emptyReplyMessage,
              });
              options.store.addLiveEvent(threadState.session.id, {
                id: randomId(),
                method: 'session/chat-empty-reply',
                summary: options.emptyReplyMessage,
                createdAt: now(),
              });
            }
          }
        }
      }
      await options.maybeAutoTitleChatSession(nextSession);
      return;
    }

    await options.maybeAutoTitleCodingSession(nextSession);
  };
}
