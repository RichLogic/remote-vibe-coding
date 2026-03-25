import test from 'node:test';
import assert from 'node:assert/strict';

import type { UserRecord } from '../types.js';
import { resolveRequestAuth, type RequestAuthProvider } from './request-auth.js';

function buildUser(username: string): UserRecord {
  return {
    id: `${username}-id`,
    username,
    roles: username === 'owner' ? ['user', 'developer', 'admin'] : ['user'],
    preferredMode: username === 'owner' ? 'developer' : 'chat',
    isAdmin: username === 'owner',
    allowedSessionTypes: username === 'owner' ? ['chat', 'code'] : ['chat'],
    canUseFullHost: username === 'owner',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

function buildProvider(): RequestAuthProvider {
  return {
    findUserSessionByToken(token) {
      if (token === 'owner-token') {
        return { token: 'owner-token', user: buildUser('owner') };
      }
      if (token === 'alice-token') {
        return { token: 'alice-token', user: buildUser('alice') };
      }
      return null;
    },
    devBypassUser(enabled) {
      return enabled ? buildUser('owner') : null;
    },
  };
}

test('resolveRequestAuth authenticates token users and clears login token from page URL', () => {
  const decision = resolveRequestAuth(buildProvider(), {
    url: '/?token=owner-token&view=chat',
    method: 'GET',
    queryToken: 'owner-token',
    cookieToken: null,
    bearerToken: null,
    devBypassEnabled: false,
  });

  assert.equal(decision.kind, 'authenticated');
  if (decision.kind !== 'authenticated') return;
  assert.equal(decision.user.username, 'owner');
  assert.equal(decision.cookieTokenToSet, 'owner-token');
  assert.equal(decision.redirectTo, '/?view=chat');
});

test('resolveRequestAuth prefers cookie auth over bearer auth on API requests', () => {
  const decision = resolveRequestAuth(buildProvider(), {
    url: '/api/bootstrap',
    method: 'GET',
    queryToken: null,
    cookieToken: 'alice-token',
    bearerToken: 'owner-token',
    devBypassEnabled: false,
  });

  assert.equal(decision.kind, 'authenticated');
  if (decision.kind !== 'authenticated') return;
  assert.equal(decision.user.username, 'alice');
  assert.equal(decision.cookieTokenToSet, null);
  assert.equal(decision.redirectTo, null);
});

test('resolveRequestAuth allows anonymous health and login routes', () => {
  const healthDecision = resolveRequestAuth(buildProvider(), {
    url: '/api/health',
    method: 'GET',
    queryToken: null,
    cookieToken: null,
    bearerToken: null,
    devBypassEnabled: false,
  });
  assert.deepEqual(healthDecision, { kind: 'allow-anonymous' });

  const loginDecision = resolveRequestAuth(buildProvider(), {
    url: '/login',
    method: 'GET',
    queryToken: null,
    cookieToken: null,
    bearerToken: null,
    devBypassEnabled: false,
  });
  assert.deepEqual(loginDecision, { kind: 'allow-anonymous' });
});

test('resolveRequestAuth rejects anonymous API access and redirects page access', () => {
  const apiDecision = resolveRequestAuth(buildProvider(), {
    url: '/api/sessions',
    method: 'GET',
    queryToken: null,
    cookieToken: null,
    bearerToken: null,
    devBypassEnabled: false,
  });
  assert.deepEqual(apiDecision, { kind: 'reject-api' });

  const pageDecision = resolveRequestAuth(buildProvider(), {
    url: '/app',
    method: 'GET',
    queryToken: null,
    cookieToken: null,
    bearerToken: null,
    devBypassEnabled: false,
  });
  assert.deepEqual(pageDecision, { kind: 'redirect-login' });
});

test('resolveRequestAuth supports dev bypass', () => {
  const decision = resolveRequestAuth(buildProvider(), {
    url: '/api/bootstrap',
    method: 'GET',
    queryToken: null,
    cookieToken: null,
    bearerToken: null,
    devBypassEnabled: true,
  });

  assert.equal(decision.kind, 'authenticated');
  if (decision.kind !== 'authenticated') return;
  assert.equal(decision.user.username, 'owner');
  assert.equal(decision.cookieTokenToSet, null);
  assert.equal(decision.redirectTo, null);
});
