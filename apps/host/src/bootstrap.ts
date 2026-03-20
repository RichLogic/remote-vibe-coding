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

const sessions: SessionSummary[] = [
  {
    id: 'sess_checkout-flow',
    title: 'Refactor checkout flow',
    workspace: '/Users/richlogic/code/shop-app',
    securityProfile: 'repo-write',
    status: 'running',
    lastUpdate: 'Streaming command output'
  },
  {
    id: 'sess_design-doc',
    title: 'Draft API design note',
    workspace: '/Users/richlogic/code/remote-vibe-coding',
    securityProfile: 'repo-write',
    status: 'needs-approval',
    lastUpdate: 'Waiting on network escalation'
  },
  {
    id: 'sess_bugfix',
    title: 'Patch OAuth callback bug',
    workspace: '/Users/richlogic/code/auth-service',
    securityProfile: 'full-host',
    status: 'idle',
    lastUpdate: 'Ready to resume'
  }
];

const approvals: ApprovalCard[] = [
  {
    id: 'approval_network_install',
    title: 'Allow network for dependency install',
    risk: 'Codex requested outbound network access for `npm install`.',
    scopeOptions: ['once', 'session'],
    source: 'host-policy'
  },
  {
    id: 'approval_exec_git',
    title: 'Approve git command execution',
    risk: 'Codex wants to run `git status --short --branch` in the active workspace.',
    scopeOptions: ['once', 'session'],
    source: 'codex'
  }
];

const transcript: TranscriptEvent[] = [
  {
    id: 'evt_user_1',
    kind: 'user',
    title: 'Instruction',
    body: 'Refactor the checkout validation path and keep the analytics event contract stable.'
  },
  {
    id: 'evt_assistant_1',
    kind: 'assistant',
    title: 'Plan',
    body: 'I will inspect the current checkout validator, compare analytics event emitters, then patch and verify the affected tests.'
  },
  {
    id: 'evt_tool_1',
    kind: 'tool',
    title: 'Tool request',
    body: 'Running `rg -n "checkout|analytics" src tests` in `/Users/richlogic/code/shop-app`.'
  },
  {
    id: 'evt_status_1',
    kind: 'status',
    title: 'Policy gate',
    body: 'Network is disabled for this session. External package install requires explicit approval.'
  }
];

export function buildBootstrapPayload(): BootstrapPayload {
  return {
    productName: 'remote-vibe-coding',
    subtitle: 'Codex-first browser shell with explicit host policy and transcript-forwarding.',
    defaults: {
      executor: 'codex',
      transcriptMode: 'transcript-first',
      defaultSecurityProfile: 'repo-write',
      networkEnabledByDefault: false,
      fullHostAvailable: true,
      approvalScopes: ['once', 'session'],
      primaryClient: 'web'
    },
    sessions,
    approvals,
    transcript,
    updatedAt: new Date().toISOString()
  };
}
