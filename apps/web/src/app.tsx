import { useEffect, useLayoutEffect, useRef, useState, type ChangeEvent, type FormEvent, type KeyboardEvent, type MouseEvent as ReactMouseEvent } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

import { TranscriptToolCard } from './transcript-tool-card';
import {
  connectCloudflareTunnel,
  createAdminUser,
  createWorkspace,
  createSession,
  deleteAttachment,
  deleteAdminUser,
  deleteSession,
  disconnectCloudflareTunnel,
  fetchAdminUsers,
  fetchBootstrap,
  fetchSessionDetail,
  fetchSessionTranscript,
  forkSession,
  logout,
  resolveApproval,
  startTurn,
  stopSession,
  uploadAttachment,
  updateSession,
  updateSessionPreferences,
  updateAdminUser,
  updateWorkspace,
} from './api';
import type {
  AdminUserRecord,
  ApprovalMode,
  AppMode,
  BootstrapPayload,
  ConversationSummary,
  ModelOption,
  PendingApproval,
  ReasoningEffort,
  SessionAttachmentSummary,
  SessionDetailResponse,
  SessionRecord,
  SessionSummary,
  SessionTranscriptEntry,
  SessionType,
  SecurityProfile,
  UpdateSessionRequest,
  UserRole,
  WorkspaceSummary,
} from './types';

type Language = 'en' | 'zh';
type UserModalMode = 'create' | 'edit';
type WorkspaceModalMode = 'create' | 'manage';
type SessionConfirmAction = { kind: 'delete'; session: SessionDetailResponse['session'] } | null;
type UiSessionState = 'new' | 'pending' | 'completed' | 'error' | 'processing' | 'stale';

interface UserFormState {
  username: string;
  password: string;
  isAdmin: boolean;
  allowCode: boolean;
  allowChat: boolean;
  canUseFullHost: boolean;
  regenerateToken: boolean;
}

interface SelectOption {
  value: string;
  label: string;
}

const FALLBACK_REASONING: ReasoningEffort[] = ['minimal', 'low', 'medium', 'high'];
const TRANSCRIPT_PAGE_SIZE = 40;
const CREATE_WORKSPACE_OPTION = '__new_workspace__';
const COMPOSER_MAX_LINES = 6;
const OPTIMISTIC_SESSION_PREFIX = '__optimistic_session__:';
const OPTIMISTIC_WORKSPACE_PREFIX = '__optimistic_workspace__:';

const UI_SESSION_STATE_LABELS: Record<Language, Record<UiSessionState, string>> = {
  en: {
    new: 'New',
    pending: 'Pending',
    completed: 'Completed',
    error: 'Error',
    processing: 'Processing',
    stale: 'Stale',
  },
  zh: {
    new: '新建',
    pending: '待处理',
    completed: '已完成',
    error: '错误',
    processing: '处理中',
    stale: '已失效',
  },
};

const CLOUDFLARE_STATE_LABELS: Record<Language, Record<'idle' | 'connecting' | 'connected' | 'error', string>> = {
  en: {
    idle: 'Idle',
    connecting: 'Connecting',
    connected: 'Connected',
    error: 'Error',
  },
  zh: {
    idle: '未连接',
    connecting: '连接中',
    connected: '已连接',
    error: '异常',
  },
};

const COPY = {
  en: {
    unknownError: 'Unknown error',
    hostUnavailableTitle: 'Could not reach the local host service',
    hostUnavailableHint: 'Start `npm run dev:host` and refresh the page.',
    approvals: 'approvals',
    sessions: 'Sessions',
    settings: 'Settings',
    admin: 'Admin',
    users: 'Users',
    languageButton: '中文',
    networkStatusOk: 'Connected',
    networkStatusRecovering: 'Reconnecting',
    networkStatusDown: 'Offline',
    networkStatusComment: 'Shows whether the browser can still reach the local host service.',
    hideSidebar: 'Hide sidebar',
    showSidebar: 'Show sidebar',
    languageSetting: 'Language',
    languageSettingHint: 'Choose the interface language.',
    languageEnglish: 'English',
    languageChinese: '中文',
    languageButtonComment: 'Switch the interface language.',
    adminComment: 'Manage users and access permissions.',
    settingsComment: 'Open system settings and remote access controls.',
    archiveComment: 'Archive this session. You can restore it later.',
    restoreComment: 'Restore this archived session.',
    forkComment: 'Create a copy of this session with the same setup.',
    editComment: 'Edit the title, workspace, or session settings.',
    infoComment: 'View session details such as workspace, owner, and model.',
    deleteComment: 'Permanently delete this session.',
    modelComment: 'Choose which model this session will use for future turns.',
    thinkingComment: 'Set the reasoning depth for future turns in this session.',
    auditModelComment: 'Control how often this session asks for approval.',
    attachComment: 'Attach files to your next prompt.',
    stopComment: 'Stop the active turn.',
    sendComment: 'Send the current prompt.',
    moreActions: 'More actions',
    removeAttachmentComment: 'Remove this attachment from the draft.',
    newSession: 'New session',
    manageWorkspaces: 'Manage',
    manageWorkspacesTitle: 'Manage',
    createWorkspaceTitle: 'Create',
    createWorkspaceAction: 'Create',
    visibleWorkspaces: 'Visible',
    moveWorkspaceUp: 'Move up',
    moveWorkspaceDown: 'Move down',
    noActiveSessions: 'No active sessions yet.',
    activeSessionsLabel: 'Active',
    archivedSessionsLabel: 'Archived',
    archivedHistory: 'Archived',
    history: 'History',
    hideArchived: 'Hide archived',
    transcript: 'Chat',
    commands: 'Commands',
    changes: 'Changes',
    activity: 'Activity',
    approvalNeeded: 'Approval required',
    approvalNeededHint: 'Codex is waiting for your decision before continuing this turn.',
    processingStatus: 'Processing',
    processingHint: 'Codex is still working on this turn. More messages may appear before it ends.',
    approvalPendingStatus: 'Pending',
    approvalPendingHint: 'Waiting for your decision. Once approved, this turn will continue.',
    turnCompleteStatus: 'Completed',
    turnCompleteHint: 'This turn has finished. Your next message will start a new turn.',
    staleStatus: 'Stale',
    staleHint: 'The runtime lost this thread. Your next prompt will automatically start a fresh one.',
    errorStatus: 'Error',
    errorHint: 'This session hit an error. Review the issue and send the next prompt to continue.',
    moreApprovals: '{count} more pending',
    approvalKeyboardHint: 'Use ↑ ↓ to choose, Enter to confirm.',
    toolCommand: 'Command',
    toolFiles: 'Files',
    toolEvent: 'Tool',
    selectOrCreate: 'Select a session to continue working.',
    runtimeReset: 'Runtime reset detected',
    threadMissing: 'Codex no longer has this thread loaded',
    autoRestartHint: 'The next prompt will automatically create a fresh thread in this session.',
    archivedEyebrow: 'Archived session',
    historyMode: 'This session is archived',
    historyModeHint: 'Restore it if you want to keep using the same workspace.',
    restoreSession: 'Restore session',
    noTurnsYet: 'New',
    noTurnsHint: 'Send the first prompt from the composer below.',
    noCommandsYet: 'No command executions yet',
    noCommandsHint: 'Tool calls from Codex will appear here.',
    noChangesYet: 'No file changes yet',
    noChangesHint: 'When Codex edits files, the paths and inline diffs will appear here.',
    noInlineDiff: 'No inline diff payload was reported for this change.',
    sessionState: 'Session state',
    liveEvents: 'Live host events',
    noTransportEvents: 'No transport events captured yet.',
    createdAt: 'Created',
    updatedAt: 'Updated',
    prompt: 'Prompt',
    sendPrompt: 'Send',
    sending: 'Sending...',
    stop: 'Stop',
    stopping: 'Stopping...',
    restoreRequired: 'Unavailable',
    approvalCenter: 'Approval center',
    pendingRequests: 'pending',
    noPendingApprovals: 'No pending approvals',
    approvalsHint: 'Codex approval requests will appear here.',
    approveOnce: 'Approve once',
    approveSession: 'Approve session',
    decline: 'Decline',
    close: 'Close',
    signOut: 'Sign out',
    signingOut: 'Signing out...',
    settingsTitle: 'System controls',
    remoteAccess: 'Remote access',
    tunnelUnavailable: 'Tunnel status unavailable',
    noPublicUrl: 'No public URL available yet',
    connectTunnel: 'Connect tunnel',
    connecting: 'Connecting...',
    tunnelLive: 'Tunnel already live',
    managedBySystem: 'Managed by system',
    disconnect: 'Disconnect',
    disconnecting: 'Disconnecting...',
    account: 'Account',
    roleLabel: 'Role',
    standardRole: 'User',
    defaults: 'Defaults',
    browserShell: 'Codex-first browser shell',
    networkOffByDefault: 'Network off by default',
    networkOnByDefault: 'Network on by default',
    newSessionTitle: 'Create a session',
    sessionType: 'Session type',
    codeSession: 'Code',
    chatSession: 'Chat',
    workspace: 'Workspace',
    workspaceRequired: 'Choose a workspace.',
    titleRequired: 'Title is required when creating a new workspace.',
    workspaceSelect: 'Choose workspace',
    newWorkspaceOption: 'Create from title',
    title: 'Title',
    optionalSessionTitle: 'Optional session title',
    securityProfile: 'Security profile',
    approvalModeLabel: 'Audit Model',
    model: 'Model',
    thinking: 'Thinking',
    readOnlyProfile: 'read-only',
    repoWriteProfile: 'Write Only',
    fullHostProfile: 'Full',
    lessApprovalMode: 'Minimal approval',
    fullApprovalMode: 'Always ask',
    chatSessionHint: 'Chat sessions always run in read-only mode.',
    chatAutoTitleHint: 'The title will be generated automatically after your first message.',
    workspaceFolder: 'New folder',
    workspacePreview: 'Workspace preview',
    managedWorkspaceHint: 'Managed workspaces live under `~/Coding/<username>`.',
    resizeComposer: 'Resize composer',
    createSession: 'Create session',
    creating: 'Creating...',
    renameSessionTitle: 'Edit session',
    saveName: 'Save session',
    renaming: 'Saving...',
    sessionContextResetHint: 'Changing the workspace or code permissions starts a fresh thread for this session.',
    sessionDeletedConfirm: 'Delete "{title}" permanently? This only removes it from remote-vibe-coding.',
    archiveSessionConfirm: 'Archive "{title}"? You can restore it later.',
    confirmArchiveTitle: 'Archive session',
    confirmDeleteTitle: 'Delete session',
    confirmAction: 'Confirm',
    archive: 'Archive',
    restore: 'Restore',
    delete: 'Delete',
    fork: 'Fork',
    forking: 'Forking...',
    rename: 'Edit',
    archiving: 'Archiving...',
    restoring: 'Restoring...',
    deleting: 'Deleting...',
    currentSession: 'Current session',
    noActiveSession: 'No active session',
    inspectWorkspaceHint: 'Select a session to inspect its workspace.',
    localHost: 'local host',
    staleSession: 'stale session',
    freshThread: 'Fresh thread or not yet loaded',
    noGitMetadata: 'No git metadata',
    noRemoteReported: 'No remote reported yet',
    networkEnabled: 'Network enabled',
    networkDisabled: 'Network disabled',
    currentToken: 'Token',
    newUser: 'New user',
    editUser: 'Edit user',
    username: 'Username',
    password: 'Password',
    optionalPassword: 'Leave blank to keep the current password',
    adminRole: 'Admin',
    canUseFullHost: 'Can use full-host',
    allowedSessionTypes: 'Allowed session types',
    saveUser: 'Save user',
    createUser: 'Create user',
    creatingUser: 'Creating...',
    savingUser: 'Saving...',
    regenerateToken: 'Regenerate token',
    deleteUser: 'Delete user',
    deleteUserConfirm: 'Delete user "{username}"?',
    noUsersYet: 'No users yet',
    sessionOwner: 'Owner',
    securityLabel: 'Security',
    modelLabel: 'Model',
    thinkingLabel: 'Thinking',
    threadLabel: 'Thread',
    info: 'Info',
    sessionInfoTitle: 'Session info',
    archived: 'Archived',
    active: 'active',
    commandToolingHidden: 'Chat sessions stay in conversation-only mode, so tool views are hidden.',
    noActiveSelection: 'No active selection',
    pickSessionHint: 'Pick an existing session, or create a new one.',
    loadingOlderMessages: 'Loading older messages…',
    attachFiles: 'Attach files',
    uploadingFiles: 'Uploading…',
    removeAttachment: 'Remove attachment',
  },
  zh: {
    unknownError: '未知错误',
    hostUnavailableTitle: '无法连接本地 Host 服务',
    hostUnavailableHint: '先启动 `npm run dev:host`，然后刷新页面。',
    approvals: '审批',
    sessions: '会话',
    settings: '设置',
    admin: '管理',
    users: '用户',
    languageButton: 'EN',
    networkStatusOk: '网络正常',
    networkStatusRecovering: '正在重连',
    networkStatusDown: '已离线',
    networkStatusComment: '显示浏览器当前是否还能连接到本地 Host 服务。',
    hideSidebar: '隐藏侧栏',
    showSidebar: '显示侧栏',
    languageSetting: '语言',
    languageSettingHint: '选择界面语言。',
    languageEnglish: 'English',
    languageChinese: '中文',
    languageButtonComment: '切换界面语言。',
    adminComment: '管理用户和访问权限。',
    settingsComment: '打开系统设置和远程访问控制。',
    archiveComment: '归档当前会话，之后仍然可以恢复。',
    restoreComment: '恢复这个已归档会话。',
    forkComment: '复制一个使用相同配置的新会话。',
    editComment: '修改标题、workspace 或会话设置。',
    infoComment: '查看 workspace、所有者、模型等会话详情。',
    deleteComment: '永久删除这个会话。',
    modelComment: '选择这个会话后续 turn 使用的模型。',
    thinkingComment: '设置这个会话后续 turn 的思考深度。',
    auditModelComment: '控制这个会话触发审批的频率。',
    attachComment: '给下一条 prompt 附加文件。',
    stopComment: '停止当前正在运行的 turn。',
    sendComment: '发送当前 prompt。',
    moreActions: '更多操作',
    removeAttachmentComment: '把这个附件从草稿里移除。',
    newSession: '新建会话',
    manageWorkspaces: '管理 Workspace',
    manageWorkspacesTitle: '管理 Workspace',
    createWorkspaceTitle: '创建',
    createWorkspaceAction: '创建',
    visibleWorkspaces: '展示中',
    moveWorkspaceUp: '上移',
    moveWorkspaceDown: '下移',
    noActiveSessions: '暂时还没有活跃会话。',
    activeSessionsLabel: '正常',
    archivedSessionsLabel: '归档',
    archivedHistory: '归档',
    history: '历史',
    hideArchived: '收起归档',
    transcript: '聊天',
    commands: '命令',
    changes: '改动',
    activity: '活动',
    approvalNeeded: '需要审批',
    approvalNeededHint: 'Codex 正在等待你的决定，当前 turn 会在审批后继续。',
    processingStatus: '处理中',
    processingHint: '当前这一轮还在处理中，结束前还可能继续追加回复。',
    approvalPendingStatus: '待处理',
    approvalPendingHint: '正在等待你的决定，审批通过后这一轮会继续。',
    turnCompleteStatus: '已完成',
    turnCompleteHint: '这一轮已经结束，你下一次发送会开始新的 turn。',
    staleStatus: '已失效',
    staleHint: '运行时已经丢失这个线程。你下一次发送消息时，会自动创建新的 thread。',
    errorStatus: '错误',
    errorHint: '这个会话刚刚遇到错误。查看问题后，可以继续发送下一条消息。',
    moreApprovals: '还有 {count} 个待处理',
    approvalKeyboardHint: '用 ↑ ↓ 选择，按 Enter 确认。',
    toolCommand: '命令',
    toolFiles: '改动',
    toolEvent: '工具',
    selectOrCreate: '选择一个会话继续工作。',
    runtimeReset: '运行时已重置',
    threadMissing: 'Codex 已经不再持有这个 thread',
    autoRestartHint: '你下一次发送消息时，会自动在这个会话里创建新的 thread。',
    archivedEyebrow: '已归档会话',
    historyMode: '这个会话已经归档',
    historyModeHint: '如果你想继续使用同一个 workspace，先恢复它。',
    restoreSession: '恢复会话',
    noTurnsYet: '新建',
    noTurnsHint: '从下面的输入框发出第一条消息。',
    noCommandsYet: '还没有命令执行',
    noCommandsHint: 'Codex 的工具调用会显示在这里。',
    noChangesYet: '还没有文件改动',
    noChangesHint: '当 Codex 修改文件时，这里会显示路径和内联 diff。',
    noInlineDiff: '这条改动没有携带内联 diff。',
    sessionState: '会话状态',
    liveEvents: '实时 Host 事件',
    noTransportEvents: '暂时还没有传输层事件。',
    createdAt: '创建于',
    updatedAt: '更新于',
    prompt: '输入内容',
    sendPrompt: '发送',
    sending: '发送中...',
    stop: '停止',
    stopping: '停止中...',
    restoreRequired: '当前不可用',
    approvalCenter: '审批中心',
    pendingRequests: '个待处理',
    noPendingApprovals: '没有待审批项',
    approvalsHint: 'Codex 的审批请求会出现在这里。',
    approveOnce: '仅批准这次',
    approveSession: '本会话内批准',
    decline: '拒绝',
    close: '关闭',
    signOut: '退出登录',
    signingOut: '退出中...',
    settingsTitle: '系统控制',
    remoteAccess: '远程访问',
    tunnelUnavailable: 'Tunnel 状态暂不可用',
    noPublicUrl: '还没有公网地址',
    connectTunnel: '连接 Tunnel',
    connecting: '连接中...',
    tunnelLive: 'Tunnel 已在线',
    managedBySystem: '由系统托管',
    disconnect: '断开连接',
    disconnecting: '断开中...',
    account: '账户',
    roleLabel: '角色',
    standardRole: '普通用户',
    defaults: '默认值',
    browserShell: 'Codex 优先的浏览器壳',
    networkOffByDefault: '默认关闭网络',
    networkOnByDefault: '默认开启网络',
    newSessionTitle: '创建会话',
    sessionType: '会话类型',
    codeSession: '代码',
    chatSession: '聊天',
    workspace: '工作目录',
    workspaceRequired: '请选择 workspace。',
    titleRequired: '使用标题名新建 workspace 时，标题是必填项。',
    workspaceSelect: '选择 workspace',
    newWorkspaceOption: '用标题名新建',
    title: '标题',
    optionalSessionTitle: '可选的会话标题',
    securityProfile: '安全档位',
    approvalModeLabel: '审批 Model',
    model: '模型',
    thinking: '思考强度',
    readOnlyProfile: '只读',
    repoWriteProfile: 'Write Only',
    fullHostProfile: 'Full',
    lessApprovalMode: '尽可能不审批',
    fullApprovalMode: '全部需要审批',
    chatSessionHint: '聊天会话固定为只读模式。',
    chatAutoTitleHint: '发出第一条消息后，会自动生成标题。',
    workspaceFolder: '新建文件夹',
    workspacePreview: 'Workspace 预览',
    managedWorkspaceHint: '托管 workspace 会创建在 `~/Coding/<用户名>` 下。',
    resizeComposer: '调整输入框高度',
    createSession: '创建会话',
    creating: '创建中...',
    renameSessionTitle: '编辑会话',
    saveName: '保存会话',
    renaming: '保存中...',
    sessionContextResetHint: '修改 workspace 或代码权限后，这个会话会从新的 thread 继续。',
    sessionDeletedConfirm: '确定永久删除 “{title}” 吗？这只会把它从 remote-vibe-coding 中移除。',
    archiveSessionConfirm: '确定归档 “{title}” 吗？之后仍然可以恢复。',
    confirmArchiveTitle: '归档会话',
    confirmDeleteTitle: '删除会话',
    confirmAction: '确认',
    archive: '归档',
    restore: '恢复',
    delete: '删除',
    fork: 'Fork',
    forking: 'Fork 中...',
    rename: '编辑',
    archiving: '归档中...',
    restoring: '恢复中...',
    deleting: '删除中...',
    currentSession: '当前会话',
    noActiveSession: '当前没有活跃会话',
    inspectWorkspaceHint: '选中一个会话后，这里会显示它的 workspace。',
    localHost: '本地 host',
    staleSession: '已失效会话',
    freshThread: '新的 thread，或暂时还没加载',
    noGitMetadata: '没有 Git 元信息',
    noRemoteReported: '还没有上报远端仓库信息',
    networkEnabled: '已开启网络',
    networkDisabled: '未开启网络',
    currentToken: 'Token',
    newUser: '新增用户',
    editUser: '编辑用户',
    username: '用户名',
    password: '密码',
    optionalPassword: '留空则保持当前密码不变',
    adminRole: '管理员',
    canUseFullHost: '可使用 full-host',
    allowedSessionTypes: '允许的会话类型',
    saveUser: '保存用户',
    createUser: '创建用户',
    creatingUser: '创建中...',
    savingUser: '保存中...',
    regenerateToken: '重置 token',
    deleteUser: '删除用户',
    deleteUserConfirm: '确定删除用户 “{username}” 吗？',
    noUsersYet: '暂时还没有用户',
    sessionOwner: 'Owner',
    securityLabel: '安全',
    modelLabel: '模型',
    thinkingLabel: '思考强度',
    threadLabel: '线程',
    info: '信息',
    sessionInfoTitle: '会话信息',
    archived: '归档',
    active: '活跃',
    commandToolingHidden: '聊天会话保持纯对话模式，所以工具视图默认隐藏。',
    noActiveSelection: '当前没有选中会话',
    pickSessionHint: '选择一个已有会话，或者新建一个会话。',
    loadingOlderMessages: '正在加载更早的消息…',
    attachFiles: '添加文件',
    uploadingFiles: '上传中…',
    removeAttachment: '移除附件',
  },
} as const;

