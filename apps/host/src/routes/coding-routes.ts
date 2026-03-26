import { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, open, readdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { basename, extname, isAbsolute, join, resolve, sep } from 'node:path';

import { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';

import { CodingWorkspaceServiceError } from '../app/coding-workspace-service.js';
import { normalizeWorkspaceFilePath } from '../workspace-paths.js';
import type {
  CodingBootstrapPayload,
  CodingWorkspaceDirectoryResponse,
  CodingWorkspaceFileEntry,
  CodingWorkspaceFileResponse,
  CodingSessionRecord,
  CodingWorkspaceSummary,
  CreateCodingWorkspaceRequest,
  CreateCodingWorkspaceSessionRequest,
  ReorderCodingWorkspacesRequest,
  UpdateCodingWorkspaceRequest,
} from '../coding/types.js';
import type {
  ApprovalMode,
  CreateTurnRequest,
  ModelOption,
  ReasoningEffort,
  ResolveApprovalRequest,
  SecurityProfile,
  SessionAttachmentKind,
  SessionAttachmentRecord,
  SessionAttachmentSummary,
  SessionDetailResponse,
  SessionRecord,
  SessionTranscriptPageResponse,
  UpdateSessionPreferencesRequest,
  UpdateSessionRequest,
  UserRecord,
  WorkspaceSummary,
} from '../types.js';

interface CodingRoutesDependencies {
  getRequestUser: (request: FastifyRequest) => UserRecord;
  userCanUseMode: (user: UserRecord, mode: 'chat' | 'developer') => boolean;
  buildCodingBootstrapResponse: (currentUser: UserRecord) => Promise<CodingBootstrapPayload>;
  listUserWorkspaces: (username: string, userId: string) => Promise<{
    root: string;
    workspaces: WorkspaceSummary[];
  }>;
  toCodingWorkspaceSummary: (workspace: WorkspaceSummary) => CodingWorkspaceSummary;
  createCodingWorkspace: (
    currentUser: UserRecord,
    body: CreateCodingWorkspaceRequest,
  ) => Promise<{
    workspace: WorkspaceSummary;
    workspaceState: {
      root: string;
      workspaces: WorkspaceSummary[];
    };
  }>;
  getOwnedCodingWorkspaceOrReply: (
    userId: string,
    workspaceId: string,
    reply: FastifyReply,
  ) => Promise<WorkspaceSummary | null>;
  updateCodingWorkspace: (
    currentUser: UserRecord,
    workspace: WorkspaceSummary,
    body: UpdateCodingWorkspaceRequest,
  ) => Promise<{
    workspace: WorkspaceSummary;
    workspaceState: {
      root: string;
      workspaces: WorkspaceSummary[];
    };
  }>;
  reorderWorkspaceList: (
    currentUser: UserRecord,
    body: ReorderCodingWorkspacesRequest,
  ) => Promise<{
    workspaceRoot: string;
    workspaces: WorkspaceSummary[];
  }>;
  createDeveloperSession: (
    currentUser: UserRecord,
    workspace: WorkspaceSummary,
    body: CreateCodingWorkspaceSessionRequest,
  ) => Promise<CodingSessionRecord>;
  errorMessage: (error: unknown) => string;
  getOwnedCodingSessionOrReply: (
    userId: string,
    sessionId: string,
    reply: FastifyReply,
  ) => Promise<SessionRecord | null>;
  buildCodingSessionDetailResponse: (session: SessionRecord) => Promise<SessionDetailResponse>;
  buildCodingSessionTranscriptResponse: (
    session: SessionRecord,
    query: { before?: string; limit?: string } | undefined,
  ) => Promise<SessionTranscriptPageResponse>;
  attachmentKindFromUpload: (filename: string, mimeType: string) => SessionAttachmentKind;
  sanitizeAttachmentFilename: (filename: string, fallbackBase: string) => string;
  extractAttachmentText: (
    kind: SessionAttachmentKind,
    filename: string,
    mimeType: string,
    buffer: Buffer,
  ) => Promise<string | null>;
  addAttachment: (attachment: SessionAttachmentRecord) => Promise<void>;
  codingAttachmentSummary: (attachment: SessionAttachmentRecord) => SessionAttachmentSummary;
  getAttachment: (sessionId: string, attachmentId: string) => SessionAttachmentRecord | null;
  removeAttachment: (sessionId: string, attachmentId: string) => Promise<boolean>;
  deleteStoredAttachments: (attachments: SessionAttachmentRecord[]) => Promise<void>;
  trimOptional: (value: unknown) => string | null;
  normalizeWorkspaceFolderName: (value: unknown) => string | null;
  ensureUserWorkspace: (
    username: string,
    userId: string,
    workspaceName: string,
  ) => Promise<WorkspaceSummary>;
  normalizeSecurityProfile: (value: unknown) => SecurityProfile;
  normalizeApprovalMode: (value: unknown) => ApprovalMode;
  isExecutorSupported: (executor: SessionRecord['executor']) => boolean;
  normalizeExecutor: (value: unknown) => SessionRecord['executor'];
  updateCodingSession: (
    sessionId: string,
    patch: Partial<SessionRecord>,
  ) => Promise<SessionRecord | null>;
  currentDefaultModel: (executor?: SessionRecord['executor']) => string;
  findModelOption: (model: string, executor?: SessionRecord['executor']) => ModelOption | null;
  normalizeReasoningEffort: (value: unknown) => ReasoningEffort | null;
  preferredReasoningEffortForModel: (modelOption: ModelOption) => ReasoningEffort;
  restartSessionThread: (
    session: SessionRecord,
    reason?: string,
  ) => Promise<SessionRecord>;
  createForkedSession: (
    currentUser: UserRecord,
    session: SessionRecord,
  ) => Promise<SessionRecord>;
  listAttachments: (sessionId: string) => SessionAttachmentRecord[];
  deleteCodingSession: (sessionId: string) => Promise<unknown>;
  startTurnWithAutoRestart: (
    session: SessionRecord,
    prompt: string | null,
    attachments: SessionAttachmentRecord[],
  ) => Promise<{ turn: unknown; session: SessionRecord }>;
  isThreadUnavailableError: (error: unknown) => boolean;
  staleSessionMessage: string;
  interruptTurn: (session: SessionRecord, threadId: string, turnId: string) => Promise<unknown>;
  addLiveEvent: (sessionId: string, event: { id: string; method: string; summary: string; createdAt: string }) => void;
  getApprovals: (sessionId: string) => Array<{
    id: string;
    rpcRequestId: number | string;
    method: string;
    payload: unknown;
  }>;
  respondToRuntime: (session: SessionRecord, rpcRequestId: number | string, payload: unknown) => Promise<void>;
  removeApproval: (sessionId: string, approvalId: string) => void;
}

const WORKSPACE_BROWSER_ENTRY_LIMIT = 500;
const WORKSPACE_FILE_PREVIEW_MAX_BYTES = 256 * 1024;
const HIDDEN_WORKSPACE_NAMES = new Set([
  '.DS_Store',
  '.git',
  '.next',
  'coverage',
  'dist',
  'node_modules',
]);
const TEXT_FILE_EXTENSIONS = new Set([
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
  '.mjs',
  '.md',
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
]);

class WorkspaceBrowserRouteError extends Error {
  statusCode: number;

  constructor(message: string, statusCode = 400) {
    super(message);
    this.name = 'WorkspaceBrowserRouteError';
    this.statusCode = statusCode;
  }
}

function normalizeWorkspaceRelativePath(value: unknown) {
  if (typeof value !== 'string') {
    return '';
  }

  const rawPath = value.trim().replace(/\\/g, '/');
  if (!rawPath) {
    return '';
  }
  if (rawPath.includes('\0')) {
    throw new WorkspaceBrowserRouteError('Invalid path.', 400);
  }

  const segments = rawPath
    .split('/')
    .map((segment) => segment.trim())
    .filter(Boolean);
  if (segments.some((segment) => segment === '..')) {
    throw new WorkspaceBrowserRouteError('Path must stay inside the workspace.', 400);
  }

  return segments
    .filter((segment) => segment !== '.')
    .join('/');
}

function isPathInsideWorkspace(workspaceRootPath: string, targetPath: string) {
  return targetPath === workspaceRootPath || targetPath.startsWith(`${workspaceRootPath}${sep}`);
}

async function resolveWorkspaceEntryPath(workspacePath: string, requestedPath: unknown) {
  const rawPath = typeof requestedPath === 'string' ? requestedPath.trim().replace(/\\/g, '/') : '';
  if (rawPath.includes('\0')) {
    throw new WorkspaceBrowserRouteError('Invalid path.', 400);
  }

  let workspaceRootPath: string;
  try {
    workspaceRootPath = await realpath(workspacePath);
  } catch {
    throw new WorkspaceBrowserRouteError('Workspace folder not found.', 404);
  }

  const relativePath = rawPath && !isAbsolute(rawPath)
    ? normalizeWorkspaceRelativePath(rawPath)
    : '';
  const absolutePath = rawPath
    ? (isAbsolute(rawPath) ? rawPath : resolve(workspaceRootPath, relativePath))
    : workspaceRootPath;
  let targetPath: string;
  try {
    targetPath = await realpath(absolutePath);
  } catch {
    throw new WorkspaceBrowserRouteError('Workspace path not found.', 404);
  }

  if (!isPathInsideWorkspace(workspaceRootPath, targetPath)) {
    throw new WorkspaceBrowserRouteError('Path must stay inside the workspace.', 400);
  }

  return {
    workspaceRootPath,
    relativePath: normalizeWorkspaceFilePath(workspaceRootPath, targetPath),
    targetPath,
    name: basename(targetPath) || basename(workspaceRootPath) || workspacePath,
  };
}

function inferWorkspaceFileMimeType(filename: string) {
  const extension = extname(filename).toLowerCase();
  switch (extension) {
    case '.c':
    case '.cc':
    case '.cpp':
    case '.css':
    case '.go':
    case '.graphql':
    case '.h':
    case '.html':
    case '.java':
    case '.js':
    case '.jsx':
    case '.mjs':
    case '.py':
    case '.rb':
    case '.rs':
    case '.sh':
    case '.sql':
    case '.ts':
    case '.tsx':
    case '.txt':
    case '.vue':
      return 'text/plain; charset=utf-8';
    case '.json':
      return 'application/json; charset=utf-8';
    case '.md':
      return 'text/markdown; charset=utf-8';
    case '.svg':
      return 'image/svg+xml';
    case '.xml':
      return 'application/xml; charset=utf-8';
    case '.yaml':
    case '.yml':
      return 'application/yaml; charset=utf-8';
    case '.csv':
      return 'text/csv; charset=utf-8';
    case '.toml':
      return 'application/toml; charset=utf-8';
    case '.png':
      return 'image/png';
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.gif':
      return 'image/gif';
    case '.webp':
      return 'image/webp';
    case '.pdf':
      return 'application/pdf';
    default:
      return 'application/octet-stream';
  }
}

function looksLikeTextWorkspaceFile(filename: string, mimeType: string, buffer: Buffer) {
  if (mimeType.startsWith('text/')) {
    return true;
  }
  if (
    mimeType.includes('json')
    || mimeType.includes('xml')
    || mimeType.includes('yaml')
    || mimeType.includes('javascript')
    || mimeType.includes('typescript')
    || mimeType.includes('markdown')
    || mimeType.includes('toml')
  ) {
    return true;
  }
  if (TEXT_FILE_EXTENSIONS.has(extname(filename).toLowerCase())) {
    return true;
  }

  const sample = buffer.subarray(0, Math.min(buffer.length, 2048));
  let suspiciousBytes = 0;
  for (const byte of sample) {
    if (byte === 0) {
      return false;
    }
    if ((byte < 7 || (byte > 13 && byte < 32)) && byte !== 27) {
      suspiciousBytes += 1;
    }
  }

  return sample.length === 0 || (suspiciousBytes / sample.length) < 0.1;
}

function workspaceFileContentUrl(workspaceId: string, relativePath: string, download = false) {
  const params = new URLSearchParams();
  params.set('path', relativePath);
  if (download) {
    params.set('download', '1');
  }
  return `/api/coding/workspaces/${workspaceId}/file/content?${params.toString()}`;
}

async function listWorkspaceDirectoryEntries(workspace: WorkspaceSummary, requestedPath: unknown) {
  const resolved = await resolveWorkspaceEntryPath(workspace.path, requestedPath);
  const entryStats = await stat(resolved.targetPath);
  if (!entryStats.isDirectory()) {
    throw new WorkspaceBrowserRouteError('Path is not a directory.', 400);
  }

  const directoryEntries = await readdir(resolved.targetPath, { withFileTypes: true });
  const entries = (await Promise.all(directoryEntries.map(async (entry) => {
    if (HIDDEN_WORKSPACE_NAMES.has(entry.name) || entry.isSymbolicLink()) {
      return null;
    }

    const nextPath = join(resolved.targetPath, entry.name);
    let nextStats;
    try {
      nextStats = await stat(nextPath);
    } catch {
      return null;
    }

    const kind = nextStats.isDirectory()
      ? 'directory'
      : nextStats.isFile()
        ? 'file'
        : null;
    if (!kind) {
      return null;
    }

    const relativePath = resolved.relativePath
      ? `${resolved.relativePath}/${entry.name}`
      : entry.name;
    const normalizedEntry: CodingWorkspaceFileEntry = {
      path: relativePath,
      name: entry.name,
      kind,
      sizeBytes: kind === 'file' ? nextStats.size : null,
    };
    return normalizedEntry;
  })))
    .filter((entry): entry is CodingWorkspaceFileEntry => entry !== null)
    .sort((left, right) => {
      if (left.kind !== right.kind) {
        return left.kind === 'directory' ? -1 : 1;
      }
      return left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: 'base' });
    })
    .slice(0, WORKSPACE_BROWSER_ENTRY_LIMIT);

  const response: CodingWorkspaceDirectoryResponse = {
    workspaceId: workspace.id,
    path: resolved.relativePath,
    entries,
  };
  return response;
}

