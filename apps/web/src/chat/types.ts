import type {
  AgentExecutor,
  AppMode,
  ChatRecoveryState,
  ChatUiStatus,
  CodexThreadSummary,
  ModelOption,
  ReasoningEffort,
  SessionAttachmentSummary,
  SessionEvent,
  SessionStatus,
  SessionTranscriptEntry,
  UserRecord,
} from '../types';

export interface ChatConversation {
  kind: 'chat-conversation';
  id: string;
  ownerUserId: string;
  ownerUsername: string;
  executor: AgentExecutor;
  threadId: string;
  activeTurnId: string | null;
  title: string;
  autoTitle: boolean;
  workspace: string;
  archivedAt: string | null;
  networkEnabled: boolean;
  status: SessionStatus;
  uiStatus: ChatUiStatus;
  recoveryState: ChatRecoveryState;
  retryable: boolean;
  lastIssue: string | null;
  hasTranscript: boolean;
  model: string | null;
  reasoningEffort: ReasoningEffort | null;
  rolePresetId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ChatConversationSummary extends ChatConversation {
  lastUpdate: string;
}

export interface ChatRolePreset {
  id: string;
  label: string;
  description: string | null;
  isDefault: boolean;
}

export interface ChatRolePresetDetail extends ChatRolePreset {
  prompt: string;
}

export interface ChatRolePresetListResponse {
  rolePresets: ChatRolePresetDetail[];
  defaultRolePresetId: string | null;
}

export interface ChatBootstrapPayload {
  productName: string;
  subtitle: string;
  currentUser: UserRecord;
  availableModes: AppMode[];
  defaultMode: AppMode;
  availableModels: ModelOption[];
  rolePresets: ChatRolePreset[];
  conversations: ChatConversationSummary[];
  defaults: {
    model: string;
    reasoningEffort: ReasoningEffort;
    rolePresetId: string | null;
  };
  attachments: {
    enabled: true;
    uploadOnly: true;
  };
  updatedAt: string;
}

export interface ChatConversationDetailResponse {
  conversation: ChatConversation;
  thread: CodexThreadSummary | null;
  transcriptTotal: number;
  draftAttachments: SessionAttachmentSummary[];
}

export interface ChatTranscriptPageResponse {
  items: SessionTranscriptEntry[];
  nextCursor: string | null;
  total: number;
  conversation: ChatConversation;
  liveEvents: SessionEvent[];
}

export interface CreateChatConversationRequest {
  title?: string;
  executor?: AgentExecutor;
  model?: string | null;
  reasoningEffort?: ReasoningEffort | null;
  rolePresetId?: string | null;
}

export interface UpdateChatConversationRequest {
  title?: string;
}

export interface UpdateChatConversationPreferencesRequest {
  executor?: AgentExecutor;
  model?: string | null;
  reasoningEffort?: ReasoningEffort | null;
  rolePresetId?: string | null;
}

export interface CreateChatMessageRequest {
  prompt?: string;
  attachmentIds?: string[];
}

export interface CreateChatRolePresetRequest {
  label?: string;
  description?: string | null;
  prompt?: string;
  isDefault?: boolean;
}

export interface UpdateChatRolePresetRequest {
  label?: string;
  description?: string | null;
  prompt?: string;
  isDefault?: boolean;
}
