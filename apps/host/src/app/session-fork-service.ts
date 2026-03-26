import { randomUUID } from 'node:crypto';

import { DEFAULT_APPROVAL_MODE } from '../approval-mode.js';
import type { AgentExecutor, ConversationRecord, SessionRecord, UserRecord } from '../types.js';
import type { RuntimeThreadStarter } from './agent-runtime.js';

interface CreateSessionForkServiceOptions {
  chatRuntime: RuntimeThreadStarter;
  runtimeForExecutor: (executor: AgentExecutor) => RuntimeThreadStarter;
  ensureChatWorkspace: (ownerUsername: string, ownerUserId: string) => Promise<{ path: string }>;
  persistForkedSession: (session: SessionRecord) => Promise<unknown>;
  persistForkedConversation: (conversation: ConversationRecord) => Promise<unknown>;
  currentDefaultModel: () => string;
  currentDefaultEffort: (model: string | null | undefined) => SessionRecord['reasoningEffort'];
  nextForkedSessionTitle: (title: string) => string;
  randomId?: () => string;
  now?: () => string;
}

export function createSessionForkService(options: CreateSessionForkServiceOptions) {
  const randomId = options.randomId ?? (() => randomUUID());
  const now = options.now ?? (() => new Date().toISOString());

  async function createForkedSession(currentUser: UserRecord, sourceSession: SessionRecord) {
    const nextModel = sourceSession.model ?? options.currentDefaultModel();
    const nextReasoningEffort = sourceSession.reasoningEffort ?? options.currentDefaultEffort(nextModel);
    const nextTitle = options.nextForkedSessionTitle(sourceSession.title);
    const threadResponse = await options.runtimeForExecutor(sourceSession.executor).startThread({
      cwd: sourceSession.workspace,
      securityProfile: sourceSession.securityProfile,
      model: nextModel,
    });

    const session: SessionRecord = {
      id: randomId(),
      ownerUserId: currentUser.id,
      ownerUsername: currentUser.username,
      sessionType: 'code',
      executor: sourceSession.executor,
      workspaceId: sourceSession.workspaceId,
      threadId: threadResponse.thread.id,
      activeTurnId: null,
      title: nextTitle,
      autoTitle: false,
      workspace: sourceSession.workspace,
      archivedAt: null,
      securityProfile: sourceSession.securityProfile,
      approvalMode: sourceSession.approvalMode,
      networkEnabled: false,
      fullHostEnabled: sourceSession.securityProfile === 'full-host',
      status: 'idle',
      lastIssue: null,
      hasTranscript: false,
      model: nextModel,
      reasoningEffort: nextReasoningEffort,
      createdAt: now(),
      updatedAt: now(),
    };

    await options.persistForkedSession(session);
    return session;
  }

  async function createForkedConversation(currentUser: UserRecord, sourceConversation: ConversationRecord) {
    const nextModel = sourceConversation.model ?? options.currentDefaultModel();
    const nextReasoningEffort = sourceConversation.reasoningEffort ?? options.currentDefaultEffort(nextModel);
    const nextTitle = options.nextForkedSessionTitle(sourceConversation.title);
    const workspaceInfo = await options.ensureChatWorkspace(currentUser.username, currentUser.id);
    const threadResponse = await options.chatRuntime.startThread({
      cwd: workspaceInfo.path,
      securityProfile: 'repo-write',
      model: nextModel,
    });

    const conversation: ConversationRecord = {
      id: randomId(),
      ownerUserId: currentUser.id,
      ownerUsername: currentUser.username,
      sessionType: 'chat',
      threadId: threadResponse.thread.id,
      activeTurnId: null,
      title: nextTitle,
      autoTitle: false,
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
      model: nextModel,
      reasoningEffort: nextReasoningEffort,
      rolePresetId: sourceConversation.rolePresetId,
      createdAt: now(),
      updatedAt: now(),
    };

    await options.persistForkedConversation(conversation);
    return conversation;
  }

  return {
    createForkedSession,
    createForkedConversation,
  };
}
