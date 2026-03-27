import { randomUUID } from 'node:crypto';

import type { QueuedCodingTurnRecord } from '../coding/repository.js';
import type { SessionAttachmentRecord, SessionEvent, SessionRecord } from '../types.js';

interface CreateCodingQueuedTurnDrainServiceOptions {
  getSession: (sessionId: string) => Promise<SessionRecord | null>;
  claimNextQueuedTurn: (sessionId: string) => Promise<QueuedCodingTurnRecord | null>;
  resetQueuedTurnToQueued: (sessionId: string, queuedTurnId: string) => Promise<QueuedCodingTurnRecord | null>;
  deleteQueuedTurn: (sessionId: string, queuedTurnId: string) => Promise<boolean>;
  getAttachment: (sessionId: string, attachmentId: string) => SessionAttachmentRecord | null;
  startTurnWithAutoRestart: (
    session: SessionRecord,
    prompt: string | null,
    attachments: SessionAttachmentRecord[],
  ) => Promise<unknown>;
  updateCodingSession: (
    sessionId: string,
    patch: Partial<SessionRecord>,
  ) => Promise<SessionRecord | null>;
  addLiveEvent: (sessionId: string, event: SessionEvent) => void;
  errorMessage: (error: unknown) => string;
  randomId?: () => string;
  now?: () => string;
}

const QUEUED_ATTACHMENT_ERROR = 'One or more queued attachments are missing or already used.';

export function createCodingQueuedTurnDrainService(options: CreateCodingQueuedTurnDrainServiceOptions) {
  const locks = new Set<string>();
  const randomId = options.randomId ?? (() => randomUUID());
  const now = options.now ?? (() => new Date().toISOString());

  return async function drainQueuedTurn(sessionId: string) {
    if (locks.has(sessionId)) {
      return false;
    }

    locks.add(sessionId);
    try {
      const session = await options.getSession(sessionId);
      if (!session || session.archivedAt || session.activeTurnId || session.status !== 'idle') {
        return false;
      }

      const queuedTurn = await options.claimNextQueuedTurn(sessionId);
      if (!queuedTurn) {
        return false;
      }

      const attachments = queuedTurn.attachmentIds.map((attachmentId) => options.getAttachment(sessionId, attachmentId));
      if (attachments.some((attachment) => !attachment || attachment.consumedAt)) {
        await options.resetQueuedTurnToQueued(sessionId, queuedTurn.id);
        await options.updateCodingSession(sessionId, {
          activeTurnId: null,
          status: 'error',
          lastIssue: QUEUED_ATTACHMENT_ERROR,
        });
        options.addLiveEvent(sessionId, {
          id: randomId(),
          method: 'turn/queued-start-failed',
          summary: QUEUED_ATTACHMENT_ERROR,
          createdAt: now(),
        });
        return false;
      }

      try {
        await options.startTurnWithAutoRestart(
          session,
          queuedTurn.prompt,
          attachments.filter((attachment): attachment is SessionAttachmentRecord => Boolean(attachment)),
        );
        await options.deleteQueuedTurn(sessionId, queuedTurn.id);
        return true;
      } catch (error) {
        const message = options.errorMessage(error);
        await options.resetQueuedTurnToQueued(sessionId, queuedTurn.id);
        await options.updateCodingSession(sessionId, {
          activeTurnId: null,
          status: 'error',
          lastIssue: message,
        });
        options.addLiveEvent(sessionId, {
          id: randomId(),
          method: 'turn/queued-start-failed',
          summary: message,
          createdAt: now(),
        });
        return false;
      }
    } finally {
      locks.delete(sessionId);
    }
  };
}

export { QUEUED_ATTACHMENT_ERROR };
