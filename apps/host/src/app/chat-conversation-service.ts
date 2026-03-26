import { randomUUID } from 'node:crypto';

import { DEFAULT_APPROVAL_MODE } from '../approval-mode.js';
import type {
  ConversationRecord,
  ModelOption,
  ReasoningEffort,
  UserRecord,
} from '../types.js';
import type { RuntimeThreadStarter } from './agent-runtime.js';

interface ChatRolePresetConfig {
  defaultPresetId: string | null;
  presets: Array<{
    id: string;
    label: string;
    description: string | null;
    promptText: string;
  }>;
}

export class ChatConversationServiceError extends Error {
  constructor(message: string, readonly statusCode: number) {
    super(message);
    this.name = 'ChatConversationServiceError';
  }
}

interface CreateChatConversationInput {
  title?: string;
  model?: string | null;
  reasoningEffort?: ReasoningEffort | null;
  rolePresetId?: string | null;
}

interface UpdateChatConversationInput {
  title?: string;
}

interface UpdateChatConversationPreferencesInput {
  model?: string | null;
  reasoningEffort?: ReasoningEffort | null;
  rolePresetId?: string | null;
}

interface CreateChatConversationServiceOptions {
  runtime: RuntimeThreadStarter;
  ensureChatWorkspace: (ownerUsername: string, ownerUserId: string) => Promise<{ path: string }>;
  persistConversation: (conversation: ConversationRecord) => Promise<unknown>;
  ensureConversationHistory: (conversation: ConversationRecord) => Promise<unknown>;
  updateConversation: (
    conversation: ConversationRecord,
    patch: Partial<ConversationRecord>,
  ) => Promise<ConversationRecord | null>;
  currentDefaultModel: () => string;
  currentDefaultEffort: (model: string | null | undefined) => ReasoningEffort;
  defaultChatTitle: () => string;
  trimOptional: (value: unknown) => string | null;
  normalizeReasoningEffort: (value: unknown) => ReasoningEffort | null;
  findModelOption: (model: string | null | undefined) => ModelOption | null;
  preferredReasoningEffortForModel: (modelOption: ModelOption) => ReasoningEffort;
  loadChatRolePresetConfig: () => Promise<ChatRolePresetConfig>;
  normalizeChatRolePresetId: (
    value: string | null | undefined,
    config: ChatRolePresetConfig,
  ) => string | null;
  randomId?: () => string;
  now?: () => string;
}

