import {
  createUser,
  deleteUser,
  findUserByToken,
  getPublicUsers,
  loadOrCreateAuthState,
  toUserRecord,
  updateUser,
  verifyPassword,
} from '../auth.js';
import type { CreateUserRequest, UpdateUserRequest, AdminUserRecord, UserRecord } from '../types.js';

export type LoadedAuthState = Awaited<ReturnType<typeof loadOrCreateAuthState>>;

export interface AuthenticatedUserSession {
  token: string;
  user: UserRecord;
}

export class HostAuthState {
  private constructor(private state: LoadedAuthState) {}

  static async load() {
    return new HostAuthState(await loadOrCreateAuthState());
  }

  static fromState(state: LoadedAuthState) {
    return new HostAuthState(state);
  }

  listUsers(): AdminUserRecord[] {
    return getPublicUsers(this.state);
  }

  fallbackOwner(): AdminUserRecord {
    const users = this.listUsers();
    const owner = users.find((entry) => entry.isAdmin) ?? users[0];
    if (!owner) {
      throw new Error('No users are configured.');
    }
    return owner;
  }

  findUserSessionByToken(token: string | null | undefined): AuthenticatedUserSession | null {
    const user = findUserByToken(this.state, token);
    if (!user) {
      return null;
    }
    return {
      token: user.token,
      user: toUserRecord(user),
    };
  }

  verifyCredentials(username: string, password: string): AuthenticatedUserSession | null {
    const user = verifyPassword(this.state, username, password);
    if (!user) {
      return null;
    }
    return {
      token: user.token,
      user: toUserRecord(user),
    };
  }

  devBypassUser(enabled: boolean): UserRecord | null {
    if (!enabled) {
      return null;
    }

    const user = this.state.users.find((entry) => entry.roles.includes('admin')) ?? this.state.users[0] ?? null;
    return user ? toUserRecord(user) : null;
  }

  async createUser(input: CreateUserRequest) {
    const result = await createUser(this.state, input);
    this.state = result.auth;
    return result.user;
  }

  async updateUser(userId: string, input: UpdateUserRequest) {
    const result = await updateUser(this.state, userId, input);
    this.state = result.auth;
    return result.user;
  }

  async deleteUser(userId: string, actingUserId: string) {
    this.state = await deleteUser(this.state, userId, actingUserId);
    return this.listUsers();
  }
}
