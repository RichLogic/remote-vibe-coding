import { randomUUID } from 'node:crypto';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';

import type {
  ApprovalMode,
  ConversationRecord,
  CreateSessionRequest,
  CreateTurnRequest,
  ModelOption,
  ReasoningEffort,
  ResolveApprovalRequest,
  SecurityProfile,
  SessionAttachmentKind,
  SessionAttachmentRecord,
  SessionAttachmentSummary,
  SessionRecord,
  SessionType,
  UpdateSessionPreferencesRequest,
  UpdateSessionRequest,
  UserRecord,
  WorkspaceSummary,
} from '../types.js';

type TurnRecord = ConversationRecord | SessionRecord;

interface SessionRoutesDependencies {
  getRequestUser: (request: FastifyRequest) => UserRecord;
  getOwnedRecordOrReply: (
    userId: string,
    recordId: string,
    reply: FastifyReply,
  ) => Promise<TurnRecord | null>;
  buildSessionDetailResponse: (session: TurnRecord) => Promise<unknown>;
  buildSessionTranscriptResponse: (
    session: TurnRecord,
    query: { before?: string; limit?: string } | undefined,
  ) => Promise<unknown>;
  attachmentKindFromUpload: (filename: string, mimeType: string) => SessionAttachmentKind;
  sanitizeAttachmentFilename: (filename: string, fallbackBase: string) => string;
  extractAttachmentText: (
    kind: SessionAttachmentKind,
    filename: string,
    mimeType: string,
    buffer: Buffer,
  ) => Promise<string | null>;
  addAttachment: (attachment: SessionAttachmentRecord) => Promise<void>;
  attachmentSummary: (attachment: SessionAttachmentRecord) => SessionAttachmentSummary;
  getAttachment: (sessionId: string, attachmentId: string) => SessionAttachmentRecord | null;
  removeAttachment: (sessionId: string, attachmentId: string) => Promise<unknown>;
  normalizeSessionType: (value: unknown) => SessionType;
  trimOptional: (value: unknown) => string | null;
  userCanCreateSessionType: (user: UserRecord, sessionType: SessionType) => boolean;
  normalizeWorkspaceFolderName: (value: unknown) => string | null;
  ensureUserWorkspace: (
    username: string,
    userId: string,
    workspaceName: string,
  ) => Promise<WorkspaceSummary>;
  getOwnedWorkspace: (workspaceId: string, userId: string) => Promise<WorkspaceSummary | null>;
  errorMessage: (error: unknown) => string;
  createChatConversation: (
    currentUser: UserRecord,
    input: CreateSessionRequest,
  ) => Promise<ConversationRecord>;
  createDeveloperSession: (
    currentUser: UserRecord,
    workspace: WorkspaceSummary,
    input: CreateSessionRequest,
  ) => Promise<SessionRecord>;
  restartSessionThread: (session: TurnRecord, reason?: string) => Promise<TurnRecord>;
  createForkedSession: (
    currentUser: UserRecord,
    session: SessionRecord,
  ) => Promise<SessionRecord>;
  createForkedConversation: (
    currentUser: UserRecord,
    conversation: ConversationRecord,
  ) => Promise<ConversationRecord>;
  updateRecord: (record: TurnRecord, patch: Partial<TurnRecord>) => Promise<TurnRecord | null>;
  normalizeSecurityProfile: (value: unknown) => SecurityProfile;
  normalizeApprovalMode: (value: unknown) => ApprovalMode;
  updateConversationPreferences: (
    conversation: ConversationRecord,
    input: UpdateSessionPreferencesRequest,
  ) => Promise<ConversationRecord>;
  renameConversation: (
    conversation: ConversationRecord,
    input: UpdateSessionRequest,
  ) => Promise<ConversationRecord>;
  archiveConversation: (conversation: ConversationRecord) => Promise<ConversationRecord>;
  restoreConversation: (conversation: ConversationRecord) => Promise<ConversationRecord>;
  clearApprovals: (sessionId: string) => void;
  deleteConversationState: (conversationId: string) => Promise<unknown>;
  deleteConversationHistory: (conversationId: string) => Promise<unknown>;
  deleteCodingSession: (sessionId: string) => Promise<unknown>;
  deleteStoredAttachments: (attachments: SessionAttachmentRecord[]) => Promise<void>;
  listAttachments: (sessionId: string) => SessionAttachmentRecord[];
  createChatMessage: (
    conversation: ConversationRecord,
    input: CreateTurnRequest,
  ) => Promise<{ turn: unknown; conversation: ConversationRecord }>;
  stopChatTurn: (conversation: ConversationRecord) => Promise<ConversationRecord>;
  startTurnWithAutoRestart: (
    session: SessionRecord,
    prompt: string | null,
    attachments: SessionAttachmentRecord[],
  ) => Promise<{ turn: unknown; session: SessionRecord }>;
  interruptTurn: (session: SessionRecord, threadId: string, turnId: string) => Promise<unknown>;
  addLiveEvent: (sessionId: string, event: { id: string; method: string; summary: string; createdAt: string }) => void;
  isThreadUnavailableError: (error: unknown) => boolean;
  staleSessionMessage: string;
  getApprovals: (sessionId: string) => Array<{
    id: string;
    rpcRequestId: number | string;
    method: string;
    payload: unknown;
  }>;
  respondToRuntime: (session: SessionRecord, rpcRequestId: number | string, payload: unknown) => Promise<void>;
  removeApproval: (sessionId: string, approvalId: string) => void;
  updateCodingSession: (
    sessionId: string,
    patch: Partial<SessionRecord>,
  ) => Promise<SessionRecord | null>;
  currentDefaultModel: (executor?: SessionRecord['executor']) => string;
  findModelOption: (model: string, executor?: SessionRecord['executor']) => ModelOption | null;
  normalizeReasoningEffort: (value: unknown) => ReasoningEffort | null;
  preferredReasoningEffortForModel: (modelOption: ModelOption) => ReasoningEffort;
}

