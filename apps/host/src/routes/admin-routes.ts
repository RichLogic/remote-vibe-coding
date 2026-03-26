import { randomUUID } from 'node:crypto';

import { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';

import { AUTH_COOKIE_NAME } from '../auth.js';
import { AdminUserServiceError } from '../app/admin-user-service.js';
import type {
  ChatPromptConfigStore,
  ChatRolePresetConfigEntry,
} from '../chat-prompt-config.js';
import type {
  CreateChatRolePresetRequest,
  UpdateChatRolePresetRequest,
} from '../chat/types.js';
import type {
  CreateUserRequest,
  UpdateUserRequest,
  UserRecord,
} from '../types.js';

interface AdminRoutesDependencies {
  getRequestUser: (request: FastifyRequest) => UserRecord;
  trimOptional: (value: unknown) => string | null;
  errorMessage: (error: unknown) => string;
  cookieIsSecure: (request: FastifyRequest) => boolean;
  chatPromptConfig: Pick<
    ChatPromptConfigStore,
    'loadRolePresetConfig' | 'saveRolePresetConfig' | 'rolePresetListResponse'
  >;
  adminUserService: {
    listUsers(): ReturnType<import('../app/admin-user-service.js').AdminUserService['listUsers']>;
    createUser(input: CreateUserRequest): ReturnType<import('../app/admin-user-service.js').AdminUserService['createUser']>;
    updateUser(
      userId: string,
      input: UpdateUserRequest,
      actingUserId: string,
    ): ReturnType<import('../app/admin-user-service.js').AdminUserService['updateUser']>;
    deleteUser(
      userId: string,
      actingUserId: string,
    ): ReturnType<import('../app/admin-user-service.js').AdminUserService['deleteUser']>;
  };
}

function requireAdmin(request: FastifyRequest, reply: FastifyReply, getRequestUser: AdminRoutesDependencies['getRequestUser']) {
  const currentUser = getRequestUser(request);
  if (!currentUser.isAdmin) {
    reply.code(403);
    return null;
  }
  return currentUser;
}

export function registerAdminRoutes(app: FastifyInstance, deps: AdminRoutesDependencies) {
  app.get('/api/admin/users', async (request, reply) => {
    const currentUser = requireAdmin(request, reply, deps.getRequestUser);
    if (!currentUser) {
      return { error: 'Admin access required' };
    }

    return {
      users: deps.adminUserService.listUsers(),
    };
  });

  app.get('/api/admin/chat/role-presets', async (request, reply) => {
    const currentUser = requireAdmin(request, reply, deps.getRequestUser);
    if (!currentUser) {
      return { error: 'Admin access required' };
    }

    const config = await deps.chatPromptConfig.loadRolePresetConfig();
    return deps.chatPromptConfig.rolePresetListResponse(config);
  });

  app.post('/api/admin/chat/role-presets', async (request, reply) => {
    const currentUser = requireAdmin(request, reply, deps.getRequestUser);
    if (!currentUser) {
      return { error: 'Admin access required' };
    }

    const body = (request.body ?? {}) as CreateChatRolePresetRequest;
    const label = deps.trimOptional(body.label);
    const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
    if (!label) {
      reply.code(400);
      return { error: 'Preset label is required.' };
    }
    if (!prompt) {
      reply.code(400);
      return { error: 'Preset prompt is required.' };
    }

    const config = await deps.chatPromptConfig.loadRolePresetConfig();
    const nextPreset: ChatRolePresetConfigEntry = {
      id: randomUUID(),
      label,
      description: deps.trimOptional(body.description),
      promptText: prompt,
    };
    const nextConfig = await deps.chatPromptConfig.saveRolePresetConfig({
      defaultPresetId: body.isDefault ? nextPreset.id : config.defaultPresetId,
      presets: [...config.presets, nextPreset],
    });
    reply.code(201);
    return deps.chatPromptConfig.rolePresetListResponse(nextConfig);
  });

  app.patch('/api/admin/chat/role-presets/:presetId', async (request, reply) => {
    const currentUser = requireAdmin(request, reply, deps.getRequestUser);
    if (!currentUser) {
      return { error: 'Admin access required' };
    }

    const { presetId } = request.params as { presetId: string };
    const body = (request.body ?? {}) as UpdateChatRolePresetRequest;
    const config = await deps.chatPromptConfig.loadRolePresetConfig();
    const existingPreset = config.presets.find((preset) => preset.id === presetId);
    if (!existingPreset) {
      reply.code(404);
      return { error: 'Preset not found.' };
    }

    const nextLabel = Object.prototype.hasOwnProperty.call(body, 'label')
      ? deps.trimOptional(body.label)
      : existingPreset.label;
    const nextPrompt = Object.prototype.hasOwnProperty.call(body, 'prompt')
      ? (typeof body.prompt === 'string' ? body.prompt.trim() : '')
      : existingPreset.promptText;
    if (!nextLabel) {
      reply.code(400);
      return { error: 'Preset label is required.' };
    }
    if (!nextPrompt) {
      reply.code(400);
      return { error: 'Preset prompt is required.' };
    }

    const nextConfig = await deps.chatPromptConfig.saveRolePresetConfig({
      defaultPresetId: body.isDefault === true
        ? presetId
        : body.isDefault === false && config.defaultPresetId === presetId
          ? null
          : config.defaultPresetId,
      presets: config.presets.map((preset) => (
        preset.id === presetId
          ? {
              ...preset,
              label: nextLabel,
              description: Object.prototype.hasOwnProperty.call(body, 'description')
                ? deps.trimOptional(body.description)
                : preset.description,
              promptText: nextPrompt,
            }
          : preset
      )),
    });
    return deps.chatPromptConfig.rolePresetListResponse(nextConfig);
  });

  app.delete('/api/admin/chat/role-presets/:presetId', async (request, reply) => {
    const currentUser = requireAdmin(request, reply, deps.getRequestUser);
    if (!currentUser) {
      return { error: 'Admin access required' };
    }

    const { presetId } = request.params as { presetId: string };
    const config = await deps.chatPromptConfig.loadRolePresetConfig();
    if (!config.presets.some((preset) => preset.id === presetId)) {
      reply.code(404);
      return { error: 'Preset not found.' };
    }

    const nextConfig = await deps.chatPromptConfig.saveRolePresetConfig({
      defaultPresetId: config.defaultPresetId === presetId ? null : config.defaultPresetId,
      presets: config.presets.filter((preset) => preset.id !== presetId),
    });
    return deps.chatPromptConfig.rolePresetListResponse(nextConfig);
  });

  app.post('/api/admin/users', async (request, reply) => {
    const currentUser = requireAdmin(request, reply, deps.getRequestUser);
    if (!currentUser) {
      return { error: 'Admin access required' };
    }

    try {
      const body = (request.body ?? {}) as CreateUserRequest;
      const result = await deps.adminUserService.createUser(body);
      reply.code(201);
      return result;
    } catch (error) {
      reply.code(400);
      return { error: deps.errorMessage(error) };
    }
  });

  app.patch('/api/admin/users/:userId', async (request, reply) => {
    const currentUser = requireAdmin(request, reply, deps.getRequestUser);
    if (!currentUser) {
      return { error: 'Admin access required' };
    }

    try {
      const { userId } = request.params as { userId: string };
      const body = (request.body ?? {}) as UpdateUserRequest;
      const result = await deps.adminUserService.updateUser(userId, body, currentUser.id);

      if (result.shouldRefreshCookie) {
        reply.setCookie(AUTH_COOKIE_NAME, result.user.token, {
          path: '/',
          httpOnly: true,
          sameSite: 'lax',
          secure: deps.cookieIsSecure(request),
        });
      }

      return result;
    } catch (error) {
      reply.code(400);
      return { error: deps.errorMessage(error) };
    }
  });

  app.delete('/api/admin/users/:userId', async (request, reply) => {
    const currentUser = requireAdmin(request, reply, deps.getRequestUser);
    if (!currentUser) {
      return { error: 'Admin access required' };
    }

    try {
      const { userId } = request.params as { userId: string };
      return await deps.adminUserService.deleteUser(userId, currentUser.id);
    } catch (error) {
      reply.code(error instanceof AdminUserServiceError ? error.statusCode : 400);
      return { error: deps.errorMessage(error) };
    }
  });
}
