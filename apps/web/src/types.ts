export type SecurityProfile = 'read-only' | 'repo-write' | 'full-host';
export type ApprovalMode = 'less-approval' | 'full-approval';
export type ApprovalScope = 'once' | 'session';
export type SessionStatus = 'running' | 'needs-approval' | 'idle' | 'error' | 'stale';
export type SessionType = 'code' | 'chat';
export type UserRole = 'user' | 'developer' | 'admin';
export type AppMode = 'chat' | 'developer';
export type ReasoningEffort = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
export type TranscriptEventKind = 'user' | 'assistant' | 'tool' | 'status';
export type CloudflareTunnelState = 'idle' | 'connecting' | 'connected' | 'error';
export type CloudflareTunnelMode = 'quick' | 'token' | 'named';
export type CloudflareTargetSource = 'host' | 'dev-web' | 'override';
export type SessionAttachmentKind = 'image' | 'file' | 'pdf';

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
  modes: AppMode[];
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
  roles: UserRole[];
  preferredMode: AppMode | null;
  isAdmin: boolean;
  allowedSessionTypes: SessionType[];
  canUseFullHost: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface AdminUserRecord extends UserRecord {
  token: string;
}

export interface BaseTurnRecord {
  id: string;
  ownerUserId: string;
  ownerUsername: string;
  sessionType: SessionType;
  threadId: string;
  activeTurnId: string | null;
  title: string;
  autoTitle: boolean;
  workspace: string;
  archivedAt: string | null;
  securityProfile: SecurityProfile;
  approvalMode: ApprovalMode;
  networkEnabled: boolean;
  fullHostEnabled: boolean;
  status: SessionStatus;
  lastIssue: string | null;
  hasTranscript: boolean;
  model: string | null;
  reasoningEffort: ReasoningEffort | null;
  createdAt: string;
  updatedAt: string;
}

export interface ConversationRecord extends BaseTurnRecord {
  sessionType: 'chat';
}

export interface SessionRecord extends BaseTurnRecord {
  sessionType: 'code';
  workspaceId: string;
  securityProfile: SecurityProfile;
  approvalMode: ApprovalMode;
  networkEnabled: boolean;
  fullHostEnabled: boolean;
}

export interface SessionSummary extends SessionRecord {
  lastUpdate: string;
  pendingApprovalCount: number;
}

export interface ConversationSummary extends ConversationRecord {
  lastUpdate: string;
}

export type TurnRecord = ConversationRecord | SessionRecord;

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

export interface SessionAttachmentSummary {
  id: string;
  kind: SessionAttachmentKind;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  url: string;
  createdAt: string;
}

export interface WorkspaceSummary {
  id: string;
  name: string;
  path: string;
  visible: boolean;
  sortOrder: number;
}

export interface BootstrapPayload {
  productName: string;
  subtitle: string;
  defaults: ProductDefaults;
  cloudflare: CloudflareStatus;
  currentUser: UserRecord;
  availableModes: AppMode[];
  defaultMode: AppMode;
  workspaceRoot: string;
  workspaces: WorkspaceSummary[];
  availableModels: ModelOption[];
  sessions: SessionSummary[];
  conversations: ConversationSummary[];
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

export interface CodexThreadSummary {
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
}

export interface SessionTranscriptEntry {
  id: string;
  index: number;
  kind: TranscriptEventKind;
  body: string;
  markdown: boolean;
  label: string | null;
  title: string | null;
  meta: string | null;
  attachments: SessionAttachmentSummary[];
  fileChanges?: SessionFileChange[];
}

export interface SessionCommandEvent {
  id: string;
  index: number;
  command: string;
  cwd: string;
  status: string;
  exitCode: number | null;
  output: string;
}

export interface SessionFileChange {
  path: string;
  kind: string;
  diff: string | null;
}

export interface SessionFileChangeEvent {
  id: string;
  index: number;
  path: string;
  kind: string;
  status: string;
  diff: string | null;
}

export interface SessionDetailResponse {
  session: TurnRecord;
  approvals: PendingApproval[];
  liveEvents: SessionEvent[];
  thread: CodexThreadSummary | null;
  transcriptTotal: number;
  commands: SessionCommandEvent[];
  changes: SessionFileChangeEvent[];
  draftAttachments: SessionAttachmentSummary[];
}

export interface ConversationDetailResponse {
  conversation: ConversationRecord;
  thread: CodexThreadSummary | null;
  transcriptTotal: number;
  draftAttachments: SessionAttachmentSummary[];
}

export interface SessionTranscriptPageResponse {
  items: SessionTranscriptEntry[];
  nextCursor: string | null;
  total: number;
}

export interface CreateSessionRequest {
  sessionType?: SessionType;
  workspaceId?: string;
  cwd?: string;
  workspaceName?: string;
  title?: string;
  securityProfile?: SecurityProfile;
  approvalMode?: ApprovalMode;
  model?: string | null;
  reasoningEffort?: ReasoningEffort | null;
}

export interface CreateConversationRequest {
  title?: string;
  model?: string | null;
  reasoningEffort?: ReasoningEffort | null;
}

export interface CreateTurnRequest {
  prompt?: string;
  attachmentIds?: string[];
}

export interface UpdateSessionRequest {
  title?: string;
  workspaceName?: string;
  securityProfile?: SecurityProfile;
  approvalMode?: ApprovalMode;
}

export interface UpdateConversationRequest {
  title?: string;
}

export interface CreateWorkspaceRequest {
  name?: string;
}

export interface UpdateWorkspaceRequest {
  visible?: boolean;
  sortOrder?: number;
}

export interface UpdateSessionPreferencesRequest {
  model?: string | null;
  reasoningEffort?: ReasoningEffort | null;
  approvalMode?: ApprovalMode;
}

export interface ResolveApprovalRequest {
  decision: 'accept' | 'decline';
  scope?: ApprovalScope;
}

export interface CreateUserRequest {
  username: string;
  password: string;
  roles?: UserRole[];
  preferredMode?: AppMode | null;
  isAdmin?: boolean;
  allowedSessionTypes?: SessionType[];
  canUseFullHost?: boolean;
}

export interface UpdateUserRequest {
  username?: string;
  password?: string;
  roles?: UserRole[];
  preferredMode?: AppMode | null;
  isAdmin?: boolean;
  allowedSessionTypes?: SessionType[];
  canUseFullHost?: boolean;
  regenerateToken?: boolean;
}
