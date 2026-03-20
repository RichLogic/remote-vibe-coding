import { mkdir, stat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { basename, join, resolve } from 'node:path';

import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import cors from '@fastify/cors';
import fastifyCookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';

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
import { CloudflareTunnelManager } from './cloudflare.js';
import { CodexAppServerClient, type JsonRpcNotification, type JsonRpcServerRequest } from './codex-app-server.js';
import { CHAT_WORKSPACES_DIR, HOST, PORT, WEB_DIST_DIR } from './config.js';
import { SessionStore } from './store.js';
import type {
  CodexThread,
  CreateSessionRequest,
  CreateTurnRequest,
  CreateUserRequest,
  ModelOption,
  PendingApproval,
  ReasoningEffort,
  RenameSessionRequest,
  ResolveApprovalRequest,
  SecurityProfile,
  SessionEvent,
  SessionRecord,
  SessionType,
  UpdateUserRequest,
  UserRecord,
} from './types.js';

type AuthenticatedRequest = FastifyRequest & {
  authUser?: UserRecord;
};

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

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function isThreadUnavailableError(error: unknown) {
  return errorMessage(error).includes('thread not loaded');
}

function isArchivedSession(session: SessionRecord) {
  return Boolean(session.archivedAt);
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

let authState = await loadOrCreateAuthState();
const seedUsers = getPublicUsers(authState);
const fallbackOwner = seedUsers.find((entry) => entry.isAdmin) ?? seedUsers[0]!;

const store = new SessionStore();
await store.load({
  fallbackOwnerUserId: fallbackOwner.id,
  fallbackOwnerUsername: fallbackOwner.username,
});

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

function currentDefaultEffort(model: string | null | undefined) {
  const option = availableModels.find((entry) => entry.model === model)
    ?? availableModels.find((entry) => entry.isDefault)
    ?? availableModels[0]
    ?? FALLBACK_MODELS[0]!;
  return option.defaultReasoningEffort;
}

function userCanCreateSessionType(user: UserRecord, sessionType: SessionType) {
  return user.allowedSessionTypes.includes(sessionType);
}

async function ensureChatWorkspace(userId: string, sessionId: string) {
  const workspace = join(CHAT_WORKSPACES_DIR, userId, sessionId);
  await mkdir(workspace, { recursive: true });
  return workspace;
}

function sessionApprovalsForUser(userId: string) {
  return store.getAllApprovalsForUser(userId);
}

function getOwnedSessionOrReply(userId: string, sessionId: string, reply: FastifyReply) {
  const session = store.getSessionForUser(sessionId, userId);
  if (!session) {
    reply.code(404);
    return null;
  }
  return session;
}

async function restartSessionThread(session: SessionRecord, summary = 'Started a fresh Codex thread for this session.') {
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

  return (await store.updateSession(session.id, {
    threadId: threadResponse.thread.id,
    activeTurnId: null,
    status: 'idle',
    networkEnabled: false,
    lastIssue: null,
  })) ?? session;
}

async function startTurnWithAutoRestart(session: SessionRecord, prompt: string) {
  let currentSession = session;

  if (currentSession.status === 'stale') {
    currentSession = await restartSessionThread(
      currentSession,
      'Automatically created a fresh thread before sending the next prompt.',
    );
  }

  const runTurn = async (targetSession: SessionRecord) => {
    await store.updateSession(targetSession.id, { status: 'running', lastIssue: null });
    const turn = await codex.startTurn(targetSession.threadId, prompt, {
      model: targetSession.model,
      effort: targetSession.reasoningEffort,
    });
    await store.updateSession(targetSession.id, {
      activeTurnId: turn.turn.id,
      status: 'running',
      lastIssue: null,
    });
    return turn;
  };

  try {
    const turn = await runTurn(currentSession);
    return { session: currentSession, turn };
  } catch (error) {
    if (!isThreadUnavailableError(error)) {
      throw error;
    }

    const latestSession = store.getSession(currentSession.id) ?? currentSession;
    currentSession = await restartSessionThread(
      latestSession,
      'Automatically created a fresh thread after a runtime reset.',
    );
    const turn = await runTurn(currentSession);
    return { session: currentSession, turn };
  }
}

async function handleChatApprovalRejection(session: SessionRecord, message: JsonRpcServerRequest) {
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
    await store.updateSession(session.id, {
      status: nextStatus,
      lastIssue: null,
      ...(statusType === 'idle' ? { activeTurnId: null } : {}),
    });
    return;
  }

  if (message.method === 'turn/completed') {
    await store.updateSession(session.id, {
      activeTurnId: null,
      status: store.getApprovals(session.id).length > 0 ? 'needs-approval' : 'idle',
      lastIssue: null,
    });
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
  return buildBootstrapPayload(
    currentUser,
    store.listSessionsForUser(currentUser.id),
    sessionApprovalsForUser(currentUser.id),
    await cloudflare.getStatus(),
    availableModels,
  );
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
  if (store.listSessionsForUser(userId).length > 0) {
    reply.code(409);
    return { error: 'Delete or archive this user’s sessions before removing the user.' };
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
  let session = getOwnedSessionOrReply(currentUser.id, sessionId, reply);
  if (!session) {
    return { error: 'Session not found' };
  }

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
      const latestSession = store.getSession(session.id);
      if (latestSession?.threadId === session.threadId) {
        session = (await store.updateSession(session.id, {
          activeTurnId: null,
          status: 'stale',
          lastIssue: STALE_SESSION_MESSAGE,
          networkEnabled: false,
        })) ?? session;
        store.clearApprovals(session.id);
      } else if (latestSession) {
        session = latestSession;
      }
    }
  }

  return {
    session,
    approvals: store.getApprovals(session.id),
    liveEvents: store.getLiveEvents(session.id),
    thread,
  };
});

