import { randomUUID } from 'node:crypto';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';

import { ChatConversationServiceError } from '../app/chat-conversation-service.js';
import { ChatTurnServiceError } from '../app/chat-turn-service.js';
import type { ChatMessageRecord } from '../chat-history.js';
import type { ChatRolePresetConfigState } from '../chat-prompt-config.js';
import type {
  ChatBootstrapPayload,
  ChatConversation as ApiChatConversation,
  ChatConversationDetailResponse,
  ChatRolePreset,
  ChatTranscriptPageResponse,
  CreateChatConversationRequest,
  CreateChatMessageRequest,
  UpdateChatConversationPreferencesRequest,
  UpdateChatConversationRequest,
} from '../chat/types.js';
import type {
  ConversationRecord,
  CodexThread,
  CodexThreadSummary,
  SessionAttachmentKind,
  SessionAttachmentRecord,
  SessionAttachmentSummary,
  SessionEvent,
  SessionTranscriptEntry,
  TurnRecord,
  UserRecord,
} from '../types.js';

interface ChatRoutesDependencies {
  getRequestUser: (request: FastifyRequest) => UserRecord;
  userCanUseMode: (user: UserRecord, mode: 'chat' | 'developer') => boolean;
  listConversationRecordsForUser: (userId: string) => Promise<ConversationRecord[]>;
  repairPendingChatAutoTitles: (conversations: ConversationRecord[]) => Promise<void>;
  loadChatRolePresetConfig: () => Promise<ChatRolePresetConfigState>;
  apiRolePresets: (config: ChatRolePresetConfigState) => ChatRolePreset[];
  buildChatBootstrapResponse: (
    currentUser: UserRecord,
    conversations: ConversationRecord[],
    rolePresets: ChatRolePreset[],
    defaultRolePresetId: string | null,
  ) => ChatBootstrapPayload;
  getOwnedConversationOrReply: (
    userId: string,
    conversationId: string,
    reply: FastifyReply,
  ) => Promise<ConversationRecord | null>;
  readSessionThread: (session: ConversationRecord) => Promise<{
    session: TurnRecord;
    thread: CodexThread | null;
  }>;
  syncConversationMirror: (conversation: ConversationRecord) => Promise<ConversationRecord>;
  syncConversationHistoryFromThread: (
    conversation: ConversationRecord,
    thread: CodexThread | null,
  ) => Promise<void>;
  countMessages: (conversationId: string) => Promise<number>;
  updateConversation: (
    conversation: ConversationRecord,
    patch: Partial<ConversationRecord>,
  ) => Promise<ConversationRecord | null>;
  buildChatConversationDetailPayload: (
    conversation: ConversationRecord,
    thread: CodexThreadSummary | null,
    transcriptTotal: number,
  ) => ChatConversationDetailResponse;
  toThreadSummary: (thread: CodexThread | null) => CodexThreadSummary | null;
  normalizeTranscriptLimit: (value: unknown) => number;
  pageMessages: (
    conversationId: string,
    options: { before: string | null; limit: number },
  ) => Promise<{
    items: ChatMessageRecord[];
    nextCursor: string | null;
    total: number;
  }>;
  chatMessageToApiTranscriptEntry: (message: ChatMessageRecord) => SessionTranscriptEntry;
  compactChatLiveEvents: (events: SessionEvent[]) => SessionEvent[];
  getLiveEvents: (conversationId: string) => SessionEvent[];
  attachmentKindFromUpload: (filename: string, mimeType: string) => SessionAttachmentKind;
  sanitizeAttachmentFilename: (filename: string, fallbackBase: string) => string;
  extractAttachmentText: (
    kind: SessionAttachmentKind,
    filename: string,
    mimeType: string,
    buffer: Buffer,
  ) => Promise<string | null>;
  addAttachment: (attachment: SessionAttachmentRecord) => Promise<void>;
  chatAttachmentSummary: (attachment: SessionAttachmentRecord) => SessionAttachmentSummary;
  getAttachment: (conversationId: string, attachmentId: string) => SessionAttachmentRecord | null;
  removeAttachment: (conversationId: string, attachmentId: string) => Promise<boolean>;
  createChatConversation: (
    currentUser: UserRecord,
    body: CreateChatConversationRequest,
  ) => Promise<ConversationRecord>;
  renameConversation: (
    conversation: ConversationRecord,
    body: UpdateChatConversationRequest,
  ) => Promise<ConversationRecord>;
  updateConversationPreferences: (
    conversation: ConversationRecord,
    body: UpdateChatConversationPreferencesRequest,
  ) => Promise<ConversationRecord>;
  restartSessionThread: (
    conversation: ConversationRecord,
    reason?: string,
  ) => Promise<ConversationRecord>;
  archiveConversation: (conversation: ConversationRecord) => Promise<ConversationRecord>;
  restoreConversation: (conversation: ConversationRecord) => Promise<ConversationRecord>;
  createForkedConversation: (
    currentUser: UserRecord,
    conversation: ConversationRecord,
  ) => Promise<ConversationRecord>;
  errorMessage: (error: unknown) => string;
  listAttachments: (conversationId: string) => SessionAttachmentRecord[];
  deleteConversationState: (conversationId: string) => Promise<unknown>;
  deleteConversationHistory: (conversationId: string) => Promise<unknown>;
  deleteStoredAttachments: (attachments: SessionAttachmentRecord[]) => Promise<void>;
  createChatMessage: (
    conversation: ConversationRecord,
    body: CreateChatMessageRequest,
  ) => Promise<{
    turn: unknown;
    conversation: ConversationRecord;
  }>;
  stopChatTurn: (conversation: ConversationRecord) => Promise<ConversationRecord>;
  toApiChatConversationRecord: (conversation: ConversationRecord) => ApiChatConversation;
}

