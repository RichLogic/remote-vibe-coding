import type {
  ApprovalMode,
  CreateSessionRequest,
  ModelOption,
  PendingApproval,
  ReasoningEffort,
  SecurityProfile,
  SessionRecord,
  SessionSummary,
  UpdateSessionPreferencesRequest,
  UpdateSessionRequest,
  UserRecord,
  WorkspaceSummary,
} from '../types.js';

export type CodingSessionRecord = SessionRecord;
export type CodingSessionSummary = SessionSummary;
export type CodingWorkspaceSummary = WorkspaceSummary;
export type UpdateCodingSessionRequest = UpdateSessionRequest;
export type UpdateCodingSessionPreferencesRequest = UpdateSessionPreferencesRequest;

export interface CreateCodingSessionRequest extends Omit<CreateSessionRequest, 'sessionType'> {
  sessionType?: 'code';
}

export interface CreateCodingWorkspaceRequest {
  source?: 'empty' | 'git';
  name?: string;
  gitUrl?: string;
}

export interface UpdateCodingWorkspaceRequest {
  visible?: boolean;
}

export interface ReorderCodingWorkspacesRequest {
  workspaceIds: string[];
}

export interface CreateCodingWorkspaceSessionRequest {
  title?: string;
  model?: string | null;
  reasoningEffort?: ReasoningEffort | null;
  securityProfile?: SecurityProfile;
  approvalMode?: ApprovalMode;
}

export interface CodingBootstrapPayload {
  productName: string;
  subtitle: string;
  currentUser: UserRecord;
  workspaceRoot: string;
  workspaces: CodingWorkspaceSummary[];
  sessions: CodingSessionSummary[];
  approvals: PendingApproval[];
  availableModels: ModelOption[];
  defaults: {
    model: string;
    reasoningEffort: ReasoningEffort;
  };
  updatedAt: string;
}
