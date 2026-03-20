import { readFile, writeFile } from 'node:fs/promises';

import { ensureDataDir, SESSIONS_FILE } from './config.js';
import type {
  PendingApproval,
  SessionEvent,
  SessionRecord,
  SessionStatus,
} from './types.js';

interface PersistedState {
  sessions: SessionRecord[];
}

const MAX_LIVE_EVENTS = 200;

export class SessionStore {
  private readonly sessions = new Map<string, SessionRecord>();
  private readonly approvals = new Map<string, PendingApproval[]>();
  private readonly liveEvents = new Map<string, SessionEvent[]>();

  async load() {
    await ensureDataDir();
    try {
      const raw = await readFile(SESSIONS_FILE, 'utf8');
      const parsed = JSON.parse(raw) as PersistedState;
      for (const session of parsed.sessions ?? []) {
        this.sessions.set(session.id, session);
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

  getSession(sessionId: string) {
    return this.sessions.get(sessionId) ?? null;
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

  getApprovals(sessionId: string) {
    return this.approvals.get(sessionId) ?? [];
  }

  getAllApprovals() {
    return [...this.approvals.values()].flat();
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
