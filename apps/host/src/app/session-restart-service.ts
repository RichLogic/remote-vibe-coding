import { randomUUID } from 'node:crypto';

import type { ConversationRecord, SessionEvent, SessionRecord } from '../types.js';

type TurnRecord = ConversationRecord | SessionRecord;

interface RestartStore {
  clearApprovals(sessionId: string): void;
  clearLiveEvents(sessionId: string): void;
  addLiveEvent(sessionId: string, event: SessionEvent): void;
}

interface StartThreadPort {
  startThread(options: {
    cwd: string;
    securityProfile: SessionRecord['securityProfile'];
    model?: string | null;
  }): Promise<{
    thread: {
      id: string;
    };
  }>;
}

interface CreateSessionRestartServiceOptions {
  codex: StartThreadPort;
  store: RestartStore;
  ensureChatWorkspace: (ownerUsername: string, ownerUserId: string) => Promise<{ path: string }>;
  rotateConversationThread: (conversation: ConversationRecord, nextThreadId: string) => Promise<unknown>;
  updateRecord: (record: TurnRecord, patch: Partial<TurnRecord>) => Promise<TurnRecord | null>;
  randomId?: () => string;
  now?: () => string;
}

function isConversation(record: TurnRecord): record is ConversationRecord {
  return record.sessionType === 'chat';
}

export function createSessionRestartService(options: CreateSessionRestartServiceOptions) {
  const randomId = options.randomId ?? (() => randomUUID());
  const now = options.now ?? (() => new Date().toISOString());

  return async function restartSessionThread(
    session: TurnRecord,
    summary = 'Started a fresh Codex thread for this session.',
  ) {
    const workspace = isConversation(session)
      ? (await options.ensureChatWorkspace(session.ownerUsername, session.ownerUserId)).path
      : session.workspace;

    const threadResponse = await options.codex.startThread({
      cwd: workspace,
      securityProfile: session.securityProfile,
      model: session.model,
    });

    options.store.clearApprovals(session.id);
    options.store.clearLiveEvents(session.id);
    options.store.addLiveEvent(session.id, {
      id: randomId(),
      method: 'session/restarted',
      summary,
      createdAt: now(),
    });

    if (isConversation(session)) {
      await options.rotateConversationThread(session, threadResponse.thread.id);
      return (await options.updateRecord(session, {
        threadId: threadResponse.thread.id,
        activeTurnId: null,
        workspace,
        status: 'idle',
        networkEnabled: false,
        recoveryState: 'ready',
        retryable: false,
        lastIssue: null,
      })) ?? {
        ...session,
        threadId: threadResponse.thread.id,
        activeTurnId: null,
        workspace,
        status: 'idle',
        networkEnabled: false,
        recoveryState: 'ready',
        retryable: false,
        lastIssue: null,
      };
    }

    return (await options.updateRecord(session, {
      threadId: threadResponse.thread.id,
      activeTurnId: null,
      workspace,
      status: 'idle',
      networkEnabled: false,
      lastIssue: null,
    })) ?? {
      ...session,
      threadId: threadResponse.thread.id,
      activeTurnId: null,
      workspace,
      status: 'idle',
      networkEnabled: false,
      lastIssue: null,
    };
  };
}
