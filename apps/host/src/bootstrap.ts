import type {
  CodingBootstrapPayload,
  CodingSessionRecord as SessionRecord,
  CodingSessionSummary as SessionSummary,
  CodingWorkspaceSummary,
} from './coding/types.js';
import type {
  AppMode,
  BaseTurnRecord,
  BootstrapPayload,
  CloudflareStatus,
  ConversationRecord,
  ConversationSummary,
  ModelOption,
  PendingApproval,
  UserRecord,
  WorkspaceSummary,
} from './types.js';

function describeStatus(record: BaseTurnRecord, approvalCount: number) {
  if (record.archivedAt) return 'Archived';
  if (approvalCount > 0) return `${approvalCount} approval${approvalCount === 1 ? '' : 's'} waiting`;
  switch (record.status) {
    case 'running':
      return record.sessionType === 'chat' ? 'Streaming chat turn' : 'Streaming Codex turn';
    case 'needs-approval':
      return 'Waiting on user decision';
    case 'stale':
      return 'Ready for the next prompt';
    case 'error':
      return record.lastIssue ?? 'Last action failed';
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

export function toConversationSummary(conversation: ConversationRecord): ConversationSummary {
  return {
    ...conversation,
    lastUpdate: describeStatus(conversation, 0),
  };
}

function availableModes(currentUser: UserRecord): AppMode[] {
  const modes: AppMode[] = [];
  if (currentUser.roles.includes('developer')) {
    modes.push('developer');
  }
  if (currentUser.roles.includes('user')) {
    modes.push('chat');
  }
  return modes.length > 0 ? modes : ['chat'];
}

function defaultMode(currentUser: UserRecord): AppMode {
  return currentUser.preferredMode && availableModes(currentUser).includes(currentUser.preferredMode)
    ? currentUser.preferredMode
    : currentUser.roles.includes('developer')
      ? 'developer'
      : 'chat';
}

export function buildBootstrapPayload(
  currentUser: UserRecord,
  sessions: SessionRecord[],
  conversations: ConversationRecord[],
  approvals: PendingApproval[],
  cloudflare: CloudflareStatus,
  workspaceRoot: string,
  workspaces: WorkspaceSummary[],
  availableModels: ModelOption[],
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
  const conversationSummaries = conversations.map(toConversationSummary);

  return {
    productName: 'remote-vibe-coding',
    subtitle: 'Codex-first browser shell backed by the real Codex app-server protocol.',
    defaults: {
      executor: 'codex',
      transcriptMode: 'app-server',
      defaultSecurityProfile: 'repo-write',
      networkEnabledByDefault: false,
      fullHostAvailable: currentUser.canUseFullHost,
      approvalScopes: ['once', 'session'],
      primaryClient: 'web',
      modes: availableModes(currentUser),
      sessionTypes: ['code', 'chat'],
    },
    cloudflare,
    currentUser,
    availableModes: availableModes(currentUser),
    defaultMode: defaultMode(currentUser),
    workspaceRoot,
    workspaces,
    availableModels,
    sessions: summaries,
    conversations: conversationSummaries,
    approvals,
    updatedAt: new Date().toISOString(),
  };
}

export function buildCodingBootstrapPayload(
  currentUser: UserRecord,
  sessions: SessionRecord[],
  approvals: PendingApproval[],
  workspaceRoot: string,
  workspaces: WorkspaceSummary[],
  availableModels: ModelOption[],
): CodingBootstrapPayload {
  const approvalCounts = new Map<string, number>();
  for (const approval of approvals) {
    approvalCounts.set(
      approval.sessionId,
      (approvalCounts.get(approval.sessionId) ?? 0) + 1,
    );
  }

  return {
    productName: 'remote-vibe-coding',
    subtitle: 'Codex-first browser shell backed by the real Codex app-server protocol.',
    currentUser,
    workspaceRoot,
    workspaces: workspaces.map((workspace): CodingWorkspaceSummary => ({
      ...workspace,
    })),
    sessions: sessions.map((session) => (
      toSessionSummary(session, approvalCounts.get(session.id) ?? 0)
    )),
    approvals,
    availableModels,
    defaults: {
      model: availableModels.find((entry) => entry.isDefault)?.model ?? availableModels[0]?.model ?? 'gpt-5-codex',
      reasoningEffort: availableModels.find((entry) => entry.isDefault)?.defaultReasoningEffort
        ?? availableModels[0]?.defaultReasoningEffort
        ?? 'xhigh',
    },
    updatedAt: new Date().toISOString(),
  };
}
