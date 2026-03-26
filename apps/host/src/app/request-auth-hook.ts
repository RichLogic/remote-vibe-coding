import { type FastifyInstance, type FastifyRequest } from 'fastify';

import type { UserRecord } from '../types.js';
import { resolveRequestAuth, type RequestAuthProvider } from './request-auth.js';

export type AuthenticatedRequest = FastifyRequest & {
  authUser?: UserRecord;
};

interface RegisterRequestAuthHookOptions {
  auth: RequestAuthProvider;
  authCookieName: string;
  devBypassEnabled: boolean;
  cookieIsSecure: (request: FastifyRequest) => boolean;
}

function queryToken(request: FastifyRequest) {
  return typeof (request.query as { token?: unknown } | undefined)?.token === 'string'
    ? ((request.query as { token?: string }).token ?? null)
    : null;
}

function bearerToken(request: FastifyRequest) {
  const authorization = request.headers.authorization;
  return typeof authorization === 'string' && authorization.startsWith('Bearer ')
    ? authorization.slice('Bearer '.length).trim()
    : null;
}

export function registerRequestAuthHook(app: FastifyInstance, options: RegisterRequestAuthHookOptions) {
  app.addHook('onRequest', async (request, reply) => {
    const decision = resolveRequestAuth(options.auth, {
      url: request.url,
      method: request.method,
      queryToken: queryToken(request),
      cookieToken: request.cookies[options.authCookieName] ?? null,
      bearerToken: bearerToken(request),
      devBypassEnabled: options.devBypassEnabled,
    });

    if (decision.kind === 'authenticated') {
      (request as AuthenticatedRequest).authUser = decision.user;

      if (decision.cookieTokenToSet) {
        reply.setCookie(options.authCookieName, decision.cookieTokenToSet, {
          path: '/',
          httpOnly: true,
          sameSite: 'lax',
          secure: options.cookieIsSecure(request),
        });
      }

      if (decision.redirectTo) {
        return reply.redirect(decision.redirectTo);
      }

      return;
    }

    if (decision.kind === 'allow-anonymous') {
      return;
    }

    if (decision.kind === 'reject-api') {
      reply.code(401).send({ error: 'Authentication required' });
      return reply;
    }

    return reply.redirect('/login');
  });
}
