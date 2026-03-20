import { useEffect, useState } from 'react';

import {
  connectCloudflareTunnel,
  createSession,
  disconnectCloudflareTunnel,
  fetchBootstrap,
  fetchSessionDetail,
  resolveApproval,
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

const STATUS_LABELS: Record<SessionStatus, string> = {
  running: 'Running',
  'needs-approval': 'Needs approval',
  idle: 'Idle',
  error: 'Error',
};

const EVENT_LABELS: Record<TranscriptEventKind, string> = {
  user: 'User',
  assistant: 'Assistant',
  tool: 'Tool',
  status: 'Status',
};

const CLOUDFLARE_STATE_LABELS = {
  idle: 'Idle',
  connecting: 'Connecting',
  connected: 'Connected',
  error: 'Error',
} as const;

function itemToEvent(item: CodexThreadItem): { kind: TranscriptEventKind; title: string; body: string } {
  if (item.type === 'userMessage') {
    return {
      kind: 'user',
      title: 'Prompt',
      body: item.content
        .filter((entry) => entry.type === 'text')
        .map((entry) => entry.text)
        .join('\n'),
    };
  }

  if (item.type === 'agentMessage') {
    return {
      kind: 'assistant',
      title: item.phase === 'commentary' ? 'Commentary' : 'Answer',
      body: item.text,
    };
  }

  if (item.type === 'plan') {
    return {
      kind: 'assistant',
      title: 'Plan',
      body: item.text,
    };
  }

  if (item.type === 'reasoning') {
    return {
      kind: 'assistant',
      title: 'Reasoning',
      body: [...item.summary, ...item.content].join('\n'),
    };
  }

  if (item.type === 'commandExecution') {
    return {
      kind: 'tool',
      title: item.command,
      body: item.aggregatedOutput || item.status,
    };
  }

  if (item.type === 'fileChange') {
    return {
      kind: 'tool',
      title: 'File changes',
      body: item.changes
        .map((change) => `${change.kind?.type ?? 'update'} ${change.path}`)
        .join('\n'),
    };
  }

  const fallback = item as never;
  return {
    kind: 'status',
    title: 'Item',
    body: JSON.stringify(fallback, null, 2),
  };
}

function flattenThread(thread: CodexThread | null) {
  if (!thread) return [];
  return thread.turns.flatMap((turn) => turn.items.map(itemToEvent));
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

  useEffect(() => {
    let cancelled = false;

    async function loadBootstrap() {
      try {
        const next = await fetchBootstrap();
        if (cancelled) return;
        setBootstrap(next);
        setError(null);
        if (!selectedSessionId && next.sessions.length > 0) {
          setSelectedSessionId(next.sessions[0]?.id ?? null);
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

  const threadEvents = flattenThread(detail?.thread ?? null);
  const cloudflare = bootstrap?.cloudflare;

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
          <span>{bootstrap?.defaults.defaultSecurityProfile ?? 'repo-write'}</span>
          <span>{bootstrap?.defaults.networkEnabledByDefault ? 'Network on' : 'Network off'}</span>
          <span>{bootstrap?.defaults.transcriptMode ?? 'app-server'}</span>
        </div>
      </header>

      <section className="hero-card">
        <div>
          <p className="eyebrow">Phase 1 contract</p>
          <h2>{bootstrap?.subtitle ?? 'Connecting the browser shell to the real Codex runtime.'}</h2>
        </div>
        <div className="hero-grid">
          <div>
            <span className="hero-label">Executor</span>
            <strong>{bootstrap?.defaults.executor ?? 'codex'}</strong>
          </div>
          <div>
            <span className="hero-label">Primary client</span>
            <strong>{bootstrap?.defaults.primaryClient ?? 'web'}</strong>
          </div>
          <div>
            <span className="hero-label">Sessions</span>
            <strong>{bootstrap?.sessions.length ?? 0}</strong>
          </div>
          <div>
            <span className="hero-label">Pending approvals</span>
            <strong>{bootstrap?.approvals.length ?? 0}</strong>
          </div>
        </div>
      </section>

      <section className="remote-access-card">
        <div className="remote-access-copy">
          <div>
            <p className="eyebrow">Cloudflare remote access</p>
            <h2>
              {cloudflare
                ? `${CLOUDFLARE_STATE_LABELS[cloudflare.state]} tunnel`
                : 'Tunnel status unavailable'}
            </h2>
          </div>
          <p>
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
          ) : (
            <p className="remote-access-note">
              {cloudflare?.mode === 'token'
                ? 'Set CLOUDFLARE_PUBLIC_URL to surface the stable hostname in the UI.'
                : 'Quick tunnel mode will surface a temporary trycloudflare.com URL here.'}
            </p>
          )}
          {cloudflare?.lastError ? <p className="remote-access-error">{cloudflare.lastError}</p> : null}
        </div>
        <div className="remote-access-actions">
          <div className="remote-status-row">
            <span>{cloudflare?.version ?? 'cloudflared missing'}</span>
            <span>{cloudflare?.mode ?? 'not connected'}</span>
          </div>
          <div className="remote-button-row">
            <button
              type="button"
              onClick={() => void handleConnectCloudflare()}
              disabled={!cloudflare?.installed || busy === 'connect-cloudflare' || cloudflare?.state === 'connecting'}
            >
              {busy === 'connect-cloudflare' || cloudflare?.state === 'connecting' ? 'Connecting...' : 'Connect tunnel'}
            </button>
            <button
              type="button"
              className="button-secondary"
              onClick={() => void handleDisconnectCloudflare()}
              disabled={!cloudflare?.installed || !cloudflare?.publicUrl || busy === 'disconnect-cloudflare'}
            >
              {busy === 'disconnect-cloudflare' ? 'Disconnecting...' : 'Disconnect'}
            </button>
          </div>
          {cloudflare?.recentLogs.length ? (
            <div className="remote-log-list">
              {cloudflare.recentLogs.slice(-4).map((line, index) => (
                <p key={`${line}-${index}`}>{line}</p>
              ))}
            </div>
          ) : null}
        </div>
      </section>

      <section className="workspace">
        <aside className="panel rail">
          <div className="panel-header">
            <p className="eyebrow">Create session</p>
            <h2>Workspace-first entry</h2>
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
              {busy === 'create-session' ? 'Creating...' : 'New session'}
            </button>
          </form>

          <div className="panel-header rail-divider">
            <p className="eyebrow">Concurrent sessions</p>
            <h2>Light session rail</h2>
          </div>

          <ul className="session-list">
            {bootstrap?.sessions.map((session) => (
              <li
                key={session.id}
                className={`session-card ${selectedSessionId === session.id ? 'session-card-active' : ''}`}
                onClick={() => setSelectedSessionId(session.id)}
              >
                <div className="session-row">
                  <h3>{session.title}</h3>
                  <span className={`status-pill status-${session.status}`}>{STATUS_LABELS[session.status]}</span>
                </div>
                <p className="session-workspace">{session.workspace}</p>
                <div className="session-row session-foot">
                  <span>{session.securityProfile}</span>
                  <span>{session.lastUpdate}</span>
                </div>
              </li>
            ))}
          </ul>
        </aside>

        <section className="panel transcript">
          <div className="panel-header">
            <p className="eyebrow">Coding-first surface</p>
            <h2>{detail?.session.title ?? 'Select or create a session'}</h2>
          </div>

          {detail ? (
            <>
              <div className="detail-meta">
                <span>{detail.session.workspace}</span>
                <span>{detail.session.securityProfile}</span>
                <span>{detail.session.networkEnabled ? 'Network enabled' : 'Network disabled'}</span>
                <span>{detail.thread?.status && typeof detail.thread.status === 'object' ? detail.thread.status.type : 'idle'}</span>
              </div>

              <div className="event-list">
                {threadEvents.length === 0 ? (
                  <article className="event-card event-status">
                    <div className="event-meta">
                      <span>Status</span>
                      <strong>No turns yet</strong>
                    </div>
                    <p>Start the first prompt from the composer below.</p>
                  </article>
                ) : (
                  threadEvents.map((event: ReturnType<typeof itemToEvent>, index: number) => (
                    <article key={`${event.title}-${index}`} className={`event-card event-${event.kind}`}>
                      <div className="event-meta">
                        <span>{EVENT_LABELS[event.kind]}</span>
                        <strong>{event.title}</strong>
                      </div>
                      <p>{event.body}</p>
                    </article>
                  ))
                )}
              </div>

              <div className="live-events">
                <p className="eyebrow">Live host events</p>
                {detail.liveEvents.length === 0 ? (
                  <p className="live-empty">No live transport events captured yet.</p>
                ) : (
                  detail.liveEvents.slice(-6).map((event) => (
                    <div key={event.id} className="live-event-row">
                      <strong>{event.method}</strong>
                      <span>{event.summary}</span>
                    </div>
                  ))
                )}
              </div>

              <form className="composer-form" onSubmit={handleStartTurn}>
                <label className="field">
                  <span>Prompt</span>
                  <textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} rows={5} />
                </label>
                <button type="submit" disabled={busy === 'start-turn'}>
                  {busy === 'start-turn' ? 'Sending...' : 'Send prompt'}
                </button>
              </form>
            </>
          ) : (
            <section className="empty-state">
              <p className="eyebrow">No active selection</p>
              <h2>Create a session on the left to start a real Codex thread.</h2>
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
    </main>
  );
}