async function buildWorkspaceFilePreview(workspace: WorkspaceSummary, requestedPath: unknown) {
  const resolved = await resolveWorkspaceEntryPath(workspace.path, requestedPath);
  if (!resolved.relativePath) {
    throw new WorkspaceBrowserRouteError('File path is required.', 400);
  }

  const entryStats = await stat(resolved.targetPath);
  if (!entryStats.isFile()) {
    throw new WorkspaceBrowserRouteError('Path is not a file.', 400);
  }

  const fileHandle = await open(resolved.targetPath, 'r');
  try {
    const sizeBytes = entryStats.size;
    const previewBytes = Math.min(sizeBytes, WORKSPACE_FILE_PREVIEW_MAX_BYTES);
    const buffer = Buffer.alloc(previewBytes);
    if (previewBytes > 0) {
      await fileHandle.read(buffer, 0, previewBytes, 0);
    }

    const mimeType = inferWorkspaceFileMimeType(resolved.name);
    const previewable = looksLikeTextWorkspaceFile(resolved.name, mimeType, buffer);
    const response: CodingWorkspaceFileResponse = {
      workspaceId: workspace.id,
      path: resolved.relativePath,
      name: resolved.name,
      mimeType,
      sizeBytes,
      previewable,
      truncated: sizeBytes > previewBytes,
      content: previewable ? buffer.toString('utf8') : null,
      downloadUrl: workspaceFileContentUrl(workspace.id, resolved.relativePath, true),
    };
    return response;
  } finally {
    await fileHandle.close();
  }
}