app.post('/api/sessions', async (request, reply) => {
  const currentUser = getRequestUser(request);
  const body = (request.body ?? {}) as CreateSessionRequest;
  const sessionType = normalizeSessionType(body.sessionType);

  if (!userCanCreateSessionType(currentUser, sessionType)) {
    reply.code(403);
    return { error: `You do not have permission to create ${sessionType} sessions.` };
  }

  const sessionId = randomUUID();
  const model = trimOptional(body.model) ?? currentDefaultModel();
  const reasoningEffort = normalizeReasoningEffort(body.reasoningEffort) ?? currentDefaultEffort(model);

  let workspace: string;
  let securityProfile: SecurityProfile;

  if (sessionType === 'chat') {
    workspace = await ensureChatWorkspace(currentUser.id, sessionId);
    securityProfile = 'read-only';
  } else {
    const cwd = trimOptional(body.cwd);
    if (!cwd) {
      reply.code(400);
      return { error: 'Workspace is required for code sessions.' };
    }

    workspace = resolve(cwd);
    await ensureWorkspaceExists(workspace);

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
    cwd: workspace,
    securityProfile,
    model,
  });

  const now = new Date().toISOString();
  const session: SessionRecord = {
    id: sessionId,
    ownerUserId: currentUser.id,
    ownerUsername: currentUser.username,
    sessionType,
    threadId: threadResponse.thread.id,
    activeTurnId: null,
    title: trimOptional(body.title) || (sessionType === 'chat' ? 'Chat session' : basename(workspace)),
    workspace,
    archivedAt: null,
    securityProfile,
    networkEnabled: false,
    fullHostEnabled,
    status: 'idle',
    lastIssue: null,
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
  const session = getOwnedSessionOrReply(currentUser.id, sessionId, reply);
  if (!session) {
    return { error: 'Session not found' };
  }

  if (isArchivedSession(session)) {
    reply.code(409);
    return { error: 'Archived sessions must be restored before they can restart.' };
  }

  const nextSession = await restartSessionThread(session);
  return { session: nextSession };
});

