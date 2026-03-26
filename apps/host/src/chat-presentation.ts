import type {
  ChatBootstrapPayload,
  ChatConversation as ApiChatConversation,
  ChatConversationDetailResponse,
  ChatConversationSummary as ApiChatConversationSummary,
  ChatRolePreset as ApiChatRolePreset,
} from './chat/types.js';
import type {
  AppMode,
  ChatRecoveryState,
  ChatUiStatus,
  CodexThreadSummary,
  ConversationRecord,
  ModelOption,
  ReasoningEffort,
  SessionAttachmentSummary,
  UserRecord,
} from './types.js';

export function describeChatConversation(record: ConversationRecord) {
  const uiStatus = chatConversationUiStatus(record);
  if (record.archivedAt) return 'Archived';
  switch (uiStatus) {
    case 'processing':
      return 'Streaming chat turn';
    case 'error':
      return record.lastIssue ?? 'Last action failed';
    default:
      return 'Ready for the next prompt';
  }
}

export function chatConversationRecoveryState(
  record: Pick<ConversationRecord, 'recoveryState' | 'status'>,
): ChatRecoveryState {
  return record.recoveryState ?? (record.status === 'stale' ? 'stale' : 'ready');
}

export function chatConversationRetryable(record: Pick<ConversationRecord, 'retryable' | 'status'>) {
  return typeof record.retryable === 'boolean' ? record.retryable : record.status === 'error';
}

export function chatConversationUiStatus(
  record: Pick<ConversationRecord, 'activeTurnId' | 'status' | 'hasTranscript'>,
): ChatUiStatus {
  if (record.activeTurnId || record.status === 'running') {
    return 'processing';
  }
  if (record.status === 'error') {
    return 'error';
  }
  return record.hasTranscript ? 'completed' : 'new';
}

export function interruptedChatConversation(
  record: Pick<ConversationRecord, 'activeTurnId' | 'status' | 'lastIssue'>,
) {
  return Boolean(record.activeTurnId) || record.status === 'running' || record.status === 'error';
}

export function unavailableChatConversationPatch(
  record: Pick<ConversationRecord, 'activeTurnId' | 'status' | 'lastIssue'>,
  interruptedMessage: string,
  reason: string,
): Partial<ConversationRecord> {
  const interrupted = interruptedChatConversation(record);
  return {
    activeTurnId: null,
    status: interrupted ? 'error' : 'idle',
    recoveryState: 'stale',
    retryable: interrupted,
    lastIssue: interrupted
      ? (record.status === 'error' && record.lastIssue ? record.lastIssue : interruptedMessage)
      : reason,
    networkEnabled: false,
  };
}

interface ChatConversationTransformOptions {
  normalizeRolePresetId: (value: string | null | undefined) => string | null;
}

export function toApiChatConversation(
  record: ConversationRecord,
  options: ChatConversationTransformOptions,
): ApiChatConversation {
  return {
    kind: 'chat-conversation',
    id: record.id,
    ownerUserId: record.ownerUserId,
    ownerUsername: record.ownerUsername,
    threadId: record.threadId,
    activeTurnId: record.activeTurnId,
    title: record.title,
    autoTitle: record.autoTitle,
    workspace: record.workspace,
    archivedAt: record.archivedAt,
    networkEnabled: record.networkEnabled,
    status: record.status,
    uiStatus: chatConversationUiStatus(record),
    recoveryState: chatConversationRecoveryState(record),
    retryable: chatConversationRetryable(record),
    lastIssue: record.lastIssue,
    hasTranscript: record.hasTranscript,
    model: record.model,
    reasoningEffort: record.reasoningEffort,
    rolePresetId: options.normalizeRolePresetId(record.rolePresetId),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

export function toApiChatConversationSummary(
  record: ConversationRecord,
  options: ChatConversationTransformOptions,
): ApiChatConversationSummary {
  return {
    ...toApiChatConversation(record, options),
    lastUpdate: describeChatConversation(record),
  };
}

interface BuildChatBootstrapPayloadOptions extends ChatConversationTransformOptions {
  currentUser: UserRecord;
  conversations: ConversationRecord[];
  rolePresets: ApiChatRolePreset[];
  defaultRolePresetId: string | null;
  availableModes: AppMode[];
  defaultMode: AppMode;
  availableModels: ModelOption[];
  defaultModel: string;
  defaultReasoningEffort: ReasoningEffort;
}

export function buildChatBootstrapPayload(
  options: BuildChatBootstrapPayloadOptions,
): ChatBootstrapPayload {
  return {
    productName: 'remote-vibe-coding',
    subtitle: 'Codex-first browser shell backed by the real Codex app-server protocol.',
    currentUser: options.currentUser,
    availableModes: options.availableModes,
    defaultMode: options.defaultMode,
    availableModels: options.availableModels,
    rolePresets: options.rolePresets,
    conversations: options.conversations.map((conversation) => (
      toApiChatConversationSummary(conversation, options)
    )),
    defaults: {
      model: options.defaultModel,
      reasoningEffort: options.defaultReasoningEffort,
      rolePresetId: options.defaultRolePresetId,
    },
    attachments: {
      enabled: true,
      uploadOnly: true,
    },
    updatedAt: new Date().toISOString(),
  };
}

interface BuildChatConversationDetailResponseOptions extends ChatConversationTransformOptions {
  conversation: ConversationRecord;
  thread: CodexThreadSummary | null;
  transcriptTotal: number;
  draftAttachments: SessionAttachmentSummary[];
}

export function buildChatConversationDetailResponse(
  options: BuildChatConversationDetailResponseOptions,
): ChatConversationDetailResponse {
  return {
    conversation: toApiChatConversation(options.conversation, options),
    thread: options.thread,
    transcriptTotal: options.transcriptTotal,
    draftAttachments: options.draftAttachments,
  };
}
