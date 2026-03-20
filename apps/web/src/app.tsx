import { useEffect, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

import {
  archiveSession,
  connectCloudflareTunnel,
  createSession,
  deleteSession,
  disconnectCloudflareTunnel,
  fetchBootstrap,
  fetchSessionDetail,
  logout,
  restartSession,
  resolveApproval,
  restoreSession,
  startTurn,
} from './api';
import type {
  BootstrapPayload,
  CodexThread,
  CodexThreadItem,
  PendingApproval,
  SessionDetailResponse,
  SessionStatus,
  TranscriptEventKind,
} from './types';

type DetailView = 'transcript' | 'commands' | 'changes' | 'activity';

interface TranscriptEvent {
  kind: TranscriptEventKind;
  body: string;
  markdown: boolean;
}

interface CommandEvent {
  id: string;
  command: string;
  cwd: string;
  status: string;
  exitCode: number | null;
  output: string;
}

interface FileChangeEvent {
  id: string;
  path: string;
  kind: string;
  status: string;
  diff: string | null;
}

const STATUS_LABELS: Record<SessionStatus, string> = {
  running: 'Running',
  'needs-approval': 'Needs approval',
  idle: 'Idle',
  error: 'Error',
  stale: 'Stale',
};

const CLOUDFLARE_STATE_LABELS = {
  idle: 'Idle',
  connecting: 'Connecting',
  connected: 'Connected',
  error: 'Error',
} as const;

function formatTimestamp(value: string) {
  return new Date(value).toLocaleString();
}

function shortThreadId(threadId: string) {
  return threadId.slice(0, 8);
}

function compactWorkspacePath(workspace: string) {
  const parts = workspace.split('/').filter(Boolean);
  if (parts.length <= 2) return workspace;
  return `${parts.slice(-2).join('/')}`;
}

function pickPreferredSessionId(
  sessions: Array<{ id: string; archivedAt: string | null }>,
) {
  return sessions.find((session) => !session.archivedAt)?.id ?? sessions[0]?.id ?? null;
}

function itemToEvent(item: CodexThreadItem): TranscriptEvent | null {
  if (item.type === 'userMessage') {
    return {
      kind: 'user',
      body: item.content
        .filter((entry) => entry.type === 'text')
        .map((entry) => entry.text)
        .join('\n'),
      markdown: true,
    };
  }

  if (item.type === 'agentMessage') {
    return {
      kind: 'assistant',
      body: item.text,
      markdown: true,
    };
  }

  return null;
}

function flattenThread(thread: CodexThread | null) {
  if (!thread) return [];
  return thread.turns.flatMap((turn) =>
    turn.items.flatMap((item) => {
      const event = itemToEvent(item);
      return event ? [event] : [];
    }),
  );
}

function collectCommands(thread: CodexThread | null): CommandEvent[] {
  if (!thread) return [];

  return thread.turns.flatMap((turn) =>
    turn.items.flatMap((item) => {
      if (item.type !== 'commandExecution') {
        return [];
      }

      return [{
        id: item.id,
        command: item.command,
        cwd: item.cwd,
        status: item.status,
        exitCode: item.exitCode,
        output: item.aggregatedOutput || item.status,
      }];
    }),
  );
}

function collectFileChanges(thread: CodexThread | null): FileChangeEvent[] {
  if (!thread) return [];

  return thread.turns.flatMap((turn) =>
    turn.items.flatMap((item) => {
      if (item.type !== 'fileChange') {
        return [];
      }

      return item.changes.map((change, index) => ({
        id: `${item.id}-${change.path}-${index}`,
        path: change.path,
        kind: change.kind?.type ?? 'update',
        status: item.status,
        diff: change.diff ?? null,
      }));
    }),
  );
}

export function App() {
  const [bootstrap, setBootstrap] = useState<BootstrapPayload | null>(null);
  const [detail, setDetail] = useState<SessionDetailResponse | null>(null);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [workspace, setWorkspace] = useState('/Users/richlogic/code/remote-vibe-coding');
  const [title, setTitle] = useState('');
  const [securityProfile, setSecurityProfile] = useState<'repo-write' | 'full-host'>('repo-write');
  const [prompt, setPrompt] = useState('Inspect the current project and summarize what is already implemented.');
  const [busy, setBusy] = useState<string | null>(null);
  const [detailView, setDetailView] = useState<DetailView>('transcript');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [newSessionOpen, setNewSessionOpen] = useState(false);
  const [showArchived, setShowArchived] = useState(false);

  useEffect(() => {
    let cancelled = false;

    async function loadBootstrap() {
      try {
        const next = await fetchBootstrap();
        if (cancelled) return;
        setBootstrap(next);
        setError(null);
        if (!selectedSessionId || !next.sessions.some((session) => session.id === selectedSessionId)) {
          setSelectedSessionId(pickPreferredSessionId(next.sessions));
        }
      } catch (loadError) {
        if (!cancelled) {
          setError(loadError instanceof Error ? loadError.message : 'Unknown error');
        }
      }
    }

    void loadBootstrap();
    const timer = window.setInterval(() => {
      void loadBootstrap();
    }, 2000);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [selectedSessionId]);

  useEffect(() => {
    if (!selectedSessionId) {
      setDetail(null);
      return;
    }

    const currentSessionId = selectedSessionId;
    let cancelled = false;

    async function loadDetail() {
      try {
        const next = await fetchSessionDetail(currentSessionId);
        if (cancelled) return;
        setDetail(next);
        setError(null);
      } catch (loadError) {
        if (!cancelled) {
          setError(loadError instanceof Error ? loadError.message : 'Unknown error');
        }
      }
    }

    void loadDetail();
    const timer = window.setInterval(() => {
      void loadDetail();
    }, 1500);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [selectedSessionId]);

  async function handleCreateSession(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy('create-session');
    try {
      const session = await createSession({
        cwd: workspace,
        securityProfile,
        ...(title.trim() ? { title: title.trim() } : {}),
      });
      setTitle('');
      setNewSessionOpen(false);
      setSelectedSessionId(session.id);
      const nextBootstrap = await fetchBootstrap();
      setBootstrap(nextBootstrap);
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : 'Failed to create session');
    } finally {
      setBusy(null);
    }
  }

  async function handleStartTurn(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedSessionId) return;
    setBusy('start-turn');
    try {
      await startTurn(selectedSessionId, { prompt });
      const nextDetail = await fetchSessionDetail(selectedSessionId);
      setDetail(nextDetail);
    } catch (turnError) {
      setError(turnError instanceof Error ? turnError.message : 'Failed to start turn');
    } finally {
      setBusy(null);
    }
  }

  async function handleRestartSession() {
    if (!selectedSessionId) return;
    setBusy('restart-session');
    try {
      await restartSession(selectedSessionId);
      const [nextBootstrap, nextDetail] = await Promise.all([
        fetchBootstrap(),
        fetchSessionDetail(selectedSessionId),
      ]);
      setBootstrap(nextBootstrap);
      setDetail(nextDetail);
      setError(null);
    } catch (restartError) {
      setError(restartError instanceof Error ? restartError.message : 'Failed to restart session');
    } finally {
      setBusy(null);
    }
  }

  async function handleArchiveToggle(sessionId: string, archived: boolean) {
    setBusy(`${archived ? 'archive' : 'restore'}-${sessionId}`);
    try {
      const session = archived ? await archiveSession(sessionId) : await restoreSession(sessionId);
      const nextBootstrap = await fetchBootstrap();
      setBootstrap(nextBootstrap);

      const nextSelectedSessionId = archived && selectedSessionId === sessionId
        ? pickPreferredSessionId(nextBootstrap.sessions)
        : session.id;

      setSelectedSessionId(nextSelectedSessionId);
      if (nextSelectedSessionId) {
        setDetail(await fetchSessionDetail(nextSelectedSessionId));
      } else {
        setDetail(null);
      }
      setError(null);
    } catch (archiveError) {
      setError(archiveError instanceof Error ? archiveError.message : 'Failed to update session archive state');
    } finally {
      setBusy(null);
    }
  }

  async function handleDeleteSession(sessionId: string) {
    const session = bootstrap?.sessions.find((entry) => entry.id === sessionId);
    if (!session) return;

    const confirmed = window.confirm(`Delete "${session.title}" permanently? This only removes it from remote-vibe-coding.`);
    if (!confirmed) return;

    setBusy(`delete-${sessionId}`);
    try {
      await deleteSession(sessionId);
      const nextBootstrap = await fetchBootstrap();
      setBootstrap(nextBootstrap);

      const nextSelectedSessionId = selectedSessionId === sessionId
        ? pickPreferredSessionId(nextBootstrap.sessions)
        : selectedSessionId;

      setSelectedSessionId(nextSelectedSessionId);
      if (nextSelectedSessionId) {
        setDetail(await fetchSessionDetail(nextSelectedSessionId));
      } else {
        setDetail(null);
      }
      setError(null);
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : 'Failed to delete session');
    } finally {
      setBusy(null);
    }
  }

  async function handleApprovalAction(approval: PendingApproval, decision: 'accept' | 'decline', scope: 'once' | 'session') {
    setBusy(approval.id);
    try {
      await resolveApproval(approval.sessionId, approval.id, { decision, scope });
      const currentSessionId = selectedSessionId;
      if (currentSessionId) {
        const [nextBootstrap, nextDetail] = await Promise.all([
          fetchBootstrap(),
          fetchSessionDetail(currentSessionId),
        ]);
        setBootstrap(nextBootstrap);
        setDetail(nextDetail);
      }
    } catch (approvalError) {
      setError(approvalError instanceof Error ? approvalError.message : 'Failed to resolve approval');
    } finally {
      setBusy(null);
    }
  }

  async function handleConnectCloudflare() {
    setBusy('connect-cloudflare');
    try {
      await connectCloudflareTunnel();
      setBootstrap(await fetchBootstrap());
      setError(null);
    } catch (connectError) {
      setError(connectError instanceof Error ? connectError.message : 'Failed to connect Cloudflare tunnel');
    } finally {
      setBusy(null);
    }
  }

  async function handleDisconnectCloudflare() {
    setBusy('disconnect-cloudflare');
    try {
      await disconnectCloudflareTunnel();
      setBootstrap(await fetchBootstrap());
      setError(null);
    } catch (disconnectError) {
      setError(disconnectError instanceof Error ? disconnectError.message : 'Failed to disconnect Cloudflare tunnel');
    } finally {
      setBusy(null);
    }
  }

  async function handleLogout() {
    setBusy('logout');
    try {
      await logout();
    } finally {
      window.location.href = '/login';
    }
  }

  const threadEvents = flattenThread(detail?.thread ?? null);
  const commandEvents = collectCommands(detail?.thread ?? null);
  const fileChanges = collectFileChanges(detail?.thread ?? null);
  const cloudflare = bootstrap?.cloudflare;
  const cloudflareManagedBySystem = cloudflare?.activeSource === 'system';
  const cloudflareManagedLocally = cloudflare?.activeSource === 'local-manager';
  const sessionIsStale = detail?.session.status === 'stale';
  const sessionIsArchived = Boolean(detail?.session.archivedAt);
  const threadStatus = detail?.thread?.status && typeof detail.thread.status === 'object' ? detail.thread.status.type : 'idle';
  const sessionGitLabel = detail?.thread?.gitInfo?.branch
    ? `${detail.thread.gitInfo.branch}${detail.thread.gitInfo.sha ? ` @ ${detail.thread.gitInfo.sha.slice(0, 7)}` : ''}`
    : 'No git metadata';
  const activeSessions = (bootstrap?.sessions ?? []).filter((session) => !session.archivedAt);
  const archivedSessions = (bootstrap?.sessions ?? []).filter((session) => Boolean(session.archivedAt));

  if (error && !bootstrap) {
    return (
      <main className="shell shell-error">
        <section className="error-card">
          <p className="eyebrow">Host unavailable</p>
          <h1>Could not reach the local host service</h1>
          <p>{error}</p>
          <p>Start <code>npm run dev:host</code> and refresh the page.</p>
        </section>
      </main>
    );
  }

  return (
    <main className="shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">Codex-first remote coding</p>
          <h1>{bootstrap?.productName ?? 'remote-vibe-coding'}</h1>
        </div>
        <div className="topbar-meta">
          <span>{activeSessions.length} active</span>
          {archivedSessions.length > 0 ? <span>{archivedSessions.length} archived</span> : null}
          <span>{bootstrap?.approvals.length ?? 0} approvals</span>
          <button type="button" className="button-secondary topbar-button" onClick={() => setSettingsOpen(true)}>
            Settings
          </button>
        </div>
      </header>

      <section className="workspace">
        <aside className="panel rail">
          <div className="panel-header rail-header">
            <div>
              <p className="eyebrow">Sessions</p>
              <h2>Existing work</h2>
            </div>
            <div className="rail-actions">
              {archivedSessions.length > 0 ? (
                <button type="button" className="button-secondary" onClick={() => setShowArchived((value) => !value)}>
                  {showArchived ? 'Hide archived' : `Archived (${archivedSessions.length})`}
                </button>
              ) : null}
              <button type="button" onClick={() => setNewSessionOpen(true)} disabled={busy === 'create-session'}>
                New session
              </button>
            </div>
          </div>

          <ul className="session-list">
            {activeSessions.length === 0 ? (
              <li className="session-empty">No active sessions yet.</li>
            ) : activeSessions.map((session) => (
              <li
                key={session.id}
                className={`session-card ${selectedSessionId === session.id ? 'session-card-active' : ''}`}
                onClick={() => setSelectedSessionId(session.id)}
              >
                <div className="session-row session-card-head">
                  <h3>{session.title}</h3>
                  <span className={`status-pill status-${session.status}`}>{STATUS_LABELS[session.status]}</span>
                </div>
                <p className="session-workspace">{compactWorkspacePath(session.workspace)}</p>
                <div className="session-row session-foot">
                  <span>{session.lastUpdate}</span>
                  {session.pendingApprovalCount > 0 ? <span>{session.pendingApprovalCount} approval</span> : null}
                </div>
                {selectedSessionId === session.id ? (
                  <div className="session-actions" onClick={(event) => event.stopPropagation()}>
                    <button
                      type="button"
                      className="button-secondary"
                      onClick={() => void handleArchiveToggle(session.id, true)}
                      disabled={busy === `archive-${session.id}`}
                    >
                      {busy === `archive-${session.id}` ? 'Archiving...' : 'Archive'}
                    </button>
                    <button
                      type="button"
                      className="button-danger"
                      onClick={() => void handleDeleteSession(session.id)}
                      disabled={busy === `delete-${session.id}`}
                    >
                      {busy === `delete-${session.id}` ? 'Deleting...' : 'Delete'}
                    </button>
                  </div>
                ) : null}
              </li>
            ))}
          </ul>

          {showArchived && archivedSessions.length > 0 ? (
            <>
              <div className="rail-subhead">
                <p className="eyebrow">Archived</p>
                <h2>History</h2>
              </div>
              <ul className="session-list archived-session-list">
                {archivedSessions.map((session) => (
                  <li
                    key={session.id}
                    className={`session-card session-card-archived ${selectedSessionId === session.id ? 'session-card-active' : ''}`}
                    onClick={() => setSelectedSessionId(session.id)}
                  >
                    <div className="session-row session-card-head">
                      <h3>{session.title}</h3>
                      <span className="status-pill status-idle">Archived</span>
                    </div>
                    <p className="session-workspace">{compactWorkspacePath(session.workspace)}</p>
                    <div className="session-row session-foot">
                      <span>Archived session</span>
                      <span>{session.lastUpdate}</span>
                    </div>
                    {selectedSessionId === session.id ? (
                      <div className="session-actions" onClick={(event) => event.stopPropagation()}>
                        <button
                          type="button"
                          className="button-secondary"
                          onClick={() => void handleArchiveToggle(session.id, false)}
                          disabled={busy === `restore-${session.id}`}
                        >
                          {busy === `restore-${session.id}` ? 'Restoring...' : 'Restore'}
                        </button>
                        <button
                          type="button"
                          className="button-danger"
                          onClick={() => void handleDeleteSession(session.id)}
                          disabled={busy === `delete-${session.id}`}
                        >
                          {busy === `delete-${session.id}` ? 'Deleting...' : 'Delete'}
                        </button>
                      </div>
                    ) : null}
                  </li>
                ))}
              </ul>
            </>
          ) : null}
        </aside>

        <section className="panel transcript">
          <div className="panel-header">
            <p className="eyebrow">Coding-first surface</p>
            <h2>{detail?.session.title ?? 'Select or create a session'}</h2>
          </div>

          {detail ? (
            <div className="transcript-layout">
              <div className="transcript-scroll">
                <div className="view-tabs">
                  <button type="button" className={detailView === 'transcript' ? 'view-tab view-tab-active' : 'view-tab'} onClick={() => setDetailView('transcript')}>
                    Transcript
                  </button>
                  <button type="button" className={detailView === 'commands' ? 'view-tab view-tab-active' : 'view-tab'} onClick={() => setDetailView('commands')}>
                    Commands {commandEvents.length > 0 ? `(${commandEvents.length})` : ''}
                  </button>
                  <button type="button" className={detailView === 'changes' ? 'view-tab view-tab-active' : 'view-tab'} onClick={() => setDetailView('changes')}>
                    Changes {fileChanges.length > 0 ? `(${fileChanges.length})` : ''}
                  </button>
                  <button type="button" className={detailView === 'activity' ? 'view-tab view-tab-active' : 'view-tab'} onClick={() => setDetailView('activity')}>
                    Activity {detail.liveEvents.length > 0 ? `(${detail.liveEvents.length})` : ''}
                  </button>
                </div>

                {sessionIsArchived ? (
                  <section className="runtime-alert runtime-alert-muted">
                    <div>
                      <p className="eyebrow">Archived session</p>
                      <h3>This session is in history mode</h3>
                      <p>Restore it if you want to continue prompting in the same workspace.</p>
                    </div>
                    <button
                      type="button"
                      onClick={() => detail && void handleArchiveToggle(detail.session.id, false)}
                      disabled={!detail || busy === `restore-${detail.session.id}`}
                    >
                      {!detail || busy !== `restore-${detail.session.id}` ? 'Restore session' : 'Restoring...'}
                    </button>
                  </section>
                ) : sessionIsStale ? (
                  <section className="runtime-alert">
                    <div>
                      <p className="eyebrow">Runtime reset detected</p>
                      <h3>Codex no longer has this thread loaded</h3>
                      <p>{detail.session.lastIssue ?? 'Restart this session to create a fresh thread in the same workspace.'}</p>
                    </div>
                    <button
                      type="button"
                      onClick={() => void handleRestartSession()}
                      disabled={busy === 'restart-session'}
                    >
                      {busy === 'restart-session' ? 'Restarting...' : 'Restart session'}
                    </button>
                  </section>
                ) : null}

                {detailView !== 'transcript' ? (
                  <>
                    <div className="detail-meta">
                      <span>{detail.session.workspace}</span>
                      <span>{detail.session.securityProfile}</span>
                      <span>{detail.session.networkEnabled ? 'Network enabled' : 'Network disabled'}</span>
                      <span>{sessionIsStale ? 'stale session' : threadStatus}</span>
                    </div>

                    <section className="detail-summary-grid">
                      <article className="summary-card">
                        <p className="eyebrow">Session</p>
                        <strong>{detail.session.title}</strong>
                        <p>{detail.session.workspace}</p>
                      </article>
                      <article className="summary-card">
                        <p className="eyebrow">Thread</p>
                        <strong>{shortThreadId(detail.session.threadId)}</strong>
                        <p>{detail.thread?.path ?? 'Fresh thread or not yet loaded'}</p>
                      </article>
                      <article className="summary-card">
                        <p className="eyebrow">Git</p>
                        <strong>{sessionGitLabel}</strong>
                        <p>{detail.thread?.gitInfo?.originUrl ?? 'No remote reported yet'}</p>
                      </article>
                      <article className="summary-card">
                        <p className="eyebrow">Runtime</p>
                        <strong>{detail.thread?.modelProvider ?? 'codex'}</strong>
                        <p>
                          {detail.thread?.source ?? 'local host'}
                          {detail.thread?.cliVersion ? ` · CLI ${detail.thread.cliVersion}` : ''}
                        </p>
                      </article>
                    </section>
                  </>
                ) : null}

                {detailView === 'transcript' ? (
                  <div className="chat-list">
                    {threadEvents.length === 0 ? (
                      <article className="event-card event-status">
                        <div className="event-meta">
                          <span>Status</span>
                          <strong>{sessionIsStale ? 'Thread unavailable' : 'No turns yet'}</strong>
                        </div>
                        <p>
                          {sessionIsStale
                            ? 'This session needs a fresh thread before it can accept a new prompt.'
                            : 'Start the first prompt from the composer below.'}
                        </p>
                      </article>
                    ) : (
                      threadEvents.map((event, index) => (
                        <article key={`${event.kind}-${index}`} className={`chat-message chat-${event.kind}`}>
                          {event.markdown ? (
                            <div className="markdown-body chat-body">
                              <ReactMarkdown remarkPlugins={[remarkGfm]}>
                                {event.body}
                              </ReactMarkdown>
                            </div>
                          ) : (
                            <pre className="event-body">{event.body}</pre>
                          )}
                        </article>
                      ))
                    )}
                  </div>
                ) : null}

                {detailView === 'commands' ? (
                  <div className="detail-list">
                    {commandEvents.length === 0 ? (
                      <article className="detail-card">
                        <strong>No command executions yet</strong>
                        <p>Command output from Codex will land here once the thread starts using tools.</p>
                      </article>
                    ) : (
                      commandEvents.map((command) => (
                        <article key={command.id} className="detail-card">
                          <div className="detail-card-head">
                            <strong>{command.command}</strong>
                            <span>{command.status}{command.exitCode !== null ? ` · exit ${command.exitCode}` : ''}</span>
                          </div>
                          <p className="detail-card-meta">{command.cwd}</p>
                          <pre className="event-body">{command.output}</pre>
                        </article>
                      ))
                    )}
                  </div>
                ) : null}

                {detailView === 'changes' ? (
                  <div className="detail-list">
                    {fileChanges.length === 0 ? (
                      <article className="detail-card">
                        <strong>No file changes yet</strong>
                        <p>When Codex proposes edits, this view will show paths and inline diffs.</p>
                      </article>
                    ) : (
                      fileChanges.map((change) => (
                        <article key={change.id} className="detail-card">
                          <div className="detail-card-head">
                            <strong>{change.path}</strong>
                            <span>{change.kind} · {change.status}</span>
                          </div>
                          {change.diff ? <pre className="event-body">{change.diff}</pre> : <p className="detail-card-meta">No inline diff payload was reported for this change.</p>}
                        </article>
                      ))
                    )}
                  </div>
                ) : null}

                {detailView === 'activity' ? (
                  <div className="detail-list">
                    <article className="detail-card">
                      <div className="detail-card-head">
                        <strong>Session state</strong>
                        <span>{detail.session.status}</span>
                      </div>
                      <p className="detail-card-meta">Created {formatTimestamp(detail.session.createdAt)}</p>
                      <p className="detail-card-meta">Updated {formatTimestamp(detail.session.updatedAt)}</p>
                      {detail.session.lastIssue ? <p>{detail.session.lastIssue}</p> : null}
                    </article>

                    <article className="detail-card">
                      <div className="detail-card-head">
                        <strong>Live host events</strong>
                        <span>{detail.liveEvents.length}</span>
                      </div>
                      {detail.liveEvents.length === 0 ? (
                        <p className="detail-card-meta">No transport events captured yet.</p>
                      ) : (
                        <div className="activity-stream">
                          {detail.liveEvents.map((event) => (
                            <div key={event.id} className="live-event-row">
                              <strong>{event.method}</strong>
                              <span>{event.summary}</span>
                            </div>
                          ))}
                        </div>
                      )}
                    </article>
                  </div>
                ) : null}
              </div>

              <form className="composer-form composer-docked" onSubmit={handleStartTurn}>
                <label className="field">
                  <span>Prompt</span>
                  <textarea
                    value={prompt}
                    onChange={(event) => setPrompt(event.target.value)}
                    rows={5}
                    disabled={sessionIsStale || sessionIsArchived}
                  />
                </label>
                <button type="submit" disabled={busy === 'start-turn' || sessionIsStale || sessionIsArchived}>
                  {sessionIsArchived ? 'Restore required' : sessionIsStale ? 'Restart required' : busy === 'start-turn' ? 'Sending...' : 'Send prompt'}
                </button>
              </form>
            </div>
          ) : (
            <section className="empty-state">
              <p className="eyebrow">No active selection</p>
              <h2>Pick an existing session, or use the New session button to start a fresh Codex thread.</h2>
            </section>
          )}
        </section>

        <aside className="panel approvals">
          <div className="panel-header">
            <p className="eyebrow">Approval center</p>
            <h2>{detail?.approvals.length ?? bootstrap?.approvals.length ?? 0} pending request(s)</h2>
          </div>
          <div className="approval-list">
            {(detail?.approvals ?? []).length === 0 ? (
              <article className="approval-card">
                <div className="approval-head">
                  <strong>No pending approvals</strong>
                  <span>codex</span>
                </div>
                <p>Network, extra file access, and high-risk commands will appear here when Codex requests them.</p>
              </article>
            ) : (
              detail?.approvals.map((approval) => (
                <article key={approval.id} className="approval-card">
                  <div className="approval-head">
                    <strong>{approval.title}</strong>
                    <span>{approval.source}</span>
                  </div>
                  <p>{approval.risk}</p>
                  <div className="approval-actions">
                    <button type="button" onClick={() => void handleApprovalAction(approval, 'accept', 'once')} disabled={busy === approval.id}>
                      Approve once
                    </button>
                    <button type="button" onClick={() => void handleApprovalAction(approval, 'accept', 'session')} disabled={busy === approval.id}>
                      Approve session
                    </button>
                    <button type="button" className="button-secondary" onClick={() => void handleApprovalAction(approval, 'decline', 'once')} disabled={busy === approval.id}>
                      Decline
                    </button>
                  </div>
                </article>
              ))
            )}
          </div>
        </aside>
      </section>

      {settingsOpen ? (
        <div className="settings-overlay" onClick={() => setSettingsOpen(false)}>
          <aside className="settings-sheet" onClick={(event) => event.stopPropagation()}>
            <div className="panel-header settings-header">
              <div>
                <p className="eyebrow">Settings</p>
                <h2>System information and controls</h2>
              </div>
              <button type="button" className="button-secondary topbar-button" onClick={() => setSettingsOpen(false)}>
                Close
              </button>
            </div>

            <section className="detail-summary-grid">
              <article className="summary-card">
                <p className="eyebrow">Product</p>
                <strong>{bootstrap?.productName ?? 'remote-vibe-coding'}</strong>
                <p>{bootstrap?.subtitle ?? 'Codex-first browser shell'}</p>
              </article>
              <article className="summary-card">
                <p className="eyebrow">Defaults</p>
                <strong>{bootstrap?.defaults.defaultSecurityProfile ?? 'repo-write'}</strong>
                <p>{bootstrap?.defaults.networkEnabledByDefault ? 'Network on by default' : 'Network off by default'}</p>
              </article>
              <article className="summary-card">
                <p className="eyebrow">Current session</p>
                <strong>{detail?.session.title ?? 'No active session'}</strong>
                <p>{detail?.session.workspace ?? 'Select a session to inspect its workspace.'}</p>
              </article>
              <article className="summary-card">
                <p className="eyebrow">Remote access</p>
                <strong>{cloudflare ? `${CLOUDFLARE_STATE_LABELS[cloudflare.state]} tunnel` : 'Tunnel status unavailable'}</strong>
                <p>{cloudflare?.publicUrl ?? cloudflare?.targetUrl ?? 'No public URL available yet'}</p>
              </article>
            </section>

            <section className="settings-section">
              <div className="settings-section-head">
                <strong>Cloudflare</strong>
                <span>{cloudflare?.mode ?? 'not connected'}</span>
              </div>
              <p className="detail-card-meta">
                {cloudflare?.installed
                  ? `Targeting ${cloudflare.targetUrl} from ${cloudflare.targetSource}.`
                  : 'cloudflared is not installed on this machine yet.'}
              </p>
              {cloudflare?.publicUrl ? (
                <p className="remote-access-url">
                  <a href={cloudflare.publicUrl} target="_blank" rel="noreferrer">
                    {cloudflare.publicUrl}
                  </a>
                </p>
              ) : null}
              {cloudflare?.lastError ? <p className="remote-access-error">{cloudflare.lastError}</p> : null}
              <div className="remote-button-row">
                <button
                  type="button"
                  onClick={() => void handleConnectCloudflare()}
                  disabled={!cloudflare?.installed || busy === 'connect-cloudflare' || cloudflare?.state === 'connecting' || cloudflareManagedBySystem}
                >
                  {cloudflareManagedBySystem
                    ? 'Tunnel already live'
                    : busy === 'connect-cloudflare' || cloudflare?.state === 'connecting'
                      ? 'Connecting...'
                      : 'Connect tunnel'}
                </button>
                <button
                  type="button"
                  className="button-secondary"
                  onClick={() => void handleDisconnectCloudflare()}
                  disabled={!cloudflare?.installed || !cloudflareManagedLocally || busy === 'disconnect-cloudflare'}
                >
                  {cloudflareManagedBySystem
                    ? 'Managed by system'
                    : busy === 'disconnect-cloudflare'
                      ? 'Disconnecting...'
                      : 'Disconnect'}
                </button>
              </div>
            </section>

            <section className="settings-section">
              <div className="settings-section-head">
                <strong>Account</strong>
                <span>{bootstrap?.defaults.executor ?? 'codex'}</span>
              </div>
              <p className="detail-card-meta">Use this panel for machine-level controls. Keep the main screen focused on session management and chat.</p>
              <button type="button" className="button-secondary settings-signout" onClick={() => void handleLogout()} disabled={busy === 'logout'}>
                {busy === 'logout' ? 'Signing out...' : 'Sign out'}
              </button>
            </section>
          </aside>
        </div>
      ) : null}

      {newSessionOpen ? (
        <div className="modal-overlay" onClick={() => setNewSessionOpen(false)}>
          <div className="modal-card" onClick={(event) => event.stopPropagation()}>
            <div className="panel-header settings-header">
              <div>
                <p className="eyebrow">New session</p>
                <h2>Create a workspace thread</h2>
              </div>
              <button type="button" className="button-secondary topbar-button" onClick={() => setNewSessionOpen(false)}>
                Close
              </button>
            </div>

            <form className="create-form" onSubmit={handleCreateSession}>
              <label className="field">
                <span>Workspace</span>
                <input value={workspace} onChange={(event) => setWorkspace(event.target.value)} />
              </label>
              <label className="field">
                <span>Title</span>
                <input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Optional session title" />
              </label>
              <label className="field">
                <span>Security profile</span>
                <select value={securityProfile} onChange={(event) => setSecurityProfile(event.target.value as 'repo-write' | 'full-host')}>
                  <option value="repo-write">repo-write</option>
                  <option value="full-host">full-host</option>
                </select>
              </label>
              <button type="submit" disabled={busy === 'create-session'}>
                {busy === 'create-session' ? 'Creating...' : 'Create session'}
              </button>
            </form>
          </div>
        </div>
      ) : null}
    </main>
  );
}
