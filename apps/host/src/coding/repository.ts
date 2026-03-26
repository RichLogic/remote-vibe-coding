import {
  MongoServerError,
  type Collection,
  type Db,
} from 'mongodb';

import type {
  SessionRecord,
  SessionStatus,
  WorkspaceRecord,
} from '../types.js';

interface CodingWorkspaceDocument {
  _id: string;
  ownerUserId: string;
  ownerUsername: string;
  name: string;
  path: string;
  visible: boolean;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

interface CodingSessionDocument {
  _id: string;
  ownerUserId: string;
  ownerUsername: string;
  executor: SessionRecord['executor'];
  workspaceId: string;
  threadId: string;
  activeTurnId: string | null;
  title: string;
  autoTitle: boolean;
  workspace: string;
  archivedAt: string | null;
  securityProfile: SessionRecord['securityProfile'];
  approvalMode: SessionRecord['approvalMode'];
  networkEnabled: boolean;
  fullHostEnabled: boolean;
  status: SessionStatus;
  lastIssue: string | null;
  hasTranscript: boolean;
  model: string | null;
  reasoningEffort: SessionRecord['reasoningEffort'];
  createdAt: string;
  updatedAt: string;
}

function asWorkspaceRecord(document: CodingWorkspaceDocument): WorkspaceRecord {
  return {
    id: document._id,
    ownerUserId: document.ownerUserId,
    ownerUsername: document.ownerUsername,
    name: document.name,
    path: document.path,
    visible: document.visible,
    sortOrder: document.sortOrder,
    createdAt: document.createdAt,
    updatedAt: document.updatedAt,
  };
}

function asSessionRecord(document: CodingSessionDocument): SessionRecord {
  return {
    id: document._id,
    ownerUserId: document.ownerUserId,
    ownerUsername: document.ownerUsername,
    sessionType: 'code',
    executor: document.executor ?? 'codex',
    workspaceId: document.workspaceId,
    threadId: document.threadId,
    activeTurnId: document.activeTurnId,
    title: document.title,
    autoTitle: document.autoTitle,
    workspace: document.workspace,
    archivedAt: document.archivedAt,
    securityProfile: document.securityProfile,
    approvalMode: document.approvalMode,
    networkEnabled: document.networkEnabled,
    fullHostEnabled: document.fullHostEnabled,
    status: document.status,
    lastIssue: document.lastIssue,
    hasTranscript: document.hasTranscript,
    model: document.model,
    reasoningEffort: document.reasoningEffort,
    createdAt: document.createdAt,
    updatedAt: document.updatedAt,
  };
}

function isDuplicateKeyError(error: unknown) {
  return error instanceof MongoServerError && error.code === 11000;
}

export class CodingRepository {
  private readonly workspaces: Collection<CodingWorkspaceDocument>;
  private readonly sessions: Collection<CodingSessionDocument>;

  constructor(db: Db) {
    this.workspaces = db.collection<CodingWorkspaceDocument>('coding_workspaces');
    this.sessions = db.collection<CodingSessionDocument>('coding_sessions');
  }

  async ensureIndexes() {
    await this.workspaces.createIndex({ ownerUserId: 1, sortOrder: 1, createdAt: 1 });
    await this.workspaces.createIndex({ ownerUserId: 1, path: 1 }, { unique: true });
    await this.sessions.createIndex({ ownerUserId: 1, workspaceId: 1, updatedAt: -1 });
    await this.sessions.createIndex({ threadId: 1 }, { unique: true });
    await this.sessions.createIndex({ ownerUserId: 1, updatedAt: -1 });
  }

  async listWorkspacesForUser(userId: string) {
    const documents = await this.workspaces
      .find({ ownerUserId: userId })
      .sort({ sortOrder: 1, createdAt: 1 })
      .toArray();
    return documents.map(asWorkspaceRecord);
  }

  async getWorkspace(workspaceId: string) {
    const document = await this.workspaces.findOne({ _id: workspaceId });
    return document ? asWorkspaceRecord(document) : null;
  }

  async getWorkspaceForUser(workspaceId: string, userId: string) {
    const document = await this.workspaces.findOne({ _id: workspaceId, ownerUserId: userId });
    return document ? asWorkspaceRecord(document) : null;
  }

  async findWorkspaceByPathForUser(userId: string, path: string) {
    const document = await this.workspaces.findOne({ ownerUserId: userId, path });
    return document ? asWorkspaceRecord(document) : null;
  }

  async createWorkspace(record: WorkspaceRecord) {
    const next: CodingWorkspaceDocument = {
      _id: record.id,
      ownerUserId: record.ownerUserId,
      ownerUsername: record.ownerUsername,
      name: record.name,
      path: record.path,
      visible: record.visible,
      sortOrder: record.sortOrder,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    };

    try {
      await this.workspaces.insertOne(next);
    } catch (error) {
      if (isDuplicateKeyError(error)) {
        throw new Error('Workspace already exists.');
      }
      throw error;
    }

    return asWorkspaceRecord(next);
  }

