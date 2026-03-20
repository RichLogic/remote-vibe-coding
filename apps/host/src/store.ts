import { readFile, writeFile } from 'node:fs/promises';

import { ensureDataDir, SESSIONS_FILE } from './config.js';
import type {
  PendingApproval,
  ReasoningEffort,
  SessionEvent,
  SessionRecord,
  SessionStatus,
  SessionType,
  SecurityProfile,
} from './types.js';

interface PersistedState {
  sessions: SessionRecord[];
}

interface LegacySessionRecord {
  id: string;
  threadId: string;
  title: string;
  workspace: string;
  archivedAt?: string | null;
  securityProfile?: SecurityProfile;
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

const MAX_LIVE_EVENTS = 200;

export class SessionStore {
  private readonly sessions = new Map<string, SessionRecord>();
  private readonly approvals = new Map<string, PendingApproval[]>();
  private readonly liveEvents = new Map<string, SessionEvent[]>();

  async load(options: LoadOptions) {
    await ensureDataDir();
    try {
      const raw = await readFile(SESSIONS_FILE, 'utf8');
      const parsed = JSON.parse(raw) as PersistedState;
      for (const session of parsed.sessions ?? []) {
        const legacy = session as LegacySessionRecord;
        this.sessions.set(legacy.id, {
          id: legacy.id,
          ownerUserId: legacy.ownerUserId ?? options.fallbackOwnerUserId,
          ownerUsername: legacy.ownerUsername ?? options.fallbackOwnerUsername,
          sessionType: legacy.sessionType ?? 'code',
          threadId: legacy.threadId,
          activeTurnId: null,
          title: legacy.title,
          workspace: legacy.workspace,
          archivedAt: legacy.archivedAt ?? null,
          securityProfile: legacy.securityProfile ?? 'repo-write',
          networkEnabled: Boolean(legacy.networkEnabled),
          fullHostEnabled: Boolean(legacy.fullHostEnabled),
          status: legacy.status ?? 'idle',
          lastIssue: legacy.lastIssue ?? null,
          model: legacy.model ?? null,
          reasoningEffort: legacy.reasoningEffort ?? null,
          createdAt: legacy.createdAt,
          updatedAt: legacy.updatedAt,
        });
      }
    } catch {
      // Fresh repo, nothing to load yet.
    }
  }

  async save() {
    await ensureDataDir();
    const state: PersistedState = {
      sessions: this.listSessions(),
    };
    await writeFile(SESSIONS_FILE, JSON.stringify(state, null, 2));
  }

  listSessions() {
    return [...this.sessions.values()].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  listSessionsForUser(userId: string) {
    return this.listSessions().filter((session) => session.ownerUserId === userId);
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

  findByThreadId(threadId: string) {
    return this.listSessions().find((session) => session.threadId === threadId) ?? null;
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

  async updateOwnerUsername(userId: string, ownerUsername: string) {
    let changed = false;
    for (const session of this.sessions.values()) {
      if (session.ownerUserId !== userId || session.ownerUsername === ownerUsername) {
        continue;
      }
      this.sessions.set(session.id, {
        ...session,
        ownerUsername,
        updatedAt: new Date().toISOString(),
      });
      changed = true;
    }

    if (changed) {
      await this.save();
    }
  }

  async deleteSession(sessionId: string) {
    const existed = this.sessions.delete(sessionId);
    this.approvals.delete(sessionId);
    this.liveEvents.delete(sessionId);
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

  addLiveEvent(sessionId: string, event: SessionEvent) {
    const current = this.liveEvents.get(sessionId) ?? [];
    const next = [...current, event].slice(-MAX_LIVE_EVENTS);
    this.liveEvents.set(sessionId, next);
  }

  getLiveEvents(sessionId: string) {
    return this.liveEvents.get(sessionId) ?? [];
  }

  clearLiveEvents(sessionId: string) {
    this.liveEvents.delete(sessionId);
  }

  async setStatus(sessionId: string, status: SessionStatus) {
    await this.updateSession(sessionId, { status });
  }

  async markAllStale(reason: string) {
    if (this.sessions.size === 0) return;

    for (const session of this.sessions.values()) {
      this.sessions.set(session.id, {
        ...session,
        activeTurnId: null,
        status: 'stale',
        lastIssue: reason,
        networkEnabled: false,
        updatedAt: new Date().toISOString(),
      });
    }
    this.clearAllApprovals();
    await this.save();
  }
}
