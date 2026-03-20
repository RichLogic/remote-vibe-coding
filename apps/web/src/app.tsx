import { useEffect, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

import {
  archiveSession,
  connectCloudflareTunnel,
  createSession,
  deleteSession,
  disconnectCloudflareTunnel,
  fetchBootstrap,
  fetchSessionDetail,
  logout,
  renameSession,
  restartSession,
  resolveApproval,
  restoreSession,
  startTurn,
} from './api';
import type {
  BootstrapPayload,
  CodexThread,
  CodexThreadItem,
  PendingApproval,
  SessionDetailResponse,
  SessionStatus,
  TranscriptEventKind,
} from './types';

type DetailView = 'transcript' | 'commands' | 'changes' | 'activity';
type Language = 'en' | 'zh';

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
    hostUnavailable: 'Host unavailable',
    hostUnavailableTitle: 'Could not reach the local host service',
    hostUnavailableHint: 'Start `npm run dev:host` and refresh the page.',
    eyebrow: 'Codex-first remote coding',
    active: 'active',
    archived: 'archived',
    approvals: 'approvals',
    settings: 'Settings',
    sessions: 'Sessions',
    existingWork: 'Existing work',
    hideArchived: 'Hide archived',
    newSession: 'New session',
    noActiveSessions: 'No active sessions yet.',
    history: 'History',
    archivedSession: 'Archived session',
    archive: 'Archive',
    archiving: 'Archiving...',
    delete: 'Delete',
    deleting: 'Deleting...',
    rename: 'Rename',
    renaming: 'Renaming...',
    restore: 'Restore',
    restoring: 'Restoring...',
    codingSurface: 'Coding-first surface',
    selectOrCreate: 'Select or create a session',
    transcript: 'Transcript',
    commands: 'Commands',
    changes: 'Changes',
    activity: 'Activity',
    runtimeReset: 'Runtime reset detected',
    threadMissing: 'Codex no longer has this thread loaded',
    restartSession: 'Restart session',
    restarting: 'Restarting...',
    autoRestartHint: 'The next prompt will automatically create a fresh thread in the same workspace.',
    archivedEyebrow: 'Archived session',
    historyMode: 'This session is in history mode',
    historyModeHint: 'Restore it if you want to continue prompting in the same workspace.',
    restoreSession: 'Restore session',
    noTurnsYet: 'No turns yet',
    threadUnavailable: 'Thread unavailable',
    noTurnsHint: 'Start the first prompt from the composer below.',
    staleHint: 'This session needs a fresh thread before it can accept a new prompt.',
    noCommandsYet: 'No command executions yet',
    noCommandsHint: 'Command output from Codex will land here once the thread starts using tools.',
    noChangesYet: 'No file changes yet',
    noChangesHint: 'When Codex proposes edits, this view will show paths and inline diffs.',
    noInlineDiff: 'No inline diff payload was reported for this change.',
    sessionState: 'Session state',
    liveEvents: 'Live host events',
    noTransportEvents: 'No transport events captured yet.',
    createdAt: 'Created',
    updatedAt: 'Updated',
    prompt: 'Prompt',
    restoreRequired: 'Restore required',
    restartRequired: 'Restart required',
    sending: 'Sending...',
    sendPrompt: 'Send prompt',
    noActiveSelection: 'No active selection',
    pickSessionHint: 'Pick an existing session, or use the New session button to start a fresh Codex thread.',
    approvalCenter: 'Approval center',
    pendingRequests: 'pending request(s)',
    noPendingApprovals: 'No pending approvals',
    approvalsHint: 'Network, extra file access, and high-risk commands will appear here when Codex requests them.',
    approveOnce: 'Approve once',
    approveSession: 'Approve session',
    decline: 'Decline',
    settingsTitle: 'System information and controls',
    close: 'Close',
    product: 'Product',
    defaults: 'Defaults',
    currentSession: 'Current session',
    noActiveSession: 'No active session',
    inspectWorkspaceHint: 'Select a session to inspect its workspace.',
    remoteAccess: 'Remote access',
    tunnelUnavailable: 'Tunnel status unavailable',
    noPublicUrl: 'No public URL available yet',
    cloudflare: 'Cloudflare',
    notConnected: 'not connected',
    cloudflareMissing: 'cloudflared is not installed on this machine yet.',
    tunnelLive: 'Tunnel already live',
    connecting: 'Connecting...',
    connectTunnel: 'Connect tunnel',
    managedBySystem: 'Managed by system',
    disconnecting: 'Disconnecting...',
    disconnect: 'Disconnect',
    account: 'Account',
    accountHint: 'Use this panel for machine-level controls. Keep the main screen focused on session management and chat.',
    signingOut: 'Signing out...',
    signOut: 'Sign out',
    newSessionTitle: 'Create a workspace thread',
    renameSessionTitle: 'Rename session',
    workspace: 'Workspace',
    title: 'Title',
    optionalSessionTitle: 'Optional session title',
    securityProfile: 'Security profile',
    creating: 'Creating...',
    createSession: 'Create session',
    saveName: 'Save name',
    sessionLabel: 'Session',
    threadLabel: 'Thread',
    gitLabel: 'Git',
    runtimeLabel: 'Runtime',
    networkEnabled: 'Network enabled',
    networkDisabled: 'Network disabled',
    staleSession: 'stale session',
    freshThread: 'Fresh thread or not yet loaded',
    noGitMetadata: 'No git metadata',
    noRemoteReported: 'No remote reported yet',
    localHost: 'local host',
    browserShell: 'Codex-first browser shell',
    networkOnByDefault: 'Network on by default',
    networkOffByDefault: 'Network off by default',
    languageButton: '中文',
    archivedHistory: 'Archived',
    sessionDeletedConfirm: 'Delete "{title}" permanently? This only removes it from remote-vibe-coding.',
  },
  zh: {
    unknownError: '未知错误',
    hostUnavailable: '主机不可用',
    hostUnavailableTitle: '无法连接本地 Host 服务',
    hostUnavailableHint: '先启动 `npm run dev:host`，然后刷新页面。',
    eyebrow: 'Codex 优先的远程编码',
    active: '活跃',
    archived: '归档',
    approvals: '审批',
    settings: '设置',
    sessions: '会话',
    existingWork: '已有工作',
    hideArchived: '收起归档',
    newSession: '新建会话',
    noActiveSessions: '暂时还没有活跃会话。',
    history: '历史',
    archivedSession: '已归档会话',
    archive: '归档',
    archiving: '归档中...',
    delete: '删除',
    deleting: '删除中...',
    rename: '改名',
    renaming: '保存中...',
    restore: '恢复',
    restoring: '恢复中...',
    codingSurface: '开发工作区',
    selectOrCreate: '选择或新建一个会话',
    transcript: '聊天',
    commands: '命令',
    changes: '改动',
    activity: '活动',
    runtimeReset: '运行时已重置',
    threadMissing: 'Codex 已经不再持有这个 thread',
    restartSession: '重启会话',
    restarting: '重启中...',
    autoRestartHint: '你下一次发送消息时，会自动在同一个 workspace 里创建新的 thread。',
    archivedEyebrow: '已归档会话',
    historyMode: '这个会话目前处于历史模式',
    historyModeHint: '如果你想继续在同一个 workspace 里对话，先恢复它。',
    restoreSession: '恢复会话',
    noTurnsYet: '还没有对话',
    threadUnavailable: '线程不可用',
    noTurnsHint: '从下面的输入框发出第一条 prompt。',
    staleHint: '这个会话需要先创建一个新的 thread，才能继续输入。',
    noCommandsYet: '还没有命令执行',
    noCommandsHint: 'Codex 开始调用工具后，命令输出会显示在这里。',
    noChangesYet: '还没有文件改动',
    noChangesHint: '当 Codex 提议修改文件时，这里会显示路径和 diff。',
    noInlineDiff: '这条改动没有携带内联 diff。',
    sessionState: '会话状态',
    liveEvents: '实时 Host 事件',
    noTransportEvents: '暂时还没有传输层事件。',
    createdAt: '创建于',
    updatedAt: '更新于',
    prompt: '输入内容',
    restoreRequired: '需要先恢复',
    restartRequired: '需要先重启',
    sending: '发送中...',
    sendPrompt: '发送',
    noActiveSelection: '当前没有选中会话',
    pickSessionHint: '选择一个已有会话，或者用 New session 按钮开启新的 Codex thread。',
    approvalCenter: '审批中心',
    pendingRequests: '个待处理请求',
    noPendingApprovals: '没有待审批项',
    approvalsHint: '网络、额外文件访问和高风险命令会在 Codex 请求时出现在这里。',
    approveOnce: '仅批准这次',
    approveSession: '本会话内批准',
    decline: '拒绝',
    settingsTitle: '系统信息与控制',
    close: '关闭',
    product: '产品',
    defaults: '默认值',
    currentSession: '当前会话',
    noActiveSession: '当前没有活跃会话',
    inspectWorkspaceHint: '选中一个会话后，这里会显示它的 workspace。',
    remoteAccess: '远程访问',
    tunnelUnavailable: 'Tunnel 状态暂不可用',
    noPublicUrl: '还没有公网地址',
    cloudflare: 'Cloudflare',
    notConnected: '未连接',
    cloudflareMissing: '这台机器还没有安装 cloudflared。',
    tunnelLive: 'Tunnel 已经在线',
    connecting: '连接中...',
    connectTunnel: '连接 Tunnel',
    managedBySystem: '由系统托管',
    disconnecting: '断开中...',
    disconnect: '断开连接',
    account: '账户',
    accountHint: '这里放机器级的设置和控制，让主界面保持在 session 和 chat 上。',
    signingOut: '退出中...',
    signOut: '退出登录',
    newSessionTitle: '创建一个 workspace thread',
    renameSessionTitle: '修改会话名称',
    workspace: '工作目录',
    title: '标题',
    optionalSessionTitle: '可选的会话标题',
    securityProfile: '安全档位',
    creating: '创建中...',
    createSession: '创建会话',
    saveName: '保存名称',
    sessionLabel: '会话',
    threadLabel: '线程',
    gitLabel: 'Git',
    runtimeLabel: '运行时',
    networkEnabled: '已开启网络',
    networkDisabled: '未开启网络',
    staleSession: '已失效会话',
    freshThread: '新的 thread，或暂时还没加载',
    noGitMetadata: '没有 Git 元信息',
    noRemoteReported: '还没有上报远端仓库信息',
    localHost: '本地 host',
    browserShell: 'Codex 优先的浏览器壳',
    networkOnByDefault: '默认开启网络',
    networkOffByDefault: '默认关闭网络',
    languageButton: 'EN',
    archivedHistory: '归档',
    sessionDeletedConfirm: '确定永久删除 “{title}” 吗？这只会把它从 remote-vibe-coding 中移除。',
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
  const [workspace, setWorkspace] = useState('/Users/richlogic/code/remote-vibe-coding');
  const [title, setTitle] = useState('');
  const [securityProfile, setSecurityProfile] = useState<'repo-write' | 'full-host'>('repo-write');
  const [prompt, setPrompt] = useState('Inspect the current project and summarize what is already implemented.');
  const [busy, setBusy] = useState<string | null>(null);
  const [detailView, setDetailView] = useState<DetailView>('transcript');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [newSessionOpen, setNewSessionOpen] = useState(false);
  const [renameSessionId, setRenameSessionId] = useState<string | null>(null);
  const [renameTitle, setRenameTitle] = useState('');
  const [showArchived, setShowArchived] = useState(false);
  const copy = COPY[language];

  useEffect(() => {
    window.localStorage.setItem('rvc-language', language);
  }, [language]);

  useEffect(() => {
    let cancelled = false;

    async function loadBootstrap() {
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

    void loadBootstrap();
    const timer = window.setInterval(() => {
      void loadBootstrap();
    }, 2000);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [selectedSessionId]);

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
  }, [selectedSessionId]);

  async function handleCreateSession(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy('create-session');
    try {
      const session = await createSession({
        cwd: workspace,
        securityProfile,
        ...(title.trim() ? { title: title.trim() } : {}),
      });
      setTitle('');
      setNewSessionOpen(false);
      setSelectedSessionId(session.id);
      const nextBootstrap = await fetchBootstrap();
      setBootstrap(nextBootstrap);
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : copy.createSession);
    } finally {
      setBusy(null);
    }
  }

  async function handleStartTurn(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedSessionId) return;
    setBusy('start-turn');
    try {
      if (detail?.session.status === 'stale') {
        await restartSession(selectedSessionId);
      }
      await startTurn(selectedSessionId, { prompt });
      const [nextBootstrap, nextDetail] = await Promise.all([
        fetchBootstrap(),
        fetchSessionDetail(selectedSessionId),
      ]);
      setBootstrap(nextBootstrap);
      setDetail(nextDetail);
    } catch (turnError) {
      setError(turnError instanceof Error ? turnError.message : copy.sendPrompt);
    } finally {
      setBusy(null);
    }
  }

  async function handleArchiveToggle(sessionId: string, archived: boolean) {
    setBusy(`${archived ? 'archive' : 'restore'}-${sessionId}`);
    try {
      const session = archived ? await archiveSession(sessionId) : await restoreSession(sessionId);
      const nextBootstrap = await fetchBootstrap();
      setBootstrap(nextBootstrap);

      if (archived) {
        setShowArchived(true);
      }

      const nextSelectedSessionId = session.id;

      setSelectedSessionId(nextSelectedSessionId);
      if (nextSelectedSessionId) {
        setDetail(await fetchSessionDetail(nextSelectedSessionId));
      } else {
        setDetail(null);
      }
      setError(null);
    } catch (archiveError) {
      setError(archiveError instanceof Error ? archiveError.message : copy.archive);
    } finally {
      setBusy(null);
    }
  }

  async function handleRenameSession(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!renameSessionId) return;

    setBusy(`rename-${renameSessionId}`);
    try {
      const session = await renameSession(renameSessionId, { title: renameTitle });
      const [nextBootstrap, nextDetail] = await Promise.all([
        fetchBootstrap(),
        fetchSessionDetail(session.id),
      ]);
      setBootstrap(nextBootstrap);
      setDetail(nextDetail);
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
      const nextBootstrap = await fetchBootstrap();
      setBootstrap(nextBootstrap);

      const nextSelectedSessionId = selectedSessionId === sessionId
        ? pickPreferredSessionId(nextBootstrap.sessions)
        : selectedSessionId;

      setSelectedSessionId(nextSelectedSessionId);
      if (nextSelectedSessionId) {
        setDetail(await fetchSessionDetail(nextSelectedSessionId));
      } else {
        setDetail(null);
      }
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
      const currentSessionId = selectedSessionId;
      if (currentSessionId) {
        const [nextBootstrap, nextDetail] = await Promise.all([
          fetchBootstrap(),
          fetchSessionDetail(currentSessionId),
        ]);
        setBootstrap(nextBootstrap);
        setDetail(nextDetail);
      }
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

  const threadEvents = flattenThread(detail?.thread ?? null);
  const commandEvents = collectCommands(detail?.thread ?? null);
  const fileChanges = collectFileChanges(detail?.thread ?? null);
  const cloudflare = bootstrap?.cloudflare;
  const cloudflareManagedBySystem = cloudflare?.activeSource === 'system';
  const cloudflareManagedLocally = cloudflare?.activeSource === 'local-manager';
  const sessionIsStale = detail?.session.status === 'stale';
  const sessionIsArchived = Boolean(detail?.session.archivedAt);
  const threadStatus = detail?.thread?.status && typeof detail.thread.status === 'object' ? detail.thread.status.type : 'idle';
  const sessionGitLabel = detail?.thread?.gitInfo?.branch
    ? `${detail.thread.gitInfo.branch}${detail.thread.gitInfo.sha ? ` @ ${detail.thread.gitInfo.sha.slice(0, 7)}` : ''}`
    : copy.noGitMetadata;
  const activeSessions = (bootstrap?.sessions ?? []).filter((session) => !session.archivedAt);
  const archivedSessions = (bootstrap?.sessions ?? []).filter((session) => Boolean(session.archivedAt));

  if (error && !bootstrap) {
    return (
      <main className="shell shell-error">
        <section className="error-card">
          <p className="eyebrow">{copy.hostUnavailable}</p>
          <h1>{copy.hostUnavailableTitle}</h1>
          <p>{error}</p>
          <p>{copy.hostUnavailableHint}</p>
        </section>
      </main>
    );
  }

  return (
    <main className="shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">{copy.eyebrow}</p>
          <h1>{bootstrap?.productName ?? 'remote-vibe-coding'}</h1>
        </div>
        <div className="topbar-meta">
          <span>{activeSessions.length} {copy.active}</span>
          {archivedSessions.length > 0 ? <span>{archivedSessions.length} {copy.archived}</span> : null}
          <span>{bootstrap?.approvals.length ?? 0} {copy.approvals}</span>
          <button type="button" className="button-secondary topbar-button" onClick={() => setLanguage((value) => value === 'zh' ? 'en' : 'zh')}>
            {copy.languageButton}
          </button>
          <button type="button" className="button-secondary topbar-button" onClick={() => setSettingsOpen(true)}>
            {copy.settings}
          </button>
        </div>
      </header>

      <section className="workspace">
        <aside className="panel rail">
          <div className="panel-header rail-header">
            <div>
              <p className="eyebrow">{copy.sessions}</p>
              <h2>{copy.existingWork}</h2>
            </div>
            <div className="rail-actions">
              {archivedSessions.length > 0 ? (
                <button type="button" className="button-secondary" onClick={() => setShowArchived((value) => !value)}>
                  {showArchived ? copy.hideArchived : `${copy.archivedHistory} (${archivedSessions.length})`}
                </button>
              ) : null}
              <button type="button" onClick={() => setNewSessionOpen(true)} disabled={busy === 'create-session'}>
                {copy.newSession}
              </button>
            </div>
          </div>

          <ul className="session-list">
            {activeSessions.length === 0 ? (
              <li className="session-empty">{copy.noActiveSessions}</li>
            ) : activeSessions.map((session) => (
              <li
                key={session.id}
                className={`session-card ${selectedSessionId === session.id ? 'session-card-active' : ''}`}
                onClick={() => setSelectedSessionId(session.id)}
              >
                <div className="session-row session-card-head">
                  <h3>{session.title}</h3>
                  <span className={`status-pill status-${session.status}`}>{STATUS_LABELS[language][session.status]}</span>
                </div>
                {selectedSessionId === session.id ? (
                  <div className="session-actions" onClick={(event) => event.stopPropagation()}>
                    <button
                      type="button"
                      className="button-secondary"
                      onClick={() => openRenameModal(session.id, session.title)}
                      disabled={busy === `rename-${session.id}`}
                    >
                      {busy === `rename-${session.id}` ? copy.renaming : copy.rename}
                    </button>
                    <button
                      type="button"
                      className="button-secondary"
                      onClick={() => void handleArchiveToggle(session.id, true)}
                      disabled={busy === `archive-${session.id}`}
                    >
                      {busy === `archive-${session.id}` ? copy.archiving : copy.archive}
                    </button>
                    <button
                      type="button"
                      className="button-danger"
                      onClick={() => void handleDeleteSession(session.id)}
                      disabled={busy === `delete-${session.id}`}
                    >
                      {busy === `delete-${session.id}` ? copy.deleting : copy.delete}
                    </button>
                  </div>
                ) : null}
              </li>
            ))}
          </ul>

          {showArchived && archivedSessions.length > 0 ? (
            <>
              <div className="rail-subhead">
                <p className="eyebrow">{copy.archivedHistory}</p>
                <h2>{copy.history}</h2>
              </div>
              <ul className="session-list archived-session-list">
                {archivedSessions.map((session) => (
                  <li
                    key={session.id}
                    className={`session-card session-card-archived ${selectedSessionId === session.id ? 'session-card-active' : ''}`}
                    onClick={() => setSelectedSessionId(session.id)}
                  >
                    <div className="session-row session-card-head">
                      <h3>{session.title}</h3>
                      <span className="status-pill status-idle">{copy.archived}</span>
                    </div>
                    {selectedSessionId === session.id ? (
                      <div className="session-actions" onClick={(event) => event.stopPropagation()}>
                        <button
                          type="button"
                          className="button-secondary"
                          onClick={() => openRenameModal(session.id, session.title)}
                          disabled={busy === `rename-${session.id}`}
                        >
                          {busy === `rename-${session.id}` ? copy.renaming : copy.rename}
                        </button>
                        <button
                          type="button"
                          className="button-secondary"
                          onClick={() => void handleArchiveToggle(session.id, false)}
                          disabled={busy === `restore-${session.id}`}
                        >
                          {busy === `restore-${session.id}` ? copy.restoring : copy.restore}
                        </button>
                        <button
                          type="button"
                          className="button-danger"
                          onClick={() => void handleDeleteSession(session.id)}
                          disabled={busy === `delete-${session.id}`}
                        >
                          {busy === `delete-${session.id}` ? copy.deleting : copy.delete}
                        </button>
                      </div>
                    ) : null}
                  </li>
                ))}
              </ul>
            </>
          ) : null}
        </aside>

        <section className="panel transcript">
          <div className="panel-header">
            <p className="eyebrow">{copy.codingSurface}</p>
            <h2>{detail?.session.title ?? copy.selectOrCreate}</h2>
          </div>

          {detail ? (
            <div className="transcript-layout">
              <div className="transcript-scroll">
                <div className="view-tabs">
                  <button type="button" className={detailView === 'transcript' ? 'view-tab view-tab-active' : 'view-tab'} onClick={() => setDetailView('transcript')}>
                    {copy.transcript}
                  </button>
                  <button type="button" className={detailView === 'commands' ? 'view-tab view-tab-active' : 'view-tab'} onClick={() => setDetailView('commands')}>
                    {copy.commands} {commandEvents.length > 0 ? `(${commandEvents.length})` : ''}
                  </button>
                  <button type="button" className={detailView === 'changes' ? 'view-tab view-tab-active' : 'view-tab'} onClick={() => setDetailView('changes')}>
                    {copy.changes} {fileChanges.length > 0 ? `(${fileChanges.length})` : ''}
                  </button>
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
                      onClick={() => detail && void handleArchiveToggle(detail.session.id, false)}
                      disabled={!detail || busy === `restore-${detail.session.id}`}
                    >
                      {!detail || busy !== `restore-${detail.session.id}` ? copy.restoreSession : copy.restoring}
                    </button>
                  </section>
                ) : sessionIsStale ? (
                  <section className="runtime-alert">
                    <div>
                      <p className="eyebrow">{copy.runtimeReset}</p>
                      <h3>{copy.threadMissing}</h3>
                      <p>{detail.session.lastIssue ?? copy.autoRestartHint}</p>
                    </div>
                  </section>
                ) : null}

                {detailView !== 'transcript' ? (
                  <>
                    <div className="detail-meta">
                      <span>{detail.session.workspace}</span>
                      <span>{detail.session.securityProfile}</span>
                      <span>{detail.session.networkEnabled ? copy.networkEnabled : copy.networkDisabled}</span>
                      <span>{sessionIsStale ? copy.staleSession : threadStatus}</span>
                    </div>

                    <section className="detail-summary-grid">
                      <article className="summary-card">
                        <p className="eyebrow">{copy.sessionLabel}</p>
                        <strong>{detail.session.title}</strong>
                        <p>{detail.session.workspace}</p>
                      </article>
                      <article className="summary-card">
                        <p className="eyebrow">{copy.threadLabel}</p>
                        <strong>{shortThreadId(detail.session.threadId)}</strong>
                        <p>{detail.thread?.path ?? copy.freshThread}</p>
                      </article>
                      <article className="summary-card">
                        <p className="eyebrow">{copy.gitLabel}</p>
                        <strong>{sessionGitLabel}</strong>
                        <p>{detail.thread?.gitInfo?.originUrl ?? copy.noRemoteReported}</p>
                      </article>
                      <article className="summary-card">
                        <p className="eyebrow">{copy.runtimeLabel}</p>
                        <strong>{detail.thread?.modelProvider ?? 'codex'}</strong>
                        <p>
                          {detail.thread?.source ?? copy.localHost}
                          {detail.thread?.cliVersion ? ` · CLI ${detail.thread.cliVersion}` : ''}
                        </p>
                      </article>
                    </section>
                  </>
                ) : null}

                {detailView === 'transcript' ? (
                  <div className="chat-list">
                    {threadEvents.length === 0 ? (
                      <article className="event-card event-status">
                        <div className="event-meta">
                          <span>{copy.sessionState}</span>
                          <strong>{sessionIsStale ? copy.threadUnavailable : copy.noTurnsYet}</strong>
                        </div>
                        <p>
                          {sessionIsStale
                            ? copy.staleHint
                            : copy.noTurnsHint}
                        </p>
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

                {detailView === 'commands' ? (
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

                {detailView === 'changes' ? (
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
                        <strong>{copy.sessionState}</strong>
                        <span>{STATUS_LABELS[language][detail.session.status]}</span>
                      </div>
                      <p className="detail-card-meta">{copy.createdAt} {formatTimestamp(detail.session.createdAt, language)}</p>
                      <p className="detail-card-meta">{copy.updatedAt} {formatTimestamp(detail.session.updatedAt, language)}</p>
                      {detail.session.lastIssue ? <p>{detail.session.lastIssue}</p> : null}
                    </article>

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
                <label className="field">
                  <span>{copy.prompt}</span>
                  <textarea
                    value={prompt}
                    onChange={(event) => setPrompt(event.target.value)}
                    rows={5}
                    disabled={sessionIsArchived}
                  />
                </label>
                <button type="submit" disabled={busy === 'start-turn' || sessionIsArchived}>
                  {sessionIsArchived ? copy.restoreRequired : busy === 'start-turn' ? copy.sending : copy.sendPrompt}
                </button>
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
            <h2>{detail?.approvals.length ?? bootstrap?.approvals.length ?? 0} {copy.pendingRequests}</h2>
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
                <p className="eyebrow">{copy.product}</p>
                <strong>{bootstrap?.productName ?? 'remote-vibe-coding'}</strong>
                <p>{language === 'zh' ? copy.browserShell : (bootstrap?.subtitle ?? copy.browserShell)}</p>
              </article>
              <article className="summary-card">
                <p className="eyebrow">{copy.defaults}</p>
                <strong>{bootstrap?.defaults.defaultSecurityProfile ?? 'repo-write'}</strong>
                <p>{bootstrap?.defaults.networkEnabledByDefault ? copy.networkOnByDefault : copy.networkOffByDefault}</p>
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
                <strong>{copy.cloudflare}</strong>
                <span>{cloudflare?.mode ?? copy.notConnected}</span>
              </div>
              <p className="detail-card-meta">
                {cloudflare?.installed
                  ? (language === 'zh'
                    ? `当前指向 ${cloudflare.targetSource} 提供的 ${cloudflare.targetUrl}。`
                    : `Targeting ${cloudflare.targetUrl} from ${cloudflare.targetSource}.`)
                  : copy.cloudflareMissing}
              </p>
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
                <span>{bootstrap?.defaults.executor ?? 'codex'}</span>
              </div>
              <p className="detail-card-meta">{copy.accountHint}</p>
              <button type="button" className="button-secondary settings-signout" onClick={() => void handleLogout()} disabled={busy === 'logout'}>
                {busy === 'logout' ? copy.signingOut : copy.signOut}
              </button>
            </section>
          </aside>
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
                <span>{copy.workspace}</span>
                <input value={workspace} onChange={(event) => setWorkspace(event.target.value)} />
              </label>
              <label className="field">
                <span>{copy.title}</span>
                <input value={title} onChange={(event) => setTitle(event.target.value)} placeholder={copy.optionalSessionTitle} />
              </label>
              <label className="field">
                <span>{copy.securityProfile}</span>
                <select value={securityProfile} onChange={(event) => setSecurityProfile(event.target.value as 'repo-write' | 'full-host')}>
                  <option value="repo-write">repo-write</option>
                  <option value="full-host">full-host</option>
                </select>
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
    </main>
  );
}