export function createChatConversationService(options: CreateChatConversationServiceOptions) {
  const randomId = options.randomId ?? (() => randomUUID());
  const now = options.now ?? (() => new Date().toISOString());

  async function createConversation(currentUser: UserRecord, input: CreateChatConversationInput) {
    const requestedTitle = options.trimOptional(input.title);
    const model = options.trimOptional(input.model) ?? options.currentDefaultModel();
    const reasoningEffort = options.normalizeReasoningEffort(input.reasoningEffort) ?? options.currentDefaultEffort(model);
    const rolePresetConfig = await options.loadChatRolePresetConfig();
    const hasRolePresetId = Object.prototype.hasOwnProperty.call(input, 'rolePresetId');
    const requestedRolePresetId = hasRolePresetId ? options.trimOptional(input.rolePresetId) : null;
    const rolePresetId = hasRolePresetId
      ? (requestedRolePresetId ? options.normalizeChatRolePresetId(requestedRolePresetId, rolePresetConfig) : null)
      : rolePresetConfig.defaultPresetId;

    if (requestedRolePresetId && !rolePresetId) {
      throw new ChatConversationServiceError('Unknown role preset.', 400);
    }

    let workspaceInfo: Awaited<ReturnType<typeof options.ensureChatWorkspace>>;
    try {
      workspaceInfo = await options.ensureChatWorkspace(currentUser.username, currentUser.id);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new ChatConversationServiceError(message, 400);
    }

    const threadResponse = await options.runtime.startThread({
      cwd: workspaceInfo.path,
      securityProfile: 'repo-write',
      model,
    });

    const conversation: ConversationRecord = {
      id: randomId(),
      ownerUserId: currentUser.id,
      ownerUsername: currentUser.username,
      sessionType: 'chat',
      threadId: threadResponse.thread.id,
      activeTurnId: null,
      title: requestedTitle || options.defaultChatTitle(),
      autoTitle: !requestedTitle,
      workspace: workspaceInfo.path,
      archivedAt: null,
      securityProfile: 'repo-write',
      approvalMode: DEFAULT_APPROVAL_MODE,
      networkEnabled: false,
      fullHostEnabled: false,
      status: 'idle',
      recoveryState: 'ready',
      retryable: false,
      lastIssue: null,
      hasTranscript: false,
      model,
      reasoningEffort,
      rolePresetId,
      createdAt: now(),
      updatedAt: now(),
    };

    await options.persistConversation(conversation);
    await options.ensureConversationHistory(conversation);
    return conversation;
  }

  async function renameConversation(conversation: ConversationRecord, input: UpdateChatConversationInput) {
    const title = options.trimOptional(input.title);
    if (!title) {
      throw new ChatConversationServiceError('Conversation title is required.', 400);
    }

    return (await options.updateConversation(conversation, {
      title,
      autoTitle: false,
    })) ?? {
      ...conversation,
      title,
      autoTitle: false,
    };
  }

  async function updateConversationPreferences(
    conversation: ConversationRecord,
    input: UpdateChatConversationPreferencesInput,
  ) {
    const requestedModel = options.trimOptional(input.model) ?? conversation.model ?? options.currentDefaultModel();
    const modelOption = options.findModelOption(requestedModel);
    if (!modelOption) {
      throw new ChatConversationServiceError('Unknown model.', 400);
    }

    const requestedEffort = options.normalizeReasoningEffort(input.reasoningEffort);
    const reasoningEffort = requestedEffort && modelOption.supportedReasoningEfforts.includes(requestedEffort)
      ? requestedEffort
      : options.preferredReasoningEffortForModel(modelOption);
    const rolePresetConfig = await options.loadChatRolePresetConfig();
    const hasRolePresetId = Object.prototype.hasOwnProperty.call(input, 'rolePresetId');
    const requestedRolePresetId = hasRolePresetId ? options.trimOptional(input.rolePresetId) : null;
    const rolePresetId = !hasRolePresetId
      ? conversation.rolePresetId
      : (requestedRolePresetId ? options.normalizeChatRolePresetId(requestedRolePresetId, rolePresetConfig) : null);

    if (requestedRolePresetId && !rolePresetId) {
      throw new ChatConversationServiceError('Unknown role preset.', 400);
    }

    return (await options.updateConversation(conversation, {
      model: modelOption.model,
      reasoningEffort,
      rolePresetId,
    })) ?? {
      ...conversation,
      model: modelOption.model,
      reasoningEffort,
      rolePresetId,
    };
  }

  async function archiveConversation(conversation: ConversationRecord) {
    if (conversation.archivedAt) {
      return conversation;
    }

    const archivedAt = now();
    return (await options.updateConversation(conversation, {
      archivedAt,
      activeTurnId: null,
      status: 'idle',
      networkEnabled: false,
      lastIssue: null,
    })) ?? {
      ...conversation,
      archivedAt,
      activeTurnId: null,
      status: 'idle',
      networkEnabled: false,
      lastIssue: null,
    };
  }

  async function restoreConversation(conversation: ConversationRecord) {
    if (!conversation.archivedAt) {
      return conversation;
    }

    return (await options.updateConversation(conversation, {
      archivedAt: null,
      status: 'idle',
      lastIssue: null,
    })) ?? {
      ...conversation,
      archivedAt: null,
      status: 'idle',
      lastIssue: null,
    };
  }

  return {
    createConversation,
    renameConversation,
    updateConversationPreferences,
    archiveConversation,
    restoreConversation,
  };
}
