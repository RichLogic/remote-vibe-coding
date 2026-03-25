import test from 'node:test';
import assert from 'node:assert/strict';

import { hashPassword } from '../auth.js';
import { HostAuthState, type LoadedAuthState } from './auth-state.js';

function buildAuthState(): LoadedAuthState {
  return {
    version: 3,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    users: [
      {
        id: 'admin-1',
        username: 'owner',
        roles: ['user', 'developer', 'admin'],
        preferredMode: 'developer',
        canUseFullHost: true,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        passwordHash: hashPassword('owner-pass'),
        token: 'owner-token',
      },
      {
        id: 'user-1',
        username: 'alice',
        roles: ['user'],
        preferredMode: 'chat',
        canUseFullHost: false,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        passwordHash: hashPassword('alice-pass'),
        token: 'alice-token',
      },
    ],
  };
}

test('HostAuthState finds token sessions and verifies credentials', () => {
  const auth = HostAuthState.fromState(buildAuthState());

  const tokenSession = auth.findUserSessionByToken('alice-token');
  assert.ok(tokenSession);
  assert.equal(tokenSession.user.username, 'alice');
  assert.equal(tokenSession.user.preferredMode, 'chat');

  const loginSession = auth.verifyCredentials('owner', 'owner-pass');
  assert.ok(loginSession);
  assert.equal(loginSession.user.username, 'owner');
  assert.equal(loginSession.token, 'owner-token');

  assert.equal(auth.findUserSessionByToken('missing-token'), null);
  assert.equal(auth.verifyCredentials('owner', 'wrong-password'), null);
});

test('HostAuthState returns admin fallback and optional dev bypass user', () => {
  const auth = HostAuthState.fromState(buildAuthState());

  const owner = auth.fallbackOwner();
  assert.equal(owner.username, 'owner');
  assert.equal(owner.isAdmin, true);

  const bypass = auth.devBypassUser(true);
  assert.ok(bypass);
  assert.equal(bypass.username, 'owner');

  assert.equal(auth.devBypassUser(false), null);
});

test('HostAuthState lists sanitized users', () => {
  const auth = HostAuthState.fromState(buildAuthState());

  const users = auth.listUsers();
  assert.equal(users.length, 2);
  assert.deepEqual(users.map((user) => user.username), ['alice', 'owner']);
  assert.equal(users[0]?.token, 'alice-token');
  assert.equal(users[1]?.isAdmin, true);
});
