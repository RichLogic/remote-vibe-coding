import { execFile } from 'node:child_process';
import { mkdir, readFile, readdir, stat, unlink, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { basename, extname, join, resolve } from 'node:path';
import { promisify } from 'node:util';

import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import cors from '@fastify/cors';
import fastifyCookie from '@fastify/cookie';
import fastifyMultipart from '@fastify/multipart';
import { PDFParse } from 'pdf-parse';

import { normalizeApprovalMode } from './approval-mode.js';
import { normalizeAgentExecutor } from './executor.js';
import { normalizeChatGeneratedTitle, normalizeGeneratedTitle } from './generated-title.js';
import {
  AUTH_COOKIE_NAME,
  loginPageHtml,
} from './auth.js';
import { AdminUserService } from './app/admin-user-service.js';
import {
  createChatConversationService,
} from './app/chat-conversation-service.js';
import { createChatTurnService } from './app/chat-turn-service.js';
import {
  CodingWorkspaceServiceError,
  createCodingWorkspaceService,
} from './app/coding-workspace-service.js';
import { createRuntimeNotificationHandler } from './app/codex-notification-handler.js';
import { createRuntimeServerRequestHandler } from './app/codex-server-request-handler.js';
import { createDeveloperSessionService } from './app/developer-session-create-service.js';
import { initializeHostRuntime } from './app/host-runtime.js';
import { generateChatConversationSummary } from './app/chat-summary-service.js';
import { registerRequestAuthHook, type AuthenticatedRequest } from './app/request-auth-hook.js';
import { bindRuntimeEvents } from './app/runtime-events.js';
import { createSessionForkService } from './app/session-fork-service.js';
import { createSessionRestartService } from './app/session-restart-service.js';
import { createTurnStartService } from './app/turn-start-service.js';
import { createUserWorkspaceService } from './app/user-workspace-service.js';
import { registerWebClientServing } from './app/web-client-serving.js';
import { buildBootstrapPayload, buildCodingBootstrapPayload } from './bootstrap.js';
import {
  type ChatMessageRecord,
  type PersistedChatAttachmentRef,
} from './chat-history.js';
import { ChatPromptConfigStore } from './chat-prompt-config.js';
import {
  buildChatBootstrapPayload,
  buildChatConversationDetailResponse,
  toApiChatConversation,
  unavailableChatConversationPatch as createUnavailableChatConversationPatch,
} from './chat-presentation.js';
import { registerAdminRoutes } from './routes/admin-routes.js';
import { registerChatRoutes } from './routes/chat-routes.js';
import { registerCodingRoutes } from './routes/coding-routes.js';
import { registerCoreRoutes } from './routes/core-routes.js';
import { registerSessionRoutes } from './routes/session-routes.js';
import { registerWorkspaceRoutes } from './routes/workspace-routes.js';
import { buildPersistedCodingHistory, summarizePersistedCodingHistory } from './coding/history.js';
import { normalizeWorkspaceFilePath } from './workspace-paths.js';
import type { CodingSessionRecord as SessionRecord } from './coding/types.js';
import type {
  CodingBootstrapPayload,
  CodingWorkspaceSummary,
  CreateCodingWorkspaceRequest,
  CreateCodingWorkspaceSessionRequest,
  ReorderCodingWorkspacesRequest,
  UpdateCodingWorkspaceRequest,
} from './coding/types.js';
import { DEV_DISABLE_AUTH, HOST, PORT, WEB_DIST_DIR, WORKSPACE_ROOT } from './config.js';
import type {
  ApprovalMode,
  AgentExecutor,
  CodexThread,
  CodexTurn,
  CodexThreadInput,
  CodexThreadItem,
  ConversationRecord,
  CreateConversationRequest,
  CreateSessionRequest,
  CreateTurnRequest,
  ModelOption,
  ReasoningEffort,
  ResolveApprovalRequest,
  SessionAttachmentKind,
  SessionAttachmentRecord,
  SessionAttachmentSummary,
  SecurityProfile,
  SessionCommandEvent,
  SessionEvent,
  SessionFileChangeEvent,
  SessionStatus,
  SessionTranscriptEntry,
  SessionType,
  UpdateConversationRequest,
  UpdateSessionRequest,
  UpdateSessionPreferencesRequest,
  UserRecord,
  WorkspaceSummary,
} from './types.js';

type TurnRecord = ConversationRecord | SessionRecord;

const CHAT_PERMISSION_BLOCK_RULES: Array<{
  pattern: RegExp;
  reason: string;
}> = [
  {
    pattern: /\b(?:npm|pnpm|yarn|bun)\s+(?:install|add|create|dlx)\b/i,
    reason: 'Blocked Node package installation or scaffolding request.',
  },
  {
    pattern: /\b(?:pip|pip3|pipx|poetry|uv\s+pip|uv\s+tool)\s+(?:install|add|sync)\b/i,
    reason: 'Blocked Python package installation request.',
  },
  {
    pattern: /\b(?:gem|bundle)\s+install\b/i,
    reason: 'Blocked Ruby package installation request.',
  },
  {
    pattern: /\b(?:cargo)\s+install\b/i,
    reason: 'Blocked Rust package installation request.',
  },
  {
    pattern: /\b(?:go)\s+(?:install|get)\b/i,
    reason: 'Blocked Go package installation request.',
  },
  {
    pattern: /\b(?:brew|apt(?:-get)?|yum|dnf|pacman|apk|zypper|winget|choco|scoop)\s+install\b/i,
    reason: 'Blocked system package installation request.',
  },
  {
    pattern: /\b(?:docker|podman)\s+pull\b/i,
    reason: 'Blocked container image download request.',
  },
  {
    pattern: /\b(?:git|hg)\s+clone\b|\bsvn\s+checkout\b/i,
    reason: 'Blocked repository download request.',
  },
  {
    pattern: /\b(?:curl|wget)\b[^\n\r]{0,160}\b(?:-O|--remote-name|-o|--output)\b/i,
    reason: 'Blocked command-line file download request.',
  },
  {
    pattern: /\b(?:Invoke-WebRequest|Start-BitsTransfer|certutil)\b/i,
    reason: 'Blocked OS-level download request.',
  },
];

const CHAT_TRANSITION_ONLY_REPLY_PATTERNS = [
  /^(?:我|让我|我先|让我先|先)(?:去|来)?(?:查|查看|搜|搜索|检索|确认|了解|看看|看一下)(?:一下|下)?(?:[^。！？!?]*)[。！？!?]?$/u,
  /^(?:我|让我|我先|让我先|先)(?:去|来)?(?:看看|查查)(?:[^。！？!?]*)[。！？!?]?$/u,
  /^(?:I(?:'|’)ll|I will|Let me|Let me first|First,?\s*I(?:'|’)ll)\s+(?:check|look up|search|verify|take a look)(?:[^.!?\n]*)[.!?]?$/i,
  /^(?:One moment|Hang on|Let me check)(?:[^.!?\n]*)[.!?]?$/i,
];

const CHAT_EMPTY_REPLY_MESSAGE = 'Chat turn ended before returning a real answer.';
const CHAT_INTERRUPTED_MESSAGE = 'This turn was interrupted before it finished. Send the next prompt to retry.';
const CHAT_ATTACHMENT_REPLY_MAX_CHARS = 12_000;
const CHAT_ATTACHMENT_REPLY_MAX_LINES = 220;
const CHAT_ATTACHMENT_PREVIEW_MAX_CHARS = 1_600;
const CHAT_ATTACHMENT_PREVIEW_MAX_LINES = 32;
const execFileAsync = promisify(execFile);

function approvalTitle(method: string): string {
  switch (method) {
    case 'item/commandExecution/requestApproval':
      return 'Approve command execution';
    case 'item/fileChange/requestApproval':
      return 'Approve file change';
    case 'item/permissions/requestApproval':
      return 'Grant extra permissions';
    default:
      return 'Review Codex request';
  }
}

function approvalRisk(method: string, params: Record<string, unknown>): string {
  if (method === 'item/commandExecution/requestApproval') {
    return String(params.reason ?? params.command ?? 'Codex requested command approval.');
  }
  if (method === 'item/fileChange/requestApproval') {
    return String(params.reason ?? 'Codex requested file write approval.');
  }
  if (method === 'item/permissions/requestApproval') {
    return String(params.reason ?? 'Codex requested additional permissions.');
  }
  return 'Codex requested a user decision.';
}

function collectApprovalStrings(value: unknown, result: string[] = []): string[] {
  if (typeof value === 'string') {
    result.push(value);
    return result;
  }

  if (Array.isArray(value)) {
    for (const entry of value) {
      collectApprovalStrings(entry, result);
    }
    return result;
  }

  if (value && typeof value === 'object') {
    for (const entry of Object.values(value as Record<string, unknown>)) {
      collectApprovalStrings(entry, result);
    }
  }

  return result;
}

function requestedPermissionsFromParams(params: unknown): Record<string, unknown> {
  if (!params || typeof params !== 'object') {
    return {};
  }

  const permissions = (params as { permissions?: unknown }).permissions;
  return permissions && typeof permissions === 'object'
    ? permissions as Record<string, unknown>
    : {};
}

function blockedChatPermissionReason(params: unknown) {
  const approvalText = collectApprovalStrings(params).join('\n');
  if (!approvalText.trim()) {
    return null;
  }

  for (const rule of CHAT_PERMISSION_BLOCK_RULES) {
    if (rule.pattern.test(approvalText)) {
      return rule.reason;
    }
  }

  return null;
}

function normalizeChatReplyText(text: string) {
  return text
    .replace(/\s+/g, ' ')
    .trim();
}

function isTransitionOnlyChatReply(text: string) {
  const normalized = normalizeChatReplyText(text);
  if (!normalized) {
    return false;
  }
  if (normalized.length > 120 || normalized.includes('\n')) {
    return false;
  }

  return CHAT_TRANSITION_ONLY_REPLY_PATTERNS.some((pattern) => pattern.test(normalized));
}

function buildChatTurnPreface(
  prefaceText: string | null | undefined,
  systemPromptText: string | null,
  rolePromptText: string | null,
) {
  const sections = [];
  if (prefaceText?.trim()) {
    sections.push(prefaceText.trim());
  }
  if (systemPromptText?.trim()) {
    sections.push(systemPromptText.trim());
  }
  if (rolePromptText?.trim()) {
    sections.push(rolePromptText.trim());
  }
  return sections.join('\n\n');
}

function latestMeaningfulChatReplyFromTurn(thread: CodexThread, turnId: string) {
  const turn = thread.turns.find((entry) => entry.id === turnId);
  if (!turn) {
    return null;
  }

  const replies = turn.items
    .filter((item): item is Extract<CodexThreadItem, { type: 'agentMessage' }> => item.type === 'agentMessage')
    .map((item) => item.text)
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    .map((value) => value.trim());

  for (let index = replies.length - 1; index >= 0; index -= 1) {
    const reply = replies[index]!;
    if (!isTransitionOnlyChatReply(reply)) {
      return reply;
    }
  }

  return replies.at(-1) ?? null;
}

function notificationErrorText(value: unknown, depth = 0): string | null {
  if (depth > 4 || value == null) {
    return null;
  }

  if (typeof value === 'string') {
    const normalized = value.trim();
    return normalized || null;
  }

  if (Array.isArray(value)) {
    for (const entry of value) {
      const nested = notificationErrorText(entry, depth + 1);
      if (nested) {
        return nested;
      }
    }
    return null;
  }

  if (typeof value !== 'object') {
    return null;
  }

  const record = value as Record<string, unknown>;
  for (const key of ['message', 'error', 'details', 'detail', 'reason', 'cause', 'summary']) {
    const nested = notificationErrorText(record[key], depth + 1);
    if (nested) {
      return nested;
    }
  }

  for (const [key, entry] of Object.entries(record)) {
    if (key === 'threadId' || key === 'turnId' || key === 'id' || key === 'type') {
      continue;
    }
    const nested = notificationErrorText(entry, depth + 1);
    if (nested) {
      return nested;
    }
  }

  return null;
}

function summarizeNotification(method: string, params: Record<string, unknown>): string {
  switch (method) {
    case 'thread/status/changed':
      return `Thread status changed to ${String((params.status as { type?: string } | undefined)?.type ?? 'unknown')}`;
    case 'turn/started':
      return 'Turn started';
    case 'turn/completed':
      return 'Turn completed';
    case 'item/completed': {
      const item = params.item as { type?: string } | undefined;
      return `Completed ${item?.type ?? 'item'}`;
    }
    case 'item/started': {
      const item = params.item as { type?: string } | undefined;
      return `Started ${item?.type ?? 'item'}`;
    }
    case 'error':
      return notificationErrorText(params) ?? 'Codex reported an error.';
    case 'item/agentMessage/delta':
      return 'Streaming assistant text';
    case 'turn/diff/updated':
      return 'Turn diff updated';
    case 'thread/tokenUsage/updated':
      return 'Token usage updated';
    default:
      return method;
  }
}

function shouldExposeChatLiveEvent(event: SessionEvent) {
  if (event.method === 'item/agentMessage/delta') {
    return true;
  }

  if (event.method === 'error') {
    return true;
  }

  if (event.method === 'item/started' || event.method === 'item/completed') {
    return /\b(?:reasoning|webSearch|agentMessage)\b/i.test(event.summary);
  }

  if (event.method === 'turn/started' || event.method === 'turn/completed') {
    return true;
  }

  if (event.method === 'thread/status/changed') {
    return /\b(?:active|idle|systemError)\b/i.test(event.summary);
  }

  return event.method.startsWith('session/chat-');
}

function compactChatLiveEvents(events: SessionEvent[]) {
  const filtered = events.filter(shouldExposeChatLiveEvent);
  const deduped: SessionEvent[] = [];

  for (const event of filtered) {
    const previous = deduped.at(-1);
    if (
      previous
      && previous.method === event.method
      && previous.summary === event.summary
    ) {
      deduped[deduped.length - 1] = event;
      continue;
    }
    deduped.push(event);
  }

  return deduped.slice(-40);
}

function extractThreadId(params: unknown): string | null {
  if (!params || typeof params !== 'object') return null;
  const record = params as Record<string, unknown>;
  if (typeof record.threadId === 'string') return record.threadId;
  if (record.thread && typeof record.thread === 'object') {
    const thread = record.thread as Record<string, unknown>;
    if (typeof thread.id === 'string') return thread.id;
  }
  return null;
}

function isCodexThread(value: unknown): value is CodexThread {
  return Boolean(value && typeof value === 'object' && typeof (value as { id?: unknown }).id === 'string');
}

async function ensureWorkspaceExists(cwd: string) {
  const info = await stat(cwd);
  if (!info.isDirectory()) {
    throw new Error(`Workspace is not a directory: ${cwd}`);
  }
}

function cookieIsSecure(request: FastifyRequest) {
  const protoHeader = request.headers['x-forwarded-proto'];
  const forwardedProto = Array.isArray(protoHeader) ? protoHeader[0] : protoHeader;
  const protocol = typeof forwardedProto === 'string' ? forwardedProto : request.protocol;
  const hostname = request.hostname ?? '';

  if (hostname === '127.0.0.1' || hostname === 'localhost') {
    return false;
  }

  return protocol === 'https';
}

const STALE_SESSION_MESSAGE = 'Codex runtime restarted. The next prompt will create a fresh thread.';
const CHAT_RECOVERY_RECENT_MESSAGE_COUNT = 10;
const CHAT_SUMMARY_TIMEOUT_MS = 120_000;
const CHAT_SUMMARY_POLL_INTERVAL_MS = 300;
const MAX_ATTACHMENT_SIZE_BYTES = 20 * 1024 * 1024;
const MAX_ATTACHMENT_TEXT_LENGTH = 120_000;
const ATTACHMENT_CONTEXT_PREFIX = '__RVC_ATTACHMENT__:';
const LEGACY_ATTACHMENT_CONTEXT_PREFIXES = ['__RVC_PDF_ATTACHMENT__:'];
const TEXT_ATTACHMENT_EXTENSIONS = new Set([
  '.txt',
  '.md',
  '.markdown',
  '.rst',
  '.json',
  '.jsonl',
  '.yaml',
  '.yml',
  '.toml',
  '.xml',
  '.html',
  '.htm',
  '.css',
  '.scss',
  '.less',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.ts',
  '.tsx',
  '.py',
  '.rb',
  '.java',
  '.kt',
  '.go',
  '.rs',
  '.c',
  '.cc',
  '.cpp',
  '.h',
  '.hpp',
  '.cs',
  '.php',
  '.swift',
  '.sql',
  '.sh',
  '.zsh',
  '.bash',
  '.env',
  '.ini',
  '.cfg',
  '.conf',
  '.csv',
  '.tsv',
  '.log',
]);

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function isThreadUnavailableError(error: unknown) {
  return errorMessage(error).includes('thread not loaded');
}

function isThreadMaterializingError(error: unknown) {
  const message = errorMessage(error);
  return message.includes('is not materialized yet')
    || message.includes('includeTurns is unavailable before first user message');
}

function isConversation(record: TurnRecord): record is ConversationRecord {
  return record.sessionType === 'chat';
}

function isDeveloperSession(record: TurnRecord): record is SessionRecord {
  return record.sessionType === 'code';
}

function normalizeSessionType(value: unknown): SessionType {
  return value === 'chat' ? 'chat' : 'code';
}

function normalizeSecurityProfile(value: unknown): SecurityProfile {
  if (value === 'read-only') return 'read-only';
  if (value === 'full-host') return 'full-host';
  return 'repo-write';
}

function normalizeReasoningEffort(value: unknown): ReasoningEffort | null {
  switch (value) {
    case 'none':
    case 'minimal':
    case 'low':
    case 'medium':
    case 'high':
    case 'xhigh':
      return value;
    default:
      return null;
  }
}

function trimOptional(value: unknown) {
  const next = typeof value === 'string' ? value.trim() : '';
  return next || null;
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

function normalizeWorkspaceFolderName(value: unknown) {
  const next = typeof value === 'string' ? value.trim() : '';
  if (!next || next === '.' || next === '..' || next.startsWith('.') || next.includes('/') || next.includes('\\')) {
    return null;
  }
  return next;
}

function defaultChatWorkspaceName() {
  return 'chat';
}

function defaultChatTitle() {
  return 'New chat';
}

function defaultCodingSessionTitle(index = 1) {
  return `Session ${Math.max(1, index)}`;
}

function isDefaultCodingSessionTitle(value: string | null | undefined) {
  return typeof value === 'string' && (value === 'New Session' || /^Session \d+$/.test(value));
}

function availableModesForUser(user: UserRecord): Array<'chat' | 'developer'> {
  const modes: Array<'chat' | 'developer'> = [
    ...(user.roles.includes('developer') ? (['developer'] as const) : []),
    ...(user.roles.includes('user') ? (['chat'] as const) : []),
  ];
  return modes.length > 0 ? modes : ['chat'];
}

function defaultModeForUser(user: UserRecord): 'chat' | 'developer' {
  return user.preferredMode && availableModesForUser(user).includes(user.preferredMode)
    ? user.preferredMode
    : user.roles.includes('developer')
      ? 'developer'
      : 'chat';
}

function userCanUseMode(user: UserRecord, mode: 'chat' | 'developer') {
  return availableModesForUser(user).includes(mode);
}

const CHAT_RECOVERY_PREFACE_LEAD = 'You are continuing an existing chat after the runtime thread was restarted.';

function visibleUserTextFromThreadInput(value: string) {
  const parsed = extractAttachmentMarkers(value);
  return parsed.markers.length > 0 ? parsed.visibleText.trim() : value.trim();
}

function looksLikeChatTurnPrefaceText(
  value: string,
  rolePresetId: string | null | undefined,
  config = chatPromptConfig.getCachedRolePresetConfig(),
) {
  const normalized = value.trim();
  if (!normalized) {
    return false;
  }

  if (normalized.startsWith(CHAT_RECOVERY_PREFACE_LEAD)) {
    return true;
  }

  const promptSections = chatPromptConfig.promptSections(rolePresetId, config);

  return promptSections.some((section) => Boolean(section) && normalized.startsWith(section!));
}

function extractFirstUserPrompt(
  thread: CodexThread | null,
  rolePresetId: string | null | undefined,
  config = chatPromptConfig.getCachedRolePresetConfig(),
) {
  if (!thread) return null;

  for (const turn of thread.turns) {
    for (const item of turn.items) {
      if (item.type !== 'userMessage') continue;

      const content = Array.isArray((item as { content?: unknown }).content)
        ? (item as { content: Array<{ type?: string; text?: string }> }).content
        : [];

      for (const entry of content) {
        if (entry.type !== 'text' || typeof entry.text !== 'string') {
          continue;
        }

        const visibleText = visibleUserTextFromThreadInput(entry.text);
        if (!visibleText || looksLikeChatTurnPrefaceText(visibleText, rolePresetId, config)) {
          continue;
        }

        return visibleText;
      }
    }
  }

  return null;
}

function deriveChatTitleFromThread(
  thread: CodexThread | null,
  rolePresetId: string | null | undefined,
  config = chatPromptConfig.getCachedRolePresetConfig(),
) {
  return normalizeChatGeneratedTitle(extractFirstUserPrompt(thread, rolePresetId, config))
    ?? normalizeChatGeneratedTitle(chatPromptConfig.stripPromptPreface(thread?.preview, rolePresetId, config));
}

function extractFirstDeveloperPrompt(thread: CodexThread | null) {
  if (!thread) return null;

  for (const turn of thread.turns) {
    for (const item of turn.items) {
      if (item.type !== 'userMessage') continue;

      const content = Array.isArray((item as { content?: unknown }).content)
        ? (item as { content: Array<{ type?: string; text?: string }> }).content
        : [];

      const text = content
        .filter((entry) => entry.type === 'text' && typeof entry.text === 'string')
        .map((entry) => entry.text)
        .join(' ')
        .trim();

      if (text) {
        return text;
      }
    }
  }

  return null;
}

function deriveCodingTitleFromThread(thread: CodexThread | null) {
  return normalizeGeneratedTitle(thread?.name)
    ?? normalizeGeneratedTitle(thread?.preview)
    ?? normalizeGeneratedTitle(extractFirstDeveloperPrompt(thread));
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

function attachmentContentPath(_ownerKind: 'conversation' | 'session', ownerId: string, attachmentId: string) {
  return `/api/sessions/${ownerId}/attachments/${attachmentId}/content`;
}

function codingAttachmentContentPath(sessionId: string, attachmentId: string) {
  return `/api/coding/sessions/${sessionId}/attachments/${attachmentId}/content`;
}

function chatAttachmentContentPath(conversationId: string, attachmentId: string) {
  return `/api/chat/conversations/${conversationId}/attachments/${attachmentId}/content`;
}

function sanitizeAttachmentFilename(filename: string, fallbackBase: string) {
  const trimmed = filename.trim() || fallbackBase;
  const ext = extname(trimmed).slice(0, 16);
  const base = basename(trimmed, ext)
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);

  return `${base || fallbackBase}${ext}`;
}

function attachmentKindFromUpload(_filename: string, mimeType: string): SessionAttachmentKind {
  if (mimeType.startsWith('image/')) {
    return 'image';
  }
  if (mimeType === 'application/pdf') {
    return 'pdf';
  }
  return 'file';
}

function attachmentSummaryForRoute(
  record: SessionAttachmentRecord,
  urlBuilder: (ownerId: string, attachmentId: string) => string,
): SessionAttachmentSummary {
  return {
    id: record.id,
    kind: record.kind,
    filename: record.filename,
    mimeType: record.mimeType,
    sizeBytes: record.sizeBytes,
    url: urlBuilder(record.ownerId, record.id),
    createdAt: record.createdAt,
  };
}

function attachmentSummary(record: SessionAttachmentRecord): SessionAttachmentSummary {
  return attachmentSummaryForRoute(
    record,
    (ownerId, attachmentId) => attachmentContentPath(record.ownerKind, ownerId, attachmentId),
  );
}

function codingAttachmentSummary(record: SessionAttachmentRecord): SessionAttachmentSummary {
  return attachmentSummaryForRoute(record, codingAttachmentContentPath);
}

function chatAttachmentSummary(record: SessionAttachmentRecord): SessionAttachmentSummary {
  return attachmentSummaryForRoute(record, chatAttachmentContentPath);
}

async function deleteStoredAttachments(attachments: SessionAttachmentRecord[]) {
  await Promise.all(
    attachments.map((attachment) => unlink(attachment.storagePath).catch(() => {})),
  );
}

function extractAttachmentMarkers(text: string) {
  const allPrefixes = [ATTACHMENT_CONTEXT_PREFIX, ...LEGACY_ATTACHMENT_CONTEXT_PREFIXES];
  const firstPrefix = allPrefixes
    .map((prefix) => ({ prefix, index: text.indexOf(prefix) }))
    .filter((entry) => entry.index !== -1)
    .sort((left, right) => left.index - right.index)[0];

  if (!firstPrefix) {
    return {
      visibleText: text,
      markers: [] as Array<{ id: string; filename: string }>,
    };
  }

  const markers: Array<{ id: string; filename: string }> = [];
  const firstMarkerIndex = firstPrefix.index;
  let cursor = firstMarkerIndex;

  while (cursor !== -1) {
    const matchedPrefix = allPrefixes.find((prefix) => text.startsWith(prefix, cursor));
    if (!matchedPrefix) {
      cursor += 1;
      continue;
    }

    const headerStart = cursor + matchedPrefix.length;
    const newlineIndex = text.indexOf('\n', headerStart);
    if (newlineIndex === -1) {
      break;
    }

    const headerText = text.slice(headerStart, newlineIndex);
    try {
      const parsed = JSON.parse(headerText) as { id?: unknown; filename?: unknown };
      if (typeof parsed.id === 'string') {
        markers.push({
          id: parsed.id,
          filename: typeof parsed.filename === 'string' ? parsed.filename : 'attachment',
        });
      }
    } catch {
      // Ignore malformed marker payloads and keep scanning.
    }

    const nextPrefix = allPrefixes
      .map((prefix) => ({ prefix, index: text.indexOf(prefix, newlineIndex + 1) }))
      .filter((entry) => entry.index !== -1)
      .sort((left, right) => left.index - right.index)[0];
    cursor = nextPrefix?.index ?? -1;
  }

  return {
    visibleText: text.slice(0, firstMarkerIndex).trimEnd(),
    markers,
  };
}

function truncateAttachmentText(text: string) {
  if (text.length <= MAX_ATTACHMENT_TEXT_LENGTH) {
    return text;
  }

  return `${text.slice(0, MAX_ATTACHMENT_TEXT_LENGTH)}\n\n[Attachment text truncated by Remote Vibe Coding.]`;
}

function decodeTextAttachment(buffer: Buffer) {
  const sample = buffer.subarray(0, Math.min(buffer.length, 4096));
  if (sample.includes(0)) {
    return null;
  }

  const text = buffer.toString('utf8').replace(/\u0000/g, '').trim();
  return text || null;
}

function looksLikeTextAttachment(filename: string, mimeType: string) {
  if (mimeType.startsWith('text/')) {
    return true;
  }
  if (
    mimeType.includes('json')
    || mimeType.includes('xml')
    || mimeType.includes('yaml')
    || mimeType.includes('javascript')
    || mimeType.includes('typescript')
  ) {
    return true;
  }

  return TEXT_ATTACHMENT_EXTENSIONS.has(extname(filename).toLowerCase());
}

async function extractAttachmentText(kind: SessionAttachmentKind, filename: string, mimeType: string, buffer: Buffer) {
  if (kind === 'image') {
    return null;
  }
  if (kind === 'pdf') {
    return extractPdfText(buffer);
  }
  if (!looksLikeTextAttachment(filename, mimeType)) {
    return null;
  }

  return decodeTextAttachment(buffer);
}

function buildAttachmentContext(attachment: SessionAttachmentRecord) {
  const payload = JSON.stringify({
    id: attachment.id,
    filename: attachment.filename,
    kind: attachment.kind,
    mimeType: attachment.mimeType,
    path: attachment.storagePath,
  });
  const extractedText = attachment.extractedText?.trim();
  const summary = extractedText
    ? truncateAttachmentText(extractedText)
    : `The user attached a file named ${attachment.filename} (${attachment.mimeType}), but no extractable text was found.`;
  const body = [
    `The attached file is available in the workspace at ${attachment.storagePath}.`,
    'If the user asks you to modify this file, edit it in place and keep the same path unless they ask for a new file.',
    summary,
  ].join('\n\n');

  return `\n${ATTACHMENT_CONTEXT_PREFIX}${payload}\n${body}`;
}

function textThreadInput(text: string): CodexThreadInput {
  return {
    type: 'text',
    text,
    text_elements: [],
  };
}

function buildTurnInput(
  prompt: string | null,
  attachments: SessionAttachmentRecord[],
  options?: {
    prefaceText?: string | null;
  },
) {
  const input: CodexThreadInput[] = [];
  const prefaceText = options?.prefaceText?.trim() ?? '';
  const trimmedPrompt = prompt?.trim() ?? '';

  if (prefaceText) {
    input.push(textThreadInput(prefaceText));
  }

  if (trimmedPrompt) {
    input.push(textThreadInput(trimmedPrompt));
  }

  for (const attachment of attachments) {
    if (attachment.kind === 'image') {
      input.push({
        type: 'localImage',
        path: attachment.storagePath,
      });
      continue;
    }

    input.push(textThreadInput(buildAttachmentContext(attachment)));
  }

  return input;
}

function shouldPersistChatRuntimeMessage(message: {
  role: 'user' | 'assistant';
  body: string;
}) {
  return message.role !== 'assistant' || !isTransitionOnlyChatReply(message.body);
}

function truncateChatAttachmentPreview(text: string | null | undefined) {
  const trimmed = text?.trim();
  if (!trimmed) {
    return null;
  }

  const lines = trimmed.split(/\r?\n/);
  const limitedLines = lines.slice(0, CHAT_ATTACHMENT_PREVIEW_MAX_LINES);
  let preview = limitedLines.join('\n');
  let truncated = lines.length > CHAT_ATTACHMENT_PREVIEW_MAX_LINES;

  if (preview.length > CHAT_ATTACHMENT_PREVIEW_MAX_CHARS) {
    preview = preview.slice(0, CHAT_ATTACHMENT_PREVIEW_MAX_CHARS);
    truncated = true;
  }

  preview = preview.trimEnd();
  if (!preview) {
    return null;
  }

  return truncated ? `${preview}\n\n[...]` : preview;
}

function shouldPersistAssistantReplyAsAttachment(body: string) {
  const trimmed = body.trim();
  if (!trimmed) {
    return false;
  }

  return trimmed.length > CHAT_ATTACHMENT_REPLY_MAX_CHARS
    || trimmed.split(/\r?\n/).length > CHAT_ATTACHMENT_REPLY_MAX_LINES;
}

function safeAttachmentIdPart(value: string | null | undefined, fallback: string) {
  const normalized = (value ?? '')
    .replace(/[^a-zA-Z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return normalized || fallback;
}

type ConversationRuntimeMessage = {
  role: 'user' | 'assistant';
  body: string;
  attachments: PersistedChatAttachmentRef[];
  sourceTurnId: string;
  sourceItemId: string;
  dedupeKey: string;
};

function chatAssistantAttachmentId(message: Pick<ConversationRuntimeMessage, 'sourceTurnId' | 'sourceItemId'>) {
  return `chat-response-${safeAttachmentIdPart(message.sourceTurnId, 'turn')}-${safeAttachmentIdPart(message.sourceItemId, 'item')}`;
}

async function materializeLongChatAssistantAttachment(
  conversation: ConversationRecord,
  message: ConversationRuntimeMessage,
) {
  if (message.role !== 'assistant' || !shouldPersistAssistantReplyAsAttachment(message.body)) {
    return null;
  }

  const attachmentId = chatAssistantAttachmentId(message);
  const existingAttachment = store.getAttachment(conversation.id, attachmentId);
  if (existingAttachment) {
    return existingAttachment;
  }

  try {
    const attachmentsDir = join(conversation.workspace, '.rvc-chat', 'attachments');
    await mkdir(attachmentsDir, { recursive: true });

    const now = new Date().toISOString();
    const timestamp = now.slice(0, 19).replace(/[:T]/g, '-');
    const storedFilename = sanitizeAttachmentFilename(
      `chat-response-${timestamp}.md`,
      'chat-response.md',
    );
    const storagePath = join(attachmentsDir, `${attachmentId}-${storedFilename}`);
    const buffer = Buffer.from(message.body, 'utf8');
    await writeFile(storagePath, buffer);

    const attachment: SessionAttachmentRecord = {
      id: attachmentId,
      ownerKind: 'conversation',
      ownerId: conversation.id,
      sessionId: conversation.id,
      ownerUserId: conversation.ownerUserId,
      ownerUsername: conversation.ownerUsername,
      kind: 'file',
      filename: storedFilename,
      mimeType: 'text/markdown; charset=utf-8',
      sizeBytes: buffer.byteLength,
      storagePath,
      extractedText: message.body,
      consumedAt: now,
      createdAt: now,
    };

    await store.addAttachment(attachment);
    return attachment;
  } catch {
    return null;
  }
}

async function extractPdfText(buffer: Buffer) {
  try {
    const parser = new PDFParse({ data: buffer });
    const parsed = await parser.getText();
    await parser.destroy();
    const text = typeof parsed.text === 'string'
      ? parsed.text.replace(/\u0000/g, '').trim()
      : '';
    return text || null;
  } catch {
    return null;
  }
}

type AttachmentSummaryBuilder = (record: SessionAttachmentRecord) => SessionAttachmentSummary;

function itemToTranscriptEntry(
  item: CodexThreadItem,
  index: number,
  _sessionId: string,
  attachments: SessionAttachmentRecord[],
  attachmentBuilder: AttachmentSummaryBuilder = attachmentSummary,
  workspacePath: string | null = null,
): SessionTranscriptEntry | null {
  if (item.type === 'userMessage') {
    const content = Array.isArray((item as { content?: unknown }).content)
      ? (item as { content: Array<{ type?: string; text?: string; path?: string }> }).content
      : [];
    const visibleText: string[] = [];
    const attachmentItems: SessionAttachmentSummary[] = [];
    const seenAttachmentIds = new Set<string>();
    const attachmentsById = new Map(attachments.map((attachment) => [attachment.id, attachment]));
    const attachmentsByPath = new Map(attachments.map((attachment) => [attachment.storagePath, attachment]));

    for (const entry of content) {
      if (entry.type === 'text') {
        const text = entry.text ?? '';
        const parsedText = extractAttachmentMarkers(text);
        if (parsedText.markers.length > 0) {
          for (const marker of parsedText.markers) {
            const attachment = attachmentsById.get(marker.id);
            if (attachment && !seenAttachmentIds.has(attachment.id)) {
              attachmentItems.push(attachmentBuilder(attachment));
              seenAttachmentIds.add(attachment.id);
            }
          }
          if (parsedText.visibleText) {
            visibleText.push(parsedText.visibleText);
          }
          continue;
        }
        visibleText.push(text);
        continue;
      }

      if (entry.type === 'localImage' && typeof entry.path === 'string') {
        const attachment = attachmentsByPath.get(entry.path);
        if (attachment && !seenAttachmentIds.has(attachment.id)) {
          attachmentItems.push(attachmentBuilder(attachment));
          seenAttachmentIds.add(attachment.id);
        }
      }
    }

    return {
      id: item.id,
      index,
      kind: 'user',
      body: visibleText.join('\n'),
      markdown: true,
      label: null,
      title: null,
      meta: null,
      attachments: attachmentItems,
    };
  }

  if (item.type === 'agentMessage') {
    const text = typeof (item as { text?: unknown }).text === 'string'
      ? (item as { text: string }).text
      : '';

    return {
      id: item.id,
      index,
      kind: 'assistant',
      body: text,
      markdown: true,
      label: null,
      title: null,
      meta: null,
      attachments: [],
    };
  }

  if (item.type === 'commandExecution') {
    const commandItem = item as {
      id: string;
      command?: unknown;
      cwd?: unknown;
      status?: unknown;
      exitCode?: unknown;
      aggregatedOutput?: unknown;
    };
    const status = typeof commandItem.status === 'string' ? commandItem.status : 'command';
    const exitCode = typeof commandItem.exitCode === 'number' ? commandItem.exitCode : null;
    const cwd = typeof commandItem.cwd === 'string' ? commandItem.cwd : '';
    const output = typeof commandItem.aggregatedOutput === 'string'
      ? commandItem.aggregatedOutput
      : '';

    return {
      id: commandItem.id,
      index,
      kind: 'tool',
      body: output || cwd,
      markdown: false,
      label: 'command',
      title: typeof commandItem.command === 'string' ? commandItem.command : 'command',
      meta: exitCode === null ? status : `${status} · exit ${exitCode}`,
      attachments: [],
    };
  }

  if (item.type === 'fileChange') {
    const fileChangeItem = item as {
      id: string;
      status?: unknown;
      changes?: Array<{
        path?: unknown;
        kind?: { type?: unknown };
        diff?: unknown;
      }>;
    };
    const changes = Array.isArray(fileChangeItem.changes) ? fileChangeItem.changes : [];
    const fileChanges = changes.map((change) => ({
      path: typeof change.path === 'string'
        ? (workspacePath ? normalizeWorkspaceFilePath(workspacePath, change.path) : change.path)
        : 'unknown',
      kind: typeof change.kind?.type === 'string' ? change.kind.type : 'update',
      diff: typeof change.diff === 'string' ? change.diff : null,
    }));
    const summary = changes.length === 1
      ? 'Changed 1 file'
      : `Changed ${changes.length} files`;
    const body = fileChanges.map((change) => {
      const diff = change.diff ?? '';
      return diff
        ? `${change.path} (${change.kind})\n\n${diff}`
        : `${change.path} (${change.kind})`;
    }).join('\n\n');

    return {
      id: fileChangeItem.id,
      index,
      kind: 'tool',
      body,
      markdown: false,
      label: 'files',
      title: summary,
      meta: typeof fileChangeItem.status === 'string' ? fileChangeItem.status : null,
      attachments: [],
      fileChanges,
    };
  }

  return null;
}

function collectTranscriptEntriesFromTurns(
  turns: CodexTurn[],
  sessionId: string,
  attachments: SessionAttachmentRecord[],
  attachmentBuilder: AttachmentSummaryBuilder = attachmentSummary,
  workspacePath: string | null = null,
) {
  const entries: SessionTranscriptEntry[] = [];
  for (const turn of turns) {
    for (const item of turn.items) {
      const entry = itemToTranscriptEntry(
        item,
        entries.length,
        sessionId,
        attachments,
        attachmentBuilder,
        workspacePath,
      );
      if (entry) {
        entries.push(entry);
      }
    }
  }
  return entries;
}

function collectTranscriptEntries(
  thread: CodexThread | null,
  sessionId: string,
  attachments: SessionAttachmentRecord[],
  attachmentBuilder: AttachmentSummaryBuilder = attachmentSummary,
) {
  return collectTranscriptEntriesFromTurns(thread?.turns ?? [], sessionId, attachments, attachmentBuilder);
}

function collectCommandsFromTurns(turns: CodexTurn[]) {
  const commands: SessionCommandEvent[] = [];
  for (const turn of turns) {
    for (const item of turn.items) {
      if (item.type !== 'commandExecution') continue;
      const commandItem = item as {
        id: string;
        command?: unknown;
        cwd?: unknown;
        status?: unknown;
        exitCode?: unknown;
        aggregatedOutput?: unknown;
      };
      commands.push({
        id: commandItem.id,
        index: commands.length,
        command: typeof commandItem.command === 'string' ? commandItem.command : '',
        cwd: typeof commandItem.cwd === 'string' ? commandItem.cwd : '',
        status: typeof commandItem.status === 'string' ? commandItem.status : '',
        exitCode: typeof commandItem.exitCode === 'number' ? commandItem.exitCode : null,
        output: typeof commandItem.aggregatedOutput === 'string'
          ? commandItem.aggregatedOutput
          : typeof commandItem.status === 'string'
            ? commandItem.status
            : '',
      });
    }
  }
  return commands;
}

function collectCommands(thread: CodexThread | null) {
  return collectCommandsFromTurns(thread?.turns ?? []);
}

function collectFileChangesFromTurns(turns: CodexTurn[], workspacePath: string | null = null) {
  const changes: SessionFileChangeEvent[] = [];
  for (const turn of turns) {
    for (const item of turn.items) {
      if (item.type !== 'fileChange') continue;
      const fileChangeItem = item as {
        id: string;
        status?: unknown;
        changes?: Array<{
          path?: unknown;
          kind?: { type?: unknown };
          diff?: unknown;
        }>;
      };

      for (const change of fileChangeItem.changes ?? []) {
        changes.push({
          id: `${fileChangeItem.id}-${typeof change.path === 'string' ? change.path : 'change'}-${changes.length}`,
          index: changes.length,
          path: typeof change.path === 'string'
            ? (workspacePath ? normalizeWorkspaceFilePath(workspacePath, change.path) : change.path)
            : '',
          kind: typeof change.kind?.type === 'string' ? change.kind.type : 'update',
          status: typeof fileChangeItem.status === 'string' ? fileChangeItem.status : '',
          diff: typeof change.diff === 'string' ? change.diff : null,
        });
      }
    }
  }
  return changes;
}

function collectFileChanges(thread: CodexThread | null) {
  return collectFileChangesFromTurns(thread?.turns ?? []);
}

function toThreadSummary(thread: CodexThread | null) {
  if (!thread) return null;
  const { turns: _turns, ...summary } = thread;
  return summary;
}

function normalizeTranscriptLimit(value: unknown) {
  const limit = Number.parseInt(String(value ?? ''), 10);
  if (Number.isNaN(limit)) return 40;
  return Math.min(Math.max(limit, 10), 100);
}

function pageTranscriptEntries(entries: SessionTranscriptEntry[], before: unknown, limit: number) {
  const total = entries.length;
  const parsedBefore = typeof before === 'string' ? Number.parseInt(before, 10) : Number.NaN;
  const end = Number.isNaN(parsedBefore) ? total : Math.min(Math.max(parsedBefore, 0), total);
  const start = Math.max(0, end - limit);

  return {
    items: entries.slice(start, end),
    nextCursor: start > 0 ? String(start) : null,
    total,
  };
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function turnIsActive(status: string) {
  const normalized = status.trim().toLowerCase();
  if (!normalized) return true;
  return !(
    normalized.includes('complete')
    || normalized.includes('error')
    || normalized.includes('fail')
    || normalized.includes('cancel')
    || normalized.includes('interrupt')
  );
}

function attachmentRefsFromRecords(attachments: SessionAttachmentRecord[]): PersistedChatAttachmentRef[] {
  return attachments.map((attachment) => ({
    attachmentId: attachment.id,
    kind: attachment.kind,
    filename: attachment.filename,
    mimeType: attachment.mimeType,
    sizeBytes: attachment.sizeBytes,
    storagePath: attachment.storagePath,
    previewText: truncateChatAttachmentPreview(attachment.extractedText),
    createdAt: attachment.createdAt,
  }));
}

function attachmentSummariesFromRefs(conversationId: string, attachments: PersistedChatAttachmentRef[]): SessionAttachmentSummary[] {
  return attachments.map((attachment) => ({
    id: attachment.attachmentId,
    kind: attachment.kind,
    filename: attachment.filename,
    mimeType: attachment.mimeType,
    sizeBytes: attachment.sizeBytes,
    url: attachmentContentPath('conversation', conversationId, attachment.attachmentId),
    createdAt: attachment.createdAt,
  }));
}

function chatAttachmentSummariesFromRefs(conversationId: string, attachments: PersistedChatAttachmentRef[]): SessionAttachmentSummary[] {
  return attachments.map((attachment) => ({
    id: attachment.attachmentId,
    kind: attachment.kind,
    filename: attachment.filename,
    mimeType: attachment.mimeType,
    sizeBytes: attachment.sizeBytes,
    url: chatAttachmentContentPath(conversationId, attachment.attachmentId),
    createdAt: attachment.createdAt,
  }));
}

function chatMessageToTranscriptEntryWithAttachments(
  message: ChatMessageRecord,
  summaryBuilder: (conversationId: string, attachments: PersistedChatAttachmentRef[]) => SessionAttachmentSummary[],
): SessionTranscriptEntry {
  return {
    id: message.id,
    index: message.seq,
    kind: message.role,
    body: message.body,
    markdown: true,
    label: null,
    title: null,
    meta: null,
    attachments: summaryBuilder(message.conversationId, message.attachments),
  };
}

function chatMessageToTranscriptEntry(message: ChatMessageRecord): SessionTranscriptEntry {
  return chatMessageToTranscriptEntryWithAttachments(message, attachmentSummariesFromRefs);
}

function chatMessageToApiTranscriptEntry(message: ChatMessageRecord): SessionTranscriptEntry {
  return chatMessageToTranscriptEntryWithAttachments(message, chatAttachmentSummariesFromRefs);
}

function formatChatMessageForMemory(message: ChatMessageRecord) {
  const text = message.body.trim();
  if (text) {
    return text;
  }
  const attachmentPreview = message.attachments
    .map((attachment) => attachment.previewText?.trim() ?? '')
    .find((value) => value.length > 0);
  if (attachmentPreview) {
    return attachmentPreview;
  }
  if (message.attachments.length > 0) {
    const count = message.attachments.length;
    return `[${count} attachment${count === 1 ? '' : 's'} omitted from recovery context]`;
  }
  return '[empty message]';
}

function formatChatMessagesForMemory(messages: ChatMessageRecord[]) {
  return messages.map((message) => (
    `${message.role === 'user' ? 'User' : 'Assistant'}: ${formatChatMessageForMemory(message)}`
  )).join('\n\n');
}

function buildChatSummaryPrompt(existingSummary: string | null, messages: ChatMessageRecord[]) {
  return [
    'You are updating a compact memory summary for a chat conversation that may need to continue in a new runtime thread.',
    'Keep the summary factual and concise.',
    'Preserve user goals, preferences, established facts, decisions, and unresolved questions.',
    'Do not include attachment paths or URLs.',
    `Existing summary:\n${existingSummary?.trim() || '(none)'}`,
    `Conversation messages to fold into the summary:\n${formatChatMessagesForMemory(messages)}`,
    'Return only the updated summary in plain text.',
  ].join('\n\n');
}

function buildChatRecoveryPreface(summary: string | null, recentMessages: ChatMessageRecord[]) {
  const sections = [
    'You are continuing an existing chat after the runtime thread was restarted.',
    'Use the persisted memory below as background context for the user message in this same turn.',
    'Do not mention this memory block unless the user asks about prior context or thread recovery.',
  ];

  if (summary?.trim()) {
    sections.push(`Persisted summary:\n${summary.trim()}`);
  }

  if (recentMessages.length > 0) {
    sections.push(`Most recent messages:\n${formatChatMessagesForMemory(recentMessages)}`);
  }

  return sections.join('\n\n');
}

async function waitForTurnThread(
  threadId: string,
  turnId: string,
  executor: AgentExecutor,
  timeoutMs = CHAT_SUMMARY_TIMEOUT_MS,
) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    try {
      const response = await runtimeForExecutor(executor).readThread(threadId);
      const thread = isCodexThread(response.thread) ? response.thread : null;
      const turn = thread?.turns.find((entry) => entry.id === turnId) ?? null;
      if (thread && turn && !turnIsActive(turn.status)) {
        if (turn.error?.message) {
          throw new Error(turn.error.message);
        }
        return thread;
      }
    } catch (error) {
      if (!isThreadMaterializingError(error)) {
        throw error;
      }
    }
    await delay(CHAT_SUMMARY_POLL_INTERVAL_MS);
  }

  throw new Error(`Timed out waiting for turn ${turnId} in thread ${threadId}`);
}

function assistantTextFromTurn(thread: CodexThread, turnId: string) {
  const turn = thread.turns.find((entry) => entry.id === turnId);
  if (!turn) {
    return null;
  }

  const text = turn.items
    .filter((item): item is Extract<CodexThreadItem, { type: 'agentMessage' }> => item.type === 'agentMessage')
    .map((item) => item.text)
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    .join('\n\n')
    .trim();

  return text || null;
}

function collectConversationRuntimeMessages(
  conversation: ConversationRecord,
  thread: CodexThread,
  attachments: SessionAttachmentRecord[],
) : ConversationRuntimeMessage[] {
  const attachmentsById = new Map(attachments.map((attachment) => [attachment.id, attachment]));
  const messages: ConversationRuntimeMessage[] = [];

  for (const turn of thread.turns) {
    if (conversation.activeTurnId && turn.id === conversation.activeTurnId) {
      continue;
    }

    for (const item of turn.items) {
      if (item.type !== 'userMessage' && item.type !== 'agentMessage') {
        continue;
      }

      const entry = itemToTranscriptEntry(item, 0, conversation.id, attachments);
      if (!entry || (entry.kind !== 'user' && entry.kind !== 'assistant')) {
        continue;
      }

      messages.push({
        role: entry.kind,
        body: entry.body,
        attachments: entry.attachments
          .map((attachment) => attachmentsById.get(attachment.id))
          .filter((attachment): attachment is SessionAttachmentRecord => Boolean(attachment))
          .map((attachment) => attachmentRefsFromRecords([attachment])[0])
          .filter((attachment): attachment is PersistedChatAttachmentRef => Boolean(attachment)),
        sourceTurnId: turn.id,
        sourceItemId: item.id,
        dedupeKey: entry.kind === 'user' ? `user:${turn.id}` : `assistant:${turn.id}:${item.id}`,
      });
    }
  }

  return messages;
}

async function syncConversationHistoryFromThread(conversation: ConversationRecord, thread: CodexThread | null) {
  await chatHistory.ensureConversation(conversation);
  if (!thread) {
    return;
  }

  const runtimeMessages = collectConversationRuntimeMessages(
    conversation,
    thread,
    store.listAttachments(conversation.id),
  );
  const persistedMessages = runtimeMessages.filter(shouldPersistChatRuntimeMessage);
  if (persistedMessages.length === 0) {
    return;
  }

  const historyInputs = [];
  for (const message of persistedMessages) {
    const generatedAttachment = await materializeLongChatAssistantAttachment(conversation, message);
    historyInputs.push({
      role: message.role,
      body: generatedAttachment ? '' : message.body,
      attachments: generatedAttachment ? attachmentRefsFromRecords([generatedAttachment]) : message.attachments,
      sourceThreadId: thread.id,
      sourceTurnId: message.sourceTurnId,
      sourceItemId: message.sourceItemId,
      dedupeKey: message.dedupeKey,
    });
  }

  await chatHistory.appendMessages(conversation, historyInputs);
}

function projectPersistedCodingTurns(
  session: SessionRecord,
  thread: CodexThread | null,
  attachments: SessionAttachmentRecord[],
) {
  if (!thread) {
    return [];
  }

  return thread.turns
    .filter((turn) => !turnIsActive(turn.status))
    .map((turn) => ({
      turnId: turn.id,
      threadId: thread.id,
      status: turn.status,
      transcriptEntries: collectTranscriptEntriesFromTurns(
        [turn],
        session.id,
        attachments,
        attachmentSummary,
        session.workspace,
      ),
      commands: collectCommandsFromTurns([turn]),
      changes: collectFileChangesFromTurns([turn], session.workspace),
    }));
}

async function syncCodingHistoryFromThread(session: SessionRecord, thread: CodexThread | null) {
  const attachments = store.listAttachments(session.id);
  const projections = projectPersistedCodingTurns(session, thread, attachments);
  if (projections.length === 0) {
    return codingHistory.listTurns(session.id);
  }

  return codingHistory.mergeTurnProjections(session.id, projections);
}

async function buildCodingHistoryView(
  session: SessionRecord,
  thread: CodexThread | null,
  attachmentBuilder: AttachmentSummaryBuilder = attachmentSummary,
) {
  const persistedTurns = await syncCodingHistoryFromThread(session, thread);
  const attachments = store.listAttachments(session.id);
  const activeTurns = thread?.turns.filter((turn) => turnIsActive(turn.status)) ?? [];
  const liveSegments = activeTurns.length > 0
    ? [{
        transcriptEntries: collectTranscriptEntriesFromTurns(
          activeTurns,
          session.id,
          attachments,
          attachmentBuilder,
          session.workspace,
        ),
        commands: collectCommandsFromTurns(activeTurns),
        changes: collectFileChangesFromTurns(activeTurns, session.workspace),
      }]
    : [];

  return buildPersistedCodingHistory([
    ...persistedTurns,
    ...liveSegments,
  ]);
}

async function buildCodingHistorySummary(
  session: SessionRecord,
  thread: CodexThread | null,
) {
  const persistedTurns = await syncCodingHistoryFromThread(session, thread);
  const attachments = store.listAttachments(session.id);
  const activeTurns = thread?.turns.filter((turn) => turnIsActive(turn.status)) ?? [];
  const liveSegments = activeTurns.length > 0
    ? [{
        transcriptEntries: collectTranscriptEntriesFromTurns(
          activeTurns,
          session.id,
          attachments,
          codingAttachmentSummary,
          session.workspace,
        ),
        commands: collectCommandsFromTurns(activeTurns),
        changes: collectFileChangesFromTurns(activeTurns, session.workspace),
      }]
    : [];

  return summarizePersistedCodingHistory([
    ...persistedTurns,
    ...liveSegments,
  ]);
}

async function generateConversationSummary(
  conversation: ConversationRecord,
  existingSummary: string | null,
  messages: ChatMessageRecord[],
) {
  const summaryExecutor = runtimeRegistry.defaultExecutor();
  const summaryModel = currentDefaultModel(summaryExecutor);
  const summaryEffort = currentDefaultEffort(summaryModel, summaryExecutor);

  return generateChatConversationSummary(conversation, existingSummary, messages, {
    summaryRuntime: chatRuntime,
    summaryExecutor,
    summaryModel,
    summaryEffort,
    buildSummaryPrompt: buildChatSummaryPrompt,
    textThreadInput,
    waitForTurnThread,
    assistantTextFromTurn,
  });
}

async function prepareConversationRecoveryState(conversation: ConversationRecord) {
  let state = await chatHistory.ensureConversation(conversation);
  if (state.recoveryAppliedGeneration >= state.threadGeneration) {
    return {
      recoveryNeeded: false,
      threadGeneration: state.threadGeneration,
      prefaceText: null as string | null,
    };
  }

  const recentMessages = await chatHistory.listRecentMessages(
    conversation.id,
    CHAT_RECOVERY_RECENT_MESSAGE_COUNT,
  );
  const recentStartSeq = recentMessages[0]?.seq ?? null;
  const summarizedUntilSeq = state.summary?.summarizedUntilSeq ?? -1;

  if (recentStartSeq !== null && recentStartSeq - 1 > summarizedUntilSeq) {
    const messagesToSummarize = await chatHistory.listMessagesBySeq(conversation.id, {
      afterSeq: summarizedUntilSeq,
      maxSeq: recentStartSeq - 1,
    });
    if (messagesToSummarize.length > 0) {
      const nextSummary = await generateConversationSummary(
        conversation,
        state.summary?.text ?? null,
        messagesToSummarize,
      );
      await chatHistory.updateSummary(conversation.id, {
        text: nextSummary,
        summarizedUntilSeq: recentStartSeq - 1,
        model: currentDefaultModel(runtimeRegistry.defaultExecutor()),
      });
      state = await chatHistory.getConversationOrThrow(conversation.id);
    }
  }

  const tailMessages = recentMessages.filter((message: ChatMessageRecord) => (
    state.summary ? message.seq > state.summary.summarizedUntilSeq : true
  ));
  const prefaceText = (state.summary?.text || tailMessages.length > 0)
    ? buildChatRecoveryPreface(state.summary?.text ?? null, tailMessages)
    : null;

  return {
    recoveryNeeded: true,
    threadGeneration: state.threadGeneration,
    prefaceText,
  };
}

function getRequestUser(request: FastifyRequest) {
  const user = (request as AuthenticatedRequest).authUser;
  if (!user) {
    throw new Error('Authentication required');
  }
  return user;
}

const app = Fastify({
  logger: true,
  trustProxy: true,
});
const chatPromptConfig = new ChatPromptConfigStore((message) => {
  app.log.warn(message);
});

await app.register(cors, {
  origin: true,
});
await app.register(fastifyCookie);
await app.register(fastifyMultipart, {
  limits: {
    files: 1,
    fileSize: MAX_ATTACHMENT_SIZE_BYTES,
  },
});

const workspaceService = createUserWorkspaceService({
  workspaceRoot: WORKSPACE_ROOT,
  normalizeWorkspaceSegment,
  normalizeWorkspaceFolderName,
  ensureWorkspaceExists,
  cloneWorkspaceInto: async (gitUrl, workspacePath) => {
    await execFileAsync('git', ['clone', gitUrl, workspacePath]);
  },
});

const runtime = await initializeHostRuntime({
  staleSessionMessage: STALE_SESSION_MESSAGE,
  syncUserWorkspaceRecords: (username, userId, dependencies) => (
    workspaceService.syncUserWorkspaceRecords(username, userId, dependencies)
  ),
  loadChatSystemPromptText: () => chatPromptConfig.loadSystemPromptText(),
  loadChatRolePresetConfig: () => chatPromptConfig.loadRolePresetConfig(),
});
const { auth, store, chatHistory, codingHistory, coding, runtimeRegistry, cloudflare, cloudflareStatusCache, modelCatalog } = runtime;
const chatRuntime = runtimeRegistry.defaultRuntime();
const runtimeForExecutor = (executor: AgentExecutor) => runtimeRegistry.require(executor);
const runtimeForRecord = (record: TurnRecord) => runtimeForExecutor(record.executor);
const userWorkspaceRoot = (username: string, userId: string) => workspaceService.userWorkspaceRoot(username, userId);
const listUserWorkspaces = (username: string, userId: string) => (
  workspaceService.listUserWorkspaces(username, userId, { store, coding })
);
const ensureUserWorkspace = (username: string, userId: string, workspaceName: string) => (
  workspaceService.ensureUserWorkspace(username, userId, workspaceName, { coding })
);
const cloneWorkspaceFromGit = (username: string, userId: string, gitUrl: string) => (
  workspaceService.cloneWorkspaceFromGit(username, userId, gitUrl, { coding })
);
const adminUserService = new AdminUserService(auth, store, chatHistory, coding);
const handleNotification = createRuntimeNotificationHandler({
  store,
  findRecordByThreadId,
  updateRecord,
  getCurrentRecord,
  readSessionThread,
  maybeAutoTitleChatSession,
  maybeAutoTitleCodingSession,
  syncConversationHistoryFromThread,
  syncCodingHistoryFromThread,
  latestMeaningfulChatReplyFromTurn,
  isTransitionOnlyChatReply,
  summarizeNotification,
  emptyReplyMessage: CHAT_EMPTY_REPLY_MESSAGE,
});
function currentDefaultModel(executor?: AgentExecutor) {
  return modelCatalog.currentDefaultModel(executor);
}

function resolveModelOption(model: string | null | undefined, executor?: AgentExecutor) {
  return modelCatalog.resolveOption(model, executor);
}

function preferredReasoningEffortForModel(modelOption: ModelOption) {
  return modelCatalog.preferredReasoningEffortForModel(modelOption);
}

function currentDefaultEffort(model: string | null | undefined, executor?: AgentExecutor) {
  return modelCatalog.currentDefaultEffort(model, executor);
}

function toApiChatConversationRecord(record: ConversationRecord) {
  return toApiChatConversation(record, {
    normalizeRolePresetId: (value) => chatPromptConfig.normalizeRolePresetId(value),
  });
}

function buildChatBootstrapResponse(
  currentUser: UserRecord,
  conversations: ConversationRecord[],
  rolePresets: ReturnType<ChatPromptConfigStore['apiRolePresets']>,
  defaultRolePresetId: string | null,
) {
  const defaultModel = currentDefaultModel();
  return buildChatBootstrapPayload({
    currentUser,
    conversations,
    rolePresets,
    defaultRolePresetId,
    availableModes: availableModesForUser(currentUser),
    defaultMode: defaultModeForUser(currentUser),
    availableModels: modelCatalog.list(),
    defaultModel,
    defaultReasoningEffort: currentDefaultEffort(defaultModel),
    normalizeRolePresetId: (value) => chatPromptConfig.normalizeRolePresetId(value),
  });
}

function buildChatConversationDetailPayload(
  conversation: ConversationRecord,
  thread: ReturnType<typeof toThreadSummary>,
  transcriptTotal: number,
) {
  return buildChatConversationDetailResponse({
    conversation,
    thread,
    transcriptTotal,
    draftAttachments: store.listDraftAttachments(conversation.id).map(chatAttachmentSummary),
    normalizeRolePresetId: (value) => chatPromptConfig.normalizeRolePresetId(value),
  });
}

function unavailableChatConversationStatePatch(
  record: Pick<ConversationRecord, 'activeTurnId' | 'status' | 'lastIssue'>,
  reason = STALE_SESSION_MESSAGE,
) {
  return createUnavailableChatConversationPatch(record, CHAT_INTERRUPTED_MESSAGE, reason);
}

const {
  createConversation: createChatConversation,
  renameConversation,
  updateConversationPreferences,
  archiveConversation,
  restoreConversation,
} = createChatConversationService({
  isExecutorSupported: (executor) => runtimeRegistry.get(executor) !== null,
  runtimeForExecutor,
  ensureChatWorkspace: (ownerUsername, ownerUserId) => (
    ensureUserWorkspace(ownerUsername, ownerUserId, defaultChatWorkspaceName())
  ),
  persistConversation: (conversation) => store.upsertConversation(conversation),
  ensureConversationHistory: (conversation) => chatHistory.ensureConversation(conversation),
  updateConversation: (conversation, patch) => updateRecord(conversation, patch) as Promise<ConversationRecord | null>,
  currentDefaultExecutor: () => runtimeRegistry.defaultExecutor(),
  currentDefaultModel,
  currentDefaultEffort,
  defaultChatTitle,
  trimOptional,
  normalizeExecutor: normalizeAgentExecutor,
  normalizeReasoningEffort,
  findModelOption: (model, executor) => modelCatalog.findByModel(model, executor),
  preferredReasoningEffortForModel,
  loadChatRolePresetConfig: () => chatPromptConfig.loadRolePresetConfig(),
  normalizeChatRolePresetId: (value, config) => chatPromptConfig.normalizeRolePresetId(value, config),
});

function toCodingWorkspaceSummary(workspace: WorkspaceSummary): CodingWorkspaceSummary {
  return {
    id: workspace.id,
    name: workspace.name,
    path: workspace.path,
    visible: workspace.visible,
    sortOrder: workspace.sortOrder,
  };
}

async function buildCodingBootstrapResponse(currentUser: UserRecord): Promise<CodingBootstrapPayload> {
  const [workspaceState, sessions, approvals] = await Promise.all([
    listUserWorkspaces(currentUser.username, currentUser.id),
    coding.listSessionsForUser(currentUser.id),
    sessionApprovalsForUser(currentUser.id),
  ]);
  return buildCodingBootstrapPayload(
    currentUser,
    sessions,
    approvals,
    workspaceState.root,
    workspaceState.workspaces,
    runtimeRegistry.supportedExecutors(),
    runtimeRegistry.defaultExecutor(),
    modelCatalog.listByExecutor(),
  );
}

async function buildAppBootstrapResponse(currentUser: UserRecord) {
  const workspaceStatePromise = userCanUseMode(currentUser, 'developer')
    ? listUserWorkspaces(currentUser.username, currentUser.id)
    : Promise.resolve({ root: userWorkspaceRoot(currentUser.username, currentUser.id), workspaces: [] });
  const conversations = store.listConversationsForUser(currentUser.id);
  const [workspaceState, sessions, approvals, cloudflareStatus] = await Promise.all([
    workspaceStatePromise,
    coding.listSessionsForUser(currentUser.id),
    sessionApprovalsForUser(currentUser.id),
    cloudflareStatusCache.get(),
  ]);
  return buildBootstrapPayload(
    currentUser,
    sessions,
    conversations,
    approvals,
    cloudflareStatus,
    workspaceState.root,
    workspaceState.workspaces,
    runtimeRegistry.supportedExecutors(),
    runtimeRegistry.defaultExecutor(),
    modelCatalog.listByExecutor(),
  );
}

async function connectCloudflareAndRefreshStatus() {
  cloudflareStatusCache.clear();
  try {
    const status = await cloudflare.connect();
    cloudflareStatusCache.prime(status);
    return status;
  } catch (error) {
    cloudflareStatusCache.clear();
    throw error;
  }
}

async function disconnectCloudflareAndRefreshStatus() {
  cloudflareStatusCache.clear();
  try {
    const status = await cloudflare.disconnect();
    cloudflareStatusCache.prime(status);
    return status;
  } catch (error) {
    cloudflareStatusCache.clear();
    throw error;
  }
}

const createDeveloperSession = createDeveloperSessionService({
  isExecutorSupported: (executor) => runtimeRegistry.get(executor) !== null,
  runtimeForExecutor,
  countSessionsForWorkspace: (userId, workspaceId) => coding.countSessionsForWorkspace(userId, workspaceId),
  persistSession: (session) => coding.upsertSession(session),
  currentDefaultExecutor: () => runtimeRegistry.defaultExecutor(),
  currentDefaultModel,
  defaultCodingSessionTitle,
  trimOptional,
  normalizeExecutor: normalizeAgentExecutor,
  normalizeReasoningEffort,
  findModelOption: (model, executor) => modelCatalog.findByModel(model, executor),
  preferredReasoningEffortForModel,
  normalizeSecurityProfile,
  normalizeApprovalMode,
});
const {
  createWorkspace: createCodingWorkspace,
  updateWorkspace: updateCodingWorkspace,
  reorderWorkspaceList,
} = createCodingWorkspaceService({
  cloneWorkspaceFromGit,
  ensureUserWorkspace,
  listUserWorkspaces,
  updateWorkspace: (workspaceId, patch) => coding.updateWorkspace(workspaceId, patch),
  reorderWorkspaces: (userId, workspaceIds) => coding.reorderWorkspaces(userId, workspaceIds),
  normalizeWorkspaceFolderName,
  trimOptional,
  errorMessage,
});

async function buildCodingSessionDetailResponse(session: SessionRecord) {
  const threadState = await readSessionThread(session);
  let responseSession = threadState.session as SessionRecord;
  const history = await buildCodingHistorySummary(responseSession, threadState.thread);
  const transcriptTotal = history.transcriptTotal;
  const hasTranscript = transcriptTotal > 0;
  if (threadState.session.hasTranscript !== hasTranscript) {
    responseSession = (await coding.updateSession(threadState.session.id, {
      hasTranscript,
    })) ?? {
      ...(threadState.session as SessionRecord),
      hasTranscript,
    };
  }

  return {
    session: responseSession,
    approvals: store.getApprovals(responseSession.id),
    liveEvents: store.getLiveEvents(responseSession.id),
    thread: toThreadSummary(threadState.thread),
    transcriptTotal,
    commands: history.commands,
    changes: history.changes,
    draftAttachments: store.listDraftAttachments(responseSession.id).map(codingAttachmentSummary),
  };
}

async function buildCodingSessionTranscriptResponse(
  session: SessionRecord,
  query: { before?: string; limit?: string } | undefined,
) {
  const threadState = await readSessionThread(session);
  const history = await buildCodingHistoryView(threadState.session as SessionRecord, threadState.thread);

  return pageTranscriptEntries(
    history.transcriptEntries,
    query?.before,
    normalizeTranscriptLimit(query?.limit),
  );
}

async function buildLegacySessionDetailResponse(session: TurnRecord) {
  const threadState = await readSessionThread(session);
  let responseSession = threadState.session;
  let transcriptTotal = 0;
  let codingHistorySummary: Awaited<ReturnType<typeof buildCodingHistorySummary>> | null = null;

  if (isConversation(threadState.session)) {
    await syncConversationHistoryFromThread(threadState.session, threadState.thread);
    transcriptTotal = await chatHistory.countMessages(threadState.session.id);
    const hasTranscript = transcriptTotal > 0;
    if (threadState.session.hasTranscript !== hasTranscript) {
      responseSession = (await store.updateConversation(threadState.session.id, {
        hasTranscript,
      })) ?? {
        ...threadState.session,
        hasTranscript,
      };
    }
  } else {
    codingHistorySummary = await buildCodingHistorySummary(threadState.session as SessionRecord, threadState.thread);
    transcriptTotal = codingHistorySummary.transcriptTotal;
    const hasTranscript = transcriptTotal > 0;
    if (threadState.session.hasTranscript !== hasTranscript) {
      responseSession = (await coding.updateSession(threadState.session.id, {
        hasTranscript,
      })) ?? {
        ...threadState.session,
        hasTranscript,
      };
    }
  }

  const codingHistoryView = isDeveloperSession(responseSession)
    ? (codingHistorySummary ?? await buildCodingHistorySummary(responseSession, threadState.thread))
    : { commands: [] as SessionCommandEvent[], changes: [] as SessionFileChangeEvent[] };
  return {
    session: responseSession,
    approvals: isDeveloperSession(responseSession) ? store.getApprovals(responseSession.id) : [],
    liveEvents: store.getLiveEvents(responseSession.id),
    thread: toThreadSummary(threadState.thread),
    transcriptTotal,
    commands: codingHistoryView.commands,
    changes: codingHistoryView.changes,
    draftAttachments: store.listDraftAttachments(responseSession.id).map(attachmentSummary),
  };
}

async function buildLegacySessionTranscriptResponse(
  session: TurnRecord,
  query: { before?: string; limit?: string } | undefined,
) {
  const threadState = await readSessionThread(session);
  const limit = normalizeTranscriptLimit(query?.limit);

  if (isConversation(threadState.session)) {
    await syncConversationHistoryFromThread(threadState.session, threadState.thread);
    const page = await chatHistory.pageMessages(threadState.session.id, {
      before: query?.before ?? null,
      limit,
    });
    return {
      items: page.items.map(chatMessageToTranscriptEntry),
      nextCursor: page.nextCursor,
      total: page.total,
    };
  }

  return pageTranscriptEntries(
    (await buildCodingHistoryView(threadState.session as SessionRecord, threadState.thread)).transcriptEntries,
    query?.before,
    limit,
  );
}

function userCanCreateSessionType(user: UserRecord, sessionType: SessionType) {
  return sessionType === 'chat'
    ? userCanUseMode(user, 'chat')
    : userCanUseMode(user, 'developer');
}

async function sessionApprovalsForUser(userId: string) {
  const sessions = await coding.listSessionsForUser(userId);
  const sessionIds = new Set(sessions.map((session) => session.id));
  return store.getAllApprovals().filter((approval) => sessionIds.has(approval.sessionId));
}

async function findRecordByThreadId(threadId: string) {
  const mirroredConversation = store.listConversations().find((conversation) => conversation.threadId === threadId) ?? null;
  if (mirroredConversation) {
    return mirroredConversation;
  }

  const persistedConversation = await chatHistory.findConversationRecordByThreadId(threadId);
  if (persistedConversation) {
    await syncConversationMirror(persistedConversation);
    return persistedConversation;
  }

  return coding.findSessionByThreadId(threadId);
}

async function syncConversationMirror(conversation: ConversationRecord) {
  const current = store.getConversation(conversation.id);
  if (
    current
    && current.updatedAt === conversation.updatedAt
    && current.threadId === conversation.threadId
    && current.activeTurnId === conversation.activeTurnId
  ) {
    return current;
  }

  await store.upsertConversation(conversation);
  return conversation;
}

async function getOwnedConversationOrReply(userId: string, conversationId: string, reply: FastifyReply) {
  const conversation = await chatHistory.getConversationRecordForUser(conversationId, userId);
  if (!conversation) {
    reply.code(404);
    return null;
  }
  await syncConversationMirror(conversation);
  return conversation;
}

async function getOwnedRecordOrReply(userId: string, recordId: string, reply: FastifyReply) {
  const conversation = store.getConversationForUser(recordId, userId) ?? await chatHistory.getConversationRecordForUser(recordId, userId);
  if (conversation) {
    await syncConversationMirror(conversation);
    return conversation;
  }

  const record = await coding.getSessionForUser(recordId, userId);
  if (!record) {
    reply.code(404);
    return null;
  }
  return record;
}

async function getCurrentRecord(recordId: string) {
  const conversation = store.getConversation(recordId) ?? await chatHistory.getConversationRecord(recordId);
  if (conversation) {
    await syncConversationMirror(conversation);
    return conversation;
  }

  return coding.getSession(recordId);
}

async function getOwnedCodingSessionOrReply(userId: string, sessionId: string, reply: FastifyReply) {
  const session = await coding.getSessionForUser(sessionId, userId);
  if (!session) {
    reply.code(404);
    return null;
  }
  return session;
}

async function getOwnedCodingWorkspaceOrReply(userId: string, workspaceId: string, reply: FastifyReply) {
  const workspace = await coding.getWorkspaceForUser(workspaceId, userId);
  if (!workspace) {
    reply.code(404);
    return null;
  }
  return workspace;
}

async function updateRecord(record: TurnRecord, patch: Partial<TurnRecord>) {
  if (isConversation(record)) {
    const nextConversation = (await store.updateConversation(record.id, patch as Partial<ConversationRecord>))
      ?? {
        ...record,
        ...(patch as Partial<ConversationRecord>),
        updatedAt: new Date().toISOString(),
      };
    if (!store.getConversation(record.id)) {
      await store.upsertConversation(nextConversation);
    }
    await chatHistory.ensureConversation(nextConversation);
    return nextConversation;
  }

  return coding.updateSession(record.id, patch as Partial<SessionRecord>);
}

async function readSessionThread(session: TurnRecord) {
  let currentSession = session;
  let thread: CodexThread | null = null;

  try {
    const response = await runtimeForRecord(session).readThread(session.threadId);
    if (isCodexThread(response.thread)) {
      thread = response.thread;
      const activeTurn = [...thread.turns].reverse().find((entry) => turnIsActive(entry.status)) ?? null;

      if (activeTurn) {
        if (currentSession.activeTurnId !== activeTurn.id || currentSession.status !== 'running') {
          if (isConversation(currentSession)) {
            const nextPatch: Partial<ConversationRecord> = {
              activeTurnId: activeTurn.id,
              status: 'running',
              recoveryState: 'ready',
              retryable: false,
              lastIssue: null,
            };
            currentSession = (await updateRecord(currentSession, nextPatch)) ?? {
              ...currentSession,
              ...nextPatch,
            };
          } else {
            const nextPatch: Partial<SessionRecord> = {
              activeTurnId: activeTurn.id,
              status: 'running',
              lastIssue: null,
            };
            currentSession = (await updateRecord(currentSession, nextPatch)) ?? {
              ...currentSession,
              ...nextPatch,
            };
          }
        }
      } else if (currentSession.activeTurnId || currentSession.status === 'running') {
        const nextStatus: SessionStatus = isDeveloperSession(currentSession) && store.getApprovals(currentSession.id).length > 0
          ? 'needs-approval'
          : 'idle';
        if (isConversation(currentSession)) {
          const nextPatch: Partial<ConversationRecord> = {
            activeTurnId: null,
            status: nextStatus,
            recoveryState: 'ready',
            retryable: false,
            lastIssue: null,
          };
          currentSession = (await updateRecord(currentSession, nextPatch)) ?? {
            ...currentSession,
            ...nextPatch,
          };
        } else {
          const nextPatch: Partial<SessionRecord> = {
            activeTurnId: null,
            status: nextStatus,
            lastIssue: null,
          };
          currentSession = (await updateRecord(currentSession, nextPatch)) ?? {
            ...currentSession,
            ...nextPatch,
          };
        }
      }
    }
  } catch (error) {
    if (isThreadMaterializingError(error)) {
      return {
        session: currentSession,
        thread,
      };
    }

    const message = errorMessage(error);
    app.log.warn(`thread/read failed for ${session.threadId}: ${message}`);

    if (isThreadUnavailableError(error)) {
      const latestSession = await getCurrentRecord(session.id);
      if (latestSession?.threadId === session.threadId) {
        if (isConversation(session)) {
          const nextPatch = unavailableChatConversationStatePatch(session);
          currentSession = (await updateRecord(session, nextPatch)) ?? {
            ...session,
            ...nextPatch,
          };
        } else {
          const nextPatch: Partial<SessionRecord> = {
            activeTurnId: null,
            status: 'stale',
            lastIssue: STALE_SESSION_MESSAGE,
            networkEnabled: false,
          };
          currentSession = (await updateRecord(session, nextPatch)) ?? {
            ...session,
            ...nextPatch,
          };
        }
        if (isDeveloperSession(session)) {
          store.clearApprovals(session.id);
        }
      } else if (latestSession) {
        currentSession = latestSession;
      }
    }
  }

  return {
    session: currentSession,
    thread,
  };
}

async function maybeAutoTitleChatSession(session: TurnRecord, threadOverride: CodexThread | null = null) {
  const latestSession = (await getCurrentRecord(session.id)) ?? session;
  if (latestSession.sessionType !== 'chat' || !latestSession.autoTitle) {
    return;
  }

  try {
    await chatPromptConfig.loadSystemPromptText();
    const rolePresetConfig = await chatPromptConfig.loadRolePresetConfig();
    let nextThread = threadOverride;
    if (!nextThread) {
      const response = await runtimeForExecutor(latestSession.executor).readThread(latestSession.threadId);
      nextThread = isCodexThread(response.thread) ? response.thread : null;
    }
    const nextTitle = deriveChatTitleFromThread(nextThread, latestSession.rolePresetId, rolePresetConfig);
    if (!nextTitle || nextTitle === latestSession.title) {
      return;
    }

    await updateRecord(latestSession, {
      title: nextTitle,
      autoTitle: false,
    });
  } catch (error) {
    if (!isThreadMaterializingError(error)) {
      app.log.warn(`chat auto-title failed for ${latestSession.id}: ${errorMessage(error)}`);
    }
  }
}

async function maybeAutoTitleCodingSession(session: SessionRecord, threadOverride: CodexThread | null = null) {
  const latestSession = (await coding.getSession(session.id)) ?? session;
  if (!latestSession.autoTitle) {
    return;
  }

  try {
    let nextThread = threadOverride;
    if (!nextThread) {
      const response = await runtimeForExecutor(latestSession.executor).readThread(latestSession.threadId);
      nextThread = isCodexThread(response.thread) ? response.thread : null;
    }
    const nextTitle = deriveCodingTitleFromThread(nextThread);
    if (!nextTitle || nextTitle === latestSession.title || isDefaultCodingSessionTitle(nextTitle)) {
      return;
    }

    await coding.updateSession(latestSession.id, {
      title: nextTitle,
      autoTitle: false,
    });
  } catch (error) {
    if (!isThreadMaterializingError(error)) {
      app.log.warn(`coding auto-title failed for ${latestSession.id}: ${errorMessage(error)}`);
    }
  }
}

async function repairPendingChatAutoTitles(conversations: ConversationRecord[]) {
  for (const conversation of conversations) {
    if (
      !conversation.autoTitle
      || !conversation.hasTranscript
      || conversation.title !== defaultChatTitle()
    ) {
      continue;
    }

    await maybeAutoTitleChatSession(conversation);
  }
}

async function resolveConversationTurnPreface(
  conversation: ConversationRecord,
  recoveryPrefaceText: string | null,
) {
  const systemPromptText = await chatPromptConfig.loadSystemPromptText();
  const rolePresetConfig = await chatPromptConfig.loadRolePresetConfig();
  const rolePromptText = chatPromptConfig.promptTextForRolePreset(conversation.rolePresetId, rolePresetConfig ?? undefined);
  return buildChatTurnPreface(recoveryPrefaceText, systemPromptText, rolePromptText);
}

async function persistConversationUserTurn(
  conversation: ConversationRecord,
  prompt: string | null,
  attachments: SessionAttachmentRecord[],
  turnId: string,
  recovery: {
    recoveryNeeded: boolean;
    threadGeneration: number;
  },
) {
  await chatHistory.appendMessages(conversation, [
    {
      role: 'user',
      body: prompt ?? '',
      attachments: attachmentRefsFromRecords(attachments),
      sourceThreadId: conversation.threadId,
      sourceTurnId: turnId,
      dedupeKey: `user:${turnId}`,
    },
  ]);

  if (recovery.recoveryNeeded) {
    await chatHistory.markRecoveryApplied(conversation.id, recovery.threadGeneration);
  }
}

const restartSessionThread = createSessionRestartService({
  chatRuntime,
  runtimeForExecutor,
  store,
  ensureChatWorkspace: (ownerUsername, ownerUserId) => ensureUserWorkspace(
    ownerUsername,
    ownerUserId,
    defaultChatWorkspaceName(),
  ),
  rotateConversationThread: (conversation, nextThreadId) => chatHistory.rotateConversationThread(conversation, nextThreadId),
  updateRecord,
});
const { createForkedSession, createForkedConversation } = createSessionForkService({
  chatRuntime,
  runtimeForExecutor,
  ensureChatWorkspace: (ownerUsername, ownerUserId) => ensureUserWorkspace(
    ownerUsername,
    ownerUserId,
    defaultChatWorkspaceName(),
  ),
  persistForkedSession: (session) => coding.upsertSession(session),
  persistForkedConversation: async (conversation) => {
    await store.upsertConversation(conversation);
    await chatHistory.ensureConversation(conversation);
  },
  currentDefaultModel,
  currentDefaultEffort,
  nextForkedSessionTitle,
});

const startTurnWithAutoRestart = createTurnStartService({
  chatRuntime,
  runtimeForExecutor,
  restartSessionThread,
  getCurrentRecord,
  prepareConversationRecoveryState,
  resolveConversationPreface: resolveConversationTurnPreface,
  buildTurnInput,
  updateRecord,
  markAttachmentsConsumed: (sessionId, attachmentIds) => store.markAttachmentsConsumed(sessionId, attachmentIds),
  persistConversationUserTurn,
  isThreadUnavailableError,
});
const { createMessage: createChatMessage, stopTurn: stopChatTurn } = createChatTurnService({
  store,
  interruptTurn: async (conversation, threadId, turnId) => {
    await runtimeForExecutor(conversation.executor).interruptTurn(threadId, turnId);
  },
  startTurnWithAutoRestart: async (conversation, prompt, attachments) => {
    const result = await startTurnWithAutoRestart(conversation, prompt, attachments);
    return {
      turn: result.turn,
      session: result.session as ConversationRecord,
    };
  },
  updateConversation: (conversation, patch) => updateRecord(conversation, patch) as Promise<ConversationRecord | null>,
  isThreadUnavailableError,
  unavailableConversationPatch: unavailableChatConversationStatePatch,
  errorMessage,
  staleSessionMessage: STALE_SESSION_MESSAGE,
});

for (const { runtime: registeredRuntime } of runtimeRegistry.entries()) {
  const handleServerRequest = createRuntimeServerRequestHandler({
    runtime: registeredRuntime,
    store,
    coding,
    findRecordByThreadId,
    updateRecord,
    approvalTitle,
    approvalRisk,
    blockedChatPermissionReason,
    requestedPermissionsFromParams,
  });

  bindRuntimeEvents({
    log: app.log,
    runtime: registeredRuntime,
    handleNotification,
    handleServerRequest,
    markAllStale: async () => {
      await Promise.all([
        store.markAllStale(STALE_SESSION_MESSAGE),
        chatHistory.markAllStale(STALE_SESSION_MESSAGE),
        coding.markAllStale(STALE_SESSION_MESSAGE),
      ]);
    },
  });
}

registerRequestAuthHook(app, {
  auth,
  authCookieName: AUTH_COOKIE_NAME,
  devBypassEnabled: DEV_DISABLE_AUTH,
  cookieIsSecure,
});

registerCoreRoutes(app, {
  devDisableAuth: DEV_DISABLE_AUTH,
  renderLoginPage: loginPageHtml,
  authCookieName: AUTH_COOKIE_NAME,
  cookieIsSecure,
  verifyCredentials: (username, password) => auth.verifyCredentials(username, password),
  getRequestUser,
  buildBootstrapResponse: buildAppBootstrapResponse,
  getCloudflareStatus: () => cloudflareStatusCache.get({ preferFresh: true }),
  connectCloudflare: connectCloudflareAndRefreshStatus,
  disconnectCloudflare: disconnectCloudflareAndRefreshStatus,
  errorMessage,
});

registerChatRoutes(app, {
  getRequestUser,
  userCanUseMode,
  listConversationRecordsForUser: (userId) => chatHistory.listConversationRecordsForUser(userId),
  repairPendingChatAutoTitles,
  loadChatRolePresetConfig: () => chatPromptConfig.loadRolePresetConfig(),
  apiRolePresets: (config) => chatPromptConfig.apiRolePresets(config),
  buildChatBootstrapResponse,
  getOwnedConversationOrReply,
  readSessionThread: (session) => readSessionThread(session),
  syncConversationMirror,
  syncConversationHistoryFromThread,
  countMessages: (conversationId) => chatHistory.countMessages(conversationId),
  updateConversation: (conversation, patch) => updateRecord(conversation, patch) as Promise<ConversationRecord | null>,
  buildChatConversationDetailPayload,
  toThreadSummary,
  normalizeTranscriptLimit,
  pageMessages: (conversationId, options) => chatHistory.pageMessages(conversationId, options),
  chatMessageToApiTranscriptEntry,
  compactChatLiveEvents,
  getLiveEvents: (conversationId) => store.getLiveEvents(conversationId),
  attachmentKindFromUpload,
  sanitizeAttachmentFilename,
  extractAttachmentText,
  addAttachment: (attachment) => store.addAttachment(attachment),
  chatAttachmentSummary,
  getAttachment: (conversationId, attachmentId) => store.getAttachment(conversationId, attachmentId),
  removeAttachment: (conversationId, attachmentId) => store.removeAttachment(conversationId, attachmentId),
  createChatConversation,
  renameConversation,
  updateConversationPreferences,
  restartSessionThread: async (conversation, reason) => (
    await restartSessionThread(conversation, reason)
  ) as ConversationRecord,
  archiveConversation,
  restoreConversation,
  createForkedConversation,
  errorMessage,
  listAttachments: (conversationId) => store.listAttachments(conversationId),
  deleteConversationState: (conversationId) => store.deleteConversation(conversationId),
  deleteConversationHistory: (conversationId) => chatHistory.deleteConversation(conversationId),
  deleteStoredAttachments,
  createChatMessage,
  stopChatTurn,
  toApiChatConversationRecord,
});

registerCodingRoutes(app, {
  getRequestUser,
  userCanUseMode,
  buildCodingBootstrapResponse,
  listUserWorkspaces,
  toCodingWorkspaceSummary,
  createCodingWorkspace,
  getOwnedCodingWorkspaceOrReply,
  updateCodingWorkspace,
  reorderWorkspaceList,
  createDeveloperSession,
  errorMessage,
  getOwnedCodingSessionOrReply,
  buildCodingSessionDetailResponse,
  buildCodingSessionTranscriptResponse,
  attachmentKindFromUpload,
  sanitizeAttachmentFilename,
  extractAttachmentText,
  addAttachment: (attachment) => store.addAttachment(attachment),
  codingAttachmentSummary,
  getAttachment: (sessionId, attachmentId) => store.getAttachment(sessionId, attachmentId),
  removeAttachment: (sessionId, attachmentId) => store.removeAttachment(sessionId, attachmentId),
  deleteStoredAttachments,
  trimOptional,
  normalizeWorkspaceFolderName,
  ensureUserWorkspace,
  normalizeSecurityProfile,
  normalizeApprovalMode,
  isExecutorSupported: (executor) => runtimeRegistry.get(executor) !== null,
  normalizeExecutor: normalizeAgentExecutor,
  updateCodingSession: (sessionId, patch) => coding.updateSession(sessionId, patch),
  currentDefaultModel,
  findModelOption: (model, executor) => modelCatalog.findByModel(model, executor),
  normalizeReasoningEffort,
  preferredReasoningEffortForModel,
  restartSessionThread: async (session, reason) => (
    await restartSessionThread(session, reason)
  ) as SessionRecord,
  createForkedSession,
  listAttachments: (sessionId) => store.listAttachments(sessionId),
  deleteCodingSession: async (sessionId) => {
    await codingHistory.deleteSession(sessionId);
    await coding.deleteSession(sessionId);
  },
  startTurnWithAutoRestart: async (session, prompt, attachments) => {
    const result = await startTurnWithAutoRestart(session, prompt, attachments);
    return {
      turn: result.turn,
      session: result.session as SessionRecord,
    };
  },
  isThreadUnavailableError,
  staleSessionMessage: STALE_SESSION_MESSAGE,
  interruptTurn: (session, threadId, turnId) => runtimeForExecutor(session.executor).interruptTurn(threadId, turnId),
  addLiveEvent: (sessionId, event) => store.addLiveEvent(sessionId, event),
  getApprovals: (sessionId) => store.getApprovals(sessionId),
  respondToRuntime: async (session, rpcRequestId, payload) => {
    await runtimeForExecutor(session.executor).respond(rpcRequestId, payload);
  },
  removeApproval: (sessionId, approvalId) => store.removeApproval(sessionId, approvalId),
});

registerWorkspaceRoutes(app, {
  getRequestUser,
  userCanUseMode,
  userWorkspaceRoot,
  listUserWorkspaces,
  normalizeWorkspaceFolderName,
  ensureUserWorkspace,
  errorMessage,
  getOwnedWorkspace: (workspaceId, userId) => coding.getWorkspaceForUser(workspaceId, userId),
  updateWorkspace: (workspaceId, patch) => coding.updateWorkspace(workspaceId, patch),
});

registerAdminRoutes(app, {
  getRequestUser,
  trimOptional,
  errorMessage,
  cookieIsSecure,
  chatPromptConfig,
  adminUserService,
});

registerSessionRoutes(app, {
  getRequestUser,
  getOwnedRecordOrReply,
  buildSessionDetailResponse: buildLegacySessionDetailResponse,
  buildSessionTranscriptResponse: buildLegacySessionTranscriptResponse,
  attachmentKindFromUpload,
  sanitizeAttachmentFilename,
  extractAttachmentText,
  addAttachment: (attachment) => store.addAttachment(attachment),
  attachmentSummary,
  getAttachment: (sessionId, attachmentId) => store.getAttachment(sessionId, attachmentId),
  removeAttachment: (sessionId, attachmentId) => store.removeAttachment(sessionId, attachmentId),
  normalizeSessionType,
  trimOptional,
  userCanCreateSessionType,
  normalizeWorkspaceFolderName,
  ensureUserWorkspace,
  getOwnedWorkspace: (workspaceId, userId) => coding.getWorkspaceForUser(workspaceId, userId),
  errorMessage,
  createChatConversation,
  createDeveloperSession,
  restartSessionThread,
  createForkedSession,
  createForkedConversation,
  updateRecord,
  normalizeSecurityProfile,
  normalizeApprovalMode,
  updateConversationPreferences,
  renameConversation,
  archiveConversation,
  restoreConversation,
  clearApprovals: (sessionId) => store.clearApprovals(sessionId),
  deleteConversationState: (conversationId) => store.deleteConversation(conversationId),
  deleteConversationHistory: (conversationId) => chatHistory.deleteConversation(conversationId),
  deleteCodingSession: async (sessionId) => {
    await codingHistory.deleteSession(sessionId);
    await coding.deleteSession(sessionId);
  },
  deleteStoredAttachments,
  listAttachments: (sessionId) => store.listAttachments(sessionId),
  createChatMessage,
  stopChatTurn,
  startTurnWithAutoRestart: async (session, prompt, attachments) => {
    const result = await startTurnWithAutoRestart(session, prompt, attachments);
    return {
      turn: result.turn,
      session: result.session as SessionRecord,
    };
  },
  interruptTurn: (session, threadId, turnId) => runtimeForExecutor(session.executor).interruptTurn(threadId, turnId),
  addLiveEvent: (sessionId, event) => store.addLiveEvent(sessionId, event),
  isThreadUnavailableError,
  staleSessionMessage: STALE_SESSION_MESSAGE,
  getApprovals: (sessionId) => store.getApprovals(sessionId),
  respondToRuntime: async (session, rpcRequestId, payload) => {
    await runtimeForExecutor(session.executor).respond(rpcRequestId, payload);
  },
  removeApproval: (sessionId, approvalId) => store.removeApproval(sessionId, approvalId),
  updateCodingSession: (sessionId, patch) => coding.updateSession(sessionId, patch),
  currentDefaultModel,
  findModelOption: (model, executor) => modelCatalog.findByModel(model, executor),
  normalizeReasoningEffort,
  preferredReasoningEffortForModel,
});

await registerWebClientServing(app, {
  webDistDir: WEB_DIST_DIR,
});

const shutdown = async () => {
  await runtime.shutdown();
  await app.close();
};

process.on('SIGINT', () => {
  void shutdown().finally(() => process.exit(0));
});
process.on('SIGTERM', () => {
  void shutdown().finally(() => process.exit(0));
});

try {
  await app.listen({ host: HOST, port: PORT });
} catch (error) {
  app.log.error(error);
  await runtime.shutdown();
  process.exit(1);
}
