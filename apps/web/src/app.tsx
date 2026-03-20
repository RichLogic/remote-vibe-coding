import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

import {
  archiveSession,
  connectCloudflareTunnel,
  createAdminUser,
  createSession,
  deleteAdminUser,
  deleteSession,
  disconnectCloudflareTunnel,
  fetchAdminUsers,
  fetchBootstrap,
  fetchSessionDetail,
  logout,
  renameSession,
  resolveApproval,
  restoreSession,
  startTurn,
  stopSession,
  updateSessionPreferences,
  updateAdminUser,
} from './api';
import type {
  AdminUserRecord,
  BootstrapPayload,
  CodexThread,
  CodexThreadItem,
  PendingApproval,
  ReasoningEffort,
  SessionDetailResponse,
  SessionStatus,
  SessionType,
  TranscriptEventKind,
} from './types';

type DetailView = 'transcript' | 'commands' | 'changes' | 'activity';
type Language = 'en' | 'zh';
type UserModalMode = 'create' | 'edit';

interface TranscriptEvent {
  kind: TranscriptEventKind;
  body: string;
  markdown: boolean;
}

interface CommandEvent {
  id: string;
  command: string;
  cwd: string;
  status: string;
  exitCode: number | null;
  output: string;
}

interface FileChangeEvent {
  id: string;
  path: string;
  kind: string;
  status: string;
  diff: string | null;
}

interface UserFormState {
  username: string;
  password: string;
  isAdmin: boolean;
  allowCode: boolean;
  allowChat: boolean;
  canUseFullHost: boolean;
  regenerateToken: boolean;
}

const FALLBACK_REASONING: ReasoningEffort[] = ['minimal', 'low', 'medium', 'high'];

const STATUS_LABELS: Record<Language, Record<SessionStatus, string>> = {
  en: {
    running: 'Running',
    'needs-approval': 'Needs approval',
    idle: 'Idle',
    error: 'Error',
    stale: 'Stale',
  },
  zh: {
    running: '运行中',
    'needs-approval': '等待审批',
    idle: '空闲',
    error: '错误',
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
    newSession: 'New session',
    noActiveSessions: 'No active sessions yet.',
    archivedHistory: 'Archived',
    history: 'History',
    hideArchived: 'Hide archived',
    transcript: 'Chat',
    commands: 'Commands',
    changes: 'Changes',
    activity: 'Activity',
    selectOrCreate: 'Select a session to continue working.',
    runtimeReset: 'Runtime reset detected',
    threadMissing: 'Codex no longer has this thread loaded',
    autoRestartHint: 'The next prompt will automatically create a fresh thread in this session.',
    archivedEyebrow: 'Archived session',
    historyMode: 'This session is archived',
    historyModeHint: 'Restore it if you want to keep using the same workspace.',
    restoreSession: 'Restore session',
    noTurnsYet: 'No turns yet',
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
    restoreRequired: 'Restore required',
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
    accountHint: 'Machine-level controls stay here so the main screen can stay focused on sessions and chat.',
    currentUser: 'Current user',
    defaults: 'Defaults',
    browserShell: 'Codex-first browser shell',
    networkOffByDefault: 'Network off by default',
    networkOnByDefault: 'Network on by default',
    newSessionTitle: 'Create a session',
    sessionType: 'Session type',
    codeSession: 'Code',
    chatSession: 'Chat',
    workspace: 'Workspace',
    title: 'Title',
    optionalSessionTitle: 'Optional session title',
    securityProfile: 'Security profile',
    model: 'Model',
    thinking: 'Thinking',
    readOnlyProfile: 'read-only',
    repoWriteProfile: 'repo-write',
    fullHostProfile: 'full-host',
    chatSessionHint: 'Chat sessions use an internal read-only workspace and do not expose file-write access.',
    createSession: 'Create session',
    creating: 'Creating...',
    renameSessionTitle: 'Rename session',
    saveName: 'Save name',
    renaming: 'Saving...',
    sessionDeletedConfirm: 'Delete "{title}" permanently? This only removes it from remote-vibe-coding.',
    archive: 'Archive',
    restore: 'Restore',
    delete: 'Delete',
    rename: 'Rename',
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
    newSession: '新建会话',
    noActiveSessions: '暂时还没有活跃会话。',
    archivedHistory: '归档',
    history: '历史',
    hideArchived: '收起归档',
    transcript: '聊天',
    commands: '命令',
    changes: '改动',
    activity: '活动',
    selectOrCreate: '选择一个会话继续工作。',
    runtimeReset: '运行时已重置',
    threadMissing: 'Codex 已经不再持有这个 thread',
    autoRestartHint: '你下一次发送消息时，会自动在这个会话里创建新的 thread。',
    archivedEyebrow: '已归档会话',
    historyMode: '这个会话已经归档',
    historyModeHint: '如果你想继续使用同一个 workspace，先恢复它。',
    restoreSession: '恢复会话',
    noTurnsYet: '还没有对话',
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
    restoreRequired: '需要先恢复',
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
    accountHint: '机器级设置放在这里，让主界面保持在 session 和 chat 上。',
    currentUser: '当前用户',
    defaults: '默认值',
    browserShell: 'Codex 优先的浏览器壳',
    networkOffByDefault: '默认关闭网络',
    networkOnByDefault: '默认开启网络',
    newSessionTitle: '创建会话',
    sessionType: '会话类型',
    codeSession: '代码',
    chatSession: '聊天',
    workspace: '工作目录',
    title: '标题',
    optionalSessionTitle: '可选的会话标题',
    securityProfile: '安全档位',
    model: '模型',
    thinking: '思考强度',
    readOnlyProfile: '只读',
    repoWriteProfile: '仓库可写',
    fullHostProfile: '整机权限',
    chatSessionHint: '聊天会话会使用内部只读 workspace，不暴露文件写权限。',
    createSession: '创建会话',
    creating: '创建中...',
    renameSessionTitle: '修改会话名称',
    saveName: '保存名称',
    renaming: '保存中...',
    sessionDeletedConfirm: '确定永久删除 “{title}” 吗？这只会把它从 remote-vibe-coding 中移除。',
    archive: '归档',
    restore: '恢复',
    delete: '删除',
    rename: '改名',
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
  },
} as const;

