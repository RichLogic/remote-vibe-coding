import type { UserRecord } from '../types.js';

export interface AuthenticatedUserSession {
  token: string;
  user: UserRecord;
}

export interface RequestAuthProvider {
  findUserSessionByToken(token: string | null | undefined): AuthenticatedUserSession | null;
  devBypassUser(enabled: boolean): UserRecord | null;
}

export type RequestAuthDecision =
  | {
      kind: 'authenticated';
      user: UserRecord;
      cookieTokenToSet: string | null;
      redirectTo: string | null;
    }
  | {
      kind: 'allow-anonymous';
    }
  | {
      kind: 'reject-api';
    }
  | {
      kind: 'redirect-login';
    };

interface ResolveRequestAuthInput {
  url: string;
  method: string;
  queryToken: string | null;
  cookieToken: string | null | undefined;
  bearerToken: string | null;
  devBypassEnabled: boolean;
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

export function resolveRequestAuth(auth: RequestAuthProvider, input: ResolveRequestAuthInput): RequestAuthDecision {
  const path = requestPath(input.url);
  const matchedUser = [input.queryToken, input.cookieToken, input.bearerToken]
    .map((candidate) => auth.findUserSessionByToken(candidate))
    .find((entry) => entry !== null) ?? null;

  if (matchedUser) {
    return {
      kind: 'authenticated',
      user: matchedUser.user,
      cookieTokenToSet: input.cookieToken !== matchedUser.token ? matchedUser.token : null,
      redirectTo: input.queryToken && input.method === 'GET' && !path.startsWith('/api/')
        ? clearTokenFromUrl(input.url)
        : null,
    };
  }

  const bypassUser = auth.devBypassUser(input.devBypassEnabled);
  if (bypassUser) {
    return {
      kind: 'authenticated',
      user: bypassUser,
      cookieTokenToSet: null,
      redirectTo: null,
    };
  }

  if (path === '/login' || path === '/api/auth/login' || path === '/api/health') {
    return { kind: 'allow-anonymous' };
  }

  if (path.startsWith('/api/')) {
    return { kind: 'reject-api' };
  }

  return { kind: 'redirect-login' };
}
