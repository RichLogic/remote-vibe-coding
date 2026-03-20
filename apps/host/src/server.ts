import { stat } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

import Fastify, { type FastifyRequest } from 'fastify';
import cors from '@fastify/cors';
import fastifyCookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';

import { AUTH_COOKIE_NAME, loadOrCreateOwnerAuth, loginPageHtml, verifyPassword, verifyToken } from './auth.js';
import { buildBootstrapPayload } from './bootstrap.js';
import { CloudflareTunnelManager } from './cloudflare.js';
import { CodexAppServerClient, type JsonRpcNotification, type JsonRpcServerRequest } from './codex-app-server.js';
import { HOST, PORT, WEB_DIST_DIR } from './config.js';
import { SessionStore } from './store.js';
import type {
  CodexThread,
  CreateSessionRequest,
  RenameSessionRequest,
  CreateTurnRequest,
  PendingApproval,
  ResolveApprovalRequest,
  SessionEvent,
  SessionRecord,
  SecurityProfile,
} from './types.js';

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

const STALE_SESSION_MESSAGE = 'Codex runtime restarted. Restart this session to create a fresh thread.';

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function isThreadUnavailableError(error: unknown) {
  return errorMessage(error).includes('thread not loaded');
}

function isArchivedSession(session: SessionRecord) {
  return Boolean(session.archivedAt);
}

const app = Fastify({
  logger: true,
  trustProxy: true,
});

await app.register(cors, {
  origin: true,
});
await app.register(fastifyCookie);

const store = new SessionStore();
await store.load();
const ownerAuth = await loadOrCreateOwnerAuth();