function formatTimestamp(value: string, language: Language) {
  return new Date(value).toLocaleString(language === 'zh' ? 'zh-CN' : 'en-US');
}

function shortThreadId(threadId: string) {
  return threadId.slice(0, 8);
}

function pickPreferredSessionId(
  sessions: Array<{ id: string; archivedAt: string | null }>,
) {
  return sessions.find((session) => !session.archivedAt)?.id ?? sessions[0]?.id ?? null;
}

function itemToEvent(item: CodexThreadItem): TranscriptEvent | null {
  if (item.type === 'userMessage') {
    return {
      kind: 'user',
      body: item.content
        .filter((entry) => entry.type === 'text')
        .map((entry) => entry.text)
        .join('\n'),
      markdown: true,
    };
  }

  if (item.type === 'agentMessage') {
    return {
      kind: 'assistant',
      body: item.text,
      markdown: true,
    };
  }

  return null;
}

function flattenThread(thread: CodexThread | null) {
  if (!thread) return [];
  return thread.turns.flatMap((turn) =>
    turn.items.flatMap((item) => {
      const event = itemToEvent(item);
      return event ? [event] : [];
    }),
  );
}

function collectCommands(thread: CodexThread | null): CommandEvent[] {
  if (!thread) return [];

  return thread.turns.flatMap((turn) =>
    turn.items.flatMap((item) => {
      if (item.type !== 'commandExecution') {
        return [];
      }

      return [{
        id: item.id,
        command: item.command,
        cwd: item.cwd,
        status: item.status,
        exitCode: item.exitCode,
        output: item.aggregatedOutput || item.status,
      }];
    }),
  );
}

function collectFileChanges(thread: CodexThread | null): FileChangeEvent[] {
  if (!thread) return [];

  return thread.turns.flatMap((turn) =>
    turn.items.flatMap((item) => {
      if (item.type !== 'fileChange') {
        return [];
      }

      return item.changes.map((change, index) => ({
        id: `${item.id}-${change.path}-${index}`,
        path: change.path,
        kind: change.kind?.type ?? 'update',
        status: item.status,
        diff: change.diff ?? null,
      }));
    }),
  );
}

