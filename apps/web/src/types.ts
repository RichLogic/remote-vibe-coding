export type SecurityProfile = 'read-only' | 'repo-write' | 'full-host';
export type ApprovalScope = 'once' | 'session';
export type SessionStatus = 'running' | 'needs-approval' | 'idle' | 'error' | 'stale';
export type SessionType = 'code' | 'chat';
export type ReasoningEffort = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
export type TranscriptEventKind = 'user' | 'assistant' | 'tool' | 'status';
export type CloudflareTunnelState = 'idle' | 'connecting' | 'connected' | 'error';
export type CloudflareTunnelMode = 'quick' | 'token' | 'named';
export type CloudflareTargetSource = 'host' | 'dev-web' | 'override';

export interface ModelOption {
  id: string;
  displayName: string;
  model: string;
  description: string;
  isDefault: boolean;
  hidden: boolean;
  defaultReasoningEffort: ReasoningEffort;
  supportedReasoningEfforts: ReasoningEffort[];
}

export interface ProductDefaults {
  executor: 'codex';
  transcriptMode: 'app-server';
  defaultSecurityProfile: SecurityProfile;
  networkEnabledByDefault: boolean;
  fullHostAvailable: boolean;
  approvalScopes: ApprovalScope[];
  primaryClient: 'web';
  sessionTypes: SessionType[];
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

export interface UserRecord {
  id: string;
  username: string;
  isAdmin: boolean;
  allowedSessionTypes: SessionType[];
  canUseFullHost: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface AdminUserRecord extends UserRecord {
  token: string;
}

export interface SessionRecord {
  id: string;
  ownerUserId: string;
  ownerUsername: string;
  sessionType: SessionType;
  threadId: string;
  title: string;
  workspace: string;
  archivedAt: string | null;
  securityProfile: SecurityProfile;
  networkEnabled: boolean;
  fullHostEnabled: boolean;
  status: SessionStatus;
  lastIssue: string | null;
  model: string | null;
  reasoningEffort: ReasoningEffort | null;
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
  currentUser: UserRecord;
  availableModels: ModelOption[];
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
  sessionType?: SessionType;
  cwd?: string;
  title?: string;
  securityProfile?: SecurityProfile;
  model?: string | null;
  reasoningEffort?: ReasoningEffort | null;
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

export interface CreateUserRequest {
  username: string;
  password: string;
  isAdmin?: boolean;
  allowedSessionTypes?: SessionType[];
  canUseFullHost?: boolean;
}

export interface UpdateUserRequest {
  username?: string;
  password?: string;
  isAdmin?: boolean;
  allowedSessionTypes?: SessionType[];
  canUseFullHost?: boolean;
  regenerateToken?: boolean;
}
