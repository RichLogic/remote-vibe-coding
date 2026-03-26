import test from 'node:test';
import assert from 'node:assert/strict';

import Fastify from 'fastify';
import fastifyCookie from '@fastify/cookie';

import { registerCoreRoutes } from './core-routes.js';
import type { UserRecord } from '../types.js';

function buildUser(): UserRecord {
  return {
    id: 'user-1',
    username: 'owner',
    roles: ['user', 'developer'],
    preferredMode: 'developer',
    isAdmin: false,
    allowedSessionTypes: ['chat', 'code'],
    canUseFullHost: false,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

function createHarness(overrides: Partial<Parameters<typeof registerCoreRoutes>[1]> = {}) {
  const bootstrapCalls: UserRecord[] = [];
  const loginCalls: Array<{ username: string; password: string }> = [];

  const deps: Parameters<typeof registerCoreRoutes>[1] = {
    devDisableAuth: false,
    renderLoginPage: () => '<html>login</html>',
    authCookieName: 'rvc_session',
    cookieIsSecure: () => false,
    verifyCredentials: (username, password) => {
      loginCalls.push({ username, password });
      return username === 'owner' && password === 'secret'
        ? { token: 'token-1', user: { username } }
        : null;
    },
    getRequestUser: () => buildUser(),
    buildBootstrapResponse: async (currentUser) => {
      bootstrapCalls.push(currentUser);
      return { ok: true, username: currentUser.username };
    },
    getCloudflareStatus: async () => ({ state: 'connected' }),
    connectCloudflare: async () => ({ state: 'connected' }),
    disconnectCloudflare: async () => ({ state: 'idle' }),
    errorMessage: (error) => error instanceof Error ? error.message : String(error),
    ...overrides,
  };

  return {
    app: Fastify(),
    deps,
    bootstrapCalls,
    loginCalls,
  };
}

test('core routes log users in and set the session cookie', async (t) => {
  const harness = createHarness();
  await harness.app.register(fastifyCookie);
  registerCoreRoutes(harness.app, harness.deps);
  t.after(() => harness.app.close());

  const response = await harness.app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: {
      username: 'owner',
      password: 'secret',
    },
  });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(harness.loginCalls, [{ username: 'owner', password: 'secret' }]);
  assert.match(String(response.headers['set-cookie'] ?? ''), /rvc_session=token-1/);
  assert.deepEqual(response.json(), {
    ok: true,
    username: 'owner',
  });
});

test('core routes delegate bootstrap responses to the bootstrap builder', async (t) => {
  const harness = createHarness();
  await harness.app.register(fastifyCookie);
  registerCoreRoutes(harness.app, harness.deps);
  t.after(() => harness.app.close());

  const response = await harness.app.inject({
    method: 'GET',
    url: '/api/bootstrap',
  });

  assert.equal(response.statusCode, 200);
  assert.equal(harness.bootstrapCalls.length, 1);
  assert.equal(harness.bootstrapCalls[0]?.id, 'user-1');
  assert.deepEqual(response.json(), {
    ok: true,
    username: 'owner',
  });
});
