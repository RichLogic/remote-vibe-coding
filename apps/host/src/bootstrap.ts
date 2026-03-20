import type {
  BootstrapPayload,
  CloudflareStatus,
  PendingApproval,
  SessionRecord,
  SessionStatus,
  SessionSummary,
} from './types.js';

function describeStatus(session: SessionRecord, approvalCount: number): string {
  if (session.archivedAt) return 'Archived';
  if (approvalCount > 0) return `${approvalCount} approval${approvalCount === 1 ? '' : 's'} waiting`;
  switch (session.status) {
    case 'running':
      return 'Streaming Codex turn';
    case 'needs-approval':
      return 'Waiting on user decision';
    case 'stale':
      return session.lastIssue ?? 'Codex runtime restarted. Restart this session.';
    case 'error':
      return session.lastIssue ?? 'Last action failed';
    default:
      return 'Ready for the next prompt';
  }
}

export function toSessionSummary(session: SessionRecord, approvalCount: number): SessionSummary {
  return {
    ...session,
    lastUpdate: describeStatus(session, approvalCount),
    pendingApprovalCount: approvalCount,
  };
}

export function buildBootstrapPayload(
  sessions: SessionRecord[],
  approvals: PendingApproval[],
  cloudflare: CloudflareStatus,
): BootstrapPayload {
  const approvalCounts = new Map<string, number>();
  for (const approval of approvals) {
    approvalCounts.set(
      approval.sessionId,
      (approvalCounts.get(approval.sessionId) ?? 0) + 1,
    );
  }

  const summaries = sessions.map((session) =>
    toSessionSummary(session, approvalCounts.get(session.id) ?? 0),
  );

  return {
    productName: 'remote-vibe-coding',
    subtitle: 'Codex-first browser shell backed by the real Codex app-server protocol.',
    defaults: {
      executor: 'codex',
      transcriptMode: 'app-server',
      defaultSecurityProfile: 'repo-write',
      networkEnabledByDefault: false,
      fullHostAvailable: true,
      approvalScopes: ['once', 'session'],
      primaryClient: 'web',
    },
    cloudflare,
    sessions: summaries,
    approvals,
    updatedAt: new Date().toISOString(),
  };
}