const codex = new CodexAppServerClient();
await codex.ensureStarted();
await store.markAllStale(STALE_SESSION_MESSAGE);
const cloudflare = new CloudflareTunnelManager();

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
    await store.updateSession(session.id, { status: nextStatus, lastIssue: null });
    return;
  }

  if (message.method === 'turn/completed') {
    await store.updateSession(session.id, {
      status: store.getApprovals(session.id).length > 0 ? 'needs-approval' : 'idle',
      lastIssue: null,
    });
    return;
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

  const matchingToken = [tokenFromQuery, cookieToken, bearerToken].find((value) => verifyToken(ownerAuth, value));

  if (matchingToken) {
    if (cookieToken !== ownerAuth.token) {
      reply.setCookie(AUTH_COOKIE_NAME, ownerAuth.token, {
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
    path === '/login' ||
    path === '/api/auth/login' ||
    path === '/api/health'
  ) {
    return;
  }

  if (path.startsWith('/api/')) {
    reply.code(401).send({ error: 'Authentication required' });
    return reply;
  }

  return reply.redirect('/login');
});

app.get('/login', async (request, reply) => {
  reply.type('text/html; charset=utf-8');
  return loginPageHtml();
});

app.post('/api/auth/login', async (request, reply) => {
  const body = request.body as { username?: string; password?: string } | undefined;
  const username = body?.username?.trim() ?? '';
  const password = body?.password ?? '';

  if (!verifyPassword(ownerAuth, username, password)) {
    reply.code(401);
    return { error: 'Invalid username or password' };
  }

  reply.setCookie(AUTH_COOKIE_NAME, ownerAuth.token, {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    secure: cookieIsSecure(request),
  });
  return { ok: true, username: ownerAuth.username };
});

app.post('/api/auth/logout', async (request, reply) => {
  reply.clearCookie(AUTH_COOKIE_NAME, {
    path: '/',
  });
  return { ok: true };
});

app.get('/api/health', async () => ({
  ok: true,
  service: 'remote-vibe-coding-host',
}));

app.get('/api/bootstrap', async () => {
  return buildBootstrapPayload(
    store.listSessions(),
    store.getAllApprovals(),
    await cloudflare.getStatus(),
  );
});

app.get('/api/cloudflare/status', async () => ({
  cloudflare: await cloudflare.getStatus(),
}));

app.post('/api/cloudflare/connect', async (request, reply) => {
  try {
    return {
      cloudflare: await cloudflare.connect(),
    };
  } catch (error) {
    reply.code(500);
    return {
      error: error instanceof Error ? error.message : 'Failed to connect Cloudflare tunnel',
    };
  }
});

app.post('/api/cloudflare/disconnect', async (request, reply) => {
  try {
    return {
      cloudflare: await cloudflare.disconnect(),
    };
  } catch (error) {
    reply.code(500);
    return {
      error: error instanceof Error ? error.message : 'Failed to disconnect Cloudflare tunnel',
    };
  }
});

app.get('/api/sessions/:sessionId', async (request, reply) => {
  const { sessionId } = request.params as { sessionId: string };
  let session = store.getSession(sessionId);
  if (!session) {
    reply.code(404);
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
  const body = request.body as CreateSessionRequest;
  const workspace = resolve(body.cwd);
  await ensureWorkspaceExists(workspace);

  const securityProfile: SecurityProfile = body.securityProfile === 'full-host' ? 'full-host' : 'repo-write';
  const fullHostEnabled = securityProfile === 'full-host';
  const threadResponse = await codex.startThread(workspace, fullHostEnabled);

  const session: SessionRecord = {
    id: randomUUID(),
    threadId: threadResponse.thread.id,
    title: body.title?.trim() || basename(workspace),
    workspace,
    archivedAt: null,
    securityProfile,
    networkEnabled: false,
    fullHostEnabled,
    status: 'idle',
    lastIssue: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  await store.upsertSession(session);
  reply.code(201);
  return { session };
});

app.post('/api/sessions/:sessionId/restart', async (request, reply) => {
  const { sessionId } = request.params as { sessionId: string };
  const session = store.getSession(sessionId);
  if (!session) {
    reply.code(404);
    return { error: 'Session not found' };
  }

  if (isArchivedSession(session)) {
    reply.code(409);
    return { error: 'Archived sessions must be restored before they can restart.' };
  }

  const threadResponse = await codex.startThread(session.workspace, session.fullHostEnabled);
  store.clearApprovals(sessionId);
  store.clearLiveEvents(sessionId);
  store.addLiveEvent(sessionId, {
    id: randomUUID(),
    method: 'session/restarted',
    summary: 'Started a fresh Codex thread for this session.',
    createdAt: new Date().toISOString(),
  });

  const nextSession = (await store.updateSession(sessionId, {
    threadId: threadResponse.thread.id,
    status: 'idle',
    networkEnabled: false,
    lastIssue: null,
  })) ?? session;

  return { session: nextSession };
});

app.post('/api/sessions/:sessionId/rename', async (request, reply) => {
  const { sessionId } = request.params as { sessionId: string };
  const body = request.body as RenameSessionRequest;
  const session = store.getSession(sessionId);
  if (!session) {
    reply.code(404);
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
  const { sessionId } = request.params as { sessionId: string };
  const session = store.getSession(sessionId);
  if (!session) {
    reply.code(404);
    return { error: 'Session not found' };
  }

  if (session.archivedAt) {
    return { session };
  }

  store.clearApprovals(sessionId);
  const nextSession = (await store.updateSession(sessionId, {
    archivedAt: new Date().toISOString(),
    networkEnabled: false,
    lastIssue: null,
  })) ?? session;

  return { session: nextSession };
});

app.post('/api/sessions/:sessionId/restore', async (request, reply) => {
  const { sessionId } = request.params as { sessionId: string };
  const session = store.getSession(sessionId);
  if (!session) {
    reply.code(404);
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
  const { sessionId } = request.params as { sessionId: string };
  const session = store.getSession(sessionId);
  if (!session) {
    reply.code(404);
    return { error: 'Session not found' };
  }

  await store.deleteSession(sessionId);
  return { ok: true };
});

app.post('/api/sessions/:sessionId/turns', async (request, reply) => {
  const { sessionId } = request.params as { sessionId: string };
  const body = request.body as CreateTurnRequest;
  const session = store.getSession(sessionId);
  if (!session) {
    reply.code(404);
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

  if (session.status === 'stale') {
    reply.code(409);
    return { error: STALE_SESSION_MESSAGE };
  }

  await store.updateSession(sessionId, { status: 'running', lastIssue: null });

  try {
    const turn = await codex.startTurn(session.threadId, body.prompt.trim());
    return { turn };
  } catch (error) {
    if (isThreadUnavailableError(error)) {
      const latestSession = store.getSession(sessionId);
      if (latestSession?.threadId === session.threadId) {
        await store.updateSession(sessionId, {
          status: 'stale',
          lastIssue: STALE_SESSION_MESSAGE,
          networkEnabled: false,
        });
        store.clearApprovals(sessionId);
      }
      reply.code(409);
      return { error: STALE_SESSION_MESSAGE };
    }

    const message = errorMessage(error);
    await store.updateSession(sessionId, {
      status: 'error',
      lastIssue: message,
    });
    reply.code(500);
    return { error: message };
  }
});

app.post('/api/sessions/:sessionId/approvals/:approvalId', async (request, reply) => {
  const { sessionId, approvalId } = request.params as { sessionId: string; approvalId: string };
  const body = request.body as ResolveApprovalRequest;
  const session = store.getSession(sessionId);
  if (!session) {
    reply.code(404);
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
