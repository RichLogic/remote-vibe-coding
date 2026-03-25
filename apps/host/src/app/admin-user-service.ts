import type { CreateUserRequest, UpdateUserRequest, AdminUserRecord } from '../types.js';

export class AdminUserServiceError extends Error {
  constructor(message: string, readonly statusCode: number) {
    super(message);
    this.name = 'AdminUserServiceError';
  }
}

export interface AdminUserAuthStore {
  listUsers(): AdminUserRecord[];
  createUser(input: CreateUserRequest): Promise<AdminUserRecord>;
  updateUser(userId: string, input: UpdateUserRequest): Promise<AdminUserRecord>;
  deleteUser(userId: string, actingUserId: string): Promise<AdminUserRecord[]>;
}

export interface AdminUserSessionStore {
  listConversationsForUser(userId: string): unknown[];
  updateOwnerUsername(userId: string, ownerUsername: string): Promise<unknown>;
}

export interface AdminUserConversationRepository {
  listConversationRecordsForUser(userId: string): Promise<unknown[]>;
  updateOwnerUsername(userId: string, ownerUsername: string): Promise<unknown>;
}

export interface AdminUserCodingRepository {
  countSessionsForUser(userId: string): Promise<number>;
  updateOwnerUsername(userId: string, ownerUsername: string): Promise<unknown>;
}

export class AdminUserService {
  constructor(
    private readonly auth: AdminUserAuthStore,
    private readonly sessions: AdminUserSessionStore,
    private readonly conversations: AdminUserConversationRepository,
    private readonly coding: AdminUserCodingRepository,
  ) {}

  listUsers() {
    return this.auth.listUsers();
  }

  async createUser(input: CreateUserRequest) {
    const user = await this.auth.createUser(input);
    return {
      user,
      users: this.auth.listUsers(),
    };
  }

  async updateUser(userId: string, input: UpdateUserRequest, actingUserId: string) {
    const previousUser = this.auth.listUsers().find((entry) => entry.id === userId) ?? null;
    const user = await this.auth.updateUser(userId, input);

    if (previousUser && previousUser.username !== user.username) {
      await this.sessions.updateOwnerUsername(userId, user.username);
      await this.conversations.updateOwnerUsername(userId, user.username);
      await this.coding.updateOwnerUsername(userId, user.username);
    }

    return {
      user,
      users: this.auth.listUsers(),
      shouldRefreshCookie: actingUserId === userId && previousUser?.token !== user.token,
    };
  }

  async deleteUser(userId: string, actingUserId: string) {
    const chatConversations = await this.conversations.listConversationRecordsForUser(userId);
    if (
      await this.coding.countSessionsForUser(userId) > 0
      || this.sessions.listConversationsForUser(userId).length > 0
      || chatConversations.length > 0
    ) {
      throw new AdminUserServiceError(
        'Delete this user’s conversations and sessions before removing the user.',
        409,
      );
    }

    const users = await this.auth.deleteUser(userId, actingUserId);
    return { users };
  }
}
