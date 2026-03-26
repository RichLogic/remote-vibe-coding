import { type FastifyInstance, type FastifyRequest } from 'fastify';

import type { UserRecord } from '../types.js';

interface CoreRoutesDependencies {
  devDisableAuth: boolean;
  renderLoginPage: () => string;
  authCookieName: string;
  cookieIsSecure: (request: FastifyRequest) => boolean;
  verifyCredentials: (username: string, password: string) => {
    token: string;
    user: Pick<UserRecord, 'username'>;
  } | null;
  getRequestUser: (request: FastifyRequest) => UserRecord;
  buildBootstrapResponse: (currentUser: UserRecord) => Promise<unknown>;
  getCloudflareStatus: () => Promise<unknown>;
  connectCloudflare: () => Promise<unknown>;
  disconnectCloudflare: () => Promise<unknown>;
  errorMessage: (error: unknown) => string;
}

export function registerCoreRoutes(app: FastifyInstance, deps: CoreRoutesDependencies) {
  app.get('/login', async (_request, reply) => {
    if (deps.devDisableAuth) {
      return reply.redirect('/');
    }
    reply.type('text/html; charset=utf-8');
    reply.header('Cache-Control', 'no-store');
    return deps.renderLoginPage();
  });

  app.post('/api/auth/login', async (request, reply) => {
    const body = request.body as { username?: string; password?: string } | undefined;
    const username = body?.username?.trim() ?? '';
    const password = body?.password ?? '';
    const user = deps.verifyCredentials(username, password);

    if (!user) {
      reply.code(401);
      return { error: 'Invalid username or password' };
    }

    reply.setCookie(deps.authCookieName, user.token, {
      path: '/',
      httpOnly: true,
      sameSite: 'lax',
      secure: deps.cookieIsSecure(request),
    });
    return { ok: true, username: user.user.username };
  });

  app.post('/api/auth/logout', async (_request, reply) => {
    reply.clearCookie(deps.authCookieName, {
      path: '/',
    });
    return { ok: true };
  });

  app.get('/api/health', async () => ({
    ok: true,
    service: 'remote-vibe-coding-host',
  }));

  app.get('/api/bootstrap', async (request) => {
    const currentUser = deps.getRequestUser(request);
    return deps.buildBootstrapResponse(currentUser);
  });

  app.get('/api/cloudflare/status', async () => ({
    cloudflare: await deps.getCloudflareStatus(),
  }));

  app.post('/api/cloudflare/connect', async (_request, reply) => {
    try {
      return {
        cloudflare: await deps.connectCloudflare(),
      };
    } catch (error) {
      reply.code(500);
      return {
        error: deps.errorMessage(error) || 'Failed to connect Cloudflare tunnel',
      };
    }
  });

  app.post('/api/cloudflare/disconnect', async (_request, reply) => {
    try {
      return {
        cloudflare: await deps.disconnectCloudflare(),
      };
    } catch (error) {
      reply.code(500);
      return {
        error: deps.errorMessage(error) || 'Failed to disconnect Cloudflare tunnel',
      };
    }
  });
}
