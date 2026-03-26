import { randomUUID } from 'node:crypto';

import { DEFAULT_APPROVAL_MODE } from '../approval-mode.js';
import type {
  AgentExecutor,
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
  executor?: AgentExecutor;
  model?: string | null;
  reasoningEffort?: ReasoningEffort | null;
  rolePresetId?: string | null;
}

interface UpdateChatConversationInput {
  title?: string;
}

interface UpdateChatConversationPreferencesInput {
  executor?: AgentExecutor;
  model?: string | null;
  reasoningEffort?: ReasoningEffort | null;
  rolePresetId?: string | null;
}

interface CreateChatConversationServiceOptions {
  isExecutorSupported: (executor: AgentExecutor) => boolean;
  runtimeForExecutor: (executor: AgentExecutor) => RuntimeThreadStarter;
  ensureChatWorkspace: (ownerUsername: string, ownerUserId: string) => Promise<{ path: string }>;
  persistConversation: (conversation: ConversationRecord) => Promise<unknown>;
  ensureConversationHistory: (conversation: ConversationRecord) => Promise<unknown>;
  updateConversation: (
    conversation: ConversationRecord,
    patch: Partial<ConversationRecord>,
  ) => Promise<ConversationRecord | null>;
  currentDefaultExecutor: () => AgentExecutor;
  currentDefaultModel: (executor?: AgentExecutor) => string;
  currentDefaultEffort: (model: string | null | undefined, executor?: AgentExecutor) => ReasoningEffort;
  defaultChatTitle: () => string;
  trimOptional: (value: unknown) => string | null;
  normalizeExecutor: (value: unknown) => AgentExecutor;
  normalizeReasoningEffort: (value: unknown) => ReasoningEffort | null;
  findModelOption: (model: string | null | undefined, executor?: AgentExecutor) => ModelOption | null;
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
    const executor = options.normalizeExecutor(input.executor ?? options.currentDefaultExecutor());
    if (!options.isExecutorSupported(executor)) {
      throw new ChatConversationServiceError(`Executor "${executor}" is not available.`, 400);
    }
    const model = options.trimOptional(input.model) ?? options.currentDefaultModel(executor);
    const modelOption = options.findModelOption(model, executor);
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

    const threadResponse = await options.runtimeForExecutor(executor).startThread({
      cwd: workspaceInfo.path,
      securityProfile: 'repo-write',
      model: modelOption.model,
    });

    const conversation: ConversationRecord = {
      id: randomId(),
      ownerUserId: currentUser.id,
      ownerUsername: currentUser.username,
      sessionType: 'chat',
      executor,
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
      model: modelOption.model,
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
    const requestedExecutor = input.executor === undefined
      ? conversation.executor
      : options.normalizeExecutor(input.executor);
    if (!options.isExecutorSupported(requestedExecutor)) {
      throw new ChatConversationServiceError('Executor not available.', 400);
    }
    if (requestedExecutor !== conversation.executor && conversation.activeTurnId) {
      throw new ChatConversationServiceError('Stop the active turn before switching executor.', 409);
    }

    const requestedModel = options.trimOptional(input.model)
      ?? (requestedExecutor === conversation.executor
        ? (conversation.model ?? options.currentDefaultModel(requestedExecutor))
        : options.currentDefaultModel(requestedExecutor));
    const modelOption = options.findModelOption(requestedModel, requestedExecutor);
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
      executor: requestedExecutor,
      model: modelOption.model,
      reasoningEffort,
      rolePresetId,
    })) ?? {
      ...conversation,
      executor: requestedExecutor,
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