function firstAllowedSessionType(bootstrap: BootstrapPayload | null): SessionType {
  return bootstrap?.currentUser.allowedSessionTypes[0] ?? 'code';
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

function SendIcon() {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <path d="M3.4 9.8 16.2 3.7l-2.8 12.6-4.1-4.2-3 .9 1.4-3.2-4.3-.8Z" fill="currentColor" />
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

export function App() {
  const [language, setLanguage] = useState<Language>(() => {
    if (typeof window === 'undefined') return 'en';
    const stored = window.localStorage.getItem('rvc-language');
    if (stored === 'zh' || stored === 'en') return stored;
    return window.navigator.language.toLowerCase().startsWith('zh') ? 'zh' : 'en';
  });
  const [bootstrap, setBootstrap] = useState<BootstrapPayload | null>(null);
  const [detail, setDetail] = useState<SessionDetailResponse | null>(null);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [prompt, setPrompt] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [detailView, setDetailView] = useState<DetailView>('transcript');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [adminOpen, setAdminOpen] = useState(false);
  const [sessionInfoOpen, setSessionInfoOpen] = useState(false);
  const [adminUsers, setAdminUsers] = useState<AdminUserRecord[] | null>(null);
  const [newSessionOpen, setNewSessionOpen] = useState(false);
  const [renameSessionId, setRenameSessionId] = useState<string | null>(null);
  const [renameTitle, setRenameTitle] = useState('');
  const [showArchived, setShowArchived] = useState(false);
  const [newSessionType, setNewSessionType] = useState<SessionType>('code');
  const [workspace, setWorkspace] = useState('/Users/richlogic/code/remote-vibe-coding');
  const [title, setTitle] = useState('');
  const [securityProfile, setSecurityProfile] = useState<'repo-write' | 'full-host'>('repo-write');
  const [sessionModel, setSessionModel] = useState('');
  const [sessionEffort, setSessionEffort] = useState<ReasoningEffort>('medium');
  const [userModalMode, setUserModalMode] = useState<UserModalMode>('create');
  const [userModalOpen, setUserModalOpen] = useState(false);
  const [editingUserId, setEditingUserId] = useState<string | null>(null);
  const [userForm, setUserForm] = useState<UserFormState>(() => defaultUserForm());
  const [isPromptComposing, setIsPromptComposing] = useState(false);
  const promptCompositionResetTimerRef = useRef<number | null>(null);
  const lastPromptCompositionEndAtRef = useRef(0);
  const copy = COPY[language];

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
    let cancelled = false;

    async function loadBootstrapData() {
      try {
        const next = await fetchBootstrap();
        if (cancelled) return;
        setBootstrap(next);
        setError(null);

        if (!selectedSessionId || !next.sessions.some((session) => session.id === selectedSessionId)) {
          setSelectedSessionId(pickPreferredSessionId(next.sessions));
        }
      } catch (loadError) {
        if (!cancelled) {
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
  }, [selectedSessionId, copy.unknownError]);

  useEffect(() => {
    if (!selectedSessionId) {
      setDetail(null);
      return;
    }

    const currentSessionId = selectedSessionId;
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
  }, [selectedSessionId, copy.unknownError]);

  useEffect(() => {
    if (!bootstrap) return;
    if (!bootstrap.currentUser.allowedSessionTypes.includes(newSessionType)) {
      setNewSessionType(firstAllowedSessionType(bootstrap));
    }
  }, [bootstrap, newSessionType]);

  useEffect(() => {
    if (newSessionType === 'chat') {
      if (securityProfile !== 'repo-write') {
        setSecurityProfile('repo-write');
      }
    }
  }, [newSessionType, securityProfile]);

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
      : option.defaultReasoningEffort;

    setSessionModel(nextModel);
    setSessionEffort(nextEffort);
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

  const threadEvents = flattenThread(detail?.thread ?? null);
  const commandEvents = collectCommands(detail?.thread ?? null);
  const fileChanges = collectFileChanges(detail?.thread ?? null);
  const cloudflare = bootstrap?.cloudflare;
  const cloudflareManagedBySystem = cloudflare?.activeSource === 'system';
  const cloudflareManagedLocally = cloudflare?.activeSource === 'local-manager';
  const sessionIsArchived = Boolean(detail?.session.archivedAt);
  const sessionIsChat = detail?.session.sessionType === 'chat';
  const sessionHasActiveTurn = Boolean(detail?.session.activeTurnId);
  const threadStatus = detail?.thread?.status && typeof detail.thread.status === 'object'
    ? detail.thread.status.type
    : typeof detail?.thread?.status === 'string'
      ? detail.thread.status
      : 'idle';
  const activeSessions = (bootstrap?.sessions ?? []).filter((session) => !session.archivedAt);
  const archivedSessions = (bootstrap?.sessions ?? []).filter((session) => Boolean(session.archivedAt));

  async function refreshCurrentSelection(sessionId = selectedSessionId) {
    const nextBootstrap = await fetchBootstrap();
    setBootstrap(nextBootstrap);
    const nextSelectedSessionId = sessionId && nextBootstrap.sessions.some((entry) => entry.id === sessionId)
      ? sessionId
      : pickPreferredSessionId(nextBootstrap.sessions);
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

  async function handleCreateSession(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy('create-session');
    try {
      const session = await createSession({
        sessionType: newSessionType,
        ...(title.trim() ? { title: title.trim() } : {}),
        ...(newSessionType === 'code'
          ? {
              cwd: workspace,
              securityProfile,
            }
          : {}),
      });
      setTitle('');
      setPrompt('');
      setNewSessionOpen(false);
      setSelectedSessionId(session.id);
      await refreshCurrentSelection(session.id);
      setError(null);
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : copy.createSession);
    } finally {
      setBusy(null);
    }
  }

  async function submitPrompt() {
    if (!selectedSessionId || !prompt.trim() || sessionIsArchived || sessionHasActiveTurn || busy === 'stop-session') return;
    setBusy('start-turn');
    try {
      await startTurn(selectedSessionId, { prompt: prompt.trim() });
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
    if (busy === 'start-turn' || busy === 'stop-session' || sessionIsArchived || detail?.session.activeTurnId) return;
    void submitPrompt();
  }

  async function handleStopActiveTurn() {
    if (!selectedSessionId) return;
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

  async function handleSessionPreferencesChange(nextModel: string, nextEffort: ReasoningEffort) {
    if (!selectedSessionId) return;
    setBusy('update-session-preferences');
    try {
      await updateSessionPreferences(selectedSessionId, {
        model: nextModel,
        reasoningEffort: nextEffort,
      });
      await refreshCurrentSelection(selectedSessionId);
      setError(null);
    } catch (preferencesError) {
      await refreshCurrentSelection(selectedSessionId);
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
      : option.defaultReasoningEffort;
    setSessionModel(nextModel);
    setSessionEffort(nextEffort);
    void handleSessionPreferencesChange(nextModel, nextEffort);
  }

  function handleSessionEffortChange(nextEffort: ReasoningEffort) {
    setSessionEffort(nextEffort);
    void handleSessionPreferencesChange(sessionModel, nextEffort);
  }

  async function handleArchiveToggle(sessionId: string, archived: boolean) {
    setBusy(`${archived ? 'archive' : 'restore'}-${sessionId}`);
    try {
      if (archived) {
        await archiveSession(sessionId);
        setShowArchived(true);
      } else {
        await restoreSession(sessionId);
      }
      await refreshCurrentSelection(sessionId);
      setError(null);
    } catch (archiveError) {
      setError(archiveError instanceof Error ? archiveError.message : copy.archive);
    } finally {
      setBusy(null);
    }
  }

  async function handleRenameSession(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!renameSessionId) return;
    setBusy(`rename-${renameSessionId}`);
    try {
      await renameSession(renameSessionId, { title: renameTitle });
      await refreshCurrentSelection(renameSessionId);
      setRenameSessionId(null);
      setRenameTitle('');
      setError(null);
    } catch (renameError) {
      setError(renameError instanceof Error ? renameError.message : copy.rename);
    } finally {
      setBusy(null);
    }
  }

  async function handleDeleteSession(sessionId: string) {
    const session = bootstrap?.sessions.find((entry) => entry.id === sessionId);
    if (!session) return;
    const confirmed = window.confirm(copy.sessionDeletedConfirm.replace('{title}', session.title));
    if (!confirmed) return;

    setBusy(`delete-${sessionId}`);
    try {
      await deleteSession(sessionId);
      await refreshCurrentSelection(selectedSessionId === sessionId ? null : selectedSessionId);
      setError(null);
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : copy.delete);
    } finally {
      setBusy(null);
    }
  }

  function openRenameModal(sessionId: string, currentTitle: string) {
    setRenameSessionId(sessionId);
    setRenameTitle(currentTitle);
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
    setUserModalMode('edit');
    setEditingUserId(user.id);
    setUserForm({
      username: user.username,
      password: '',
      isAdmin: user.isAdmin,
      allowCode: user.allowedSessionTypes.includes('code'),
      allowChat: user.allowedSessionTypes.includes('chat'),
      canUseFullHost: user.canUseFullHost,
      regenerateToken: false,
    });
    setUserModalOpen(true);
  }

  async function handleUserSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const allowedSessionTypes = [
      ...(userForm.allowCode ? (['code'] as SessionType[]) : []),
      ...(userForm.allowChat ? (['chat'] as SessionType[]) : []),
    ];
    if (allowedSessionTypes.length === 0) {
      setError(language === 'zh' ? '至少选择一种会话类型。' : 'Pick at least one session type.');
      return;
    }

    setBusy(userModalMode === 'create' ? 'create-user' : `save-user-${editingUserId}`);
    try {
      if (userModalMode === 'create') {
        const response = await createAdminUser({
          username: userForm.username,
          password: userForm.password,
          isAdmin: userForm.isAdmin,
          allowedSessionTypes,
          canUseFullHost: userForm.allowCode ? userForm.canUseFullHost : false,
        });
        setAdminUsers(response.users);
      } else if (editingUserId) {
        const response = await updateAdminUser(editingUserId, {
          username: userForm.username,
          ...(userForm.password.trim() ? { password: userForm.password } : {}),
          isAdmin: userForm.isAdmin,
          allowedSessionTypes,
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
          <span>{bootstrap.sessions.length} {copy.sessions}</span>
          <span>{bootstrap.approvals.length} {copy.approvals}</span>
          <button type="button" className="button-secondary topbar-button" onClick={() => setLanguage((value) => (value === 'en' ? 'zh' : 'en'))}>
            {copy.languageButton}
          </button>
          {bootstrap.currentUser.isAdmin ? (
            <button type="button" className="button-secondary topbar-button" onClick={() => setAdminOpen(true)}>
              {copy.admin}
            </button>
          ) : null}
          <button type="button" className="button-secondary topbar-button" onClick={() => setSettingsOpen(true)}>
            {copy.settings}
          </button>
        </div>
      </header>

      {error ? (
        <div className="inline-banner inline-banner-error">
          {error}
        </div>
      ) : null}

      <section className="workspace">
        <aside className="panel rail">
          <div className="rail-header">
            <div>
              <p className="eyebrow">{copy.sessions}</p>
              <h2>{bootstrap.currentUser.username}</h2>
            </div>
            <div className="rail-actions">
              <button type="button" onClick={() => setNewSessionOpen(true)}>{copy.newSession}</button>
            </div>
          </div>

          <ul className="session-list">
            {activeSessions.length === 0 ? (
              <li className="session-empty">{copy.noActiveSessions}</li>
            ) : (
              activeSessions.map((session) => (
                <li
                  key={session.id}
                  className={`session-card ${selectedSessionId === session.id ? 'session-card-active' : ''}`}
                  onClick={() => setSelectedSessionId(session.id)}
                >
                  <div className="session-card-title">
                    <h3 title={session.title}>{session.title}</h3>
                  </div>
                  <div className="session-status-row">
                    <span className={`status-pill status-${session.status}`}>{STATUS_LABELS[language][session.status]}</span>
                  </div>
                </li>
              ))
            )}
          </ul>

          {archivedSessions.length > 0 ? (
            <>
              <div className="rail-subhead">
                <p className="eyebrow">{copy.archivedHistory}</p>
                <button type="button" className="button-secondary" onClick={() => setShowArchived((value) => !value)}>
                  {showArchived ? copy.hideArchived : `${copy.history} (${archivedSessions.length})`}
                </button>
              </div>
              {showArchived ? (
                <ul className="session-list archived-session-list">
                  {archivedSessions.map((session) => (
                    <li
                      key={session.id}
                      className={`session-card session-card-archived ${selectedSessionId === session.id ? 'session-card-active' : ''}`}
                      onClick={() => setSelectedSessionId(session.id)}
                    >
                      <div className="session-card-title">
                        <h3 title={session.title}>{session.title}</h3>
                      </div>
                      <div className="session-status-row">
                        <span className="status-pill status-idle">{copy.archived}</span>
                      </div>
                    </li>
                  ))}
                </ul>
              ) : null}
            </>
          ) : null}
        </aside>

        <section className="panel transcript">
          <div className="panel-header">
            <div className="session-title-row">
              <h2 title={detail?.session.workspace ?? undefined}>{detail?.session.title ?? copy.selectOrCreate}</h2>
              {detail ? (
                <button type="button" className="button-secondary info-button" onClick={() => setSessionInfoOpen(true)} title={copy.info} aria-label={copy.info}>
                  <InfoIcon />
                </button>
              ) : null}
            </div>
          </div>

          {detail ? (
            <div className="transcript-layout">
              <div className="transcript-scroll">
                <div className="view-tabs">
                  <button type="button" className={detailView === 'transcript' ? 'view-tab view-tab-active' : 'view-tab'} onClick={() => setDetailView('transcript')}>
                    {copy.transcript}
                  </button>
                  {!sessionIsChat ? (
                    <>
                      <button type="button" className={detailView === 'commands' ? 'view-tab view-tab-active' : 'view-tab'} onClick={() => setDetailView('commands')}>
                        {copy.commands} {commandEvents.length > 0 ? `(${commandEvents.length})` : ''}
                      </button>
                      <button type="button" className={detailView === 'changes' ? 'view-tab view-tab-active' : 'view-tab'} onClick={() => setDetailView('changes')}>
                        {copy.changes} {fileChanges.length > 0 ? `(${fileChanges.length})` : ''}
                      </button>
                    </>
                  ) : null}
                  <button type="button" className={detailView === 'activity' ? 'view-tab view-tab-active' : 'view-tab'} onClick={() => setDetailView('activity')}>
                    {copy.activity} {detail.liveEvents.length > 0 ? `(${detail.liveEvents.length})` : ''}
                  </button>
                </div>

                {sessionIsArchived ? (
                  <section className="runtime-alert runtime-alert-muted">
                    <div>
                      <p className="eyebrow">{copy.archivedEyebrow}</p>
                      <h3>{copy.historyMode}</h3>
                      <p>{copy.historyModeHint}</p>
                    </div>
                    <button
                      type="button"
                      onClick={() => void handleArchiveToggle(detail.session.id, false)}
                      disabled={busy === `restore-${detail.session.id}`}
                    >
                      {busy === `restore-${detail.session.id}` ? copy.restoring : copy.restoreSession}
                    </button>
                  </section>
                ) : detail.session.status === 'stale' ? (
                  <section className="runtime-alert">
                    <div>
                      <p className="eyebrow">{copy.runtimeReset}</p>
                      <h3>{copy.threadMissing}</h3>
                      <p>{detail.session.lastIssue ?? copy.autoRestartHint}</p>
                    </div>
                  </section>
                ) : null}

                {detailView === 'transcript' ? (
                  <div className="chat-list">
                    {threadEvents.length === 0 ? (
                      <article className="event-card event-status">
                        <div className="event-meta">
                          <span>{copy.sessionState}</span>
                          <strong>{copy.noTurnsYet}</strong>
                        </div>
                        <p>{copy.noTurnsHint}</p>
                      </article>
                    ) : (
                      threadEvents.map((event, index) => (
                        <article key={`${event.kind}-${index}`} className={`chat-message chat-${event.kind}`}>
                          {event.markdown ? (
                            <div className="markdown-body chat-body">
                              <ReactMarkdown remarkPlugins={[remarkGfm]}>
                                {event.body}
                              </ReactMarkdown>
                            </div>
                          ) : (
                            <pre className="event-body">{event.body}</pre>
                          )}
                        </article>
                      ))
                    )}
                  </div>
                ) : null}

                {detailView === 'commands' && !sessionIsChat ? (
                  <div className="detail-list">
                    {commandEvents.length === 0 ? (
                      <article className="detail-card">
                        <strong>{copy.noCommandsYet}</strong>
                        <p>{copy.noCommandsHint}</p>
                      </article>
                    ) : (
                      commandEvents.map((command) => (
                        <article key={command.id} className="detail-card">
                          <div className="detail-card-head">
                            <strong>{command.command}</strong>
                            <span>{command.status}{command.exitCode !== null ? ` · exit ${command.exitCode}` : ''}</span>
                          </div>
                          <p className="detail-card-meta">{command.cwd}</p>
                          <pre className="event-body">{command.output}</pre>
                        </article>
                      ))
                    )}
                  </div>
                ) : null}

                {detailView === 'changes' && !sessionIsChat ? (
                  <div className="detail-list">
                    {fileChanges.length === 0 ? (
                      <article className="detail-card">
                        <strong>{copy.noChangesYet}</strong>
                        <p>{copy.noChangesHint}</p>
                      </article>
                    ) : (
                      fileChanges.map((change) => (
                        <article key={change.id} className="detail-card">
                          <div className="detail-card-head">
                            <strong>{change.path}</strong>
                            <span>{change.kind} · {change.status}</span>
                          </div>
                          {change.diff ? <pre className="event-body">{change.diff}</pre> : <p className="detail-card-meta">{copy.noInlineDiff}</p>}
                        </article>
                      ))
                    )}
                  </div>
                ) : null}

                {detailView === 'activity' ? (
                  <div className="detail-list">
                    <article className="detail-card">
                      <div className="detail-card-head">
                        <strong>{copy.liveEvents}</strong>
                        <span>{detail.liveEvents.length}</span>
                      </div>
                      {detail.liveEvents.length === 0 ? (
                        <p className="detail-card-meta">{copy.noTransportEvents}</p>
                      ) : (
                        <div className="activity-stream">
                          {detail.liveEvents.map((event) => (
                            <div key={event.id} className="live-event-row">
                              <strong>{event.method}</strong>
                              <span>{event.summary}</span>
                            </div>
                          ))}
                        </div>
                      )}
                    </article>
                  </div>
                ) : null}
              </div>

              <form className="composer-form composer-docked" onSubmit={handleStartTurn}>
                {detail ? (
                  <div className="composer-config-row">
                    <label className="composer-config-field">
                      <span>{copy.model}</span>
                      <select
                        value={sessionModel}
                        onChange={(event) => handleSessionModelChange(event.target.value)}
                        disabled={busy === 'update-session-preferences' || availableModels.length === 0}
                      >
                        {availableModels.map((option) => (
                          <option key={option.id} value={option.model}>{option.displayName}</option>
                        ))}
                      </select>
                    </label>
                    <label className="composer-config-field">
                      <span>{copy.thinking}</span>
                      <select
                        value={sessionEffort}
                        onChange={(event) => handleSessionEffortChange(event.target.value as ReasoningEffort)}
                        disabled={busy === 'update-session-preferences'}
                      >
                        {currentSessionEfforts.map((effort) => (
                          <option key={effort} value={effort}>{effort}</option>
                        ))}
                      </select>
                    </label>
                  </div>
                ) : null}
                <label className="field">
                  <span>{copy.prompt}</span>
                  <div className="composer-row">
                    <textarea
                      value={prompt}
                      onChange={(event) => setPrompt(event.target.value)}
                      onKeyDown={handlePromptKeyDown}
                      onCompositionStart={handlePromptCompositionStart}
                      onCompositionEnd={handlePromptCompositionEnd}
                      rows={3}
                      placeholder={copy.prompt}
                      disabled={sessionIsArchived}
                    />
                    <div className="composer-actions">
                      {sessionHasActiveTurn ? (
                        <button
                          type="button"
                          className="stop-button"
                          onClick={() => void handleStopActiveTurn()}
                          disabled={busy === 'stop-session'}
                          title={busy === 'stop-session' ? copy.stopping : copy.stop}
                          aria-label={busy === 'stop-session' ? copy.stopping : copy.stop}
                        >
                          <StopIcon />
                        </button>
                      ) : null}
                      <button
                        type="submit"
                        className="send-button"
                        disabled={busy === 'start-turn' || busy === 'stop-session' || sessionIsArchived || sessionHasActiveTurn || !prompt.trim()}
                        title={sessionIsArchived ? copy.restoreRequired : sessionHasActiveTurn ? copy.stop : busy === 'start-turn' ? copy.sending : copy.sendPrompt}
                        aria-label={sessionIsArchived ? copy.restoreRequired : sessionHasActiveTurn ? copy.stop : busy === 'start-turn' ? copy.sending : copy.sendPrompt}
                      >
                        <SendIcon />
                      </button>
                    </div>
                  </div>
                </label>
              </form>
            </div>
          ) : (
            <section className="empty-state">
              <p className="eyebrow">{copy.noActiveSelection}</p>
              <h2>{copy.pickSessionHint}</h2>
            </section>
          )}
        </section>

        <aside className="panel approvals">
          <div className="panel-header">
            <p className="eyebrow">{copy.approvalCenter}</p>
            <h2>{detail?.approvals.length ?? bootstrap.approvals.length} {copy.pendingRequests}</h2>
          </div>
          <div className="approval-list">
            {(detail?.approvals ?? []).length === 0 ? (
              <article className="approval-card">
                <div className="approval-head">
                  <strong>{copy.noPendingApprovals}</strong>
                  <span>codex</span>
                </div>
                <p>{copy.approvalsHint}</p>
              </article>
            ) : (
              detail?.approvals.map((approval) => (
                <article key={approval.id} className="approval-card">
                  <div className="approval-head">
                    <strong>{approval.title}</strong>
                    <span>{approval.source}</span>
                  </div>
                  <p>{approval.risk}</p>
                  <div className="approval-actions">
                    <button type="button" onClick={() => void handleApprovalAction(approval, 'accept', 'once')} disabled={busy === approval.id}>
                      {copy.approveOnce}
                    </button>
                    <button type="button" onClick={() => void handleApprovalAction(approval, 'accept', 'session')} disabled={busy === approval.id}>
                      {copy.approveSession}
                    </button>
                    <button type="button" className="button-secondary" onClick={() => void handleApprovalAction(approval, 'decline', 'once')} disabled={busy === approval.id}>
                      {copy.decline}
                    </button>
                  </div>
                </article>
              ))
            )}
          </div>
        </aside>
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

            <section className="detail-summary-grid">
              <article className="summary-card">
                <p className="eyebrow">{copy.currentUser}</p>
                <strong>{bootstrap.currentUser.username}</strong>
                <p>{bootstrap.currentUser.isAdmin ? copy.adminRole : copy.users}</p>
              </article>
              <article className="summary-card">
                <p className="eyebrow">{copy.defaults}</p>
                <strong>{bootstrap.defaults.defaultSecurityProfile}</strong>
                <p>{bootstrap.defaults.networkEnabledByDefault ? copy.networkOnByDefault : copy.networkOffByDefault}</p>
              </article>
              <article className="summary-card">
                <p className="eyebrow">{copy.currentSession}</p>
                <strong>{detail?.session.title ?? copy.noActiveSession}</strong>
                <p>{detail?.session.workspace ?? copy.inspectWorkspaceHint}</p>
              </article>
              <article className="summary-card">
                <p className="eyebrow">{copy.remoteAccess}</p>
                <strong>{cloudflare ? `${CLOUDFLARE_STATE_LABELS[language][cloudflare.state]} tunnel` : copy.tunnelUnavailable}</strong>
                <p>{cloudflare?.publicUrl ?? cloudflare?.targetUrl ?? copy.noPublicUrl}</p>
              </article>
            </section>

            <section className="settings-section">
              <div className="settings-section-head">
                <strong>{copy.remoteAccess}</strong>
                <span>{cloudflare?.mode ?? copy.tunnelUnavailable}</span>
              </div>
              {cloudflare?.publicUrl ? (
                <p className="remote-access-url">
                  <a href={cloudflare.publicUrl} target="_blank" rel="noreferrer">
                    {cloudflare.publicUrl}
                  </a>
                </p>
              ) : null}
              {cloudflare?.lastError ? <p className="remote-access-error">{cloudflare.lastError}</p> : null}
              <div className="remote-button-row">
                <button
                  type="button"
                  onClick={() => void handleConnectCloudflare()}
                  disabled={!cloudflare?.installed || busy === 'connect-cloudflare' || cloudflare?.state === 'connecting' || cloudflareManagedBySystem}
                >
                  {cloudflareManagedBySystem
                    ? copy.tunnelLive
                    : busy === 'connect-cloudflare' || cloudflare?.state === 'connecting'
                      ? copy.connecting
                      : copy.connectTunnel}
                </button>
                <button
                  type="button"
                  className="button-secondary"
                  onClick={() => void handleDisconnectCloudflare()}
                  disabled={!cloudflare?.installed || !cloudflareManagedLocally || busy === 'disconnect-cloudflare'}
                >
                  {cloudflareManagedBySystem
                    ? copy.managedBySystem
                    : busy === 'disconnect-cloudflare'
                      ? copy.disconnecting
                      : copy.disconnect}
                </button>
              </div>
            </section>

            <section className="settings-section">
              <div className="settings-section-head">
                <strong>{copy.account}</strong>
                <span>{bootstrap.defaults.executor}</span>
              </div>
              <p className="detail-card-meta">{copy.accountHint}</p>
              <button type="button" className="button-secondary settings-signout" onClick={() => void handleLogout()} disabled={busy === 'logout'}>
                {busy === 'logout' ? copy.signingOut : copy.signOut}
              </button>
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
                    <div className="detail-card-head">
                      <strong>{user.username}</strong>
                      <span>{user.isAdmin ? copy.adminRole : copy.users}</span>
                    </div>
                    <p className="detail-card-meta">{copy.allowedSessionTypes}: {user.allowedSessionTypes.join(', ')}</p>
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
                  </article>
                ))
              )}
            </div>
          </aside>
        </div>
      ) : null}

      {sessionInfoOpen && detail ? (
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
                  <span>{STATUS_LABELS[language][detail.session.status]}</span>
                </div>
                <div className="info-actions">
                  <button
                    type="button"
                    onClick={() => {
                      setSessionInfoOpen(false);
                      openRenameModal(detail.session.id, detail.session.title);
                    }}
                    disabled={busy === `rename-${detail.session.id}`}
                  >
                    {busy === `rename-${detail.session.id}` ? copy.renaming : copy.rename}
                  </button>
                  {detail.session.archivedAt ? (
                    <button
                      type="button"
                      onClick={() => {
                        setSessionInfoOpen(false);
                        void handleArchiveToggle(detail.session.id, false);
                      }}
                      disabled={busy === `restore-${detail.session.id}`}
                    >
                      {busy === `restore-${detail.session.id}` ? copy.restoring : copy.restore}
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={() => {
                        setSessionInfoOpen(false);
                        void handleArchiveToggle(detail.session.id, true);
                      }}
                      disabled={busy === `archive-${detail.session.id}`}
                    >
                      {busy === `archive-${detail.session.id}` ? copy.archiving : copy.archive}
                    </button>
                  )}
                  <button
                    type="button"
                    className="button-danger"
                    onClick={() => {
                      setSessionInfoOpen(false);
                      void handleDeleteSession(detail.session.id);
                    }}
                    disabled={busy === `delete-${detail.session.id}`}
                  >
                    {busy === `delete-${detail.session.id}` ? copy.deleting : copy.delete}
                  </button>
                </div>
                <p className="detail-card-meta">{copy.workspace}: {detail.session.workspace}</p>
                <p className="detail-card-meta">{copy.sessionOwner}: {detail.session.ownerUsername}</p>
                <p className="detail-card-meta">{copy.securityLabel}: {detail.session.securityProfile}</p>
                <p className="detail-card-meta">{copy.modelLabel}: {detail.session.model ?? 'codex'}</p>
                <p className="detail-card-meta">{copy.thinkingLabel}: {detail.session.reasoningEffort ?? 'medium'}</p>
                <p className="detail-card-meta">{copy.threadLabel}: {shortThreadId(detail.session.threadId)}</p>
                <p className="detail-card-meta">{copy.createdAt} {formatTimestamp(detail.session.createdAt, language)}</p>
                <p className="detail-card-meta">{copy.updatedAt} {formatTimestamp(detail.session.updatedAt, language)}</p>
                {detail.session.lastIssue ? <p>{detail.session.lastIssue}</p> : null}
              </article>

              {sessionIsChat ? (
                <article className="detail-card">
                  <strong>{copy.chatSessionHint}</strong>
                  <p>{copy.commandToolingHidden}</p>
                </article>
              ) : null}

              <article className="detail-card">
                <div className="detail-card-head">
                  <strong>{copy.liveEvents}</strong>
                  <span>{detail.liveEvents.length}</span>
                </div>
                {detail.liveEvents.length === 0 ? (
                  <p className="detail-card-meta">{copy.noTransportEvents}</p>
                ) : (
                  <div className="activity-stream">
                    {detail.liveEvents.map((event) => (
                      <div key={event.id} className="live-event-row">
                        <strong>{event.method}</strong>
                        <span>{event.summary}</span>
                      </div>
                    ))}
                  </div>
                )}
              </article>
            </div>
          </div>
        </div>
      ) : null}

      {newSessionOpen ? (
        <div className="modal-overlay" onClick={() => setNewSessionOpen(false)}>
          <div className="modal-card" onClick={(event) => event.stopPropagation()}>
            <div className="panel-header settings-header">
              <div>
                <p className="eyebrow">{copy.newSession}</p>
                <h2>{copy.newSessionTitle}</h2>
              </div>
              <button type="button" className="button-secondary topbar-button" onClick={() => setNewSessionOpen(false)}>
                {copy.close}
              </button>
            </div>

            <form className="create-form" onSubmit={handleCreateSession}>
              <label className="field">
                <span>{copy.sessionType}</span>
                <select value={newSessionType} onChange={(event) => setNewSessionType(event.target.value as SessionType)}>
                  {bootstrap.currentUser.allowedSessionTypes.includes('code') ? <option value="code">{copy.codeSession}</option> : null}
                  {bootstrap.currentUser.allowedSessionTypes.includes('chat') ? <option value="chat">{copy.chatSession}</option> : null}
                </select>
              </label>

              {newSessionType === 'code' ? (
                <>
                  <label className="field">
                    <span>{copy.workspace}</span>
                    <input value={workspace} onChange={(event) => setWorkspace(event.target.value)} />
                  </label>
                  <label className="field">
                    <span>{copy.securityProfile}</span>
                    <select value={securityProfile} onChange={(event) => setSecurityProfile(event.target.value as 'repo-write' | 'full-host')}>
                      <option value="repo-write">{copy.repoWriteProfile}</option>
                      {bootstrap.currentUser.canUseFullHost ? <option value="full-host">{copy.fullHostProfile}</option> : null}
                    </select>
                  </label>
                </>
              ) : (
                <article className="detail-card">
                  <strong>{copy.readOnlyProfile}</strong>
                  <p>{copy.chatSessionHint}</p>
                </article>
              )}

              <label className="field">
                <span>{copy.title}</span>
                <input value={title} onChange={(event) => setTitle(event.target.value)} placeholder={copy.optionalSessionTitle} />
              </label>

              <button type="submit" disabled={busy === 'create-session'}>
                {busy === 'create-session' ? copy.creating : copy.createSession}
              </button>
            </form>
          </div>
        </div>
      ) : null}

      {renameSessionId ? (
        <div className="modal-overlay" onClick={() => {
          setRenameSessionId(null);
          setRenameTitle('');
        }}>
          <div className="modal-card" onClick={(event) => event.stopPropagation()}>
            <div className="panel-header settings-header">
              <div>
                <p className="eyebrow">{copy.rename}</p>
                <h2>{copy.renameSessionTitle}</h2>
              </div>
              <button type="button" className="button-secondary topbar-button" onClick={() => {
                setRenameSessionId(null);
                setRenameTitle('');
              }}>
                {copy.close}
              </button>
            </div>

            <form className="create-form" onSubmit={handleRenameSession}>
              <label className="field">
                <span>{copy.title}</span>
                <input value={renameTitle} onChange={(event) => setRenameTitle(event.target.value)} placeholder={copy.optionalSessionTitle} />
              </label>
              <button type="submit" disabled={busy === `rename-${renameSessionId}`}>
                {busy === `rename-${renameSessionId}` ? copy.renaming : copy.saveName}
              </button>
            </form>
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
                  <span>{copy.chatSession}</span>
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
                  <span>{copy.codeSession}</span>
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
