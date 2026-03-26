import { randomUUID } from 'node:crypto';
import { readFile, rename, writeFile } from 'node:fs/promises';

import { DEFAULT_APPROVAL_MODE, normalizeApprovalMode } from './approval-mode.js';
import { ensureDataDir, SESSIONS_BACKUP_FILE, SESSIONS_FILE } from './config.js';
import { DEFAULT_AGENT_EXECUTOR } from './executor.js';
import type {
  ApprovalMode,
  BaseTurnRecord,
  ConversationRecord,
  PendingApproval,
  ReasoningEffort,
  SessionAttachmentRecord,
  SessionEvent,
  SessionRecord,
  SessionStatus,
  SessionType,
  SecurityProfile,
  WorkspaceRecord,
} from './types.js';

interface PersistedState {
  version: 3;
  workspaces: WorkspaceRecord[];
  sessions: SessionRecord[];
  conversations: ConversationRecord[];
  attachments?: SessionAttachmentRecord[];
}

interface LegacyPersistedState {
  sessions: LegacySessionRecord[];
  attachments?: SessionAttachmentRecord[];
}

interface LegacySessionRecord {
  id: string;
  threadId: string;
  title: string;
  autoTitle?: boolean;
  workspace: string;
  archivedAt?: string | null;
  securityProfile?: SecurityProfile;
  approvalMode?: ApprovalMode;
  networkEnabled?: boolean;
  fullHostEnabled?: boolean;
  status?: SessionStatus;
  lastIssue?: string | null;
  createdAt: string;
  updatedAt: string;
  ownerUserId?: string;
  ownerUsername?: string;
  sessionType?: SessionType;
  model?: string | null;
  reasoningEffort?: ReasoningEffort | null;
}

interface LoadOptions {
  fallbackOwnerUserId: string;
  fallbackOwnerUsername: string;
}

interface EnsureWorkspaceInput {
  id?: string;
  ownerUserId: string;
  ownerUsername: string;
  name: string;
  path: string;
  visible?: boolean;
  sortOrder?: number;
  createdAt?: string;
  updatedAt?: string;
}

const MAX_LIVE_EVENTS = 200;