app.post('/api/sessions/:sessionId/rename', async (request, reply) => {
  const currentUser = getRequestUser(request);
  const { sessionId } = request.params as { sessionId: string };
  const body = request.body as RenameSessionRequest;
  const session = getOwnedSessionOrReply(currentUser.id, sessionId, reply);
  if (!session) {
    return { error: 'Session not found' };
  }

  const title = body.title?.trim();
  if (!title) {
    reply.code(400);
    return { error: 'Session title is required' };
  }

  const nextSession = (await store.updateSession(sessionId, {
    title,
  })) ?? session;

  return { session: nextSession };
});

app.post('/api/sessions/:sessionId/archive', async (request, reply) => {
  const currentUser = getRequestUser(request);
  const { sessionId } = request.params as { sessionId: string };
  const session = getOwnedSessionOrReply(currentUser.id, sessionId, reply);
  if (!session) {
    return { error: 'Session not found' };
  }

  if (session.archivedAt) {
    return { session };
  }

  store.clearApprovals(sessionId);
  const nextSession = (await store.updateSession(sessionId, {
    archivedAt: new Date().toISOString(),
    activeTurnId: null,
    networkEnabled: false,
    lastIssue: null,
  })) ?? session;

  return { session: nextSession };
});

app.post('/api/sessions/:sessionId/restore', async (request, reply) => {
  const currentUser = getRequestUser(request);
  const { sessionId } = request.params as { sessionId: string };
  const session = getOwnedSessionOrReply(currentUser.id, sessionId, reply);
  if (!session) {
    return { error: 'Session not found' };
  }

  if (!session.archivedAt) {
    return { session };
  }

  const nextSession = (await store.updateSession(sessionId, {
    archivedAt: null,
    lastIssue: null,
  })) ?? session;

  return { session: nextSession };
});

app.delete('/api/sessions/:sessionId', async (request, reply) => {
  const currentUser = getRequestUser(request);
  const { sessionId } = request.params as { sessionId: string };
  const session = getOwnedSessionOrReply(currentUser.id, sessionId, reply);
  if (!session) {
    return { error: 'Session not found' };
  }

  await store.deleteSession(sessionId);
  return { ok: true };
});

app.post('/api/sessions/:sessionId/turns', async (request, reply) => {
  const currentUser = getRequestUser(request);
  const { sessionId } = request.params as { sessionId: string };
  const body = request.body as CreateTurnRequest;
  const session = getOwnedSessionOrReply(currentUser.id, sessionId, reply);
  if (!session) {
    return { error: 'Session not found' };
  }

  if (!body.prompt?.trim()) {
    reply.code(400);
    return { error: 'Prompt is required' };
  }

  if (isArchivedSession(session)) {
    reply.code(409);
    return { error: 'Archived sessions must be restored before they can accept a prompt.' };
  }

  try {
    const result = await startTurnWithAutoRestart(session, body.prompt.trim());
    return { turn: result.turn, session: result.session };
  } catch (error) {
    const message = errorMessage(error);
    await store.updateSession(sessionId, {
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
  const session = getOwnedSessionOrReply(currentUser.id, sessionId, reply);
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
    const nextSession = (await store.updateSession(session.id, {
      activeTurnId: null,
      status: 'idle',
      lastIssue: 'Stopped by user.',
    })) ?? session;
    return { session: nextSession };
  } catch (error) {
    if (isThreadUnavailableError(error)) {
      const nextSession = (await store.updateSession(session.id, {
        activeTurnId: null,
        status: 'stale',
        lastIssue: STALE_SESSION_MESSAGE,
        networkEnabled: false,
      })) ?? session;
      reply.code(409);
      return { error: STALE_SESSION_MESSAGE, session: nextSession };
    }

    const message = errorMessage(error);
    await store.updateSession(session.id, {
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
  const session = getOwnedSessionOrReply(currentUser.id, sessionId, reply);
  if (!session) {
    return { error: 'Session not found' };
  }

  if (isArchivedSession(session)) {
    reply.code(409);
    return { error: 'Archived sessions do not accept approvals.' };
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
  });
}

app.setNotFoundHandler(async (request, reply) => {
  if (request.url.startsWith('/api/')) {
    reply.code(404);
    return { error: 'Not found' };
  }

  if (hasBuiltWeb) {
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