function formatTimestamp(value: string, language: Language) {
  return new Date(value).toLocaleString(language === 'zh' ? 'zh-CN' : 'en-US');
}

function shortThreadId(threadId: string) {
  return threadId.slice(0, 8);
}

function pickPreferredSessionId(
  sessions: Array<{ id: string }>,
) {
  return sessions[0]?.id ?? null;
}

function mergeTranscriptEntries(current: SessionTranscriptEntry[], incoming: SessionTranscriptEntry[]) {
  const merged = new Map<number, SessionTranscriptEntry>();

  for (const entry of current) {
    merged.set(entry.index, entry);
  }
  for (const entry of incoming) {
    merged.set(entry.index, entry);
  }

  return [...merged.values()].sort((left, right) => left.index - right.index);
}

function deriveSummarySessionState(session: SessionSummary | ConversationSummary): UiSessionState {
  if ('pendingApprovalCount' in session && session.pendingApprovalCount > 0) {
    return 'pending';
  }
  if (session.status === 'needs-approval') {
    return 'pending';
  }
  if (session.status === 'running') {
    return 'processing';
  }
  if (session.status === 'error') {
    return 'error';
  }
  if (session.status === 'stale') {
    return 'stale';
  }
  return session.hasTranscript ? 'completed' : 'new';
}

function deriveDetailSessionState(
  session: SessionDetailResponse['session'] | null,
  options: {
    activeApproval: PendingApproval | null;
    transcriptCount: number;
    busy: string | null;
    hasActiveTurn: boolean;
  },
): UiSessionState | null {
  if (!session) {
    return null;
  }
  if (options.activeApproval || session.status === 'needs-approval') {
    return 'pending';
  }
  if (session.status === 'error') {
    return 'error';
  }
  if (options.busy === 'start-turn' || options.busy === 'create-session' || options.hasActiveTurn || session.status === 'running') {
    return 'processing';
  }
  if (session.status === 'stale') {
    return 'stale';
  }
  return options.transcriptCount === 0 ? 'new' : 'completed';
}

function uiSessionStateLabel(language: Language, state: UiSessionState) {
  return UI_SESSION_STATE_LABELS[language][state];
}

function workspaceNameFromPath(workspacePath: string, workspaceRoot: string | null | undefined) {
  if (workspaceRoot && workspacePath.startsWith(`${workspaceRoot}/`)) {
    return workspacePath.slice(workspaceRoot.length + 1);
  }
  return workspacePath.split('/').filter(Boolean).pop() ?? workspacePath;
}

function workspaceNameForSession(
  session: Pick<SessionRecord, 'workspaceId' | 'workspace'> | Pick<SessionSummary, 'workspaceId' | 'workspace'>,
  workspaces: WorkspaceSummary[],
  workspaceRoot: string | null | undefined,
) {
  return workspaces.find((workspace) => workspace.id === session.workspaceId)?.name
    ?? workspaceNameFromPath(session.workspace, workspaceRoot);
}