function isMissingFileError(error: unknown): error is NodeJS.ErrnoException {
  return Boolean(error && typeof error === 'object' && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT');
}

function formatPersistenceError(context: string, filePath: string, error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return new Error(`Failed to load ${context} from ${filePath}: ${message}`);
}

function defaultConversationRecoveryState(status: SessionStatus | undefined) {
  return status === 'stale' ? 'stale' as const : 'ready' as const;
}

function defaultConversationRetryable(status: SessionStatus | undefined) {
  return status === 'error';
}

function interruptedConversation(record: Pick<ConversationRecord, 'activeTurnId' | 'status'>) {
  return Boolean(record.activeTurnId) || record.status === 'running' || record.status === 'error';
}

async function loadPersistedState<T>(primaryPath: string, backupPath: string, context: string): Promise<T | null> {
  let primaryError: Error | null = null;

  try {
    return JSON.parse(await readFile(primaryPath, 'utf8')) as T;
  } catch (error) {
    if (!isMissingFileError(error)) {
      primaryError = formatPersistenceError(context, primaryPath, error);
    }
  }

  try {
    return JSON.parse(await readFile(backupPath, 'utf8')) as T;
  } catch (error) {
    if (isMissingFileError(error)) {
      if (primaryError) {
        throw primaryError;
      }
      return null;
    }
    throw formatPersistenceError(context, backupPath, error);
  }
}

async function writePersistedState(primaryPath: string, backupPath: string, content: string) {
  const tempPath = `${primaryPath}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`;
  const previousContent = await readFile(primaryPath, 'utf8').catch((error: unknown) => {
    if (isMissingFileError(error)) {
      return null;
    }
    throw error;
  });

  await writeFile(tempPath, content);
  if (previousContent !== null) {
    await writeFile(backupPath, previousContent);
  }
  await rename(tempPath, primaryPath);
}

export class SessionStore {
  private readonly workspaces = new Map<string, WorkspaceRecord>();
  private readonly sessions = new Map<string, SessionRecord>();
  private readonly conversations = new Map<string, ConversationRecord>();
  private readonly attachments = new Map<string, SessionAttachmentRecord[]>();
  private readonly approvals = new Map<string, PendingApproval[]>();
  private readonly liveEvents = new Map<string, SessionEvent[]>();
  private saveQueue: Promise<void> = Promise.resolve();

  async load(options: LoadOptions) {
    await ensureDataDir();
    const parsed = await loadPersistedState<PersistedState | LegacyPersistedState>(
      SESSIONS_FILE,
      SESSIONS_BACKUP_FILE,
      'session state',
    );
    if (!parsed) {
      return;
    }

    if ('version' in parsed && parsed.version === 3) {
      const sortedWorkspaces = [...(parsed.workspaces ?? [])].sort((left, right) => {
        const leftOrder = typeof left.sortOrder === 'number' ? left.sortOrder : Number.MAX_SAFE_INTEGER;
        const rightOrder = typeof right.sortOrder === 'number' ? right.sortOrder : Number.MAX_SAFE_INTEGER;
        if (leftOrder !== rightOrder) {
          return leftOrder - rightOrder;
        }
        return left.name.localeCompare(right.name);
      });
      for (const [index, workspace] of sortedWorkspaces.entries()) {
        this.workspaces.set(workspace.id, {
          ...workspace,
          visible: workspace.visible ?? true,
          sortOrder: typeof workspace.sortOrder === 'number' ? workspace.sortOrder : index,
        });
      }
      for (const session of parsed.sessions ?? []) {
        this.sessions.set(session.id, {
          ...session,
          executor: session.executor ?? DEFAULT_AGENT_EXECUTOR,
          approvalMode: normalizeApprovalMode(session.approvalMode),
          hasTranscript: typeof session.hasTranscript === 'boolean'
            ? session.hasTranscript
            : session.createdAt !== session.updatedAt,
        });
      }
      for (const conversation of parsed.conversations ?? []) {
        this.conversations.set(conversation.id, {
          ...conversation,
          executor: conversation.executor ?? DEFAULT_AGENT_EXECUTOR,
          approvalMode: normalizeApprovalMode(conversation.approvalMode),
          rolePresetId: conversation.rolePresetId ?? null,
          recoveryState: conversation.recoveryState ?? defaultConversationRecoveryState(conversation.status),
          retryable: typeof conversation.retryable === 'boolean'
            ? conversation.retryable
            : defaultConversationRetryable(conversation.status),
          hasTranscript: typeof conversation.hasTranscript === 'boolean'
            ? conversation.hasTranscript
            : conversation.createdAt !== conversation.updatedAt,
        });
      }
      for (const attachment of parsed.attachments ?? []) {
        const ownerId = attachment.ownerId ?? attachment.sessionId;
        const current = this.attachments.get(ownerId) ?? [];
        this.attachments.set(ownerId, [
          ...current,
          {
            ...attachment,
            ownerKind: attachment.ownerKind ?? 'session',
            ownerId,
            sessionId: ownerId,
          },
        ]);
      }
      return;
    }

    for (const legacy of parsed.sessions ?? []) {
      const record = this.normalizeLegacySession(legacy, options);
      if (record.sessionType === 'chat') {
        const conversation: ConversationRecord = {
          ...record,
          sessionType: 'chat',
          executor: DEFAULT_AGENT_EXECUTOR,
          securityProfile: 'repo-write',
          approvalMode: DEFAULT_APPROVAL_MODE,
          fullHostEnabled: false,
          rolePresetId: null,
          recoveryState: defaultConversationRecoveryState(record.status),
          retryable: defaultConversationRetryable(record.status),
        };
        this.conversations.set(conversation.id, conversation);
      } else {
        const workspaceId = this.ensureWorkspaceRecord({
          ownerUserId: record.ownerUserId,
          ownerUsername: record.ownerUsername,
          name: record.workspace.split('/').filter(Boolean).pop() ?? record.workspace,
          path: record.workspace,
          createdAt: record.createdAt,
          updatedAt: record.updatedAt,
        }).id;
        const session: SessionRecord = {
          ...record,
          sessionType: 'code',
          executor: DEFAULT_AGENT_EXECUTOR,
          workspaceId,
        };
        this.sessions.set(session.id, session);
      }
    }

    for (const attachment of parsed.attachments ?? []) {
      const ownerId = attachment.sessionId;
      const ownerKind = this.conversations.has(ownerId) ? 'conversation' : 'session';
      const current = this.attachments.get(ownerId) ?? [];
      this.attachments.set(ownerId, [
        ...current,
        {
          ...attachment,
          ownerKind,
          ownerId,
          sessionId: ownerId,
        },
      ]);
    }

    await this.save();
  }

  private normalizeLegacySession(legacy: LegacySessionRecord, options: LoadOptions): BaseTurnRecord {
    const normalizedArchivedAt = legacy.archivedAt ?? null;
    const normalizedStatus = normalizedArchivedAt
      ? 'idle'
      : legacy.status === 'needs-approval'
        ? 'idle'
        : legacy.status ?? 'idle';
    return {
      id: legacy.id,
      ownerUserId: legacy.ownerUserId ?? options.fallbackOwnerUserId,
      ownerUsername: legacy.ownerUsername ?? options.fallbackOwnerUsername,
      sessionType: legacy.sessionType ?? 'code',
      threadId: legacy.threadId,
      activeTurnId: null,
      title: legacy.title,
      autoTitle: Boolean(legacy.autoTitle),
      workspace: legacy.workspace,
      archivedAt: normalizedArchivedAt,
      securityProfile: legacy.sessionType === 'chat'
        ? 'repo-write'
        : legacy.securityProfile ?? 'repo-write',
      approvalMode: legacy.sessionType === 'chat'
        ? DEFAULT_APPROVAL_MODE
        : normalizeApprovalMode(legacy.approvalMode),
      networkEnabled: Boolean(legacy.networkEnabled),
      fullHostEnabled: legacy.sessionType === 'chat' ? false : Boolean(legacy.fullHostEnabled),
      status: normalizedStatus,
      lastIssue: legacy.lastIssue ?? null,
      hasTranscript: legacy.createdAt !== legacy.updatedAt,
      model: legacy.model ?? null,
      reasoningEffort: legacy.reasoningEffort ?? null,
      createdAt: legacy.createdAt,
      updatedAt: legacy.updatedAt,
    };
  }

  async save() {
    const runSave = async () => {
      await ensureDataDir();
      const state: PersistedState = {
        version: 3,
        workspaces: this.listWorkspaces(),
        sessions: this.listSessions(),
        conversations: this.listConversations(),
        attachments: [...this.attachments.values()].flat(),
      };
      await writePersistedState(
        SESSIONS_FILE,
        SESSIONS_BACKUP_FILE,
        `${JSON.stringify(state, null, 2)}\n`,
      );
    };

    const nextSave = this.saveQueue
      .catch(() => {})
      .then(runSave);
    this.saveQueue = nextSave;
    await nextSave;
  }

  listWorkspaces() {
    return [...this.workspaces.values()].sort((left, right) => {
      if (left.sortOrder !== right.sortOrder) {
        return left.sortOrder - right.sortOrder;
      }
      return left.name.localeCompare(right.name);
    });
  }

  listWorkspacesForUser(userId: string) {
    return this.listWorkspaces().filter((workspace) => workspace.ownerUserId === userId);
  }

  getWorkspace(workspaceId: string) {
    return this.workspaces.get(workspaceId) ?? null;
  }

  getWorkspaceForUser(workspaceId: string, userId: string) {
    const workspace = this.getWorkspace(workspaceId);
    if (!workspace || workspace.ownerUserId !== userId) {
      return null;
    }
    return workspace;
  }

  findWorkspaceByPathForUser(userId: string, path: string) {
    return this.listWorkspacesForUser(userId).find((workspace) => workspace.path === path) ?? null;
  }

  async ensureWorkspace(input: EnsureWorkspaceInput) {
    const existing = this.findWorkspaceByPathForUser(input.ownerUserId, input.path);
    if (existing) {
      if (
        existing.name === input.name
        && existing.ownerUsername === input.ownerUsername
        && (input.visible === undefined || existing.visible === input.visible)
        && (input.sortOrder === undefined || existing.sortOrder === input.sortOrder)
      ) {
        return existing;
      }
      const next: WorkspaceRecord = {
        ...existing,
        name: input.name,
        ownerUsername: input.ownerUsername,
        ...(input.visible === undefined ? {} : { visible: input.visible }),
        ...(input.sortOrder === undefined ? {} : { sortOrder: input.sortOrder }),
        updatedAt: input.updatedAt ?? new Date().toISOString(),
      };
      this.workspaces.set(next.id, next);
      await this.save();
      return next;
    }

    const next = this.ensureWorkspaceRecord(input);
    await this.save();
    return next;
  }

  private ensureWorkspaceRecord(input: EnsureWorkspaceInput) {
    const now = new Date().toISOString();
    const next: WorkspaceRecord = {
      id: input.id ?? randomUUID(),
      ownerUserId: input.ownerUserId,
      ownerUsername: input.ownerUsername,
      name: input.name,
      path: input.path,
      visible: input.visible ?? true,
      sortOrder: input.sortOrder ?? this.listWorkspacesForUser(input.ownerUserId).length,
      createdAt: input.createdAt ?? now,
      updatedAt: input.updatedAt ?? input.createdAt ?? now,
    };
    this.workspaces.set(next.id, next);
    return next;
  }

  async updateWorkspace(workspaceId: string, patch: Partial<WorkspaceRecord>) {
    const current = this.workspaces.get(workspaceId);
    if (!current) {
      return null;
    }
    const next: WorkspaceRecord = {
      ...current,
      ...patch,
      id: current.id,
      ownerUserId: current.ownerUserId,
      path: current.path,
      createdAt: current.createdAt,
      updatedAt: patch.updatedAt ?? new Date().toISOString(),
    };
    this.workspaces.set(workspaceId, next);
    await this.save();
    return next;
  }

  listSessions() {
    return [...this.sessions.values()].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  listSessionsForUser(userId: string) {
    return this.listSessions().filter((session) => session.ownerUserId === userId);
  }

  listSessionsForWorkspace(userId: string, workspaceId: string | null) {
    return this.listSessionsForUser(userId).filter((session) => (
      workspaceId ? session.workspaceId === workspaceId : true
    ));
  }

  listConversations() {
    return [...this.conversations.values()].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  listConversationsForUser(userId: string) {
    return this.listConversations().filter((conversation) => conversation.ownerUserId === userId);
  }

  getSession(sessionId: string) {
    return this.sessions.get(sessionId) ?? null;
  }

  getSessionForUser(sessionId: string, userId: string) {
    const session = this.getSession(sessionId);
    if (!session || session.ownerUserId !== userId) {
      return null;
    }
    return session;
  }

  getConversation(conversationId: string) {
    return this.conversations.get(conversationId) ?? null;
  }

  getConversationForUser(conversationId: string, userId: string) {
    const conversation = this.getConversation(conversationId);
    if (!conversation || conversation.ownerUserId !== userId) {
      return null;
    }
    return conversation;
  }

  findByThreadId(threadId: string) {
    return this.listConversations().find((conversation) => conversation.threadId === threadId)
      ?? this.listSessions().find((session) => session.threadId === threadId)
      ?? null;
  }

  async upsertSession(session: SessionRecord) {
    this.sessions.set(session.id, session);
    await this.save();
  }

  async updateSession(sessionId: string, patch: Partial<SessionRecord>) {
    const current = this.getSession(sessionId);
    if (!current) return null;
    const next: SessionRecord = {
      ...current,
      ...patch,
      updatedAt: patch.updatedAt ?? new Date().toISOString(),
    };
    this.sessions.set(sessionId, next);
    await this.save();
    return next;
  }

  async upsertConversation(conversation: ConversationRecord) {
    this.conversations.set(conversation.id, conversation);
    await this.save();
  }

  async updateConversation(conversationId: string, patch: Partial<ConversationRecord>) {
    const current = this.getConversation(conversationId);
    if (!current) return null;
    const next: ConversationRecord = {
      ...current,
      ...patch,
      updatedAt: patch.updatedAt ?? new Date().toISOString(),
    };
    this.conversations.set(conversationId, next);
    await this.save();
    return next;
  }

  async updateOwnerUsername(userId: string, ownerUsername: string) {
    let changed = false;
    const now = new Date().toISOString();

    for (const session of this.sessions.values()) {
      if (session.ownerUserId !== userId || session.ownerUsername === ownerUsername) {
        continue;
      }
      this.sessions.set(session.id, {
        ...session,
        ownerUsername,
        updatedAt: now,
      });
      changed = true;
    }

    for (const conversation of this.conversations.values()) {
      if (conversation.ownerUserId !== userId || conversation.ownerUsername === ownerUsername) {
        continue;
      }
      this.conversations.set(conversation.id, {
        ...conversation,
        ownerUsername,
        updatedAt: now,
      });
      changed = true;
    }

    for (const workspace of this.workspaces.values()) {
      if (workspace.ownerUserId !== userId || workspace.ownerUsername === ownerUsername) {
        continue;
      }
      this.workspaces.set(workspace.id, {
        ...workspace,
        ownerUsername,
        updatedAt: now,
      });
      changed = true;
    }

    for (const [ownerId, attachments] of this.attachments.entries()) {
      const nextAttachments = attachments.map((attachment) => (
        attachment.ownerUserId === userId && attachment.ownerUsername !== ownerUsername
          ? { ...attachment, ownerUsername }
          : attachment
      ));
      if (nextAttachments.some((attachment, index) => attachment !== attachments[index])) {
        this.attachments.set(ownerId, nextAttachments);
        changed = true;
      }
    }

    if (changed) {
      await this.save();
    }
  }

  async deleteSession(sessionId: string) {
    const existed = this.sessions.delete(sessionId);
    this.attachments.delete(sessionId);
    this.approvals.delete(sessionId);
    this.liveEvents.delete(sessionId);
    if (existed) {
      await this.save();
    }
    return existed;
  }

  async deleteConversation(conversationId: string) {
    const existed = this.conversations.delete(conversationId);
    this.attachments.delete(conversationId);
    this.liveEvents.delete(conversationId);
    if (existed) {
      await this.save();
    }
    return existed;
  }

  getApprovals(sessionId: string) {
    return this.approvals.get(sessionId) ?? [];
  }

  getAllApprovals() {
    return [...this.approvals.values()].flat();
  }

  getAllApprovalsForUser(userId: string) {
    return this.getAllApprovals().filter((approval) => this.getSession(approval.sessionId)?.ownerUserId === userId);
  }

  addApproval(approval: PendingApproval) {
    const approvals = this.getApprovals(approval.sessionId);
    this.approvals.set(approval.sessionId, [...approvals, approval]);
  }

  clearApprovals(sessionId: string) {
    this.approvals.delete(sessionId);
  }

  clearAllApprovals() {
    this.approvals.clear();
  }

  removeApproval(sessionId: string, approvalId: string) {
    const approvals = this.getApprovals(sessionId).filter((approval) => approval.id !== approvalId);
    this.approvals.set(sessionId, approvals);
  }

  addLiveEvent(ownerId: string, event: SessionEvent) {
    const current = this.liveEvents.get(ownerId) ?? [];
    const next = [...current, event].slice(-MAX_LIVE_EVENTS);
    this.liveEvents.set(ownerId, next);
  }

  getLiveEvents(ownerId: string) {
    return this.liveEvents.get(ownerId) ?? [];
  }

  clearLiveEvents(ownerId: string) {
    this.liveEvents.delete(ownerId);
  }

  listAttachments(ownerId: string) {
    return [...(this.attachments.get(ownerId) ?? [])].sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  listDraftAttachments(ownerId: string) {
    return this.listAttachments(ownerId).filter((attachment) => !attachment.consumedAt);
  }

  getAttachment(ownerId: string, attachmentId: string) {
    return this.listAttachments(ownerId).find((attachment) => attachment.id === attachmentId) ?? null;
  }

  findAttachmentByPath(ownerId: string, storagePath: string) {
    return this.listAttachments(ownerId).find((attachment) => attachment.storagePath === storagePath) ?? null;
  }

  async addAttachment(attachment: SessionAttachmentRecord) {
    const ownerId = attachment.ownerId ?? attachment.sessionId;
    const current = this.listAttachments(ownerId);
    this.attachments.set(ownerId, [
      ...current,
      {
        ...attachment,
        ownerId,
        sessionId: ownerId,
      },
    ]);
    await this.save();
  }

  async markAttachmentsConsumed(ownerId: string, attachmentIds: string[]) {
    if (attachmentIds.length === 0) return;
    const current = this.listAttachments(ownerId);
    if (current.length === 0) return;
    const now = new Date().toISOString();
    const next = current.map((attachment) => (
      attachmentIds.includes(attachment.id) && !attachment.consumedAt
        ? { ...attachment, consumedAt: now }
        : attachment
    ));
    this.attachments.set(ownerId, next);
    await this.save();
  }

  async removeAttachment(ownerId: string, attachmentId: string) {
    const current = this.listAttachments(ownerId);
    const next = current.filter((attachment) => attachment.id !== attachmentId);
    if (next.length === current.length) {
      return false;
    }
    this.attachments.set(ownerId, next);
    await this.save();
    return true;
  }

  async setStatus(sessionId: string, status: SessionStatus) {
    await this.updateSession(sessionId, { status });
  }

  async markAllStale(reason: string) {
    if (this.sessions.size === 0 && this.conversations.size === 0) return;
    const now = new Date().toISOString();

    for (const session of this.sessions.values()) {
      this.sessions.set(session.id, {
        ...session,
        activeTurnId: null,
        status: 'stale',
        lastIssue: reason,
        networkEnabled: false,
        updatedAt: now,
      });
    }

    for (const conversation of this.conversations.values()) {
      const interrupted = interruptedConversation(conversation);
      this.conversations.set(conversation.id, {
        ...conversation,
        activeTurnId: null,
        status: interrupted ? 'error' : conversation.status === 'stale' ? 'stale' : 'idle',
        recoveryState: 'stale',
        retryable: interrupted,
        lastIssue: interrupted
          ? (conversation.status === 'error' && conversation.lastIssue ? conversation.lastIssue : 'This turn was interrupted before it finished. Send the next prompt to retry.')
          : reason,
        networkEnabled: false,
        updatedAt: now,
      });
    }

    this.clearAllApprovals();
    await this.save();
  }
}
