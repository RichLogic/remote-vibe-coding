import { randomUUID } from 'node:crypto';

import type {
  AgentExecutor,
  ApprovalMode,
  ModelOption,
  ReasoningEffort,
  SecurityProfile,
  SessionRecord,
  UserRecord,
  WorkspaceSummary,
} from '../types.js';
import type { RuntimeThreadStarter } from './agent-runtime.js';

interface CreateDeveloperSessionServiceOptions {
  isExecutorSupported: (executor: AgentExecutor) => boolean;
  runtimeForExecutor: (executor: AgentExecutor) => RuntimeThreadStarter;
  countSessionsForWorkspace: (userId: string, workspaceId: string) => Promise<number>;
  persistSession: (session: SessionRecord) => Promise<unknown>;
  currentDefaultExecutor: () => AgentExecutor;
  currentDefaultModel: (executor?: AgentExecutor) => string;
  defaultCodingSessionTitle: (index?: number) => string;
  trimOptional: (value: unknown) => string | null;
  normalizeExecutor: (value: unknown) => AgentExecutor;
  normalizeReasoningEffort: (value: unknown) => ReasoningEffort | null;
  findModelOption: (model: string, executor?: AgentExecutor) => ModelOption | null;
  preferredReasoningEffortForModel: (modelOption: ModelOption) => ReasoningEffort;
  normalizeSecurityProfile: (value: unknown) => SecurityProfile;
  normalizeApprovalMode: (value: unknown) => ApprovalMode;
  randomId?: () => string;
  now?: () => string;
}

export function createDeveloperSessionService(options: CreateDeveloperSessionServiceOptions) {
  const randomId = options.randomId ?? (() => randomUUID());
  const now = options.now ?? (() => new Date().toISOString());

  return async function createDeveloperSession(
    currentUser: UserRecord,
    workspace: WorkspaceSummary,
    input: {
      title?: string;
      executor?: AgentExecutor;
      model?: string | null;
      reasoningEffort?: ReasoningEffort | null;
      securityProfile?: SecurityProfile;
      approvalMode?: ApprovalMode;
    },
  ) {
    const requestedTitle = options.trimOptional(input.title);
    const defaultTitle = requestedTitle
      ? null
      : options.defaultCodingSessionTitle((await options.countSessionsForWorkspace(currentUser.id, workspace.id)) + 1);
    const executor = options.normalizeExecutor(input.executor ?? options.currentDefaultExecutor());
    if (!options.isExecutorSupported(executor)) {
      throw new Error(`Executor "${executor}" is not available.`);
    }

    const requestedModel = options.trimOptional(input.model) ?? options.currentDefaultModel(executor);
    const modelOption = options.findModelOption(requestedModel, executor);
    if (!modelOption) {
      throw new Error('Unknown model.');
    }

    const requestedEffort = options.normalizeReasoningEffort(input.reasoningEffort);
    const reasoningEffort = requestedEffort && modelOption.supportedReasoningEfforts.includes(requestedEffort)
      ? requestedEffort
      : options.preferredReasoningEffortForModel(modelOption);
    const model = modelOption.model;
    let securityProfile = options.normalizeSecurityProfile(input.securityProfile);
    if (securityProfile === 'read-only') {
      securityProfile = 'repo-write';
    }
    if (securityProfile === 'full-host' && !currentUser.canUseFullHost) {
      throw new Error('You do not have permission to create full-host sessions.');
    }

    const approvalMode = options.normalizeApprovalMode(input.approvalMode);
    const threadResponse = await options.runtimeForExecutor(executor).startThread({
      cwd: workspace.path,
      securityProfile,
      model,
    });

    const session: SessionRecord = {
      id: randomId(),
      ownerUserId: currentUser.id,
      ownerUsername: currentUser.username,
      sessionType: 'code',
      executor,
      workspaceId: workspace.id,
      threadId: threadResponse.thread.id,
      activeTurnId: null,
      title: requestedTitle || defaultTitle || options.defaultCodingSessionTitle(),
      autoTitle: !requestedTitle,
      workspace: workspace.path,
      archivedAt: null,
      securityProfile,
      approvalMode,
      networkEnabled: false,
      fullHostEnabled: securityProfile === 'full-host',
      status: 'idle',
      lastIssue: null,
      hasTranscript: false,
      model,
      reasoningEffort,
      createdAt: now(),
      updatedAt: now(),
    };

    await options.persistSession(session);
    return session;
  };
}
