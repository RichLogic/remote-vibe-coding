export type SecurityProfile = 'read-only-workspace' | 'repo-write' | 'repo-write-network' | 'full-host';
export type ApprovalScope = 'once' | 'session';
export type SessionStatus = 'running' | 'needs-approval' | 'idle' | 'completed';
export type TranscriptEventKind = 'user' | 'assistant' | 'tool' | 'status';

export interface ProductDefaults {
  executor: 'codex';
  transcriptMode: 'transcript-first';
  defaultSecurityProfile: SecurityProfile;
  networkEnabledByDefault: boolean;
  fullHostAvailable: boolean;
  approvalScopes: ApprovalScope[];
  primaryClient: 'web';
}

export interface SessionSummary {
  id: string;
  title: string;
  workspace: string;
  securityProfile: SecurityProfile;
  status: SessionStatus;
  lastUpdate: string;
}

export interface ApprovalCard {
  id: string;
  title: string;
  risk: string;
  scopeOptions: ApprovalScope[];
  source: 'host-policy' | 'codex';
}

export interface TranscriptEvent {
  id: string;
  kind: TranscriptEventKind;
  title: string;
  body: string;
}

export interface BootstrapPayload {
  productName: string;
  subtitle: string;
  defaults: ProductDefaults;
  sessions: SessionSummary[];
  approvals: ApprovalCard[];
  transcript: TranscriptEvent[];
  updatedAt: string;
}
