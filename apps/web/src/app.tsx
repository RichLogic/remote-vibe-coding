import { Children, Fragment, isValidElement, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ChangeEvent, type ClipboardEvent as ReactClipboardEvent, type DragEvent as ReactDragEvent, type FormEvent, type KeyboardEvent, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

import { FileChangeList, TranscriptToolCard } from './transcript-tool-card';
import {
  createAdminUser,
  deleteAdminUser,
  fetchAdminUsers,
  fetchBootstrap,
  logout,
  updateAdminUser,
} from './api';
import {
  createChatRolePreset,
  createChatConversation,
  deleteChatAttachment,
  deleteChatConversation,
  deleteChatRolePreset,
  fetchChatBootstrap,
  fetchChatConversationDetail,
  fetchChatConversationTranscript,
  fetchChatRolePresets,
  forkChatConversation,
  resolveChatBodyLink,
  sendChatMessage,
  stopChatConversation,
  updateChatRolePreset,
  updateChatConversation,
  updateChatConversationPreferences,
  uploadChatAttachment,
} from './chat/api';
import {
  codingWorkspaceFileContentHref,
  createCodingWorkspace,
  createCodingWorkspaceSession,
  deleteQueuedCodingTurn,
  deleteCodingAttachment,
  deleteCodingSession,
  fetchCodingWorkspaceFile,
  fetchCodingWorkspaceTree,
  fetchCodingSessionDetail,
  fetchCodingSessionTranscript,
  forkCodingSession,
  reorderCodingWorkspaces,
  resolveCodingApproval,
  startCodingTurn,
  stopCodingSession,
  updateCodingSession,
  updateCodingSessionPreferences,
  updateCodingWorkspace,
  uploadCodingAttachment,
} from './coding/api';
import type {
  ChatBootstrapPayload,
  ChatConversation,
  ChatConversationDetailResponse,
  ChatRolePresetDetail,
  ChatRolePresetListResponse,
  ChatConversationSummary,
  ChatTranscriptPageResponse,
} from './chat/types';
import type {
  CodingWorkspaceFileEntry,
  CodingWorkspaceFileResponse,
  CodingSessionRecord as SessionRecord,
  CodingSessionSummary as SessionSummary,
  UpdateCodingSessionRequest as UpdateSessionRequest,
} from './coding/types';
import type {
  AdminUserRecord,
  AgentExecutor,
  ApprovalMode,
  AppMode,
  BootstrapPayload,
  ChatUiStatus,
  ConversationSummary,
  ModelOption,
  PendingApproval,
  ReasoningEffort,
  SessionAttachmentSummary,
  SessionDetailResponse,
  SessionEvent,
  SessionFileChange,
  SessionTranscriptEntry,
  SessionType,
  SecurityProfile,
  TranscriptEventKind,
  UserRole,
  WorkspaceSummary,
} from './types';

type Language = 'en' | 'zh';
type ThemeMode = 'white' | 'warm' | 'night';
type UserModalMode = 'create' | 'edit';
type WorkspaceModalMode = 'create';
type WorkspaceDropPosition = 'before' | 'after';
type DeveloperSubview = 'sessions' | 'files';
type DeveloperInspectorTab = 'preview' | 'diff';
type SessionConfirmAction = { kind: 'delete'; session: SessionDetailResponse['session'] } | null;
type UiSessionState = 'normal' | 'new' | 'pending' | 'completed' | 'error' | 'processing' | 'stale';
type NotificationSessionState = Exclude<UiSessionState, 'normal'>;
type ChatCompletionMarkerMap = Record<string, string>;
type ChatStatusRecord = Pick<ConversationSummary, 'id' | 'activeTurnId' | 'status' | 'uiStatus' | 'hasTranscript' | 'updatedAt'>;
type ModeOption = ApprovalMode;
type SystemNotificationPermission = NotificationPermission | 'unsupported';

interface UserFormState {
  username: string;
  password: string;
  roles: UserRole[];
  canUseFullHost: boolean;
}

interface ChatRolePresetFormState {
  label: string;
  description: string;
  prompt: string;
  isDefault: boolean;
}

interface SelectOption {
  value: string;
  label: string;
}

interface InlinePreviewResource {
  path: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
  previewable: boolean;
  truncated: boolean;
  content: string | null;
  inlineUrl: string;
  downloadUrl: string;
}

interface WorkspaceDropIndicator {
  workspaceId: string;
  position: WorkspaceDropPosition;
}

interface FileTreeDirectoryState {
  entries: CodingWorkspaceFileEntry[];
  loading: boolean;
  error: string | null;
}

interface NotificationSessionSnapshot {
  id: string;
  sessionType: SessionType;
  workspaceId: string | null;
  title: string;
  updatedAt: string;
  state: NotificationSessionState;
}

const FALLBACK_REASONING: ReasoningEffort[] = ['minimal', 'low', 'medium', 'high', 'xhigh'];
const TRANSCRIPT_PAGE_SIZE = 40;
const CREATE_WORKSPACE_OPTION = '__new_workspace__';
const COMPOSER_MAX_LINES = 6;
const ACTIVITY_TICKER_TRANSITION_MS = 280;
const OPTIMISTIC_SESSION_PREFIX = '__optimistic_session__:';
const OPTIMISTIC_WORKSPACE_PREFIX = '__optimistic_workspace__:';
const THEME_STORAGE_KEY = 'rvc-theme';
const CHAT_COMPLETION_MARKERS_STORAGE_KEY = 'rvc-chat-completion-markers';
const DEVELOPER_RAIL_HIDDEN_STORAGE_KEY = 'rvc-developer-rail-hidden';
const CHAT_RAIL_HIDDEN_STORAGE_KEY = 'rvc-chat-rail-hidden';

const UI_SESSION_STATE_LABELS: Record<Language, Record<UiSessionState, string>> = {
  en: {
    normal: 'Normal',
    new: 'New',
    pending: 'Pending',
    completed: 'Completed',
    error: 'Error',
    processing: 'Processing',
    stale: 'Stale',
  },
  zh: {
    normal: '普通',
    new: '新建',
    pending: '待处理',
    completed: '已完成',
    error: '错误',
    processing: '处理中',
    stale: '已失效',
  },
};

const SESSION_ACTIVITY_LABELS: Record<Language, Record<'thinking' | 'searching' | 'drafting', string>> = {
  en: {
    thinking: 'Thinking through the answer',
    searching: 'Searching the web',
    drafting: 'Drafting the reply',
  },
  zh: {
    thinking: '正在思考答案',
    searching: '正在搜索网页',
    drafting: '正在整理回复',
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
    networkAlertRecovering: 'Trying to reconnect to the local host service.',
    networkAlertDown: 'The browser cannot reach the local host service right now.',
    hideSidebar: 'Hide sidebar',
    showSidebar: 'Show sidebar',
    languageSetting: 'Language',
    languageSettingHint: 'Choose the interface language.',
    themeSetting: 'Theme',
    themeSettingHint: 'Choose the interface skin.',
    themeWhite: 'white',
    themeWarm: 'warm',
    themeNight: 'night',
    filesNav: 'files',
    refresh: 'Refresh',
    languageEnglish: 'English',
    languageChinese: '中文',
    languageButtonComment: 'Switch the interface language.',
    adminComment: 'Manage users and access permissions.',
    settingsComment: 'Open system settings.',
    archiveComment: 'Archive this session. You can restore it later.',
    restoreComment: 'Restore this archived session.',
    forkComment: 'Create a copy of this session with the same setup.',
    editComment: 'Edit the title, workspace, or session settings.',
    infoComment: 'View session details such as workspace, owner, and model.',
    deleteComment: 'Permanently delete this session.',
    modelComment: 'Choose which model this session will use for future turns.',
    thinkingComment: 'Set the reasoning depth for future turns in this session.',
    auditModelComment: 'Choose how automated this coding session should be.',
    attachComment: 'Attach files to your next prompt.',
    stopComment: 'Stop the active turn.',
    sendComment: 'Send the current prompt.',
    queueTurn: 'Queue next turn',
    queuedTurnsLabel: 'Queued turns',
    queuedTurnsHint: 'These prompts will start automatically after the current turn finishes.',
    removeQueuedTurn: 'Remove queued turn',
    moreActions: 'More actions',
    copyCode: 'Copy',
    copiedCode: 'Copied',
    removeAttachmentComment: 'Remove this attachment from the draft.',
    newSession: 'New session',
    editWorkspaces: 'Edit',
    finish: 'Finish',
    reorderWorkspace: 'Drag to reorder workspace',
    createWorkspaceTitle: 'New',
    createWorkspaceAction: 'New',
    visibleWorkspaces: 'Visible',
    hideWorkspace: 'Hide',
    showWorkspace: 'Show',
    workspaceFromName: 'Name',
    workspaceFromGit: 'Git',
    gitRepository: 'Git repository',
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
    normalStatus: 'Normal',
    processingStatus: 'Processing',
    normalHint: 'Ready for the next message.',
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
    answerLabel: 'Answer',
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
    systemNotifications: 'System notifications',
    systemNotificationsHint: 'Used for coding approval requests and completed chat/coding turns.',
    notificationsEnabled: 'Enabled',
    notificationsDisabled: 'Not enabled',
    notificationsBlocked: 'Blocked by browser',
    notificationsUnsupported: 'Not supported',
    enableNotifications: 'Enable notifications',
    notificationsBlockedHint: 'Allow notifications for this site in the browser, then return here.',
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
    browseWorkspace: 'Browse workspace',
    workspaceRequired: 'Choose a workspace.',
    titleRequired: 'Title is required when creating a new workspace.',
    workspaceSelect: 'Choose workspace',
    newWorkspaceOption: 'New from title',
    title: 'Title',
    optionalSessionTitle: 'Optional session title',
    securityProfile: 'Security profile',
    executorLabel: 'Executor',
    approvalModeLabel: 'MODE',
    model: 'Model',
    thinking: 'Thinking',
    rolePreset: 'Preset role',
    rolePresetManager: 'Preset roles',
    rolePresetManagerHint: 'Manage reusable prompt presets for Chat.',
    rolePresetName: 'Role name',
    rolePresetDescription: 'Description',
    rolePresetPrompt: 'Prompt',
    rolePresetDefault: 'Default preset',
    newRolePreset: 'New preset',
    editRolePreset: 'Edit preset',
    saveRolePreset: 'Save preset',
    deleteRolePreset: 'Delete preset',
    noRolePresets: 'No preset roles yet.',
    rolePresetSaved: 'Preset saved',
    rolePresetDeleted: 'Preset deleted',
    deleteRolePresetConfirm: 'Delete preset "{label}"?',
    readOnlyProfile: 'read-only',
    repoWriteProfile: 'workspace-write',
    fullHostProfile: 'Full',
    detailedMode: 'Detailed',
    lessInterruptiveMode: 'Less interruption',
    allPermissionsMode: 'Full auto',
    codexExecutor: 'Codex',
    claudeCodeExecutor: 'Claude Code',
    noRolePreset: 'None',
    chatSessionHint: 'Chat sessions can edit files inside the shared chat workspace.',
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
    sessionDeletedConfirm: 'Are you sure you want to delete this chat history?',
    archiveSessionConfirm: 'Archive "{title}"? You can restore it later.',
    confirmArchiveTitle: 'Archive session',
    confirmDeleteTitle: 'Delete session',
    confirmAction: 'Confirm',
    deleteInlineConfirm: 'Click again to delete',
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
    regeneratingToken: 'Regenerating token...',
    regenerateTokenConfirm: 'Regenerate token for "{username}"? Existing token links will stop working.',
    deleteUser: 'Delete user',
    deleteUserConfirm: 'Delete user "{username}"?',
    noUsersYet: 'No users yet',
    sessionOwner: 'Owner',
    securityLabel: 'Security',
    modelLabel: 'Model',
    thinkingLabel: 'Thinking',
    rolePresetLabel: 'Preset role',
    threadLabel: 'Thread',
    info: 'Info',
    filesTitle: 'Files',
    loadingFiles: 'Loading files…',
    loadingFile: 'Loading file…',
    loadingSession: 'Loading session…',
    selectFileHint: 'Choose a file from the sidebar to preview it.',
    emptyWorkspaceFiles: 'No files found in this workspace.',
    emptyDirectory: 'This folder is empty.',
    binaryFile: 'This file cannot be previewed inline.',
    downloadFile: 'Download',
    filePreviewTruncated: 'Preview shows the first 256 KB.',
    previewTab: 'Preview',
    diffTab: 'Diff',
    hideInspector: 'Hide',
    noDiffSelected: 'No diff selected yet.',
    sessionInfoTitle: 'Session info',
    archived: 'Archived',
    active: 'active',
    commandToolingHidden: 'Chat can edit files in the shared workspace, but command tooling stays hidden.',
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
    networkAlertRecovering: '正在尝试重新连接本地 Host 服务。',
    networkAlertDown: '浏览器当前无法连接到本地 Host 服务。',
    hideSidebar: '隐藏侧栏',
    showSidebar: '显示侧栏',
    languageSetting: '语言',
    languageSettingHint: '选择界面语言。',
    themeSetting: '皮肤',
    themeSettingHint: '选择界面皮肤。',
    themeWhite: 'white',
    themeWarm: 'warm',
    themeNight: 'night',
    filesNav: 'files',
    refresh: '刷新',
    languageEnglish: 'English',
    languageChinese: '中文',
    languageButtonComment: '切换界面语言。',
    adminComment: '管理用户和访问权限。',
    settingsComment: '打开系统设置。',
    archiveComment: '归档当前会话，之后仍然可以恢复。',
    restoreComment: '恢复这个已归档会话。',
    forkComment: '复制一个使用相同配置的新会话。',
    editComment: '修改标题、workspace 或会话设置。',
    infoComment: '查看 workspace、所有者、模型等会话详情。',
    deleteComment: '永久删除这个会话。',
    modelComment: '选择这个会话后续 turn 使用的模型。',
    thinkingComment: '设置这个会话后续 turn 的思考深度。',
    auditModelComment: '选择这个 coding 会话的自动化模式。',
    attachComment: '给下一条 prompt 附加文件。',
    stopComment: '停止当前正在运行的 turn。',
    sendComment: '发送当前 prompt。',
    queueTurn: '加入下一轮',
    queuedTurnsLabel: '排队中的 turn',
    queuedTurnsHint: '当前 turn 结束后，这些 prompt 会自动开始下一轮。',
    removeQueuedTurn: '移除排队 turn',
    moreActions: '更多操作',
    copyCode: '复制',
    copiedCode: '已复制',
    removeAttachmentComment: '把这个附件从草稿里移除。',
    newSession: '新建会话',
    editWorkspaces: '编辑',
    finish: '完成',
    reorderWorkspace: '拖动以调整 workspace 顺序',
    createWorkspaceTitle: '新建',
    createWorkspaceAction: '新建',
    visibleWorkspaces: '展示中',
    hideWorkspace: '隐藏',
    showWorkspace: '显示',
    workspaceFromName: '名称',
    workspaceFromGit: 'Git',
    gitRepository: 'Git 仓库',
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
    normalStatus: '普通',
    processingStatus: '处理中',
    normalHint: '当前是普通状态，可以继续发送下一条消息。',
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
    answerLabel: 'Answer',
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
    systemNotifications: '系统通知',
    systemNotificationsHint: '用于代码审批待处理，以及 Chat / Coding 完成时的系统通知。',
    notificationsEnabled: '已开启',
    notificationsDisabled: '未开启',
    notificationsBlocked: '已被浏览器拦截',
    notificationsUnsupported: '当前浏览器不支持',
    enableNotifications: '开启通知',
    notificationsBlockedHint: '请先在浏览器里允许这个站点发送通知，再回到这里。',
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
    browseWorkspace: '切换 workspace',
    workspaceRequired: '请选择 workspace。',
    titleRequired: '使用标题名新建 workspace 时，标题是必填项。',
    workspaceSelect: '选择 workspace',
    newWorkspaceOption: '用标题名新建',
    title: '标题',
    optionalSessionTitle: '可选的会话标题',
    securityProfile: '安全档位',
    executorLabel: '执行器',
    approvalModeLabel: 'MODE',
    model: '模型',
    thinking: '思考强度',
    rolePreset: '预设角色',
    rolePresetManager: '预设角色',
    rolePresetManagerHint: '管理 Chat 可复用的 Prompt 预设。',
    rolePresetName: '角色名称',
    rolePresetDescription: '描述',
    rolePresetPrompt: 'Prompt',
    rolePresetDefault: '设为默认预设',
    newRolePreset: '新建预设',
    editRolePreset: '编辑预设',
    saveRolePreset: '保存预设',
    deleteRolePreset: '删除预设',
    noRolePresets: '还没有预设角色。',
    rolePresetSaved: '预设已保存',
    rolePresetDeleted: '预设已删除',
    deleteRolePresetConfirm: '确定删除预设 “{label}” 吗？',
    readOnlyProfile: '只读',
    repoWriteProfile: 'Workspace 可写',
    fullHostProfile: 'Full',
    detailedMode: '详细',
    lessInterruptiveMode: '少打扰',
    allPermissionsMode: '全自动',
    codexExecutor: 'Codex',
    claudeCodeExecutor: 'Claude Code',
    noRolePreset: '无',
    chatSessionHint: '聊天会话可以修改共享 Chat workspace 里的文件。',
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
    sessionDeletedConfirm: '你确定要删除这个 chat history 吗？',
    archiveSessionConfirm: '确定归档 “{title}” 吗？之后仍然可以恢复。',
    confirmArchiveTitle: '归档会话',
    confirmDeleteTitle: '删除会话',
    confirmAction: '确认',
    deleteInlineConfirm: '再次点击即可删除',
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
    regeneratingToken: '重置 token 中...',
    regenerateTokenConfirm: '确定为 “{username}” 重置 token 吗？旧 token 链接将立即失效。',
    deleteUser: '删除用户',
    deleteUserConfirm: '确定删除用户 “{username}” 吗？',
    noUsersYet: '暂时还没有用户',
    sessionOwner: 'Owner',
    securityLabel: '安全',
    modelLabel: '模型',
    thinkingLabel: '思考强度',
    rolePresetLabel: '预设角色',
    threadLabel: '线程',
    info: '信息',
    filesTitle: '文件',
    loadingFiles: '正在加载文件…',
    loadingFile: '正在加载文件…',
    loadingSession: '正在加载会话…',
    selectFileHint: '从侧边栏选择一个文件查看内容。',
    emptyWorkspaceFiles: '这个 workspace 里还没有可显示的文件。',
    emptyDirectory: '这个文件夹是空的。',
    binaryFile: '这个文件暂不支持直接预览。',
    downloadFile: '下载',
    filePreviewTruncated: '预览仅显示前 256 KB。',
    previewTab: '预览',
    diffTab: '改动',
    hideInspector: '隐藏',
    noDiffSelected: '还没有选中的改动。',
    sessionInfoTitle: '会话信息',
    archived: '归档',
    active: '活跃',
    commandToolingHidden: '聊天会话可以改共享 workspace 里的文件，但命令工具视图仍然隐藏。',
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

function readChatCompletionMarkers(): ChatCompletionMarkerMap {
  if (typeof window === 'undefined') {
    return {};
  }

  try {
    const raw = window.localStorage.getItem(CHAT_COMPLETION_MARKERS_STORAGE_KEY);
    if (!raw) {
      return {};
    }

    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const markers: ChatCompletionMarkerMap = {};
    for (const [conversationId, value] of Object.entries(parsed)) {
      if (typeof value === 'string' && value.trim()) {
        markers[conversationId] = value;
      }
    }
    return markers;
  } catch {
    return {};
  }
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

function isChatSessionProcessing(
  session: Pick<ChatStatusRecord, 'activeTurnId' | 'status'> & { uiStatus?: ChatUiStatus },
) {
  return session.uiStatus === 'processing' || Boolean(session.activeTurnId) || session.status === 'running';
}

function chatUiStatusFromConversation(
  session: Pick<ConversationSummary, 'activeTurnId' | 'status' | 'hasTranscript'> & { uiStatus?: ChatUiStatus },
): ChatUiStatus {
  if (session.uiStatus) {
    return session.uiStatus;
  }
  if (isChatSessionProcessing(session)) {
    return 'processing';
  }
  if (session.status === 'error') {
    return 'error';
  }
  return session.hasTranscript ? 'completed' : 'new';
}

function isUnreadChatCompletion(
  session: Pick<ChatStatusRecord, 'id' | 'updatedAt' | 'hasTranscript'>,
  markers: ChatCompletionMarkerMap,
) {
  return session.hasTranscript && markers[session.id] === session.updatedAt;
}

function deriveCodingSessionState(
  session: Pick<SessionRecord, 'activeTurnId' | 'status' | 'hasTranscript'> & { pendingApprovalCount?: number },
  options?: {
    activeApproval?: PendingApproval | null;
    busy?: string | null;
    hasActiveTurn?: boolean;
  },
): NotificationSessionState {
  if ((session.pendingApprovalCount ?? 0) > 0 || options?.activeApproval || session.status === 'needs-approval') {
    return 'pending';
  }
  if (options?.busy === 'start-turn' || options?.hasActiveTurn || Boolean(session.activeTurnId) || session.status === 'running') {
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

function deriveSummarySessionState(
  session: SessionSummary | ConversationSummary,
  markers: ChatCompletionMarkerMap,
): UiSessionState {
  if (session.sessionType === 'chat') {
    const chatUiStatus = chatUiStatusFromConversation(session);
    if (chatUiStatus === 'processing') {
      return 'processing';
    }
    if (chatUiStatus === 'error') {
      return 'error';
    }
    if (chatUiStatus === 'new') {
      return 'new';
    }
    return isUnreadChatCompletion(session, markers) ? 'completed' : 'normal';
  }

  return deriveCodingSessionState(session);
}

function deriveNotificationSessionState(session: SessionSummary | ConversationSummary): NotificationSessionState {
  if (session.sessionType === 'chat') {
    const chatUiStatus = chatUiStatusFromConversation(session);
    if (chatUiStatus === 'processing') {
      return 'processing';
    }
    if (chatUiStatus === 'error') {
      return 'error';
    }
    if (chatUiStatus === 'new') {
      return 'new';
    }
    return 'completed';
  }

  return deriveCodingSessionState(session);
}

function currentNotificationPermission(): SystemNotificationPermission {
  if (typeof window === 'undefined' || typeof window.Notification === 'undefined') {
    return 'unsupported';
  }
  return window.Notification.permission;
}

function shouldNotifySessionCompletion(
  previous: NotificationSessionSnapshot | undefined,
  next: NotificationSessionSnapshot,
) {
  if (!previous || next.state !== 'completed') {
    return false;
  }
  if (previous.updatedAt === next.updatedAt) {
    return false;
  }
  return previous.state !== 'completed';
}

function chatRailStateRank(state: UiSessionState) {
  switch (state) {
    case 'processing':
      return 0;
    case 'error':
      return 1;
    case 'new':
      return 2;
    case 'completed':
      return 3;
    default:
      return 4;
  }
}

function sortChatConversationsForRail(
  conversations: ConversationSummary[],
  markers: ChatCompletionMarkerMap,
) {
  return [...conversations].sort((left, right) => {
    const leftState = deriveSummarySessionState(left, markers);
    const rightState = deriveSummarySessionState(right, markers);
    const stateDelta = chatRailStateRank(leftState) - chatRailStateRank(rightState);
    if (stateDelta !== 0) {
      return stateDelta;
    }
    if (leftState === 'normal' && rightState === 'normal' && left.hasTranscript !== right.hasTranscript) {
      return left.hasTranscript ? -1 : 1;
    }
    const updatedDelta = right.updatedAt.localeCompare(left.updatedAt);
    if (updatedDelta !== 0) {
      return updatedDelta;
    }
    return left.title.localeCompare(right.title);
  });
}

function deriveDetailSessionState(
  session: SessionDetailResponse['session'] | null,
  options: {
    activeApproval: PendingApproval | null;
    busy: string | null;
    hasActiveTurn: boolean;
  },
): UiSessionState | null {
  if (!session) {
    return null;
  }
  if (session.sessionType === 'chat') {
    if (options.busy === 'start-turn') {
      return 'processing';
    }
    const chatUiStatus = chatUiStatusFromConversation(session);
    if (chatUiStatus === 'processing') {
      return 'processing';
    }
    if (chatUiStatus === 'error') {
      return 'error';
    }
    if (chatUiStatus === 'new') {
      return 'new';
    }
    return 'completed';
  }
  return deriveCodingSessionState(session, {
    activeApproval: options.activeApproval,
    busy: options.busy,
    hasActiveTurn: options.hasActiveTurn,
  });
}

function uiSessionStateLabel(language: Language, state: UiSessionState) {
  return UI_SESSION_STATE_LABELS[language][state];
}

function sessionMarkerStyle(state: UiSessionState): CSSProperties {
  switch (state) {
    case 'pending':
      return { backgroundColor: '#f59e0b', borderColor: 'rgba(217, 119, 6, 0.22)' };
    case 'processing':
      return { backgroundColor: '#3b82f6', borderColor: 'rgba(37, 99, 235, 0.22)' };
    case 'completed':
      return { backgroundColor: '#16a34a', borderColor: 'rgba(22, 163, 74, 0.22)' };
    case 'error':
      return { backgroundColor: '#dc2626', borderColor: 'rgba(220, 38, 38, 0.22)' };
    case 'stale':
      return { backgroundColor: '#9ca3af', borderColor: 'rgba(107, 114, 128, 0.22)' };
    case 'new':
    case 'normal':
      return { backgroundColor: 'rgba(255, 255, 255, 0.96)', borderColor: 'rgba(43, 36, 30, 0.08)' };
  }
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

function nextCodingSessionTitle(
  sessions: Array<Pick<SessionSummary, 'workspaceId'>>,
  workspaceId: string,
) {
  const sessionCount = sessions.reduce((count, session) => (
    session.workspaceId === workspaceId ? count + 1 : count
  ), 0);
  return `Session ${sessionCount + 1}`;
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

function chatConversationToConversationSummary(
  conversation: ChatConversation | ChatConversationSummary,
  lastUpdate?: string,
): ConversationSummary {
  return {
    id: conversation.id,
    ownerUserId: conversation.ownerUserId,
    ownerUsername: conversation.ownerUsername,
    sessionType: 'chat',
    executor: conversation.executor,
    threadId: conversation.threadId,
    activeTurnId: conversation.activeTurnId,
    title: conversation.title,
    autoTitle: conversation.autoTitle,
    workspace: conversation.workspace,
    archivedAt: conversation.archivedAt,
    securityProfile: 'repo-write',
    approvalMode: 'detailed',
    networkEnabled: conversation.networkEnabled,
    fullHostEnabled: false,
    status: conversation.status,
    uiStatus: conversation.uiStatus,
    recoveryState: conversation.recoveryState,
    retryable: conversation.retryable,
    lastIssue: conversation.lastIssue,
    hasTranscript: conversation.hasTranscript,
    model: conversation.model,
    reasoningEffort: conversation.reasoningEffort,
    rolePresetId: conversation.rolePresetId,
    createdAt: conversation.createdAt,
    updatedAt: conversation.updatedAt,
    lastUpdate: lastUpdate ?? ('lastUpdate' in conversation ? conversation.lastUpdate : conversation.updatedAt),
  };
}

function chatDetailToSessionDetail(detail: ChatConversationDetailResponse): SessionDetailResponse {
  return {
    session: chatConversationToConversationSummary(detail.conversation),
    approvals: [],
    liveEvents: [],
    thread: detail.thread,
    transcriptTotal: detail.transcriptTotal,
    commands: [],
    changes: [],
    draftAttachments: detail.draftAttachments,
    queuedTurns: [],
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
    queuedTurns: [],
  };
}

function securityProfileLabel(language: Language, sessionType: SessionType, securityProfile: SecurityProfile) {
  const copy = COPY[language];
  if (sessionType === 'chat') {
    return copy.repoWriteProfile;
  }
  return securityProfile === 'full-host' ? copy.fullHostProfile : copy.repoWriteProfile;
}

function modeOptionLabel(language: Language, mode: ModeOption) {
  const copy = COPY[language];
  if (mode === 'full-auto') return copy.allPermissionsMode;
  if (mode === 'less-interruption') return copy.lessInterruptiveMode;
  return copy.detailedMode;
}

function executorOptionLabel(language: Language, executor: AgentExecutor) {
  const copy = COPY[language];
  return executor === 'claude-code' ? copy.claudeCodeExecutor : copy.codexExecutor;
}

function codingModelsForExecutor(
  bootstrap: BootstrapPayload | null | undefined,
  executor: AgentExecutor,
): ModelOption[] {
  if (!bootstrap) {
    return [];
  }
  const executorModels = bootstrap.availableModelsByExecutor[executor];
  return executorModels?.length ? executorModels : bootstrap.availableModels;
}

function preferredReasoningEffort(option: Pick<ModelOption, 'defaultReasoningEffort' | 'supportedReasoningEfforts'> | null | undefined) {
  if (!option) return 'xhigh' as const;
  const preferredEfforts: ReasoningEffort[] = ['xhigh', 'high', 'medium', 'low', 'minimal', 'none'];
  for (const effort of preferredEfforts) {
    if (option.supportedReasoningEfforts.includes(effort)) {
      return effort;
    }
  }
  if (option.supportedReasoningEfforts.includes(option.defaultReasoningEffort)) {
    return option.defaultReasoningEffort;
  }
  return option.supportedReasoningEfforts[0] ?? 'xhigh';
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

function sessionActivityKind(event: SessionEvent): 'thinking' | 'searching' | 'drafting' | null {
  if (event.method === 'item/agentMessage/delta') {
    return 'drafting';
  }

  if (event.method !== 'item/started' && event.method !== 'item/completed') {
    return null;
  }

  if (/\breasoning\b/i.test(event.summary)) {
    return 'thinking';
  }

  if (/\bwebSearch\b/i.test(event.summary)) {
    return 'searching';
  }

  if (/\bagentMessage\b/i.test(event.summary)) {
    return 'drafting';
  }

  return null;
}

function isSessionActivityTerminalEvent(event: SessionEvent) {
  if (event.method === 'turn/completed' || event.method === 'turn/interrupted' || event.method === 'session/restarted') {
    return true;
  }

  return event.method === 'thread/status/changed' && /\bidle\b/i.test(event.summary);
}

function deriveSessionActivityItems(events: SessionEvent[], language: Language) {
  const lastTerminalIndex = [...events].reverse().findIndex(isSessionActivityTerminalEvent);
  const relevantEvents = lastTerminalIndex === -1
    ? events
    : events.slice(events.length - lastTerminalIndex);
  const items: Array<{ id: string; label: string }> = [];

  for (const event of relevantEvents) {
    const kind = sessionActivityKind(event);
    if (!kind) {
      continue;
    }

    const label = SESSION_ACTIVITY_LABELS[language][kind];
    const previous = items.at(-1);
    if (previous?.label === label) {
      items[items.length - 1] = {
        id: event.id,
        label,
      };
      continue;
    }

    items.push({
      id: event.id,
      label,
    });
  }

  return items.slice(-4);
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

function formatQueuedTurnMeta(
  queuedTurn: { attachmentCount: number; createdAt: string },
  language: Language,
) {
  const parts = [formatTimestamp(queuedTurn.createdAt, language)];
  if (queuedTurn.attachmentCount > 0) {
    parts.push(
      language === 'zh'
        ? `${queuedTurn.attachmentCount} 个附件`
        : `${queuedTurn.attachmentCount} attachment${queuedTurn.attachmentCount === 1 ? '' : 's'}`,
    );
  }
  return parts.join(' · ');
}

function codingFileTreeKey(workspaceId: string, path: string) {
  return `${workspaceId}:${path}`;
}

function inferredFileLanguage(path: string) {
  const extension = path.split('.').pop()?.toLowerCase() ?? '';
  return extension || 'text';
}

function filePreviewCodeClassName(path: string) {
  return `language-${inferredFileLanguage(path)}`;
}

function relativeFileLabel(path: string) {
  return path || '/';
}

function filePreviewExtension(path: string) {
  const filename = path.split('/').pop() ?? path;
  const lastDot = filename.lastIndexOf('.');
  return lastDot >= 0 ? filename.slice(lastDot).toLowerCase() : '';
}

function isImageFilePreview(file: Pick<InlinePreviewResource, 'mimeType'>) {
  return file.mimeType.startsWith('image/');
}

function isMarkdownFilePreview(file: Pick<InlinePreviewResource, 'mimeType' | 'path' | 'previewable'>) {
  const extension = filePreviewExtension(file.path);
  return file.previewable && (file.mimeType.includes('markdown') || extension === '.md' || extension === '.mdx');
}

function isCsvFilePreview(file: Pick<InlinePreviewResource, 'mimeType' | 'path' | 'previewable'>) {
  return file.previewable && (file.mimeType.includes('csv') || filePreviewExtension(file.path) === '.csv');
}

function isPdfFilePreview(file: Pick<InlinePreviewResource, 'mimeType'>) {
  return file.mimeType === 'application/pdf';
}

function stripUtf8Bom(value: string) {
  return value.charCodeAt(0) === 0xfeff ? value.slice(1) : value;
}

function parseCsvPreview(content: string) {
  const source = stripUtf8Bom(content);
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let inQuotes = false;

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index] ?? '';

    if (inQuotes) {
      if (character === '"') {
        if (source[index + 1] === '"') {
          cell += '"';
          index += 1;
        } else {
          inQuotes = false;
        }
      } else {
        cell += character;
      }
      continue;
    }

    if (character === '"') {
      inQuotes = true;
      continue;
    }

    if (character === ',') {
      row.push(cell);
      cell = '';
      continue;
    }

    if (character === '\r' || character === '\n') {
      if (character === '\r' && source[index + 1] === '\n') {
        index += 1;
      }
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
      continue;
    }

    cell += character;
  }

  row.push(cell);
  if (row.length > 1 || row[0] !== '' || rows.length > 0) {
    rows.push(row);
  }

  while (rows.length > 0 && rows[rows.length - 1]?.every((value) => value === '')) {
    rows.pop();
  }

  return rows;
}

function apiHref(path: string) {
  if (/^https?:\/\//i.test(path)) {
    return path;
  }
  const baseUrl = (import.meta.env.VITE_API_BASE_URL ?? '').replace(/\/$/, '');
  return `${baseUrl}${path}`;
}

function attachmentInlineHref(attachment: SessionAttachmentSummary) {
  return apiHref(attachment.url);
}

function attachmentDownloadHref(attachment: SessionAttachmentSummary) {
  const url = attachment.url.includes('?')
    ? `${attachment.url}&download=1`
    : `${attachment.url}?download=1`;
  return apiHref(url);
}

function isModifiedPrimaryClick(event: ReactMouseEvent<HTMLAnchorElement>) {
  return event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey;
}

function shouldResolveChatMarkdownLink(href: string) {
  const trimmed = href.trim();
  if (!trimmed || trimmed.startsWith('#') || /^(mailto|tel|javascript):/i.test(trimmed)) {
    return false;
  }
  if (/^file:/i.test(trimmed) || /^https?:\/\//i.test(trimmed)) {
    return true;
  }
  if (/^\/api\/chat\/conversations\/[^/]+\/attachments\/[^/]+\/content(?:[?#].*)?$/i.test(trimmed)) {
    return true;
  }
  if (/^\/.+\.[a-z0-9]{1,8}(?:[?#].*)?$/i.test(trimmed)) {
    return true;
  }
  if (/^\/(Users|Volumes|private|tmp|var)\//.test(trimmed)) {
    return true;
  }
  return trimmed.startsWith('./')
    || trimmed.startsWith('../')
    || (!trimmed.startsWith('/') && /(?:\/|\\|\.[a-z0-9]{1,8})(?:[?#].*)?$/i.test(trimmed));
}

function isTextLikeMimeType(mimeType: string) {
  return mimeType.startsWith('text/')
    || mimeType.includes('json')
    || mimeType.includes('xml')
    || mimeType.includes('yaml')
    || mimeType.includes('javascript')
    || mimeType.includes('typescript')
    || mimeType.includes('markdown')
    || mimeType.includes('toml')
    || mimeType.includes('csv');
}

function isLikelyTextAttachment(attachment: SessionAttachmentSummary) {
  if (attachment.kind === 'image' || attachment.kind === 'pdf') {
    return false;
  }
  const extension = filePreviewExtension(attachment.filename);
  return isTextLikeMimeType(attachment.mimeType)
    || [
      '.c',
      '.cc',
      '.cpp',
      '.css',
      '.csv',
      '.go',
      '.graphql',
      '.h',
      '.html',
      '.java',
      '.js',
      '.json',
      '.jsx',
      '.md',
      '.mdx',
      '.mjs',
      '.py',
      '.rb',
      '.rs',
      '.sh',
      '.sql',
      '.svg',
      '.toml',
      '.ts',
      '.tsx',
      '.txt',
      '.vue',
      '.xml',
      '.yaml',
      '.yml',
    ].includes(extension);
}

function workspacePreviewResource(preview: CodingWorkspaceFileResponse, workspaceId: string): InlinePreviewResource {
  const downloadUrl = preview.downloadUrl
    ? apiHref(preview.downloadUrl)
    : codingWorkspaceFileContentHref(workspaceId, preview.path, true);
  return {
    path: preview.path,
    name: preview.name,
    mimeType: preview.mimeType,
    sizeBytes: preview.sizeBytes,
    previewable: preview.previewable,
    truncated: preview.truncated,
    content: preview.content,
    inlineUrl: codingWorkspaceFileContentHref(workspaceId, preview.path, false),
    downloadUrl,
  };
}

function attachmentPreviewResource(
  attachment: SessionAttachmentSummary,
  options?: { content?: string | null; previewable?: boolean },
): InlinePreviewResource {
  return {
    path: attachment.filename,
    name: attachment.filename,
    mimeType: attachment.mimeType,
    sizeBytes: attachment.sizeBytes,
    previewable: options?.previewable ?? false,
    truncated: false,
    content: options?.content ?? null,
    inlineUrl: attachmentInlineHref(attachment),
    downloadUrl: attachmentDownloadHref(attachment),
  };
}

function composerDraftKey(mode: AppMode, sessionId: string | null) {
  return sessionId ? `${mode}:${sessionId}` : null;
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

function orderedUserRoles(roles: Iterable<UserRole>) {
  const priority: UserRole[] = ['user', 'developer', 'admin'];
  const roleSet = new Set(roles);
  return priority.filter((role) => roleSet.has(role));
}

function toggleUserRole(roles: UserRole[], role: UserRole, enabled: boolean) {
  const next = new Set(roles);
  if (enabled) {
    next.add(role);
  } else {
    next.delete(role);
  }
  return orderedUserRoles(next);
}

function deriveRolesFromLegacy(user: BootstrapPayload['currentUser'] | null | undefined): UserRole[] {
  const rawRoles = Array.isArray((user as { roles?: unknown } | null | undefined)?.roles)
    ? (user as { roles: unknown[] }).roles
    : null;
  if (rawRoles) {
    const roles = rawRoles.filter((role): role is UserRole => role === 'user' || role === 'developer' || role === 'admin');
    if (roles.length > 0) {
      return orderedUserRoles(roles);
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
  return roles.length > 0 ? orderedUserRoles(roles) : ['user'];
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

function normalizedChatConversations(bootstrap: ChatBootstrapPayload | null): ConversationSummary[] {
  return (bootstrap?.conversations ?? []).map((conversation) => chatConversationToConversationSummary(conversation));
}

function isChatTranscriptPageResponse(value: unknown): value is ChatTranscriptPageResponse {
  return Boolean(value && typeof value === 'object' && 'conversation' in value);
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

function normalizeWorkspaceLayoutOrder(workspaces: WorkspaceSummary[]) {
  const fixedWorkspaces = sortWorkspaceSummaries(workspaces.filter((workspace) => isFixedChatWorkspace(workspace)));
  const editableWorkspaces = selectableDeveloperWorkspaces(workspaces);
  return [
    ...sortWorkspaceSummaries(editableWorkspaces.filter((workspace) => workspace.visible)),
    ...sortWorkspaceSummaries(editableWorkspaces.filter((workspace) => !workspace.visible)),
    ...fixedWorkspaces,
  ].map((workspace, index) => ({
    ...workspace,
    sortOrder: index,
  }));
}

function mergeWorkspaceIds(currentIds: string[], ...workspaceIds: Array<string | null | undefined>) {
  const next = [...currentIds];
  for (const workspaceId of workspaceIds) {
    if (!workspaceId || next.includes(workspaceId)) continue;
    next.push(workspaceId);
  }
  return next;
}

function sameOrderedStrings(left: string[], right: string[]) {
  if (left.length !== right.length) {
    return false;
  }

  return left.every((value, index) => value === right[index]);
}

function defaultUserForm(): UserFormState {
  return {
    username: '',
    password: '',
    roles: ['user'],
    canUseFullHost: false,
  };
}

function defaultChatRolePresetForm(): ChatRolePresetFormState {
  return {
    label: '',
    description: '',
    prompt: '',
    isDefault: false,
  };
}

function readStoredBoolean(key: string, fallback = false) {
  if (typeof window === 'undefined') return fallback;
  const stored = window.localStorage.getItem(key);
  if (stored === 'true') return true;
  if (stored === 'false') return false;
  return fallback;
}

function readStoredTheme(): ThemeMode {
  if (typeof window === 'undefined') return 'white';
  const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
  if (stored === 'white' || stored === 'warm' || stored === 'night') {
    return stored;
  }
  if (stored === 'contrast') {
    return 'white';
  }
  return 'white';
}

function extractTextContent(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') {
    return String(node);
  }

  if (Array.isArray(node)) {
    return node.map((entry) => extractTextContent(entry)).join('');
  }

  if (isValidElement(node)) {
    return extractTextContent((node.props as { children?: ReactNode }).children);
  }

  return '';
}

function clipboardFileName(file: File, index: number) {
  if (file.name) {
    return file.name;
  }

  const suffix = file.type.split('/')[1]?.split('+')[0]?.toLowerCase() || 'bin';
  return `clipboard-${Date.now()}-${index + 1}.${suffix}`;
}

function normalizeClipboardFile(file: File, index: number) {
  if (file.name) {
    return file;
  }

  return new File([file], clipboardFileName(file, index), {
    type: file.type,
    lastModified: Date.now(),
  });
}

interface MarkdownCodeBlockProps {
  language: Language;
  children?: ReactNode;
}

function MarkdownCodeBlock({ language, children }: MarkdownCodeBlockProps) {
  const [copied, setCopied] = useState(false);
  const childNodes = Children.toArray(children);
  const firstChild = childNodes[0] ?? null;
  const className = isValidElement(firstChild) && typeof firstChild.props === 'object'
    ? (typeof (firstChild.props as { className?: unknown }).className === 'string'
        ? (firstChild.props as { className?: string }).className
        : undefined)
    : undefined;
  const languageLabel = className?.match(/language-([\w-]+)/)?.[1] ?? null;
  const code = extractTextContent(children).replace(/\n$/, '');

  useEffect(() => {
    if (!copied) return;
    const timeout = window.setTimeout(() => {
      setCopied(false);
    }, 1500);
    return () => {
      window.clearTimeout(timeout);
    };
  }, [copied]);

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  return (
    <div className="markdown-code-block">
      <div className="markdown-code-toolbar">
        <span className="markdown-code-language">{languageLabel ?? ''}</span>
        <button
          type="button"
          className={`button-secondary markdown-code-copy ${copied ? 'markdown-code-copy-active' : ''}`}
          onClick={() => {
            void handleCopy();
          }}
        >
          {copied ? COPY[language].copiedCode : COPY[language].copyCode}
        </button>
      </div>
      <pre>{children}</pre>
    </div>
  );
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

function DragHandleIcon() {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <circle cx="7" cy="6" r="1.2" fill="currentColor" />
      <circle cx="13" cy="6" r="1.2" fill="currentColor" />
      <circle cx="7" cy="10" r="1.2" fill="currentColor" />
      <circle cx="13" cy="10" r="1.2" fill="currentColor" />
      <circle cx="7" cy="14" r="1.2" fill="currentColor" />
      <circle cx="13" cy="14" r="1.2" fill="currentColor" />
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

function OverflowIcon() {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <circle cx="4.5" cy="10" r="1.4" fill="currentColor" />
      <circle cx="10" cy="10" r="1.4" fill="currentColor" />
      <circle cx="15.5" cy="10" r="1.4" fill="currentColor" />
    </svg>
  );
}

function TrashIcon() {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <path
        d="M6.3 6.8v7.1m3.7-7.1v7.1m3.7-7.1v7.1M4.7 5.3h10.6m-7.6-1.8h4.6m-6.8 1.8.6 9a1.6 1.6 0 0 0 1.6 1.5h4.6a1.6 1.6 0 0 0 1.6-1.5l.6-9"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function StopSquareIcon() {
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

function RefreshIcon() {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <path
        d="M15.6 9.8a5.6 5.6 0 1 1-1.6-3.9M12.8 4.1h2.9V7"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function CodingIcon() {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <path
        d="m7.6 6.3-3.4 3.7 3.4 3.7M12.4 6.3l3.4 3.7-3.4 3.7M11.1 4.8l-2.2 10.4"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function FilesIcon() {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <path
        d="M3.8 6.4a1.9 1.9 0 0 1 1.9-1.9h2.4l1.1 1.4h5.1a1.9 1.9 0 0 1 1.9 1.9v5.8a1.9 1.9 0 0 1-1.9 1.9H5.7a1.9 1.9 0 0 1-1.9-1.9Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path d="M7 10h6M7 12.8h3.4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

function FolderIcon({ open = false }: { open?: boolean }) {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true">
      {open ? (
        <path
          d="M3.8 7.1a1.7 1.7 0 0 1 1.7-1.7h2.3l1.1 1.3h5.6a1.7 1.7 0 0 1 1.6 2.1l-1 4.4a1.7 1.7 0 0 1-1.6 1.3H5.3a1.7 1.7 0 0 1-1.7-1.7z"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      ) : (
        <path
          d="M3.8 6.4a1.9 1.9 0 0 1 1.9-1.9h2.4l1.1 1.4h5.1a1.9 1.9 0 0 1 1.9 1.9v5.8a1.9 1.9 0 0 1-1.9 1.9H5.7a1.9 1.9 0 0 1-1.9-1.9Z"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      )}
    </svg>
  );
}

function FileIcon() {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <path
        d="M6 3.9h5.4l2.7 2.7v8a1.6 1.6 0 0 1-1.6 1.6H6a1.6 1.6 0 0 1-1.6-1.6V5.5A1.6 1.6 0 0 1 6 3.9Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path d="M11.4 3.9v2.7h2.7M7.2 10h4.8M7.2 12.7h3.6" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function ChatIcon() {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <path
        d="M5.2 14.7 4.1 17l3-1.2h6a4.1 4.1 0 0 0 4.1-4.1V7.9a4.1 4.1 0 0 0-4.1-4.1H6.9A4.1 4.1 0 0 0 2.8 7.9v3.8a4 4 0 0 0 2.4 3"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path d="M7.1 9.8h5.8" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
    </svg>
  );
}

function RolesIcon() {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <path
        d="M6.4 11.4a2.3 2.3 0 1 0 0-4.6 2.3 2.3 0 0 0 0 4.6ZM12.9 10.6l.7 1.3 1.5.4-1 1.2.2 1.6-1.4-.7-1.4.7.2-1.6-1.1-1.2 1.6-.4.7-1.3ZM3.8 15.3c.8-1.7 2.3-2.6 4.3-2.6"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function SettingsIcon() {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <path
        d="m10 3.8.9 1.5 1.8.4.3 1.8 1.5.9-.5 1.7.5 1.7-1.5.9-.3 1.8-1.8.4-.9 1.5-1.7-.5-1.7.5-.9-1.5-1.8-.4-.3-1.8-1.5-.9.5-1.7-.5-1.7 1.5-.9.3-1.8 1.8-.4.9-1.5 1.7.5 1.7-.5Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.45"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="10" cy="10" r="2.3" fill="none" stroke="currentColor" strokeWidth="1.6" />
    </svg>
  );
}

function AdminIcon() {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <path
        d="M10 3.4 15.5 5v4c0 3.6-2 5.9-5.5 7.6C6.5 14.9 4.5 12.6 4.5 9V5L10 3.4Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path d="m8.2 10.1 1.2 1.2 2.5-2.8" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
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
  const [theme, setTheme] = useState<ThemeMode>(() => readStoredTheme());
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
  const [notificationPermission, setNotificationPermission] = useState<SystemNotificationPermission>(() => currentNotificationPermission());
  const [activeMode, setActiveMode] = useState<AppMode>(() => {
    if (typeof window === 'undefined') return 'developer';
    const stored = window.localStorage.getItem('rvc-mode');
    return stored === 'chat' || stored === 'developer' ? stored : 'developer';
  });
  const [developerSubview, setDeveloperSubview] = useState<DeveloperSubview>('sessions');
  const [bootstrap, setBootstrap] = useState<BootstrapPayload | null>(null);
  const [chatBootstrap, setChatBootstrap] = useState<ChatBootstrapPayload | null>(null);
  const [detail, setDetail] = useState<SessionDetailResponse | null>(null);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string | null>(null);
  const [selectedFileWorkspaceId, setSelectedFileWorkspaceId] = useState<string | null>(null);
  const [expandedWorkspaceIds, setExpandedWorkspaceIds] = useState<string[]>([]);
  const [expandedFileTreePaths, setExpandedFileTreePaths] = useState<Record<string, string[]>>({});
  const [selectedFilePaths, setSelectedFilePaths] = useState<Record<string, string | null>>({});
  const [fileTreeDirectories, setFileTreeDirectories] = useState<Record<string, FileTreeDirectoryState>>({});
  const [filePreviewCache, setFilePreviewCache] = useState<Record<string, CodingWorkspaceFileResponse>>({});
  const [filePreviewLoadingKey, setFilePreviewLoadingKey] = useState<string | null>(null);
  const [filePreviewError, setFilePreviewError] = useState<string | null>(null);
  const [attachmentPreviewTarget, setAttachmentPreviewTarget] = useState<SessionAttachmentSummary | null>(null);
  const [attachmentPreviewResourceState, setAttachmentPreviewResourceState] = useState<InlinePreviewResource | null>(null);
  const [attachmentPreviewLoading, setAttachmentPreviewLoading] = useState(false);
  const [attachmentPreviewError, setAttachmentPreviewError] = useState<string | null>(null);
  const [fileBrowserTab, setFileBrowserTab] = useState<DeveloperInspectorTab>('preview');
  const [developerInspectorOpen, setDeveloperInspectorOpen] = useState(false);
  const [developerInspectorWorkspaceId, setDeveloperInspectorWorkspaceId] = useState<string | null>(null);
  const [developerInspectorFilePath, setDeveloperInspectorFilePath] = useState<string | null>(null);
  const [developerInspectorTab, setDeveloperInspectorTab] = useState<DeveloperInspectorTab>('preview');
  const [developerInspectorDiffChange, setDeveloperInspectorDiffChange] = useState<SessionFileChange | null>(null);
  const [developerInspectorLoadingKey, setDeveloperInspectorLoadingKey] = useState<string | null>(null);
  const [developerInspectorError, setDeveloperInspectorError] = useState<string | null>(null);
  const [developerInspectorSourceToken, setDeveloperInspectorSourceToken] = useState<string | null>(null);
  const [developerInspectorDismissedToken, setDeveloperInspectorDismissedToken] = useState<string | null>(null);
  const [sessionMenuSessionId, setSessionMenuSessionId] = useState<string | null>(null);
  const [pendingSessionRailAction, setPendingSessionRailAction] = useState<{ kind: 'edit' | 'info'; sessionId: string } | null>(null);
  const [detailMenuOpen, setDetailMenuOpen] = useState(false);
  const [developerRailHidden, setDeveloperRailHidden] = useState(() => readStoredBoolean(DEVELOPER_RAIL_HIDDEN_STORAGE_KEY));
  const [chatRailHidden, setChatRailHidden] = useState(() => readStoredBoolean(CHAT_RAIL_HIDDEN_STORAGE_KEY));
  const [railWidth, setRailWidth] = useState(() => {
    if (typeof window === 'undefined') return 320;
    const stored = Number(window.localStorage.getItem('rvc-rail-width') ?? '320');
    return Number.isFinite(stored) ? Math.min(520, Math.max(260, stored)) : 320;
  });
  const [error, setError] = useState<string | null>(null);
  const [promptDrafts, setPromptDrafts] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [rolesOpen, setRolesOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [adminOpen, setAdminOpen] = useState(false);
  const [sessionInfoOpen, setSessionInfoOpen] = useState(false);
  const [adminUsers, setAdminUsers] = useState<AdminUserRecord[] | null>(null);
  const [chatRolePresetList, setChatRolePresetList] = useState<ChatRolePresetListResponse | null>(null);
  const [editingChatRolePresetId, setEditingChatRolePresetId] = useState<string | null>(null);
  const [chatRolePresetForm, setChatRolePresetForm] = useState<ChatRolePresetFormState>(() => defaultChatRolePresetForm());
  const [workspaceModalMode, setWorkspaceModalMode] = useState<WorkspaceModalMode | null>(null);
  const [workspaceEditMode, setWorkspaceEditMode] = useState(false);
  const [dragWorkspaceId, setDragWorkspaceId] = useState<string | null>(null);
  const [workspaceDropIndicator, setWorkspaceDropIndicator] = useState<WorkspaceDropIndicator | null>(null);
  const [workspaceLayoutSaving, setWorkspaceLayoutSaving] = useState(false);
  const [chatCompletionMarkers, setChatCompletionMarkers] = useState<ChatCompletionMarkerMap>(() => readChatCompletionMarkers());
  const [optimisticSessions, setOptimisticSessions] = useState<SessionSummary[]>([]);
  const [optimisticConversations, setOptimisticConversations] = useState<ConversationSummary[]>([]);
  const [optimisticWorkspaces, setOptimisticWorkspaces] = useState<WorkspaceSummary[]>([]);
  const [workspaceDraftSource, setWorkspaceDraftSource] = useState<'empty' | 'git'>('empty');
  const [workspaceDraftName, setWorkspaceDraftName] = useState('');
  const [workspaceDraftGitUrl, setWorkspaceDraftGitUrl] = useState('');
  const [inlineRenameSessionId, setInlineRenameSessionId] = useState<string | null>(null);
  const [inlineRenameTitle, setInlineRenameTitle] = useState('');
  const [editSessionId, setEditSessionId] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState('');
  const [editWorkspaceName, setEditWorkspaceName] = useState('');
  const [editSecurityProfile, setEditSecurityProfile] = useState<'repo-write' | 'full-host'>('repo-write');
  const [draftCodingExecutorState, setDraftCodingExecutorState] = useState<AgentExecutor>('codex');
  const [sessionApprovalMode, setSessionApprovalMode] = useState<ApprovalMode>('detailed');
  const [sessionModel, setSessionModel] = useState('');
  const [sessionEffort, setSessionEffort] = useState<ReasoningEffort>('xhigh');
  const [sessionRolePresetId, setSessionRolePresetId] = useState('');
  const [userModalMode, setUserModalMode] = useState<UserModalMode>('create');
  const [userModalOpen, setUserModalOpen] = useState(false);
  const [editingUserId, setEditingUserId] = useState<string | null>(null);
  const [userForm, setUserForm] = useState<UserFormState>(() => defaultUserForm());
  const [confirmAction, setConfirmAction] = useState<SessionConfirmAction>(null);
  const [chatRailEditMode, setChatRailEditMode] = useState(false);
  const [railDeleteConfirmId, setRailDeleteConfirmId] = useState<string | null>(null);
  const [transcriptItems, setTranscriptItems] = useState<SessionTranscriptEntry[]>([]);
  const [transcriptNextCursor, setTranscriptNextCursor] = useState<string | null>(null);
  const [transcriptLoadingOlder, setTranscriptLoadingOlder] = useState(false);
  const [transcriptLoadedOlder, setTranscriptLoadedOlder] = useState(false);
  const [chatLiveEvents, setChatLiveEvents] = useState<SessionEvent[]>([]);
  const [visibleSessionActivityLabel, setVisibleSessionActivityLabel] = useState<string | null>(null);
  const [departingSessionActivityLabel, setDepartingSessionActivityLabel] = useState<string | null>(null);
  const [isPromptComposing, setIsPromptComposing] = useState(false);
  const [approvalSelectionIndex, setApprovalSelectionIndex] = useState(0);
  const promptCompositionResetTimerRef = useRef<number | null>(null);
  const activityTickerTimerRef = useRef<number | null>(null);
  const lastPromptCompositionEndAtRef = useRef(0);
  const transcriptScrollRef = useRef<HTMLDivElement | null>(null);
  const workspaceRailBodyRef = useRef<HTMLDivElement | null>(null);
  const shouldStickTranscriptToBottomRef = useRef(false);
  const restoreTranscriptScrollHeightRef = useRef<number | null>(null);
  const promptTextareaRef = useRef<HTMLTextAreaElement | null>(null);
  const inlineRenameInputRef = useRef<HTMLInputElement | null>(null);
  const workspaceDraftInputRef = useRef<HTMLInputElement | null>(null);
  const attachmentInputRef = useRef<HTMLInputElement | null>(null);
  const approvalPromptRef = useRef<HTMLDivElement | null>(null);
  const chatProcessingSnapshotRef = useRef<Record<string, boolean>>({});
  const workspaceExpansionInitializedRef = useRef(false);
  const dragWorkspaceIdRef = useRef<string | null>(null);
  const attachmentPreviewRequestRef = useRef(0);
  const bootstrapRequestVersionRef = useRef(0);
  const notificationSnapshotsReadyRef = useRef(false);
  const notificationSessionSnapshotsRef = useRef<Record<string, NotificationSessionSnapshot>>({});
  const seenApprovalIdsRef = useRef<Set<string>>(new Set());
  const activityTickerOwnerRef = useRef<string | null>(null);
  const copy = COPY[language];

  const currentUserRoles = deriveRolesFromLegacy(bootstrap?.currentUser);
  const selectedPromptDraftKey = composerDraftKey(activeMode, selectedSessionId);
  const prompt = selectedPromptDraftKey ? (promptDrafts[selectedPromptDraftKey] ?? '') : '';
  const hasSelectedSession = selectedSessionId !== null;
  const availableModes = derivedAvailableModes(bootstrap);
  const chatBootstrapEnabled = Boolean(bootstrap && availableModes.includes('chat'));
  const bootstrapWorkspaces = normalizedWorkspaces(bootstrap);
  const bootstrapSessions = normalizedDeveloperSessions(bootstrap);
  const bootstrapConversations = normalizedChatConversations(chatBootstrap);
  const availableCodingExecutors: AgentExecutor[] = bootstrap?.defaults.availableExecutors.length
    ? bootstrap.defaults.availableExecutors
    : (bootstrap?.defaults.executor ? [bootstrap.defaults.executor] : ['codex']);
  const draftCodingExecutor: AgentExecutor = availableCodingExecutors.includes(draftCodingExecutorState)
    ? draftCodingExecutorState
    : (bootstrap?.defaults.executor ?? availableCodingExecutors[0] ?? 'codex');
  const currentSessionExecutor: AgentExecutor = detail?.session.executor ?? draftCodingExecutor;
  const availableModels = codingModelsForExecutor(bootstrap, currentSessionExecutor);
  const availableChatRolePresets = chatBootstrap?.rolePresets ?? [];
  const canManageChatRolePresets = Boolean(bootstrap?.currentUser.isAdmin && derivedAvailableModes(bootstrap).includes('chat'));
  const showSessionLoadingState = hasSelectedSession && !detail;
  const selectedChatTranscriptShouldPoll = activeMode === 'chat'
    && detail?.session.sessionType === 'chat'
    && detail.session.id === selectedSessionId
    && isChatSessionProcessing(detail.session);
  const currentSessionModelOption = availableModels.find((entry) => entry.model === sessionModel)
    ?? availableModels.find((entry) => entry.isDefault)
    ?? availableModels[0]
    ?? null;
  const currentSessionMode = detail?.session.sessionType === 'code'
    ? sessionApprovalMode
    : 'detailed';
  const currentSessionEfforts = currentSessionModelOption?.supportedReasoningEfforts.length
    ? currentSessionModelOption.supportedReasoningEfforts
    : FALLBACK_REASONING;
  const editingChatRolePreset = chatRolePresetList?.rolePresets.find((preset) => preset.id === editingChatRolePresetId) ?? null;

  function updatePromptDraft(draftKey: string | null, nextPrompt: string) {
    if (!draftKey) return;

    setPromptDrafts((current) => {
      if (!nextPrompt) {
        if (!(draftKey in current)) {
          return current;
        }
        const { [draftKey]: _removed, ...rest } = current;
        return rest;
      }

      if (current[draftKey] === nextPrompt) {
        return current;
      }

      return {
        ...current,
        [draftKey]: nextPrompt,
      };
    });
  }

  function migratePromptDraft(sourceKey: string | null, targetKey: string | null) {
    if (!sourceKey || !targetKey || sourceKey === targetKey) {
      return;
    }

    setPromptDrafts((current) => {
      const draft = current[sourceKey];
      if (typeof draft !== 'string' || draft.length === 0) {
        if (!(sourceKey in current)) {
          return current;
        }
        const { [sourceKey]: _removed, ...rest } = current;
        return rest;
      }

      const next = { ...current };
      next[targetKey] = draft;
      delete next[sourceKey];
      return next;
    });
  }

  function syncChatConversationSnapshot(nextConversation: ChatConversation) {
    setChatBootstrap((current) => (
      current
        ? {
            ...current,
            conversations: current.conversations.map((conversation) => (
              conversation.id === nextConversation.id
                ? {
                    ...conversation,
                    ...nextConversation,
                    lastUpdate: conversation.lastUpdate,
                  }
                : conversation
            )),
          }
        : current
    ));
    setDetail((current) => (
      current && current.session.id === nextConversation.id
        ? {
            ...current,
            session: chatConversationToConversationSummary(nextConversation),
          }
        : current
    ));
  }

  function applyChatRolePresetList(nextList: ChatRolePresetListResponse) {
    setChatRolePresetList(nextList);
    setChatBootstrap((current) => (
      current
        ? {
            ...current,
            rolePresets: nextList.rolePresets.map(({ id, label, description, isDefault }) => ({
              id,
              label,
              description,
              isDefault,
            })),
            defaults: {
              ...current.defaults,
              rolePresetId: nextList.defaultRolePresetId,
            },
          }
        : current
    ));
  }

  function invalidateBootstrapRefreshes() {
    bootstrapRequestVersionRef.current += 1;
  }

  function showSystemNotification(options: {
    title: string;
    body: string;
    tag: string;
    mode: AppMode;
    sessionId: string;
    workspaceId?: string | null;
  }) {
    if (typeof window === 'undefined' || typeof window.Notification === 'undefined') {
      return;
    }
    if (window.Notification.permission !== 'granted') {
      return;
    }

    const notification = new window.Notification(options.title, {
      body: options.body,
      tag: options.tag,
    });

    notification.onclick = () => {
      window.focus();
      setActiveMode(options.mode);
      if (options.workspaceId) {
        setSelectedWorkspaceId(options.workspaceId);
      }
      setSelectedSessionId(options.sessionId);
      notification.close();
    };
  }

  async function handleEnableNotifications() {
    if (typeof window === 'undefined' || typeof window.Notification === 'undefined') {
      setNotificationPermission('unsupported');
      return;
    }

    const nextPermission = await window.Notification.requestPermission();
    setNotificationPermission(nextPermission);
  }

  function applyBootstrapSnapshot(next: BootstrapPayload) {
    setHostReachable(true);
    setBootstrap(next);
    setActiveMode((current) => pickDefaultMode(next, current));
    setError(null);
  }

  async function refreshBootstrapState() {
    const requestVersion = ++bootstrapRequestVersionRef.current;

    try {
      const next = await fetchBootstrap();
      if (requestVersion !== bootstrapRequestVersionRef.current) {
        return null;
      }

      applyBootstrapSnapshot(next);
      return next;
    } catch (refreshError) {
      if (requestVersion !== bootstrapRequestVersionRef.current) {
        return null;
      }
      throw refreshError;
    }
  }

  const editingAdminUser = editingUserId
    ? adminUsers?.find((entry) => entry.id === editingUserId) ?? null
    : null;

  useEffect(() => {
    window.localStorage.setItem(THEME_STORAGE_KEY, theme);
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  useEffect(() => {
    window.localStorage.setItem('rvc-language', language);
  }, [language]);

  useEffect(() => {
    window.localStorage.setItem('rvc-mode', activeMode);
  }, [activeMode]);

  useEffect(() => {
    window.localStorage.setItem(DEVELOPER_RAIL_HIDDEN_STORAGE_KEY, String(developerRailHidden));
  }, [developerRailHidden]);

  useEffect(() => {
    window.localStorage.setItem(CHAT_RAIL_HIDDEN_STORAGE_KEY, String(chatRailHidden));
  }, [chatRailHidden]);

  useEffect(() => {
    window.localStorage.setItem('rvc-rail-width', String(railWidth));
  }, [railWidth]);

  useEffect(() => {
    window.localStorage.setItem(
      CHAT_COMPLETION_MARKERS_STORAGE_KEY,
      JSON.stringify(chatCompletionMarkers),
    );
  }, [chatCompletionMarkers]);

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
    function syncNotificationPermission() {
      setNotificationPermission(currentNotificationPermission());
    }

    window.addEventListener('focus', syncNotificationPermission);
    document.addEventListener('visibilitychange', syncNotificationPermission);
    return () => {
      window.removeEventListener('focus', syncNotificationPermission);
      document.removeEventListener('visibilitychange', syncNotificationPermission);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function loadBootstrapData() {
      try {
        const next = await refreshBootstrapState();
        if (cancelled || !next) return;
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
    if (!chatBootstrapEnabled) {
      setChatBootstrap(null);
      return;
    }
    if (activeMode !== 'chat') {
      return;
    }

    let cancelled = false;

    async function loadChatBootstrapData() {
      try {
        const next = await fetchChatBootstrap();
        if (cancelled) return;
        setChatBootstrap(next);
        setError(null);
      } catch (loadError) {
        if (!cancelled && activeMode === 'chat') {
          setError(loadError instanceof Error ? loadError.message : copy.unknownError);
        }
      }
    }

    void loadChatBootstrapData();
    const timer = window.setInterval(() => {
      void loadChatBootstrapData();
    }, 10000);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [chatBootstrapEnabled, activeMode, copy.unknownError]);

  useEffect(() => {
    if (!bootstrap) {
      return;
    }

    const nextApprovalIds = new Set(bootstrap.approvals.map((approval) => approval.id));
    const nextSessionSnapshots: Record<string, NotificationSessionSnapshot> = {};
    const codingSessionsById = new Map(bootstrap.sessions.map((session) => [session.id, session]));

    for (const session of bootstrap.sessions) {
      nextSessionSnapshots[session.id] = {
        id: session.id,
        sessionType: 'code',
        workspaceId: session.workspaceId,
        title: session.title,
        updatedAt: session.updatedAt,
        state: deriveNotificationSessionState(session),
      };
    }

    for (const conversation of bootstrap.conversations) {
      nextSessionSnapshots[conversation.id] = {
        id: conversation.id,
        sessionType: 'chat',
        workspaceId: null,
        title: conversation.title,
        updatedAt: conversation.updatedAt,
        state: deriveNotificationSessionState(conversation),
      };
    }

    if (!notificationSnapshotsReadyRef.current) {
      seenApprovalIdsRef.current = nextApprovalIds;
      notificationSessionSnapshotsRef.current = nextSessionSnapshots;
      notificationSnapshotsReadyRef.current = true;
      return;
    }

    if (notificationPermission === 'granted') {
      for (const approval of bootstrap.approvals) {
        if (seenApprovalIdsRef.current.has(approval.id)) {
          continue;
        }

        const session = codingSessionsById.get(approval.sessionId);
        if (!session) {
          continue;
        }

        showSystemNotification({
          title: language === 'zh'
            ? `需要审批 · ${session.title}`
            : `Approval required · ${session.title}`,
          body: approval.risk,
          tag: `approval:${approval.id}`,
          mode: 'developer',
          sessionId: session.id,
          workspaceId: session.workspaceId,
        });
      }

      for (const snapshot of Object.values(nextSessionSnapshots)) {
        if (!shouldNotifySessionCompletion(notificationSessionSnapshotsRef.current[snapshot.id], snapshot)) {
          continue;
        }

        showSystemNotification({
          title: language === 'zh'
            ? `${snapshot.sessionType === 'chat' ? '聊天已完成' : '代码会话已完成'} · ${snapshot.title}`
            : `${snapshot.sessionType === 'chat' ? 'Chat completed' : 'Coding completed'} · ${snapshot.title}`,
          body: language === 'zh'
            ? '本轮已经完成，可以继续发送下一条消息。'
            : 'The latest turn is complete and ready for your next message.',
          tag: `completed:${snapshot.id}:${snapshot.updatedAt}`,
          mode: snapshot.sessionType === 'chat' ? 'chat' : 'developer',
          sessionId: snapshot.id,
          workspaceId: snapshot.workspaceId,
        });
      }
    }

    seenApprovalIdsRef.current = nextApprovalIds;
    notificationSessionSnapshotsRef.current = nextSessionSnapshots;
  }, [bootstrap, language, notificationPermission]);

  useEffect(() => {
    if (!selectedSessionId) {
      setDetail(null);
      setTranscriptItems([]);
      setTranscriptNextCursor(null);
      setTranscriptLoadedOlder(false);
      setChatLiveEvents([]);
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
        const next = activeMode === 'chat'
          ? chatDetailToSessionDetail(await fetchChatConversationDetail(currentSessionId))
          : await fetchCodingSessionDetail(currentSessionId);
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
    if (activeMode === 'chat') {
      return () => {
        cancelled = true;
      };
    }
    const timer = window.setInterval(() => {
      void loadDetail();
    }, 1500);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [selectedSessionId, activeMode, optimisticSessions, optimisticConversations, copy.unknownError]);

  useEffect(() => {
    if (activeMode !== 'chat') {
      if (chatRailEditMode) {
        setChatRailEditMode(false);
      }
    }

    const inlineDeleteEnabled = (activeMode === 'chat' && chatRailEditMode) || (activeMode === 'developer' && workspaceEditMode);
    if (!inlineDeleteEnabled && railDeleteConfirmId) {
      setRailDeleteConfirmId(null);
    }
  }, [activeMode, chatRailEditMode, railDeleteConfirmId, workspaceEditMode]);

  useEffect(() => {
    if (!rolesOpen || !canManageChatRolePresets) {
      return;
    }

    let cancelled = false;

    async function loadRolePresets() {
      try {
        const next = await fetchChatRolePresets();
        if (cancelled) return;
        applyChatRolePresetList(next);
        setError(null);
      } catch (loadError) {
        if (!cancelled) {
          setError(loadError instanceof Error ? loadError.message : copy.unknownError);
        }
      }
    }

    void loadRolePresets();
    return () => {
      cancelled = true;
    };
  }, [rolesOpen, canManageChatRolePresets, copy.unknownError]);

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
    if (!rolesOpen) {
      setEditingChatRolePresetId(null);
      setChatRolePresetForm(defaultChatRolePresetForm());
      return;
    }
    if (editingChatRolePresetId && chatRolePresetList && !chatRolePresetList.rolePresets.some((preset) => preset.id === editingChatRolePresetId)) {
      setEditingChatRolePresetId(null);
      setChatRolePresetForm(defaultChatRolePresetForm());
    }
  }, [rolesOpen, editingChatRolePresetId, chatRolePresetList]);

  useEffect(() => {
    if (rolesOpen && !canManageChatRolePresets) {
      setRolesOpen(false);
    }
  }, [rolesOpen, canManageChatRolePresets]);

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
    setChatLiveEvents([]);
    restoreTranscriptScrollHeightRef.current = null;
    shouldStickTranscriptToBottomRef.current = true;
  }, [selectedSessionId]);

  useEffect(() => {
    if (!selectedSessionId) {
      setTranscriptItems([]);
      setTranscriptNextCursor(null);
      setTranscriptLoadedOlder(false);
      setChatLiveEvents([]);
      return;
    }

    const currentSessionId = selectedSessionId;
    if (isOptimisticSessionId(currentSessionId)) {
      setTranscriptItems([]);
      setTranscriptNextCursor(null);
      setTranscriptLoadedOlder(false);
      setChatLiveEvents([]);
      return;
    }

    let cancelled = false;

    async function loadLatestTranscript() {
      try {
        const next = activeMode === 'chat'
          ? await fetchChatConversationTranscript(currentSessionId, { limit: TRANSCRIPT_PAGE_SIZE })
          : await fetchCodingSessionTranscript(currentSessionId, { limit: TRANSCRIPT_PAGE_SIZE });
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

        if (activeMode === 'chat' && isChatTranscriptPageResponse(next)) {
          setChatLiveEvents(next.liveEvents);
          syncChatConversationSnapshot(next.conversation);
        }
        setError(null);
      } catch (loadError) {
        if (!cancelled) {
          setError(loadError instanceof Error ? loadError.message : copy.unknownError);
        }
      }
    }

    void loadLatestTranscript();
    if (activeMode === 'chat' && !selectedChatTranscriptShouldPoll) {
      return () => {
        cancelled = true;
      };
    }
    const timer = window.setInterval(() => {
      void loadLatestTranscript();
    }, 1500);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [selectedSessionId, activeMode, selectedChatTranscriptShouldPoll, transcriptLoadedOlder, copy.unknownError]);

  useEffect(() => {
    const currentConversations = new Map<string, ChatStatusRecord>();
    for (const conversation of bootstrapConversations) {
      currentConversations.set(conversation.id, conversation);
    }
    if (activeMode === 'chat' && detail?.session.sessionType === 'chat') {
      currentConversations.set(detail.session.id, detail.session);
    }

    const previousSnapshot = chatProcessingSnapshotRef.current;
    const nextSnapshot: Record<string, boolean> = {};
    for (const [conversationId, conversation] of currentConversations) {
      nextSnapshot[conversationId] = isChatSessionProcessing(conversation);
    }

    setChatCompletionMarkers((current) => {
      let next = current;
      let changed = false;

      for (const [conversationId, conversation] of currentConversations) {
        const isProcessing = nextSnapshot[conversationId];
        const wasProcessing = previousSnapshot[conversationId] ?? false;
        const chatUiStatus = chatUiStatusFromConversation(conversation);

        if (chatUiStatus === 'error' || isProcessing || !conversation.hasTranscript) {
          if (conversationId in next) {
            if (next === current) {
              next = { ...current };
            }
            delete next[conversationId];
            changed = true;
          }
          continue;
        }

        if (wasProcessing) {
          if (selectedSessionId !== conversationId && next[conversationId] !== conversation.updatedAt) {
            if (next === current) {
              next = { ...current };
            }
            next[conversationId] = conversation.updatedAt;
            changed = true;
          }
          continue;
        }

        if (next[conversationId] && next[conversationId] !== conversation.updatedAt) {
          if (next === current) {
            next = { ...current };
          }
          delete next[conversationId];
          changed = true;
        }
      }

      for (const conversationId of Object.keys(next)) {
        if (!currentConversations.has(conversationId)) {
          if (next === current) {
            next = { ...current };
          }
          delete next[conversationId];
          changed = true;
        }
      }

      return changed ? next : current;
    });

    chatProcessingSnapshotRef.current = nextSnapshot;
  }, [activeMode, bootstrapConversations, detail, selectedSessionId]);

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
    if (activeMode !== 'developer') {
      if (developerSubview !== 'sessions') {
        setDeveloperSubview('sessions');
      }
      if (selectedFileWorkspaceId !== null) {
        setSelectedFileWorkspaceId(null);
      }
      return;
    }

    const availableFileWorkspaces = (() => {
      const allDeveloperWorkspaces = [
        ...optimisticWorkspaces,
        ...bootstrapWorkspaces,
      ];
      const visible = visibleDeveloperWorkspaces(allDeveloperWorkspaces);
      return visible.length > 0 ? visible : selectableDeveloperWorkspaces(allDeveloperWorkspaces);
    })();
    const workspaceIds = new Set(availableFileWorkspaces.map((workspace) => workspace.id));
    if (selectedFileWorkspaceId && workspaceIds.has(selectedFileWorkspaceId)) {
      return;
    }

    const fallbackWorkspaceId = selectedWorkspaceId && workspaceIds.has(selectedWorkspaceId)
      ? selectedWorkspaceId
      : availableFileWorkspaces[0]?.id ?? null;
    if (selectedFileWorkspaceId !== fallbackWorkspaceId) {
      setSelectedFileWorkspaceId(fallbackWorkspaceId);
    }
  }, [activeMode, bootstrapWorkspaces, developerSubview, optimisticWorkspaces, selectedFileWorkspaceId, selectedWorkspaceId]);

  useEffect(() => {
    const filesViewActive = activeMode === 'developer' && developerSubview === 'files';
    if (!filesViewActive || !selectedFileWorkspaceId) {
      return;
    }

    void loadWorkspaceFileTree(selectedFileWorkspaceId, '', true);
  }, [activeMode, developerSubview, selectedFileWorkspaceId]);

  useEffect(() => {
    const filesViewActive = activeMode === 'developer' && developerSubview === 'files';
    const nextSelectedFilePath = selectedFileWorkspaceId ? (selectedFilePaths[selectedFileWorkspaceId] ?? null) : null;
    if (!filesViewActive || !selectedFileWorkspaceId || !nextSelectedFilePath) {
      setFilePreviewError(null);
      return;
    }

    void loadWorkspaceFilePreview(selectedFileWorkspaceId, nextSelectedFilePath);
  }, [activeMode, developerSubview, selectedFilePaths, selectedFileWorkspaceId]);

  useEffect(() => {
    setDeveloperInspectorOpen(false);
    setDeveloperInspectorWorkspaceId(null);
    setDeveloperInspectorFilePath(null);
    setDeveloperInspectorTab('preview');
    setDeveloperInspectorDiffChange(null);
    setDeveloperInspectorLoadingKey(null);
    setDeveloperInspectorError(null);
    setDeveloperInspectorSourceToken(null);
    setDeveloperInspectorDismissedToken(null);
  }, [activeMode, developerSubview, selectedSessionId]);

  useEffect(() => {
    attachmentPreviewRequestRef.current += 1;
    setAttachmentPreviewTarget(null);
    setAttachmentPreviewResourceState(null);
    setAttachmentPreviewLoading(false);
    setAttachmentPreviewError(null);
  }, [activeMode, selectedSessionId]);

  useEffect(() => {
    const filesViewActive = activeMode === 'developer' && developerSubview === 'files';
    const latestFileChangeEntry = !filesViewActive && detail?.session.sessionType === 'code'
      ? [...transcriptItems].reverse().find((entry) => entry.kind === 'tool' && entry.label === 'files' && Array.isArray(entry.fileChanges) && entry.fileChanges.length > 0) ?? null
      : null;
    const latestFileChange = latestFileChangeEntry?.fileChanges?.[0] ?? null;
    const latestFileChangeToken = detail?.session.sessionType === 'code' && latestFileChangeEntry && latestFileChange
      ? `${detail.session.id}:${latestFileChangeEntry.id}:${latestFileChange.path}`
      : null;

    if (
      activeMode !== 'developer'
      || developerSubview !== 'sessions'
      || detail?.session.sessionType !== 'code'
      || !latestFileChange
      || !latestFileChangeToken
      || developerInspectorDismissedToken === latestFileChangeToken
    ) {
      return;
    }

    if (developerInspectorOpen && developerInspectorSourceToken === latestFileChangeToken) {
      return;
    }

    openDeveloperInspector({
      workspaceId: detail.session.workspaceId,
      path: latestFileChange.path,
      tab: 'diff',
      diffChange: latestFileChange,
      sourceToken: latestFileChangeToken,
    });
  }, [
    activeMode,
    developerSubview,
    detail?.session,
    transcriptItems,
    developerInspectorDismissedToken,
    developerInspectorOpen,
    developerInspectorSourceToken,
  ]);

  useEffect(() => {
    if (!bootstrap) return;

    const visibleWorkspaceIds = new Set(visibleDeveloperWorkspaces([
      ...optimisticWorkspaces,
      ...bootstrapWorkspaces,
    ]).map((workspace) => workspace.id));
    const allDeveloperSessions = [...optimisticSessions, ...bootstrapSessions]
      .filter((session) => visibleWorkspaceIds.has(session.workspaceId));
    const allConversations = sortChatConversationsForRail(
      [...optimisticConversations, ...bootstrapConversations],
      chatCompletionMarkers,
    );

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
  }, [bootstrap, chatBootstrap, activeMode, optimisticSessions, optimisticConversations, selectedWorkspaceId, selectedSessionId, chatCompletionMarkers]);

  useEffect(() => {
    if (activeMode !== 'developer') {
      workspaceExpansionInitializedRef.current = false;
      if (dragWorkspaceId) {
        setDragWorkspaceId(null);
      }
      if (workspaceDropIndicator) {
        setWorkspaceDropIndicator(null);
      }
      if (expandedWorkspaceIds.length > 0) {
        setExpandedWorkspaceIds([]);
      }
      if (workspaceEditMode) {
        setWorkspaceEditMode(false);
      }
      return;
    }

    if (!workspaceEditMode) {
      if (dragWorkspaceId) {
        setDragWorkspaceId(null);
      }
      if (workspaceDropIndicator) {
        setWorkspaceDropIndicator(null);
      }
    }

    const nextRailWorkspaces = workspaceEditMode
      ? sortWorkspaceSummaries(selectableDeveloperWorkspaces([
          ...optimisticWorkspaces,
          ...bootstrapWorkspaces,
        ]))
      : visibleDeveloperWorkspaces([
          ...optimisticWorkspaces,
          ...bootstrapWorkspaces,
        ]);
    const visibleIds = new Set(nextRailWorkspaces.map((workspace) => workspace.id));

    setExpandedWorkspaceIds((current) => {
      const filtered = current.filter((workspaceId) => visibleIds.has(workspaceId));
      let nextExpandedIds = filtered;

      if (!workspaceEditMode && !workspaceExpansionInitializedRef.current && nextRailWorkspaces.length > 0) {
        workspaceExpansionInitializedRef.current = true;
        nextExpandedIds = filtered.length > 0 ? filtered : [nextRailWorkspaces[0]!.id];
      }

      return sameOrderedStrings(current, nextExpandedIds) ? current : nextExpandedIds;
    });
  }, [activeMode, bootstrapWorkspaces, dragWorkspaceId, expandedWorkspaceIds.length, optimisticWorkspaces, workspaceDropIndicator, workspaceEditMode]);

  useEffect(() => {
    if (draftCodingExecutorState !== draftCodingExecutor) {
      setDraftCodingExecutorState(draftCodingExecutor);
    }
  }, [draftCodingExecutor, draftCodingExecutorState]);

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
    if (detail.session.sessionType === 'chat') {
      const chatSession = detail.session;
      const nextRolePresetId = chatSession.rolePresetId
        && availableChatRolePresets.some((preset) => preset.id === chatSession.rolePresetId)
        ? chatSession.rolePresetId
        : '';
      setSessionRolePresetId(nextRolePresetId);
      return;
    }
    setSessionRolePresetId('');
  }, [detail?.session, availableModels, availableChatRolePresets]);

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
    clearActivityTickerTimer();
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

  const networkState = !browserOnline
    ? 'down'
    : hostReachable
      ? 'ok'
      : 'recovering';
  const sessionIsChat = detail?.session.sessionType === 'chat';
  const selectedChatRolePreset = (() => {
    if (detail?.session.sessionType !== 'chat') {
      return null;
    }
    const chatSession = detail.session;
    return availableChatRolePresets.find((preset) => preset.id === chatSession.rolePresetId) ?? null;
  })();
  const selectedSessionIsOptimistic = isOptimisticSessionId(selectedSessionId);
  const inlineRenameActive = Boolean(detail && inlineRenameSessionId === detail.session.id);
  const inlineRenameBusy = Boolean(detail && busy === `rename-${detail.session.id}`);
  const sessionHasActiveTurn = Boolean(detail?.session.activeTurnId);
  const draftAttachments = detail?.draftAttachments ?? [];
  const queuedTurns = detail?.queuedTurns ?? [];
  const pendingApprovals = detail?.session.sessionType === 'code'
    ? (bootstrap?.approvals.filter((approval) => approval.sessionId === detail.session.id) ?? [])
    : (detail?.approvals ?? []);
  const activeApproval = pendingApprovals[0] ?? null;
  const canQueueCodingFollowUpTurn = Boolean(detail && !sessionIsChat && sessionHasActiveTurn && !activeApproval);
  const developerModeEnabled = availableModes.includes('developer');
  const chatModeEnabled = availableModes.includes('chat');
  const developerFilesView = activeMode === 'developer' && developerSubview === 'files';
  const currentRailHidden = activeMode === 'developer' ? developerRailHidden : chatRailHidden;
  const primaryNavWidth = 64;
  const networkLabel = networkState === 'ok'
    ? copy.networkStatusOk
    : networkState === 'recovering'
      ? copy.networkStatusRecovering
      : copy.networkStatusDown;
  const approvalOptions: Array<{ decision: 'accept' | 'decline'; scope: 'once' | 'session'; label: string; tone?: 'secondary' }> = [
    { decision: 'accept', scope: 'once', label: copy.approveOnce },
    ...(activeApproval?.scopeOptions.includes('session')
      ? [{ decision: 'accept' as const, scope: 'session' as const, label: copy.approveSession }]
      : []),
    { decision: 'decline', scope: 'once', label: copy.decline, tone: 'secondary' },
  ];
  const networkAlertMessage = networkState === 'recovering'
    ? copy.networkAlertRecovering
    : networkState === 'down'
      ? copy.networkAlertDown
      : null;
  const allSessions = [
    ...optimisticSessions,
    ...bootstrapSessions,
  ];
  const allConversations = [
    ...optimisticConversations,
    ...bootstrapConversations,
  ];
  const sortedConversations = sortChatConversationsForRail(allConversations, chatCompletionMarkers);
  const allWorkspaces = [
    ...optimisticWorkspaces,
    ...bootstrapWorkspaces,
  ];
  const developerWorkspaceOptions = selectableDeveloperWorkspaces(allWorkspaces);
  const editableWorkspaces = sortWorkspaceSummaries(developerWorkspaceOptions);
  const visibleWorkspaces = visibleDeveloperWorkspaces(allWorkspaces);
  const fileWorkspaceOptions = visibleWorkspaces.length > 0 ? visibleWorkspaces : developerWorkspaceOptions;
  const editableVisibleWorkspaces = editableWorkspaces.filter((workspace) => workspace.visible);
  const editableHiddenWorkspaces = editableWorkspaces.filter((workspace) => !workspace.visible);
  const railVisibleWorkspaces = workspaceEditMode ? editableVisibleWorkspaces : visibleWorkspaces;
  const visibleWorkspaceIds = new Set(visibleWorkspaces.map((workspace) => workspace.id));
  const visibleWorkspaceSessions = allSessions.filter((session) => visibleWorkspaceIds.has(session.workspaceId));
  const selectedWorkspace = developerWorkspaceOptions.find((workspace) => workspace.id === selectedWorkspaceId) ?? null;
  const selectedFileWorkspace = fileWorkspaceOptions.find((workspace) => workspace.id === selectedFileWorkspaceId) ?? null;
  const selectedFilePath = selectedFileWorkspaceId ? (selectedFilePaths[selectedFileWorkspaceId] ?? null) : null;
  const selectedFileRootTreeKey = selectedFileWorkspaceId ? codingFileTreeKey(selectedFileWorkspaceId, '') : null;
  const selectedFilePreviewKey = selectedFileWorkspaceId && selectedFilePath
    ? codingFileTreeKey(selectedFileWorkspaceId, selectedFilePath)
    : null;
  const selectedFilePreview = selectedFilePreviewKey ? (filePreviewCache[selectedFilePreviewKey] ?? null) : null;
  const selectedFileRootTreeState = selectedFileWorkspaceId ? currentFileTreeState(selectedFileWorkspaceId, '') : null;
  const selectedFileDiffEntry = detail?.session.sessionType === 'code'
    && selectedFilePath
    && selectedFileWorkspaceId === detail.session.workspaceId
    ? [...transcriptItems].reverse().find((entry) => entry.kind === 'tool'
      && entry.label === 'files'
      && Array.isArray(entry.fileChanges)
      && entry.fileChanges.some((change) => change.path === selectedFilePath)) ?? null
    : null;
  const selectedFileDiffChange = selectedFileDiffEntry?.fileChanges?.find((change) => change.path === selectedFilePath) ?? null;
  const developerInspectorWorkspace = developerWorkspaceOptions.find((workspace) => workspace.id === developerInspectorWorkspaceId) ?? null;
  const developerInspectorPreviewKey = developerInspectorWorkspaceId && developerInspectorFilePath
    ? codingFileTreeKey(developerInspectorWorkspaceId, developerInspectorFilePath)
    : null;
  const developerInspectorPreview = developerInspectorPreviewKey
    ? (filePreviewCache[developerInspectorPreviewKey] ?? null)
    : null;
  const hasSelectedFileRootTreeState = selectedFileRootTreeKey
    ? Object.prototype.hasOwnProperty.call(fileTreeDirectories, selectedFileRootTreeKey)
    : false;
  const visibleDeveloperSessions = visibleWorkspaceSessions;
  const railItems = activeMode === 'developer' ? visibleDeveloperSessions : sortedConversations;
  const sessionActivityItems = detail
    ? deriveSessionActivityItems(
      detail.session.sessionType === 'chat' ? chatLiveEvents : detail.liveEvents,
      language,
    )
    : [];
  const latestTranscriptFileChangeEntry = !developerFilesView && detail?.session.sessionType === 'code'
    ? [...transcriptItems].reverse().find((entry) => entry.kind === 'tool' && entry.label === 'files' && Array.isArray(entry.fileChanges) && entry.fileChanges.length > 0) ?? null
    : null;
  const latestTranscriptFileChange = latestTranscriptFileChangeEntry?.fileChanges?.[0] ?? null;
  const latestTranscriptFileChangeToken = detail?.session.sessionType === 'code' && latestTranscriptFileChangeEntry && latestTranscriptFileChange
    ? `${detail.session.id}:${latestTranscriptFileChangeEntry.id}:${latestTranscriptFileChange.path}`
    : null;
  const showChatAttachmentInlinePreview = sessionIsChat && Boolean(attachmentPreviewTarget);
  const detailSessionState = deriveDetailSessionState(detail?.session ?? null, {
    activeApproval,
    busy,
    hasActiveTurn: sessionHasActiveTurn,
  });
  const detailSessionStatusLabel = detailSessionState ? uiSessionStateLabel(language, detailSessionState) : null;
  const detailSessionStatusTitle = detailSessionState === 'pending'
    ? activeApproval?.title ?? copy.approvalPendingHint
    : detailSessionState === 'processing'
      ? copy.processingHint
      : detailSessionState === 'completed'
        ? copy.turnCompleteHint
        : detailSessionState === 'new'
          ? copy.noTurnsHint
          : detailSessionState === 'error'
            ? detail?.session.lastIssue ?? copy.errorHint
            : detailSessionState === 'stale'
              ? copy.staleHint
              : detailSessionState === 'normal'
                ? copy.normalHint
                : null;
  const activityTickerOwnerKey = detail ? `${detail.session.sessionType}:${detail.session.id}` : null;
  const latestSessionActivityLabel = detailSessionState === 'processing'
    ? sessionActivityItems.at(-1)?.label ?? null
    : null;
  const detailSessionTitle = detail?.session
    ? detail.session.sessionType === 'code'
      ? `${workspaceNameForSession(detail.session, allWorkspaces, bootstrap?.workspaceRoot)} · ${detail.session.title}`
      : detail.session.title
    : copy.selectOrCreate;
  const showDeveloperInspector = activeMode === 'developer'
    && !developerFilesView
    && developerInspectorOpen
    && Boolean(developerInspectorWorkspaceId && developerInspectorFilePath);
  const codingAnswerLabelEntryIds = new Set<string>();
  if (!sessionIsChat) {
    let hasAssistantReplyInCurrentTurn = false;
    for (const entry of transcriptItems) {
      if (entry.kind === 'user') {
        hasAssistantReplyInCurrentTurn = false;
        continue;
      }

      if (entry.kind !== 'assistant') {
        continue;
      }

      if (!hasAssistantReplyInCurrentTurn) {
        codingAnswerLabelEntryIds.add(entry.id);
        hasAssistantReplyInCurrentTurn = true;
      }
    }
  }

  useEffect(() => {
    if (activeMode !== 'developer' || developerSubview !== 'files') {
      return;
    }

    setFileBrowserTab('preview');
  }, [activeMode, developerSubview, selectedFileWorkspaceId, selectedFilePath]);

  useEffect(() => {
    if (fileBrowserTab !== 'diff' || selectedFileDiffChange) {
      return;
    }

    setFileBrowserTab('preview');
  }, [fileBrowserTab, selectedFileDiffChange]);

  useEffect(() => {
    if (activityTickerOwnerRef.current !== activityTickerOwnerKey) {
      activityTickerOwnerRef.current = activityTickerOwnerKey;
      clearActivityTickerTimer();
      setDepartingSessionActivityLabel(null);
      setVisibleSessionActivityLabel(latestSessionActivityLabel);
      return;
    }

    if (!latestSessionActivityLabel) {
      clearActivityTickerTimer();
      setDepartingSessionActivityLabel(null);
      setVisibleSessionActivityLabel(null);
      return;
    }

    if (!visibleSessionActivityLabel) {
      setVisibleSessionActivityLabel(latestSessionActivityLabel);
      return;
    }

    if (visibleSessionActivityLabel === latestSessionActivityLabel) {
      return;
    }

    const previousLabel = visibleSessionActivityLabel;
    clearActivityTickerTimer();
    setDepartingSessionActivityLabel(previousLabel);
    setVisibleSessionActivityLabel(latestSessionActivityLabel);
    activityTickerTimerRef.current = window.setTimeout(() => {
      setDepartingSessionActivityLabel((current) => current === previousLabel ? null : current);
      activityTickerTimerRef.current = null;
    }, ACTIVITY_TICKER_TRANSITION_MS);
  }, [activityTickerOwnerKey, latestSessionActivityLabel, visibleSessionActivityLabel]);

  useEffect(() => {
    setApprovalSelectionIndex(0);
    if (detailSessionState !== 'pending' || !activeApproval) return;
    window.setTimeout(() => {
      approvalPromptRef.current?.focus();
    }, 0);
  }, [detailSessionState, activeApproval?.id]);

  const canSaveSession = Boolean(
    detail
    && editTitle.trim(),
  );
  const railEyebrow = activeMode === 'developer'
    ? (developerFilesView ? copy.filesTitle : (language === 'zh' ? '工作区' : 'Workspace'))
    : `${language === 'zh' ? '对话' : 'Conversations'} (${railItems.length})`;
  const railEmptyLabel = activeMode === 'developer'
    ? (language === 'zh' ? '暂时还没有会话。' : 'No sessions yet.')
    : (language === 'zh' ? '还没有聊天记录。' : 'No conversations yet.');
  const noWorkspaceLabel = language === 'zh' ? '还没有 workspace。' : 'No workspaces yet.';
  const modelSelectOptions: SelectOption[] = availableModels.map((option) => ({
    value: option.model,
    label: option.displayName,
  }));
  const executorSelectOptions: SelectOption[] = availableCodingExecutors.map((executor) => ({
    value: executor,
    label: executorOptionLabel(language, executor),
  }));
  const showDraftExecutorSelector = executorSelectOptions.length > 1 && !hasSelectedSession;
  const effortSelectOptions: SelectOption[] = currentSessionEfforts.map((effort) => ({
    value: effort,
    label: effort,
  }));
  const rolePresetSelectOptions: SelectOption[] = [
    { value: '', label: copy.noRolePreset },
    ...availableChatRolePresets.map((preset) => ({
      value: preset.id,
      label: preset.label,
    })),
  ];
  const modeSelectOptions: SelectOption[] = [
    { value: 'detailed', label: copy.detailedMode },
    { value: 'less-interruption', label: copy.lessInterruptiveMode },
    { value: 'full-auto', label: copy.allPermissionsMode },
  ];
  const workspaceSelectOptions: SelectOption[] = [
    { value: '', label: copy.workspaceSelect },
    { value: CREATE_WORKSPACE_OPTION, label: copy.newWorkspaceOption },
    ...(developerWorkspaceOptions.map((workspace) => ({
      value: workspace.name,
      label: workspace.name,
    }))),
  ];
  const fileWorkspaceSelectOptions: SelectOption[] = fileWorkspaceOptions.map((workspace) => ({
    value: workspace.id,
    label: workspace.name,
  }));
  const securityProfileSelectOptions: SelectOption[] = [
    { value: 'repo-write', label: copy.repoWriteProfile },
    ...(bootstrap?.currentUser.canUseFullHost
      ? [{ value: 'full-host', label: copy.fullHostProfile }]
      : []),
  ];

  function preferredFileWorkspaceId() {
    if (selectedWorkspaceId && fileWorkspaceOptions.some((workspace) => workspace.id === selectedWorkspaceId)) {
      return selectedWorkspaceId;
    }
    return fileWorkspaceOptions[0]?.id ?? null;
  }

  function currentFileTreeState(workspaceId: string, path = '') {
    return fileTreeDirectories[codingFileTreeKey(workspaceId, path)] ?? {
      entries: [],
      loading: false,
      error: null,
    };
  }

  async function loadWorkspaceFileTree(workspaceId: string, path = '', force = false) {
    const cacheKey = codingFileTreeKey(workspaceId, path);
    const cached = fileTreeDirectories[cacheKey];
    if (!force && cached && (cached.loading || cached.entries.length > 0)) {
      return;
    }

    setFileTreeDirectories((current) => ({
      ...current,
      [cacheKey]: {
        entries: current[cacheKey]?.entries ?? [],
        loading: true,
        error: null,
      },
    }));

    try {
      const response = await fetchCodingWorkspaceTree(workspaceId, path);
      setFileTreeDirectories((current) => ({
        ...current,
        [cacheKey]: {
          entries: response.entries,
          loading: false,
          error: null,
        },
      }));
    } catch (loadError) {
      const message = loadError instanceof Error ? loadError.message : copy.unknownError;
      setFileTreeDirectories((current) => ({
        ...current,
        [cacheKey]: {
          entries: current[cacheKey]?.entries ?? [],
          loading: false,
          error: message,
        },
      }));
    }
  }

  async function loadWorkspaceFilePreview(workspaceId: string, path: string, force = false) {
    const cacheKey = codingFileTreeKey(workspaceId, path);
    if (!force && filePreviewCache[cacheKey]) {
      setFilePreviewError(null);
      return;
    }

    setFilePreviewLoadingKey(cacheKey);
    setFilePreviewError(null);
    try {
      const response = await fetchCodingWorkspaceFile(workspaceId, path);
      setFilePreviewCache((current) => ({
        ...current,
        [cacheKey]: response,
      }));
    } catch (loadError) {
      setFilePreviewError(loadError instanceof Error ? loadError.message : copy.unknownError);
    } finally {
      setFilePreviewLoadingKey((current) => current === cacheKey ? null : current);
    }
  }

  async function loadDeveloperInspectorPreview(workspaceId: string, path: string, force = false) {
    const cacheKey = codingFileTreeKey(workspaceId, path);
    if (!force && filePreviewCache[cacheKey]) {
      setDeveloperInspectorError(null);
      return;
    }

    setDeveloperInspectorLoadingKey(cacheKey);
    setDeveloperInspectorError(null);
    try {
      const response = await fetchCodingWorkspaceFile(workspaceId, path);
      setFilePreviewCache((current) => ({
        ...current,
        [cacheKey]: response,
      }));
    } catch (loadError) {
      setDeveloperInspectorError(loadError instanceof Error ? loadError.message : copy.unknownError);
    } finally {
      setDeveloperInspectorLoadingKey((current) => current === cacheKey ? null : current);
    }
  }

  async function refreshFileBrowser() {
    if (!selectedFileWorkspaceId) {
      return;
    }

    const expandedPaths = expandedFileTreePaths[selectedFileWorkspaceId] ?? [];
    await Promise.all([
      loadWorkspaceFileTree(selectedFileWorkspaceId, '', true),
      ...expandedPaths.map((path) => loadWorkspaceFileTree(selectedFileWorkspaceId, path, true)),
    ]);

    const nextSelectedFilePath = selectedFilePaths[selectedFileWorkspaceId] ?? null;
    if (nextSelectedFilePath) {
      await loadWorkspaceFilePreview(selectedFileWorkspaceId, nextSelectedFilePath, true);
    }
  }

  function handleDeveloperSubviewClick(nextSubview: DeveloperSubview) {
    if (!developerModeEnabled) {
      return;
    }

    closePrimaryDialogs();

    setActiveMode('developer');
    setDeveloperSubview(nextSubview);
    setDeveloperRailHidden(false);
    if (nextSubview === 'files') {
      setSelectedFileWorkspaceId(preferredFileWorkspaceId());
    }
  }

  function handleFileWorkspaceChange(nextWorkspaceId: string) {
    setSelectedFileWorkspaceId(nextWorkspaceId);
    setFilePreviewError(null);
  }

  function toggleFileTreeDirectory(workspaceId: string, path: string) {
    setExpandedFileTreePaths((current) => {
      const expandedPaths = current[workspaceId] ?? [];
      const nextExpandedPaths = expandedPaths.includes(path)
        ? expandedPaths.filter((entry) => entry !== path)
        : [...expandedPaths, path];
      return {
        ...current,
        [workspaceId]: nextExpandedPaths,
      };
    });

    const directoryState = currentFileTreeState(workspaceId, path);
    if (directoryState.entries.length === 0 && !directoryState.loading && !directoryState.error) {
      void loadWorkspaceFileTree(workspaceId, path);
    }
  }

  function handleFileTreeSelect(workspaceId: string, path: string) {
    setFilePreviewError(null);
    setSelectedFilePaths((current) => ({
      ...current,
      [workspaceId]: path,
    }));
  }

  function openDeveloperInspector(input: {
    workspaceId: string;
    path: string;
    tab?: DeveloperInspectorTab;
    diffChange?: SessionFileChange | null;
    sourceToken?: string | null;
  }) {
    setDeveloperInspectorWorkspaceId(input.workspaceId);
    setDeveloperInspectorFilePath(input.path);
    setDeveloperInspectorTab(input.tab ?? 'preview');
    setDeveloperInspectorDiffChange(input.diffChange ?? null);
    setDeveloperInspectorOpen(true);
    setDeveloperInspectorError(null);
    setDeveloperInspectorSourceToken(input.sourceToken ?? null);
    setDeveloperInspectorDismissedToken(null);
    void loadDeveloperInspectorPreview(input.workspaceId, input.path);
  }

  function hideDeveloperInspector() {
    setDeveloperInspectorOpen(false);
    setDeveloperInspectorDismissedToken(latestTranscriptFileChangeToken);
  }

  function handleTranscriptFileChangeSelect(change: SessionFileChange) {
    if (detail?.session.sessionType !== 'code') {
      return;
    }

    openDeveloperInspector({
      workspaceId: detail.session.workspaceId,
      path: change.path,
      tab: 'diff',
      diffChange: change,
      sourceToken: latestTranscriptFileChangeToken,
    });
  }

  async function refreshCurrentSelection(sessionId = selectedSessionId) {
    const nextBootstrap = await refreshBootstrapState();
    if (!nextBootstrap) {
      return;
    }
    const nextMode = pickDefaultMode(nextBootstrap, activeMode);
    const shouldLoadChatBootstrap = nextMode === 'chat' && derivedAvailableModes(nextBootstrap).includes('chat');
    const nextChatBootstrap = shouldLoadChatBootstrap ? await fetchChatBootstrap() : null;
    setChatBootstrap(nextChatBootstrap);

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
      : sortChatConversationsForRail(normalizedChatConversations(nextChatBootstrap), chatCompletionMarkers);
    const nextSelectedSessionId = sessionId && candidates.some((entry) => entry.id === sessionId)
      ? sessionId
      : pickPreferredSessionId(candidates);
    setSelectedSessionId(nextSelectedSessionId);
    if (nextSelectedSessionId) {
      setDetail(
        nextMode === 'chat'
          ? chatDetailToSessionDetail(await fetchChatConversationDetail(nextSelectedSessionId))
          : await fetchCodingSessionDetail(nextSelectedSessionId),
      );
    } else {
      setDetail(null);
    }
  }

  async function materializeOptimisticChatConversation(sessionId: string) {
    if (!isOptimisticSessionId(sessionId)) {
      return sessionId;
    }

    const optimisticConversation = (
      detail?.session.sessionType === 'chat' && detail.session.id === sessionId
        ? detail.session
        : optimisticConversations.find((session) => session.id === sessionId)
    ) ?? null;

    if (!optimisticConversation) {
      throw new Error(copy.createSession);
    }

    const conversation = await createChatConversation({
      ...(optimisticConversation.autoTitle ? {} : { title: optimisticConversation.title }),
      executor: optimisticConversation.executor,
      ...(optimisticConversation.model ? { model: optimisticConversation.model } : {}),
      ...(optimisticConversation.reasoningEffort ? { reasoningEffort: optimisticConversation.reasoningEffort } : {}),
      ...(optimisticConversation.rolePresetId ? { rolePresetId: optimisticConversation.rolePresetId } : {}),
    });

    setOptimisticConversations((current) => current.filter((session) => session.id !== sessionId));
    setChatBootstrap((current) => {
      if (!current) {
        return current;
      }
      return {
        ...current,
        conversations: [
          {
            ...conversation,
            lastUpdate: current.conversations.find((entry) => entry.id === conversation.id)?.lastUpdate ?? conversation.updatedAt,
          },
          ...current.conversations.filter((entry) => entry.id !== conversation.id),
        ],
      };
    });
    migratePromptDraft(
      composerDraftKey('chat', sessionId),
      composerDraftKey('chat', conversation.id),
    );
    setSelectedSessionId(conversation.id);
    setDetail(optimisticDetail(chatConversationToConversationSummary(conversation)));
    return conversation.id;
  }

  function clearPromptCompositionResetTimer() {
    if (promptCompositionResetTimerRef.current) {
      window.clearTimeout(promptCompositionResetTimerRef.current);
      promptCompositionResetTimerRef.current = null;
    }
  }

  function clearActivityTickerTimer() {
    if (activityTickerTimerRef.current) {
      window.clearTimeout(activityTickerTimerRef.current);
      activityTickerTimerRef.current = null;
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
      const next = activeMode === 'chat'
        ? await fetchChatConversationTranscript(currentSessionId, {
            limit: TRANSCRIPT_PAGE_SIZE,
            before: transcriptNextCursor,
          })
        : await fetchCodingSessionTranscript(currentSessionId, {
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

  async function handleCreateWorkspaceSession(targetWorkspace?: WorkspaceSummary | null) {
    if (!bootstrap) return;

    const workspace = targetWorkspace
      ?? selectedWorkspace
      ?? visibleWorkspaces[0]
      ?? developerWorkspaceOptions[0]
      ?? null;
    if (!workspace) {
      setError(language === 'zh' ? '请先创建一个 Workspace。' : 'Create a workspace first.');
      return;
    }

    setBusy('create-session');
    const previousSelectedSessionId = selectedSessionId;
    const previousSelectedWorkspaceId = selectedWorkspaceId;
    let optimisticId: string | null = null;
    try {
      optimisticId = `${OPTIMISTIC_SESSION_PREFIX}${Date.now()}`;
      const now = new Date().toISOString();
      const executorModels = codingModelsForExecutor(bootstrap, draftCodingExecutor);
      const defaultModel = executorModels.find((entry) => entry.isDefault)
        ?? executorModels[0]
        ?? null;
      const optimisticTitle = nextCodingSessionTitle(allSessions, workspace.id);
      setExpandedWorkspaceIds((current) => mergeWorkspaceIds(current, workspace.id));
      const optimisticSession: SessionSummary = {
        id: optimisticId,
        ownerUserId: bootstrap.currentUser.id,
        ownerUsername: bootstrap.currentUser.username,
        sessionType: 'code',
        executor: draftCodingExecutor,
        workspaceId: workspace.id,
        threadId: optimisticId,
        activeTurnId: null,
        title: optimisticTitle,
        autoTitle: true,
        workspace: workspace.path,
        archivedAt: null,
        securityProfile: 'repo-write',
        approvalMode: 'detailed',
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
        pendingApprovalCount: 0,
      };
      setOptimisticSessions((current) => [optimisticSession, ...current]);
      setSelectedWorkspaceId(workspace.id);
      setSelectedSessionId(optimisticId);
      setSessionMenuSessionId(null);

      const session = await createCodingWorkspaceSession(workspace.id, {
        executor: draftCodingExecutor,
        securityProfile: 'repo-write',
      });
      setOptimisticSessions((current) => current.filter((entry) => entry.id !== optimisticId));
      setOptimisticConversations((current) => current.filter((entry) => entry.id !== optimisticId));
      setBootstrap((current) => {
        if (!current) return current;
        return {
          ...current,
          sessions: [
            toSessionSummary(session, current.sessions.find((entry) => entry.id === session.id) ?? null),
            ...current.sessions.filter((entry) => entry.id !== session.id),
          ],
        };
      });
      setSelectedWorkspaceId(session.workspaceId);
      setExpandedWorkspaceIds((current) => mergeWorkspaceIds(current, session.workspaceId));
      setSelectedSessionId(session.id);
      await refreshCurrentSelection(session.id);
      setError(null);
    } catch (createError) {
      if (optimisticId) {
        setOptimisticSessions((current) => current.filter((entry) => entry.id !== optimisticId));
        setOptimisticConversations((current) => current.filter((entry) => entry.id !== optimisticId));
      }
      setSelectedSessionId(previousSelectedSessionId);
      setSelectedWorkspaceId(previousSelectedWorkspaceId);
      setError(createError instanceof Error ? createError.message : copy.createSession);
    } finally {
      setBusy(null);
    }
  }

  async function persistWorkspaceLayout(nextWorkspaces: WorkspaceSummary[], previousBootstrap: BootstrapPayload | null) {
    invalidateBootstrapRefreshes();
    setBootstrapWorkspaces(nextWorkspaces);
    setWorkspaceLayoutSaving(true);
    try {
      const changedWorkspaces = nextWorkspaces.filter((workspace) => {
        if (workspace.id.startsWith(OPTIMISTIC_WORKSPACE_PREFIX)) {
          return false;
        }
        const previousWorkspace = allWorkspaces.find((entry) => entry.id === workspace.id);
        return !previousWorkspace
          || previousWorkspace.visible !== workspace.visible;
      });

      await Promise.all(changedWorkspaces.map((workspace) => (
        updateCodingWorkspace(workspace.id, {
          visible: workspace.visible,
        })
      )));
      const persistedWorkspaceIds = normalizeWorkspaceLayoutOrder(nextWorkspaces)
        .map((workspace) => workspace.id)
        .filter((workspaceId) => !workspaceId.startsWith(OPTIMISTIC_WORKSPACE_PREFIX));
      if (persistedWorkspaceIds.length > 0) {
        const response = await reorderCodingWorkspaces({
          workspaceIds: persistedWorkspaceIds,
        });
        setBootstrap((current) => (
          current
            ? {
                ...current,
                workspaceRoot: response.workspaceRoot,
                workspaces: sortWorkspaceSummaries(response.workspaces),
              }
            : current
        ));
      }
    } catch (workspaceError) {
      setBootstrap(previousBootstrap);
      setError(workspaceError instanceof Error ? workspaceError.message : copy.editWorkspaces);
    } finally {
      setWorkspaceLayoutSaving(false);
    }
  }

  async function handleCreateWorkspace(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!bootstrap) return;

    const nextName = workspaceDraftName.trim();
    const nextGitUrl = workspaceDraftGitUrl.trim();
    if (workspaceDraftSource === 'empty' && !nextName) {
      setError(language === 'zh' ? 'Workspace 名称是必填项。' : 'Workspace name is required.');
      return;
    }
    if (workspaceDraftSource === 'git' && !nextGitUrl) {
      setError(language === 'zh' ? 'Git 仓库地址是必填项。' : 'Git repository URL is required.');
      return;
    }

    setBusy('create-workspace');
    try {
      const { workspaceRoot, workspaces, workspace } = await createCodingWorkspace({
        source: workspaceDraftSource,
        ...(workspaceDraftSource === 'empty'
          ? { name: nextName }
          : { gitUrl: nextGitUrl }),
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
      setWorkspaceDraftGitUrl('');
      setWorkspaceDraftSource('empty');
      setWorkspaceModalMode(null);
      setError(null);
    } catch (workspaceError) {
      setError(workspaceError instanceof Error ? workspaceError.message : copy.createWorkspaceAction);
    } finally {
      setBusy(null);
    }
  }

  async function handleToggleWorkspaceVisibility(workspaceId: string) {
    const previousBootstrap = bootstrap;
    const nextWorkspaces = normalizeWorkspaceLayoutOrder(allWorkspaces.map((workspace) => (
      workspace.id === workspaceId
        ? {
            ...workspace,
            visible: !workspace.visible,
          }
        : workspace
    )));

    await persistWorkspaceLayout(nextWorkspaces, previousBootstrap);
  }

  function clearWorkspaceDragState() {
    dragWorkspaceIdRef.current = null;
    setDragWorkspaceId(null);
    setWorkspaceDropIndicator(null);
  }

  function workspaceDropPositionFromEvent(event: ReactDragEvent<HTMLElement>): WorkspaceDropPosition {
    const bounds = event.currentTarget.getBoundingClientRect();
    return event.clientY - bounds.top < bounds.height / 2 ? 'before' : 'after';
  }

  function maybeAutoScrollWorkspaceRail(clientY: number) {
    const railBody = workspaceRailBodyRef.current;
    if (!railBody || !dragWorkspaceIdRef.current) {
      return;
    }

    const bounds = railBody.getBoundingClientRect();
    const threshold = 56;
    const maxStep = 28;
    if (clientY < bounds.top + threshold) {
      const intensity = Math.min(1, (bounds.top + threshold - clientY) / threshold);
      railBody.scrollTop -= Math.max(12, Math.ceil(maxStep * intensity));
      return;
    }
    if (clientY > bounds.bottom - threshold) {
      const intensity = Math.min(1, (clientY - (bounds.bottom - threshold)) / threshold);
      railBody.scrollTop += Math.max(12, Math.ceil(maxStep * intensity));
    }
  }

  async function handleWorkspaceDrop(targetWorkspaceId: string, position: WorkspaceDropPosition) {
    const activeDragWorkspaceId = dragWorkspaceIdRef.current;
    if (!activeDragWorkspaceId || activeDragWorkspaceId === targetWorkspaceId) {
      clearWorkspaceDragState();
      return;
    }

    const previousBootstrap = bootstrap;
    const reordered = [...editableVisibleWorkspaces];
    const draggedWorkspace = reordered.find((workspace) => workspace.id === activeDragWorkspaceId);
    if (!draggedWorkspace) {
      clearWorkspaceDragState();
      return;
    }
    const remaining = reordered.filter((workspace) => workspace.id !== activeDragWorkspaceId);
    const targetIndex = remaining.findIndex((workspace) => workspace.id === targetWorkspaceId);
    if (targetIndex === -1) {
      clearWorkspaceDragState();
      return;
    }
    const insertIndex = position === 'after' ? targetIndex + 1 : targetIndex;
    remaining.splice(insertIndex, 0, draggedWorkspace);
    const normalizedVisible = remaining.map((entry, index) => ({
      ...entry,
      sortOrder: index,
    }));
    const visibleMap = new Map(normalizedVisible.map((entry) => [entry.id, entry]));
    const nextWorkspaces = normalizeWorkspaceLayoutOrder(
      allWorkspaces.map((entry) => visibleMap.get(entry.id) ?? entry),
    );

    clearWorkspaceDragState();
    await persistWorkspaceLayout(nextWorkspaces, previousBootstrap);
  }

  function handleCreateConversation() {
    if (!bootstrap) return;

    const optimisticId = `${OPTIMISTIC_SESSION_PREFIX}${Date.now()}`;
    const now = new Date().toISOString();
    const ownerRoot = normalizeWorkspaceSegment(
      bootstrap.currentUser.username,
      `user-${bootstrap.currentUser.id.slice(0, 8)}`,
    );
    const executorModels = codingModelsForExecutor(bootstrap, draftCodingExecutor);
    const defaultModel = executorModels.find((entry) => entry.isDefault)
      ?? executorModels[0]
      ?? null;
    const optimisticWorkspace = `${bootstrap.workspaceRoot}/${ownerRoot}/chat`;
    const optimisticConversation: ConversationSummary = {
      id: optimisticId,
      ownerUserId: bootstrap.currentUser.id,
      ownerUsername: bootstrap.currentUser.username,
      sessionType: 'chat',
      executor: draftCodingExecutor,
      threadId: optimisticId,
      activeTurnId: null,
      title: 'New chat',
      autoTitle: true,
      workspace: optimisticWorkspace,
      archivedAt: null,
      securityProfile: 'repo-write',
      approvalMode: 'detailed',
      networkEnabled: false,
      fullHostEnabled: false,
      status: 'idle',
      uiStatus: 'new',
      lastIssue: null,
      hasTranscript: false,
      model: defaultModel?.model ?? null,
      reasoningEffort: preferredReasoningEffort(defaultModel),
      rolePresetId: chatBootstrap?.defaults.rolePresetId ?? null,
      recoveryState: 'ready',
      retryable: false,
      createdAt: now,
      updatedAt: now,
      lastUpdate: copy.creating,
    };

    setOptimisticConversations((current) => [optimisticConversation, ...current]);
    setSessionMenuSessionId(null);
    setRailDeleteConfirmId(null);
    setSelectedSessionId(optimisticId);
    setDetail(optimisticDetail(optimisticConversation));
    setTranscriptItems([]);
    setTranscriptNextCursor(null);
    setTranscriptLoadedOlder(false);
    window.setTimeout(() => {
      promptTextareaRef.current?.focus();
    }, 0);
  }

  async function handleAttachmentSelection(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files ?? []);
    event.target.value = '';
    if (files.length === 0) return;
    await uploadDraftFiles(files);
  }

  async function uploadDraftFiles(files: File[]) {
    if (
      !selectedSessionId
      || files.length === 0
      || (sessionHasActiveTurn && (activeMode === 'chat' || detail?.session.sessionType !== 'code'))
      || busy === 'upload-attachment'
      || busy === 'start-turn'
      || Boolean(activeApproval)
      || (selectedSessionIsOptimistic && !sessionIsChat)
    ) {
      return;
    }

    setBusy('upload-attachment');
    try {
      const targetSessionId = activeMode === 'chat'
        ? await materializeOptimisticChatConversation(selectedSessionId)
        : selectedSessionId;
      for (const [index, file] of files.entries()) {
        const nextFile = normalizeClipboardFile(file, index);
        if (activeMode === 'chat') {
          await uploadChatAttachment(targetSessionId, nextFile);
        } else {
          await uploadCodingAttachment(targetSessionId, nextFile);
        }
      }
      await refreshCurrentSelection(targetSessionId);
      setError(null);
    } catch (uploadError) {
      setError(uploadError instanceof Error ? uploadError.message : copy.attachFiles);
    } finally {
      setBusy(null);
    }
  }

  function handleComposerPaste(event: ReactClipboardEvent<HTMLTextAreaElement>) {
    const files = Array.from(event.clipboardData.items)
      .map((item) => item.kind === 'file' ? item.getAsFile() : null)
      .filter((file): file is File => file !== null && file.size > 0);

    if (files.length === 0) {
      return;
    }

    event.preventDefault();
    void uploadDraftFiles(files);
  }

  async function handleRemoveDraftAttachment(attachment: SessionAttachmentSummary) {
    if (!selectedSessionId) return;
    setBusy(`remove-attachment-${attachment.id}`);
    try {
      if (activeMode === 'chat') {
        await deleteChatAttachment(selectedSessionId, attachment.id);
      } else {
        await deleteCodingAttachment(selectedSessionId, attachment.id);
      }
      await refreshCurrentSelection(selectedSessionId);
      setError(null);
    } catch (removeError) {
      setError(removeError instanceof Error ? removeError.message : copy.removeAttachment);
    } finally {
      setBusy(null);
    }
  }

  async function handleRemoveQueuedTurn(queuedTurnId: string) {
    if (!selectedSessionId || activeMode !== 'developer') return;
    setBusy(`remove-queued-turn-${queuedTurnId}`);
    try {
      await deleteQueuedCodingTurn(selectedSessionId, queuedTurnId);
      await refreshCurrentSelection(selectedSessionId);
      setError(null);
    } catch (removeError) {
      setError(removeError instanceof Error ? removeError.message : copy.removeQueuedTurn);
    } finally {
      setBusy(null);
    }
  }

  function closeAttachmentPreview() {
    attachmentPreviewRequestRef.current += 1;
    setAttachmentPreviewTarget(null);
    setAttachmentPreviewResourceState(null);
    setAttachmentPreviewLoading(false);
    setAttachmentPreviewError(null);
  }

  async function handleOpenAttachmentPreview(attachment: SessionAttachmentSummary) {
    const requestId = attachmentPreviewRequestRef.current + 1;
    attachmentPreviewRequestRef.current = requestId;
    setAttachmentPreviewTarget(attachment);
    setAttachmentPreviewResourceState(null);
    setAttachmentPreviewError(null);
    setAttachmentPreviewLoading(true);

    try {
      if (attachment.kind === 'image' || attachment.kind === 'pdf') {
        if (attachmentPreviewRequestRef.current !== requestId) {
          return;
        }
        setAttachmentPreviewResourceState(attachmentPreviewResource(attachment));
        return;
      }

      if (!isLikelyTextAttachment(attachment)) {
        if (attachmentPreviewRequestRef.current !== requestId) {
          return;
        }
        setAttachmentPreviewResourceState(attachmentPreviewResource(attachment));
        return;
      }

      const response = await fetch(attachmentInlineHref(attachment));
      if (!response.ok) {
        const errorBody = await response.json().catch(() => null) as { error?: string } | null;
        throw new Error(errorBody?.error ?? `${attachment.filename} failed with status ${response.status}`);
      }

      const content = await response.text();
      if (attachmentPreviewRequestRef.current !== requestId) {
        return;
      }
      setAttachmentPreviewResourceState(attachmentPreviewResource(attachment, {
        content,
        previewable: true,
      }));
    } catch (previewError) {
      if (attachmentPreviewRequestRef.current !== requestId) {
        return;
      }
      setAttachmentPreviewError(previewError instanceof Error ? previewError.message : copy.unknownError);
    } finally {
      if (attachmentPreviewRequestRef.current === requestId) {
        setAttachmentPreviewLoading(false);
      }
    }
  }

  async function handleChatMarkdownLinkClick(rawHref: string) {
    if (detail?.session.sessionType !== 'chat' || !selectedSessionId) {
      return;
    }

    try {
      const conversationId = await materializeOptimisticChatConversation(selectedSessionId);
      const resolution = await resolveChatBodyLink(conversationId, rawHref);
      if (resolution.kind === 'attachment') {
        await handleOpenAttachmentPreview(resolution.attachment);
        return;
      }

      const externalHref = resolution.href.startsWith('/api/')
        ? apiHref(resolution.href)
        : resolution.href;
      window.open(externalHref, '_blank', 'noopener,noreferrer');
    } catch (resolveError) {
      setError(resolveError instanceof Error ? resolveError.message : copy.unknownError);
    }
  }

  function renderMarkdown(
    body: string,
    options?: {
      onLinkClick?: (href: string) => void | Promise<void>;
    },
  ) {
    return (
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          pre: ({ children }) => (
            <MarkdownCodeBlock language={language}>
              {children}
            </MarkdownCodeBlock>
          ),
          a: ({ node: _node, href, children, ...props }) => {
            const rawHref = typeof href === 'string' ? href : '';
            const shouldIntercept = Boolean(options?.onLinkClick && rawHref && shouldResolveChatMarkdownLink(rawHref));
            return (
              <a
                {...props}
                href={href}
                onClick={(event) => {
                  if (!shouldIntercept || isModifiedPrimaryClick(event)) {
                    return;
                  }
                  event.preventDefault();
                  void options?.onLinkClick?.(rawHref);
                }}
              >
                {children}
              </a>
            );
          },
        }}
      >
        {body}
      </ReactMarkdown>
    );
  }

  async function submitPrompt() {
    if (!selectedSessionId || busy === 'stop-session') return;
    if (sessionHasActiveTurn && (activeMode === 'chat' || detail?.session.sessionType !== 'code')) return;
    const trimmedPrompt = prompt.trim();
    if (!trimmedPrompt && draftAttachments.length === 0) return;

    setBusy('start-turn');
    try {
      shouldStickTranscriptToBottomRef.current = true;
      const targetSessionId = activeMode === 'chat'
        ? await materializeOptimisticChatConversation(selectedSessionId)
        : selectedSessionId;
      if (activeMode === 'chat') {
        await sendChatMessage(targetSessionId, {
          ...(trimmedPrompt ? { prompt: trimmedPrompt } : {}),
          ...(draftAttachments.length > 0 ? { attachmentIds: draftAttachments.map((attachment) => attachment.id) } : {}),
        });
      } else {
        await startCodingTurn(targetSessionId, {
          ...(trimmedPrompt ? { prompt: trimmedPrompt } : {}),
          ...(draftAttachments.length > 0 ? { attachmentIds: draftAttachments.map((attachment) => attachment.id) } : {}),
        });
      }
      updatePromptDraft(composerDraftKey(activeMode, targetSessionId), '');
      await refreshCurrentSelection(targetSessionId);
      setError(null);
    } catch (turnError) {
      setError(turnError instanceof Error ? turnError.message : copy.sendPrompt);
    } finally {
      setBusy(null);
    }
  }

  async function handleStartTurn(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (sessionHasActiveTurn && (activeMode === 'chat' || detail?.session.sessionType !== 'code')) return;
    await submitPrompt();
  }

  function handlePromptKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (shouldIgnorePromptEnter(event)) return;
    if (event.key !== 'Enter' || event.shiftKey) return;
    event.preventDefault();
    if (
      busy === 'start-turn'
      || busy === 'stop-session'
      || (detail?.session.activeTurnId && (activeMode === 'chat' || detail.session.sessionType !== 'code'))
    ) {
      return;
    }
    void submitPrompt();
  }

  async function handleStopActiveTurn() {
    if (!selectedSessionId || selectedSessionIsOptimistic) return;
    setBusy('stop-session');
    try {
      if (activeMode === 'chat') {
        await stopChatConversation(selectedSessionId);
      } else {
        await stopCodingSession(selectedSessionId);
      }
      await refreshCurrentSelection(selectedSessionId);
      setError(null);
    } catch (stopError) {
      setError(stopError instanceof Error ? stopError.message : copy.stop);
    } finally {
      setBusy(null);
    }
  }

  async function handleSessionPreferencesChange(
    nextModel: string,
    nextEffort: ReasoningEffort,
    nextApprovalMode: ApprovalMode,
    nextExecutor?: AgentExecutor,
  ) {
    if (!selectedSessionId || !detail) return;
    setBusy('update-session-preferences');
    const previousBootstrap = bootstrap;
    const previousChatBootstrap = chatBootstrap;
    const previousDetail = detail;
    const previousDraftExecutor = draftCodingExecutorState;
    const previousModel = detail.session.model ?? currentSessionModelOption?.model ?? '';
    const previousEffort = detail.session.reasoningEffort ?? preferredReasoningEffort(currentSessionModelOption);
    const previousApprovalMode = detail.session.approvalMode;
    const targetExecutor = nextExecutor ?? detail.session.executor;
    const now = new Date().toISOString();
    const optimisticSession = {
      ...detail.session,
      executor: targetExecutor,
      model: nextModel,
      reasoningEffort: nextEffort,
      approvalMode: detail.session.sessionType === 'code' ? nextApprovalMode : detail.session.approvalMode,
      updatedAt: now,
    };

    if (detail.session.sessionType === 'chat') {
      setChatBootstrap((current) => (
        current
          ? {
              ...current,
              conversations: current.conversations.map((conversation) => (
                conversation.id === optimisticSession.id
                  ? {
                      ...conversation,
                      executor: targetExecutor,
                      model: nextModel,
                      reasoningEffort: nextEffort,
                      updatedAt: now,
                      lastUpdate: conversation.lastUpdate,
                    }
                  : conversation
              )),
            }
          : current
      ));
      setOptimisticConversations((current) => (
        current.map((conversation) => (
            conversation.id === optimisticSession.id
              ? {
                  ...conversation,
                  executor: targetExecutor,
                  model: nextModel,
                  reasoningEffort: nextEffort,
                  updatedAt: now,
              }
            : conversation
        ))
      ));
      setDetail((current) => (
        current && current.session.id === optimisticSession.id
          ? {
              ...current,
              session: optimisticSession,
            }
          : current
      ));

      if (isOptimisticSessionId(selectedSessionId)) {
        setDraftCodingExecutorState(targetExecutor);
        setError(null);
        setBusy(null);
        return;
      }

      try {
        const nextConversation = await updateChatConversationPreferences(selectedSessionId, {
          executor: targetExecutor,
          model: nextModel,
          reasoningEffort: nextEffort,
        });
        setDraftCodingExecutorState(nextConversation.executor);
        setChatBootstrap((current) => (
          current
            ? {
                ...current,
                conversations: current.conversations.map((conversation) => (
                  conversation.id === nextConversation.id
                    ? {
                        ...conversation,
                        ...nextConversation,
                        lastUpdate: conversation.lastUpdate,
                      }
                    : conversation
                )),
              }
            : current
        ));
        setDetail((current) => (
          current && current.session.id === nextConversation.id
            ? {
                ...current,
                session: chatConversationToConversationSummary(nextConversation),
              }
            : current
        ));
        setError(null);
      } catch (preferencesError) {
        setBootstrap(previousBootstrap);
        setChatBootstrap(previousChatBootstrap);
        setDetail(previousDetail);
        setDraftCodingExecutorState(previousDraftExecutor);
        setSessionModel(previousModel);
        setSessionEffort(previousEffort);
        setSessionApprovalMode(previousApprovalMode);
        setError(preferencesError instanceof Error ? preferencesError.message : copy.settings);
      } finally {
        setBusy(null);
      }
      return;
    }

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
    setDraftCodingExecutorState(targetExecutor);
    try {
      const nextPreferences = detail.session.sessionType === 'code'
        ? {
            executor: targetExecutor ?? detail.session.executor,
            model: nextModel,
            reasoningEffort: nextEffort,
            approvalMode: nextApprovalMode,
          }
        : {
            model: nextModel,
            reasoningEffort: nextEffort,
          };
      const nextSession = await updateCodingSessionPreferences(selectedSessionId, nextPreferences);
      setDraftCodingExecutorState(nextSession.executor);
      setBootstrap((current) => (
        current
          ? {
              ...current,
              sessions: current.sessions.map((session) => (
                session.id === nextSession.id
                  ? toSessionSummary(nextSession, session)
                  : session
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
      setChatBootstrap(previousChatBootstrap);
      setDetail(previousDetail);
      setDraftCodingExecutorState(previousDraftExecutor);
      setSessionModel(previousModel);
      setSessionEffort(previousEffort);
      setSessionApprovalMode(previousApprovalMode);
      setError(preferencesError instanceof Error ? preferencesError.message : copy.settings);
    } finally {
      setBusy(null);
    }
  }

  function handleSessionExecutorChange(nextExecutorValue: string) {
    if (!detail || sessionHasActiveTurn) return;
    const nextExecutor = nextExecutorValue === 'claude-code' ? 'claude-code' : 'codex';
    if (nextExecutor === detail.session.executor) return;

    const executorModels = codingModelsForExecutor(bootstrap, nextExecutor);
    const nextModelOption = executorModels.find((entry) => entry.model === sessionModel)
      ?? executorModels.find((entry) => entry.model === detail.session.model)
      ?? executorModels.find((entry) => entry.isDefault)
      ?? executorModels[0]
      ?? null;
    if (!nextModelOption) return;

    const nextEffort = nextModelOption.supportedReasoningEfforts.includes(sessionEffort)
      ? sessionEffort
      : preferredReasoningEffort(nextModelOption);

    setSessionModel(nextModelOption.model);
    setSessionEffort(nextEffort);
    void handleSessionPreferencesChange(nextModelOption.model, nextEffort, sessionApprovalMode, nextExecutor);
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

  function handleSessionModeChange(nextMode: string) {
    if (!detail || detail.session.sessionType !== 'code') return;
    if (nextMode !== 'detailed' && nextMode !== 'less-interruption' && nextMode !== 'full-auto') return;
    handleSessionApprovalModeChange(nextMode as ApprovalMode);
  }

  async function handleChatRolePresetChange(nextRolePresetValue: string) {
    if (!selectedSessionId || !detail || detail.session.sessionType !== 'chat') return;
    setSessionRolePresetId(nextRolePresetValue);
    setBusy('update-session-preferences');
    const previousChatBootstrap = chatBootstrap;
    const previousDetail = detail;
    const previousRolePresetId = detail.session.rolePresetId ?? '';
    const now = new Date().toISOString();
    const nextRolePresetId = nextRolePresetValue || null;

    setChatBootstrap((current) => (
      current
        ? {
            ...current,
            conversations: current.conversations.map((conversation) => (
              conversation.id === detail.session.id
                ? {
                    ...conversation,
                    rolePresetId: nextRolePresetId,
                    updatedAt: now,
                  }
                : conversation
            )),
          }
        : current
    ));
    setOptimisticConversations((current) => (
      current.map((conversation) => (
        conversation.id === detail.session.id
          ? {
              ...conversation,
              rolePresetId: nextRolePresetId,
              updatedAt: now,
            }
          : conversation
      ))
    ));
    setDetail((current) => (
      current && current.session.id === detail.session.id
        ? {
            ...current,
            session: {
              ...current.session,
              rolePresetId: nextRolePresetId,
              updatedAt: now,
            },
          }
        : current
    ));

    if (isOptimisticSessionId(selectedSessionId)) {
      setError(null);
      setBusy(null);
      return;
    }

    try {
      const nextConversation = await updateChatConversationPreferences(selectedSessionId, {
        rolePresetId: nextRolePresetId,
      });
      setChatBootstrap((current) => (
        current
          ? {
              ...current,
              conversations: current.conversations.map((conversation) => (
                conversation.id === nextConversation.id
                  ? {
                      ...conversation,
                      ...nextConversation,
                      lastUpdate: conversation.lastUpdate,
                    }
                  : conversation
              )),
            }
          : current
      ));
      setDetail((current) => (
        current && current.session.id === nextConversation.id
          ? {
              ...current,
              session: chatConversationToConversationSummary(nextConversation),
            }
          : current
      ));
      setError(null);
    } catch (preferencesError) {
      setChatBootstrap(previousChatBootstrap);
      setDetail(previousDetail);
      setSessionRolePresetId(previousRolePresetId);
      setError(preferencesError instanceof Error ? preferencesError.message : copy.settings);
    } finally {
      setBusy(null);
    }
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
    const previousChatBootstrap = chatBootstrap;
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

    if (detail.session.sessionType === 'chat') {
      setChatBootstrap((current) => (
        current
          ? {
              ...current,
              conversations: current.conversations.map((conversation) => (
                conversation.id === optimisticSession.id
                  ? {
                      ...conversation,
                      title: nextTitle,
                      autoTitle: false,
                      updatedAt: now,
                      lastUpdate: conversation.lastUpdate,
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
        const nextConversation = await updateChatConversation(inlineRenameSessionId, {
          title: nextTitle,
        });
        setChatBootstrap((current) => (
          current
            ? {
                ...current,
                conversations: current.conversations.map((conversation) => (
                  conversation.id === nextConversation.id
                    ? {
                        ...conversation,
                        ...nextConversation,
                        lastUpdate: conversation.lastUpdate,
                      }
                    : conversation
                )),
              }
            : current
        ));
        setDetail((current) => (
          current && current.session.id === nextConversation.id
            ? {
                ...current,
                session: chatConversationToConversationSummary(nextConversation),
              }
            : current
        ));
        setError(null);
      } catch (saveError) {
        setBootstrap(previousBootstrap);
        setChatBootstrap(previousChatBootstrap);
        setDetail(previousDetail);
        setError(saveError instanceof Error ? saveError.message : copy.rename);
      } finally {
        setBusy(null);
      }
      return;
    }

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
      const nextSession = await updateCodingSession(inlineRenameSessionId, {
        title: nextTitle,
      });
      setBootstrap((current) => (
        current
          ? {
              ...current,
              sessions: current.sessions.map((session) => (
                session.id === nextSession.id
                  ? toSessionSummary(nextSession, session)
                  : session
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
      setChatBootstrap(previousChatBootstrap);
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
    const previousChatBootstrap = chatBootstrap;
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

      if (detail.session.sessionType === 'chat') {
        setChatBootstrap((current) => (
          current
            ? {
                ...current,
                conversations: current.conversations.map((conversation) => (
                  conversation.id === optimisticSession.id
                    ? {
                        ...conversation,
                        title: editTitle,
                        autoTitle: false,
                        updatedAt: now,
                        lastUpdate: conversation.lastUpdate,
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

        const nextConversation = await updateChatConversation(editSessionId, {
          title: editTitle,
        });
        setChatBootstrap((current) => (
          current
            ? {
                ...current,
                conversations: current.conversations.map((conversation) => (
                  conversation.id === nextConversation.id
                    ? {
                        ...conversation,
                        ...nextConversation,
                        lastUpdate: conversation.lastUpdate,
                      }
                    : conversation
                )),
              }
            : current
        ));
        setDetail((current) => (
          current && current.session.id === nextConversation.id
            ? {
                ...current,
                session: chatConversationToConversationSummary(nextConversation),
              }
            : current
        ));
        setError(null);
        return;
      }

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

      const nextSession = await updateCodingSession(editSessionId, sessionUpdate);
      setBootstrap((current) => (
        current
          ? {
              ...current,
              sessions: current.sessions.map((session) => (
                session.id === nextSession.id
                  ? toSessionSummary(nextSession, session)
                  : session
              )),
            }
          : current
      ));
      setSelectedWorkspaceId(nextSession.workspaceId);
      setExpandedWorkspaceIds((current) => mergeWorkspaceIds(current, nextSession.workspaceId));
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
      setChatBootstrap(previousChatBootstrap);
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
          uiStatus: 'processing',
          lastIssue: null,
          hasTranscript: false,
          recoveryState: 'ready',
          retryable: false,
          createdAt: now,
          updatedAt: now,
          lastUpdate: copy.forking,
        };
        setOptimisticConversations((current) => [optimisticConversation, ...current]);
      }

      if (session.sessionType === 'chat') {
        const nextConversation = await forkChatConversation(session.id);
        if (optimisticId) {
          setOptimisticConversations((current) => current.filter((entry) => entry.id !== optimisticId));
        }
        setChatBootstrap((current) => (
          current
            ? {
                ...current,
                conversations: [
                  {
                    ...nextConversation,
                    lastUpdate: current.conversations.find((entry) => entry.id === nextConversation.id)?.lastUpdate ?? nextConversation.updatedAt,
                  },
                  ...current.conversations.filter((entry) => entry.id !== nextConversation.id),
                ],
              }
            : current
        ));
        setSelectedWorkspaceId(null);
        setSelectedSessionId(nextConversation.id);
        await refreshCurrentSelection(nextConversation.id);
        setError(null);
        return;
      }

      const nextSession = await forkCodingSession(session.id);
      if (optimisticId) {
        setOptimisticSessions((current) => current.filter((entry) => entry.id !== optimisticId));
        setOptimisticConversations((current) => current.filter((entry) => entry.id !== optimisticId));
      }
      setBootstrap((current) => (
        current
          ? {
              ...current,
              sessions: [
                toSessionSummary(nextSession, current.sessions.find((entry) => entry.id === nextSession.id) ?? null),
                ...current.sessions.filter((entry) => entry.id !== nextSession.id),
              ],
            }
          : current
      ));
      setSelectedWorkspaceId(nextSession.workspaceId);
      setExpandedWorkspaceIds((current) => mergeWorkspaceIds(current, nextSession.workspaceId));
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
    setRailDeleteConfirmId(null);
    const previousSelectedSessionId = selectedSessionId;
    const previousBootstrap = bootstrap;
    const previousChatBootstrap = chatBootstrap;
    const previousDetail = detail;
    const currentDeveloperSession = allSessions.find((session) => session.id === sessionId) ?? null;
    const deletingConversation = allConversations.some((session) => session.id === sessionId);
    const deletingOptimisticConversation = deletingConversation && isOptimisticSessionId(sessionId);
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
      ? sortChatConversationsForRail(
          allConversations.filter((session) => session.id !== sessionId),
          chatCompletionMarkers,
        )
      : visibleDeveloperSessions.filter((session) => session.id !== sessionId);
    const nextSelectedSessionId = deletingCurrentSession
      ? pickPreferredSessionId(remainingSessions)
      : previousSelectedSessionId;

    setConfirmAction(null);
    if (deletingOptimisticConversation) {
      setOptimisticConversations((current) => current.filter((session) => session.id !== sessionId));
      if (deletingCurrentSession) {
        setSelectedSessionId(nextSelectedSessionId);
        setDetail(null);
      }
      setError(null);
      return;
    }

    setBusy(`delete-${sessionId}`);
    if (deletingConversation) {
      setChatBootstrap((current) => (
        current
          ? {
              ...current,
              conversations: current.conversations.filter((session) => session.id !== sessionId),
            }
          : current
      ));
    } else {
      setBootstrap((current) => (
        current
          ? {
              ...current,
              sessions: current.sessions.filter((session) => session.id !== sessionId),
              approvals: current.approvals.filter((approval) => approval.sessionId !== sessionId),
            }
          : current
      ));
    }

    if (deletingCurrentSession) {
      setSelectedSessionId(nextSelectedSessionId);
      setDetail(null);
    }

    setError(null);

    try {
      if (deletingConversation) {
        await deleteChatConversation(sessionId);
      } else {
        await deleteCodingSession(sessionId);
      }
      void refreshCurrentSelection(nextSelectedSessionId);
      setError(null);
    } catch (deleteError) {
      setBootstrap(previousBootstrap);
      setChatBootstrap(previousChatBootstrap);
      setSelectedSessionId(previousSelectedSessionId);
      setDetail(previousDetail);
      if (previousSelectedSessionId) {
        void refreshCurrentSelection(previousSelectedSessionId);
      }
      setError(deleteError instanceof Error ? deleteError.message : copy.delete);
    } finally {
      setBusy(null);
    }
  }

  async function handleConfirmSessionAction() {
    if (!confirmAction) return;
    void handleDeleteSession(confirmAction.session.id);
  }

  async function handleApprovalAction(
    approval: PendingApproval,
    decision: 'accept' | 'decline',
    scope: 'once' | 'session',
  ) {
    setBusy(approval.id);
    try {
      await resolveCodingApproval(approval.sessionId, approval.id, { decision, scope });
      await refreshCurrentSelection(approval.sessionId);
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

  function beginCreateChatRolePreset() {
    setEditingChatRolePresetId(null);
    setChatRolePresetForm({
      ...defaultChatRolePresetForm(),
      isDefault: !chatRolePresetList?.defaultRolePresetId,
    });
  }

  function beginEditChatRolePreset(preset: ChatRolePresetDetail) {
    setEditingChatRolePresetId(preset.id);
    setChatRolePresetForm({
      label: preset.label,
      description: preset.description ?? '',
      prompt: preset.prompt,
      isDefault: preset.isDefault,
    });
  }

  function resetChatRolePresetEditor() {
    setEditingChatRolePresetId(null);
    setChatRolePresetForm(defaultChatRolePresetForm());
  }

  async function handleSaveChatRolePreset(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const label = chatRolePresetForm.label.trim();
    const promptText = chatRolePresetForm.prompt.trim();
    if (!label) {
      setError(language === 'zh' ? '预设名称是必填项。' : 'Preset name is required.');
      return;
    }
    if (!promptText) {
      setError(language === 'zh' ? '预设 Prompt 是必填项。' : 'Preset prompt is required.');
      return;
    }

    setBusy('save-chat-role-preset');
    try {
      const nextList = editingChatRolePresetId
        ? await updateChatRolePreset(editingChatRolePresetId, {
            label,
            description: chatRolePresetForm.description.trim() || null,
            prompt: promptText,
            isDefault: chatRolePresetForm.isDefault,
          })
        : await createChatRolePreset({
            label,
            description: chatRolePresetForm.description.trim() || null,
            prompt: promptText,
            isDefault: chatRolePresetForm.isDefault,
          });
      applyChatRolePresetList(nextList);
      resetChatRolePresetEditor();
      setError(null);
    } catch (presetError) {
      setError(presetError instanceof Error ? presetError.message : copy.settings);
    } finally {
      setBusy(null);
    }
  }

  async function handleDeleteChatRolePreset(preset: ChatRolePresetDetail) {
    const confirmed = window.confirm(copy.deleteRolePresetConfirm.replace('{label}', preset.label));
    if (!confirmed) return;

    setBusy(`delete-chat-role-preset-${preset.id}`);
    try {
      const nextList = await deleteChatRolePreset(preset.id);
      applyChatRolePresetList(nextList);
      if (editingChatRolePresetId === preset.id) {
        resetChatRolePresetEditor();
      }
      setError(null);
    } catch (presetError) {
      setError(presetError instanceof Error ? presetError.message : copy.settings);
    } finally {
      setBusy(null);
    }
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
      roles: userRoles,
      canUseFullHost: userRoles.includes('developer') ? user.canUseFullHost : false,
    });
    setUserModalOpen(true);
  }

  async function handleUserSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const roles = orderedUserRoles(userForm.roles);
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
          canUseFullHost: roles.includes('developer') ? userForm.canUseFullHost : false,
        });
        setAdminUsers(response.users);
      } else if (editingUserId) {
        const response = await updateAdminUser(editingUserId, {
          username: userForm.username,
          ...(userForm.password.trim() ? { password: userForm.password } : {}),
          roles,
          preferredMode: roles.includes('developer') ? 'developer' : 'chat',
          canUseFullHost: roles.includes('developer') ? userForm.canUseFullHost : false,
        });
        setAdminUsers(response.users);
        await refreshBootstrapState();
      }
      setUserModalOpen(false);
      setError(null);
    } catch (userError) {
      setError(userError instanceof Error ? userError.message : copy.saveUser);
    } finally {
      setBusy(null);
    }
  }

  async function handleRegenerateUserToken() {
    if (!editingUserId || !editingAdminUser) return;
    const confirmed = window.confirm(copy.regenerateTokenConfirm.replace('{username}', editingAdminUser.username));
    if (!confirmed) return;

    setBusy(`regenerate-token-${editingUserId}`);
    try {
      const response = await updateAdminUser(editingUserId, {
        regenerateToken: true,
      });
      setAdminUsers(response.users);
      await refreshBootstrapState();
    } catch (regenerateError) {
      setError(regenerateError instanceof Error ? regenerateError.message : copy.regenerateToken);
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
      await refreshBootstrapState();
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
    setDetailMenuOpen(false);
    setSessionMenuSessionId(null);
    setRailDeleteConfirmId((current) => current === session.id ? null : current);
    if (isOptimisticSessionId(session.id)) {
      if (session.sessionType === 'chat') {
        setSelectedSessionId(session.id);
      }
      return;
    }
    if (session.sessionType === 'code') {
      setSelectedWorkspaceId(session.workspaceId);
      setExpandedWorkspaceIds((current) => mergeWorkspaceIds(current, session.workspaceId));
    }
    setSelectedSessionId(session.id);
  }

  function renderSessionRailItem(session: SessionSummary | ConversationSummary) {
    const sessionState = deriveSummarySessionState(session, chatCompletionMarkers);
    const sessionPending = isOptimisticSessionId(session.id);
    const isChatConversation = session.sessionType === 'chat';
    const sessionSelected = selectedSessionId === session.id;
    const showInlineDeleteButton = isChatConversation
      ? chatRailEditMode
      : workspaceEditMode && !sessionPending;
    const railDeleteConfirming = showInlineDeleteButton && railDeleteConfirmId === session.id;
    const markerShapeClass = isChatConversation
      ? 'session-node-marker-chat'
      : 'session-node-marker-code';
    const chatLabel = railDeleteConfirming
      ? `${copy.deleteInlineConfirm} · ${session.title}`
      : session.title;
    const handleSessionTrigger = () => {
      if (railDeleteConfirming) {
        setRailDeleteConfirmId(null);
      }
      selectSessionFromRail(session);
    };
    const renderLeading = () => (
      <span className="session-node-leading">
        {showInlineDeleteButton ? (
          <button
            type="button"
            className={`session-inline-delete-button ${isChatConversation ? 'session-inline-delete-button-chat' : 'session-inline-delete-button-code'} ${railDeleteConfirming ? 'session-inline-delete-button-confirm' : ''}`}
            onClick={(event) => {
              event.stopPropagation();
              setDetailMenuOpen(false);
              setSessionMenuSessionId(null);
              if (railDeleteConfirming) {
                void handleDeleteSession(session.id);
                return;
              }
              setRailDeleteConfirmId(session.id);
            }}
            title={railDeleteConfirming ? copy.confirmAction : copy.delete}
            aria-label={railDeleteConfirming ? copy.confirmAction : copy.delete}
            disabled={busy === `delete-${session.id}`}
          >
            {railDeleteConfirming ? <CheckIcon /> : <TrashIcon />}
          </button>
        ) : (
          <span
            className={`session-node-marker session-node-marker-${sessionState} ${markerShapeClass}`}
            style={sessionMarkerStyle(sessionState)}
            aria-hidden="true"
          />
        )}
      </span>
    );

    return (
      <li
        key={session.id}
        className={`session-node ${sessionSelected ? 'session-node-active' : ''} ${sessionPending ? 'session-node-pending' : ''} ${isChatConversation ? 'session-node-chat' : ''} ${railDeleteConfirming ? 'session-node-delete-confirming' : ''}`}
      >
        {isChatConversation || showInlineDeleteButton ? (
          <div
            role="button"
            tabIndex={0}
            className="session-node-trigger session-node-trigger-chat"
            aria-current={sessionSelected ? 'page' : undefined}
            onClick={handleSessionTrigger}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                handleSessionTrigger();
              }
            }}
          >
            <div className="session-node-copy">
              {renderLeading()}
              <span className="session-node-label" title={chatLabel}>{chatLabel}</span>
            </div>
          </div>
        ) : (
          <button
            type="button"
            className="session-node-trigger"
            onClick={handleSessionTrigger}
            disabled={sessionPending}
            aria-current={sessionSelected ? 'page' : undefined}
          >
            <div className="session-node-copy">
              {renderLeading()}
              <span className="session-node-label" title={chatLabel}>{chatLabel}</span>
            </div>
          </button>
        )}
      </li>
    );
  }

  function renderWorkspaceRailItem(workspace: WorkspaceSummary) {
    const workspaceSessions = allSessions.filter((session) => session.workspaceId === workspace.id);
    const workspaceExpanded = expandedWorkspaceIds.includes(workspace.id);
    const workspaceOpen = workspaceExpanded || workspaceEditMode;
    const workspaceSelected = activeMode === 'developer' && selectedWorkspaceId === workspace.id;
    const workspacePending = workspace.id.startsWith(OPTIMISTIC_WORKSPACE_PREFIX);
    const workspaceHidden = !workspace.visible;
    const workspaceDraggable = workspaceEditMode && !workspaceHidden && !workspacePending && !workspaceLayoutSaving;
    const workspaceDragging = dragWorkspaceId === workspace.id;
    const workspaceDropPreview = workspaceDropIndicator?.workspaceId === workspace.id
      ? workspaceDropIndicator.position
      : null;
    const workspaceDropTarget = workspaceDropPreview !== null;

    const renderWorkspaceDropSlot = (position: WorkspaceDropPosition) => {
      if (!workspaceDropTarget || workspaceDropPreview !== position || !dragWorkspaceIdRef.current) {
        return null;
      }

      return (
        <li
          key={`${workspace.id}-${position}-slot`}
          className={`workspace-drop-slot workspace-drop-slot-${position}`}
          onDragOver={(event: ReactDragEvent<HTMLLIElement>) => {
            if (!dragWorkspaceIdRef.current) return;
            event.preventDefault();
            event.dataTransfer.dropEffect = 'move';
            maybeAutoScrollWorkspaceRail(event.clientY);
            setWorkspaceDropIndicator((current) => (
              current?.workspaceId === workspace.id && current.position === position
                ? current
                : { workspaceId: workspace.id, position }
            ));
          }}
          onDrop={(event: ReactDragEvent<HTMLLIElement>) => {
            if (!dragWorkspaceIdRef.current) return;
            event.preventDefault();
            void handleWorkspaceDrop(workspace.id, position);
          }}
          aria-hidden="true"
        >
          <span className="workspace-drop-slot-line" />
        </li>
      );
    };

    return (
      <Fragment key={workspace.id}>
        {renderWorkspaceDropSlot('before')}
        <li
          className={`session-card workspace-card ${workspaceOpen ? 'workspace-card-open' : ''} ${workspaceSelected ? 'workspace-card-selected' : ''} ${workspacePending ? 'session-card-pending' : ''} ${workspaceEditMode && workspaceHidden ? 'workspace-card-hidden' : ''} ${workspaceDragging ? 'workspace-card-dragging' : ''} ${workspaceDropTarget ? 'workspace-card-drop-target' : ''}`}
          onDragOver={(event: ReactDragEvent<HTMLLIElement>) => {
            const activeDragWorkspaceId = dragWorkspaceIdRef.current;
            if (!workspaceDraggable || !activeDragWorkspaceId || activeDragWorkspaceId === workspace.id) return;
            event.preventDefault();
            event.dataTransfer.dropEffect = 'move';
            maybeAutoScrollWorkspaceRail(event.clientY);
            const nextPosition = workspaceDropPositionFromEvent(event);
            setWorkspaceDropIndicator((current) => (
              current?.workspaceId === workspace.id && current.position === nextPosition
                ? current
                : { workspaceId: workspace.id, position: nextPosition }
            ));
          }}
          onDrop={(event: ReactDragEvent<HTMLLIElement>) => {
            const activeDragWorkspaceId = dragWorkspaceIdRef.current;
            if (!workspaceDraggable || !activeDragWorkspaceId || activeDragWorkspaceId === workspace.id) return;
            event.preventDefault();
            const nextPosition = workspaceDropPositionFromEvent(event);
            void handleWorkspaceDrop(workspace.id, nextPosition);
          }}
        >
          <div className="workspace-card-header">
            <div className="workspace-manager-title-row">
              {workspaceEditMode ? (
                workspaceDraggable ? (
                  <button
                    type="button"
                    className={`workspace-drag-handle ${workspaceDragging ? 'workspace-drag-handle-dragging' : ''}`}
                    draggable
                    onDragStart={(event) => {
                      dragWorkspaceIdRef.current = workspace.id;
                      setDragWorkspaceId(workspace.id);
                      setWorkspaceDropIndicator(null);
                      event.dataTransfer.effectAllowed = 'move';
                      event.dataTransfer.setData('text/plain', workspace.id);
                      const workspaceCard = event.currentTarget.closest('.workspace-card');
                      if (workspaceCard instanceof HTMLElement) {
                        const bounds = workspaceCard.getBoundingClientRect();
                        const fallbackX = Math.min(32, bounds.width / 2);
                        const fallbackY = Math.min(Math.max(bounds.height / 2, 18), bounds.height - 8);
                        const offsetX = event.clientX > 0
                          ? Math.min(Math.max(event.clientX - bounds.left, 0), bounds.width)
                          : fallbackX;
                        const offsetY = event.clientY > 0
                          ? Math.min(Math.max(event.clientY - bounds.top, 0), bounds.height)
                          : fallbackY;
                        event.dataTransfer.setDragImage(workspaceCard, offsetX, offsetY);
                      }
                    }}
                    onDragEnd={() => clearWorkspaceDragState()}
                    aria-label={copy.reorderWorkspace}
                    title={copy.reorderWorkspace}
                  >
                    <DragHandleIcon />
                  </button>
                ) : (
                  <span className="workspace-drag-handle workspace-drag-handle-disabled" aria-hidden="true">
                    <DragHandleIcon />
                  </span>
                )
              ) : null}
              <button
                type="button"
                className="workspace-card-trigger"
                onClick={() => {
                  if (workspacePending || workspaceEditMode) return;
                  toggleWorkspaceExpanded(workspace.id);
                }}
              >
                <div className="session-card-title workspace-card-title">
                  <h3 title={workspace.path}>{workspace.name}</h3>
                </div>
              </button>
              {workspaceEditMode ? (
                <button
                  type="button"
                  className="button-secondary workspace-visibility-button"
                  onClick={(event) => {
                    event.stopPropagation();
                    void handleToggleWorkspaceVisibility(workspace.id);
                  }}
                  disabled={workspacePending || workspaceLayoutSaving}
                >
                  {workspace.visible ? copy.hideWorkspace : copy.showWorkspace}
                </button>
              ) : null}
            </div>
          </div>

          {workspaceOpen ? (
            <div className="workspace-children">
              <ul className="session-list workspace-session-list">
                {workspaceSessions.map((session) => renderSessionRailItem(session))}
                {workspaceEditMode ? (
                  <li className="session-node session-node-create">
                    <button
                      type="button"
                      className="session-node-trigger session-node-trigger-create"
                      onClick={() => {
                        void handleCreateWorkspaceSession(workspace);
                      }}
                      disabled={busy === 'create-session' || workspacePending}
                    >
                      <div className="session-node-copy">
                        <span className="session-node-marker session-node-marker-empty" aria-hidden="true" />
                        <span className="session-node-label session-node-label-empty">{copy.createSession}</span>
                      </div>
                    </button>
                  </li>
                ) : null}
                {!workspaceEditMode && workspaceSessions.length === 0 ? (
                  <li className="session-node session-node-empty">
                    <div className="session-node-trigger session-node-trigger-empty">
                      <div className="session-node-copy">
                        <span className="session-node-marker session-node-marker-empty" aria-hidden="true" />
                        <span className="session-node-label session-node-label-empty">{railEmptyLabel}</span>
                      </div>
                    </div>
                  </li>
                ) : null}
              </ul>
            </div>
          ) : null}
        </li>
        {renderWorkspaceDropSlot('after')}
      </Fragment>
    );
  }

  function renderFileTreeEntries(workspaceId: string, entries: CodingWorkspaceFileEntry[], depth = 0): ReactNode[] {
    const expandedPaths = new Set(expandedFileTreePaths[workspaceId] ?? []);

    return entries.map((entry) => {
      const directory = entry.kind === 'directory';
      const expanded = directory && expandedPaths.has(entry.path);
      const selected = !directory && selectedFilePaths[workspaceId] === entry.path;
      const childState = directory ? currentFileTreeState(workspaceId, entry.path) : null;
      const childStateKey = directory ? codingFileTreeKey(workspaceId, entry.path) : null;
      const hasChildState = childStateKey
        ? Object.prototype.hasOwnProperty.call(fileTreeDirectories, childStateKey)
        : false;

      return (
        <li key={entry.path} className="file-tree-node">
          <button
            type="button"
            className={`file-tree-button ${selected ? 'file-tree-button-active' : ''} ${directory ? 'file-tree-button-directory' : ''}`}
            style={{ paddingInlineStart: `${12 + (depth * 14)}px` } as CSSProperties}
            onClick={() => {
              if (directory) {
                toggleFileTreeDirectory(workspaceId, entry.path);
                return;
              }
              handleFileTreeSelect(workspaceId, entry.path);
            }}
            title={entry.path}
          >
            <span className="file-tree-button-leading" aria-hidden="true">
              {directory ? (
                <span className={`file-tree-caret ${expanded ? 'file-tree-caret-open' : ''}`}>
                  <ChevronIcon open={expanded} />
                </span>
              ) : (
                <span className="file-tree-caret file-tree-caret-placeholder" />
              )}
              <span className="file-tree-icon">
                {directory ? <FolderIcon open={expanded} /> : <FileIcon />}
              </span>
            </span>
            <span className="file-tree-copy">
              <span className="file-tree-label">{entry.name}</span>
              {!directory && typeof entry.sizeBytes === 'number' ? (
                <span className="file-tree-meta">{formatAttachmentSize(entry.sizeBytes)}</span>
              ) : null}
            </span>
          </button>
          {directory && expanded ? (
            <div className="file-tree-children">
              {!hasChildState || childState?.loading ? (
                <div className="file-tree-inline-state">{copy.loadingFiles}</div>
              ) : childState?.error ? (
                <div className="file-tree-inline-state file-tree-inline-state-error">{childState.error}</div>
              ) : childState && childState.entries.length > 0 ? (
                <ul className="file-tree-list">
                  {renderFileTreeEntries(workspaceId, childState.entries, depth + 1)}
                </ul>
              ) : (
                <div className="file-tree-inline-state">{copy.emptyDirectory}</div>
              )}
            </div>
          ) : null}
        </li>
      );
    });
  }

  function renderFilePreviewPane() {
    if (!selectedFileWorkspace) {
      return (
        <div className="file-preview-empty">
          <strong>{copy.filesTitle}</strong>
          <p>{noWorkspaceLabel}</p>
        </div>
      );
    }

    if (!selectedFilePath) {
      return (
        <div className="file-preview-empty">
          <strong>{copy.filesTitle}</strong>
          <p>{copy.selectFileHint}</p>
        </div>
      );
    }

    if (filePreviewError) {
      return (
        <div className="file-preview-empty file-preview-empty-error">
          <strong>{copy.filesTitle}</strong>
          <p>{filePreviewError}</p>
        </div>
      );
    }

    if (!selectedFilePreview) {
      return (
        <div className="file-preview-empty">
          <strong>{copy.loadingFile}</strong>
        </div>
      );
    }

    return renderResolvedFilePreviewContent(workspacePreviewResource(selectedFilePreview, selectedFileWorkspace.id));
  }

  function renderResolvedFilePreviewContent(
    preview: InlinePreviewResource,
    options?: {
      onMarkdownLinkClick?: (href: string) => void | Promise<void>;
    },
  ) {
    const imagePreview = isImageFilePreview(preview);
    const markdownPreview = isMarkdownFilePreview(preview);
    const pdfPreview = isPdfFilePreview(preview);
    const csvPreview = isCsvFilePreview(preview);
    const textPreview = !imagePreview && !pdfPreview && preview.previewable;
    const csvRows = csvPreview ? parseCsvPreview(preview.content ?? '') : [];
    const csvHeader = csvRows[0] ?? [];
    const csvBodyRows = csvRows.slice(1);

    return (
      <div className="file-preview-pane">
        <div className="file-preview-toolbar">
          <div className="file-preview-meta">
            <strong>{relativeFileLabel(preview.path)}</strong>
            <span>{formatAttachmentSize(preview.sizeBytes)}</span>
            <span>{preview.mimeType}</span>
          </div>
          <a className="button-secondary file-preview-download" href={preview.downloadUrl} download={preview.name}>
            {copy.downloadFile}
          </a>
        </div>
        {preview.truncated && textPreview ? (
          <p className="file-preview-note">{copy.filePreviewTruncated}</p>
        ) : null}
        {imagePreview ? (
          <div className="file-preview-rich-surface file-preview-image-wrap">
            <img
              src={preview.inlineUrl}
              alt={preview.name}
              className="file-preview-image"
            />
          </div>
        ) : markdownPreview ? (
          <div className="file-preview-rich-surface file-preview-markdown markdown-body">
            {renderMarkdown(
              preview.content ?? '',
              options?.onMarkdownLinkClick ? { onLinkClick: options.onMarkdownLinkClick } : undefined,
            )}
          </div>
        ) : pdfPreview ? (
          <div className="file-preview-rich-surface file-preview-pdf-wrap">
            <iframe
              title={preview.name}
              src={preview.inlineUrl}
              className="file-preview-pdf-frame"
            />
          </div>
        ) : csvPreview ? (
          <div className="file-preview-rich-surface file-preview-table-wrap">
            <table className="file-preview-table">
              {csvHeader.length > 0 ? (
                <thead>
                  <tr>
                    {csvHeader.map((cell, index) => (
                      <th key={`header-${index}`}>{cell}</th>
                    ))}
                  </tr>
                </thead>
              ) : null}
              {csvBodyRows.length > 0 ? (
                <tbody>
                  {csvBodyRows.map((row, rowIndex) => (
                    <tr key={`row-${rowIndex}`}>
                      {row.map((cell, cellIndex) => (
                        <td key={`row-${rowIndex}-cell-${cellIndex}`}>{cell}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              ) : null}
            </table>
          </div>
        ) : preview.previewable ? (
          <div className="file-preview-code">
            <MarkdownCodeBlock language={language}>
              <code className={filePreviewCodeClassName(preview.path)}>
                {preview.content ?? ''}
              </code>
            </MarkdownCodeBlock>
          </div>
        ) : (
          <div className="file-preview-empty">
            <strong>{preview.name}</strong>
            <p>{copy.binaryFile}</p>
          </div>
        )}
      </div>
    );
  }

  function renderFileBrowserPane() {
    const selectedFileName = selectedFilePreview?.name
      ?? selectedFilePath?.split('/').pop()
      ?? copy.filesTitle;
    const selectedFileLabel = selectedFilePath
      ? relativeFileLabel(selectedFilePath)
      : selectedFileWorkspace?.name ?? copy.selectFileHint;

    return (
      <section className="panel transcript file-browser-panel">
        <div className="panel-header panel-header-file-browser">
          <div className="session-title-row">
            <div className="file-preview-title-block">
              <h2>{selectedFileName}</h2>
              <p className="file-preview-title-path">{selectedFileLabel}</p>
            </div>
            {selectedFilePath ? (
              <div className="inspector-header-actions">
                <div className="inspector-tabs" role="tablist" aria-label={copy.filesTitle}>
                  <button
                    type="button"
                    className={`button-secondary inspector-tab-button ${fileBrowserTab === 'preview' ? 'inspector-tab-button-active' : ''}`}
                    onClick={() => setFileBrowserTab('preview')}
                  >
                    {copy.previewTab}
                  </button>
                  <button
                    type="button"
                    className={`button-secondary inspector-tab-button ${fileBrowserTab === 'diff' ? 'inspector-tab-button-active' : ''}`}
                    onClick={() => setFileBrowserTab('diff')}
                    disabled={!selectedFileDiffChange}
                  >
                    {copy.diffTab}
                  </button>
                </div>
              </div>
            ) : null}
          </div>
        </div>
        <div className="transcript-layout file-browser-layout">
          <div className="transcript-scroll file-browser-scroll">
            {fileBrowserTab === 'diff' && selectedFileDiffChange ? (
              <div className="inspector-diff-pane">
                <FileChangeList
                  fileChanges={[selectedFileDiffChange]}
                  language={language}
                  noInlineDiffLabel={copy.noInlineDiff}
                />
              </div>
            ) : fileBrowserTab === 'diff' ? (
              <div className="file-preview-empty">
                <strong>{copy.diffTab}</strong>
                <p>{copy.noDiffSelected}</p>
              </div>
            ) : (
              renderFilePreviewPane()
            )}
          </div>
        </div>
      </section>
    );
  }

  function renderDeveloperInspectorPane() {
    if (!developerInspectorWorkspace || !developerInspectorFilePath) {
      return (
        <div className="file-preview-empty">
          <strong>{copy.filesTitle}</strong>
          <p>{copy.selectFileHint}</p>
        </div>
      );
    }

    const canShowDiff = Boolean(developerInspectorDiffChange);
    const canShowPreview = developerInspectorDiffChange?.kind.toLowerCase() !== 'delete';

    return (
      <section className="panel transcript transcript-inspector">
        <div className="panel-header panel-header-file-browser">
          <div className="session-title-row">
            <div className="file-preview-title-block">
              <h2>{developerInspectorFilePath.split('/').pop() ?? developerInspectorFilePath}</h2>
              <p className="file-preview-title-path">{relativeFileLabel(developerInspectorFilePath)}</p>
            </div>
            <div className="inspector-header-actions">
              <div className="inspector-tabs" role="tablist" aria-label={copy.filesTitle}>
                <button
                  type="button"
                  className={`button-secondary inspector-tab-button ${developerInspectorTab === 'preview' ? 'inspector-tab-button-active' : ''}`}
                  onClick={() => setDeveloperInspectorTab('preview')}
                  disabled={!canShowPreview}
                >
                  {copy.previewTab}
                </button>
                <button
                  type="button"
                  className={`button-secondary inspector-tab-button ${developerInspectorTab === 'diff' ? 'inspector-tab-button-active' : ''}`}
                  onClick={() => setDeveloperInspectorTab('diff')}
                  disabled={!canShowDiff}
                >
                  {copy.diffTab}
                </button>
              </div>
              <button
                type="button"
                className="button-secondary"
                onClick={hideDeveloperInspector}
              >
                {copy.hideInspector}
              </button>
            </div>
          </div>
        </div>
        <div className="transcript-layout file-browser-layout">
          <div className="transcript-scroll file-browser-scroll">
            {developerInspectorTab === 'diff' && developerInspectorDiffChange ? (
              <div className="inspector-diff-pane">
                <FileChangeList
                  fileChanges={[developerInspectorDiffChange]}
                  language={language}
                  noInlineDiffLabel={copy.noInlineDiff}
                />
              </div>
            ) : developerInspectorTab === 'diff' ? (
              <div className="file-preview-empty">
                <strong>{copy.diffTab}</strong>
                <p>{copy.noDiffSelected}</p>
              </div>
            ) : developerInspectorError ? (
              <div className="file-preview-empty file-preview-empty-error">
                <strong>{copy.filesTitle}</strong>
                <p>{developerInspectorError}</p>
              </div>
            ) : !developerInspectorPreview ? (
              <div className="file-preview-empty">
                <strong>{developerInspectorLoadingKey ? copy.loadingFile : copy.filesTitle}</strong>
                {!developerInspectorLoadingKey ? <p>{copy.selectFileHint}</p> : null}
              </div>
            ) : (
              renderResolvedFilePreviewContent(workspacePreviewResource(developerInspectorPreview, developerInspectorWorkspace.id))
            )}
          </div>
        </div>
      </section>
    );
  }

  function renderAttachmentPreviewModal() {
    if (!attachmentPreviewTarget) {
      return null;
    }
    if (detail?.session.sessionType === 'chat') {
      return null;
    }

    return (
      <div className="modal-overlay" onClick={closeAttachmentPreview}>
        <aside
          className="modal-card management-modal-card attachment-preview-modal"
          onClick={(event) => event.stopPropagation()}
        >
          <div className="panel-header panel-header-file-browser attachment-preview-header">
            <div className="session-title-row">
              <div className="file-preview-title-block">
                <h2>{attachmentPreviewTarget.filename}</h2>
                <p className="file-preview-title-path">{attachmentPreviewTarget.mimeType}</p>
              </div>
              <div className="inspector-header-actions">
                <a
                  className="button-secondary file-preview-download"
                  href={attachmentDownloadHref(attachmentPreviewTarget)}
                  download={attachmentPreviewTarget.filename}
                >
                  {copy.downloadFile}
                </a>
                <button
                  type="button"
                  className="button-secondary"
                  onClick={closeAttachmentPreview}
                >
                  {copy.close}
                </button>
              </div>
            </div>
          </div>
          <div className="attachment-preview-shell">
            {attachmentPreviewError ? (
              <div className="file-preview-empty file-preview-empty-error">
                <strong>{copy.filesTitle}</strong>
                <p>{attachmentPreviewError}</p>
              </div>
            ) : attachmentPreviewLoading || !attachmentPreviewResourceState ? (
              <div className="file-preview-empty">
                <strong>{copy.loadingFile}</strong>
              </div>
            ) : (
              renderResolvedFilePreviewContent(attachmentPreviewResourceState)
            )}
          </div>
        </aside>
      </div>
    );
  }

  function renderChatAttachmentPreviewPane() {
    if (!attachmentPreviewTarget || detail?.session.sessionType !== 'chat') {
      return null;
    }

    return (
      <aside className="chat-inline-preview-pane">
        <div className="chat-inline-preview-header">
          <div className="file-preview-title-block">
            <h3>{attachmentPreviewTarget.filename}</h3>
            <p className="file-preview-title-path">{attachmentPreviewTarget.mimeType}</p>
          </div>
          <div className="inspector-header-actions">
            <a
              className="button-secondary file-preview-download"
              href={attachmentDownloadHref(attachmentPreviewTarget)}
              download={attachmentPreviewTarget.filename}
            >
              {copy.downloadFile}
            </a>
            <button
              type="button"
              className="button-secondary"
              onClick={closeAttachmentPreview}
            >
              {copy.close}
            </button>
          </div>
        </div>
        <div className="chat-inline-preview-body">
          {attachmentPreviewError ? (
            <div className="file-preview-empty file-preview-empty-error">
              <strong>{copy.filesTitle}</strong>
              <p>{attachmentPreviewError}</p>
            </div>
          ) : attachmentPreviewLoading || !attachmentPreviewResourceState ? (
            <div className="file-preview-empty">
              <strong>{copy.loadingFile}</strong>
            </div>
          ) : (
            renderResolvedFilePreviewContent(
              attachmentPreviewResourceState,
              { onMarkdownLinkClick: handleChatMarkdownLinkClick },
            )
          )}
        </div>
      </aside>
    );
  }

  function openWorkspaceManager(mode: WorkspaceModalMode) {
    setDetailMenuOpen(false);
    setSessionMenuSessionId(null);
    setWorkspaceModalMode(mode);
    setWorkspaceDraftSource('empty');
    setWorkspaceDraftName('');
    setWorkspaceDraftGitUrl('');
    window.setTimeout(() => {
      workspaceDraftInputRef.current?.focus();
    }, 0);
  }

  function closePrimaryDialogs() {
    setRolesOpen(false);
    setSettingsOpen(false);
    setAdminOpen(false);
  }

  function openPrimaryDialog(dialog: 'roles' | 'settings' | 'admin') {
    closePrimaryDialogs();
    if (dialog === 'roles') {
      if (!canManageChatRolePresets) return;
      setRolesOpen(true);
      return;
    }
    if (dialog === 'admin') {
      if (!bootstrap?.currentUser.isAdmin) return;
      setAdminOpen(true);
      return;
    }
    setSettingsOpen(true);
  }

  function handleRailVisibilityToggle() {
    closePrimaryDialogs();
    if (activeMode === 'developer') {
      setDeveloperRailHidden((current) => !current);
      return;
    }
    setChatRailHidden((current) => !current);
  }

  function handlePrimaryModeClick(nextMode: AppMode) {
    if (nextMode === 'developer' && !developerModeEnabled) return;
    if (nextMode === 'chat' && !chatModeEnabled) return;

    closePrimaryDialogs();

    if (nextMode === 'developer') {
      setDeveloperSubview('sessions');
      setDeveloperRailHidden(false);
    } else {
      setChatRailHidden(false);
    }
    setActiveMode(nextMode);
  }

  function renderRolePresetManagerSection() {
    if (!canManageChatRolePresets) {
      return null;
    }

    return (
      <section className="settings-section">
        <div className="settings-section-head">
          <strong>{copy.rolePresetManager}</strong>
          <span>{copy.rolePresetManagerHint}</span>
        </div>

        <div className="settings-role-preset-layout">
          <div className="settings-role-preset-list">
            <div className="settings-role-preset-toolbar">
              <button type="button" className="button-secondary" onClick={beginCreateChatRolePreset}>
                {copy.newRolePreset}
              </button>
            </div>

            {chatRolePresetList?.rolePresets.length ? (
              chatRolePresetList.rolePresets.map((preset) => (
                <article key={preset.id} className={`detail-card settings-role-preset-card ${editingChatRolePresetId === preset.id ? 'settings-role-preset-card-active' : ''}`}>
                  <div className="detail-card-head">
                    <strong>{preset.label}</strong>
                    {preset.isDefault ? <span>{copy.defaults}</span> : null}
                  </div>
                  {preset.description ? <p>{preset.description}</p> : null}
                  <div className="approval-actions settings-role-preset-actions">
                    <button
                      type="button"
                      className="button-secondary"
                      onClick={() => beginEditChatRolePreset(preset)}
                    >
                      {copy.rename}
                    </button>
                    <button
                      type="button"
                      className="button-secondary"
                      onClick={() => void handleDeleteChatRolePreset(preset)}
                      disabled={busy === `delete-chat-role-preset-${preset.id}`}
                    >
                      {copy.delete}
                    </button>
                  </div>
                </article>
              ))
            ) : (
              <article className="detail-card">
                <strong>{copy.noRolePresets}</strong>
                <p>{copy.rolePresetManagerHint}</p>
              </article>
            )}
          </div>

          <form className="detail-card settings-role-preset-editor" onSubmit={handleSaveChatRolePreset}>
            <div className="detail-card-head">
              <strong>{editingChatRolePreset ? copy.editRolePreset : copy.newRolePreset}</strong>
              {editingChatRolePreset ? <span>{editingChatRolePreset.label}</span> : null}
            </div>

            <label className="field">
              <span>{copy.rolePresetName}</span>
              <input
                value={chatRolePresetForm.label}
                onChange={(event) => setChatRolePresetForm((current) => ({ ...current, label: event.target.value }))}
                placeholder={copy.rolePresetName}
              />
            </label>

            <label className="field">
              <span>{copy.rolePresetDescription}</span>
              <textarea
                rows={3}
                value={chatRolePresetForm.description}
                onChange={(event) => setChatRolePresetForm((current) => ({ ...current, description: event.target.value }))}
                placeholder={copy.rolePresetDescription}
              />
            </label>

            <label className="field">
              <span>{copy.rolePresetPrompt}</span>
              <textarea
                rows={10}
                value={chatRolePresetForm.prompt}
                onChange={(event) => setChatRolePresetForm((current) => ({ ...current, prompt: event.target.value }))}
                placeholder={copy.rolePresetPrompt}
              />
            </label>

            <div className="checkbox-grid">
              <label className="checkbox-field">
                <input
                  type="checkbox"
                  checked={chatRolePresetForm.isDefault}
                  onChange={(event) => setChatRolePresetForm((current) => ({ ...current, isDefault: event.target.checked }))}
                />
                <span>{copy.rolePresetDefault}</span>
              </label>
            </div>

            <div className="approval-actions settings-role-preset-actions">
              <button type="button" className="button-secondary" onClick={resetChatRolePresetEditor}>
                {copy.close}
              </button>
              <button
                type="submit"
                disabled={busy === 'save-chat-role-preset'}
              >
                {copy.saveRolePreset}
              </button>
            </div>
          </form>
        </div>
      </section>
    );
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
          <h1>Loading…</h1>
        </section>
      </main>
    );
  }

  return (
    <main className="shell">
      {error || networkAlertMessage ? (
        <div className="toast-stack" role="status" aria-live="polite">
          {networkAlertMessage ? (
            <div className={`toast ${networkState === 'down' ? 'toast-error' : 'toast-warning'}`}>
              <div className="toast-copy">
                <strong>{networkLabel}</strong>
                <span>{networkAlertMessage}</span>
              </div>
            </div>
          ) : null}
          {error ? (
            <div className="toast toast-error">
              <span>{error}</span>
              <button type="button" className="button-secondary toast-close" onClick={() => setError(null)}>
                {copy.close}
              </button>
            </div>
          ) : null}
        </div>
      ) : null}

      <div className="shell-main">
        <section
          className={`workspace ${currentRailHidden ? 'workspace-rail-hidden' : ''}`}
          style={{
            '--primary-nav-width': `${primaryNavWidth}px`,
            '--sidebar-shell-width': `${currentRailHidden ? primaryNavWidth : primaryNavWidth + railWidth}px`,
          } as CSSProperties}
        >
          <div className={`sidebar-shell ${currentRailHidden ? 'sidebar-shell-collapsed' : ''}`}>
            <aside className="primary-nav">
              <div className="primary-nav-menu">
                <button
                  type="button"
                  className={`primary-nav-button ${currentRailHidden ? 'primary-nav-button-active' : ''}`}
                  onClick={handleRailVisibilityToggle}
                  data-label={currentRailHidden ? copy.showSidebar : copy.hideSidebar}
                  aria-label={currentRailHidden ? copy.showSidebar : copy.hideSidebar}
                  title={currentRailHidden ? copy.showSidebar : copy.hideSidebar}
                >
                  <SidebarIcon collapsed={currentRailHidden} />
                  <span className="sr-only">{currentRailHidden ? copy.showSidebar : copy.hideSidebar}</span>
                </button>
                <button
                  type="button"
                  className={`primary-nav-button ${activeMode === 'developer' && developerSubview === 'sessions' ? 'primary-nav-button-active' : ''}`}
                  onClick={() => handlePrimaryModeClick('developer')}
                  disabled={!developerModeEnabled}
                  data-label="coding"
                  aria-label="coding"
                  title="coding"
                >
                  <CodingIcon />
                  <span className="sr-only">coding</span>
                </button>
                <button
                  type="button"
                  className={`primary-nav-button ${developerFilesView ? 'primary-nav-button-active' : ''}`}
                  onClick={() => handleDeveloperSubviewClick('files')}
                  disabled={!developerModeEnabled}
                  data-label={copy.filesNav}
                  aria-label={copy.filesNav}
                  title={copy.filesNav}
                >
                  <FilesIcon />
                  <span className="sr-only">{copy.filesNav}</span>
                </button>
                <button
                  type="button"
                  className={`primary-nav-button ${activeMode === 'chat' ? 'primary-nav-button-active' : ''}`}
                  onClick={() => handlePrimaryModeClick('chat')}
                  disabled={!chatModeEnabled}
                  data-label="chat"
                  aria-label="chat"
                  title="chat"
                >
                  <ChatIcon />
                  <span className="sr-only">chat</span>
                </button>
                {canManageChatRolePresets ? (
                  <button
                    type="button"
                    className={`primary-nav-button ${rolesOpen ? 'primary-nav-button-active' : ''}`}
                    onClick={() => openPrimaryDialog('roles')}
                    data-label="roles"
                    aria-label="roles"
                    title="roles"
                  >
                    <RolesIcon />
                    <span className="sr-only">roles</span>
                  </button>
                ) : null}
                <button
                  type="button"
                  className={`primary-nav-button ${settingsOpen ? 'primary-nav-button-active' : ''}`}
                  onClick={() => openPrimaryDialog('settings')}
                  data-label="setting"
                  aria-label="setting"
                  title="setting"
                >
                  <SettingsIcon />
                  <span className="sr-only">setting</span>
                </button>
                <button
                  type="button"
                  className={`primary-nav-button ${adminOpen ? 'primary-nav-button-active' : ''}`}
                  onClick={() => openPrimaryDialog('admin')}
                  disabled={!bootstrap.currentUser.isAdmin}
                  data-label="admin"
                  aria-label="admin"
                  title="admin"
                >
                  <AdminIcon />
                  <span className="sr-only">admin</span>
                </button>
              </div>

            </aside>

            {!currentRailHidden ? (
              <aside className="rail">
                <div className={`rail-header ${developerFilesView ? 'rail-header-file-browser' : ''}`}>
                  <div className="rail-header-copy">
                    <p className="eyebrow">{railEyebrow}</p>
                    {developerFilesView ? (
                      fileWorkspaceSelectOptions.length > 0 ? (
                        <div className="rail-header-controls">
                          <AppSelect
                            value={selectedFileWorkspaceId ?? fileWorkspaceSelectOptions[0]?.value ?? ''}
                            options={fileWorkspaceSelectOptions}
                            onChange={handleFileWorkspaceChange}
                            ariaLabel={copy.browseWorkspace}
                          />
                          <button
                            type="button"
                            className="button-secondary icon-button"
                            onClick={() => {
                              void refreshFileBrowser();
                            }}
                            title={copy.refresh}
                            aria-label={copy.refresh}
                            disabled={!selectedFileWorkspaceId || selectedFileRootTreeState?.loading || filePreviewLoadingKey !== null}
                          >
                            <RefreshIcon />
                          </button>
                        </div>
                      ) : null
                    ) : showDraftExecutorSelector ? (
                      <div className="rail-header-controls">
                        <AppSelect
                          value={draftCodingExecutor}
                          options={executorSelectOptions}
                          onChange={(nextValue) => setDraftCodingExecutorState(nextValue as AgentExecutor)}
                          ariaLabel={copy.executorLabel}
                        />
                      </div>
                    ) : null}
                  </div>
                </div>

                <div
                  ref={workspaceRailBodyRef}
                  className="rail-body"
                  onDragOver={(event) => {
                    if (activeMode !== 'developer' || !workspaceEditMode || !dragWorkspaceIdRef.current) {
                      return;
                    }
                    maybeAutoScrollWorkspaceRail(event.clientY);
                  }}
                >
                  {developerFilesView ? (
                    <div className="rail-section file-browser-rail-section">
                      {!selectedFileWorkspace ? (
                        <div className="file-tree-empty">{noWorkspaceLabel}</div>
                      ) : !hasSelectedFileRootTreeState || selectedFileRootTreeState?.loading ? (
                        <div className="file-tree-empty">{copy.loadingFiles}</div>
                      ) : selectedFileRootTreeState?.error ? (
                        <div className="file-tree-empty file-tree-empty-error">{selectedFileRootTreeState.error}</div>
                      ) : selectedFileRootTreeState && selectedFileRootTreeState.entries.length > 0 ? (
                        <ul className="file-tree-list">
                          {renderFileTreeEntries(selectedFileWorkspace.id, selectedFileRootTreeState.entries)}
                        </ul>
                      ) : (
                        <div className="file-tree-empty">{copy.emptyWorkspaceFiles}</div>
                      )}
                    </div>
                  ) : activeMode === 'developer' ? (
                    <div className="rail-section">
                      <ul className="session-list workspace-tree">
                        {railVisibleWorkspaces.length === 0 && (!workspaceEditMode || editableHiddenWorkspaces.length === 0) ? (
                          <li className="session-empty">{noWorkspaceLabel}</li>
                        ) : (
                          <>
                            {railVisibleWorkspaces.map((workspace) => renderWorkspaceRailItem(workspace))}
                            {workspaceEditMode && editableHiddenWorkspaces.length > 0 ? (
                              <>
                                {railVisibleWorkspaces.length > 0 ? <li className="workspace-tree-divider" aria-hidden="true" /> : null}
                                {editableHiddenWorkspaces.map((workspace) => renderWorkspaceRailItem(workspace))}
                              </>
                            ) : null}
                          </>
                        )}
                      </ul>
                    </div>
                  ) : (
                    <div className="rail-section">
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

                {!developerFilesView ? (
                  <div className="rail-footer">
                    {activeMode === 'developer' ? (
                      <div className="rail-footer-actions">
                        <button
                          type="button"
                          className={`button-secondary ${workspaceEditMode ? 'rail-footer-button-active' : ''}`}
                          onClick={() => setWorkspaceEditMode((current) => !current)}
                        >
                          {workspaceEditMode ? copy.finish : copy.editWorkspaces}
                        </button>
                        <button type="button" className="button-warm" onClick={() => openWorkspaceManager('create')}>
                          {copy.createWorkspaceAction}
                        </button>
                      </div>
                    ) : (
                      <div className="rail-footer-actions">
                        <button
                          type="button"
                          className={`button-secondary ${chatRailEditMode ? 'rail-footer-button-active' : ''}`}
                          onClick={() => setChatRailEditMode((current) => !current)}
                        >
                          {chatRailEditMode ? copy.finish : copy.rename}
                        </button>
                        <button
                          type="button"
                          className="button-warm"
                          onClick={() => {
                            void handleCreateConversation();
                          }}
                        >
                          {language === 'zh' ? '新建' : 'New'}
                        </button>
                      </div>
                    )}
                  </div>
                ) : null}
              </aside>
            ) : null}
          </div>

          {!currentRailHidden ? (
            <div className="rail-resizer" onMouseDown={handleRailResizeStart} role="separator" aria-orientation="vertical" aria-label={copy.hideSidebar} />
          ) : null}

          <div className={`developer-content-shell ${showDeveloperInspector ? 'developer-content-shell-with-inspector' : ''}`}>
            {developerFilesView ? renderFileBrowserPane() : (
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
                  <h2>{showSessionLoadingState ? copy.loadingSession : copy.selectOrCreate}</h2>
                )}
                {detail && !inlineRenameActive && (detailSessionStatusLabel || !sessionIsChat) ? (
                  <div className="session-title-actions">
                    {detailSessionStatusLabel ? (
                      <span
                        className={`session-status-badge session-status-badge-${detailSessionState} session-title-status-badge`}
                        title={detailSessionStatusTitle ?? undefined}
                      >
                        {detailSessionStatusLabel}
                      </span>
                    ) : null}
                    {!sessionIsChat ? (
                      <button
                        type="button"
                        className="button-secondary icon-button"
                        onClick={(event) => {
                          event.stopPropagation();
                          setSessionMenuSessionId(null);
                          setDetailMenuOpen(false);
                          setSessionInfoOpen(true);
                        }}
                        title={copy.info}
                        aria-label={copy.info}
                        disabled={selectedSessionIsOptimistic}
                      >
                        <InfoIcon />
                      </button>
                    ) : null}
                  </div>
                ) : null}
              </div>
            </div>

            {detail ? (
              <div className="transcript-layout">
                <div className={`transcript-main-shell ${showChatAttachmentInlinePreview ? 'transcript-main-shell-with-preview' : ''}`}>
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
                                onSelectFileChange={!sessionIsChat ? handleTranscriptFileChangeSelect : undefined}
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
                              <div className="chat-message-main">
                                {event.kind === 'assistant' && (sessionIsChat || codingAnswerLabelEntryIds.has(event.id)) ? (
                                  <div className="chat-message-head">
                                    <strong>{copy.answerLabel}</strong>
                                  </div>
                                ) : null}
                                {event.attachments.length > 0 ? (
                                  <div className="chat-attachments">
                                    {event.attachments.map((attachment) => (
                                      <button
                                        key={attachment.id}
                                        type="button"
                                        className={`chat-attachment-card chat-attachment-card-${attachment.kind}`}
                                        onClick={() => {
                                          void handleOpenAttachmentPreview(attachment);
                                        }}
                                      >
                                        {attachment.kind === 'image' ? (
                                          <div className="chat-attachment-media">
                                            <img src={attachmentInlineHref(attachment)} alt={attachment.filename} className="chat-attachment-image" />
                                          </div>
                                        ) : null}
                                        <div className="chat-attachment-copy">
                                          <strong>{attachment.filename}</strong>
                                          <span>{formatAttachmentSize(attachment.sizeBytes)}</span>
                                        </div>
                                      </button>
                                    ))}
                                  </div>
                                ) : null}
                                {event.body && event.markdown ? (
                                  <div className="markdown-body chat-body">
                                    {renderMarkdown(
                                      event.body,
                                      sessionIsChat ? { onLinkClick: handleChatMarkdownLinkClick } : undefined,
                                    )}
                                  </div>
                                ) : event.body ? (
                                  <pre className="event-body">{event.body}</pre>
                                ) : null}
                              </div>
                            </article>
                          );
                        })
                      )}
                      {detailSessionState === 'processing' && (visibleSessionActivityLabel || departingSessionActivityLabel) ? (
                        <article className="chat-message chat-assistant chat-activity-message">
                          <div className="chat-message-main chat-activity-message-main">
                            <div className="chat-activity-message-copy">
                              <span>{copy.processingStatus}</span>
                            </div>
                            <div className="chat-activity-ticker" aria-live="polite" aria-atomic="true">
                              {departingSessionActivityLabel ? (
                                <span className="chat-activity-ticker-item chat-activity-ticker-item-leaving">
                                  {departingSessionActivityLabel}
                                </span>
                              ) : null}
                              {visibleSessionActivityLabel ? (
                                <span
                                  className={`chat-activity-ticker-item ${departingSessionActivityLabel ? 'chat-activity-ticker-item-entering' : 'chat-activity-ticker-item-current'}`}
                                >
                                  {visibleSessionActivityLabel}
                                </span>
                              ) : null}
                            </div>
                          </div>
                        </article>
                      ) : null}
                    </div>
                  </div>
                  {showChatAttachmentInlinePreview ? (
                    <>
                      <div className="transcript-main-divider" aria-hidden="true" />
                      {renderChatAttachmentPreviewPane()}
                    </>
                  ) : null}
                </div>
                {detailSessionState === 'pending' && activeApproval ? (
                  <section
                    ref={approvalPromptRef}
                    className={`session-status-bar session-status-${detailSessionState}`}
                    tabIndex={0}
                    onKeyDown={handleApprovalPromptKeyDown}
                  >
                    <div className="session-status-copy">
                      <div className="session-status-title-row">
                        <span className={`session-status-badge session-status-badge-${detailSessionState}`}>
                          {copy.approvalPendingStatus}
                        </span>
                        <strong>{activeApproval.title}</strong>
                      </div>
                      <p>{activeApproval.risk}</p>
                      <p className="detail-card-meta">{copy.approvalPendingHint}</p>
                      <p className="detail-card-meta">{copy.approvalKeyboardHint}</p>
                      {pendingApprovals.length > 1 ? (
                        <p className="detail-card-meta">{formatRemainingApprovals(pendingApprovals.length - 1, language)}</p>
                      ) : null}
                    </div>
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
                        {executorSelectOptions.length > 1 ? (
                          <label className="composer-config-field">
                            <span>{copy.executorLabel}</span>
                            <AppSelect
                              className="app-select-compact"
                              value={currentSessionExecutor}
                              options={executorSelectOptions}
                              onChange={handleSessionExecutorChange}
                              ariaLabel={copy.executorLabel}
                              disabled={
                                busy === 'update-session-preferences'
                                || sessionHasActiveTurn
                                || selectedSessionIsOptimistic
                              }
                            />
                          </label>
                        ) : null}
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
                        {sessionIsChat ? (
                          <label className="composer-config-field">
                            <span>{copy.rolePreset}</span>
                            <AppSelect
                              className="app-select-compact"
                              value={sessionRolePresetId}
                              options={rolePresetSelectOptions}
                              onChange={(nextValue) => void handleChatRolePresetChange(nextValue)}
                              ariaLabel={copy.rolePreset}
                              disabled={busy === 'update-session-preferences'}
                            />
                          </label>
                        ) : null}
                        {!sessionIsChat ? (
                          <label className="composer-config-field">
                            <span>{copy.approvalModeLabel}</span>
                            <AppSelect
                              className="app-select-compact"
                              value={currentSessionMode}
                              options={modeSelectOptions}
                              onChange={handleSessionModeChange}
                              ariaLabel={copy.approvalModeLabel}
                              disabled={!detail || detail.session.sessionType !== 'code'}
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
                    {!sessionIsChat && queuedTurns.length > 0 ? (
                      <div className="queued-turns">
                        <div className="queued-turns-head">
                          <strong>{copy.queuedTurnsLabel}</strong>
                          <span>{copy.queuedTurnsHint}</span>
                        </div>
                        <div className="queued-turn-list">
                          {queuedTurns.map((queuedTurn) => (
                            <div key={queuedTurn.id} className="queued-turn-card">
                              <div className="queued-turn-copy">
                                <strong>{queuedTurn.promptPreview}</strong>
                                <span>{formatQueuedTurnMeta(queuedTurn, language)}</span>
                              </div>
                              <button
                                type="button"
                                className="button-secondary icon-button queued-turn-remove"
                                onClick={() => void handleRemoveQueuedTurn(queuedTurn.id)}
                                disabled={busy === `remove-queued-turn-${queuedTurn.id}`}
                                title={copy.removeQueuedTurn}
                                aria-label={copy.removeQueuedTurn}
                              >
                                <RemoveIcon />
                              </button>
                            </div>
                          ))}
                        </div>
                      </div>
                    ) : null}
                    <div className="composer-row">
                      <textarea
                        ref={promptTextareaRef}
                        value={prompt}
                        onChange={(event) => updatePromptDraft(selectedPromptDraftKey, event.target.value)}
                        onPaste={handleComposerPaste}
                        onKeyDown={handlePromptKeyDown}
                        onCompositionStart={handlePromptCompositionStart}
                        onCompositionEnd={handlePromptCompositionEnd}
                        rows={1}
                        placeholder={copy.prompt}
                        disabled={(selectedSessionIsOptimistic && !sessionIsChat) || Boolean(activeApproval)}
                      />
                      <div className="composer-actions">
                        <button
                          type="button"
                          className="button-secondary icon-button attach-button"
                          onClick={() => attachmentInputRef.current?.click()}
                          disabled={
                            (selectedSessionIsOptimistic && !sessionIsChat)
                            || busy === 'upload-attachment'
                            || busy === 'start-turn'
                            || (sessionHasActiveTurn && !canQueueCodingFollowUpTurn)
                            || Boolean(activeApproval)
                          }
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
                            <StopSquareIcon />
                          </button>
                        ) : null}
                        <button
                          type="submit"
                          className="send-button"
                          disabled={
                            (selectedSessionIsOptimistic && !sessionIsChat)
                            || busy === 'start-turn'
                            || busy === 'stop-session'
                            || busy === 'upload-attachment'
                            || (sessionHasActiveTurn && !canQueueCodingFollowUpTurn)
                            || Boolean(activeApproval)
                            || (!prompt.trim() && draftAttachments.length === 0)
                          }
                          title={canQueueCodingFollowUpTurn ? copy.queueTurn : busy === 'start-turn' ? copy.sending : copy.sendPrompt}
                          aria-label={canQueueCodingFollowUpTurn ? copy.queueTurn : busy === 'start-turn' ? copy.sending : copy.sendPrompt}
                        >
                          <SendIcon />
                        </button>
                      </div>
                    </div>
                  </div>
                </form>
              </div>
            ) : showSessionLoadingState ? (
              <section className="empty-state">
                <p className="eyebrow">{copy.currentSession}</p>
                <h2>{copy.loadingSession}</h2>
              </section>
            ) : (
              <section className="empty-state">
                <p className="eyebrow">{copy.noActiveSelection}</p>
                <h2>{copy.pickSessionHint}</h2>
              </section>
            )}
          </section>
            )}
          {showDeveloperInspector ? (
            <>
              <div className="developer-content-divider" aria-hidden="true" />
              {renderDeveloperInspectorPane()}
            </>
          ) : null}
          </div>
        </section>
      </div>

      {renderAttachmentPreviewModal()}

      {rolesOpen ? (
        <div className="modal-overlay" onClick={() => setRolesOpen(false)}>
          <aside className="modal-card management-modal-card" onClick={(event) => event.stopPropagation()}>
            <div className="panel-header settings-header">
              <div>
                <p className="eyebrow">roles</p>
                <h2>{copy.rolePresetManager}</h2>
              </div>
              <button type="button" className="button-secondary topbar-button" onClick={() => setRolesOpen(false)}>
                {copy.close}
              </button>
            </div>

            {renderRolePresetManagerSection()}
          </aside>
        </div>
      ) : null}

      {settingsOpen ? (
        <div className="modal-overlay" onClick={() => setSettingsOpen(false)}>
          <aside className="modal-card management-modal-card settings-modal-card" onClick={(event) => event.stopPropagation()}>
            <div className="panel-header settings-header">
              <div>
                <p className="eyebrow">setting</p>
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
                <strong>{copy.themeSetting}</strong>
                <span>{copy.themeSettingHint}</span>
              </div>
              <div className="settings-language-row">
                <button
                  type="button"
                  className={theme === 'white' ? 'button-secondary settings-language-button settings-language-button-active' : 'button-secondary settings-language-button'}
                  onClick={() => setTheme('white')}
                >
                  {copy.themeWhite}
                </button>
                <button
                  type="button"
                  className={theme === 'warm' ? 'button-secondary settings-language-button settings-language-button-active' : 'button-secondary settings-language-button'}
                  onClick={() => setTheme('warm')}
                >
                  {copy.themeWarm}
                </button>
                <button
                  type="button"
                  className={theme === 'night' ? 'button-secondary settings-language-button settings-language-button-active' : 'button-secondary settings-language-button'}
                  onClick={() => setTheme('night')}
                >
                  {copy.themeNight}
                </button>
              </div>
            </section>

            <section className="settings-section">
              <div className="settings-section-head">
                <strong>{copy.systemNotifications}</strong>
                <span>{copy.systemNotificationsHint}</span>
              </div>
              <div className="remote-status-row">
                <span className={`remote-status-pill ${notificationPermission === 'granted' ? 'remote-status-pill-live' : ''}`}>
                  {notificationPermission === 'granted'
                    ? copy.notificationsEnabled
                    : notificationPermission === 'default'
                      ? copy.notificationsDisabled
                      : notificationPermission === 'denied'
                        ? copy.notificationsBlocked
                        : copy.notificationsUnsupported}
                </span>
              </div>
              {notificationPermission === 'default' ? (
                <div className="remote-button-row">
                  <button type="button" onClick={() => void handleEnableNotifications()}>
                    {copy.enableNotifications}
                  </button>
                </div>
              ) : null}
              {notificationPermission === 'denied' ? (
                <p className="remote-access-error">{copy.notificationsBlockedHint}</p>
              ) : null}
            </section>

          </aside>
        </div>
      ) : null}

      {adminOpen ? (
        <div className="modal-overlay" onClick={() => setAdminOpen(false)}>
          <aside className="modal-card management-modal-card management-modal-card-wide admin-sheet" onClick={(event) => event.stopPropagation()}>
            <div className="panel-header settings-header">
              <div>
                <p className="eyebrow">admin</p>
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
                <p className="detail-card-meta">{copy.executorLabel}: {executorOptionLabel(language, detail.session.executor)}</p>
                {detail.session.sessionType === 'code' ? (
                  <p className="detail-card-meta">{copy.approvalModeLabel}: {modeOptionLabel(language, currentSessionMode)}</p>
                ) : null}
                <p className="detail-card-meta">{copy.modelLabel}: {detail.session.model ?? 'codex'}</p>
                <p className="detail-card-meta">{copy.thinkingLabel}: {detail.session.reasoningEffort ?? 'xhigh'}</p>
                {detail.session.sessionType === 'chat' ? (
                  <p className="detail-card-meta">{copy.rolePresetLabel}: {selectedChatRolePreset?.label ?? copy.noRolePreset}</p>
                ) : null}
                <p className="detail-card-meta">{copy.threadLabel}: {shortThreadId(detail.session.threadId)}</p>
                <p className="detail-card-meta">{copy.createdAt} {formatTimestamp(detail.session.createdAt, language)}</p>
                <p className="detail-card-meta">{copy.updatedAt} {formatTimestamp(detail.session.updatedAt, language)}</p>
                {detail.session.lastIssue && (
                  detail.session.sessionType === 'chat'
                    ? detail.session.uiStatus === 'error'
                    : detail.session.status !== 'stale'
                ) ? <p>{detail.session.lastIssue}</p> : null}
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
          <div className="modal-card workspace-manager-modal workspace-create-modal" onClick={(event) => event.stopPropagation()}>
            <div className="panel-header settings-header">
              <div>
                <p className="eyebrow">{copy.createWorkspaceAction}</p>
                <h2>{copy.createWorkspaceTitle}</h2>
              </div>
              <button type="button" className="button-secondary topbar-button" onClick={() => setWorkspaceModalMode(null)}>
                {copy.close}
              </button>
            </div>

            <form className="create-form workspace-create-form" onSubmit={handleCreateWorkspace}>
              <div className="rail-footer-actions">
                <button
                  type="button"
                  className={workspaceDraftSource === 'empty' ? 'rail-footer-button-active' : 'button-secondary'}
                  onClick={() => setWorkspaceDraftSource('empty')}
                >
                  {copy.workspaceFromName}
                </button>
                <button
                  type="button"
                  className={workspaceDraftSource === 'git' ? 'rail-footer-button-active' : 'button-secondary'}
                  onClick={() => setWorkspaceDraftSource('git')}
                >
                  {copy.workspaceFromGit}
                </button>
              </div>

              {workspaceDraftSource === 'empty' ? (
                <label className="field">
                  <span>{copy.workspace}</span>
                  <input
                    ref={workspaceDraftInputRef}
                    value={workspaceDraftName}
                    onChange={(event) => setWorkspaceDraftName(event.target.value)}
                    placeholder={copy.workspaceFolder}
                  />
                </label>
              ) : (
                <label className="field">
                  <span>{copy.gitRepository}</span>
                  <input
                    ref={workspaceDraftInputRef}
                    value={workspaceDraftGitUrl}
                    onChange={(event) => setWorkspaceDraftGitUrl(event.target.value)}
                    placeholder="https://github.com/org/repo.git"
                  />
                </label>
              )}

              <button
                type="submit"
                className="button-warm"
                disabled={busy === 'create-workspace' || (workspaceDraftSource === 'empty' ? !workspaceDraftName.trim() : !workspaceDraftGitUrl.trim())}
              >
                {busy === 'create-workspace' ? copy.creating : copy.createWorkspaceAction}
              </button>
            </form>
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
                  <strong>{copy.repoWriteProfile}</strong>
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

              {userModalMode === 'edit' && editingAdminUser ? (
                <label className="token-block">
                  <span>{copy.currentToken}</span>
                  <input readOnly value={editingAdminUser.token} />
                </label>
              ) : null}

              <div className="field">
                <span>{copy.roleLabel}</span>
                <div className="checkbox-grid">
                  <label className="checkbox-field">
                    <input
                      type="checkbox"
                      checked={userForm.roles.includes('user')}
                      onChange={(event) => setUserForm((current) => ({
                        ...current,
                        roles: toggleUserRole(current.roles, 'user', event.target.checked),
                      }))}
                    />
                    <span>{roleLabel(language, 'user')}</span>
                  </label>
                  <label className="checkbox-field">
                    <input
                      type="checkbox"
                      checked={userForm.roles.includes('developer')}
                      onChange={(event) => setUserForm((current) => ({
                        ...current,
                        roles: toggleUserRole(current.roles, 'developer', event.target.checked),
                        canUseFullHost: event.target.checked ? current.canUseFullHost : false,
                      }))}
                    />
                    <span>{roleLabel(language, 'developer')}</span>
                  </label>
                  <label className="checkbox-field">
                    <input
                      type="checkbox"
                      checked={userForm.roles.includes('admin')}
                      onChange={(event) => setUserForm((current) => ({
                        ...current,
                        roles: toggleUserRole(current.roles, 'admin', event.target.checked),
                      }))}
                    />
                    <span>{copy.adminRole}</span>
                  </label>
                </div>
              </div>

              <div className="checkbox-grid">
                <label className="checkbox-field">
                  <input
                    type="checkbox"
                    checked={userForm.canUseFullHost}
                    disabled={!userForm.roles.includes('developer')}
                    onChange={(event) => setUserForm((current) => ({ ...current, canUseFullHost: event.target.checked }))}
                  />
                  <span>{copy.canUseFullHost}</span>
                </label>
              </div>

              {userModalMode === 'edit' && editingUserId ? (
                <div className="approval-actions">
                  <button
                    type="button"
                    className="button-secondary"
                    onClick={() => void handleRegenerateUserToken()}
                    disabled={busy === `regenerate-token-${editingUserId}`}
                  >
                    {busy === `regenerate-token-${editingUserId}` ? copy.regeneratingToken : copy.regenerateToken}
                  </button>
                </div>
              ) : null}

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
