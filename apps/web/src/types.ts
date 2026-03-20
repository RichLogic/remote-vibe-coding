export type SecurityProfile = 'repo-write' | 'full-host';
export type ApprovalScope = 'once' | 'session';
export type SessionStatus = 'running' | 'needs-approval' | 'idle' | 'error' | 'stale';
export type TranscriptEventKind = 'user' | 'assistant' | 'tool' | 'status';
export type CloudflareTunnelState = 'idle' | 'connecting' | 'connected' | 'error';
export type CloudflareTunnelMode = 'quick' | 'token' | 'named';
export type CloudflareTargetSource = 'host' | 'dev-web' | 'override';

export interface ProductDefaults {
  executor: 'codex';
  transcriptMode: 'app-server';
  defaultSecurityProfile: SecurityProfile;
  networkEnabledByDefault: boolean;
  fullHostAvailable: boolean;
  approvalScopes: ApprovalScope[];
  primaryClient: 'web';
}

export interface CloudflareStatus {
  installed: boolean;
  version: string | null;
  state: CloudflareTunnelState;
  mode: CloudflareTunnelMode | null;
  tunnelName: string | null;
  publicUrl: string | null;
  targetUrl: string;
  targetSource: CloudflareTargetSource;
  connectorCount: number;
  activeSource: 'local-manager' | 'system' | null;
  startedAt: string | null;
  lastError: string | null;
  recentLogs: string[];
}

export interface SessionRecord {
  id: string;
  threadId: string;
  title: string;
  workspace: string;
  archivedAt: string | null;
  securityProfile: SecurityProfile;
  networkEnabled: boolean;
  fullHostEnabled: boolean;
  status: SessionStatus;
  lastIssue: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SessionSummary extends SessionRecord {
  lastUpdate: string;
  pendingApprovalCount: number;
}

export interface PendingApproval {
  id: string;
  sessionId: string;
  method: string;
  title: string;
  risk: string;
  scopeOptions: ApprovalScope[];
  source: 'codex';
  payload: unknown;
  createdAt: string;
}

export interface SessionEvent {
  id: string;
  method: string;
  summary: string;
  createdAt: string;
}

export interface BootstrapPayload {
  productName: string;
  subtitle: string;
  defaults: ProductDefaults;
  cloudflare: CloudflareStatus;
  sessions: SessionSummary[];
  approvals: PendingApproval[];
  updatedAt: string;
}

export interface CodexThreadInput {
  type: 'text';
  text: string;
  text_elements: unknown[];
}

export interface CodexUserMessageItem {
  type: 'userMessage';
  id: string;
  content: CodexThreadInput[];
}

export interface CodexAgentMessageItem {
  type: 'agentMessage';
  id: string;
  text: string;
  phase: string | null;
}

export interface CodexPlanItem {
  type: 'plan';
  id: string;
  text: string;
}

export interface CodexReasoningItem {
  type: 'reasoning';
  id: string;
  summary: string[];
  content: string[];
}

export interface CodexCommandExecutionItem {
  type: 'commandExecution';
  id: string;
  command: string;
  cwd: string;
  status: string;
  aggregatedOutput: string | null;
  exitCode: number | null;
}

export interface CodexFileChangeItem {
  type: 'fileChange';
  id: string;
  status: string;
  changes: Array<{
    path: string;
    kind: {
      type?: string;
    };
    diff?: string | null;
  }>;
}

export type CodexThreadItem =
  | CodexUserMessageItem
  | CodexAgentMessageItem
  | CodexPlanItem
  | CodexReasoningItem
  | CodexCommandExecutionItem
  | CodexFileChangeItem;

export interface CodexTurn {
  id: string;
  status: string;
  error: {
    message?: string;
  } | null;
  items: CodexThreadItem[];
}

export interface CodexThread {
  id: string;
  preview: string;
  cwd: string;
  name: string | null;
  path?: string | null;
  cliVersion?: string | null;
  source?: string | null;
  modelProvider?: string | null;
  gitInfo?: {
    sha?: string;
    branch?: string;
    originUrl?: string;
  };
  status: {
    type: string;
    activeFlags?: string[];
  } | string;
  updatedAt: number;
  turns: CodexTurn[];
}

export interface SessionDetailResponse {
  session: SessionRecord;
  approvals: PendingApproval[];
  liveEvents: SessionEvent[];
  thread: CodexThread | null;
}

export interface CreateSessionRequest {
  cwd: string;
  title?: string;
  securityProfile?: SecurityProfile;
}

export interface CreateTurnRequest {
  prompt: string;
}

export interface RenameSessionRequest {
  title: string;
}

export interface ResolveApprovalRequest {
  decision: 'accept' | 'decline';
  scope?: ApprovalScope;
}