  async updateWorkspace(workspaceId: string, patch: Partial<WorkspaceRecord>) {
    const current = await this.getWorkspace(workspaceId);
    if (!current) {
      return null;
    }

    const next: WorkspaceRecord = {
      ...current,
      ...patch,
      id: current.id,
      ownerUserId: current.ownerUserId,
      ownerUsername: patch.ownerUsername ?? current.ownerUsername,
      path: patch.path ?? current.path,
      createdAt: current.createdAt,
      updatedAt: patch.updatedAt ?? new Date().toISOString(),
    };

    await this.workspaces.updateOne(
      { _id: workspaceId },
      {
        $set: {
          ownerUsername: next.ownerUsername,
          name: next.name,
          path: next.path,
          visible: next.visible,
          sortOrder: next.sortOrder,
          updatedAt: next.updatedAt,
        },
      },
    );

    return next;
  }

  async reorderWorkspaces(userId: string, workspaceIds: string[]) {
    const now = new Date().toISOString();
    await Promise.all(workspaceIds.map((workspaceId, index) => (
      this.workspaces.updateOne(
        { _id: workspaceId, ownerUserId: userId },
        {
          $set: {
            sortOrder: index,
            updatedAt: now,
          },
        },
      )
    )));
    return this.listWorkspacesForUser(userId);
  }

  async listSessionsForUser(userId: string) {
    const documents = await this.sessions
      .find({ ownerUserId: userId })
      .sort({ updatedAt: -1 })
      .toArray();
    return documents.map(asSessionRecord);
  }

  async getSession(sessionId: string) {
    const document = await this.sessions.findOne({ _id: sessionId });
    return document ? asSessionRecord(document) : null;
  }

  async getSessionForUser(sessionId: string, userId: string) {
    const document = await this.sessions.findOne({ _id: sessionId, ownerUserId: userId });
    return document ? asSessionRecord(document) : null;
  }

  async findSessionByThreadId(threadId: string) {
    const document = await this.sessions.findOne({ threadId });
    return document ? asSessionRecord(document) : null;
  }

  async upsertSession(record: SessionRecord) {
    await this.sessions.updateOne(
      { _id: record.id },
      {
        $setOnInsert: {
          _id: record.id,
          createdAt: record.createdAt,
        },
        $set: {
          ownerUserId: record.ownerUserId,
          ownerUsername: record.ownerUsername,
          executor: record.executor,
          workspaceId: record.workspaceId,
          threadId: record.threadId,
          activeTurnId: record.activeTurnId,
          title: record.title,
          autoTitle: record.autoTitle,
          workspace: record.workspace,
          archivedAt: record.archivedAt,
          securityProfile: record.securityProfile,
          approvalMode: record.approvalMode,
          networkEnabled: record.networkEnabled,
          fullHostEnabled: record.fullHostEnabled,
          status: record.status,
          lastIssue: record.lastIssue,
          hasTranscript: record.hasTranscript,
          model: record.model,
          reasoningEffort: record.reasoningEffort,
          updatedAt: record.updatedAt,
        },
      },
      { upsert: true },
    );
    return this.getSession(record.id);
  }

  async updateSession(sessionId: string, patch: Partial<SessionRecord>) {
    const current = await this.getSession(sessionId);
    if (!current) {
      return null;
    }

    const next: SessionRecord = {
      ...current,
      ...patch,
      id: current.id,
      sessionType: 'code',
      ownerUserId: current.ownerUserId,
      createdAt: current.createdAt,
      updatedAt: patch.updatedAt ?? new Date().toISOString(),
    };

    await this.upsertSession(next);
    return next;
  }

  async deleteSession(sessionId: string) {
    const result = await this.sessions.deleteOne({ _id: sessionId });
    return result.deletedCount > 0;
  }

  async countSessionsForUser(userId: string) {
    return this.sessions.countDocuments({ ownerUserId: userId });
  }

  async countSessionsForWorkspace(userId: string, workspaceId: string) {
    return this.sessions.countDocuments({ ownerUserId: userId, workspaceId });
  }

  async updateOwnerUsername(userId: string, ownerUsername: string) {
    const now = new Date().toISOString();
    await Promise.all([
      this.workspaces.updateMany(
        { ownerUserId: userId },
        {
          $set: {
            ownerUsername,
            updatedAt: now,
          },
        },
      ),
      this.sessions.updateMany(
        { ownerUserId: userId },
        {
          $set: {
            ownerUsername,
            updatedAt: now,
          },
        },
      ),
    ]);
  }

  async markAllStale(reason: string) {
    await this.sessions.updateMany(
      {},
      {
        $set: {
          activeTurnId: null,
          status: 'stale',
          lastIssue: reason,
          networkEnabled: false,
          updatedAt: new Date().toISOString(),
        },
      },
    );
  }
}
