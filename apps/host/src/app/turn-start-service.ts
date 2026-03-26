import type { AgentExecutor, CodexThreadInput, ConversationRecord, SessionAttachmentRecord, SessionRecord } from '../types.js';
import type { RuntimeTurnStarter } from './agent-runtime.js';

type TurnRecord = ConversationRecord | SessionRecord;

interface RecoveryState {
  recoveryNeeded: boolean;
  threadGeneration: number;
  prefaceText: string | null;
}

interface CreateTurnStartServiceOptions {
  chatRuntime: RuntimeTurnStarter;
  runtimeForExecutor: (executor: AgentExecutor) => RuntimeTurnStarter;
  restartSessionThread: (session: TurnRecord, summary?: string) => Promise<TurnRecord>;
  getCurrentRecord: (recordId: string) => Promise<TurnRecord | null>;
  prepareConversationRecoveryState: (conversation: ConversationRecord) => Promise<RecoveryState>;
  resolveConversationPreface: (conversation: ConversationRecord, recoveryPrefaceText: string | null) => Promise<string | null>;
  buildTurnInput: (
    prompt: string | null,
    attachments: SessionAttachmentRecord[],
    options?: { prefaceText?: string | null },
  ) => CodexThreadInput[];
  updateRecord: (record: TurnRecord, patch: Partial<TurnRecord>) => Promise<TurnRecord | null>;
  markAttachmentsConsumed: (sessionId: string, attachmentIds: string[]) => Promise<unknown>;
  persistConversationUserTurn: (
    conversation: ConversationRecord,
    prompt: string | null,
    attachments: SessionAttachmentRecord[],
    turnId: string,
    recovery: RecoveryState,
  ) => Promise<unknown>;
  isThreadUnavailableError: (error: unknown) => boolean;
}

function isConversation(record: TurnRecord): record is ConversationRecord {
  return record.sessionType === 'chat';
}

function conversationRecoveryState(record: Pick<ConversationRecord, 'recoveryState' | 'status'>) {
  return record.recoveryState ?? (record.status === 'stale' ? 'stale' : 'ready');
}

export function createTurnStartService(options: CreateTurnStartServiceOptions) {
  return async function startTurnWithAutoRestart(
    session: TurnRecord,
    prompt: string | null,
    attachments: SessionAttachmentRecord[],
  ) {
    let currentSession = session;

    if (
      currentSession.status === 'stale'
      || (isConversation(currentSession) && conversationRecoveryState(currentSession) === 'stale')
    ) {
      currentSession = await options.restartSessionThread(
        currentSession,
        'Automatically created a fresh thread before sending the next prompt.',
      );
    }

    const runTurn = async (targetSession: TurnRecord) => {
      const recovery = isConversation(targetSession)
        ? await options.prepareConversationRecoveryState(targetSession)
        : {
            recoveryNeeded: false,
            threadGeneration: 0,
            prefaceText: null,
          } satisfies RecoveryState;

      const prefaceText = isConversation(targetSession)
        ? await options.resolveConversationPreface(targetSession, recovery.prefaceText)
        : recovery.prefaceText;

      const input = options.buildTurnInput(prompt, attachments, { prefaceText });

      if (isConversation(targetSession)) {
        await options.updateRecord(targetSession, {
          status: 'running',
          recoveryState: 'ready',
          retryable: false,
          lastIssue: null,
        });
      } else {
        await options.updateRecord(targetSession, {
          status: 'running',
          lastIssue: null,
        });
      }

      const runtime = isConversation(targetSession)
        ? options.runtimeForExecutor(targetSession.executor)
        : options.runtimeForExecutor(targetSession.executor);
      const turn = await runtime.startTurn(targetSession.threadId, input, {
        model: targetSession.model,
        effort: targetSession.reasoningEffort,
        approvalMode: targetSession.approvalMode,
        securityProfile: targetSession.securityProfile,
      });

      await options.markAttachmentsConsumed(targetSession.id, attachments.map((attachment) => attachment.id));

      const nextSession = isConversation(targetSession)
        ? ((await options.updateRecord(targetSession, {
            activeTurnId: turn.turn.id,
            status: 'running',
            recoveryState: 'ready',
            retryable: false,
            lastIssue: null,
            hasTranscript: true,
          })) ?? {
            ...targetSession,
            activeTurnId: turn.turn.id,
            status: 'running',
            recoveryState: 'ready',
            retryable: false,
            lastIssue: null,
            hasTranscript: true,
          })
        : ((await options.updateRecord(targetSession, {
            activeTurnId: turn.turn.id,
            status: 'running',
            lastIssue: null,
            hasTranscript: true,
          })) ?? {
            ...targetSession,
            activeTurnId: turn.turn.id,
            status: 'running',
            lastIssue: null,
            hasTranscript: true,
          });

      if (isConversation(nextSession)) {
        await options.persistConversationUserTurn(nextSession, prompt, attachments, turn.turn.id, recovery);
      }

      return { turn, session: nextSession };
    };

    try {
      return await runTurn(currentSession);
    } catch (error) {
      if (!options.isThreadUnavailableError(error)) {
        throw error;
      }

      const latestSession = (await options.getCurrentRecord(currentSession.id)) ?? currentSession;
      currentSession = await options.restartSessionThread(
        latestSession,
        'Automatically created a fresh thread after a runtime reset.',
      );
      return runTurn(currentSession);
    }
  };
}