async function loadConversationResponseState(
  deps: ChatRoutesDependencies,
  conversation: ConversationRecord,
) {
  const threadState = await deps.readSessionThread(conversation);
  const currentConversation = threadState.session as ConversationRecord;
  await deps.syncConversationMirror(currentConversation);
  await deps.syncConversationHistoryFromThread(currentConversation, threadState.thread);
  const transcriptTotal = await deps.countMessages(conversation.id);
  const hasTranscript = transcriptTotal > 0;
  const responseConversation = currentConversation.hasTranscript === hasTranscript
    ? currentConversation
    : (await deps.updateConversation(currentConversation, {
        hasTranscript,
      })) ?? {
        ...currentConversation,
        hasTranscript,
      };

  return {
    thread: threadState.thread,
    transcriptTotal,
    responseConversation,
  };
}

export function registerChatRoutes(app: FastifyInstance, deps: ChatRoutesDependencies) {
  app.get('/api/chat/bootstrap', async (request, reply) => {
    const currentUser = deps.getRequestUser(request);
    if (!deps.userCanUseMode(currentUser, 'chat')) {
      reply.code(403);
      return { error: 'Chat access required.' };
    }

    let conversations = await deps.listConversationRecordsForUser(currentUser.id);
    await deps.repairPendingChatAutoTitles(conversations);
    conversations = await deps.listConversationRecordsForUser(currentUser.id);
    const rolePresetConfig = await deps.loadChatRolePresetConfig();
    return deps.buildChatBootstrapResponse(
      currentUser,
      conversations,
      deps.apiRolePresets(rolePresetConfig),
      rolePresetConfig.defaultPresetId,
    );
  });

  app.get('/api/chat/conversations/:conversationId', async (request, reply) => {
    const currentUser = deps.getRequestUser(request);
    const { conversationId } = request.params as { conversationId: string };
    const conversation = await deps.getOwnedConversationOrReply(currentUser.id, conversationId, reply);
    if (!conversation) {
      return { error: 'Conversation not found' };
    }

    const state = await loadConversationResponseState(deps, conversation);
    return deps.buildChatConversationDetailPayload(
      state.responseConversation,
      deps.toThreadSummary(state.thread),
      state.transcriptTotal,
    );
  });

  app.get('/api/chat/conversations/:conversationId/transcript', async (request, reply) => {
    const currentUser = deps.getRequestUser(request);
    const { conversationId } = request.params as { conversationId: string };
    const conversation = await deps.getOwnedConversationOrReply(currentUser.id, conversationId, reply);
    if (!conversation) {
      return { error: 'Conversation not found' };
    }

    const state = await loadConversationResponseState(deps, conversation);
    const query = request.query as { before?: string; limit?: string } | undefined;
    const page = await deps.pageMessages(conversationId, {
      before: query?.before ?? null,
      limit: deps.normalizeTranscriptLimit(query?.limit),
    });

    const payload: ChatTranscriptPageResponse = {
      items: page.items.map((item) => deps.chatMessageToApiTranscriptEntry(item)),
      nextCursor: page.nextCursor,
      total: page.total,
      conversation: deps.toApiChatConversationRecord(state.responseConversation),
      liveEvents: deps.compactChatLiveEvents(deps.getLiveEvents(conversationId)),
    };
    return payload;
  });

  app.post('/api/chat/conversations/:conversationId/attachments', async (request, reply) => {
    const currentUser = deps.getRequestUser(request);
    const { conversationId } = request.params as { conversationId: string };
    const conversation = await deps.getOwnedConversationOrReply(currentUser.id, conversationId, reply);
    if (!conversation) {
      return { error: 'Conversation not found' };
    }

    const file = await request.file();
    if (!file) {
      reply.code(400);
      return { error: 'Attachment file is required.' };
    }

    const filename = file.filename?.trim() || 'attachment';
    const mimeType = file.mimetype || 'application/octet-stream';
    const kind = deps.attachmentKindFromUpload(filename, mimeType);
    const buffer = await file.toBuffer();
    if (buffer.length === 0) {
      reply.code(400);
      return { error: 'Attachment is empty.' };
    }

    const attachmentId = randomUUID();
    const attachmentsDir = join(conversation.workspace, '.rvc-chat', 'attachments');
    await mkdir(attachmentsDir, { recursive: true });

    const storedFilename = deps.sanitizeAttachmentFilename(
      filename,
      kind === 'image'
        ? 'attachment'
        : kind === 'pdf'
          ? 'attachment.pdf'
          : 'attachment-file',
    );
    const storagePath = join(attachmentsDir, `${attachmentId}-${storedFilename}`);
    await writeFile(storagePath, buffer);

    const now = new Date().toISOString();
    const attachment: SessionAttachmentRecord = {
      id: attachmentId,
      ownerKind: 'conversation',
      ownerId: conversation.id,
      sessionId: conversation.id,
      ownerUserId: conversation.ownerUserId,
      ownerUsername: conversation.ownerUsername,
      kind,
      filename: storedFilename,
      mimeType,
      sizeBytes: buffer.length,
      storagePath,
      extractedText: await deps.extractAttachmentText(kind, storedFilename, mimeType, buffer),
      consumedAt: null,
      createdAt: now,
    };

    await deps.addAttachment(attachment);
    reply.code(201);
    return {
      attachment: deps.chatAttachmentSummary(attachment),
    };
  });

  app.get('/api/chat/conversations/:conversationId/attachments/:attachmentId/content', async (request, reply) => {
    const currentUser = deps.getRequestUser(request);
    const { conversationId, attachmentId } = request.params as { conversationId: string; attachmentId: string };
    const query = request.query as { download?: string } | undefined;
    const conversation = await deps.getOwnedConversationOrReply(currentUser.id, conversationId, reply);
    if (!conversation) {
      return { error: 'Conversation not found' };
    }

    const attachment = deps.getAttachment(conversationId, attachmentId);
    if (!attachment) {
      reply.code(404);
      return { error: 'Attachment not found' };
    }

    const buffer = await readFile(attachment.storagePath);
    reply.type(attachment.mimeType);
    reply.header('Cache-Control', 'private, max-age=60');
    reply.header(
      'Content-Disposition',
      `${query?.download === '1' || query?.download === 'true' ? 'attachment' : 'inline'}; filename="${attachment.filename.replace(/"/g, '')}"`,
    );
    return buffer;
  });

  app.delete('/api/chat/conversations/:conversationId/attachments/:attachmentId', async (request, reply) => {
    const currentUser = deps.getRequestUser(request);
    const { conversationId, attachmentId } = request.params as { conversationId: string; attachmentId: string };
    const conversation = await deps.getOwnedConversationOrReply(currentUser.id, conversationId, reply);
    if (!conversation) {
      return { error: 'Conversation not found' };
    }

    const attachment = deps.getAttachment(conversationId, attachmentId);
    if (!attachment) {
      reply.code(404);
      return { error: 'Attachment not found' };
    }

    if (attachment.consumedAt) {
      reply.code(409);
      return { error: 'This attachment is already part of a sent message.' };
    }

    await deps.removeAttachment(conversationId, attachmentId);
    await unlink(attachment.storagePath).catch(() => {});
    return { ok: true };
  });

  app.post('/api/chat/conversations', async (request, reply) => {
    const currentUser = deps.getRequestUser(request);
    if (!deps.userCanUseMode(currentUser, 'chat')) {
      reply.code(403);
      return { error: 'Chat access required.' };
    }

    const body = (request.body ?? {}) as CreateChatConversationRequest;
    try {
      const conversation = await deps.createChatConversation(currentUser, body);
      reply.code(201);
      return {
        conversation: deps.toApiChatConversationRecord(conversation),
      };
    } catch (error) {
      if (error instanceof ChatConversationServiceError) {
        reply.code(error.statusCode);
        return { error: error.message };
      }
      throw error;
    }
  });

  app.patch('/api/chat/conversations/:conversationId', async (request, reply) => {
    const currentUser = deps.getRequestUser(request);
    const { conversationId } = request.params as { conversationId: string };
    const body = (request.body ?? {}) as UpdateChatConversationRequest;
    const conversation = await deps.getOwnedConversationOrReply(currentUser.id, conversationId, reply);
    if (!conversation) {
      return { error: 'Conversation not found' };
    }

    try {
      const nextConversation = await deps.renameConversation(conversation, body);
      return {
        conversation: deps.toApiChatConversationRecord(nextConversation),
      };
    } catch (error) {
      if (error instanceof ChatConversationServiceError) {
        reply.code(error.statusCode);
        return { error: error.message };
      }
      throw error;
    }
  });

  app.patch('/api/chat/conversations/:conversationId/preferences', async (request, reply) => {
    const currentUser = deps.getRequestUser(request);
    const { conversationId } = request.params as { conversationId: string };
    const body = (request.body ?? {}) as UpdateChatConversationPreferencesRequest;
    const conversation = await deps.getOwnedConversationOrReply(currentUser.id, conversationId, reply);
    if (!conversation) {
      return { error: 'Conversation not found' };
    }

    try {
      let nextConversation = await deps.updateConversationPreferences(conversation, body);
      if (nextConversation.executor !== conversation.executor) {
        nextConversation = await deps.restartSessionThread(
          nextConversation,
          'Executor changed. Started a fresh thread for this session.',
        );
      }
      return {
        conversation: deps.toApiChatConversationRecord(nextConversation),
      };
    } catch (error) {
      if (error instanceof ChatConversationServiceError) {
        reply.code(error.statusCode);
        return { error: error.message };
      }
      throw error;
    }
  });

  app.post('/api/chat/conversations/:conversationId/archive', async (request, reply) => {
    const currentUser = deps.getRequestUser(request);
    const { conversationId } = request.params as { conversationId: string };
    const conversation = await deps.getOwnedConversationOrReply(currentUser.id, conversationId, reply);
    if (!conversation) {
      return { error: 'Conversation not found' };
    }

    const nextConversation = await deps.archiveConversation(conversation);
    return {
      conversation: deps.toApiChatConversationRecord(nextConversation),
    };
  });

  app.post('/api/chat/conversations/:conversationId/restore', async (request, reply) => {
    const currentUser = deps.getRequestUser(request);
    const { conversationId } = request.params as { conversationId: string };
    const conversation = await deps.getOwnedConversationOrReply(currentUser.id, conversationId, reply);
    if (!conversation) {
      return { error: 'Conversation not found' };
    }

    const nextConversation = await deps.restoreConversation(conversation);
    return {
      conversation: deps.toApiChatConversationRecord(nextConversation),
    };
  });

  app.post('/api/chat/conversations/:conversationId/fork', async (request, reply) => {
    const currentUser = deps.getRequestUser(request);
    const { conversationId } = request.params as { conversationId: string };
    const conversation = await deps.getOwnedConversationOrReply(currentUser.id, conversationId, reply);
    if (!conversation) {
      return { error: 'Conversation not found' };
    }

    try {
      const nextConversation = await deps.createForkedConversation(currentUser, conversation);
      reply.code(201);
      return {
        conversation: deps.toApiChatConversationRecord(nextConversation),
      };
    } catch (error) {
      reply.code(500);
      return { error: deps.errorMessage(error) };
    }
  });

  app.delete('/api/chat/conversations/:conversationId', async (request, reply) => {
    const currentUser = deps.getRequestUser(request);
    const { conversationId } = request.params as { conversationId: string };
    const conversation = await deps.getOwnedConversationOrReply(currentUser.id, conversationId, reply);
    if (!conversation) {
      return { error: 'Conversation not found' };
    }

    const attachments = deps.listAttachments(conversationId);
    await deps.deleteConversationState(conversationId);
    await deps.deleteConversationHistory(conversationId);
    await deps.deleteStoredAttachments(attachments);
    return { ok: true };
  });

  app.post('/api/chat/conversations/:conversationId/messages', async (request, reply) => {
    const currentUser = deps.getRequestUser(request);
    const { conversationId } = request.params as { conversationId: string };
    const body = (request.body ?? {}) as CreateChatMessageRequest;
    const conversation = await deps.getOwnedConversationOrReply(currentUser.id, conversationId, reply);
    if (!conversation) {
      return { error: 'Conversation not found' };
    }

    try {
      const result = await deps.createChatMessage(conversation, body);
      return {
        turn: result.turn,
        conversation: deps.toApiChatConversationRecord(result.conversation),
      };
    } catch (error) {
      if (error instanceof ChatTurnServiceError) {
        reply.code(error.statusCode);
        return { error: error.message };
      }
      throw error;
    }
  });

  app.post('/api/chat/conversations/:conversationId/stop', async (request, reply) => {
    const currentUser = deps.getRequestUser(request);
    const { conversationId } = request.params as { conversationId: string };
    const conversation = await deps.getOwnedConversationOrReply(currentUser.id, conversationId, reply);
    if (!conversation) {
      return { error: 'Conversation not found' };
    }

    try {
      const nextConversation = await deps.stopChatTurn(conversation);
      return {
        conversation: deps.toApiChatConversationRecord(nextConversation),
      };
    } catch (error) {
      if (error instanceof ChatTurnServiceError) {
        reply.code(error.statusCode);
        return error.conversation
          ? { error: error.message, conversation: deps.toApiChatConversationRecord(error.conversation) }
          : { error: error.message };
      }
      throw error;
    }
  });
}
