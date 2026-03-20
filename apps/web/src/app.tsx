import { useEffect, useState } from 'react';

import { fetchBootstrap } from './api';
import type { BootstrapPayload, SessionStatus, TranscriptEventKind } from './types';

const STATUS_LABELS: Record<SessionStatus, string> = {
  running: 'Running',
  'needs-approval': 'Needs approval',
  idle: 'Idle',
  completed: 'Completed'
};

const EVENT_LABELS: Record<TranscriptEventKind, string> = {
  user: 'User',
  assistant: 'Assistant',
  tool: 'Tool',
  status: 'Status'
};

export function App() {
  const [data, setData] = useState<BootstrapPayload | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const bootstrap = await fetchBootstrap();
        if (!cancelled) {
          setData(bootstrap);
        }
      } catch (loadError) {
        if (!cancelled) {
          setError(loadError instanceof Error ? loadError.message : 'Unknown error');
        }
      }
    }

    void load();

    return () => {
      cancelled = true;
    };
  }, []);

  if (error) {
    return (
      <main className="shell shell-error">
        <section className="error-card">
          <p className="eyebrow">Host unavailable</p>
          <h1>Could not load the bootstrap contract</h1>
          <p>{error}</p>
          <p>Start the host service on <code>127.0.0.1:8787</code> and refresh.</p>
        </section>
      </main>
    );
  }

  if (!data) {
    return (
      <main className="shell shell-loading">
        <section className="loading-card">
          <p className="eyebrow">remote-vibe-coding</p>
          <h1>Loading browser shell</h1>
        </section>
      </main>
    );
  }

  return (
    <main className="shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">Codex-first remote coding</p>
          <h1>{data.productName}</h1>
        </div>
        <div className="topbar-meta">
          <span>{data.defaults.defaultSecurityProfile}</span>
          <span>{data.defaults.networkEnabledByDefault ? 'Network on' : 'Network off'}</span>
          <span>{data.defaults.fullHostAvailable ? 'Full host toggle available' : 'Full host disabled'}</span>
        </div>
      </header>

      <section className="hero-card">
        <div>
          <p className="eyebrow">Phase 1 contract</p>
          <h2>{data.subtitle}</h2>
        </div>
        <div className="hero-grid">
          <div>
            <span className="hero-label">Executor</span>
            <strong>{data.defaults.executor}</strong>
          </div>
          <div>
            <span className="hero-label">Primary client</span>
            <strong>{data.defaults.primaryClient}</strong>
          </div>
          <div>
            <span className="hero-label">Approval scopes</span>
            <strong>{data.defaults.approvalScopes.join(' / ')}</strong>
          </div>
          <div>
            <span className="hero-label">Updated</span>
            <strong>{new Date(data.updatedAt).toLocaleString()}</strong>
          </div>
        </div>
      </section>

      <section className="workspace">
        <aside className="panel rail">
          <div className="panel-header">
            <p className="eyebrow">Concurrent sessions</p>
            <h2>Light session rail</h2>
          </div>
          <ul className="session-list">
            {data.sessions.map((session) => (
              <li key={session.id} className="session-card">
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
            <h2>Transcript and command flow</h2>
          </div>
          <div className="event-list">
            {data.transcript.map((event) => (
              <article key={event.id} className={`event-card event-${event.kind}`}>
                <div className="event-meta">
                  <span>{EVENT_LABELS[event.kind]}</span>
                  <strong>{event.title}</strong>
                </div>
                <p>{event.body}</p>
              </article>
            ))}
          </div>
        </section>

        <aside className="panel approvals">
          <div className="panel-header">
            <p className="eyebrow">Approval center</p>
            <h2>Policy and Codex gates</h2>
          </div>
          <div className="approval-list">
            {data.approvals.map((approval) => (
              <article key={approval.id} className="approval-card">
                <div className="approval-head">
                  <strong>{approval.title}</strong>
                  <span>{approval.source}</span>
                </div>
                <p>{approval.risk}</p>
                <div className="approval-actions">
                  {approval.scopeOptions.map((scope) => (
                    <button key={scope} type="button">
                      Approve {scope}
                    </button>
                  ))}
                </div>
              </article>
            ))}
          </div>
        </aside>
      </section>
    </main>
  );
}
