import { randomUUID } from 'node:crypto';

import type {
  ApprovalMode,
  ReasoningEffort,
  SecurityProfile,
  SessionRecord,
  UserRecord,
  WorkspaceSummary,
} from '../types.js';

interface StartThreadPort {
  startThread(options: {
    cwd: string;
    securityProfile: SessionRecord['securityProfile'];
    model?: string | null;
  }): Promise<{
    thread: {
      id: string;
    };
  }>;
}

interface CreateDeveloperSessionServiceOptions {
  codex: StartThreadPort;
  countSessionsForWorkspace: (userId: string, workspaceId: string) => Promise<number>;
  persistSession: (session: SessionRecord) => Promise<unknown>;
  currentDefaultModel: () => string;
  currentDefaultEffort: (model: string | null | undefined) => ReasoningEffort;
  defaultCodingSessionTitle: (index?: number) => string;
  trimOptional: (value: unknown) => string | null;
  normalizeReasoningEffort: (value: unknown) => ReasoningEffort | null;
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
    const model = options.trimOptional(input.model) ?? options.currentDefaultModel();
    const reasoningEffort = options.normalizeReasoningEffort(input.reasoningEffort) ?? options.currentDefaultEffort(model);
    let securityProfile = options.normalizeSecurityProfile(input.securityProfile);
    if (securityProfile === 'read-only') {
      securityProfile = 'repo-write';
    }
    if (securityProfile === 'full-host' && !currentUser.canUseFullHost) {
      throw new Error('You do not have permission to create full-host sessions.');
    }

    const approvalMode = options.normalizeApprovalMode(input.approvalMode);
    const threadResponse = await options.codex.startThread({
      cwd: workspace.path,
      securityProfile,
      model,
    });

    const session: SessionRecord = {
      id: randomId(),
      ownerUserId: currentUser.id,
      ownerUsername: currentUser.username,
      sessionType: 'code',
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
