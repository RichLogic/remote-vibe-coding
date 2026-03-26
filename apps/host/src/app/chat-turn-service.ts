import { randomUUID } from 'node:crypto';

import type { ConversationRecord, SessionAttachmentRecord, SessionEvent } from '../types.js';
import type { RuntimeTurnInterrupter } from './agent-runtime.js';

interface ChatAttachmentStore {
  getAttachment(conversationId: string, attachmentId: string): SessionAttachmentRecord | null | undefined;
  addLiveEvent(sessionId: string, event: SessionEvent): void;
}

export class ChatTurnServiceError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
    readonly conversation: ConversationRecord | null = null,
  ) {
    super(message);
    this.name = 'ChatTurnServiceError';
  }
}

interface CreateChatTurnInput {
  prompt?: string;
  attachmentIds?: string[];
}

interface CreateChatTurnServiceOptions {
  store: ChatAttachmentStore;
  runtime: RuntimeTurnInterrupter;
  startTurnWithAutoRestart: (
    conversation: ConversationRecord,
    prompt: string | null,
    attachments: SessionAttachmentRecord[],
  ) => Promise<{
    turn: unknown;
    session: ConversationRecord;
  }>;
  updateConversation: (
    conversation: ConversationRecord,
    patch: Partial<ConversationRecord>,
  ) => Promise<ConversationRecord | null>;
  isThreadUnavailableError: (error: unknown) => boolean;
  unavailableConversationPatch: (
    record: Pick<ConversationRecord, 'activeTurnId' | 'status' | 'lastIssue'>,
    reason?: string,
  ) => Partial<ConversationRecord>;
  errorMessage: (error: unknown) => string;
  staleSessionMessage: string;
  randomId?: () => string;
  now?: () => string;
}

export function createChatTurnService(options: CreateChatTurnServiceOptions) {
  const randomId = options.randomId ?? (() => randomUUID());
  const now = options.now ?? (() => new Date().toISOString());

  async function createMessage(conversation: ConversationRecord, input: CreateChatTurnInput) {
    const prompt = input.prompt?.trim() ?? '';
    const attachmentIds = Array.isArray(input.attachmentIds)
      ? [...new Set(input.attachmentIds.filter((value): value is string => typeof value === 'string' && value.trim().length > 0))]
      : [];
    const attachments = attachmentIds.map((attachmentId) => options.store.getAttachment(conversation.id, attachmentId));

    if (!prompt && attachmentIds.length === 0) {
      throw new ChatTurnServiceError('Prompt or attachment is required.', 400);
    }

    if (attachments.some((attachment) => !attachment || attachment.consumedAt)) {
      throw new ChatTurnServiceError('One or more attachments are missing or already used.', 400);
    }

    try {
      const result = await options.startTurnWithAutoRestart(
        conversation,
        prompt || null,
        attachments.filter((attachment): attachment is SessionAttachmentRecord => Boolean(attachment)),
      );
      return {
        turn: result.turn,
        conversation: result.session,
      };
    } catch (error) {
      const message = options.errorMessage(error);
      await options.updateConversation(conversation, {
        activeTurnId: null,
        status: 'error',
        recoveryState: 'ready',
        retryable: true,
        lastIssue: message,
      });
      throw new ChatTurnServiceError(message, 500);
    }
  }

  async function stopTurn(conversation: ConversationRecord) {
    if (!conversation.activeTurnId) {
      throw new ChatTurnServiceError('This conversation does not have an active turn to stop.', 409);
    }

    try {
      await options.runtime.interruptTurn(conversation.threadId, conversation.activeTurnId);
      options.store.addLiveEvent(conversation.id, {
        id: randomId(),
        method: 'turn/interrupted',
        summary: 'Stopped the active turn.',
        createdAt: now(),
      });
      return (await options.updateConversation(conversation, {
        activeTurnId: null,
        status: 'idle',
        recoveryState: 'ready',
        retryable: false,
        lastIssue: 'Stopped by user.',
      })) ?? {
        ...conversation,
        activeTurnId: null,
        status: 'idle',
        recoveryState: 'ready',
        retryable: false,
        lastIssue: 'Stopped by user.',
      };
    } catch (error) {
      if (options.isThreadUnavailableError(error)) {
        const nextConversation = (await options.updateConversation(
          conversation,
          options.unavailableConversationPatch(conversation),
        )) ?? {
          ...conversation,
          ...options.unavailableConversationPatch(conversation),
        };
        throw new ChatTurnServiceError(options.staleSessionMessage, 409, nextConversation);
      }

      const message = options.errorMessage(error);
      await options.updateConversation(conversation, {
        activeTurnId: null,
        status: 'error',
        recoveryState: 'ready',
        retryable: true,
        lastIssue: message,
      });
      throw new ChatTurnServiceError(message, 500);
    }
  }

  return {
    createMessage,
    stopTurn,
  };
}