function normalizeWorkspaceSegment(value: string | null | undefined, fallback: string) {
  const normalized = (value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');

  if (!normalized || normalized === '.' || normalized === '..') {
    return fallback;
  }

  return normalized;
}

function isOptimisticSessionId(sessionId: string | null | undefined) {
  return Boolean(sessionId && sessionId.startsWith(OPTIMISTIC_SESSION_PREFIX));
}

function nextForkedSessionTitle(title: string) {
  const match = title.match(/^(.*) \((\d+)\)$/);
  if (!match) {
    return `${title} (2)`;
  }

  const baseTitle = match[1] ?? title;
  const currentIndex = match[2] ?? '1';
  const nextIndex = Number.parseInt(currentIndex, 10);
  if (!Number.isFinite(nextIndex)) {
    return `${title} (2)`;
  }

  return `${baseTitle} (${nextIndex + 1})`;
}

function toSessionSummary(
  session: SessionRecord,
  previous?: SessionSummary | null,
  lastUpdate?: string,
): SessionSummary {
  return {
    ...session,
    lastUpdate: lastUpdate ?? previous?.lastUpdate ?? session.updatedAt,
    pendingApprovalCount: previous?.pendingApprovalCount ?? 0,
  };
}

function optimisticDetail(session: SessionDetailResponse['session']): SessionDetailResponse {
  return {
    session,
    approvals: [],
    liveEvents: [],
    thread: null,
    transcriptTotal: 0,
    commands: [],
    changes: [],
    draftAttachments: [],
  };
}

function securityProfileLabel(language: Language, sessionType: SessionType, securityProfile: SecurityProfile) {
  const copy = COPY[language];
  if (sessionType === 'chat') {
    return copy.readOnlyProfile;
  }
  return securityProfile === 'full-host' ? copy.fullHostProfile : copy.repoWriteProfile;
}

function approvalModeLabel(language: Language, approvalMode: ApprovalMode) {
  const copy = COPY[language];
  return approvalMode === 'full-approval' ? copy.fullApprovalMode : copy.lessApprovalMode;
}

function preferredReasoningEffort(option: Pick<ModelOption, 'defaultReasoningEffort' | 'supportedReasoningEfforts'> | null | undefined) {
  if (!option) return 'medium' as const;
  if (option.supportedReasoningEfforts.includes('medium')) {
    return 'medium' as const;
  }
  if (option.supportedReasoningEfforts.includes(option.defaultReasoningEffort)) {
    return option.defaultReasoningEffort;
  }
  return option.supportedReasoningEfforts[0] ?? 'medium';
}

function toolLabel(entry: SessionTranscriptEntry, language: Language) {
  if (entry.label === 'command') {
    return language === 'zh' ? '命令' : 'Command';
  }
  if (entry.label === 'files') {
    return language === 'zh' ? '改动' : 'Files';
  }
  return language === 'zh' ? '工具' : 'Tool';
}

function formatRemainingApprovals(count: number, language: Language) {
  if (count <= 0) return '';
  return language === 'zh'
    ? `还有 ${count} 个待处理`
    : `${count} more pending`;
}

function formatAttachmentSize(sizeBytes: number) {
  if (sizeBytes < 1024) return `${sizeBytes} B`;
  if (sizeBytes < 1024 * 1024) return `${(sizeBytes / 1024).toFixed(1)} KB`;
  return `${(sizeBytes / (1024 * 1024)).toFixed(1)} MB`;
}

function isTranscriptNearBottom(scrollContainer: HTMLDivElement) {
  return (scrollContainer.scrollHeight - (scrollContainer.scrollTop + scrollContainer.clientHeight)) < 96;
}

function firstAllowedSessionType(bootstrap: BootstrapPayload | null): SessionType {
  return bootstrap?.currentUser.allowedSessionTypes[0] ?? 'code';
}

function modeLabel(language: Language, mode: AppMode) {
  if (mode === 'developer') {
    return language === 'zh' ? '开发' : 'Developer';
  }
  return language === 'zh' ? '聊天' : 'Chat';
}

function roleLabel(language: Language, role: UserRole) {
  if (role === 'admin') {
    return language === 'zh' ? '管理员' : 'Admin';
  }
  if (role === 'developer') {
    return language === 'zh' ? '开发者' : 'Developer';
  }
  return language === 'zh' ? '用户' : 'User';
}

function deriveRolesFromLegacy(user: BootstrapPayload['currentUser'] | null | undefined): UserRole[] {
  const rawRoles = Array.isArray((user as { roles?: unknown } | null | undefined)?.roles)
    ? (user as { roles: unknown[] }).roles
    : null;
  if (rawRoles) {
    const roles = rawRoles.filter((role): role is UserRole => role === 'user' || role === 'developer' || role === 'admin');
    if (roles.length > 0) {
      return roles;
    }
  }

  const legacyTypes = Array.isArray(user?.allowedSessionTypes) ? user.allowedSessionTypes : [];
  const roles: UserRole[] = [];
  if (legacyTypes.includes('chat')) {
    roles.push('user');
  }
  if (legacyTypes.includes('code')) {
    roles.push('developer');
  }
  if ((user as { isAdmin?: boolean } | null | undefined)?.isAdmin) {
    roles.push('admin');
  }
  return roles.length > 0 ? roles : ['user'];
}

function derivedAvailableModes(bootstrap: BootstrapPayload | null): AppMode[] {
  const rawModes = Array.isArray((bootstrap as { availableModes?: unknown } | null)?.availableModes)
    ? (bootstrap as { availableModes: unknown[] }).availableModes.filter((mode): mode is AppMode => mode === 'chat' || mode === 'developer')
    : [];
  if (rawModes.length > 0) {
    return rawModes;
  }

  const roles = deriveRolesFromLegacy(bootstrap?.currentUser);
  const modes: AppMode[] = [];
  if (roles.includes('developer')) {
    modes.push('developer');
  }
  if (roles.includes('user')) {
    modes.push('chat');
  }
  return modes.length > 0 ? modes : ['chat'];
}

function normalizedWorkspaces(bootstrap: BootstrapPayload | null): WorkspaceSummary[] {
  const rawWorkspaces = Array.isArray((bootstrap as { workspaces?: unknown } | null)?.workspaces)
    ? (bootstrap as { workspaces: Array<{ id?: string; name?: string; path?: string; visible?: boolean; sortOrder?: number }> }).workspaces
    : [];
  return rawWorkspaces
    .filter((workspace) => typeof workspace.name === 'string' && typeof workspace.path === 'string')
    .map((workspace, index) => ({
      id: workspace.id ?? workspace.path ?? workspace.name ?? '',
      name: workspace.name ?? '',
      path: workspace.path ?? '',
      visible: workspace.visible ?? true,
      sortOrder: typeof workspace.sortOrder === 'number' ? workspace.sortOrder : index,
    }));
}

function normalizedDeveloperSessions(bootstrap: BootstrapPayload | null): SessionSummary[] {
  const rawSessions = Array.isArray((bootstrap as unknown as { sessions?: unknown } | null)?.sessions)
    ? (bootstrap as unknown as { sessions: Array<Record<string, unknown>> }).sessions
    : [];
  return rawSessions
    .filter((session): session is Record<string, unknown> & SessionSummary => session.sessionType !== 'chat')
    .map((session) => ({
      ...(session as SessionSummary),
      workspaceId: typeof session.workspaceId === 'string'
        ? session.workspaceId
        : String(session.workspace ?? session.id),
    }));
}

function normalizedConversations(bootstrap: BootstrapPayload | null): ConversationSummary[] {
  const rawConversations = Array.isArray((bootstrap as { conversations?: unknown } | null)?.conversations)
    ? (bootstrap as { conversations: ConversationSummary[] }).conversations
    : null;
  if (rawConversations) {
    return rawConversations;
  }

  const rawSessions = Array.isArray((bootstrap as unknown as { sessions?: unknown } | null)?.sessions)
    ? (bootstrap as unknown as { sessions: Array<Record<string, unknown>> }).sessions
    : [];
  return rawSessions
    .filter((session): session is Record<string, unknown> & ConversationSummary => session.sessionType === 'chat')
    .map((session) => ({
      ...(session as ConversationSummary),
      lastUpdate: typeof session.lastUpdate === 'string' ? session.lastUpdate : String(session.updatedAt ?? ''),
    }));
}

function pickDefaultMode(bootstrap: BootstrapPayload | null, currentMode: AppMode) {
  if (!bootstrap) return currentMode;
  const modes = derivedAvailableModes(bootstrap);
  if (modes.includes(currentMode)) {
    return currentMode;
  }
  if (typeof window !== 'undefined') {
    const stored = window.localStorage.getItem('rvc-mode');
    if ((stored === 'chat' || stored === 'developer') && modes.includes(stored)) {
      return stored;
    }
  }
  const preferredMode = (bootstrap.currentUser as { preferredMode?: AppMode | null } | undefined)?.preferredMode;
  if (preferredMode && modes.includes(preferredMode)) {
    return preferredMode;
  }
  const rawDefaultMode = (bootstrap as { defaultMode?: AppMode } | null)?.defaultMode;
  if (rawDefaultMode && modes.includes(rawDefaultMode)) {
    return rawDefaultMode;
  }
  return modes.includes('developer') ? 'developer' : 'chat';
}

function pickPreferredWorkspaceId(
  workspaces: WorkspaceSummary[],
  sessions: Array<{ workspaceId: string }>,
) {
  return sessions[0]?.workspaceId ?? workspaces[0]?.id ?? null;
}

function isFixedChatWorkspace(workspace: Pick<WorkspaceSummary, 'name'>) {
  const normalized = workspace.name.trim().toLowerCase();
  return normalized === 'chat' || /^chat-[a-z0-9]{8}$/i.test(normalized);
}

function selectableDeveloperWorkspaces(workspaces: WorkspaceSummary[]) {
  return workspaces.filter((workspace) => !isFixedChatWorkspace(workspace));
}

function sortWorkspaceSummaries(workspaces: WorkspaceSummary[]) {
  return [...workspaces].sort((left, right) => (
    left.sortOrder - right.sortOrder || left.name.localeCompare(right.name)
  ));
}

function visibleDeveloperWorkspaces(workspaces: WorkspaceSummary[]) {
  return sortWorkspaceSummaries(selectableDeveloperWorkspaces(workspaces)
    .filter((workspace) => workspace.visible)
  );
}

function mergeWorkspaceIds(currentIds: string[], ...workspaceIds: Array<string | null | undefined>) {
  const next = [...currentIds];
  for (const workspaceId of workspaceIds) {
    if (!workspaceId || next.includes(workspaceId)) continue;
    next.push(workspaceId);
  }
  return next;
}

function defaultUserForm(): UserFormState {
  return {
    username: '',
    password: '',
    isAdmin: false,
    allowCode: false,
    allowChat: true,
    canUseFullHost: false,
    regenerateToken: false,
  };
}

function InfoIcon() {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <circle cx="10" cy="10" r="7" fill="none" stroke="currentColor" strokeWidth="1.7" />
      <path d="M10 8.1v4.8M10 6.1h.01" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function EditIcon() {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <path d="M4.7 13.9 13.9 4.7l1.4 1.4-9.2 9.2-2 .6.6-2Z" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
      <path d="m12.9 5.7 1.4-1.4a1.4 1.4 0 0 1 2 2l-1.4 1.4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function ChevronIcon({ open }: { open: boolean }) {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <path
        d={open ? 'm5.5 11.8 4.5-4.5 4.5 4.5' : 'm7.2 5.5 4.5 4.5-4.5 4.5'}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

interface AppSelectProps {
  value: string;
  options: SelectOption[];
  onChange: (value: string) => void;
  disabled?: boolean;
  className?: string;
  ariaLabel?: string;
}

function AppSelect({ value, options, onChange, disabled = false, className, ariaLabel }: AppSelectProps) {
  const [open, setOpen] = useState(false);
  const [highlightedValue, setHighlightedValue] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const selectedOption = options.find((option) => option.value === value) ?? options[0] ?? null;
  const selectedValue = selectedOption?.value ?? null;
  const firstOptionValue = options[0]?.value ?? null;
  const effectiveDisabled = disabled || options.length === 0;

  useEffect(() => {
    if (!open) return;

    function handlePointerDown(event: MouseEvent) {
      if (!rootRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    }

    window.addEventListener('mousedown', handlePointerDown);
    return () => {
      window.removeEventListener('mousedown', handlePointerDown);
    };
  }, [open]);

  useEffect(() => {
    if (effectiveDisabled) {
      setOpen(false);
    }
  }, [effectiveDisabled]);

  useEffect(() => {
    if (!open) return;
    setHighlightedValue(selectedValue ?? firstOptionValue);
  }, [open, selectedValue, firstOptionValue]);

  function selectOption(nextValue: string) {
    onChange(nextValue);
    setOpen(false);
  }

  function moveHighlight(direction: 1 | -1) {
    if (options.length === 0) return;

    const currentValue = open ? highlightedValue : selectedValue;
    const currentIndex = options.findIndex((option) => option.value === currentValue);
    const startIndex = currentIndex >= 0 ? currentIndex : 0;
    const nextIndex = (startIndex + direction + options.length) % options.length;
    const nextValue = options[nextIndex]?.value ?? null;

    setOpen(true);
    setHighlightedValue(nextValue);
  }

  function handleTriggerKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    if (effectiveDisabled) return;

    if (event.key === 'ArrowDown') {
      event.preventDefault();
      moveHighlight(1);
      return;
    }

    if (event.key === 'ArrowUp') {
      event.preventDefault();
      moveHighlight(-1);
      return;
    }

    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      if (open) {
        const nextValue = highlightedValue ?? selectedValue ?? options[0]?.value;
        if (nextValue) {
          selectOption(nextValue);
        }
      } else {
        setOpen(true);
      }
      return;
    }

    if (event.key === 'Escape') {
      if (open) {
        event.preventDefault();
        setOpen(false);
      }
      return;
    }

    if (event.key === 'Home' && open && options.length > 0) {
      event.preventDefault();
      setHighlightedValue(options[0]?.value ?? null);
      return;
    }

    if (event.key === 'End' && open && options.length > 0) {
      event.preventDefault();
      setHighlightedValue(options[options.length - 1]?.value ?? null);
      return;
    }

    if (event.key === 'Tab') {
      setOpen(false);
    }
  }

  return (
    <div ref={rootRef} className={`app-select ${className ?? ''} ${open ? 'app-select-open' : ''}`.trim()}>
      <button
        type="button"
        className="app-select-trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
        disabled={effectiveDisabled}
        onClick={() => setOpen((current) => !current)}
        onKeyDown={handleTriggerKeyDown}
      >
        <span className="app-select-value">{selectedOption?.label ?? ''}</span>
        <ChevronIcon open={open} />
      </button>

      {open ? (
        <div className="app-select-menu" role="listbox" aria-label={ariaLabel}>
          {options.map((option) => {
            const isSelected = option.value === selectedValue;
            const isHighlighted = option.value === highlightedValue;
            return (
              <button
                key={option.value}
                type="button"
                role="option"
                aria-selected={isSelected}
                className={`app-select-option ${isSelected ? 'app-select-option-selected' : ''} ${isHighlighted ? 'app-select-option-highlighted' : ''}`.trim()}
                onMouseEnter={() => setHighlightedValue(option.value)}
                onClick={() => selectOption(option.value)}
              >
                <span>{option.label}</span>
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

function SendIcon() {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <path d="M3.4 9.8 16.2 3.7l-2.8 12.6-4.1-4.2-3 .9 1.4-3.2-4.3-.8Z" fill="currentColor" />
    </svg>
  );
}

function MoreIcon() {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <circle cx="4.5" cy="10" r="1.4" fill="currentColor" />
      <circle cx="10" cy="10" r="1.4" fill="currentColor" />
      <circle cx="15.5" cy="10" r="1.4" fill="currentColor" />
    </svg>
  );
}

function StopIcon() {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <rect x="5.7" y="5.7" width="8.6" height="8.6" rx="1.4" fill="currentColor" />
    </svg>
  );
}

function AttachmentIcon() {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <path
        d="M7.3 10.6 12 5.9a2.3 2.3 0 1 1 3.2 3.2l-5.6 5.6a3.6 3.6 0 1 1-5.1-5.1l6-6"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function RemoveIcon() {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <path
        d="m6 6 8 8M14 6l-8 8"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
      />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <path
        d="m4.8 10.3 3.2 3.2 7.2-7.2"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function SidebarIcon({ collapsed = false }: { collapsed?: boolean }) {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <rect x="3" y="4" width="14" height="12" rx="2" fill="none" stroke="currentColor" strokeWidth="1.6" />
      <path d={collapsed ? 'M7.7 6.4v7.2M9.7 10h4.6' : 'M7.7 6.4v7.2M10.3 10h4'} fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

export function App() {
  const [language, setLanguage] = useState<Language>(() => {
    if (typeof window === 'undefined') return 'en';
    const stored = window.localStorage.getItem('rvc-language');
    if (stored === 'zh' || stored === 'en') return stored;
    return window.navigator.language.toLowerCase().startsWith('zh') ? 'zh' : 'en';
  });
  const [browserOnline, setBrowserOnline] = useState(() => {
    if (typeof window === 'undefined') return true;
    return window.navigator.onLine;
  });
  const [hostReachable, setHostReachable] = useState(true);
  const [activeMode, setActiveMode] = useState<AppMode>(() => {
    if (typeof window === 'undefined') return 'developer';
    const stored = window.localStorage.getItem('rvc-mode');
    return stored === 'chat' || stored === 'developer' ? stored : 'developer';
  });
  const [bootstrap, setBootstrap] = useState<BootstrapPayload | null>(null);
  const [detail, setDetail] = useState<SessionDetailResponse | null>(null);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string | null>(null);
  const [expandedWorkspaceIds, setExpandedWorkspaceIds] = useState<string[]>([]);
  const [sessionMenuSessionId, setSessionMenuSessionId] = useState<string | null>(null);
  const [pendingSessionRailAction, setPendingSessionRailAction] = useState<{ kind: 'edit' | 'info'; sessionId: string } | null>(null);
  const [detailMenuOpen, setDetailMenuOpen] = useState(false);
  const [railHidden, setRailHidden] = useState(false);
  const [railWidth, setRailWidth] = useState(() => {
    if (typeof window === 'undefined') return 320;
    const stored = Number(window.localStorage.getItem('rvc-rail-width') ?? '320');
    return Number.isFinite(stored) ? Math.min(520, Math.max(260, stored)) : 320;
  });
  const [error, setError] = useState<string | null>(null);
  const [prompt, setPrompt] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [adminOpen, setAdminOpen] = useState(false);
  const [sessionInfoOpen, setSessionInfoOpen] = useState(false);
  const [adminUsers, setAdminUsers] = useState<AdminUserRecord[] | null>(null);
  const [workspaceModalMode, setWorkspaceModalMode] = useState<WorkspaceModalMode | null>(null);
  const [newSessionOpen, setNewSessionOpen] = useState(false);
  const [optimisticSessions, setOptimisticSessions] = useState<SessionSummary[]>([]);
  const [optimisticConversations, setOptimisticConversations] = useState<ConversationSummary[]>([]);
  const [optimisticWorkspaces, setOptimisticWorkspaces] = useState<WorkspaceSummary[]>([]);
  const [workspaceDraftName, setWorkspaceDraftName] = useState('');
  const [inlineRenameSessionId, setInlineRenameSessionId] = useState<string | null>(null);
  const [inlineRenameTitle, setInlineRenameTitle] = useState('');
  const [editSessionId, setEditSessionId] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState('');
  const [editWorkspaceName, setEditWorkspaceName] = useState('');
  const [editSecurityProfile, setEditSecurityProfile] = useState<'repo-write' | 'full-host'>('repo-write');
  const [workspaceName, setWorkspaceName] = useState('');
  const [title, setTitle] = useState('');
  const [securityProfile, setSecurityProfile] = useState<'repo-write' | 'full-host'>('repo-write');
  const [sessionApprovalMode, setSessionApprovalMode] = useState<ApprovalMode>('less-approval');
  const [sessionModel, setSessionModel] = useState('');
  const [sessionEffort, setSessionEffort] = useState<ReasoningEffort>('medium');
  const [userModalMode, setUserModalMode] = useState<UserModalMode>('create');
  const [userModalOpen, setUserModalOpen] = useState(false);
  const [editingUserId, setEditingUserId] = useState<string | null>(null);
  const [userForm, setUserForm] = useState<UserFormState>(() => defaultUserForm());
  const [confirmAction, setConfirmAction] = useState<SessionConfirmAction>(null);
  const [transcriptItems, setTranscriptItems] = useState<SessionTranscriptEntry[]>([]);
  const [transcriptNextCursor, setTranscriptNextCursor] = useState<string | null>(null);
  const [transcriptLoadingOlder, setTranscriptLoadingOlder] = useState(false);
  const [transcriptLoadedOlder, setTranscriptLoadedOlder] = useState(false);
  const [isPromptComposing, setIsPromptComposing] = useState(false);
  const [approvalSelectionIndex, setApprovalSelectionIndex] = useState(0);
  const promptCompositionResetTimerRef = useRef<number | null>(null);
  const lastPromptCompositionEndAtRef = useRef(0);
  const transcriptScrollRef = useRef<HTMLDivElement | null>(null);
  const shouldStickTranscriptToBottomRef = useRef(false);
  const restoreTranscriptScrollHeightRef = useRef<number | null>(null);
  const promptTextareaRef = useRef<HTMLTextAreaElement | null>(null);
  const inlineRenameInputRef = useRef<HTMLInputElement | null>(null);
  const workspaceDraftInputRef = useRef<HTMLInputElement | null>(null);
  const attachmentInputRef = useRef<HTMLInputElement | null>(null);
  const approvalPromptRef = useRef<HTMLDivElement | null>(null);
  const copy = COPY[language];
  const newSessionType: SessionType = activeMode === 'chat' ? 'chat' : 'code';

  const currentUserRoles = deriveRolesFromLegacy(bootstrap?.currentUser);
  const availableModes = derivedAvailableModes(bootstrap);
  const bootstrapWorkspaces = normalizedWorkspaces(bootstrap);
  const bootstrapSessions = normalizedDeveloperSessions(bootstrap);
  const bootstrapConversations = normalizedConversations(bootstrap);
  const availableModels = bootstrap?.availableModels.length ? bootstrap.availableModels : [];
  const currentSessionModelOption = availableModels.find((entry) => entry.model === sessionModel)
    ?? availableModels.find((entry) => entry.isDefault)
    ?? availableModels[0]
    ?? null;
  const currentSessionEfforts = currentSessionModelOption?.supportedReasoningEfforts.length
    ? currentSessionModelOption.supportedReasoningEfforts
    : FALLBACK_REASONING;

  useEffect(() => {
    window.localStorage.setItem('rvc-language', language);
  }, [language]);

  useEffect(() => {
    window.localStorage.setItem('rvc-mode', activeMode);
  }, [activeMode]);

  useEffect(() => {
    window.localStorage.setItem('rvc-rail-width', String(railWidth));
  }, [railWidth]);

  useEffect(() => {
    if (!sessionMenuSessionId && !detailMenuOpen) return;

    function handleWindowClick() {
      setSessionMenuSessionId(null);
      setDetailMenuOpen(false);
    }

    window.addEventListener('click', handleWindowClick);
    return () => {
      window.removeEventListener('click', handleWindowClick);
    };
  }, [detailMenuOpen, sessionMenuSessionId]);

  useEffect(() => {
    function handleOnline() {
      setBrowserOnline(true);
    }

    function handleOffline() {
      setBrowserOnline(false);
      setHostReachable(false);
    }

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function loadBootstrapData() {
      try {
        const next = await fetchBootstrap();
        if (cancelled) return;
        setHostReachable(true);
        setBootstrap(next);
        setActiveMode((current) => pickDefaultMode(next, current));
        setError(null);
      } catch (loadError) {
        if (!cancelled) {
          setHostReachable(false);
          setError(loadError instanceof Error ? loadError.message : copy.unknownError);
        }
      }
    }

    void loadBootstrapData();
    const timer = window.setInterval(() => {
      void loadBootstrapData();
    }, 2000);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [activeMode, copy.unknownError]);

  useEffect(() => {
    if (!selectedSessionId) {
      setDetail(null);
      setTranscriptItems([]);
      setTranscriptNextCursor(null);
      setTranscriptLoadedOlder(false);
      return;
    }

    const currentSessionId = selectedSessionId;
    if (isOptimisticSessionId(currentSessionId)) {
      const optimisticSession = activeMode === 'developer'
        ? optimisticSessions.find((session) => session.id === currentSessionId)
        : optimisticConversations.find((session) => session.id === currentSessionId);

      if (optimisticSession) {
        setDetail(optimisticDetail(optimisticSession));
        setError(null);
      }
      return;
    }

    let cancelled = false;

    async function loadDetail() {
      try {
        const next = await fetchSessionDetail(currentSessionId);
        if (cancelled) return;
        setDetail(next);
        setError(null);
      } catch (loadError) {
        if (!cancelled) {
          setError(loadError instanceof Error ? loadError.message : copy.unknownError);
        }
      }
    }

    void loadDetail();
    const timer = window.setInterval(() => {
      void loadDetail();
    }, 1500);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [selectedSessionId, activeMode, optimisticSessions, optimisticConversations, copy.unknownError]);

  useEffect(() => {
    if (!inlineRenameSessionId) return;
    if (!detail || detail.session.id !== inlineRenameSessionId) {
      setInlineRenameSessionId(null);
      setInlineRenameTitle('');
    }
  }, [detail, inlineRenameSessionId]);

  useEffect(() => {
    if (!inlineRenameSessionId) return;
    window.setTimeout(() => {
      inlineRenameInputRef.current?.focus();
      inlineRenameInputRef.current?.select();
    }, 0);
  }, [inlineRenameSessionId]);

  useEffect(() => {
    if (!pendingSessionRailAction || !detail || detail.session.id !== pendingSessionRailAction.sessionId) {
      return;
    }
    if (pendingSessionRailAction.kind === 'edit') {
      openSessionEditor(detail.session);
    } else {
      setSessionInfoOpen(true);
    }
    setPendingSessionRailAction(null);
  }, [detail, pendingSessionRailAction]);

  useLayoutEffect(() => {
    setTranscriptItems([]);
    setTranscriptNextCursor(null);
    setTranscriptLoadedOlder(false);
    setTranscriptLoadingOlder(false);
    restoreTranscriptScrollHeightRef.current = null;
    shouldStickTranscriptToBottomRef.current = true;
  }, [selectedSessionId]);

  useEffect(() => {
    if (!selectedSessionId) {
      setTranscriptItems([]);
      setTranscriptNextCursor(null);
      setTranscriptLoadedOlder(false);
      return;
    }

    const currentSessionId = selectedSessionId;
    if (isOptimisticSessionId(currentSessionId)) {
      setTranscriptItems([]);
      setTranscriptNextCursor(null);
      setTranscriptLoadedOlder(false);
      return;
    }

    let cancelled = false;

    async function loadLatestTranscript() {
      try {
        const next = await fetchSessionTranscript(currentSessionId, { limit: TRANSCRIPT_PAGE_SIZE });
        if (cancelled) return;

        const scrollContainer = transcriptScrollRef.current;
        const shouldStickToBottom = !scrollContainer
          || isTranscriptNearBottom(scrollContainer);

        if (shouldStickToBottom) {
          shouldStickTranscriptToBottomRef.current = true;
        }

        setTranscriptItems((current) => (
          !transcriptLoadedOlder || current.length === 0
            ? next.items
            : mergeTranscriptEntries(current, next.items)
        ));

        if (!transcriptLoadedOlder) {
          setTranscriptNextCursor(next.nextCursor);
        }

        setError(null);
      } catch (loadError) {
        if (!cancelled) {
          setError(loadError instanceof Error ? loadError.message : copy.unknownError);
        }
      }
    }

    void loadLatestTranscript();
    const timer = window.setInterval(() => {
      void loadLatestTranscript();
    }, 1500);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [selectedSessionId, transcriptLoadedOlder, copy.unknownError]);

  useEffect(() => {
    if (!bootstrap) return;
    if (activeMode !== 'developer') {
      if (selectedWorkspaceId !== null) {
        setSelectedWorkspaceId(null);
      }
      return;
    }

    const allWorkspaces = visibleDeveloperWorkspaces([
      ...optimisticWorkspaces,
      ...bootstrapWorkspaces,
    ]);
    const workspaceIds = new Set(allWorkspaces.map((workspace) => workspace.id));
    const allSessions = [...optimisticSessions, ...bootstrapSessions]
      .filter((session) => workspaceIds.has(session.workspaceId));
    const selectedSession = selectedSessionId
      ? allSessions.find((session) => session.id === selectedSessionId) ?? null
      : null;
    if (selectedSession) {
      if (selectedWorkspaceId !== selectedSession.workspaceId) {
        setSelectedWorkspaceId(selectedSession.workspaceId);
      }
      return;
    }
    if (selectedWorkspaceId && workspaceIds.has(selectedWorkspaceId)) {
      return;
    }

    setSelectedWorkspaceId(allWorkspaces.length > 0 ? pickPreferredWorkspaceId(allWorkspaces, allSessions) : null);
  }, [bootstrap, activeMode, selectedWorkspaceId, selectedSessionId, optimisticSessions, optimisticWorkspaces]);

  useEffect(() => {
    if (!bootstrap) return;

    const visibleWorkspaceIds = new Set(visibleDeveloperWorkspaces([
      ...optimisticWorkspaces,
      ...bootstrapWorkspaces,
    ]).map((workspace) => workspace.id));
    const allDeveloperSessions = [...optimisticSessions, ...bootstrapSessions]
      .filter((session) => visibleWorkspaceIds.has(session.workspaceId));
    const allConversations = [...optimisticConversations, ...bootstrapConversations];

    if (activeMode === 'developer') {
      if (visibleWorkspaceIds.size === 0) {
        if (selectedSessionId !== null) {
          setSelectedSessionId(null);
        }
        return;
      }
      if (!selectedSessionId || !allDeveloperSessions.some((session) => session.id === selectedSessionId)) {
        setSelectedSessionId(pickPreferredSessionId(allDeveloperSessions));
      }
      return;
    }

    if (!selectedSessionId || !allConversations.some((conversation) => conversation.id === selectedSessionId)) {
      setSelectedSessionId(pickPreferredSessionId(allConversations));
    }
  }, [bootstrap, activeMode, optimisticSessions, optimisticConversations, selectedWorkspaceId, selectedSessionId]);

  useEffect(() => {
    if (activeMode !== 'developer') {
      if (expandedWorkspaceIds.length > 0) {
        setExpandedWorkspaceIds([]);
      }
      return;
    }

    const visibleIds = new Set(visibleDeveloperWorkspaces([
      ...optimisticWorkspaces,
      ...bootstrapWorkspaces,
    ]).map((workspace) => workspace.id));

    setExpandedWorkspaceIds((current) => {
      return current.filter((workspaceId) => visibleIds.has(workspaceId));
    });
  }, [activeMode, bootstrapWorkspaces, optimisticWorkspaces, expandedWorkspaceIds.length]);

  useEffect(() => {
    if (newSessionType !== 'code') {
      if (workspaceName !== '') {
        setWorkspaceName('');
      }
      if (securityProfile !== 'repo-write') {
        setSecurityProfile('repo-write');
      }
      return;
    }

    const allWorkspaces = selectableDeveloperWorkspaces([...optimisticWorkspaces, ...(bootstrap?.workspaces ?? [])]);
    if (workspaceName === CREATE_WORKSPACE_OPTION) {
      return;
    }
    if (workspaceName && allWorkspaces.some((entry) => entry.name === workspaceName)) {
      return;
    }
    const selectedWorkspace = allWorkspaces.find((entry) => entry.id === selectedWorkspaceId);
    setWorkspaceName(selectedWorkspace?.name ?? allWorkspaces[0]?.name ?? CREATE_WORKSPACE_OPTION);
  }, [bootstrap, newSessionType, workspaceName, selectedWorkspaceId, optimisticWorkspaces, securityProfile]);

  useEffect(() => {
    if (!detail?.session) return;
    const option = availableModels.find((entry) => entry.model === detail.session.model)
      ?? availableModels.find((entry) => entry.isDefault)
      ?? availableModels[0]
      ?? null;
    if (!option) return;

    const nextModel = detail.session.model ?? option.model;
    const nextEffort = detail.session.reasoningEffort && option.supportedReasoningEfforts.includes(detail.session.reasoningEffort)
      ? detail.session.reasoningEffort
      : preferredReasoningEffort(option);

    setSessionModel(nextModel);
    setSessionEffort(nextEffort);
    setSessionApprovalMode(detail.session.approvalMode);
  }, [detail?.session, availableModels]);

  useEffect(() => {
    if (!adminOpen || !bootstrap?.currentUser.isAdmin) return;
    let cancelled = false;

    async function loadUsers() {
      try {
        const users = await fetchAdminUsers();
        if (!cancelled) {
          setAdminUsers(users);
          setError(null);
        }
      } catch (loadError) {
        if (!cancelled) {
          setError(loadError instanceof Error ? loadError.message : copy.unknownError);
        }
      }
    }

    void loadUsers();
    return () => {
      cancelled = true;
    };
  }, [adminOpen, bootstrap?.currentUser.isAdmin, copy.unknownError]);

  useEffect(() => () => {
    if (promptCompositionResetTimerRef.current) {
      window.clearTimeout(promptCompositionResetTimerRef.current);
    }
  }, []);

  useLayoutEffect(() => {
    const scrollContainer = transcriptScrollRef.current;
    if (!scrollContainer) return;

    if (restoreTranscriptScrollHeightRef.current !== null) {
      const previousHeight = restoreTranscriptScrollHeightRef.current;
      restoreTranscriptScrollHeightRef.current = null;
      scrollContainer.scrollTop += scrollContainer.scrollHeight - previousHeight;
      return;
    }

    if (shouldStickTranscriptToBottomRef.current) {
      shouldStickTranscriptToBottomRef.current = false;
      scrollContainer.scrollTop = scrollContainer.scrollHeight;
    }
  }, [transcriptItems, selectedSessionId]);

  useLayoutEffect(() => {
    const textarea = promptTextareaRef.current;
    if (!textarea) return;

    textarea.style.height = '0px';

    const computed = window.getComputedStyle(textarea);
    const lineHeight = Number.parseFloat(computed.lineHeight) || 24;
    const paddingTop = Number.parseFloat(computed.paddingTop) || 0;
    const paddingBottom = Number.parseFloat(computed.paddingBottom) || 0;
    const minHeight = lineHeight + paddingTop + paddingBottom;
    const maxHeight = (lineHeight * COMPOSER_MAX_LINES) + paddingTop + paddingBottom;
    const nextHeight = Math.min(Math.max(textarea.scrollHeight, minHeight), maxHeight);

    textarea.style.height = `${nextHeight}px`;
    textarea.style.overflowY = textarea.scrollHeight > maxHeight ? 'auto' : 'hidden';
  }, [prompt, selectedSessionId]);

  const cloudflare = bootstrap?.cloudflare;
  const networkState = !browserOnline
    ? 'down'
    : hostReachable
      ? 'ok'
      : 'recovering';
  const cloudflareManagedBySystem = cloudflare?.activeSource === 'system';
  const cloudflareManagedLocally = cloudflare?.activeSource === 'local-manager';
  const sessionIsChat = detail?.session.sessionType === 'chat';
  const selectedSessionIsOptimistic = isOptimisticSessionId(selectedSessionId);
  const inlineRenameActive = Boolean(detail && inlineRenameSessionId === detail.session.id);
  const inlineRenameBusy = Boolean(detail && busy === `rename-${detail.session.id}`);
  const sessionHasActiveTurn = Boolean(detail?.session.activeTurnId);
  const draftAttachments = detail?.draftAttachments ?? [];
  const pendingApprovals = detail?.approvals ?? [];
  const activeApproval = pendingApprovals[0] ?? null;
  const modeAllowsSwitch = availableModes.length > 1;
  const approvalOptions: Array<{ decision: 'accept' | 'decline'; scope: 'once' | 'session'; label: string; tone?: 'secondary' }> = [
    { decision: 'accept', scope: 'once', label: copy.approveOnce },
    { decision: 'accept', scope: 'session', label: copy.approveSession },
    { decision: 'decline', scope: 'once', label: copy.decline, tone: 'secondary' },
  ];
  const allSessions = [
    ...optimisticSessions,
    ...bootstrapSessions,
  ];
  const allConversations = [
    ...optimisticConversations,
    ...bootstrapConversations,
  ];
  const allWorkspaces = [
    ...optimisticWorkspaces,
    ...bootstrapWorkspaces,
  ];
  const developerWorkspaceOptions = selectableDeveloperWorkspaces(allWorkspaces);
  const visibleWorkspaces = visibleDeveloperWorkspaces(allWorkspaces);
  const visibleWorkspaceIds = new Set(visibleWorkspaces.map((workspace) => workspace.id));
  const visibleWorkspaceSessions = allSessions.filter((session) => visibleWorkspaceIds.has(session.workspaceId));
  const selectedWorkspace = developerWorkspaceOptions.find((workspace) => workspace.id === selectedWorkspaceId) ?? null;
  const visibleDeveloperSessions = visibleWorkspaceSessions;
  const railItems = activeMode === 'developer' ? visibleDeveloperSessions : allConversations;
  const detailSessionState = deriveDetailSessionState(detail?.session ?? null, {
    activeApproval,
    transcriptCount: transcriptItems.length,
    busy,
    hasActiveTurn: sessionHasActiveTurn,
  });
  const detailSessionTitle = detail?.session
    ? detail.session.sessionType === 'code'
      ? `${workspaceNameForSession(detail.session, allWorkspaces, bootstrap?.workspaceRoot)} · ${detail.session.title}`
      : detail.session.title
    : copy.selectOrCreate;
  const canSubmitNewSession = Boolean(
    newSessionType === 'chat'
      ? true
      : workspaceName && (workspaceName !== CREATE_WORKSPACE_OPTION || title.trim()),
  );
  const canSaveSession = Boolean(
    detail
    && editTitle.trim(),
  );
  const railEyebrow = activeMode === 'developer'
    ? (language === 'zh' ? '工作区' : 'Workspace')
    : (language === 'zh' ? '对话' : 'Conversations');
  const railPrimaryActionLabel = language === 'zh' ? '新聊天' : 'New chat';
  const railEmptyLabel = activeMode === 'developer'
    ? (language === 'zh' ? '暂时还没有会话。' : 'No sessions yet.')
    : (language === 'zh' ? '还没有聊天记录。' : 'No conversations yet.');
  const noWorkspaceLabel = language === 'zh' ? '还没有 workspace。' : 'No workspaces yet.';
  const modelSelectOptions: SelectOption[] = availableModels.map((option) => ({
    value: option.model,
    label: option.displayName,
  }));
  const effortSelectOptions: SelectOption[] = currentSessionEfforts.map((effort) => ({
    value: effort,
    label: effort,
  }));
  const approvalModeSelectOptions: SelectOption[] = [
    { value: 'less-approval', label: copy.lessApprovalMode },
    { value: 'full-approval', label: copy.fullApprovalMode },
  ];
  const workspaceSelectOptions: SelectOption[] = [
    { value: '', label: copy.workspaceSelect },
    { value: CREATE_WORKSPACE_OPTION, label: copy.newWorkspaceOption },
    ...(developerWorkspaceOptions.map((workspace) => ({
      value: workspace.name,
      label: workspace.name,
    }))),
  ];
  const securityProfileSelectOptions: SelectOption[] = [
    { value: 'repo-write', label: copy.repoWriteProfile },
    ...(bootstrap?.currentUser.canUseFullHost
      ? [{ value: 'full-host', label: copy.fullHostProfile }]
      : []),
  ];

  useEffect(() => {
    setApprovalSelectionIndex(0);
    if (detailSessionState !== 'pending' || !activeApproval) return;
    window.setTimeout(() => {
      approvalPromptRef.current?.focus();
    }, 0);
  }, [detailSessionState, activeApproval?.id]);

  async function refreshCurrentSelection(sessionId = selectedSessionId) {
    const nextBootstrap = await fetchBootstrap();
    setBootstrap(nextBootstrap);
    const nextMode = pickDefaultMode(nextBootstrap, activeMode);
    setActiveMode(nextMode);

    let nextWorkspaceId = selectedWorkspaceId;
    let nextVisibleSessions: SessionSummary[] = [];
    if (nextMode === 'developer') {
      const nextBootstrapSessions = normalizedDeveloperSessions(nextBootstrap);
      const nextBootstrapWorkspaces = visibleDeveloperWorkspaces(normalizedWorkspaces(nextBootstrap));
      const nextWorkspaceIds = new Set(nextBootstrapWorkspaces.map((workspace) => workspace.id));
      nextVisibleSessions = nextBootstrapSessions.filter((entry) => nextWorkspaceIds.has(entry.workspaceId));
      const matchingSession = nextVisibleSessions.find((entry) => entry.id === sessionId);
      nextWorkspaceId = matchingSession?.workspaceId
        ?? (nextWorkspaceId && nextBootstrapWorkspaces.some((workspace) => workspace.id === nextWorkspaceId)
          ? nextWorkspaceId
          : nextBootstrapWorkspaces.length > 0 ? pickPreferredWorkspaceId(nextBootstrapWorkspaces, nextVisibleSessions) : null);
      setSelectedWorkspaceId(nextWorkspaceId);
    } else {
      setSelectedWorkspaceId(null);
    }

    const candidates = nextMode === 'developer'
      ? nextVisibleSessions
      : normalizedConversations(nextBootstrap);
    const nextSelectedSessionId = sessionId && candidates.some((entry) => entry.id === sessionId)
      ? sessionId
      : pickPreferredSessionId(candidates);
    setSelectedSessionId(nextSelectedSessionId);
    if (nextSelectedSessionId) {
      setDetail(await fetchSessionDetail(nextSelectedSessionId));
    } else {
      setDetail(null);
    }
  }

  function clearPromptCompositionResetTimer() {
    if (promptCompositionResetTimerRef.current) {
      window.clearTimeout(promptCompositionResetTimerRef.current);
      promptCompositionResetTimerRef.current = null;
    }
  }

  function handlePromptCompositionStart() {
    clearPromptCompositionResetTimer();
    setIsPromptComposing(true);
    lastPromptCompositionEndAtRef.current = 0;
  }

  function handlePromptCompositionEnd() {
    clearPromptCompositionResetTimer();
    lastPromptCompositionEndAtRef.current = Date.now();
    promptCompositionResetTimerRef.current = window.setTimeout(() => {
      setIsPromptComposing(false);
      promptCompositionResetTimerRef.current = null;
    }, 80);
  }

  function shouldIgnorePromptEnter(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== 'Enter' || event.shiftKey) return false;
    const nativeEvent = event.nativeEvent as KeyboardEvent<HTMLTextAreaElement>['nativeEvent'] & {
      keyCode?: number;
      which?: number;
    };

    if (nativeEvent.isComposing) return true;
    if (nativeEvent.keyCode === 229 || nativeEvent.which === 229) return true;
    if (isPromptComposing) return true;
    if (!lastPromptCompositionEndAtRef.current) return false;
    return (Date.now() - lastPromptCompositionEndAtRef.current) < 80;
  }

  async function loadOlderTranscriptPage() {
    if (!selectedSessionId || !transcriptNextCursor || transcriptLoadingOlder) return;
    const currentSessionId = selectedSessionId;

    const scrollContainer = transcriptScrollRef.current;
    if (scrollContainer) {
      restoreTranscriptScrollHeightRef.current = scrollContainer.scrollHeight;
    }

    setTranscriptLoadingOlder(true);
    try {
      const next = await fetchSessionTranscript(currentSessionId, {
        limit: TRANSCRIPT_PAGE_SIZE,
        before: transcriptNextCursor,
      });
      setTranscriptItems((current) => mergeTranscriptEntries(next.items, current));
      setTranscriptNextCursor(next.nextCursor);
      setTranscriptLoadedOlder(true);
      setError(null);
    } catch (loadError) {
      restoreTranscriptScrollHeightRef.current = null;
      setError(loadError instanceof Error ? loadError.message : copy.unknownError);
    } finally {
      setTranscriptLoadingOlder(false);
    }
  }

  function handleTranscriptScroll() {
    const scrollContainer = transcriptScrollRef.current;
    if (!scrollContainer) return;
    shouldStickTranscriptToBottomRef.current = isTranscriptNearBottom(scrollContainer);
    if (scrollContainer.scrollTop > 120) return;
    if (!transcriptNextCursor || transcriptLoadingOlder) return;
    void loadOlderTranscriptPage();
  }

  function resolveWorkspaceSelection(sessionType: SessionType, selectedWorkspaceName: string, sessionTitle: string) {
    if (sessionType === 'chat') {
      return null;
    }

    if (selectedWorkspaceName === CREATE_WORKSPACE_OPTION) {
      const nextTitle = sessionTitle.trim();
      if (!nextTitle) {
        throw new Error(copy.titleRequired);
      }
      return nextTitle;
    }

    const nextWorkspaceName = selectedWorkspaceName.trim();
    if (!nextWorkspaceName) {
      throw new Error(copy.workspaceRequired);
    }

    return nextWorkspaceName;
  }

  function setBootstrapWorkspaces(nextWorkspaces: WorkspaceSummary[]) {
    setBootstrap((current) => (
      current
        ? {
            ...current,
            workspaces: sortWorkspaceSummaries(nextWorkspaces),
          }
        : current
    ));
  }

  function openNewSessionModal(targetWorkspace?: WorkspaceSummary | null) {
    setTitle('');
    setWorkspaceName(targetWorkspace?.name ?? selectedWorkspace?.name ?? visibleWorkspaces[0]?.name ?? developerWorkspaceOptions[0]?.name ?? CREATE_WORKSPACE_OPTION);
    setSecurityProfile('repo-write');
    setNewSessionOpen(true);
  }

  async function persistWorkspaceLayout(nextWorkspaces: WorkspaceSummary[], previousBootstrap: BootstrapPayload | null) {
    setBootstrapWorkspaces(nextWorkspaces);
    try {
      const changedWorkspaces = nextWorkspaces.filter((workspace) => {
        if (workspace.id.startsWith(OPTIMISTIC_WORKSPACE_PREFIX)) {
          return false;
        }
        const previousWorkspace = allWorkspaces.find((entry) => entry.id === workspace.id);
        return !previousWorkspace
          || previousWorkspace.visible !== workspace.visible
          || previousWorkspace.sortOrder !== workspace.sortOrder;
      });

      await Promise.all(changedWorkspaces.map((workspace) => (
        updateWorkspace(workspace.id, {
          visible: workspace.visible,
          sortOrder: workspace.sortOrder,
        })
      )));

      setBootstrap(await fetchBootstrap());
      setError(null);
    } catch (workspaceError) {
      setBootstrap(previousBootstrap);
      setError(workspaceError instanceof Error ? workspaceError.message : copy.manageWorkspaces);
    }
  }

  async function handleCreateWorkspace(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!bootstrap) return;

    const nextName = workspaceDraftName.trim();
    if (!nextName) {
      setError(language === 'zh' ? 'Workspace 名称是必填项。' : 'Workspace name is required.');
      return;
    }

    setBusy('create-workspace');
    try {
      const { workspaceRoot, workspaces, workspace } = await createWorkspace({
        name: nextName,
      });

      setBootstrap((current) => (
        current
          ? {
              ...current,
              workspaceRoot,
              workspaces: sortWorkspaceSummaries(workspaces),
            }
          : current
      ));
      setSelectedWorkspaceId(workspace.id);
      setExpandedWorkspaceIds((current) => mergeWorkspaceIds(current, workspace.id));
      setWorkspaceDraftName('');
      setWorkspaceModalMode(null);
      setError(null);
    } catch (workspaceError) {
      setError(workspaceError instanceof Error ? workspaceError.message : copy.createWorkspaceAction);
    } finally {
      setBusy(null);
    }
  }

  async function handleMoveWorkspace(workspaceId: string, direction: -1 | 1) {
    const currentIndex = visibleWorkspaces.findIndex((workspace) => workspace.id === workspaceId);
    const nextIndex = currentIndex + direction;
    if (currentIndex === -1 || nextIndex < 0 || nextIndex >= visibleWorkspaces.length) {
      return;
    }

    const previousBootstrap = bootstrap;
    const reordered = [...visibleWorkspaces];
    const [targetWorkspace] = reordered.splice(currentIndex, 1);
    if (!targetWorkspace) {
      return;
    }
    reordered.splice(nextIndex, 0, targetWorkspace);
    const normalizedVisible = reordered.map((entry, index) => ({
      ...entry,
      sortOrder: index,
    }));
    const visibleMap = new Map(normalizedVisible.map((entry) => [entry.id, entry]));
    const nextWorkspaces = allWorkspaces.map((entry) => visibleMap.get(entry.id) ?? entry);

    await persistWorkspaceLayout(nextWorkspaces, previousBootstrap);
  }

  async function handleCreateConversation() {
    if (!bootstrap) return;

    setBusy('create-session');
    const previousSelectedSessionId = selectedSessionId;
    let optimisticId: string | null = null;

    try {
      optimisticId = `${OPTIMISTIC_SESSION_PREFIX}${Date.now()}`;
      const now = new Date().toISOString();
      const ownerRoot = normalizeWorkspaceSegment(
        bootstrap.currentUser.username,
        `user-${bootstrap.currentUser.id.slice(0, 8)}`,
      );
      const defaultModel = bootstrap.availableModels.find((entry) => entry.isDefault)
        ?? bootstrap.availableModels[0]
        ?? null;
      const optimisticConversation: ConversationSummary = {
        id: optimisticId,
        ownerUserId: bootstrap.currentUser.id,
        ownerUsername: bootstrap.currentUser.username,
        sessionType: 'chat',
        threadId: optimisticId,
        activeTurnId: null,
        title: 'New chat',
        autoTitle: true,
        workspace: `${bootstrap.workspaceRoot}/${ownerRoot}`,
        archivedAt: null,
        securityProfile: 'read-only',
        approvalMode: 'less-approval',
        networkEnabled: false,
        fullHostEnabled: false,
        status: 'running',
        lastIssue: null,
        hasTranscript: false,
        model: defaultModel?.model ?? null,
        reasoningEffort: preferredReasoningEffort(defaultModel),
        createdAt: now,
        updatedAt: now,
        lastUpdate: copy.creating,
      };

      setOptimisticConversations((current) => [optimisticConversation, ...current]);
      setSessionMenuSessionId(null);
      setSelectedSessionId(optimisticId);
      setDetail(optimisticDetail(optimisticConversation));
      setTranscriptItems([]);
      setTranscriptNextCursor(null);
      setTranscriptLoadedOlder(false);
      setPrompt('');

      const session = await createSession({
        sessionType: 'chat',
      });

      setOptimisticConversations((current) => current.filter((entry) => entry.id !== optimisticId));
      setBootstrap((current) => {
        if (!current || session.sessionType !== 'chat') {
          return current;
        }

        return {
          ...current,
          conversations: [
            {
              ...session,
              lastUpdate: current.conversations.find((entry) => entry.id === session.id)?.lastUpdate ?? session.updatedAt,
            },
            ...current.conversations.filter((entry) => entry.id !== session.id),
          ],
        };
      });
      setSelectedSessionId(session.id);
      await refreshCurrentSelection(session.id);
      window.setTimeout(() => {
        promptTextareaRef.current?.focus();
      }, 0);
      setError(null);
    } catch (createError) {
      if (optimisticId) {
        setOptimisticConversations((current) => current.filter((entry) => entry.id !== optimisticId));
      }
      setSelectedSessionId(previousSelectedSessionId);
      setError(createError instanceof Error ? createError.message : copy.createSession);
    } finally {
      setBusy(null);
    }
  }

  async function handleCreateSession(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!bootstrap) return;
    if (newSessionType === 'chat') {
      await handleCreateConversation();
      return;
    }
    setBusy('create-session');
    const previousSelectedSessionId = selectedSessionId;
    const previousSelectedWorkspaceId = selectedWorkspaceId;
    let optimisticId: string | null = null;
    let optimisticWorkspaceId: string | null = null;
    try {
      const nextWorkspaceName = resolveWorkspaceSelection(newSessionType, workspaceName, title);
      optimisticId = `${OPTIMISTIC_SESSION_PREFIX}${Date.now()}`;
      const now = new Date().toISOString();
      const ownerRoot = normalizeWorkspaceSegment(
        bootstrap.currentUser.username,
        `user-${bootstrap.currentUser.id.slice(0, 8)}`,
      );
      const existingWorkspace = nextWorkspaceName
        ? developerWorkspaceOptions.find((workspace) => workspace.name === nextWorkspaceName)
        : null;
      if (newSessionType === 'code' && !existingWorkspace) {
        optimisticWorkspaceId = `${OPTIMISTIC_WORKSPACE_PREFIX}${Date.now()}`;
      }
      const optimisticWorkspace = nextWorkspaceName
        ? `${bootstrap.workspaceRoot}/${ownerRoot}/${nextWorkspaceName}`
        : `${bootstrap.workspaceRoot}/${ownerRoot}`;
      const defaultModel = bootstrap.availableModels.find((entry) => entry.isDefault)
        ?? bootstrap.availableModels[0]
        ?? null;
      const nextWorkspaceId = existingWorkspace?.id ?? optimisticWorkspaceId ?? `${OPTIMISTIC_WORKSPACE_PREFIX}${Date.now()}`;
      if (!existingWorkspace) {
        setOptimisticWorkspaces((current) => ([
          {
            id: nextWorkspaceId,
            name: nextWorkspaceName ?? title.trim(),
            path: optimisticWorkspace,
            visible: true,
            sortOrder: visibleWorkspaces.length,
          },
          ...current.filter((workspace) => workspace.id !== nextWorkspaceId),
        ]));
      }
      setExpandedWorkspaceIds((current) => mergeWorkspaceIds(current, nextWorkspaceId));
      const optimisticSession: SessionSummary = {
        id: optimisticId,
        ownerUserId: bootstrap.currentUser.id,
        ownerUsername: bootstrap.currentUser.username,
        sessionType: 'code',
        workspaceId: nextWorkspaceId,
        threadId: optimisticId,
        activeTurnId: null,
        title: title.trim() || (nextWorkspaceName ?? copy.newSession),
        autoTitle: false,
        workspace: optimisticWorkspace,
        archivedAt: null,
        securityProfile,
        approvalMode: 'less-approval',
        networkEnabled: false,
        fullHostEnabled: securityProfile === 'full-host',
        status: 'running',
        lastIssue: null,
        hasTranscript: false,
        model: defaultModel?.model ?? null,
        reasoningEffort: preferredReasoningEffort(defaultModel),
        createdAt: now,
        updatedAt: now,
        lastUpdate: copy.creating,
        pendingApprovalCount: 0,
      };
      setOptimisticSessions((current) => [optimisticSession, ...current]);
      setSelectedWorkspaceId(nextWorkspaceId);
      setSelectedSessionId(optimisticId);
      setSessionMenuSessionId(null);
      setNewSessionOpen(false);
      setTitle('');
      setPrompt('');
      setWorkspaceName(nextWorkspaceName ?? '');

      const session = await createSession({
        sessionType: newSessionType,
        ...(newSessionType === 'code' && title.trim() ? { title: title.trim() } : {}),
        ...(nextWorkspaceName ? { workspaceName: nextWorkspaceName } : {}),
        ...(newSessionType === 'code'
          ? {
              securityProfile,
            }
          : {}),
      });
      setOptimisticSessions((current) => current.filter((entry) => entry.id !== optimisticId));
      setOptimisticConversations((current) => current.filter((entry) => entry.id !== optimisticId));
      if (optimisticWorkspaceId) {
        setOptimisticWorkspaces((current) => current.filter((entry) => entry.id !== optimisticWorkspaceId));
      }
      setBootstrap((current) => {
        if (!current) return current;
        if (session.sessionType === 'chat') {
          return {
            ...current,
            conversations: [
              {
                ...session,
                lastUpdate: current.conversations.find((entry) => entry.id === session.id)?.lastUpdate ?? session.updatedAt,
              },
              ...current.conversations.filter((entry) => entry.id !== session.id),
            ],
          };
        }
        return {
          ...current,
          sessions: [
            toSessionSummary(session, current.sessions.find((entry) => entry.id === session.id) ?? null),
            ...current.sessions.filter((entry) => entry.id !== session.id),
          ],
        };
      });
      if (session.sessionType === 'code') {
        setSelectedWorkspaceId(session.workspaceId);
        setExpandedWorkspaceIds((current) => mergeWorkspaceIds(current, session.workspaceId));
      }
      setSelectedSessionId(session.id);
      await refreshCurrentSelection(session.id);
      setError(null);
    } catch (createError) {
      if (optimisticId) {
        setOptimisticSessions((current) => current.filter((entry) => entry.id !== optimisticId));
        setOptimisticConversations((current) => current.filter((entry) => entry.id !== optimisticId));
      }
      if (optimisticWorkspaceId) {
        setOptimisticWorkspaces((current) => current.filter((entry) => entry.id !== optimisticWorkspaceId));
      }
      setSelectedSessionId(previousSelectedSessionId);
      setSelectedWorkspaceId(previousSelectedWorkspaceId);
      setError(createError instanceof Error ? createError.message : copy.createSession);
    } finally {
      setBusy(null);
    }
  }

  async function handleAttachmentSelection(event: ChangeEvent<HTMLInputElement>) {
    if (!selectedSessionId || selectedSessionIsOptimistic || sessionHasActiveTurn) return;
    const files = Array.from(event.target.files ?? []);
    event.target.value = '';
    if (files.length === 0) return;

    setBusy('upload-attachment');
    try {
      for (const file of files) {
        await uploadAttachment(selectedSessionId, file);
      }
      await refreshCurrentSelection(selectedSessionId);
      setError(null);
    } catch (uploadError) {
      setError(uploadError instanceof Error ? uploadError.message : copy.attachFiles);
    } finally {
      setBusy(null);
    }
  }

  async function handleRemoveDraftAttachment(attachment: SessionAttachmentSummary) {
    if (!selectedSessionId) return;
    setBusy(`remove-attachment-${attachment.id}`);
    try {
      await deleteAttachment(selectedSessionId, attachment.id);
      await refreshCurrentSelection(selectedSessionId);
      setError(null);
    } catch (removeError) {
      setError(removeError instanceof Error ? removeError.message : copy.removeAttachment);
    } finally {
      setBusy(null);
    }
  }

  async function submitPrompt() {
    if (!selectedSessionId || selectedSessionIsOptimistic || sessionHasActiveTurn || busy === 'stop-session') return;
    const trimmedPrompt = prompt.trim();
    if (!trimmedPrompt && draftAttachments.length === 0) return;

    setBusy('start-turn');
    try {
      shouldStickTranscriptToBottomRef.current = true;
      await startTurn(selectedSessionId, {
        ...(trimmedPrompt ? { prompt: trimmedPrompt } : {}),
        ...(draftAttachments.length > 0 ? { attachmentIds: draftAttachments.map((attachment) => attachment.id) } : {}),
      });
      setPrompt('');
      await refreshCurrentSelection(selectedSessionId);
      setError(null);
    } catch (turnError) {
      setError(turnError instanceof Error ? turnError.message : copy.sendPrompt);
    } finally {
      setBusy(null);
    }
  }

  async function handleStartTurn(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (sessionHasActiveTurn) return;
    await submitPrompt();
  }

  function handlePromptKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (shouldIgnorePromptEnter(event)) return;
    if (event.key !== 'Enter' || event.shiftKey) return;
    event.preventDefault();
    if (busy === 'start-turn' || busy === 'stop-session' || detail?.session.activeTurnId) return;
    void submitPrompt();
  }

  async function handleStopActiveTurn() {
    if (!selectedSessionId || selectedSessionIsOptimistic) return;
    setBusy('stop-session');
    try {
      await stopSession(selectedSessionId);
      await refreshCurrentSelection(selectedSessionId);
      setError(null);
    } catch (stopError) {
      setError(stopError instanceof Error ? stopError.message : copy.stop);
    } finally {
      setBusy(null);
    }
  }

  async function handleSessionPreferencesChange(nextModel: string, nextEffort: ReasoningEffort, nextApprovalMode: ApprovalMode) {
    if (!selectedSessionId || !detail) return;
    setBusy('update-session-preferences');
    const previousBootstrap = bootstrap;
    const previousDetail = detail;
    const previousModel = detail.session.model ?? currentSessionModelOption?.model ?? '';
    const previousEffort = detail.session.reasoningEffort ?? preferredReasoningEffort(currentSessionModelOption);
    const previousApprovalMode = detail.session.approvalMode;
    const now = new Date().toISOString();
    const optimisticSession = {
      ...detail.session,
      model: nextModel,
      reasoningEffort: nextEffort,
      approvalMode: detail.session.sessionType === 'code' ? nextApprovalMode : detail.session.approvalMode,
      updatedAt: now,
    };

    setBootstrap((current) => (
      current
        ? optimisticSession.sessionType === 'code'
          ? {
              ...current,
              sessions: current.sessions.map((session) => (
                session.id === optimisticSession.id
                  ? toSessionSummary(optimisticSession, session, now)
                  : session
              )),
            }
          : {
              ...current,
              conversations: current.conversations.map((conversation) => (
                conversation.id === optimisticSession.id
                  ? {
                      ...conversation,
                      ...optimisticSession,
                      lastUpdate: now,
                    }
                  : conversation
              )),
            }
        : current
    ));
    setDetail((current) => (
      current && current.session.id === optimisticSession.id
        ? {
            ...current,
            session: optimisticSession,
          }
        : current
    ));
    try {
      const nextSession = await updateSessionPreferences(selectedSessionId, {
        model: nextModel,
        reasoningEffort: nextEffort,
        ...(detail?.session.sessionType === 'code'
          ? {
              approvalMode: nextApprovalMode,
            }
          : {}),
      });
      setBootstrap((current) => (
        current
          ? nextSession.sessionType === 'code'
            ? {
                ...current,
                sessions: current.sessions.map((session) => (
                  session.id === nextSession.id
                    ? toSessionSummary(nextSession, session)
                    : session
                )),
              }
            : {
                ...current,
                conversations: current.conversations.map((conversation) => (
                  conversation.id === nextSession.id
                    ? {
                        ...conversation,
                        ...nextSession,
                        lastUpdate: conversation.lastUpdate,
                      }
                    : conversation
                )),
              }
          : current
      ));
      setDetail((current) => (
        current && current.session.id === nextSession.id
          ? {
              ...current,
              session: nextSession,
            }
          : current
      ));
      setError(null);
    } catch (preferencesError) {
      setBootstrap(previousBootstrap);
      setDetail(previousDetail);
      setSessionModel(previousModel);
      setSessionEffort(previousEffort);
      setSessionApprovalMode(previousApprovalMode);
      setError(preferencesError instanceof Error ? preferencesError.message : copy.settings);
    } finally {
      setBusy(null);
    }
  }

  function handleSessionModelChange(nextModel: string) {
    const option = availableModels.find((entry) => entry.model === nextModel);
    if (!option) return;
    const nextEffort = option.supportedReasoningEfforts.includes(sessionEffort)
      ? sessionEffort
      : preferredReasoningEffort(option);
    setSessionModel(nextModel);
    setSessionEffort(nextEffort);
    void handleSessionPreferencesChange(nextModel, nextEffort, sessionApprovalMode);
  }

  function handleSessionEffortChange(nextEffort: ReasoningEffort) {
    setSessionEffort(nextEffort);
    void handleSessionPreferencesChange(sessionModel, nextEffort, sessionApprovalMode);
  }

  function handleSessionApprovalModeChange(nextApprovalMode: ApprovalMode) {
    setSessionApprovalMode(nextApprovalMode);
    void handleSessionPreferencesChange(sessionModel, sessionEffort, nextApprovalMode);
  }

  function beginInlineRename() {
    if (!detail || selectedSessionIsOptimistic || busy === `rename-${detail.session.id}`) {
      return;
    }
    setDetailMenuOpen(false);
    setSessionMenuSessionId(null);
    setInlineRenameSessionId(detail.session.id);
    setInlineRenameTitle(detail.session.title);
  }

  function cancelInlineRename() {
    setInlineRenameSessionId(null);
    setInlineRenameTitle('');
  }

  async function saveInlineRename() {
    if (!inlineRenameSessionId || !detail || !bootstrap) return;
    const nextTitle = inlineRenameTitle.trim();
    if (!nextTitle) return;
    if (nextTitle === detail.session.title) {
      cancelInlineRename();
      return;
    }

    setBusy(`rename-${inlineRenameSessionId}`);
    const previousBootstrap = bootstrap;
    const previousDetail = detail;
    const now = new Date().toISOString();
    const optimisticSession = {
      ...detail.session,
      title: nextTitle,
      autoTitle: false,
      updatedAt: now,
    };

    setInlineRenameSessionId(null);
    setInlineRenameTitle('');
    setBootstrap((current) => (
      current
        ? optimisticSession.sessionType === 'code'
          ? {
              ...current,
              sessions: current.sessions.map((session) => (
                session.id === optimisticSession.id
                  ? toSessionSummary(optimisticSession, session, now)
                  : session
              )),
            }
          : {
              ...current,
              conversations: current.conversations.map((conversation) => (
                conversation.id === optimisticSession.id
                  ? {
                      ...conversation,
                      ...optimisticSession,
                      lastUpdate: now,
                    }
                  : conversation
              )),
            }
        : current
    ));
    setDetail((current) => (
      current && current.session.id === optimisticSession.id
        ? {
            ...current,
            session: optimisticSession,
          }
        : current
    ));

    try {
      const nextSession = await updateSession(inlineRenameSessionId, {
        title: nextTitle,
      });
      setBootstrap((current) => (
        current
          ? nextSession.sessionType === 'code'
            ? {
                ...current,
                sessions: current.sessions.map((session) => (
                  session.id === nextSession.id
                    ? toSessionSummary(nextSession, session)
                    : session
                )),
              }
            : {
                ...current,
                conversations: current.conversations.map((conversation) => (
                  conversation.id === nextSession.id
                    ? {
                        ...conversation,
                        ...nextSession,
                        lastUpdate: conversation.lastUpdate,
                      }
                    : conversation
                )),
              }
          : current
      ));
      setDetail((current) => (
        current && current.session.id === nextSession.id
          ? {
              ...current,
              session: nextSession,
            }
          : current
      ));
      setError(null);
    } catch (saveError) {
      setBootstrap(previousBootstrap);
      setDetail(previousDetail);
      setError(saveError instanceof Error ? saveError.message : copy.rename);
    } finally {
      setBusy(null);
    }
  }

  function handleInlineRenameKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'Enter') {
      event.preventDefault();
      void saveInlineRename();
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      cancelInlineRename();
    }
  }

  async function handleSaveSession(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!editSessionId || !detail || !bootstrap) return;
    setBusy(`rename-${editSessionId}`);
    const previousBootstrap = bootstrap;
    const previousDetail = detail;
    try {
      const sessionUpdate: UpdateSessionRequest = {
        title: editTitle,
      };
      const nextSecurityProfile = detail.session.sessionType === 'code'
        ? editSecurityProfile
        : detail.session.securityProfile;
      const restartRequired = nextSecurityProfile !== detail.session.securityProfile;
      const now = new Date().toISOString();
      const optimisticSession = {
        ...detail.session,
        title: editTitle,
        autoTitle: false,
        securityProfile: nextSecurityProfile,
        fullHostEnabled: nextSecurityProfile === 'full-host',
        updatedAt: now,
        ...(restartRequired
          ? {
              activeTurnId: null,
              status: 'idle' as const,
              lastIssue: null,
            }
          : {}),
      };

      if (detail.session.sessionType === 'code') {
        sessionUpdate.securityProfile = editSecurityProfile;
      }

      setEditSessionId(null);
      setEditTitle('');
      setEditWorkspaceName('');
      setBootstrap((current) => (
        current
          ? optimisticSession.sessionType === 'code'
            ? {
                ...current,
                sessions: current.sessions.map((session) => (
                  session.id === optimisticSession.id
                    ? toSessionSummary(optimisticSession, session, now)
                    : session
                )),
              }
            : {
                ...current,
                conversations: current.conversations.map((conversation) => (
                  conversation.id === optimisticSession.id
                    ? {
                        ...conversation,
                        ...optimisticSession,
                        lastUpdate: now,
                      }
                    : conversation
                )),
              }
          : current
      ));
      setDetail((current) => (
        current && current.session.id === optimisticSession.id
          ? {
              ...current,
              session: optimisticSession,
            }
          : current
      ));

      const nextSession = await updateSession(editSessionId, sessionUpdate);
      setBootstrap((current) => (
        current
          ? nextSession.sessionType === 'code'
            ? {
                ...current,
                sessions: current.sessions.map((session) => (
                  session.id === nextSession.id
                    ? toSessionSummary(nextSession, session)
                    : session
                )),
              }
            : {
                ...current,
                conversations: current.conversations.map((conversation) => (
                  conversation.id === nextSession.id
                    ? {
                        ...conversation,
                        ...nextSession,
                        lastUpdate: conversation.lastUpdate,
                      }
                    : conversation
                )),
              }
          : current
      ));
      if (nextSession.sessionType === 'code') {
        setSelectedWorkspaceId(nextSession.workspaceId);
        setExpandedWorkspaceIds((current) => mergeWorkspaceIds(current, nextSession.workspaceId));
      }
      setDetail((current) => (
        current && current.session.id === nextSession.id
          ? {
              ...current,
              session: nextSession,
            }
          : current
      ));
      setError(null);
    } catch (saveError) {
      setBootstrap(previousBootstrap);
      setDetail(previousDetail);
      setError(saveError instanceof Error ? saveError.message : copy.rename);
    } finally {
      setBusy(null);
    }
  }

  async function handleForkSession(session: SessionSummary | ConversationSummary) {
    setBusy(`fork-${session.id}`);
    setSessionMenuSessionId(null);
    if (!bootstrap) {
      setBusy(null);
      return;
    }
    const previousSelectedSessionId = selectedSessionId;
    let optimisticId: string | null = null;
    try {
      optimisticId = `${OPTIMISTIC_SESSION_PREFIX}${Date.now()}`;
      const now = new Date().toISOString();
      if (session.sessionType === 'code') {
        const optimisticSession: SessionSummary = {
          ...toSessionSummary({
            ...session,
            id: optimisticId,
            threadId: optimisticId,
            title: nextForkedSessionTitle(session.title),
            activeTurnId: null,
            archivedAt: null,
            status: 'running',
            lastIssue: null,
            hasTranscript: false,
            createdAt: now,
            updatedAt: now,
          }, null, copy.forking),
          pendingApprovalCount: 0,
        };
        setOptimisticSessions((current) => [optimisticSession, ...current]);
        setExpandedWorkspaceIds((current) => mergeWorkspaceIds(current, session.workspaceId));
      } else {
        const optimisticConversation: ConversationSummary = {
          ...session,
          id: optimisticId,
          threadId: optimisticId,
          title: nextForkedSessionTitle(session.title),
          activeTurnId: null,
          archivedAt: null,
          status: 'running',
          lastIssue: null,
          hasTranscript: false,
          createdAt: now,
          updatedAt: now,
          lastUpdate: copy.forking,
        };
        setOptimisticConversations((current) => [optimisticConversation, ...current]);
      }

      const nextSession = await forkSession(session.id);
      if (optimisticId) {
        setOptimisticSessions((current) => current.filter((entry) => entry.id !== optimisticId));
        setOptimisticConversations((current) => current.filter((entry) => entry.id !== optimisticId));
      }
      setBootstrap((current) => (
        current
          ? nextSession.sessionType === 'code'
            ? {
                ...current,
                sessions: [
                  toSessionSummary(nextSession, current.sessions.find((entry) => entry.id === nextSession.id) ?? null),
                  ...current.sessions.filter((entry) => entry.id !== nextSession.id),
                ],
              }
            : {
                ...current,
                conversations: [
                  {
                    ...nextSession,
                    lastUpdate: current.conversations.find((entry) => entry.id === nextSession.id)?.lastUpdate ?? nextSession.updatedAt,
                  },
                  ...current.conversations.filter((entry) => entry.id !== nextSession.id),
                ],
              }
          : current
      ));
      if (nextSession.sessionType === 'code') {
        setSelectedWorkspaceId(nextSession.workspaceId);
        setExpandedWorkspaceIds((current) => mergeWorkspaceIds(current, nextSession.workspaceId));
      } else {
        setSelectedWorkspaceId(null);
      }
      setSelectedSessionId(nextSession.id);
      await refreshCurrentSelection(nextSession.id);
      setError(null);
    } catch (forkError) {
      if (optimisticId) {
        setOptimisticSessions((current) => current.filter((entry) => entry.id !== optimisticId));
        setOptimisticConversations((current) => current.filter((entry) => entry.id !== optimisticId));
      }
      setSelectedSessionId(previousSelectedSessionId);
      setError(forkError instanceof Error ? forkError.message : copy.fork);
    } finally {
      setBusy(null);
    }
  }

  async function handleDeleteSession(sessionId: string) {
    setSessionMenuSessionId(null);
    const previousSelectedSessionId = selectedSessionId;
    const previousBootstrap = bootstrap;
    const previousDetail = detail;
    const currentDeveloperSession = allSessions.find((session) => session.id === sessionId) ?? null;
    const deletingConversation = allConversations.some((session) => session.id === sessionId);
    if (currentDeveloperSession) {
      const workspaceSessionCount = allSessions.filter((session) => session.workspaceId === currentDeveloperSession.workspaceId).length;
      if (workspaceSessionCount <= 1) {
        setConfirmAction(null);
        setError(language === 'zh' ? '不能删除这个 workspace 的最后一个 session。' : 'You cannot delete the last session in a workspace.');
        return;
      }
    }
    const deletingCurrentSession = previousSelectedSessionId === sessionId;
    const remainingSessions = deletingConversation
      ? allConversations.filter((session) => session.id !== sessionId)
      : visibleDeveloperSessions.filter((session) => session.id !== sessionId);
    const nextSelectedSessionId = deletingCurrentSession
      ? pickPreferredSessionId(remainingSessions)
      : previousSelectedSessionId;

    setConfirmAction(null);
    setBootstrap((current) => (
      current
        ? deletingConversation
          ? {
              ...current,
              conversations: current.conversations.filter((session) => session.id !== sessionId),
            }
          : {
              ...current,
              sessions: current.sessions.filter((session) => session.id !== sessionId),
              approvals: current.approvals.filter((approval) => approval.sessionId !== sessionId),
            }
        : current
    ));

    if (deletingCurrentSession) {
      setSelectedSessionId(nextSelectedSessionId);
      setDetail(null);
    }

    setError(null);

    try {
      await deleteSession(sessionId);
      void refreshCurrentSelection(nextSelectedSessionId);
      setError(null);
    } catch (deleteError) {
      setBootstrap(previousBootstrap);
      setSelectedSessionId(previousSelectedSessionId);
      setDetail(previousDetail);
      if (previousSelectedSessionId) {
        void refreshCurrentSelection(previousSelectedSessionId);
      }
      setError(deleteError instanceof Error ? deleteError.message : copy.delete);
    }
  }

  async function handleConfirmSessionAction() {
    if (!confirmAction) return;
    void handleDeleteSession(confirmAction.session.id);
  }

  function openSessionEditor(session: SessionDetailResponse['session']) {
    setSessionMenuSessionId(null);
    const selectedWorkspaceName = session.sessionType === 'code'
      ? allWorkspaces.find((entry) => entry.id === session.workspaceId)?.name ?? ''
      : '';
    setEditSessionId(session.id);
    setEditTitle(session.title);
    setEditWorkspaceName(selectedWorkspaceName);
    setEditSecurityProfile(session.securityProfile === 'full-host' ? 'full-host' : 'repo-write');
  }

  async function handleApprovalAction(approval: PendingApproval, decision: 'accept' | 'decline', scope: 'once' | 'session') {
    setBusy(approval.id);
    try {
      await resolveApproval(approval.sessionId, approval.id, { decision, scope });
      await refreshCurrentSelection(selectedSessionId);
      setError(null);
    } catch (approvalError) {
      setError(approvalError instanceof Error ? approvalError.message : copy.decline);
    } finally {
      setBusy(null);
    }
  }

  function handleApprovalPromptKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (!activeApproval) return;

    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setApprovalSelectionIndex((current) => (current + 1) % approvalOptions.length);
      return;
    }

    if (event.key === 'ArrowUp') {
      event.preventDefault();
      setApprovalSelectionIndex((current) => (current - 1 + approvalOptions.length) % approvalOptions.length);
      return;
    }

    if (event.key === 'Enter') {
      event.preventDefault();
      const option = approvalOptions[approvalSelectionIndex] ?? approvalOptions[0];
      if (!option) return;
      void handleApprovalAction(activeApproval, option.decision, option.scope);
    }
  }

  async function handleConnectCloudflare() {
    setBusy('connect-cloudflare');
    try {
      await connectCloudflareTunnel();
      setBootstrap(await fetchBootstrap());
      setError(null);
    } catch (connectError) {
      setError(connectError instanceof Error ? connectError.message : copy.connectTunnel);
    } finally {
      setBusy(null);
    }
  }

  async function handleDisconnectCloudflare() {
    setBusy('disconnect-cloudflare');
    try {
      await disconnectCloudflareTunnel();
      setBootstrap(await fetchBootstrap());
      setError(null);
    } catch (disconnectError) {
      setError(disconnectError instanceof Error ? disconnectError.message : copy.disconnect);
    } finally {
      setBusy(null);
    }
  }

  async function handleLogout() {
    setBusy('logout');
    try {
      await logout();
    } finally {
      window.location.href = '/login';
    }
  }

  function openCreateUserModal() {
    setUserModalMode('create');
    setEditingUserId(null);
    setUserForm(defaultUserForm());
    setUserModalOpen(true);
  }

  function openEditUserModal(user: AdminUserRecord) {
    const userRoles = deriveRolesFromLegacy(user);
    setUserModalMode('edit');
    setEditingUserId(user.id);
    setUserForm({
      username: user.username,
      password: '',
      isAdmin: userRoles.includes('admin'),
      allowCode: userRoles.includes('developer'),
      allowChat: userRoles.includes('user'),
      canUseFullHost: user.canUseFullHost,
      regenerateToken: false,
    });
    setUserModalOpen(true);
  }

  async function handleUserSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const roles = [
      ...(userForm.allowChat ? (['user'] as UserRole[]) : []),
      ...(userForm.allowCode ? (['developer'] as UserRole[]) : []),
      ...(userForm.isAdmin ? (['admin'] as UserRole[]) : []),
    ];
    if (!roles.includes('user') && !roles.includes('developer')) {
      setError(language === 'zh' ? '至少选择 User 或 Developer。' : 'Pick at least one of User or Developer.');
      return;
    }

    setBusy(userModalMode === 'create' ? 'create-user' : `save-user-${editingUserId}`);
    try {
      if (userModalMode === 'create') {
        const response = await createAdminUser({
          username: userForm.username,
          password: userForm.password,
          roles,
          preferredMode: roles.includes('developer') ? 'developer' : 'chat',
          canUseFullHost: userForm.allowCode ? userForm.canUseFullHost : false,
        });
        setAdminUsers(response.users);
      } else if (editingUserId) {
        const response = await updateAdminUser(editingUserId, {
          username: userForm.username,
          ...(userForm.password.trim() ? { password: userForm.password } : {}),
          roles,
          preferredMode: roles.includes('developer') ? 'developer' : 'chat',
          canUseFullHost: userForm.allowCode ? userForm.canUseFullHost : false,
          regenerateToken: userForm.regenerateToken,
        });
        setAdminUsers(response.users);
        setBootstrap(await fetchBootstrap());
      }
      setUserModalOpen(false);
      setError(null);
    } catch (userError) {
      setError(userError instanceof Error ? userError.message : copy.saveUser);
    } finally {
      setBusy(null);
    }
  }

  async function handleDeleteUser(user: AdminUserRecord) {
    const confirmed = window.confirm(copy.deleteUserConfirm.replace('{username}', user.username));
    if (!confirmed) return;
    setBusy(`delete-user-${user.id}`);
    try {
      setAdminUsers(await deleteAdminUser(user.id));
      setBootstrap(await fetchBootstrap());
      setError(null);
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : copy.deleteUser);
    } finally {
      setBusy(null);
    }
  }

  function toggleWorkspaceExpanded(workspaceId: string) {
    setDetailMenuOpen(false);
    setSessionMenuSessionId(null);
    setExpandedWorkspaceIds((current) => (
      current.includes(workspaceId)
        ? current.filter((entry) => entry !== workspaceId)
        : [...current, workspaceId]
    ));
  }

  function selectSessionFromRail(session: SessionSummary | ConversationSummary) {
    if (isOptimisticSessionId(session.id)) return;
    setDetailMenuOpen(false);
    setSessionMenuSessionId(null);
    if (session.sessionType === 'code') {
      setSelectedWorkspaceId(session.workspaceId);
      setExpandedWorkspaceIds((current) => mergeWorkspaceIds(current, session.workspaceId));
    }
    setSelectedSessionId(session.id);
  }

  function invokeSessionRailAction(session: SessionSummary, action: 'edit' | 'info') {
    setDetailMenuOpen(false);
    setSessionMenuSessionId(null);
    if (detail?.session.id === session.id) {
      if (action === 'edit') {
        openSessionEditor(detail.session);
      } else {
        setSessionInfoOpen(true);
      }
      return;
    }

    setPendingSessionRailAction({ kind: action, sessionId: session.id });
    selectSessionFromRail(session);
  }

  function renderSessionRailItem(session: SessionSummary | ConversationSummary) {
    const sessionState = deriveSummarySessionState(session);
    const menuOpen = sessionMenuSessionId === session.id;
    const sessionPending = isOptimisticSessionId(session.id);

    return (
      <li
        key={session.id}
        className={`session-node ${selectedSessionId === session.id ? 'session-node-active' : ''} ${sessionPending ? 'session-node-pending' : ''}`}
      >
        <button
          type="button"
          className="session-node-trigger"
          onClick={() => selectSessionFromRail(session)}
          disabled={sessionPending}
        >
          <div className="session-node-copy">
            <span className={`session-node-marker session-node-marker-${sessionState}`} aria-hidden="true" />
            <span className="session-node-label" title={session.title}>{session.title}</span>
          </div>
          <span className={`status-pill status-${sessionState}`}>
            {uiSessionStateLabel(language, sessionState)}
          </span>
        </button>

        {!sessionPending ? (
          <div className="session-node-menu" onClick={(event) => event.stopPropagation()}>
            <button
              type="button"
              className="button-secondary icon-button session-more-button"
              onClick={(event) => {
                event.stopPropagation();
                setSessionMenuSessionId((current) => current === session.id ? null : session.id);
              }}
              title={copy.moreActions}
              aria-label={copy.moreActions}
            >
              <MoreIcon />
            </button>

            {menuOpen ? (
              <div className="session-context-menu" role="menu">
                {session.sessionType === 'code' ? (
                  <>
                    <button
                      type="button"
                      className="session-context-item"
                      role="menuitem"
                      onClick={() => invokeSessionRailAction(session, 'edit')}
                      disabled={busy === `rename-${session.id}`}
                    >
                      {copy.rename}
                    </button>
                    <button
                      type="button"
                      className="session-context-item"
                      role="menuitem"
                      onClick={() => invokeSessionRailAction(session, 'info')}
                    >
                      {copy.info}
                    </button>
                  </>
                ) : null}
                <button
                  type="button"
                  className="session-context-item"
                  role="menuitem"
                  onClick={() => void handleForkSession(session)}
                  disabled={busy === `fork-${session.id}`}
                >
                  {copy.fork}
                </button>
                <button
                  type="button"
                  className="session-context-item session-context-item-danger"
                  role="menuitem"
                  onClick={() => {
                    setSessionMenuSessionId(null);
                    setConfirmAction({ kind: 'delete', session });
                  }}
                  disabled={busy === `delete-${session.id}`}
                >
                  {copy.delete}
                </button>
              </div>
            ) : null}
          </div>
        ) : null}
      </li>
    );
  }

  function openWorkspaceManager(mode: WorkspaceModalMode) {
    setDetailMenuOpen(false);
    setSessionMenuSessionId(null);
    setWorkspaceModalMode(mode);
    if (mode === 'create') {
      setWorkspaceDraftName('');
      window.setTimeout(() => {
        workspaceDraftInputRef.current?.focus();
      }, 0);
    }
  }

  function handleRailResizeStart(event: ReactMouseEvent<HTMLDivElement>) {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = railWidth;

    function handlePointerMove(moveEvent: MouseEvent) {
      const nextWidth = startWidth + (moveEvent.clientX - startX);
      setRailWidth(Math.min(520, Math.max(260, nextWidth)));
    }

    function handlePointerUp() {
      window.removeEventListener('mousemove', handlePointerMove);
      window.removeEventListener('mouseup', handlePointerUp);
    }

    window.addEventListener('mousemove', handlePointerMove);
    window.addEventListener('mouseup', handlePointerUp);
  }

  if (error && !bootstrap) {
    return (
      <main className="shell shell-error">
        <section className="error-card">
          <p className="eyebrow">{copy.hostUnavailableTitle}</p>
          <h1>{copy.hostUnavailableTitle}</h1>
          <p>{error}</p>
          <p>{copy.hostUnavailableHint}</p>
        </section>
      </main>
    );
  }

  if (!bootstrap) {
    return (
      <main className="shell shell-loading">
        <section className="loading-card">
          <p className="eyebrow">remote-vibe-coding</p>
          <h1>Loading…</h1>
        </section>
      </main>
    );
  }

  return (
    <main className="shell">
      <header className="topbar">
        <div>
          <h1>{bootstrap.productName}</h1>
        </div>
        <div className="topbar-meta">
          <div className={`topbar-network topbar-network-${networkState}`} role="status" aria-live="polite" title={copy.networkStatusComment}>
            <span className="topbar-network-dot" aria-hidden="true" />
            <span>
              {networkState === 'ok'
                ? copy.networkStatusOk
                : networkState === 'recovering'
                  ? copy.networkStatusRecovering
                  : copy.networkStatusDown}
            </span>
          </div>
          {modeAllowsSwitch ? (
            <button
              type="button"
              className="button-secondary topbar-button"
              onClick={() => setActiveMode((current) => current === 'developer' ? 'chat' : 'developer')}
              title={language === 'zh' ? '切换模式' : 'Switch mode'}
            >
              {modeLabel(language, activeMode === 'developer' ? 'chat' : 'developer')}
            </button>
          ) : null}
          {bootstrap.currentUser.isAdmin ? (
            <button type="button" className="button-secondary topbar-button" onClick={() => setAdminOpen(true)} title={copy.adminComment}>
              {copy.admin}
            </button>
          ) : null}
          <button type="button" className="button-secondary topbar-button" onClick={() => setSettingsOpen(true)} title={copy.settingsComment}>
            {copy.settings}
          </button>
        </div>
      </header>

      {error ? (
        <div className="toast-stack" role="status" aria-live="polite">
          <div className="toast toast-error">
            <span>{error}</span>
            <button type="button" className="button-secondary toast-close" onClick={() => setError(null)}>
              {copy.close}
            </button>
          </div>
        </div>
      ) : null}

      <section
        className="workspace"
        style={activeMode === 'developer'
          ? (railHidden
            ? { gridTemplateColumns: 'minmax(0, 1fr)' }
            : { gridTemplateColumns: `${railWidth}px 10px minmax(0, 1fr)` })
          : undefined}
      >
        {!railHidden ? (
          <aside className="panel rail">
          <div className="rail-header">
            <div>
              <p className="eyebrow">{railEyebrow}</p>
              {activeMode === 'developer' ? null : <h2>{bootstrap.currentUser.username}</h2>}
            </div>
            {activeMode === 'chat' ? (
              <div className="rail-actions">
                <button
                  type="button"
                  onClick={() => {
                    void handleCreateConversation();
                  }}
                >
                  {railPrimaryActionLabel}
                </button>
              </div>
            ) : null}
          </div>

          <div className="rail-body">
          {activeMode === 'developer' ? (
            <div className="rail-section">
              <ul className="session-list workspace-tree">
                {visibleWorkspaces.length === 0 ? (
                  <li className="session-empty">{noWorkspaceLabel}</li>
                ) : (
                  visibleWorkspaces.map((workspace) => {
                    const workspaceSessions = allSessions.filter((session) => session.workspaceId === workspace.id);
                    const workspaceOpen = expandedWorkspaceIds.includes(workspace.id);

                    return (
                      <li
                        key={workspace.id}
                        className={`session-card workspace-card ${workspaceOpen ? 'workspace-card-open' : ''} ${workspace.id.startsWith(OPTIMISTIC_WORKSPACE_PREFIX) ? 'session-card-pending' : ''}`}
                      >
                        <button
                          type="button"
                          className="workspace-card-trigger"
                          onClick={() => {
                            if (workspace.id.startsWith(OPTIMISTIC_WORKSPACE_PREFIX)) return;
                            toggleWorkspaceExpanded(workspace.id);
                          }}
                        >
                          <div className="session-card-title">
                            <h3 title={workspace.path}>{workspace.name}</h3>
                          </div>
                          <ChevronIcon open={workspaceOpen} />
                        </button>

                        {workspaceOpen ? (
                          <div className="workspace-children">
                            <ul className="session-list workspace-session-list">
                              {workspaceSessions.length === 0 ? (
                                <li className="session-empty">{railEmptyLabel}</li>
                              ) : (
                                workspaceSessions.map((session) => renderSessionRailItem(session))
                              )}
                            </ul>
                          </div>
                        ) : null}
                      </li>
                    );
                  })
                )}
              </ul>
            </div>
          ) : (
            <div className="rail-section">
              <div className="rail-section-toggle">
                <span>{copy.history} ({railItems.length})</span>
              </div>
              <ul className="session-list">
                {railItems.length === 0 ? (
                  <li className="session-empty">{railEmptyLabel}</li>
                ) : (
                  railItems.map((session) => renderSessionRailItem(session))
                )}
              </ul>
            </div>
          )}
          </div>

          {activeMode === 'developer' ? (
            <div className="rail-footer">
              <div className="rail-footer-actions">
                <button type="button" className="button-secondary" onClick={() => openWorkspaceManager('create')}>
                  {copy.createWorkspaceAction}
                </button>
                <button type="button" onClick={() => openWorkspaceManager('manage')}>
                  {copy.manageWorkspaces}
                </button>
              </div>
            </div>
          ) : null}
        </aside>
        ) : null}

        {!railHidden && activeMode === 'developer' ? (
          <div className="rail-resizer" onMouseDown={handleRailResizeStart} role="separator" aria-orientation="vertical" aria-label={copy.hideSidebar} />
        ) : null}

        <section className="panel transcript">
          <div className="panel-header">
            <div className="session-title-row">
              {detail ? (
                inlineRenameActive ? (
                  <div className="session-title-inline">
                    <input
                      ref={inlineRenameInputRef}
                      className="session-title-input"
                      value={inlineRenameTitle}
                      onChange={(event) => setInlineRenameTitle(event.target.value)}
                      onKeyDown={handleInlineRenameKeyDown}
                      aria-label={copy.rename}
                    />
                    <div className="session-title-inline-actions">
                      <button
                        type="button"
                        className="button-secondary icon-button"
                        onClick={() => void saveInlineRename()}
                        title={copy.confirmAction}
                        aria-label={copy.confirmAction}
                        disabled={!inlineRenameTitle.trim()}
                      >
                        <CheckIcon />
                      </button>
                      <button
                        type="button"
                        className="button-secondary icon-button"
                        onClick={cancelInlineRename}
                        title={copy.close}
                        aria-label={copy.close}
                      >
                        <RemoveIcon />
                      </button>
                    </div>
                  </div>
                ) : (
                  <button
                    type="button"
                  className="session-title-trigger"
                  onClick={beginInlineRename}
                  title={activeMode === 'developer' ? (detail.session.workspace ?? undefined) : undefined}
                  disabled={selectedSessionIsOptimistic || inlineRenameBusy}
                >
                    <h2>{detailSessionTitle}</h2>
                  </button>
                )
              ) : (
                <h2>{copy.selectOrCreate}</h2>
              )}
              {detail ? (
                inlineRenameActive || sessionIsChat ? null : (
                  <div className="session-title-actions">
                    <button
                      type="button"
                      className="button-secondary icon-button"
                      onClick={(event) => {
                        event.stopPropagation();
                        setSessionMenuSessionId(null);
                        setDetailMenuOpen((current) => !current);
                      }}
                      title={copy.moreActions}
                      aria-label={copy.moreActions}
                      disabled={selectedSessionIsOptimistic}
                    >
                      <MoreIcon />
                    </button>
                    {detailMenuOpen ? (
                      <div className="session-context-menu header-context-menu" role="menu" onClick={(event) => event.stopPropagation()}>
                        <button
                          type="button"
                          className="session-context-item"
                          role="menuitem"
                          onClick={() => openSessionEditor(detail.session)}
                          disabled={selectedSessionIsOptimistic || inlineRenameBusy}
                        >
                          {copy.rename}
                        </button>
                        <button
                          type="button"
                          className="session-context-item"
                          role="menuitem"
                          onClick={() => {
                            setDetailMenuOpen(false);
                            setSessionInfoOpen(true);
                          }}
                          disabled={selectedSessionIsOptimistic}
                        >
                          {copy.info}
                        </button>
                      </div>
                    ) : null}
                  </div>
                )
              ) : null}
            </div>
          </div>

          {detail ? (
            <div className="transcript-layout">
              <div className="transcript-scroll" ref={transcriptScrollRef} onScroll={handleTranscriptScroll}>
                <div className="chat-list">
                  {transcriptLoadingOlder ? (
                    <div className="chat-loading-older">{copy.loadingOlderMessages}</div>
                  ) : null}
                  {transcriptItems.length === 0 ? null : (
                    transcriptItems.map((event) => {
                      if (event.kind === 'tool') {
                        return (
                          <TranscriptToolCard
                            key={event.id}
                            entry={event}
                            badgeLabel={toolLabel(event, language)}
                            language={language}
                            noInlineDiffLabel={copy.noInlineDiff}
                          />
                        );
                      }

                      if (event.kind === 'status') {
                        return (
                          <article key={event.id} className="event-card event-status">
                            <div className="event-meta">
                              <span>{copy.sessionState}</span>
                              <strong>{event.title ?? copy.activity}</strong>
                            </div>
                            <p>{event.body}</p>
                          </article>
                        );
                      }

                      return (
                        <article key={event.id} className={`chat-message chat-${event.kind}`}>
                          {event.attachments.length > 0 ? (
                            <div className="chat-attachments">
                              {event.attachments.map((attachment) => (
                                <a
                                  key={attachment.id}
                                  className={`chat-attachment-card chat-attachment-card-${attachment.kind}`}
                                  href={attachment.url}
                                  target="_blank"
                                  rel="noreferrer"
                                >
                                  {attachment.kind === 'image' ? (
                                    <div className="chat-attachment-media">
                                      <img src={attachment.url} alt={attachment.filename} className="chat-attachment-image" />
                                    </div>
                                  ) : null}
                                  <div className="chat-attachment-copy">
                                    <strong>{attachment.filename}</strong>
                                    <span>{formatAttachmentSize(attachment.sizeBytes)}</span>
                                  </div>
                                </a>
                              ))}
                            </div>
                          ) : null}
                          {event.body && event.markdown ? (
                            <div className="markdown-body chat-body">
                              <ReactMarkdown remarkPlugins={[remarkGfm]}>
                                {event.body}
                              </ReactMarkdown>
                            </div>
                          ) : event.body ? (
                            <pre className="event-body">{event.body}</pre>
                          ) : null}
                        </article>
                      );
                    })
                  )}
                </div>
              </div>

              {detailSessionState ? (
                <section
                  ref={detailSessionState === 'pending' ? approvalPromptRef : null}
                  className={`session-status-bar session-status-${detailSessionState}`}
                  tabIndex={detailSessionState === 'pending' ? 0 : undefined}
                  onKeyDown={detailSessionState === 'pending' ? handleApprovalPromptKeyDown : undefined}
                >
                  <div className="session-status-copy">
                    <div className="session-status-title-row">
                      <span className={`session-status-badge session-status-badge-${detailSessionState}`}>
                        {detailSessionState === 'processing'
                          ? copy.processingStatus
                          : detailSessionState === 'pending'
                            ? copy.approvalPendingStatus
                            : detailSessionState === 'completed'
                              ? copy.turnCompleteStatus
                              : detailSessionState === 'error'
                                ? copy.errorStatus
                                : detailSessionState === 'stale'
                                  ? copy.staleStatus
                                  : copy.noTurnsYet}
                      </span>
                      {detailSessionState === 'pending' && activeApproval ? (
                        <strong>{activeApproval.title}</strong>
                      ) : null}
                    </div>

                    {detailSessionState === 'processing' ? (
                      <p>{copy.processingHint}</p>
                    ) : null}

                    {detailSessionState === 'pending' ? (
                      <>
                        {activeApproval ? <p>{activeApproval.risk}</p> : null}
                        <p className="detail-card-meta">{copy.approvalPendingHint}</p>
                        {activeApproval ? <p className="detail-card-meta">{copy.approvalKeyboardHint}</p> : null}
                        {pendingApprovals.length > 1 ? (
                          <p className="detail-card-meta">{formatRemainingApprovals(pendingApprovals.length - 1, language)}</p>
                        ) : null}
                      </>
                    ) : null}

                    {detailSessionState === 'completed' ? (
                      <p>{copy.turnCompleteHint}</p>
                    ) : null}

                    {detailSessionState === 'new' ? (
                      <p>{copy.noTurnsHint}</p>
                    ) : null}

                    {detailSessionState === 'error' ? (
                      <p>{detail.session.lastIssue ?? copy.errorHint}</p>
                    ) : null}

                    {detailSessionState === 'stale' ? (
                      <p>{copy.staleHint}</p>
                    ) : null}
                  </div>

                  {detailSessionState === 'pending' && activeApproval ? (
                    <div className="approval-inline-options session-status-actions">
                      {approvalOptions.map((option, index) => (
                        <button
                          key={`${option.decision}-${option.scope}`}
                          type="button"
                          className={`approval-inline-option ${index === approvalSelectionIndex ? 'approval-inline-option-active' : ''} ${option.tone === 'secondary' ? 'approval-inline-option-secondary' : ''}`}
                          onClick={() => void handleApprovalAction(activeApproval, option.decision, option.scope)}
                          disabled={busy === activeApproval.id}
                        >
                          <span className="approval-inline-marker">{index === approvalSelectionIndex ? '›' : ''}</span>
                          <span>{option.label}</span>
                        </button>
                      ))}
                    </div>
                  ) : null}
                </section>
              ) : null}

              <form className="composer-form composer-docked" onSubmit={handleStartTurn}>
                <div className="composer-shell">
                  <input
                    ref={attachmentInputRef}
                    type="file"
                    multiple
                    hidden
                    onChange={handleAttachmentSelection}
                  />
                  {detail ? (
                    <div className="composer-config-row">
                      <label className="composer-config-field">
                        <span>{copy.model}</span>
                        <AppSelect
                          className="app-select-compact"
                          value={sessionModel}
                          options={modelSelectOptions}
                          onChange={handleSessionModelChange}
                          ariaLabel={copy.model}
                          disabled={busy === 'update-session-preferences' || availableModels.length === 0}
                        />
                      </label>
                      <label className="composer-config-field">
                        <span>{copy.thinking}</span>
                        <AppSelect
                          className="app-select-compact"
                          value={sessionEffort}
                          options={effortSelectOptions}
                          onChange={(nextValue) => handleSessionEffortChange(nextValue as ReasoningEffort)}
                          ariaLabel={copy.thinking}
                          disabled={busy === 'update-session-preferences'}
                        />
                      </label>
                      {!sessionIsChat ? (
                        <label className="composer-config-field">
                          <span>{copy.approvalModeLabel}</span>
                          <AppSelect
                            className="app-select-compact"
                            value={sessionApprovalMode}
                            options={approvalModeSelectOptions}
                            onChange={(nextValue) => handleSessionApprovalModeChange(nextValue as ApprovalMode)}
                            ariaLabel={copy.approvalModeLabel}
                            disabled={busy === 'update-session-preferences'}
                          />
                        </label>
                      ) : null}
                    </div>
                  ) : null}
                  {draftAttachments.length > 0 ? (
                    <div className="draft-attachments">
                      {draftAttachments.map((attachment) => (
                        <div key={attachment.id} className={`draft-attachment-chip draft-attachment-${attachment.kind}`}>
                          <div className="draft-attachment-copy">
                            <strong>{attachment.filename}</strong>
                            <span>{formatAttachmentSize(attachment.sizeBytes)}</span>
                          </div>
                          <button
                            type="button"
                            className="button-secondary icon-button draft-attachment-remove"
                            onClick={() => void handleRemoveDraftAttachment(attachment)}
                            disabled={busy === `remove-attachment-${attachment.id}` || busy === 'start-turn'}
                            title={copy.removeAttachment}
                            aria-label={copy.removeAttachment}
                          >
                            <RemoveIcon />
                          </button>
                        </div>
                      ))}
                    </div>
                  ) : null}
                  <div className="composer-row">
                    <textarea
                      ref={promptTextareaRef}
                      value={prompt}
                      onChange={(event) => setPrompt(event.target.value)}
                      onKeyDown={handlePromptKeyDown}
                      onCompositionStart={handlePromptCompositionStart}
                      onCompositionEnd={handlePromptCompositionEnd}
                      rows={1}
                      placeholder={copy.prompt}
                      disabled={selectedSessionIsOptimistic || Boolean(activeApproval)}
                    />
                    <div className="composer-actions">
                      <button
                        type="button"
                        className="button-secondary icon-button attach-button"
                        onClick={() => attachmentInputRef.current?.click()}
                        disabled={selectedSessionIsOptimistic || busy === 'upload-attachment' || busy === 'start-turn' || sessionHasActiveTurn || Boolean(activeApproval)}
                        title={busy === 'upload-attachment' ? copy.uploadingFiles : copy.attachFiles}
                        aria-label={busy === 'upload-attachment' ? copy.uploadingFiles : copy.attachFiles}
                      >
                        <AttachmentIcon />
                      </button>
                      {sessionHasActiveTurn ? (
                        <button
                          type="button"
                          className="stop-button"
                          onClick={() => void handleStopActiveTurn()}
                          disabled={busy === 'stop-session' || Boolean(activeApproval)}
                          title={busy === 'stop-session' ? copy.stopping : copy.stop}
                          aria-label={busy === 'stop-session' ? copy.stopping : copy.stop}
                        >
                          <StopIcon />
                        </button>
                      ) : null}
                      <button
                        type="submit"
                        className="send-button"
                        disabled={selectedSessionIsOptimistic || busy === 'start-turn' || busy === 'stop-session' || busy === 'upload-attachment' || sessionHasActiveTurn || Boolean(activeApproval) || (!prompt.trim() && draftAttachments.length === 0)}
                        title={sessionHasActiveTurn ? copy.stop : busy === 'start-turn' ? copy.sending : copy.sendPrompt}
                        aria-label={sessionHasActiveTurn ? copy.stop : busy === 'start-turn' ? copy.sending : copy.sendPrompt}
                      >
                        <SendIcon />
                      </button>
                    </div>
                  </div>
                </div>
              </form>
            </div>
          ) : (
            <section className="empty-state">
              <p className="eyebrow">{copy.noActiveSelection}</p>
              <h2>{copy.pickSessionHint}</h2>
            </section>
          )}
        </section>
      </section>

      {settingsOpen ? (
        <div className="settings-overlay" onClick={() => setSettingsOpen(false)}>
          <aside className="settings-sheet" onClick={(event) => event.stopPropagation()}>
            <div className="panel-header settings-header">
              <div>
                <p className="eyebrow">{copy.settings}</p>
                <h2>{copy.settingsTitle}</h2>
              </div>
              <button type="button" className="button-secondary topbar-button" onClick={() => setSettingsOpen(false)}>
                {copy.close}
              </button>
            </div>

            <section className="settings-section">
              <div className="settings-section-head">
                <strong>{copy.account}</strong>
              </div>
              <div className="settings-account-grid">
                <div className="settings-account-item">
                  <span>{copy.username}</span>
                  <strong>{bootstrap.currentUser.username}</strong>
                </div>
                <div className="settings-account-item">
                  <span>{copy.roleLabel}</span>
                  <strong>{currentUserRoles.map((role) => roleLabel(language, role)).join(', ')}</strong>
                </div>
              </div>
              <button type="button" className="button-secondary settings-signout" onClick={() => void handleLogout()} disabled={busy === 'logout'}>
                {busy === 'logout' ? copy.signingOut : copy.signOut}
              </button>
            </section>

            <section className="settings-section">
              <div className="settings-section-head">
                <strong>{copy.languageSetting}</strong>
                <span>{copy.languageSettingHint}</span>
              </div>
              <div className="settings-language-row">
                <button
                  type="button"
                  className={language === 'en' ? 'button-secondary settings-language-button settings-language-button-active' : 'button-secondary settings-language-button'}
                  onClick={() => setLanguage('en')}
                >
                  {copy.languageEnglish}
                </button>
                <button
                  type="button"
                  className={language === 'zh' ? 'button-secondary settings-language-button settings-language-button-active' : 'button-secondary settings-language-button'}
                  onClick={() => setLanguage('zh')}
                >
                  {copy.languageChinese}
                </button>
              </div>
            </section>

            <section className="settings-section">
              <div className="settings-section-head">
                <strong>{copy.remoteAccess}</strong>
              </div>
              <div className="remote-status-row">
                <span className="remote-status-pill">{cloudflare?.mode ?? copy.tunnelUnavailable}</span>
                {cloudflare?.state === 'connected' ? <span className="remote-status-pill remote-status-pill-live">{copy.tunnelLive}</span> : null}
                {cloudflareManagedBySystem ? <span className="remote-status-pill">{copy.managedBySystem}</span> : null}
              </div>
              {cloudflare?.publicUrl ? (
                <p className="remote-access-url">
                  <a href={cloudflare.publicUrl} target="_blank" rel="noreferrer">
                    {cloudflare.publicUrl}
                  </a>
                </p>
              ) : null}
              {cloudflare?.lastError ? <p className="remote-access-error">{cloudflare.lastError}</p> : null}
              {!cloudflareManagedBySystem ? (
                <div className="remote-button-row">
                  {cloudflareManagedLocally ? (
                    <button
                      type="button"
                      className="button-secondary"
                      onClick={() => void handleDisconnectCloudflare()}
                      disabled={!cloudflare?.installed || busy === 'disconnect-cloudflare'}
                    >
                      {busy === 'disconnect-cloudflare' ? copy.disconnecting : copy.disconnect}
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={() => void handleConnectCloudflare()}
                      disabled={!cloudflare?.installed || busy === 'connect-cloudflare' || cloudflare?.state === 'connecting'}
                    >
                      {busy === 'connect-cloudflare' || cloudflare?.state === 'connecting'
                        ? copy.connecting
                        : copy.connectTunnel}
                    </button>
                  )}
                </div>
              ) : null}
            </section>
          </aside>
        </div>
      ) : null}

      {adminOpen ? (
        <div className="settings-overlay" onClick={() => setAdminOpen(false)}>
          <aside className="settings-sheet admin-sheet" onClick={(event) => event.stopPropagation()}>
            <div className="panel-header settings-header">
              <div>
                <p className="eyebrow">{copy.admin}</p>
                <h2>{copy.users}</h2>
              </div>
              <div className="admin-toolbar">
                <button type="button" onClick={openCreateUserModal}>{copy.newUser}</button>
                <button type="button" className="button-secondary topbar-button" onClick={() => setAdminOpen(false)}>
                  {copy.close}
                </button>
              </div>
            </div>

            <div className="admin-user-list">
              {(adminUsers ?? []).length === 0 ? (
                <article className="detail-card">
                  <strong>{copy.noUsersYet}</strong>
                </article>
              ) : (
                adminUsers?.map((user) => (
                  <article key={user.id} className="detail-card admin-user-card">
                    {(() => {
                      const userRoles = deriveRolesFromLegacy(user);
                      return (
                        <>
                    <div className="detail-card-head">
                      <strong>{user.username}</strong>
                      <span>{userRoles.map((role) => roleLabel(language, role)).join(', ')}</span>
                    </div>
                    <p className="detail-card-meta">{copy.roleLabel}: {userRoles.map((role) => roleLabel(language, role)).join(', ')}</p>
                    <p className="detail-card-meta">{copy.canUseFullHost}: {user.canUseFullHost ? 'yes' : 'no'}</p>
                    <label className="token-block">
                      <span>{copy.currentToken}</span>
                      <input readOnly value={user.token} />
                    </label>
                    <div className="approval-actions">
                      <button type="button" onClick={() => openEditUserModal(user)}>
                        {copy.editUser}
                      </button>
                      <button
                        type="button"
                        className="button-danger"
                        onClick={() => void handleDeleteUser(user)}
                        disabled={busy === `delete-user-${user.id}`}
                      >
                        {busy === `delete-user-${user.id}` ? copy.deleting : copy.deleteUser}
                      </button>
                    </div>
                        </>
                      );
                    })()}
                  </article>
                ))
              )}
            </div>
          </aside>
        </div>
      ) : null}

      {sessionInfoOpen && detail && !sessionIsChat ? (
        <div className="modal-overlay" onClick={() => setSessionInfoOpen(false)}>
          <div className="modal-card" onClick={(event) => event.stopPropagation()}>
            <div className="panel-header settings-header">
              <div>
                <p className="eyebrow">{copy.info}</p>
                <h2>{copy.sessionInfoTitle}</h2>
              </div>
              <button type="button" className="button-secondary topbar-button" onClick={() => setSessionInfoOpen(false)}>
                {copy.close}
              </button>
            </div>

            <div className="detail-list">
              <article className="detail-card">
                <div className="detail-card-head">
                  <strong>{detail.session.title}</strong>
                  <span>{detailSessionState ? uiSessionStateLabel(language, detailSessionState) : uiSessionStateLabel(language, 'completed')}</span>
                </div>
                <p className="detail-card-meta">{copy.workspace}: {detail.session.workspace}</p>
                <p className="detail-card-meta">{copy.sessionType}: {detail.session.sessionType === 'chat' ? copy.chatSession : copy.codeSession}</p>
                <p className="detail-card-meta">{copy.sessionOwner}: {detail.session.ownerUsername}</p>
                <p className="detail-card-meta">{copy.securityLabel}: {securityProfileLabel(language, detail.session.sessionType, detail.session.securityProfile)}</p>
                {detail.session.sessionType === 'code' ? (
                  <p className="detail-card-meta">{copy.approvalModeLabel}: {approvalModeLabel(language, detail.session.approvalMode)}</p>
                ) : null}
                <p className="detail-card-meta">{copy.modelLabel}: {detail.session.model ?? 'codex'}</p>
                <p className="detail-card-meta">{copy.thinkingLabel}: {detail.session.reasoningEffort ?? 'medium'}</p>
                <p className="detail-card-meta">{copy.threadLabel}: {shortThreadId(detail.session.threadId)}</p>
                <p className="detail-card-meta">{copy.createdAt} {formatTimestamp(detail.session.createdAt, language)}</p>
                <p className="detail-card-meta">{copy.updatedAt} {formatTimestamp(detail.session.updatedAt, language)}</p>
                {detail.session.lastIssue && detail.session.status !== 'stale' ? <p>{detail.session.lastIssue}</p> : null}
              </article>

              {sessionIsChat ? (
                <article className="detail-card">
                  <strong>{copy.chatSessionHint}</strong>
                  <p>{copy.commandToolingHidden}</p>
                </article>
              ) : null}
            </div>
          </div>
        </div>
      ) : null}

      {workspaceModalMode ? (
        <div className="modal-overlay" onClick={() => setWorkspaceModalMode(null)}>
          <div className={`modal-card workspace-manager-modal ${workspaceModalMode === 'create' ? 'workspace-create-modal' : ''}`} onClick={(event) => event.stopPropagation()}>
            <div className="panel-header settings-header">
              <div>
                <p className="eyebrow">{workspaceModalMode === 'create' ? copy.createWorkspaceAction : copy.manageWorkspaces}</p>
                <h2>{workspaceModalMode === 'create' ? copy.createWorkspaceTitle : copy.manageWorkspacesTitle}</h2>
              </div>
              <button type="button" className="button-secondary topbar-button" onClick={() => setWorkspaceModalMode(null)}>
                {copy.close}
              </button>
            </div>

            {workspaceModalMode === 'create' ? (
              <form className="create-form workspace-create-form" onSubmit={handleCreateWorkspace}>
                <label className="field">
                  <span>{copy.workspace}</span>
                  <input
                    ref={workspaceDraftInputRef}
                    value={workspaceDraftName}
                    onChange={(event) => setWorkspaceDraftName(event.target.value)}
                    placeholder={copy.workspaceFolder}
                  />
                </label>
                <button type="submit" disabled={busy === 'create-workspace' || !workspaceDraftName.trim()}>
                  {busy === 'create-workspace' ? copy.creating : copy.createWorkspaceAction}
                </button>
              </form>
            ) : (
              <div className="workspace-manager-columns">
                <section className="rail-section">
                  <div className="rail-section-toggle">
                    <span>{copy.visibleWorkspaces} ({visibleWorkspaces.length})</span>
                  </div>
                  <ul className="session-list workspace-manager-list">
                    {visibleWorkspaces.length === 0 ? (
                      <li className="session-empty">{noWorkspaceLabel}</li>
                    ) : (
                      visibleWorkspaces.map((workspace, index) => (
                        <li key={workspace.id} className={`session-card workspace-manager-card ${selectedWorkspaceId === workspace.id ? 'session-card-active' : ''}`}>
                          <div className="workspace-manager-row">
                            <div className="workspace-manager-copy">
                              <div className="workspace-manager-title-row">
                                <div className="session-card-title">
                                  <h3 title={workspace.path}>{workspace.name}</h3>
                                </div>
                              </div>
                              <div className="workspace-manager-actions">
                                <button type="button" className="button-secondary" onClick={() => void handleMoveWorkspace(workspace.id, -1)} disabled={index === 0}>
                                  {copy.moveWorkspaceUp}
                                </button>
                                <button
                                  type="button"
                                  className="button-secondary"
                                  onClick={() => void handleMoveWorkspace(workspace.id, 1)}
                                  disabled={index === visibleWorkspaces.length - 1}
                                >
                                  {copy.moveWorkspaceDown}
                                </button>
                              </div>
                            </div>
                          </div>
                        </li>
                      ))
                    )}
                  </ul>
                </section>
              </div>
            )}
          </div>
        </div>
      ) : null}

      {editSessionId && detail ? (
        <div className="modal-overlay" onClick={() => {
          setEditSessionId(null);
          setEditTitle('');
          setEditWorkspaceName('');
        }}>
          <div className="modal-card" onClick={(event) => event.stopPropagation()}>
            <div className="panel-header settings-header">
              <div>
                <p className="eyebrow">{copy.rename}</p>
                <h2>{copy.renameSessionTitle}</h2>
              </div>
              <button type="button" className="button-secondary topbar-button" onClick={() => {
                setEditSessionId(null);
                setEditTitle('');
                setEditWorkspaceName('');
              }}>
                {copy.close}
              </button>
            </div>

            <form className="create-form" onSubmit={handleSaveSession}>
              <article className="detail-card">
                <strong>{copy.sessionType}</strong>
                <p className="detail-card-meta">{detail.session.sessionType === 'chat' ? copy.chatSession : copy.codeSession}</p>
                {detail.session.sessionType === 'code' ? (
                  <>
                    <p className="detail-card-meta">{copy.workspace}: {detail.session.workspace}</p>
                    <p>{copy.sessionContextResetHint}</p>
                  </>
                ) : null}
              </article>

              <label className="field">
                <span>{copy.title}</span>
                <input value={editTitle} onChange={(event) => setEditTitle(event.target.value)} placeholder={copy.title} />
              </label>

              {detail.session.sessionType === 'code' ? (
                <label className="field">
                  <span>{copy.securityProfile}</span>
                  <AppSelect
                    value={editSecurityProfile}
                    options={securityProfileSelectOptions}
                    onChange={(nextValue) => setEditSecurityProfile(nextValue as 'repo-write' | 'full-host')}
                    ariaLabel={copy.securityProfile}
                  />
                </label>
              ) : (
                <article className="detail-card">
                  <strong>{copy.readOnlyProfile}</strong>
                  <p>{copy.chatSessionHint}</p>
                </article>
              )}

              <button type="submit" disabled={busy === `rename-${editSessionId}` || !canSaveSession}>
                {busy === `rename-${editSessionId}` ? copy.renaming : copy.saveName}
              </button>
            </form>
          </div>
        </div>
      ) : null}

      {confirmAction ? (
        <div className="modal-overlay" onClick={() => setConfirmAction(null)}>
          <div className="modal-card confirm-modal-card" onClick={(event) => event.stopPropagation()}>
            <div className="panel-header settings-header">
              <div>
                <p className="eyebrow">{copy.delete}</p>
                <h2>{copy.confirmDeleteTitle}</h2>
              </div>
              <button type="button" className="button-secondary topbar-button" onClick={() => setConfirmAction(null)}>
                {copy.close}
              </button>
            </div>

            <div className="detail-list">
              <article className="detail-card">
                <strong>{confirmAction.session.title}</strong>
                <p>{copy.sessionDeletedConfirm.replace('{title}', confirmAction.session.title)}</p>
              </article>
            </div>

            <div className="confirm-modal-actions">
              <button type="button" className="button-secondary" onClick={() => setConfirmAction(null)}>
                {copy.close}
              </button>
              <button
                type="button"
                className="button-danger"
                onClick={() => void handleConfirmSessionAction()}
                disabled={busy === `delete-${confirmAction.session.id}`}
              >
                {copy.confirmAction}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {userModalOpen ? (
        <div className="modal-overlay" onClick={() => setUserModalOpen(false)}>
          <div className="modal-card" onClick={(event) => event.stopPropagation()}>
            <div className="panel-header settings-header">
              <div>
                <p className="eyebrow">{userModalMode === 'create' ? copy.newUser : copy.editUser}</p>
                <h2>{userModalMode === 'create' ? copy.createUser : copy.editUser}</h2>
              </div>
              <button type="button" className="button-secondary topbar-button" onClick={() => setUserModalOpen(false)}>
                {copy.close}
              </button>
            </div>

            <form className="create-form" onSubmit={handleUserSubmit}>
              <label className="field">
                <span>{copy.username}</span>
                <input value={userForm.username} onChange={(event) => setUserForm((current) => ({ ...current, username: event.target.value }))} />
              </label>
              <label className="field">
                <span>{copy.password}</span>
                <input
                  type="password"
                  value={userForm.password}
                  onChange={(event) => setUserForm((current) => ({ ...current, password: event.target.value }))}
                  placeholder={userModalMode === 'edit' ? copy.optionalPassword : undefined}
                />
              </label>

              <div className="checkbox-grid">
                <label className="checkbox-field">
                  <input
                    type="checkbox"
                    checked={userForm.allowChat}
                    onChange={(event) => setUserForm((current) => ({ ...current, allowChat: event.target.checked }))}
                  />
                  <span>{roleLabel(language, 'user')}</span>
                </label>
                <label className="checkbox-field">
                  <input
                    type="checkbox"
                    checked={userForm.allowCode}
                    onChange={(event) => setUserForm((current) => ({
                      ...current,
                      allowCode: event.target.checked,
                      canUseFullHost: event.target.checked ? current.canUseFullHost : false,
                    }))}
                  />
                  <span>{roleLabel(language, 'developer')}</span>
                </label>
                <label className="checkbox-field">
                  <input
                    type="checkbox"
                    checked={userForm.isAdmin}
                    onChange={(event) => setUserForm((current) => ({ ...current, isAdmin: event.target.checked }))}
                  />
                  <span>{copy.adminRole}</span>
                </label>
                <label className="checkbox-field">
                  <input
                    type="checkbox"
                    checked={userForm.canUseFullHost}
                    disabled={!userForm.allowCode}
                    onChange={(event) => setUserForm((current) => ({ ...current, canUseFullHost: event.target.checked }))}
                  />
                  <span>{copy.canUseFullHost}</span>
                </label>
                {userModalMode === 'edit' ? (
                  <label className="checkbox-field">
                    <input
                      type="checkbox"
                      checked={userForm.regenerateToken}
                      onChange={(event) => setUserForm((current) => ({ ...current, regenerateToken: event.target.checked }))}
                    />
                    <span>{copy.regenerateToken}</span>
                  </label>
                ) : null}
              </div>

              <button type="submit" disabled={busy === 'create-user' || busy === `save-user-${editingUserId}`}>
                {userModalMode === 'create'
                  ? (busy === 'create-user' ? copy.creatingUser : copy.createUser)
                  : (busy === `save-user-${editingUserId}` ? copy.savingUser : copy.saveUser)}
              </button>
            </form>
          </div>
        </div>
      ) : null}
    </main>
  );
}
