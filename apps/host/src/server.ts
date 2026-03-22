import { mkdir, readFile, readdir, stat, unlink, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { basename, extname, join, resolve } from 'node:path';

import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import cors from '@fastify/cors';
import fastifyCookie from '@fastify/cookie';
import fastifyMultipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import { PDFParse } from 'pdf-parse';

import {
  AUTH_COOKIE_NAME,
  createUser,
  deleteUser,
  findUserByToken,
  getPublicUsers,
  loadOrCreateAuthState,
  loginPageHtml,
  toUserRecord,
  updateUser,
  verifyPassword,
} from './auth.js';
import { buildBootstrapPayload } from './bootstrap.js';
import {
  ChatHistoryRepository,
  type ChatMessageRecord,
  type PersistedChatAttachmentRef,
} from './chat-history.js';
import { CloudflareTunnelManager } from './cloudflare.js';
import { CodexAppServerClient, type JsonRpcNotification, type JsonRpcServerRequest } from './codex-app-server.js';
import { HOST, PORT, WEB_DIST_DIR, WORKSPACE_ROOT } from './config.js';
import { getMongoDb } from './mongo.js';
import { SessionStore } from './store.js';
import type {
  ApprovalMode,
  CodexThread,
  CodexThreadInput,
  CodexThreadItem,
  ConversationRecord,
  CreateWorkspaceRequest,
  CreateConversationRequest,
  CreateSessionRequest,
  CreateTurnRequest,
  CreateUserRequest,
  ModelOption,
  PendingApproval,
  ReasoningEffort,
  ResolveApprovalRequest,
  SessionAttachmentKind,
  SessionAttachmentRecord,
  SessionAttachmentSummary,
  SecurityProfile,
  SessionCommandEvent,
  SessionEvent,
  SessionFileChangeEvent,
  SessionRecord,
  SessionTranscriptEntry,
  SessionType,
  UpdateConversationRequest,
  UpdateSessionRequest,
  UpdateSessionPreferencesRequest,
  UpdateWorkspaceRequest,
  UpdateUserRequest,
  UserRecord,
  WorkspaceSummary,
} from './types.js';

type AuthenticatedRequest = FastifyRequest & {
  authUser?: UserRecord;
};

type TurnRecord = ConversationRecord | SessionRecord;

const FALLBACK_MODELS: ModelOption[] = [
  {
    id: 'gpt-5-codex',
    displayName: 'GPT-5 Codex',
    model: 'gpt-5-codex',
    description: 'Fallback default when the model catalog is unavailable.',
    isDefault: true,
    hidden: false,
    defaultReasoningEffort: 'medium',
    supportedReasoningEfforts: ['minimal', 'low', 'medium', 'high'],
  },
];

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

function requestPath(url: string) {
  return url.split('?')[0] ?? url;
}

function clearTokenFromUrl(url: string) {
  const parsed = new URL(url, 'http://127.0.0.1');
  parsed.searchParams.delete('token');
  const query = parsed.searchParams.toString();
  return `${parsed.pathname}${query ? `?${query}` : ''}`;
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

function normalizeApprovalMode(value: unknown): ApprovalMode {
  return value === 'full-approval' ? 'full-approval' : 'less-approval';
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

function defaultChatWorkspaceName(sessionId: string) {
  return `chat-${sessionId.slice(0, 8)}`;
}

function defaultChatTitle() {
  return 'New chat';
}

function availableModesForUser(user: UserRecord) {
  const modes = [
    ...(user.roles.includes('developer') ? (['developer'] as const) : []),
    ...(user.roles.includes('user') ? (['chat'] as const) : []),
  ];
  return modes.length > 0 ? modes : ['chat'];
}

function userCanUseMode(user: UserRecord, mode: 'chat' | 'developer') {
  return availableModesForUser(user).includes(mode);
}

function normalizeGeneratedTitle(value: string | null | undefined) {
  const normalized = (value ?? '')
    .replace(/\s+/g, ' ')
    .trim();

  if (!normalized) return null;
  return normalized.length > 60
    ? `${normalized.slice(0, 59).trimEnd()}…`
    : normalized;
}

function extractFirstUserPrompt(thread: CodexThread | null) {
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

function deriveChatTitleFromThread(thread: CodexThread | null) {
  return normalizeGeneratedTitle(thread?.preview)
    ?? normalizeGeneratedTitle(extractFirstUserPrompt(thread));
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

function userWorkspaceRoot(username: string, userId: string) {
  return join(
    WORKSPACE_ROOT,
    normalizeWorkspaceSegment(username, `user-${userId.slice(0, 8)}`),
  );
}

async function ensureUserWorkspaceRoot(
  username: string,
  userId: string,
) {
  const root = userWorkspaceRoot(username, userId);
  await mkdir(root, { recursive: true });
  return root;
}

async function listUserWorkspaces(
  username: string,
  userId: string,
): Promise<{ root: string; workspaces: WorkspaceSummary[] }> {
  const root = await ensureUserWorkspaceRoot(username, userId);
  const entries = await readdir(root, { withFileTypes: true });
  const workspaces = await Promise.all(entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
    .map(async (entry) => {
      const workspace = await store.ensureWorkspace({
        ownerUserId: userId,
        ownerUsername: username,
        name: entry.name,
        path: join(root, entry.name),
      });
      return {
        id: workspace.id,
        name: workspace.name,
        path: workspace.path,
        visible: workspace.visible,
        sortOrder: workspace.sortOrder,
      };
    }));
  workspaces.sort((left, right) => left.name.localeCompare(right.name));
  return { root, workspaces };
}

async function ensureUserWorkspace(
  username: string,
  userId: string,
  workspaceName: string,
) {
  const root = await ensureUserWorkspaceRoot(username, userId);
  const workspace = join(root, workspaceName);
  await mkdir(workspace, { recursive: true });
  await ensureWorkspaceExists(workspace);
  const record = await store.ensureWorkspace({
    ownerUserId: userId,
    ownerUsername: username,
    name: workspaceName,
    path: workspace,
  });
  return {
    root,
    id: record.id,
    name: record.name,
    path: record.path,
    visible: record.visible,
    sortOrder: record.sortOrder,
  };
}

function attachmentContentPath(_ownerKind: 'conversation' | 'session', ownerId: string, attachmentId: string) {
  return `/api/sessions/${ownerId}/attachments/${attachmentId}/content`;
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

function attachmentSummary(record: SessionAttachmentRecord): SessionAttachmentSummary {
  return {
    id: record.id,
    kind: record.kind,
    filename: record.filename,
    mimeType: record.mimeType,
    sizeBytes: record.sizeBytes,
    url: attachmentContentPath(record.ownerKind, record.ownerId, record.id),
    createdAt: record.createdAt,
  };
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
  });
  const extractedText = attachment.extractedText?.trim();
  const body = extractedText
    ? truncateAttachmentText(extractedText)
    : `The user attached a file named ${attachment.filename} (${attachment.mimeType}), but no extractable text was found.`;

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

function itemToTranscriptEntry(
  item: CodexThreadItem,
  index: number,
  sessionId: string,
  attachments: SessionAttachmentRecord[],
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
              attachmentItems.push(attachmentSummary(attachment));
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
          attachmentItems.push(attachmentSummary(attachment));
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
      path: typeof change.path === 'string' ? change.path : 'unknown',
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

function collectTranscriptEntries(thread: CodexThread | null, sessionId: string, attachments: SessionAttachmentRecord[]) {
  if (!thread) return [];

  const entries: SessionTranscriptEntry[] = [];
  for (const turn of thread.turns) {
    for (const item of turn.items) {
      const entry = itemToTranscriptEntry(item, entries.length, sessionId, attachments);
      if (entry) {
        entries.push(entry);
      }
    }
  }
  return entries;
}

function collectCommands(thread: CodexThread | null) {
  if (!thread) return [];

  const commands: SessionCommandEvent[] = [];
  for (const turn of thread.turns) {
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

function collectFileChanges(thread: CodexThread | null) {
  if (!thread) return [];

  const changes: SessionFileChangeEvent[] = [];
  for (const turn of thread.turns) {
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
          path: typeof change.path === 'string' ? change.path : '',
          kind: typeof change.kind?.type === 'string' ? change.kind.type : 'update',
          status: typeof fileChangeItem.status === 'string' ? fileChangeItem.status : '',
          diff: typeof change.diff === 'string' ? change.diff : null,
        });
      }
    }
  }
  return changes;
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

function chatMessageToTranscriptEntry(message: ChatMessageRecord): SessionTranscriptEntry {
  return {
    id: message.id,
    index: message.seq,
    kind: message.role,
    body: message.body,
    markdown: true,
    label: null,
    title: null,
    meta: null,
    attachments: attachmentSummariesFromRefs(message.conversationId, message.attachments),
  };
}

function formatChatMessageForMemory(message: ChatMessageRecord) {
  const text = message.body.trim();
  if (text) {
    return text;
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

async function waitForTurnThread(threadId: string, turnId: string, timeoutMs = CHAT_SUMMARY_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const response = await codex.readThread(threadId);
    const thread = isCodexThread(response.thread) ? response.thread : null;
    const turn = thread?.turns.find((entry) => entry.id === turnId) ?? null;
    if (thread && turn && !turnIsActive(turn.status)) {
      if (turn.error?.message) {
        throw new Error(turn.error.message);
      }
      return thread;
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
): Array<{
  role: 'user' | 'assistant';
  body: string;
  attachments: PersistedChatAttachmentRef[];
  sourceTurnId: string;
  sourceItemId: string;
  dedupeKey: string;
}> {
  const attachmentsById = new Map(attachments.map((attachment) => [attachment.id, attachment]));
  const messages: Array<{
    role: 'user' | 'assistant';
    body: string;
    attachments: PersistedChatAttachmentRef[];
    sourceTurnId: string;
    sourceItemId: string;
    dedupeKey: string;
  }> = [];

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
          .map((attachment) => ({
            attachmentId: attachment.id,
            kind: attachment.kind,
            filename: attachment.filename,
            mimeType: attachment.mimeType,
            sizeBytes: attachment.sizeBytes,
            storagePath: attachment.storagePath,
            createdAt: attachment.createdAt,
          })),
        sourceTurnId: turn.id,
        sourceItemId: item.id,
        dedupeKey: entry.kind === 'user' ? `user:${turn.id}` : `assistant:${item.id}`,
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
  if (runtimeMessages.length === 0) {
    return;
  }

  await chatHistory.appendMessages(conversation, runtimeMessages.map((message) => ({
    role: message.role,
    body: message.body,
    attachments: message.attachments,
    sourceThreadId: thread.id,
    sourceTurnId: message.sourceTurnId,
    sourceItemId: message.sourceItemId,
    dedupeKey: message.dedupeKey,
  })));
}

async function generateConversationSummary(
  conversation: ConversationRecord,
  existingSummary: string | null,
  messages: ChatMessageRecord[],
) {
  if (messages.length === 0) {
    return existingSummary?.trim() ?? '';
  }

  const threadResponse = await codex.startThread({
    cwd: conversation.workspace,
    securityProfile: 'read-only',
    model: conversation.model,
  });
  const turnResponse = await codex.startTurn(
    threadResponse.thread.id,
    [textThreadInput(buildChatSummaryPrompt(existingSummary, messages))],
    {
      model: conversation.model,
      effort: conversation.reasoningEffort,
    },
  );
  const thread = await waitForTurnThread(threadResponse.thread.id, turnResponse.turn.id);
  const summary = assistantTextFromTurn(thread, turnResponse.turn.id);
  if (!summary) {
    throw new Error(`Summary generation returned no assistant text for conversation ${conversation.id}`);
  }
  return summary.trim();
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
        model: conversation.model ?? null,
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

let authState = await loadOrCreateAuthState();
const seedUsers = getPublicUsers(authState);
const fallbackOwner = seedUsers.find((entry) => entry.isAdmin) ?? seedUsers[0]!;

const store = new SessionStore();
await store.load({
  fallbackOwnerUserId: fallbackOwner.id,
  fallbackOwnerUsername: fallbackOwner.username,
});
const chatHistory = new ChatHistoryRepository(await getMongoDb());
await chatHistory.ensureIndexes();

const codex = new CodexAppServerClient();
await codex.ensureStarted();
await store.markAllStale(STALE_SESSION_MESSAGE);
const cloudflare = new CloudflareTunnelManager();

let availableModels = [...FALLBACK_MODELS];

async function refreshAvailableModels() {
  try {
    const next = await codex.listModels();
    if (next.length > 0) {
      availableModels = next.filter((entry) => !entry.hidden);
    }
  } catch (error) {
    app.log.warn(`model/list failed, using fallback catalog: ${errorMessage(error)}`);
  }
}

await refreshAvailableModels();

function currentDefaultModel() {
  return availableModels.find((entry) => entry.isDefault)?.model ?? availableModels[0]?.model ?? FALLBACK_MODELS[0]!.model;
}

function resolveModelOption(model: string | null | undefined) {
  return availableModels.find((entry) => entry.model === model)
    ?? availableModels.find((entry) => entry.isDefault)
    ?? availableModels[0]
    ?? FALLBACK_MODELS[0]!;
}

function preferredReasoningEffortForModel(modelOption: ModelOption) {
  if (modelOption.supportedReasoningEfforts.includes('medium')) {
    return 'medium' as const;
  }

  if (modelOption.supportedReasoningEfforts.includes(modelOption.defaultReasoningEffort)) {
    return modelOption.defaultReasoningEffort;
  }

  return modelOption.supportedReasoningEfforts[0] ?? 'medium';
}

function currentDefaultEffort(model: string | null | undefined) {
  return preferredReasoningEffortForModel(resolveModelOption(model));
}

function userCanCreateSessionType(user: UserRecord, sessionType: SessionType) {
  return sessionType === 'chat'
    ? userCanUseMode(user, 'chat')
    : userCanUseMode(user, 'developer');
}

function sessionApprovalsForUser(userId: string) {
  return store.getAllApprovalsForUser(userId);
}

function getOwnedRecordOrReply(userId: string, recordId: string, reply: FastifyReply) {
  const record = store.getConversationForUser(recordId, userId) ?? store.getSessionForUser(recordId, userId);
  if (!record) {
    reply.code(404);
    return null;
  }
  return record;
}

function getCurrentRecord(recordId: string) {
  return store.getConversation(recordId) ?? store.getSession(recordId);
}

async function updateRecord(record: TurnRecord, patch: Partial<TurnRecord>) {
  return isConversation(record)
    ? store.updateConversation(record.id, patch as Partial<ConversationRecord>)
    : store.updateSession(record.id, patch as Partial<SessionRecord>);
}

async function readSessionThread(session: TurnRecord) {
  let currentSession = session;
  let thread: CodexThread | null = null;

  try {
    const response = await codex.readThread(session.threadId);
    if (isCodexThread(response.thread)) {
      thread = response.thread;
    }
  } catch (error) {
    const message = errorMessage(error);
    app.log.warn(`thread/read failed for ${session.threadId}: ${message}`);

    if (isThreadUnavailableError(error)) {
      const latestSession = getCurrentRecord(session.id);
      if (latestSession?.threadId === session.threadId) {
        currentSession = (await updateRecord(session, {
          activeTurnId: null,
          status: 'stale',
          lastIssue: STALE_SESSION_MESSAGE,
          networkEnabled: false,
        })) ?? session;
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

async function maybeAutoTitleChatSession(session: TurnRecord) {
  const latestSession = getCurrentRecord(session.id) ?? session;
  if (latestSession.sessionType !== 'chat' || !latestSession.autoTitle) {
    return;
  }

  try {
    const response = await codex.readThread(latestSession.threadId);
    const thread = isCodexThread(response.thread) ? response.thread : null;
    const nextTitle = deriveChatTitleFromThread(thread);
    if (!nextTitle) {
      return;
    }

    await store.updateConversation(latestSession.id, {
      title: nextTitle,
      autoTitle: false,
    });
  } catch (error) {
    app.log.warn(`chat auto-title failed for ${latestSession.id}: ${errorMessage(error)}`);
  }
}

async function restartSessionThread(session: TurnRecord, summary = 'Started a fresh Codex thread for this session.') {
  const threadResponse = await codex.startThread({
    cwd: session.workspace,
    securityProfile: session.securityProfile,
    model: session.model,
  });

  store.clearApprovals(session.id);
  store.clearLiveEvents(session.id);
  store.addLiveEvent(session.id, {
    id: randomUUID(),
    method: 'session/restarted',
    summary,
    createdAt: new Date().toISOString(),
  });

  const nextSession = (await updateRecord(session, {
    threadId: threadResponse.thread.id,
    activeTurnId: null,
    status: 'idle',
    networkEnabled: false,
    lastIssue: null,
  })) ?? session;

  if (isConversation(nextSession)) {
    await chatHistory.rotateConversationThread(nextSession, threadResponse.thread.id);
  }

  return nextSession;
}

async function createForkedSession(currentUser: UserRecord, sourceSession: SessionRecord) {
  const nextModel = sourceSession.model ?? currentDefaultModel();
  const nextReasoningEffort = sourceSession.reasoningEffort ?? currentDefaultEffort(nextModel);
  const nextTitle = nextForkedSessionTitle(sourceSession.title);
  const threadResponse = await codex.startThread({
    cwd: sourceSession.workspace,
    securityProfile: sourceSession.securityProfile,
    model: nextModel,
  });

  const now = new Date().toISOString();
  const nextSession: SessionRecord = {
    id: randomUUID(),
    ownerUserId: currentUser.id,
    ownerUsername: currentUser.username,
    sessionType: 'code',
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
    createdAt: now,
    updatedAt: now,
  };

  await store.upsertSession(nextSession);
  return nextSession;
}

async function createForkedConversation(currentUser: UserRecord, sourceConversation: ConversationRecord) {
  const nextModel = sourceConversation.model ?? currentDefaultModel();
  const nextReasoningEffort = sourceConversation.reasoningEffort ?? currentDefaultEffort(nextModel);
  const nextTitle = nextForkedSessionTitle(sourceConversation.title);
  const threadResponse = await codex.startThread({
    cwd: sourceConversation.workspace,
    securityProfile: 'read-only',
    model: nextModel,
  });

  const now = new Date().toISOString();
  const nextConversation: ConversationRecord = {
    id: randomUUID(),
    ownerUserId: currentUser.id,
    ownerUsername: currentUser.username,
    sessionType: 'chat',
    threadId: threadResponse.thread.id,
    activeTurnId: null,
    title: nextTitle,
    autoTitle: false,
    workspace: sourceConversation.workspace,
    archivedAt: null,
    securityProfile: 'read-only',
    approvalMode: 'less-approval',
    networkEnabled: false,
    fullHostEnabled: false,
    status: 'idle',
    lastIssue: null,
    hasTranscript: false,
    model: nextModel,
    reasoningEffort: nextReasoningEffort,
    createdAt: now,
    updatedAt: now,
  };

  await store.upsertConversation(nextConversation);
  await chatHistory.ensureConversation(nextConversation);
  return nextConversation;
}

async function startTurnWithAutoRestart(session: TurnRecord, prompt: string | null, attachments: SessionAttachmentRecord[]) {
  let currentSession = session;

  if (currentSession.status === 'stale') {
    currentSession = await restartSessionThread(
      currentSession,
      'Automatically created a fresh thread before sending the next prompt.',
    );
  }

  const runTurn = async (targetSession: TurnRecord) => {
    const recovery = isConversation(targetSession)
      ? await prepareConversationRecoveryState(targetSession)
      : {
        recoveryNeeded: false,
        threadGeneration: 0,
        prefaceText: null as string | null,
      };
    const input = buildTurnInput(prompt, attachments, {
      prefaceText: recovery.prefaceText,
    });
    await updateRecord(targetSession, { status: 'running', lastIssue: null });
    const turn = await codex.startTurn(targetSession.threadId, input, {
      model: targetSession.model,
      effort: targetSession.reasoningEffort,
    });
    await store.markAttachmentsConsumed(targetSession.id, attachments.map((attachment) => attachment.id));
    await updateRecord(targetSession, {
      activeTurnId: turn.turn.id,
      status: 'running',
      lastIssue: null,
      hasTranscript: true,
    });
    if (isConversation(targetSession)) {
      await chatHistory.appendMessages(targetSession, [
        {
          role: 'user',
          body: prompt ?? '',
          attachments: attachmentRefsFromRecords(attachments),
          sourceThreadId: targetSession.threadId,
          sourceTurnId: turn.turn.id,
          dedupeKey: `user:${turn.turn.id}`,
        },
      ]);
      if (recovery.recoveryNeeded) {
        await chatHistory.markRecoveryApplied(targetSession.id, recovery.threadGeneration);
      }
    }
    return turn;
  };

  try {
    const turn = await runTurn(currentSession);
    return { session: currentSession, turn };
  } catch (error) {
    if (!isThreadUnavailableError(error)) {
      throw error;
    }

    const latestSession = getCurrentRecord(currentSession.id) ?? currentSession;
    currentSession = await restartSessionThread(
      latestSession,
      'Automatically created a fresh thread after a runtime reset.',
    );
    const turn = await runTurn(currentSession);
    return { session: currentSession, turn };
  }
}

async function handleChatApprovalRejection(session: TurnRecord, message: JsonRpcServerRequest) {
  if (message.method === 'item/permissions/requestApproval') {
    await codex.respond(message.id, {
      permissions: {},
      scope: 'turn',
    });
  } else if (
    message.method === 'item/commandExecution/requestApproval'
    || message.method === 'item/fileChange/requestApproval'
  ) {
    await codex.respond(message.id, {
      decision: 'decline',
    });
  } else {
    await codex.respond(message.id, {
      decision: 'cancel',
    });
  }

  store.addLiveEvent(session.id, {
    id: randomUUID(),
    method: 'session/chat-tool-blocked',
    summary: 'Blocked a tool or permission request in a chat-only session.',
    createdAt: new Date().toISOString(),
  });
}

codex.on('debug', (message) => {
  app.log.info(message);
});

codex.on('notification', (message: JsonRpcNotification) => {
  void handleNotification(message);
});

codex.on('serverRequest', (message: JsonRpcServerRequest) => {
  void handleServerRequest(message);
});

codex.on('runtimeStopped', (message: string) => {
  app.log.warn(message);
  void store.markAllStale(STALE_SESSION_MESSAGE);
});

async function handleNotification(message: JsonRpcNotification) {
  const threadId = extractThreadId(message.params);
  if (!threadId) return;

  const session = store.findByThreadId(threadId);
  if (!session) return;

  const event: SessionEvent = {
    id: randomUUID(),
    method: message.method,
    summary: summarizeNotification(message.method, (message.params ?? {}) as Record<string, unknown>),
    createdAt: new Date().toISOString(),
  };
  store.addLiveEvent(session.id, event);

  if (message.method === 'thread/status/changed') {
    const statusType = String(((message.params as Record<string, unknown>).status as { type?: string } | undefined)?.type ?? '');
    const nextStatus = statusType === 'active' ? 'running' : statusType === 'idle' ? 'idle' : session.status;
    await updateRecord(session, {
      status: nextStatus,
      lastIssue: null,
      ...(statusType === 'idle' ? { activeTurnId: null } : {}),
    });
    return;
  }

  if (message.method === 'turn/completed') {
    await updateRecord(session, {
      activeTurnId: null,
      status: isDeveloperSession(session) && store.getApprovals(session.id).length > 0 ? 'needs-approval' : 'idle',
      lastIssue: null,
    });
    await maybeAutoTitleChatSession(session);
    if (isConversation(session)) {
      const latestSession = getCurrentRecord(session.id);
      if (latestSession && isConversation(latestSession)) {
        const threadState = await readSessionThread(latestSession);
        if (isConversation(threadState.session)) {
          await syncConversationHistoryFromThread(threadState.session, threadState.thread);
        }
      }
    }
  }
}

async function handleServerRequest(message: JsonRpcServerRequest) {
  const threadId = extractThreadId(message.params);
  if (!threadId) {
    await codex.respond(message.id, { decision: 'cancel' });
    return;
  }

  const session = store.findByThreadId(threadId);
  if (!session) {
    await codex.respond(message.id, { decision: 'cancel' });
    return;
  }

  if (session.sessionType === 'chat') {
    await handleChatApprovalRejection(session, message);
    return;
  }

  const approval: PendingApproval = {
    id: String(message.id),
    sessionId: session.id,
    rpcRequestId: message.id,
    method: message.method,
    title: approvalTitle(message.method),
    risk: approvalRisk(message.method, (message.params ?? {}) as Record<string, unknown>),
    scopeOptions: ['once', 'session'],
    source: 'codex',
    payload: message.params ?? {},
    createdAt: new Date().toISOString(),
  };

  store.addApproval(approval);
  store.addLiveEvent(session.id, {
    id: randomUUID(),
    method: message.method,
    summary: approval.title,
    createdAt: approval.createdAt,
  });
  await store.updateSession(session.id, { status: 'needs-approval', lastIssue: null });
}

app.addHook('onRequest', async (request, reply) => {
  const path = requestPath(request.url);
  const tokenFromQuery = typeof (request.query as { token?: unknown } | undefined)?.token === 'string'
    ? (request.query as { token?: string }).token
    : null;
  const cookieToken = request.cookies[AUTH_COOKIE_NAME];
  const authorization = request.headers.authorization;
  const bearerToken = typeof authorization === 'string' && authorization.startsWith('Bearer ')
    ? authorization.slice('Bearer '.length).trim()
    : null;

  const matchedUser = [tokenFromQuery, cookieToken, bearerToken]
    .map((candidate) => findUserByToken(authState, candidate))
    .find((entry) => entry !== null) ?? null;

  if (matchedUser) {
    (request as AuthenticatedRequest).authUser = toUserRecord(matchedUser);

    if (cookieToken !== matchedUser.token) {
      reply.setCookie(AUTH_COOKIE_NAME, matchedUser.token, {
        path: '/',
        httpOnly: true,
        sameSite: 'lax',
        secure: cookieIsSecure(request),
      });
    }

    if (tokenFromQuery && request.method === 'GET' && !path.startsWith('/api/')) {
      return reply.redirect(clearTokenFromUrl(request.url));
    }

    return;
  }

  if (
    path === '/login'
    || path === '/api/auth/login'
    || path === '/api/health'
  ) {
    return;
  }

  if (path.startsWith('/api/')) {
    reply.code(401).send({ error: 'Authentication required' });
    return reply;
  }

  return reply.redirect('/login');
});

app.get('/login', async (_request, reply) => {
  reply.type('text/html; charset=utf-8');
  reply.header('Cache-Control', 'no-store');
  return loginPageHtml();
});

app.post('/api/auth/login', async (request, reply) => {
  const body = request.body as { username?: string; password?: string } | undefined;
  const username = body?.username?.trim() ?? '';
  const password = body?.password ?? '';
  const user = verifyPassword(authState, username, password);

  if (!user) {
    reply.code(401);
    return { error: 'Invalid username or password' };
  }

  reply.setCookie(AUTH_COOKIE_NAME, user.token, {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    secure: cookieIsSecure(request),
  });
  return { ok: true, username: user.username };
});

app.post('/api/auth/logout', async (_request, reply) => {
  reply.clearCookie(AUTH_COOKIE_NAME, {
    path: '/',
  });
  return { ok: true };
});

app.get('/api/health', async () => ({
  ok: true,
  service: 'remote-vibe-coding-host',
}));

app.get('/api/bootstrap', async (request) => {
  const currentUser = getRequestUser(request);
  const workspaceState = userCanUseMode(currentUser, 'developer')
    ? await listUserWorkspaces(currentUser.username, currentUser.id)
    : { root: userWorkspaceRoot(currentUser.username, currentUser.id), workspaces: [] };
  return buildBootstrapPayload(
    currentUser,
    store.listSessionsForUser(currentUser.id),
    store.listConversationsForUser(currentUser.id),
    sessionApprovalsForUser(currentUser.id),
    await cloudflare.getStatus(),
    workspaceState.root,
    workspaceState.workspaces,
    availableModels,
  );
});

app.get('/api/workspaces', async (request) => {
  const currentUser = getRequestUser(request);
  if (!userCanUseMode(currentUser, 'developer')) {
    return {
      workspaceRoot: userWorkspaceRoot(currentUser.username, currentUser.id),
      workspaces: [],
    };
  }
  const workspaceState = await listUserWorkspaces(currentUser.username, currentUser.id);
  return {
    workspaceRoot: workspaceState.root,
    workspaces: workspaceState.workspaces,
  };
});

app.post('/api/workspaces', async (request, reply) => {
  const currentUser = getRequestUser(request);
  if (!userCanUseMode(currentUser, 'developer')) {
    reply.code(403);
    return { error: 'Developer access required.' };
  }
  const body = (request.body ?? {}) as CreateWorkspaceRequest;
  const workspaceName = normalizeWorkspaceFolderName(body.name);
  if (!workspaceName) {
    reply.code(400);
    return { error: 'Workspace name is required.' };
  }

  try {
    const workspace = await ensureUserWorkspace(currentUser.username, currentUser.id, workspaceName);
    const workspaceState = await listUserWorkspaces(currentUser.username, currentUser.id);
    return {
      workspace: {
        id: workspace.id,
        name: workspace.name,
        path: workspace.path,
        visible: workspace.visible,
        sortOrder: workspace.sortOrder,
      },
      workspaceRoot: workspaceState.root,
      workspaces: workspaceState.workspaces,
    };
  } catch (error) {
    reply.code(400);
    return { error: errorMessage(error) };
  }
});

app.patch('/api/workspaces/:workspaceId', async (request, reply) => {
  const currentUser = getRequestUser(request);
  if (!userCanUseMode(currentUser, 'developer')) {
    reply.code(403);
    return { error: 'Developer access required.' };
  }

  const { workspaceId } = request.params as { workspaceId: string };
  const workspace = store.getWorkspaceForUser(workspaceId, currentUser.id);
  if (!workspace) {
    reply.code(404);
    return { error: 'Workspace not found.' };
  }

  const body = (request.body ?? {}) as UpdateWorkspaceRequest;
  const patch: Partial<typeof workspace> = {};

  if (Object.prototype.hasOwnProperty.call(body, 'visible')) {
    patch.visible = Boolean(body.visible);
  }
  if (Object.prototype.hasOwnProperty.call(body, 'sortOrder')) {
    if (typeof body.sortOrder !== 'number' || !Number.isFinite(body.sortOrder)) {
      reply.code(400);
      return { error: 'Workspace sort order must be a number.' };
    }
    patch.sortOrder = Math.max(0, Math.trunc(body.sortOrder));
  }

  const nextWorkspace = await store.updateWorkspace(workspace.id, patch);
  if (!nextWorkspace) {
    reply.code(404);
    return { error: 'Workspace not found.' };
  }

  const workspaceState = await listUserWorkspaces(currentUser.username, currentUser.id);
  return {
    workspace: {
      id: nextWorkspace.id,
      name: nextWorkspace.name,
      path: nextWorkspace.path,
      visible: nextWorkspace.visible,
      sortOrder: nextWorkspace.sortOrder,
    },
    workspaceRoot: workspaceState.root,
    workspaces: workspaceState.workspaces,
  };
});

app.get('/api/admin/users', async (request, reply) => {
  const currentUser = getRequestUser(request);
  if (!currentUser.isAdmin) {
    reply.code(403);
    return { error: 'Admin access required' };
  }

  return {
    users: getPublicUsers(authState),
  };
});

app.post('/api/admin/users', async (request, reply) => {
  const currentUser = getRequestUser(request);
  if (!currentUser.isAdmin) {
    reply.code(403);
    return { error: 'Admin access required' };
  }

  try {
    const body = (request.body ?? {}) as CreateUserRequest;
    const result = await createUser(authState, body);
    authState = result.auth;
    reply.code(201);
    return {
      user: result.user,
      users: getPublicUsers(authState),
    };
  } catch (error) {
    reply.code(400);
    return { error: errorMessage(error) };
  }
});

app.patch('/api/admin/users/:userId', async (request, reply) => {
  const currentUser = getRequestUser(request);
  if (!currentUser.isAdmin) {
    reply.code(403);
    return { error: 'Admin access required' };
  }

  try {
    const { userId } = request.params as { userId: string };
    const body = (request.body ?? {}) as UpdateUserRequest;
    const previousUser = getPublicUsers(authState).find((entry) => entry.id === userId);
    const result = await updateUser(authState, userId, body);
    authState = result.auth;

    if (previousUser && previousUser.username !== result.user.username) {
      await store.updateOwnerUsername(userId, result.user.username);
    }

    return {
      user: result.user,
      users: getPublicUsers(authState),
    };
  } catch (error) {
    reply.code(400);
    return { error: errorMessage(error) };
  }
});

app.delete('/api/admin/users/:userId', async (request, reply) => {
  const currentUser = getRequestUser(request);
  if (!currentUser.isAdmin) {
    reply.code(403);
    return { error: 'Admin access required' };
  }

  const { userId } = request.params as { userId: string };
  if (store.listSessionsForUser(userId).length > 0 || store.listConversationsForUser(userId).length > 0) {
    reply.code(409);
    return { error: 'Delete this user’s conversations and sessions before removing the user.' };
  }

  try {
    authState = await deleteUser(authState, userId, currentUser.id);
    return {
      users: getPublicUsers(authState),
    };
  } catch (error) {
    reply.code(400);
    return { error: errorMessage(error) };
  }
});

app.get('/api/cloudflare/status', async () => ({
  cloudflare: await cloudflare.getStatus(),
}));

app.post('/api/cloudflare/connect', async (_request, reply) => {
  try {
    return {
      cloudflare: await cloudflare.connect(),
    };
  } catch (error) {
    reply.code(500);
    return {
      error: errorMessage(error) || 'Failed to connect Cloudflare tunnel',
    };
  }
});

app.post('/api/cloudflare/disconnect', async (_request, reply) => {
  try {
    return {
      cloudflare: await cloudflare.disconnect(),
    };
  } catch (error) {
    reply.code(500);
    return {
      error: errorMessage(error) || 'Failed to disconnect Cloudflare tunnel',
    };
  }
});

app.get('/api/sessions/:sessionId', async (request, reply) => {
  const currentUser = getRequestUser(request);
  const { sessionId } = request.params as { sessionId: string };
  const session = getOwnedRecordOrReply(currentUser.id, sessionId, reply);
  if (!session) {
    return { error: 'Session not found' };
  }

  const threadState = await readSessionThread(session);
  let responseSession = threadState.session;
  let transcriptTotal = 0;

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
    const sessionAttachments = store.listAttachments(threadState.session.id);
    const transcriptEntries = collectTranscriptEntries(threadState.thread, threadState.session.id, sessionAttachments);
    transcriptTotal = transcriptEntries.length;
    if (threadState.thread) {
      const hasTranscript = transcriptTotal > 0;
      if (threadState.session.hasTranscript !== hasTranscript) {
        responseSession = (await store.updateSession(threadState.session.id, {
          hasTranscript,
        })) ?? {
          ...threadState.session,
          hasTranscript,
        };
      }
    }
  }

  return {
    session: responseSession,
    approvals: isDeveloperSession(responseSession) ? store.getApprovals(responseSession.id) : [],
    liveEvents: store.getLiveEvents(responseSession.id),
    thread: toThreadSummary(threadState.thread),
    transcriptTotal,
    commands: collectCommands(threadState.thread),
    changes: collectFileChanges(threadState.thread),
    draftAttachments: store.listDraftAttachments(responseSession.id).map(attachmentSummary),
  };
});

app.get('/api/sessions/:sessionId/transcript', async (request, reply) => {
  const currentUser = getRequestUser(request);
  const { sessionId } = request.params as { sessionId: string };
  const session = getOwnedRecordOrReply(currentUser.id, sessionId, reply);
  if (!session) {
    return { error: 'Session not found' };
  }

  const threadState = await readSessionThread(session);
  const query = request.query as { before?: string; limit?: string } | undefined;
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

  const transcriptEntries = collectTranscriptEntries(
    threadState.thread,
    threadState.session.id,
    store.listAttachments(threadState.session.id),
  );

  return pageTranscriptEntries(
    transcriptEntries,
    query?.before,
    limit,
  );
});

app.post('/api/sessions/:sessionId/attachments', async (request, reply) => {
  const currentUser = getRequestUser(request);
  const { sessionId } = request.params as { sessionId: string };
  const session = getOwnedRecordOrReply(currentUser.id, sessionId, reply);
  if (!session) {
    return { error: 'Session not found' };
  }

  const file = await request.file();
  if (!file) {
    reply.code(400);
    return { error: 'Attachment file is required.' };
  }

  const filename = file.filename?.trim() || 'attachment';
  const mimeType = file.mimetype || 'application/octet-stream';
  const kind = attachmentKindFromUpload(filename, mimeType);

  const buffer = await file.toBuffer();
  if (buffer.length === 0) {
    reply.code(400);
    return { error: 'Attachment is empty.' };
  }

  const attachmentId = randomUUID();
  const attachmentsDir = join(session.workspace, '.rvc-attachments');
  await mkdir(attachmentsDir, { recursive: true });

  const storedFilename = sanitizeAttachmentFilename(
    filename,
    kind === 'image'
      ? 'attachment'
      : kind === 'pdf'
        ? 'attachment.pdf'
        : 'attachment-file',
  );
  const storagePath = join(attachmentsDir, `${attachmentId}-${storedFilename}`);
  await writeFile(storagePath, buffer);

  const now = new Date().toISOString();
  const attachment: SessionAttachmentRecord = {
    id: attachmentId,
    ownerKind: isConversation(session) ? 'conversation' : 'session',
    ownerId: session.id,
    sessionId: session.id,
    ownerUserId: session.ownerUserId,
    ownerUsername: session.ownerUsername,
    kind,
    filename: storedFilename,
    mimeType,
    sizeBytes: buffer.length,
    storagePath,
    extractedText: await extractAttachmentText(kind, storedFilename, mimeType, buffer),
    consumedAt: null,
    createdAt: now,
  };

  await store.addAttachment(attachment);
  reply.code(201);
  return {
    attachment: attachmentSummary(attachment),
  };
});

app.get('/api/sessions/:sessionId/attachments/:attachmentId/content', async (request, reply) => {
  const currentUser = getRequestUser(request);
  const { sessionId, attachmentId } = request.params as { sessionId: string; attachmentId: string };
  const session = getOwnedRecordOrReply(currentUser.id, sessionId, reply);
  if (!session) {
    return { error: 'Session not found' };
  }

  const attachment = store.getAttachment(sessionId, attachmentId);
  if (!attachment) {
    reply.code(404);
    return { error: 'Attachment not found' };
  }

  const buffer = await readFile(attachment.storagePath);
  reply.type(attachment.mimeType);
  reply.header('Cache-Control', 'private, max-age=60');
  reply.header('Content-Disposition', `inline; filename="${attachment.filename.replace(/"/g, '')}"`);
  return buffer;
});

app.delete('/api/sessions/:sessionId/attachments/:attachmentId', async (request, reply) => {
  const currentUser = getRequestUser(request);
  const { sessionId, attachmentId } = request.params as { sessionId: string; attachmentId: string };
  const session = getOwnedRecordOrReply(currentUser.id, sessionId, reply);
  if (!session) {
    return { error: 'Session not found' };
  }

  const attachment = store.getAttachment(sessionId, attachmentId);
  if (!attachment) {
    reply.code(404);
    return { error: 'Attachment not found' };
  }

  if (attachment.consumedAt) {
    reply.code(409);
    return { error: 'This attachment is already part of a sent turn.' };
  }

  await store.removeAttachment(sessionId, attachmentId);
  await unlink(attachment.storagePath).catch(() => {});
  return { ok: true };
});

app.post('/api/sessions', async (request, reply) => {
  const currentUser = getRequestUser(request);
  const body = (request.body ?? {}) as CreateSessionRequest;
  const sessionType = normalizeSessionType(body.sessionType);
  const requestedTitle = trimOptional(body.title);

  if (!userCanCreateSessionType(currentUser, sessionType)) {
    reply.code(403);
    return { error: `You do not have permission to create ${sessionType} sessions.` };
  }

  const sessionId = randomUUID();
  const model = trimOptional(body.model) ?? currentDefaultModel();
  const reasoningEffort = normalizeReasoningEffort(body.reasoningEffort) ?? currentDefaultEffort(model);
  const requestedWorkspaceName = normalizeWorkspaceFolderName(body.workspaceName);
  const workspaceName = requestedWorkspaceName ?? (sessionType === 'chat' ? defaultChatWorkspaceName(sessionId) : null);
  if (!workspaceName) {
    reply.code(400);
    return { error: 'Workspace is required.' };
  }

  let workspaceInfo: Awaited<ReturnType<typeof ensureUserWorkspace>>;
  let securityProfile: SecurityProfile;
  const approvalMode = sessionType === 'chat' ? 'less-approval' : normalizeApprovalMode(body.approvalMode);

  try {
    if (body.workspaceId && sessionType === 'code') {
      const workspace = store.getWorkspaceForUser(body.workspaceId, currentUser.id);
      if (!workspace) {
        reply.code(404);
        return { error: 'Workspace not found.' };
      }
      workspaceInfo = {
        root: userWorkspaceRoot(currentUser.username, currentUser.id),
        id: workspace.id,
        name: workspace.name,
        path: workspace.path,
        visible: workspace.visible,
        sortOrder: workspace.sortOrder,
      };
    } else {
      workspaceInfo = await ensureUserWorkspace(
        currentUser.username,
        currentUser.id,
        workspaceName,
      );
    }
  } catch (error) {
    reply.code(400);
    return { error: errorMessage(error) };
  }

  if (sessionType === 'chat') {
    securityProfile = 'read-only';
  } else {
    securityProfile = normalizeSecurityProfile(body.securityProfile);
    if (securityProfile === 'read-only') {
      securityProfile = 'repo-write';
    }
    if (securityProfile === 'full-host' && !currentUser.canUseFullHost) {
      reply.code(403);
      return { error: 'You do not have permission to create full-host sessions.' };
    }
  }

  const fullHostEnabled = securityProfile === 'full-host';
  const threadResponse = await codex.startThread({
    cwd: workspaceInfo.path,
    securityProfile,
    model,
  });

  const now = new Date().toISOString();
  if (sessionType === 'chat') {
    const conversation: ConversationRecord = {
      id: sessionId,
      ownerUserId: currentUser.id,
      ownerUsername: currentUser.username,
      sessionType: 'chat',
      threadId: threadResponse.thread.id,
      activeTurnId: null,
      title: requestedTitle || defaultChatTitle(),
      autoTitle: !requestedTitle,
      workspace: workspaceInfo.path,
      archivedAt: null,
      securityProfile: 'read-only',
      approvalMode: 'less-approval',
      networkEnabled: false,
      fullHostEnabled: false,
      status: 'idle',
      lastIssue: null,
      hasTranscript: false,
      model,
      reasoningEffort,
      createdAt: now,
      updatedAt: now,
    };

    await store.upsertConversation(conversation);
    await chatHistory.ensureConversation(conversation);
    reply.code(201);
    return { session: conversation, conversation };
  }

  const session: SessionRecord = {
    id: sessionId,
    ownerUserId: currentUser.id,
    ownerUsername: currentUser.username,
    sessionType: 'code',
    workspaceId: workspaceInfo.id,
    threadId: threadResponse.thread.id,
    activeTurnId: null,
    title: requestedTitle || basename(workspaceInfo.path),
    autoTitle: false,
    workspace: workspaceInfo.path,
    archivedAt: null,
    securityProfile,
    approvalMode,
    networkEnabled: false,
    fullHostEnabled,
    status: 'idle',
    lastIssue: null,
    hasTranscript: false,
    model,
    reasoningEffort,
    createdAt: now,
    updatedAt: now,
  };

  await store.upsertSession(session);
  reply.code(201);
  return { session };
});

app.post('/api/sessions/:sessionId/restart', async (request, reply) => {
  const currentUser = getRequestUser(request);
  const { sessionId } = request.params as { sessionId: string };
  const session = getOwnedRecordOrReply(currentUser.id, sessionId, reply);
  if (!session) {
    return { error: 'Session not found' };
  }

  const nextSession = await restartSessionThread(session);
  return { session: nextSession };
});

app.post('/api/sessions/:sessionId/fork', async (request, reply) => {
  const currentUser = getRequestUser(request);
  const { sessionId } = request.params as { sessionId: string };
  const session = getOwnedRecordOrReply(currentUser.id, sessionId, reply);
  if (!session) {
    return { error: 'Session not found' };
  }
  try {
    const nextSession = isDeveloperSession(session)
      ? await createForkedSession(currentUser, session)
      : await createForkedConversation(currentUser, session);
    reply.code(201);
    return { session: nextSession };
  } catch (error) {
    reply.code(500);
    return { error: errorMessage(error) };
  }
});

app.post('/api/sessions/:sessionId/rename', async (request, reply) => {
  const currentUser = getRequestUser(request);
  const { sessionId } = request.params as { sessionId: string };
  const body = (request.body ?? {}) as UpdateSessionRequest;
  const session = getOwnedRecordOrReply(currentUser.id, sessionId, reply);
  if (!session) {
    return { error: 'Session not found' };
  }

  const title = body.title?.trim();
  if (!title) {
    reply.code(400);
    return { error: 'Session title is required' };
  }

  const nextSession = (await updateRecord(session, {
    title,
    autoTitle: false,
  })) ?? session;

  return { session: nextSession };
});

app.patch('/api/sessions/:sessionId', async (request, reply) => {
  const currentUser = getRequestUser(request);
  const { sessionId } = request.params as { sessionId: string };
  const body = (request.body ?? {}) as UpdateSessionRequest;
  const session = getOwnedRecordOrReply(currentUser.id, sessionId, reply);
  if (!session) {
    return { error: 'Session not found' };
  }

  const titleProvided = Object.prototype.hasOwnProperty.call(body, 'title');
  const workspaceProvided = Object.prototype.hasOwnProperty.call(body, 'workspaceName');
  const securityProvided = Object.prototype.hasOwnProperty.call(body, 'securityProfile');
  const approvalModeProvided = Object.prototype.hasOwnProperty.call(body, 'approvalMode');

  const title = titleProvided ? trimOptional(body.title) : session.title;
  if (titleProvided && !title) {
    reply.code(400);
    return { error: 'Session title is required' };
  }

  if ((workspaceProvided || securityProvided) && session.activeTurnId) {
    reply.code(409);
    return { error: 'Stop the active turn before editing this session.' };
  }

  let workspace = session.workspace;
  let workspaceId = isDeveloperSession(session) ? session.workspaceId : undefined;
  if (workspaceProvided && isDeveloperSession(session)) {
    const workspaceName = normalizeWorkspaceFolderName(body.workspaceName);
    if (!workspaceName) {
      reply.code(400);
      return { error: 'Workspace is required.' };
    }

    try {
      const workspaceRecord = await ensureUserWorkspace(currentUser.username, currentUser.id, workspaceName);
      workspace = workspaceRecord.path;
      workspaceId = workspaceRecord.id;
    } catch (error) {
      reply.code(400);
      return { error: errorMessage(error) };
    }
  }

  let securityProfile = session.securityProfile;
  if (session.sessionType === 'chat') {
    securityProfile = 'read-only';
  } else if (securityProvided) {
    securityProfile = normalizeSecurityProfile(body.securityProfile);
    if (securityProfile === 'read-only') {
      securityProfile = 'repo-write';
    }
    if (securityProfile === 'full-host' && !currentUser.canUseFullHost) {
      reply.code(403);
      return { error: 'You do not have permission to use full-host sessions.' };
    }
  }

  const approvalMode = approvalModeProvided
    ? normalizeApprovalMode(body.approvalMode)
    : session.approvalMode;
  const restartRequired = workspace !== session.workspace || securityProfile !== session.securityProfile;

  let nextSession = (await updateRecord(session, {
    title: title ?? session.title,
    autoTitle: titleProvided ? false : session.autoTitle,
    workspace,
    securityProfile,
    approvalMode: isDeveloperSession(session) ? approvalMode : session.approvalMode,
    fullHostEnabled: isDeveloperSession(session) ? securityProfile === 'full-host' : false,
    ...(isDeveloperSession(session) && workspaceId ? { workspaceId } : {}),
  })) ?? session;

  if (restartRequired) {
    nextSession = await restartSessionThread(
      nextSession,
      'Session settings changed. Started a fresh thread for this session.',
    );
  }

  return { session: nextSession };
});

app.patch('/api/sessions/:sessionId/preferences', async (request, reply) => {
  const currentUser = getRequestUser(request);
  const { sessionId } = request.params as { sessionId: string };
  const body = (request.body ?? {}) as UpdateSessionPreferencesRequest;
  const session = getOwnedRecordOrReply(currentUser.id, sessionId, reply);
  if (!session) {
    return { error: 'Session not found' };
  }

  const requestedModel = trimOptional(body.model) ?? session.model ?? currentDefaultModel();
  const modelOption = availableModels.find((entry) => entry.model === requestedModel);
  if (!modelOption) {
    reply.code(400);
    return { error: 'Unknown model.' };
  }

  const requestedEffort = normalizeReasoningEffort(body.reasoningEffort);
  const reasoningEffort = requestedEffort && modelOption.supportedReasoningEfforts.includes(requestedEffort)
    ? requestedEffort
    : preferredReasoningEffortForModel(modelOption);
  const approvalMode = session.sessionType === 'code'
    ? normalizeApprovalMode(body.approvalMode ?? session.approvalMode)
    : session.approvalMode;

  const nextSession = (await updateRecord(session, {
    model: modelOption.model,
    reasoningEffort,
    approvalMode: isDeveloperSession(session) ? approvalMode : session.approvalMode,
  })) ?? session;

  return { session: nextSession };
});

app.post('/api/sessions/:sessionId/archive', async (request, reply) => {
  const currentUser = getRequestUser(request);
  const { sessionId } = request.params as { sessionId: string };
  const session = getOwnedRecordOrReply(currentUser.id, sessionId, reply);
  if (!session) {
    return { error: 'Session not found' };
  }

  if (session.archivedAt) {
    return { session };
  }

  if (isDeveloperSession(session)) {
    store.clearApprovals(sessionId);
  }
  const nextSession = (await updateRecord(session, {
    archivedAt: new Date().toISOString(),
    activeTurnId: null,
    status: 'idle',
    networkEnabled: false,
    lastIssue: null,
  })) ?? session;

  return { session: nextSession };
});

app.post('/api/sessions/:sessionId/restore', async (request, reply) => {
  const currentUser = getRequestUser(request);
  const { sessionId } = request.params as { sessionId: string };
  const session = getOwnedRecordOrReply(currentUser.id, sessionId, reply);
  if (!session) {
    return { error: 'Session not found' };
  }

  if (!session.archivedAt) {
    return { session };
  }

  const nextSession = (await updateRecord(session, {
    archivedAt: null,
    status: 'idle',
    lastIssue: null,
  })) ?? session;

  return { session: nextSession };
});

app.delete('/api/sessions/:sessionId', async (request, reply) => {
  const currentUser = getRequestUser(request);
  const { sessionId } = request.params as { sessionId: string };
  const session = getOwnedRecordOrReply(currentUser.id, sessionId, reply);
  if (!session) {
    return { error: 'Session not found' };
  }

  const attachments = store.listAttachments(sessionId);

  if (isConversation(session)) {
    await store.deleteConversation(sessionId);
    await chatHistory.deleteConversation(sessionId);
  } else {
    await store.deleteSession(sessionId);
  }
  await deleteStoredAttachments(attachments);
  return { ok: true };
});

app.post('/api/sessions/:sessionId/turns', async (request, reply) => {
  const currentUser = getRequestUser(request);
  const { sessionId } = request.params as { sessionId: string };
  const body = request.body as CreateTurnRequest;
  const session = getOwnedRecordOrReply(currentUser.id, sessionId, reply);
  if (!session) {
    return { error: 'Session not found' };
  }

  const prompt = body.prompt?.trim() ?? '';
  const attachmentIds = Array.isArray(body.attachmentIds)
    ? [...new Set(body.attachmentIds.filter((value): value is string => typeof value === 'string' && value.trim().length > 0))]
    : [];
  const attachments = attachmentIds.map((attachmentId) => store.getAttachment(sessionId, attachmentId));

  if (!prompt && attachmentIds.length === 0) {
    reply.code(400);
    return { error: 'Prompt or attachment is required' };
  }

  if (attachments.some((attachment) => !attachment || attachment.consumedAt)) {
    reply.code(400);
    return { error: 'One or more attachments are missing or already used.' };
  }

  try {
    const result = await startTurnWithAutoRestart(
      session,
      prompt || null,
      attachments.filter((attachment): attachment is SessionAttachmentRecord => Boolean(attachment)),
    );
    return { turn: result.turn, session: result.session };
  } catch (error) {
    const message = errorMessage(error);
    await updateRecord(session, {
      activeTurnId: null,
      status: 'error',
      lastIssue: message,
    });
    reply.code(500);
    return { error: message };
  }
});

app.post('/api/sessions/:sessionId/stop', async (request, reply) => {
  const currentUser = getRequestUser(request);
  const { sessionId } = request.params as { sessionId: string };
  const session = getOwnedRecordOrReply(currentUser.id, sessionId, reply);
  if (!session) {
    return { error: 'Session not found' };
  }

  if (!session.activeTurnId) {
    reply.code(409);
    return { error: 'This session does not have an active turn to stop.' };
  }

  try {
    await codex.interruptTurn(session.threadId, session.activeTurnId);
    store.addLiveEvent(session.id, {
      id: randomUUID(),
      method: 'turn/interrupted',
      summary: 'Stopped the active turn.',
      createdAt: new Date().toISOString(),
    });
    const nextSession = (await updateRecord(session, {
      activeTurnId: null,
      status: 'idle',
      lastIssue: 'Stopped by user.',
    })) ?? session;
    return { session: nextSession };
  } catch (error) {
    if (isThreadUnavailableError(error)) {
      const nextSession = (await updateRecord(session, {
        activeTurnId: null,
        status: 'stale',
        lastIssue: STALE_SESSION_MESSAGE,
        networkEnabled: false,
      })) ?? session;
      reply.code(409);
      return { error: STALE_SESSION_MESSAGE, session: nextSession };
    }

    const message = errorMessage(error);
    await updateRecord(session, {
      activeTurnId: null,
      status: 'error',
      lastIssue: message,
    });
    reply.code(500);
    return { error: message };
  }
});

app.post('/api/sessions/:sessionId/approvals/:approvalId', async (request, reply) => {
  const currentUser = getRequestUser(request);
  const { sessionId, approvalId } = request.params as { sessionId: string; approvalId: string };
  const body = request.body as ResolveApprovalRequest;
  const session = getOwnedRecordOrReply(currentUser.id, sessionId, reply);
  if (!session) {
    return { error: 'Session not found' };
  }
  if (!isDeveloperSession(session)) {
    reply.code(404);
    return { error: 'Approval not found' };
  }

  const approval = store.getApprovals(sessionId).find((entry) => entry.id === approvalId);
  if (!approval) {
    reply.code(404);
    return { error: 'Approval not found' };
  }

  const scope = body.scope === 'session' ? 'session' : 'once';
  const accepted = body.decision !== 'decline';

  if (approval.method === 'item/commandExecution/requestApproval') {
    await codex.respond(approval.rpcRequestId, {
      decision: accepted ? (scope === 'session' ? 'acceptForSession' : 'accept') : 'decline',
    });
  } else if (approval.method === 'item/fileChange/requestApproval') {
    await codex.respond(approval.rpcRequestId, {
      decision: accepted ? (scope === 'session' ? 'acceptForSession' : 'accept') : 'decline',
    });
  } else if (approval.method === 'item/permissions/requestApproval') {
    const params = approval.payload as { permissions?: unknown };
    await codex.respond(approval.rpcRequestId, {
      permissions: accepted ? (params.permissions ?? {}) : {},
      scope: scope === 'session' ? 'session' : 'turn',
    });
    if (accepted) {
      await store.updateSession(sessionId, {
        networkEnabled: true,
      });
    }
  } else {
    await codex.respond(approval.rpcRequestId, {
      decision: accepted ? 'accept' : 'cancel',
    });
  }

  store.removeApproval(sessionId, approvalId);
  await store.updateSession(sessionId, {
    status: store.getApprovals(sessionId).length > 0 ? 'needs-approval' : 'running',
    lastIssue: null,
  });
  return { ok: true };
});

const hasBuiltWeb = await stat(WEB_DIST_DIR)
  .then((info) => info.isDirectory())
  .catch(() => false);

if (hasBuiltWeb) {
  await app.register(fastifyStatic, {
    root: WEB_DIST_DIR,
    prefix: '/',
    setHeaders: (response, pathName) => {
      if (pathName.endsWith('.html')) {
        response.setHeader('Cache-Control', 'no-store');
      }
    },
  });
}

app.setNotFoundHandler(async (request, reply) => {
  if (request.url.startsWith('/api/')) {
    reply.code(404);
    return { error: 'Not found' };
  }

  if (hasBuiltWeb) {
    reply.header('Cache-Control', 'no-store');
    return reply.sendFile('index.html');
  }

  reply.code(404);
  return {
    error: 'Web client is not built yet. Run `npm run build` or use `npm run dev:web` for local development.',
  };
});

const shutdown = async () => {
  await cloudflare.disconnect();
  await codex.stop();
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
  await cloudflare.disconnect();
  await codex.stop();
  process.exit(1);
}