function requireDeveloper(
  request: FastifyRequest,
  reply: FastifyReply,
  deps: CodingRoutesDependencies,
) {
  const currentUser = deps.getRequestUser(request);
  if (!deps.userCanUseMode(currentUser, 'developer')) {
    reply.code(403);
    return null;
  }
  return currentUser;
}

export function registerCodingRoutes(app: FastifyInstance, deps: CodingRoutesDependencies) {
  app.get('/api/coding/bootstrap', async (request, reply) => {
    const currentUser = requireDeveloper(request, reply, deps);
    if (!currentUser) {
      return { error: 'Developer access required.' };
    }

    return deps.buildCodingBootstrapResponse(currentUser);
  });

  app.get('/api/coding/workspaces', async (request, reply) => {
    const currentUser = requireDeveloper(request, reply, deps);
    if (!currentUser) {
      return { error: 'Developer access required.' };
    }

    const workspaceState = await deps.listUserWorkspaces(currentUser.username, currentUser.id);
    return {
      workspaceRoot: workspaceState.root,
      workspaces: workspaceState.workspaces.map(deps.toCodingWorkspaceSummary),
    };
  });

  app.get('/api/coding/workspaces/:workspaceId/tree', async (request, reply) => {
    const currentUser = requireDeveloper(request, reply, deps);
    if (!currentUser) {
      return { error: 'Developer access required.' };
    }

    const { workspaceId } = request.params as { workspaceId: string };
    const workspace = await deps.getOwnedCodingWorkspaceOrReply(currentUser.id, workspaceId, reply);
    if (!workspace) {
      return { error: 'Workspace not found.' };
    }

    try {
      return await listWorkspaceDirectoryEntries(workspace, (request.query as { path?: string } | undefined)?.path);
    } catch (error) {
      if (error instanceof WorkspaceBrowserRouteError) {
        reply.code(error.statusCode);
        return { error: error.message };
      }
      throw error;
    }
  });

  app.get('/api/coding/workspaces/:workspaceId/file', async (request, reply) => {
    const currentUser = requireDeveloper(request, reply, deps);
    if (!currentUser) {
      return { error: 'Developer access required.' };
    }

    const { workspaceId } = request.params as { workspaceId: string };
    const workspace = await deps.getOwnedCodingWorkspaceOrReply(currentUser.id, workspaceId, reply);
    if (!workspace) {
      return { error: 'Workspace not found.' };
    }

    try {
      return await buildWorkspaceFilePreview(workspace, (request.query as { path?: string } | undefined)?.path);
    } catch (error) {
      if (error instanceof WorkspaceBrowserRouteError) {
        reply.code(error.statusCode);
        return { error: error.message };
      }
      throw error;
    }
  });

  app.get('/api/coding/workspaces/:workspaceId/file/content', async (request, reply) => {
    const currentUser = requireDeveloper(request, reply, deps);
    if (!currentUser) {
      return { error: 'Developer access required.' };
    }

    const { workspaceId } = request.params as { workspaceId: string };
    const query = request.query as { path?: string; download?: string } | undefined;
    const workspace = await deps.getOwnedCodingWorkspaceOrReply(currentUser.id, workspaceId, reply);
    if (!workspace) {
      return { error: 'Workspace not found.' };
    }

    try {
      const resolved = await resolveWorkspaceEntryPath(workspace.path, query?.path);
      if (!resolved.relativePath) {
        reply.code(400);
        return { error: 'File path is required.' };
      }

      const entryStats = await stat(resolved.targetPath);
      if (!entryStats.isFile()) {
        reply.code(400);
        return { error: 'Path is not a file.' };
      }

      reply.type(inferWorkspaceFileMimeType(resolved.name));
      reply.header('Cache-Control', 'private, max-age=60');
      reply.header(
        'Content-Disposition',
        `${query?.download === '1' || query?.download === 'true' ? 'attachment' : 'inline'}; filename="${resolved.name.replace(/"/g, '')}"`,
      );
      return reply.send(createReadStream(resolved.targetPath));
    } catch (error) {
      if (error instanceof WorkspaceBrowserRouteError) {
        reply.code(error.statusCode);
        return { error: error.message };
      }
      throw error;
    }
  });

  app.post('/api/coding/workspaces', async (request, reply) => {
    const currentUser = requireDeveloper(request, reply, deps);
    if (!currentUser) {
      return { error: 'Developer access required.' };
    }

    const body = (request.body ?? {}) as CreateCodingWorkspaceRequest;
    try {
      const result = await deps.createCodingWorkspace(currentUser, body);
      reply.code(201);
      return {
        workspace: deps.toCodingWorkspaceSummary(result.workspace),
        workspaceRoot: result.workspaceState.root,
        workspaces: result.workspaceState.workspaces.map(deps.toCodingWorkspaceSummary),
      };
    } catch (error) {
      if (error instanceof CodingWorkspaceServiceError) {
        reply.code(error.statusCode);
        return { error: error.message };
      }
      throw error;
    }
  });

  app.patch('/api/coding/workspaces/:workspaceId', async (request, reply) => {
    const currentUser = requireDeveloper(request, reply, deps);
    if (!currentUser) {
      return { error: 'Developer access required.' };
    }

    const { workspaceId } = request.params as { workspaceId: string };
    const workspace = await deps.getOwnedCodingWorkspaceOrReply(currentUser.id, workspaceId, reply);
    if (!workspace) {
      return { error: 'Workspace not found.' };
    }

    const body = (request.body ?? {}) as UpdateCodingWorkspaceRequest;
    try {
      const result = await deps.updateCodingWorkspace(currentUser, workspace, body);
      return {
        workspace: deps.toCodingWorkspaceSummary(result.workspace),
        workspaceRoot: result.workspaceState.root,
        workspaces: result.workspaceState.workspaces.map(deps.toCodingWorkspaceSummary),
      };
    } catch (error) {
      if (error instanceof CodingWorkspaceServiceError) {
        reply.code(error.statusCode);
        return { error: error.message };
      }
      throw error;
    }
  });

  app.post('/api/coding/workspaces/reorder', async (request, reply) => {
    const currentUser = requireDeveloper(request, reply, deps);
    if (!currentUser) {
      return { error: 'Developer access required.' };
    }

    const body = (request.body ?? {}) as ReorderCodingWorkspacesRequest;
    try {
      const result = await deps.reorderWorkspaceList(currentUser, body);
      return {
        workspaceRoot: result.workspaceRoot,
        workspaces: result.workspaces.map(deps.toCodingWorkspaceSummary),
      };
    } catch (error) {
      if (error instanceof CodingWorkspaceServiceError) {
        reply.code(error.statusCode);
        return { error: error.message };
      }
      throw error;
    }
  });

  app.post('/api/coding/workspaces/:workspaceId/sessions', async (request, reply) => {
    const currentUser = requireDeveloper(request, reply, deps);
    if (!currentUser) {
      return { error: 'Developer access required.' };
    }

    const { workspaceId } = request.params as { workspaceId: string };
    const workspace = await deps.getOwnedCodingWorkspaceOrReply(currentUser.id, workspaceId, reply);
    if (!workspace) {
      return { error: 'Workspace not found.' };
    }

    const body = (request.body ?? {}) as CreateCodingWorkspaceSessionRequest;
    try {
      const session = await deps.createDeveloperSession(currentUser, workspace, body);
      reply.code(201);
      return { session };
    } catch (error) {
      const message = deps.errorMessage(error);
      reply.code(message.includes('permission') ? 403 : 400);
      return { error: message };
    }
  });

  app.get('/api/coding/sessions/:sessionId', async (request, reply) => {
    const currentUser = deps.getRequestUser(request);
    const { sessionId } = request.params as { sessionId: string };
    const session = await deps.getOwnedCodingSessionOrReply(currentUser.id, sessionId, reply);
    if (!session) {
      return { error: 'Session not found' };
    }

    return deps.buildCodingSessionDetailResponse(session);
  });

  app.get('/api/coding/sessions/:sessionId/transcript', async (request, reply) => {
    const currentUser = deps.getRequestUser(request);
    const { sessionId } = request.params as { sessionId: string };
    const session = await deps.getOwnedCodingSessionOrReply(currentUser.id, sessionId, reply);
    if (!session) {
      return { error: 'Session not found' };
    }

    return deps.buildCodingSessionTranscriptResponse(
      session,
      request.query as { before?: string; limit?: string } | undefined,
    );
  });

  app.post('/api/coding/sessions/:sessionId/attachments', async (request, reply) => {
    const currentUser = deps.getRequestUser(request);
    const { sessionId } = request.params as { sessionId: string };
    const session = await deps.getOwnedCodingSessionOrReply(currentUser.id, sessionId, reply);
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
    const kind = deps.attachmentKindFromUpload(filename, mimeType);
    const buffer = await file.toBuffer();
    if (buffer.length === 0) {
      reply.code(400);
      return { error: 'Attachment is empty.' };
    }

    const attachmentId = randomUUID();
    const attachmentsDir = join(session.workspace, '.rvc-attachments');
    await mkdir(attachmentsDir, { recursive: true });

    const storedFilename = deps.sanitizeAttachmentFilename(
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
      ownerKind: 'session',
      ownerId: session.id,
      sessionId: session.id,
      ownerUserId: session.ownerUserId,
      ownerUsername: session.ownerUsername,
      kind,
      filename: storedFilename,
      mimeType,
      sizeBytes: buffer.length,
      storagePath,
      extractedText: await deps.extractAttachmentText(kind, storedFilename, mimeType, buffer),
      consumedAt: null,
      createdAt: now,
    };

    await deps.addAttachment(attachment);
    reply.code(201);
    return {
      attachment: deps.codingAttachmentSummary(attachment),
    };
  });

  app.get('/api/coding/sessions/:sessionId/attachments/:attachmentId/content', async (request, reply) => {
    const currentUser = deps.getRequestUser(request);
    const { sessionId, attachmentId } = request.params as { sessionId: string; attachmentId: string };
    const query = request.query as { download?: string } | undefined;
    const session = await deps.getOwnedCodingSessionOrReply(currentUser.id, sessionId, reply);
    if (!session) {
      return { error: 'Session not found' };
    }

    const attachment = deps.getAttachment(sessionId, attachmentId);
    if (!attachment) {
      reply.code(404);
      return { error: 'Attachment not found' };
    }

    const buffer = await readFile(attachment.storagePath);
    reply.type(attachment.mimeType);
    reply.header('Cache-Control', 'private, max-age=60');
    reply.header(
      'Content-Disposition',
      `${query?.download === '1' || query?.download === 'true' ? 'attachment' : 'inline'}; filename="${attachment.filename.replace(/"/g, '')}"`,
    );
    return buffer;
  });

  app.delete('/api/coding/sessions/:sessionId/attachments/:attachmentId', async (request, reply) => {
    const currentUser = deps.getRequestUser(request);
    const { sessionId, attachmentId } = request.params as { sessionId: string; attachmentId: string };
    const session = await deps.getOwnedCodingSessionOrReply(currentUser.id, sessionId, reply);
    if (!session) {
      return { error: 'Session not found' };
    }

    const attachment = deps.getAttachment(sessionId, attachmentId);
    if (!attachment) {
      reply.code(404);
      return { error: 'Attachment not found' };
    }

    if (attachment.consumedAt) {
      reply.code(409);
      return { error: 'This attachment is already part of a sent turn.' };
    }

    await deps.removeAttachment(sessionId, attachmentId);
    await deps.deleteStoredAttachments([attachment]);
    return { ok: true };
  });

  app.patch('/api/coding/sessions/:sessionId', async (request, reply) => {
    const currentUser = deps.getRequestUser(request);
    const { sessionId } = request.params as { sessionId: string };
    const body = (request.body ?? {}) as UpdateSessionRequest;
    const session = await deps.getOwnedCodingSessionOrReply(currentUser.id, sessionId, reply);
    if (!session) {
      return { error: 'Session not found' };
    }

    const titleProvided = Object.prototype.hasOwnProperty.call(body, 'title');
    const workspaceProvided = Object.prototype.hasOwnProperty.call(body, 'workspaceName');
    const securityProvided = Object.prototype.hasOwnProperty.call(body, 'securityProfile');
    const approvalModeProvided = Object.prototype.hasOwnProperty.call(body, 'approvalMode');
    const title = titleProvided ? deps.trimOptional(body.title) : session.title;

    if (titleProvided && !title) {
      reply.code(400);
      return { error: 'Session title is required' };
    }

    if ((workspaceProvided || securityProvided) && session.activeTurnId) {
      reply.code(409);
      return { error: 'Stop the active turn before editing this session.' };
    }

    let workspace = session.workspace;
    let workspaceId = session.workspaceId;
    if (workspaceProvided) {
      const workspaceName = deps.normalizeWorkspaceFolderName(body.workspaceName);
      if (!workspaceName) {
        reply.code(400);
        return { error: 'Workspace is required.' };
      }

      try {
        const workspaceRecord = await deps.ensureUserWorkspace(currentUser.username, currentUser.id, workspaceName);
        workspace = workspaceRecord.path;
        workspaceId = workspaceRecord.id;
      } catch (error) {
        reply.code(400);
        return { error: deps.errorMessage(error) };
      }
    }

    let securityProfile = session.securityProfile;
    if (securityProvided) {
      securityProfile = deps.normalizeSecurityProfile(body.securityProfile);
      if (securityProfile === 'read-only') {
        securityProfile = 'repo-write';
      }
      if (securityProfile === 'full-host' && !currentUser.canUseFullHost) {
        reply.code(403);
        return { error: 'You do not have permission to use full-host sessions.' };
      }
    }

    const approvalMode = approvalModeProvided
      ? deps.normalizeApprovalMode(body.approvalMode)
      : session.approvalMode;
    const restartRequired = workspace !== session.workspace || securityProfile !== session.securityProfile;

    let nextSession = (await deps.updateCodingSession(session.id, {
      title: title ?? session.title,
      autoTitle: titleProvided ? false : session.autoTitle,
      workspace,
      workspaceId,
      securityProfile,
      approvalMode,
      fullHostEnabled: securityProfile === 'full-host',
    })) ?? session;

    if (restartRequired) {
      nextSession = await deps.restartSessionThread(
        nextSession,
        'Session settings changed. Started a fresh thread for this session.',
      );
    }

    return { session: nextSession };
  });

  app.patch('/api/coding/sessions/:sessionId/preferences', async (request, reply) => {
    const currentUser = deps.getRequestUser(request);
    const { sessionId } = request.params as { sessionId: string };
    const body = (request.body ?? {}) as UpdateSessionPreferencesRequest;
    const session = await deps.getOwnedCodingSessionOrReply(currentUser.id, sessionId, reply);
    if (!session) {
      return { error: 'Session not found' };
    }

    const requestedExecutor = body.executor === undefined
      ? session.executor
      : deps.normalizeExecutor(body.executor);
    if (!deps.isExecutorSupported(requestedExecutor)) {
      reply.code(400);
      return { error: 'Executor not available.' };
    }

    if (requestedExecutor !== session.executor && session.activeTurnId) {
      reply.code(409);
      return { error: 'Stop the active turn before switching executor.' };
    }

    const requestedModel = deps.trimOptional(body.model)
      ?? (requestedExecutor === session.executor
        ? (session.model ?? deps.currentDefaultModel(requestedExecutor))
        : deps.currentDefaultModel(requestedExecutor));
    const modelOption = deps.findModelOption(requestedModel, requestedExecutor);
    if (!modelOption) {
      reply.code(400);
      return { error: 'Unknown model.' };
    }

    const requestedEffort = deps.normalizeReasoningEffort(body.reasoningEffort);
    const reasoningEffort = requestedEffort && modelOption.supportedReasoningEfforts.includes(requestedEffort)
      ? requestedEffort
      : deps.preferredReasoningEffortForModel(modelOption);

    let nextSession = (await deps.updateCodingSession(session.id, {
      executor: requestedExecutor,
      model: modelOption.model,
      reasoningEffort,
      approvalMode: deps.normalizeApprovalMode(body.approvalMode ?? session.approvalMode),
    })) ?? {
      ...session,
      executor: requestedExecutor,
      model: modelOption.model,
      reasoningEffort,
      approvalMode: deps.normalizeApprovalMode(body.approvalMode ?? session.approvalMode),
    };

    if (requestedExecutor !== session.executor) {
      nextSession = await deps.restartSessionThread(
        nextSession,
        'Executor changed. Started a fresh thread for this session.',
      );
    }

    return { session: nextSession };
  });

  app.post('/api/coding/sessions/:sessionId/restart', async (request, reply) => {
    const currentUser = deps.getRequestUser(request);
    const { sessionId } = request.params as { sessionId: string };
    const session = await deps.getOwnedCodingSessionOrReply(currentUser.id, sessionId, reply);
    if (!session) {
      return { error: 'Session not found' };
    }

    return { session: await deps.restartSessionThread(session) };
  });

  app.post('/api/coding/sessions/:sessionId/fork', async (request, reply) => {
    const currentUser = deps.getRequestUser(request);
    const { sessionId } = request.params as { sessionId: string };
    const session = await deps.getOwnedCodingSessionOrReply(currentUser.id, sessionId, reply);
    if (!session) {
      return { error: 'Session not found' };
    }

    try {
      const nextSession = await deps.createForkedSession(currentUser, session);
      reply.code(201);
      return { session: nextSession };
    } catch (error) {
      reply.code(500);
      return { error: deps.errorMessage(error) };
    }
  });

  app.post('/api/coding/sessions/:sessionId/archive', async (request, reply) => {
    const currentUser = deps.getRequestUser(request);
    const { sessionId } = request.params as { sessionId: string };
    const session = await deps.getOwnedCodingSessionOrReply(currentUser.id, sessionId, reply);
    if (!session) {
      return { error: 'Session not found' };
    }

    if (session.archivedAt) {
      return { session };
    }

    const nextSession = (await deps.updateCodingSession(session.id, {
      archivedAt: new Date().toISOString(),
      activeTurnId: null,
      status: 'idle',
      networkEnabled: false,
      lastIssue: null,
    })) ?? session;

    return { session: nextSession };
  });

  app.post('/api/coding/sessions/:sessionId/restore', async (request, reply) => {
    const currentUser = deps.getRequestUser(request);
    const { sessionId } = request.params as { sessionId: string };
    const session = await deps.getOwnedCodingSessionOrReply(currentUser.id, sessionId, reply);
    if (!session) {
      return { error: 'Session not found' };
    }

    if (!session.archivedAt) {
      return { session };
    }

    const nextSession = (await deps.updateCodingSession(session.id, {
      archivedAt: null,
      status: 'idle',
      lastIssue: null,
    })) ?? session;

    return { session: nextSession };
  });

  app.delete('/api/coding/sessions/:sessionId', async (request, reply) => {
    const currentUser = deps.getRequestUser(request);
    const { sessionId } = request.params as { sessionId: string };
    const session = await deps.getOwnedCodingSessionOrReply(currentUser.id, sessionId, reply);
    if (!session) {
      return { error: 'Session not found' };
    }

    const attachments = deps.listAttachments(sessionId);
    await deps.deleteCodingSession(sessionId);
    await deps.deleteStoredAttachments(attachments);
    return { ok: true };
  });

  app.post('/api/coding/sessions/:sessionId/turns', async (request, reply) => {
    const currentUser = deps.getRequestUser(request);
    const { sessionId } = request.params as { sessionId: string };
    const body = request.body as CreateTurnRequest;
    const session = await deps.getOwnedCodingSessionOrReply(currentUser.id, sessionId, reply);
    if (!session) {
      return { error: 'Session not found' };
    }

    const prompt = body.prompt?.trim() ?? '';
    const attachmentIds = Array.isArray(body.attachmentIds)
      ? [...new Set(body.attachmentIds.filter((value): value is string => typeof value === 'string' && value.trim().length > 0))]
      : [];
    const attachments = attachmentIds.map((attachmentId) => deps.getAttachment(sessionId, attachmentId));

    if (!prompt && attachmentIds.length === 0) {
      reply.code(400);
      return { error: 'Prompt or attachment is required' };
    }

    if (attachments.some((attachment) => !attachment || attachment.consumedAt)) {
      reply.code(400);
      return { error: 'One or more attachments are missing or already used.' };
    }

    try {
      const result = await deps.startTurnWithAutoRestart(
        session,
        prompt || null,
        attachments.filter((attachment): attachment is SessionAttachmentRecord => Boolean(attachment)),
      );
      return { turn: result.turn, session: result.session };
    } catch (error) {
      const message = deps.errorMessage(error);
      await deps.updateCodingSession(session.id, {
        activeTurnId: null,
        status: 'error',
        lastIssue: message,
      });
      reply.code(500);
      return { error: message };
    }
  });

  app.post('/api/coding/sessions/:sessionId/stop', async (request, reply) => {
    const currentUser = deps.getRequestUser(request);
    const { sessionId } = request.params as { sessionId: string };
    const session = await deps.getOwnedCodingSessionOrReply(currentUser.id, sessionId, reply);
    if (!session) {
      return { error: 'Session not found' };
    }

    if (!session.activeTurnId) {
      reply.code(409);
      return { error: 'This session does not have an active turn to stop.' };
    }

    try {
      await deps.interruptTurn(session, session.threadId, session.activeTurnId);
      deps.addLiveEvent(session.id, {
        id: randomUUID(),
        method: 'turn/interrupted',
        summary: 'Stopped the active turn.',
        createdAt: new Date().toISOString(),
      });
      const nextSession = (await deps.updateCodingSession(session.id, {
        activeTurnId: null,
        status: 'idle',
        lastIssue: 'Stopped by user.',
      })) ?? session;
      return { session: nextSession };
    } catch (error) {
      if (deps.isThreadUnavailableError(error)) {
        const nextSession = (await deps.updateCodingSession(session.id, {
          activeTurnId: null,
          status: 'stale',
          lastIssue: deps.staleSessionMessage,
          networkEnabled: false,
        })) ?? session;
        reply.code(409);
        return { error: deps.staleSessionMessage, session: nextSession };
      }

      const message = deps.errorMessage(error);
      await deps.updateCodingSession(session.id, {
        activeTurnId: null,
        status: 'error',
        lastIssue: message,
      });
      reply.code(500);
      return { error: message };
    }
  });

  app.post('/api/coding/sessions/:sessionId/approvals/:approvalId', async (request, reply) => {
    const currentUser = deps.getRequestUser(request);
    const { sessionId, approvalId } = request.params as { sessionId: string; approvalId: string };
    const body = request.body as ResolveApprovalRequest;
    const session = await deps.getOwnedCodingSessionOrReply(currentUser.id, sessionId, reply);
    if (!session) {
      return { error: 'Session not found' };
    }

    const approval = deps.getApprovals(sessionId).find((entry) => entry.id === approvalId);
    if (!approval) {
      reply.code(404);
      return { error: 'Approval not found' };
    }

    const scope = body.scope === 'session' ? 'session' : 'once';
    const accepted = body.decision !== 'decline';

    if (approval.method === 'item/commandExecution/requestApproval') {
      await deps.respondToRuntime(session, approval.rpcRequestId, {
        decision: accepted ? (scope === 'session' ? 'acceptForSession' : 'accept') : 'decline',
      });
    } else if (approval.method === 'item/fileChange/requestApproval') {
      await deps.respondToRuntime(session, approval.rpcRequestId, {
        decision: accepted ? (scope === 'session' ? 'acceptForSession' : 'accept') : 'decline',
      });
    } else if (approval.method === 'item/permissions/requestApproval') {
      const params = approval.payload as { permissions?: unknown };
      await deps.respondToRuntime(session, approval.rpcRequestId, {
        permissions: accepted ? (params.permissions ?? {}) : {},
        scope: scope === 'session' ? 'session' : 'turn',
      });
      if (accepted) {
        await deps.updateCodingSession(sessionId, {
          networkEnabled: true,
        });
      }
    } else {
      await deps.respondToRuntime(session, approval.rpcRequestId, {
        decision: accepted ? 'accept' : 'cancel',
      });
    }

    deps.removeApproval(sessionId, approvalId);
    await deps.updateCodingSession(sessionId, {
      status: deps.getApprovals(sessionId).length > 0 ? 'needs-approval' : 'running',
      lastIssue: null,
    });
    return { ok: true };
  });
}
