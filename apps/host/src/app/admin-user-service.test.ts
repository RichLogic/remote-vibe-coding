import test from 'node:test';
import assert from 'node:assert/strict';

import type { CreateUserRequest, UpdateUserRequest, AdminUserRecord } from '../types.js';
import { AdminUserService, AdminUserServiceError } from './admin-user-service.js';

function buildUser(overrides: Partial<AdminUserRecord> = {}): AdminUserRecord {
  const username = overrides.username ?? 'owner';
  return {
    id: overrides.id ?? `${username}-id`,
    username,
    roles: overrides.roles ?? ['user'],
    preferredMode: overrides.preferredMode ?? 'chat',
    isAdmin: overrides.isAdmin ?? false,
    allowedSessionTypes: overrides.allowedSessionTypes ?? ['chat'],
    canUseFullHost: overrides.canUseFullHost ?? false,
    createdAt: overrides.createdAt ?? '2026-01-01T00:00:00.000Z',
    updatedAt: overrides.updatedAt ?? '2026-01-01T00:00:00.000Z',
    token: overrides.token ?? `${username}-token`,
  };
}

function createHarness() {
  const users = [
    buildUser({
      id: 'owner-1',
      username: 'owner',
      roles: ['user', 'developer', 'admin'],
      preferredMode: 'developer',
      isAdmin: true,
      allowedSessionTypes: ['chat', 'code'],
      canUseFullHost: true,
      token: 'owner-token',
    }),
    buildUser({
      id: 'alice-1',
      username: 'alice',
      token: 'alice-token',
    }),
  ];

  const usernameUpdates = {
    sessions: [] as Array<{ userId: string; username: string }>,
    conversations: [] as Array<{ userId: string; username: string }>,
    coding: [] as Array<{ userId: string; username: string }>,
  };
  let codingSessionCount = 0;
  let mirroredConversationCount = 0;
  let persistedConversationCount = 0;

  const service = new AdminUserService(
    {
      listUsers: () => [...users].sort((left, right) => left.username.localeCompare(right.username)),
      async createUser(input: CreateUserRequest) {
        const user = buildUser({
          id: `created-${users.length + 1}`,
          username: input.username ?? 'new-user',
          token: `token-${users.length + 1}`,
        });
        users.push(user);
        return user;
      },
      async updateUser(userId: string, input: UpdateUserRequest) {
        const index = users.findIndex((entry) => entry.id === userId);
        assert.notEqual(index, -1);
        const current = users[index]!;
        const next: AdminUserRecord = {
          ...current,
          username: input.username ?? current.username,
          token: input.regenerateToken ? `${current.username}-new-token` : current.token,
          updatedAt: '2026-02-01T00:00:00.000Z',
        };
        users[index] = next;
        return next;
      },
      async deleteUser(userId: string) {
        const nextUsers = users.filter((entry) => entry.id !== userId);
        users.length = 0;
        users.push(...nextUsers);
        return [...nextUsers].sort((left, right) => left.username.localeCompare(right.username));
      },
    },
    {
      listConversationsForUser: () => Array.from({ length: mirroredConversationCount }, () => ({})),
      async updateOwnerUsername(userId: string, username: string) {
        usernameUpdates.sessions.push({ userId, username });
      },
    },
    {
      async listConversationRecordsForUser() {
        return Array.from({ length: persistedConversationCount }, () => ({}));
      },
      async updateOwnerUsername(userId: string, username: string) {
        usernameUpdates.conversations.push({ userId, username });
      },
    },
    {
      async countSessionsForUser() {
        return codingSessionCount;
      },
      async updateOwnerUsername(userId: string, username: string) {
        usernameUpdates.coding.push({ userId, username });
      },
    },
  );

  return {
    service,
    users,
    usernameUpdates,
    setCounts(next: { coding?: number; mirrored?: number; persisted?: number }) {
      codingSessionCount = next.coding ?? codingSessionCount;
      mirroredConversationCount = next.mirrored ?? mirroredConversationCount;
      persistedConversationCount = next.persisted ?? persistedConversationCount;
    },
  };
}

test('AdminUserService creates users and returns refreshed list', async () => {
  const harness = createHarness();

  const result = await harness.service.createUser({ username: 'zoe', password: 'test-pass-123' });

  assert.equal(result.user.username, 'zoe');
  assert.deepEqual(result.users.map((user) => user.username), ['alice', 'owner', 'zoe']);
});

test('AdminUserService updates username, propagates ownership, and refreshes cookie when needed', async () => {
  const harness = createHarness();

  const result = await harness.service.updateUser('owner-1', {
    username: 'owner-renamed',
    regenerateToken: true,
  }, 'owner-1');

  assert.equal(result.user.username, 'owner-renamed');
  assert.equal(result.shouldRefreshCookie, true);
  assert.deepEqual(harness.usernameUpdates.sessions, [{ userId: 'owner-1', username: 'owner-renamed' }]);
  assert.deepEqual(harness.usernameUpdates.conversations, [{ userId: 'owner-1', username: 'owner-renamed' }]);
  assert.deepEqual(harness.usernameUpdates.coding, [{ userId: 'owner-1', username: 'owner-renamed' }]);
});

test('AdminUserService skips owner propagation when username does not change', async () => {
  const harness = createHarness();

  const result = await harness.service.updateUser('alice-1', {
    regenerateToken: false,
  }, 'owner-1');

  assert.equal(result.user.username, 'alice');
  assert.equal(result.shouldRefreshCookie, false);
  assert.deepEqual(harness.usernameUpdates.sessions, []);
  assert.deepEqual(harness.usernameUpdates.conversations, []);
  assert.deepEqual(harness.usernameUpdates.coding, []);
});

test('AdminUserService blocks deleting users with remaining activity', async () => {
  const harness = createHarness();
  harness.setCounts({ coding: 1 });

  await assert.rejects(
    harness.service.deleteUser('alice-1', 'owner-1'),
    (error: unknown) => {
      assert.ok(error instanceof AdminUserServiceError);
      assert.equal(error.statusCode, 409);
      assert.match(error.message, /Delete this user/);
      return true;
    },
  );
});

test('AdminUserService deletes inactive users', async () => {
  const harness = createHarness();

  const result = await harness.service.deleteUser('alice-1', 'owner-1');

  assert.deepEqual(result.users.map((user) => user.username), ['owner']);
});
