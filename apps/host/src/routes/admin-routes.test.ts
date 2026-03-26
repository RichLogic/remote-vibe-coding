import test from 'node:test';
import assert from 'node:assert/strict';

import Fastify from 'fastify';
import fastifyCookie from '@fastify/cookie';

import { registerAdminRoutes } from './admin-routes.js';
import type { AdminUserRecord, UserRecord } from '../types.js';

function buildUser(overrides: Partial<UserRecord> = {}): UserRecord {
  return {
    id: 'user-1',
    username: 'owner',
    roles: ['admin', 'developer', 'user'],
    preferredMode: 'developer',
    isAdmin: true,
    allowedSessionTypes: ['chat', 'code'],
    canUseFullHost: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function buildAdminUser(overrides: Partial<AdminUserRecord> = {}): AdminUserRecord {
  return {
    ...buildUser(),
    token: 'token-1',
    ...overrides,
  };
}

function createHarness(overrides: Partial<Parameters<typeof registerAdminRoutes>[1]> = {}) {
  let rolePresetConfig = {
    defaultPresetId: null as string | null,
    presets: [] as Array<{ id: string; label: string; description: string | null; promptText: string }>,
  };

  const deps: Parameters<typeof registerAdminRoutes>[1] = {
    getRequestUser: () => buildUser(),
    trimOptional: (value) => {
      const next = typeof value === 'string' ? value.trim() : '';
      return next || null;
    },
    errorMessage: (error) => error instanceof Error ? error.message : String(error),
    cookieIsSecure: () => false,
    chatPromptConfig: {
      async loadRolePresetConfig() {
        return rolePresetConfig;
      },
      async saveRolePresetConfig(nextConfig) {
        rolePresetConfig = nextConfig;
        return rolePresetConfig;
      },
      rolePresetListResponse(config = rolePresetConfig) {
        return {
          rolePresets: config.presets.map((preset) => ({
            id: preset.id,
            label: preset.label,
            description: preset.description,
            prompt: preset.promptText,
            isDefault: config.defaultPresetId === preset.id,
          })),
          defaultRolePresetId: config.defaultPresetId,
        };
      },
    },
    adminUserService: {
      listUsers: () => [buildAdminUser()],
      async createUser() {
        return {
          user: buildAdminUser(),
          users: [buildAdminUser()],
        };
      },
      async updateUser() {
        return {
          user: buildAdminUser(),
          users: [buildAdminUser()],
          shouldRefreshCookie: false,
        };
      },
      async deleteUser() {
        return { users: [buildAdminUser()] };
      },
    },
    ...overrides,
  };

  return {
    app: Fastify(),
    deps,
  };
}

test('admin routes reject non-admin requests', async (t) => {
  const harness = createHarness({
    getRequestUser: () => buildUser({
      isAdmin: false,
      roles: ['developer'],
    }),
  });
  await harness.app.register(fastifyCookie);
  registerAdminRoutes(harness.app, harness.deps);
  t.after(() => harness.app.close());

  const response = await harness.app.inject({
    method: 'GET',
    url: '/api/admin/users',
  });

  assert.equal(response.statusCode, 403);
  assert.deepEqual(response.json(), {
    error: 'Admin access required',
  });
});

test('admin routes validate chat role preset creation payloads', async (t) => {
  const harness = createHarness();
  await harness.app.register(fastifyCookie);
  registerAdminRoutes(harness.app, harness.deps);
  t.after(() => harness.app.close());

  const response = await harness.app.inject({
    method: 'POST',
    url: '/api/admin/chat/role-presets',
    payload: {
      label: '   ',
      prompt: 'Prompt text',
    },
  });

  assert.equal(response.statusCode, 400);
  assert.deepEqual(response.json(), {
    error: 'Preset label is required.',
  });
});

test('admin routes refresh the auth cookie when the acting user token changes', async (t) => {
  const harness = createHarness({
    adminUserService: {
      listUsers: () => [buildAdminUser()],
      async createUser() {
        return {
          user: buildAdminUser(),
          users: [buildAdminUser()],
        };
      },
      async updateUser() {
        return {
          user: buildAdminUser({ token: 'next-token' }),
          users: [buildAdminUser({ token: 'next-token' })],
          shouldRefreshCookie: true,
        };
      },
      async deleteUser() {
        return { users: [buildAdminUser()] };
      },
    },
  });
  await harness.app.register(fastifyCookie);
  registerAdminRoutes(harness.app, harness.deps);
  t.after(() => harness.app.close());

  const response = await harness.app.inject({
    method: 'PATCH',
    url: '/api/admin/users/user-1',
    payload: {
      username: 'owner',
    },
  });

  assert.equal(response.statusCode, 200);
  assert.match(String(response.headers['set-cookie'] ?? ''), /rvc_session=next-token/);
});
