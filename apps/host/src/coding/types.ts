import type {
  AgentExecutor,
  ApprovalMode,
  CreateSessionRequest,
  CreateTurnRequest,
  ExecutorModelCatalog,
  ModelOption,
  PendingApproval,
  QueuedTurnSummary,
  ReasoningEffort,
  SessionDetailResponse,
  SecurityProfile,
  SessionRecord,
  SessionSummary,
  SessionTranscriptPageResponse,
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
export type CodingSessionDetailResponse = SessionDetailResponse;
export type CodingSessionTranscriptPageResponse = SessionTranscriptPageResponse;
export type CreateCodingTurnRequest = CreateTurnRequest;

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
  executor?: AgentExecutor;
  model?: string | null;
  reasoningEffort?: ReasoningEffort | null;
  securityProfile?: SecurityProfile;
  approvalMode?: ApprovalMode;
}

export interface CodingWorkspaceFileEntry {
  path: string;
  name: string;
  kind: 'directory' | 'file';
  sizeBytes: number | null;
}

export interface CodingWorkspaceDirectoryResponse {
  workspaceId: string;
  path: string;
  entries: CodingWorkspaceFileEntry[];
}

export interface CodingWorkspaceFileResponse {
  workspaceId: string;
  path: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
  previewable: boolean;
  truncated: boolean;
  content: string | null;
  downloadUrl: string;
}

export interface CodingBootstrapPayload {
  productName: string;
  subtitle: string;
  currentUser: UserRecord;
  workspaceRoot: string;
  workspaces: CodingWorkspaceSummary[];
  sessions: CodingSessionSummary[];
  approvals: PendingApproval[];
  availableExecutors: AgentExecutor[];
  availableModels: ModelOption[];
  availableModelsByExecutor: ExecutorModelCatalog;
  defaults: {
    executor: AgentExecutor;
    model: string;
    reasoningEffort: ReasoningEffort;
  };
  updatedAt: string;
}

export type CreateCodingTurnResponse =
  | {
      status: 'started';
      turn: unknown;
      session: CodingSessionRecord;
      queuedTurns: QueuedTurnSummary[];
    }
  | {
      status: 'queued';
      queuedTurn: QueuedTurnSummary;
      session: CodingSessionRecord;
      queuedTurns: QueuedTurnSummary[];
    };