function isConversation(record: TurnRecord): record is ConversationRecord {
  return record.sessionType === 'chat';
}

function isDeveloperSession(record: TurnRecord): record is SessionRecord {
  return record.sessionType === 'code';
}

function errorStatusCode(error: unknown) {
  return (
    error
    && typeof error === 'object'
    && 'statusCode' in error
    && typeof (error as { statusCode?: unknown }).statusCode === 'number'
  )
    ? (error as { statusCode: number }).statusCode
    : null;
}

export function registerSessionRoutes(app: FastifyInstance, deps: SessionRoutesDependencies) {
  app.get('/api/sessions/:sessionId', async (request, reply) => {
    const currentUser = deps.getRequestUser(request);
    const { sessionId } = request.params as { sessionId: string };
    const session = await deps.getOwnedRecordOrReply(currentUser.id, sessionId, reply);
    if (!session) {
      return { error: 'Session not found' };
    }

    return deps.buildSessionDetailResponse(session);
  });

  app.get('/api/sessions/:sessionId/transcript', async (request, reply) => {
    const currentUser = deps.getRequestUser(request);
    const { sessionId } = request.params as { sessionId: string };
    const session = await deps.getOwnedRecordOrReply(currentUser.id, sessionId, reply);
    if (!session) {
      return { error: 'Session not found' };
    }

    return deps.buildSessionTranscriptResponse(
      session,
      request.query as { before?: string; limit?: string } | undefined,
    );
  });

  app.post('/api/sessions/:sessionId/attachments', async (request, reply) => {
    const currentUser = deps.getRequestUser(request);
    const { sessionId } = request.params as { sessionId: string };
    const session = await deps.getOwnedRecordOrReply(currentUser.id, sessionId, reply);
    if (!session) {
      return { error: 'Session not found' };
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
    const attachmentsDir = join(session.workspace, '.rvc-attachments');
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
      ownerKind: isConversation(session) ? 'conversation' : 'session',
      ownerId: session.id,
      sessionId: session.id,
      ownerUserId: session.ownerUserId,
      ownerUsername: session.ownerUsername,
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
      attachment: deps.attachmentSummary(attachment),
    };
  });

  app.get('/api/sessions/:sessionId/attachments/:attachmentId/content', async (request, reply) => {
    const currentUser = deps.getRequestUser(request);
    const { sessionId, attachmentId } = request.params as { sessionId: string; attachmentId: string };
    const query = request.query as { download?: string } | undefined;
    const session = await deps.getOwnedRecordOrReply(currentUser.id, sessionId, reply);
    if (!session) {
      return { error: 'Session not found' };
    }

    const attachment = deps.getAttachment(sessionId, attachmentId);
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

  app.delete('/api/sessions/:sessionId/attachments/:attachmentId', async (request, reply) => {
    const currentUser = deps.getRequestUser(request);
    const { sessionId, attachmentId } = request.params as { sessionId: string; attachmentId: string };
    const session = await deps.getOwnedRecordOrReply(currentUser.id, sessionId, reply);
    if (!session) {
      return { error: 'Session not found' };
    }

    const attachment = deps.getAttachment(sessionId, attachmentId);
    if (!attachment) {
      reply.code(404);
      return { error: 'Attachment not found' };
    }

    if (attachment.consumedAt) {
      reply.code(409);
      return { error: 'This attachment is already part of a sent turn.' };
    }

    await deps.removeAttachment(sessionId, attachmentId);
    await unlink(attachment.storagePath).catch(() => {});
    return { ok: true };
  });

  app.post('/api/sessions', async (request, reply) => {
    const currentUser = deps.getRequestUser(request);
    const body = (request.body ?? {}) as CreateSessionRequest;
    const sessionType = deps.normalizeSessionType(body.sessionType);

    if (!deps.userCanCreateSessionType(currentUser, sessionType)) {
      reply.code(403);
      return { error: `You do not have permission to create ${sessionType} sessions.` };
    }

    if (sessionType === 'chat') {
      try {
        const conversation = await deps.createChatConversation(currentUser, body);
        reply.code(201);
        return { session: conversation, conversation };
      } catch (error) {
        reply.code(errorStatusCode(error) ?? 400);
        return { error: deps.errorMessage(error) };
      }
    }

    let workspace: WorkspaceSummary;
    if (body.workspaceId) {
      const existingWorkspace = await deps.getOwnedWorkspace(body.workspaceId, currentUser.id);
      if (!existingWorkspace) {
        reply.code(404);
        return { error: 'Workspace not found.' };
      }
      workspace = existingWorkspace;
    } else {
      const workspaceName = deps.normalizeWorkspaceFolderName(body.workspaceName);
      if (!workspaceName) {
        reply.code(400);
        return { error: 'Workspace is required.' };
      }
      try {
        workspace = await deps.ensureUserWorkspace(currentUser.username, currentUser.id, workspaceName);
      } catch (error) {
        reply.code(400);
        return { error: deps.errorMessage(error) };
      }
    }

    try {
      const session = await deps.createDeveloperSession(currentUser, workspace, body);
      reply.code(201);
      return { session };
    } catch (error) {
      const message = deps.errorMessage(error);
      reply.code(message.includes('permission') ? 403 : 400);
      return { error: message };
    }
  });

  app.post('/api/sessions/:sessionId/restart', async (request, reply) => {
    const currentUser = deps.getRequestUser(request);
    const { sessionId } = request.params as { sessionId: string };
    const session = await deps.getOwnedRecordOrReply(currentUser.id, sessionId, reply);
    if (!session) {
      return { error: 'Session not found' };
    }

    return { session: await deps.restartSessionThread(session) };
  });

  app.post('/api/sessions/:sessionId/fork', async (request, reply) => {
    const currentUser = deps.getRequestUser(request);
    const { sessionId } = request.params as { sessionId: string };
    const session = await deps.getOwnedRecordOrReply(currentUser.id, sessionId, reply);
    if (!session) {
      return { error: 'Session not found' };
    }

    try {
      const nextSession = isDeveloperSession(session)
        ? await deps.createForkedSession(currentUser, session)
        : await deps.createForkedConversation(currentUser, session);
      reply.code(201);
      return { session: nextSession };
    } catch (error) {
      reply.code(500);
      return { error: deps.errorMessage(error) };
    }
  });

  app.post('/api/sessions/:sessionId/rename', async (request, reply) => {
    const currentUser = deps.getRequestUser(request);
    const { sessionId } = request.params as { sessionId: string };
    const body = (request.body ?? {}) as UpdateSessionRequest;
    const session = await deps.getOwnedRecordOrReply(currentUser.id, sessionId, reply);
    if (!session) {
      return { error: 'Session not found' };
    }

    if (isConversation(session)) {
      try {
        return { session: await deps.renameConversation(session, body) };
      } catch (error) {
        reply.code(errorStatusCode(error) ?? 400);
        return { error: deps.errorMessage(error) };
      }
    }

    const title = deps.trimOptional(body.title);
    if (!title) {
      reply.code(400);
      return { error: 'Session title is required' };
    }

    return {
      session: (await deps.updateRecord(session, {
        title,
        autoTitle: false,
      })) ?? session,
    };
  });

  app.patch('/api/sessions/:sessionId', async (request, reply) => {
    const currentUser = deps.getRequestUser(request);
    const { sessionId } = request.params as { sessionId: string };
    const body = (request.body ?? {}) as UpdateSessionRequest;
    const session = await deps.getOwnedRecordOrReply(currentUser.id, sessionId, reply);
    if (!session) {
      return { error: 'Session not found' };
    }

    const titleProvided = Object.prototype.hasOwnProperty.call(body, 'title');
    const workspaceProvided = Object.prototype.hasOwnProperty.call(body, 'workspaceName');
    const securityProvided = Object.prototype.hasOwnProperty.call(body, 'securityProfile');
    const approvalModeProvided = Object.prototype.hasOwnProperty.call(body, 'approvalMode');

    const title = titleProvided ? deps.trimOptional(body.title) : session.title;
    if (titleProvided && !title) {
      reply.code(400);
      return { error: 'Session title is required' };
    }

    if ((workspaceProvided || securityProvided) && session.activeTurnId) {
      reply.code(409);
      return { error: 'Stop the active turn before editing this session.' };
    }

    let workspace = session.workspace;
    let workspaceId = isDeveloperSession(session) ? session.workspaceId : undefined;
    if (workspaceProvided && isDeveloperSession(session)) {
      const workspaceName = deps.normalizeWorkspaceFolderName(body.workspaceName);
      if (!workspaceName) {
        reply.code(400);
        return { error: 'Workspace is required.' };
      }

      try {
        const workspaceRecord = await deps.ensureUserWorkspace(currentUser.username, currentUser.id, workspaceName);
        workspace = workspaceRecord.path;
        workspaceId = workspaceRecord.id;
      } catch (error) {
        reply.code(400);
        return { error: deps.errorMessage(error) };
      }
    }

    let securityProfile = session.securityProfile;
    if (isConversation(session)) {
      securityProfile = 'repo-write';
    } else if (securityProvided) {
      securityProfile = deps.normalizeSecurityProfile(body.securityProfile);
      if (securityProfile === 'read-only') {
        securityProfile = 'repo-write';
      }
      if (securityProfile === 'full-host' && !currentUser.canUseFullHost) {
        reply.code(403);
        return { error: 'You do not have permission to use full-host sessions.' };
      }
    }

    const approvalMode = approvalModeProvided
      ? deps.normalizeApprovalMode(body.approvalMode)
      : session.approvalMode;
    const restartRequired = workspace !== session.workspace || securityProfile !== session.securityProfile;

    let nextSession = (await deps.updateRecord(session, {
      title: title ?? session.title,
      autoTitle: titleProvided ? false : session.autoTitle,
      workspace,
      securityProfile,
      approvalMode: isDeveloperSession(session) ? approvalMode : session.approvalMode,
      fullHostEnabled: isDeveloperSession(session) ? securityProfile === 'full-host' : false,
      ...(isDeveloperSession(session) && workspaceId ? { workspaceId } : {}),
    })) ?? session;

    if (restartRequired) {
      nextSession = await deps.restartSessionThread(
        nextSession,
        'Session settings changed. Started a fresh thread for this session.',
      );
    }

    return { session: nextSession };
  });

  app.patch('/api/sessions/:sessionId/preferences', async (request, reply) => {
    const currentUser = deps.getRequestUser(request);
    const { sessionId } = request.params as { sessionId: string };
    const body = (request.body ?? {}) as UpdateSessionPreferencesRequest;
    const session = await deps.getOwnedRecordOrReply(currentUser.id, sessionId, reply);
    if (!session) {
      return { error: 'Session not found' };
    }

    if (isConversation(session)) {
      try {
        return { session: await deps.updateConversationPreferences(session, body) };
      } catch (error) {
        reply.code(errorStatusCode(error) ?? 400);
        return { error: deps.errorMessage(error) };
      }
    }

    const requestedModel = deps.trimOptional(body.model) ?? session.model ?? deps.currentDefaultModel(session.executor);
    const modelOption = deps.findModelOption(requestedModel, session.executor);
    if (!modelOption) {
      reply.code(400);
      return { error: 'Unknown model.' };
    }

    const requestedEffort = deps.normalizeReasoningEffort(body.reasoningEffort);
    const reasoningEffort = requestedEffort && modelOption.supportedReasoningEfforts.includes(requestedEffort)
      ? requestedEffort
      : deps.preferredReasoningEffortForModel(modelOption);
    const approvalMode = deps.normalizeApprovalMode(body.approvalMode ?? session.approvalMode);

    return {
      session: (await deps.updateCodingSession(session.id, {
        model: modelOption.model,
        reasoningEffort,
        approvalMode,
      })) ?? session,
    };
  });

  app.post('/api/sessions/:sessionId/archive', async (request, reply) => {
    const currentUser = deps.getRequestUser(request);
    const { sessionId } = request.params as { sessionId: string };
    const session = await deps.getOwnedRecordOrReply(currentUser.id, sessionId, reply);
    if (!session) {
      return { error: 'Session not found' };
    }

    if (isConversation(session)) {
      return { session: await deps.archiveConversation(session) };
    }

    if (session.archivedAt) {
      return { session };
    }

    deps.clearApprovals(sessionId);
    return {
      session: (await deps.updateCodingSession(session.id, {
        archivedAt: new Date().toISOString(),
        activeTurnId: null,
        status: 'idle',
        networkEnabled: false,
        lastIssue: null,
      })) ?? session,
    };
  });

  app.post('/api/sessions/:sessionId/restore', async (request, reply) => {
    const currentUser = deps.getRequestUser(request);
    const { sessionId } = request.params as { sessionId: string };
    const session = await deps.getOwnedRecordOrReply(currentUser.id, sessionId, reply);
    if (!session) {
      return { error: 'Session not found' };
    }

    if (isConversation(session)) {
      return { session: await deps.restoreConversation(session) };
    }

    if (!session.archivedAt) {
      return { session };
    }

    return {
      session: (await deps.updateCodingSession(session.id, {
        archivedAt: null,
        status: 'idle',
        lastIssue: null,
      })) ?? session,
    };
  });

  app.delete('/api/sessions/:sessionId', async (request, reply) => {
    const currentUser = deps.getRequestUser(request);
    const { sessionId } = request.params as { sessionId: string };
    const session = await deps.getOwnedRecordOrReply(currentUser.id, sessionId, reply);
    if (!session) {
      return { error: 'Session not found' };
    }

    const attachments = deps.listAttachments(sessionId);
    if (isConversation(session)) {
      await deps.deleteConversationState(sessionId);
      await deps.deleteConversationHistory(sessionId);
    } else {
      await deps.deleteCodingSession(sessionId);
    }
    await deps.deleteStoredAttachments(attachments);
    return { ok: true };
  });

  app.post('/api/sessions/:sessionId/turns', async (request, reply) => {
    const currentUser = deps.getRequestUser(request);
    const { sessionId } = request.params as { sessionId: string };
    const body = (request.body ?? {}) as CreateTurnRequest;
    const session = await deps.getOwnedRecordOrReply(currentUser.id, sessionId, reply);
    if (!session) {
      return { error: 'Session not found' };
    }

    if (isConversation(session)) {
      try {
        const result = await deps.createChatMessage(session, body);
        return { turn: result.turn, session: result.conversation };
      } catch (error) {
        reply.code(errorStatusCode(error) ?? 500);
        return {
          error: deps.errorMessage(error),
          ...(error && typeof error === 'object' && 'conversation' in error
            ? { session: (error as { conversation?: ConversationRecord | null }).conversation ?? undefined }
            : {}),
        };
      }
    }

    const prompt = body.prompt?.trim() ?? '';
    const attachmentIds = Array.isArray(body.attachmentIds)
      ? [...new Set(body.attachmentIds.filter((value): value is string => typeof value === 'string' && value.trim().length > 0))]
      : [];
    const attachments = attachmentIds.map((attachmentId) => deps.getAttachment(sessionId, attachmentId));

    if (!prompt && attachmentIds.length === 0) {
      reply.code(400);
      return { error: 'Prompt or attachment is required' };
    }

    if (attachments.some((attachment) => !attachment || attachment.consumedAt)) {
      reply.code(400);
      return { error: 'One or more attachments are missing or already used.' };
    }

    try {
      const result = await deps.startTurnWithAutoRestart(
        session,
        prompt || null,
        attachments.filter((attachment): attachment is SessionAttachmentRecord => Boolean(attachment)),
      );
      return { turn: result.turn, session: result.session };
    } catch (error) {
      const message = deps.errorMessage(error);
      await deps.updateCodingSession(session.id, {
        activeTurnId: null,
        status: 'error',
        lastIssue: message,
      });
      reply.code(500);
      return { error: message };
    }
  });

  app.post('/api/sessions/:sessionId/stop', async (request, reply) => {
    const currentUser = deps.getRequestUser(request);
    const { sessionId } = request.params as { sessionId: string };
    const session = await deps.getOwnedRecordOrReply(currentUser.id, sessionId, reply);
    if (!session) {
      return { error: 'Session not found' };
    }

    if (isConversation(session)) {
      try {
        return { session: await deps.stopChatTurn(session) };
      } catch (error) {
        reply.code(errorStatusCode(error) ?? 500);
        return {
          error: deps.errorMessage(error),
          ...(error && typeof error === 'object' && 'conversation' in error
            ? { session: (error as { conversation?: ConversationRecord | null }).conversation ?? undefined }
            : {}),
        };
      }
    }

    if (!session.activeTurnId) {
      reply.code(409);
      return { error: 'This session does not have an active turn to stop.' };
    }

    try {
      await deps.interruptTurn(session, session.threadId, session.activeTurnId);
      deps.addLiveEvent(session.id, {
        id: randomUUID(),
        method: 'turn/interrupted',
        summary: 'Stopped the active turn.',
        createdAt: new Date().toISOString(),
      });
      return {
        session: (await deps.updateCodingSession(session.id, {
          activeTurnId: null,
          status: 'idle',
          lastIssue: 'Stopped by user.',
        })) ?? session,
      };
    } catch (error) {
      if (deps.isThreadUnavailableError(error)) {
        const nextSession = (await deps.updateCodingSession(session.id, {
          activeTurnId: null,
          status: 'stale',
          lastIssue: deps.staleSessionMessage,
          networkEnabled: false,
        })) ?? session;
        reply.code(409);
        return { error: deps.staleSessionMessage, session: nextSession };
      }

      const message = deps.errorMessage(error);
      await deps.updateCodingSession(session.id, {
        activeTurnId: null,
        status: 'error',
        lastIssue: message,
      });
      reply.code(500);
      return { error: message };
    }
  });

  app.post('/api/sessions/:sessionId/approvals/:approvalId', async (request, reply) => {
    const currentUser = deps.getRequestUser(request);
    const { sessionId, approvalId } = request.params as { sessionId: string; approvalId: string };
    const body = (request.body ?? {}) as ResolveApprovalRequest;
    const session = await deps.getOwnedRecordOrReply(currentUser.id, sessionId, reply);
    if (!session) {
      return { error: 'Session not found' };
    }
    if (!isDeveloperSession(session)) {
      reply.code(404);
      return { error: 'Approval not found' };
    }

    const approval = deps.getApprovals(sessionId).find((entry) => entry.id === approvalId);
    if (!approval) {
      reply.code(404);
      return { error: 'Approval not found' };
    }

    const scope = body.scope === 'session' ? 'session' : 'once';
    const accepted = body.decision !== 'decline';

    if (approval.method === 'item/commandExecution/requestApproval' || approval.method === 'item/fileChange/requestApproval') {
      await deps.respondToRuntime(session, approval.rpcRequestId, {
        decision: accepted ? (scope === 'session' ? 'acceptForSession' : 'accept') : 'decline',
      });
    } else if (approval.method === 'item/permissions/requestApproval') {
      const params = approval.payload as { permissions?: unknown };
      await deps.respondToRuntime(session, approval.rpcRequestId, {
        permissions: accepted ? (params.permissions ?? {}) : {},
        scope: scope === 'session' ? 'session' : 'turn',
      });
      if (accepted) {
        await deps.updateCodingSession(sessionId, {
          networkEnabled: true,
        });
      }
    } else {
      await deps.respondToRuntime(session, approval.rpcRequestId, {
        decision: accepted ? 'accept' : 'cancel',
      });
    }

    deps.removeApproval(sessionId, approvalId);
    await deps.updateCodingSession(sessionId, {
      status: deps.getApprovals(sessionId).length > 0 ? 'needs-approval' : 'running',
      lastIssue: null,
    });
    return { ok: true };
  });
}
