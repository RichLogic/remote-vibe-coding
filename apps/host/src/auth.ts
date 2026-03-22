import { randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';
import { chmod, readFile, rename, writeFile } from 'node:fs/promises';

import { AUTH_BACKUP_FILE, AUTH_FILE, ensureDataDir } from './config.js';
import type {
  AppMode,
  AdminUserRecord,
  CreateUserRequest,
  SessionType,
  UserRole,
  UpdateUserRequest,
  UserRecord,
} from './types.js';

export const AUTH_COOKIE_NAME = 'rvc_session';

interface AuthFileUser {
  id: string;
  username: string;
  roles: UserRole[];
  preferredMode: AppMode | null;
  canUseFullHost: boolean;
  createdAt: string;
  updatedAt: string;
  passwordHash: string;
  token: string;
}

interface AuthFile {
  version: 3;
  createdAt: string;
  updatedAt: string;
  users: AuthFileUser[];
}

interface LegacyAuthFileUserV2 {
  id: string;
  username: string;
  isAdmin: boolean;
  allowedSessionTypes: SessionType[];
  canUseFullHost: boolean;
  createdAt: string;
  updatedAt: string;
  passwordHash: string;
  token: string;
}

interface LegacyAuthFileV2 {
  version: 2;
  createdAt: string;
  updatedAt: string;
  users: LegacyAuthFileUserV2[];
}

interface LegacyOwnerAuthConfig {
  username: string;
  password?: string;
  passwordHash?: string;
  token: string;
  createdAt: string;
}

function randomSecret(bytes = 24) {
  return randomBytes(bytes).toString('base64url');
}

function safeEqual(left: string, right: string) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);

  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }

  return timingSafeEqual(leftBuffer, rightBuffer);
}

export function hashPassword(password: string) {
  const salt = randomSecret(16);
  const hash = scryptSync(password, salt, 64).toString('base64url');
  return `scrypt:${salt}:${hash}`;
}

function verifyPasswordHash(password: string, passwordHash: string) {
  const [scheme, salt, expectedHash] = passwordHash.split(':');
  if (scheme !== 'scrypt' || !salt || !expectedHash) {
    return false;
  }

  const actualHash = scryptSync(password, salt, 64).toString('base64url');
  return safeEqual(actualHash, expectedHash);
}

function orderedRoles(roles: Iterable<UserRole>) {
  const priority: UserRole[] = ['user', 'developer', 'admin'];
  const roleSet = new Set(roles);
  return priority.filter((role) => roleSet.has(role));
}

function allowedSessionTypesFromRoles(roles: UserRole[]) {
  const allowed: SessionType[] = [];
  if (roles.includes('developer')) {
    allowed.push('code');
  }
  if (roles.includes('user')) {
    allowed.push('chat');
  }
  return allowed;
}

function deriveDefaultMode(roles: UserRole[]): AppMode {
  return roles.includes('developer') ? 'developer' : 'chat';
}

function normalizePreferredMode(preferredMode: AppMode | null | undefined, roles: UserRole[]) {
  const allowedModes = new Set<AppMode>([
    ...(roles.includes('user') ? (['chat'] as const) : []),
    ...(roles.includes('developer') ? (['developer'] as const) : []),
  ]);
  if (allowedModes.size === 0) {
    return 'chat' as const;
  }
  if (preferredMode && allowedModes.has(preferredMode)) {
    return preferredMode;
  }
  return deriveDefaultMode(roles);
}

function normalizedRoles(roles: UserRole[] | undefined, fallback: UserRole[]) {
  const filtered = orderedRoles((roles ?? fallback).filter((entry): entry is UserRole => (
    entry === 'user' || entry === 'developer' || entry === 'admin'
  )));
  if (!filtered.includes('user') && !filtered.includes('developer')) {
    return orderedRoles(['user', ...filtered]);
  }
  return filtered.length > 0 ? filtered : orderedRoles(fallback);
}

function rolesFromLegacy(user: Pick<LegacyAuthFileUserV2, 'allowedSessionTypes' | 'isAdmin'>) {
  const roles: UserRole[] = [];
  const allowedSessionTypes = Array.from(new Set((user.allowedSessionTypes ?? []).filter((entry): entry is SessionType => entry === 'code' || entry === 'chat')));
  if (allowedSessionTypes.includes('chat')) {
    roles.push('user');
  }
  if (allowedSessionTypes.includes('code')) {
    roles.push('developer');
  }
  if (user.isAdmin) {
    roles.push('admin');
  }
  return normalizedRoles(roles, ['user']);
}

function resolveRolesFromInput(
  input: Pick<CreateUserRequest | UpdateUserRequest, 'roles' | 'allowedSessionTypes' | 'isAdmin'>,
  fallback: UserRole[],
) {
  if (Array.isArray(input.roles)) {
    return normalizedRoles(input.roles, fallback);
  }
  const legacyRoles = rolesFromLegacy({
    allowedSessionTypes: input.allowedSessionTypes ?? allowedSessionTypesFromRoles(fallback),
    isAdmin: Boolean(input.isAdmin ?? fallback.includes('admin')),
  });
  return normalizedRoles(legacyRoles, fallback);
}

function sanitizeUser(user: AuthFileUser): UserRecord {
  const roles = normalizedRoles(user.roles, ['user']);
  return {
    id: user.id,
    username: user.username,
    roles,
    preferredMode: normalizePreferredMode(user.preferredMode, roles),
    isAdmin: roles.includes('admin'),
    allowedSessionTypes: allowedSessionTypesFromRoles(roles),
    canUseFullHost: user.canUseFullHost,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
  };
}

function sanitizeAdminUser(user: AuthFileUser): AdminUserRecord {
  return {
    ...sanitizeUser(user),
    token: user.token,
  };
}

function isMissingFileError(error: unknown): error is NodeJS.ErrnoException {
  return Boolean(error && typeof error === 'object' && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT');
}

function formatPersistenceError(context: string, filePath: string, error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return new Error(`Failed to load ${context} from ${filePath}: ${message}`);
}

async function loadPersistedAuthFile<T>(primaryPath: string, backupPath: string, context: string): Promise<T | null> {
  let primaryError: Error | null = null;

  try {
    return JSON.parse(await readFile(primaryPath, 'utf8')) as T;
  } catch (error) {
    if (!isMissingFileError(error)) {
      primaryError = formatPersistenceError(context, primaryPath, error);
    }
  }

  try {
    return JSON.parse(await readFile(backupPath, 'utf8')) as T;
  } catch (error) {
    if (isMissingFileError(error)) {
      if (primaryError) {
        throw primaryError;
      }
      return null;
    }
    throw formatPersistenceError(context, backupPath, error);
  }
}

async function writePersistedAuthFile(primaryPath: string, backupPath: string, content: string, mode: number) {
  const tempPath = `${primaryPath}.${process.pid}.${Date.now()}.tmp`;
  const previousContent = await readFile(primaryPath, 'utf8').catch((error: unknown) => {
    if (isMissingFileError(error)) {
      return null;
    }
    throw error;
  });

  await writeFile(tempPath, content, { mode });
  if (previousContent !== null) {
    await writeFile(backupPath, previousContent, { mode });
    await chmod(backupPath, mode);
  }
  await rename(tempPath, primaryPath);
  await chmod(primaryPath, mode);
}

async function persistAuth(auth: AuthFile) {
  await writePersistedAuthFile(
    AUTH_FILE,
    AUTH_BACKUP_FILE,
    `${JSON.stringify(auth, null, 2)}\n`,
    0o600,
  );
}

function createAdminUser(username: string, password: string, createdAt: string): AuthFileUser {
  return {
    id: randomUUID(),
    username,
    passwordHash: hashPassword(password),
    token: randomSecret(32),
    roles: ['user', 'developer', 'admin'],
    preferredMode: 'developer',
    canUseFullHost: true,
    createdAt,
    updatedAt: createdAt,
  };
}

function validateUsername(username: string) {
  const next = username.trim();
  if (!next) {
    throw new Error('Username is required');
  }
  if (next.length < 3) {
    throw new Error('Username must be at least 3 characters');
  }
  return next;
}

function validatePassword(password: string | undefined, required: boolean) {
  const next = password?.trim() ?? '';
  if (!next && !required) {
    return null;
  }
  if (next.length < 8) {
    throw new Error('Password must be at least 8 characters');
  }
  return next;
}

function ensureUniqueUsername(auth: AuthFile, username: string, ignoreUserId?: string) {
  const conflict = auth.users.find((entry) => entry.id !== ignoreUserId && entry.username.toLowerCase() === username.toLowerCase());
  if (conflict) {
    throw new Error(`Username "${username}" already exists`);
  }
}

function ensureAdminInvariant(users: AuthFileUser[]) {
  if (!users.some((entry) => entry.roles.includes('admin'))) {
    throw new Error('At least one admin user is required');
  }
}

export async function loadOrCreateAuthState() {
  await ensureDataDir();
  const parsed = await loadPersistedAuthFile<AuthFile | LegacyAuthFileV2 | LegacyOwnerAuthConfig>(
    AUTH_FILE,
    AUTH_BACKUP_FILE,
    'auth state',
  );

  if (parsed) {
    if ('version' in parsed && parsed.version === 3 && Array.isArray(parsed.users)) {
      return {
        ...parsed,
        users: parsed.users.map((user) => ({
          ...user,
          roles: normalizedRoles(user.roles, ['user']),
          preferredMode: normalizePreferredMode(user.preferredMode, normalizedRoles(user.roles, ['user'])),
          canUseFullHost: Boolean(user.canUseFullHost),
        })),
      } satisfies AuthFile;
    }

    if ('version' in parsed && parsed.version === 2 && Array.isArray(parsed.users)) {
      const migrated: AuthFile = {
        version: 3,
        createdAt: parsed.createdAt,
        updatedAt: new Date().toISOString(),
        users: parsed.users.map((user) => {
          const roles = rolesFromLegacy(user);
          return {
            id: user.id,
            username: user.username,
            roles,
            preferredMode: normalizePreferredMode(null, roles),
            canUseFullHost: Boolean(user.canUseFullHost) && roles.includes('developer'),
            createdAt: user.createdAt,
            updatedAt: user.updatedAt,
            passwordHash: user.passwordHash,
            token: user.token,
          };
        }),
      };
      await persistAuth(migrated);
      return migrated;
    }

    const legacy = parsed as LegacyOwnerAuthConfig;
    const createdAt = legacy.createdAt ?? new Date().toISOString();
    const password = legacy.passwordHash ? null : legacy.password;
    const migratedUser: AuthFileUser = {
      id: randomUUID(),
      username: legacy.username,
      passwordHash: legacy.passwordHash ?? hashPassword(password ?? randomSecret(18)),
      token: legacy.token,
      roles: ['user', 'developer', 'admin'],
      preferredMode: 'developer',
      canUseFullHost: true,
      createdAt,
      updatedAt: createdAt,
    };
    const migrated: AuthFile = {
      version: 3,
      createdAt,
      updatedAt: new Date().toISOString(),
      users: [migratedUser],
    };
    await persistAuth(migrated);
    return migrated;
  }

  const envUsername = process.env.RVC_AUTH_USERNAME?.trim();
  const envPassword = process.env.RVC_AUTH_PASSWORD?.trim();
  const createdAt = new Date().toISOString();
  const seedUser = envUsername && envPassword
    ? createAdminUser(envUsername, envPassword, createdAt)
    : createAdminUser('owner', randomSecret(18), createdAt);

  const auth: AuthFile = {
    version: 3,
    createdAt,
    updatedAt: createdAt,
    users: [
      {
        ...seedUser,
        token: process.env.RVC_AUTH_TOKEN?.trim() || seedUser.token,
      },
    ],
  };

  await persistAuth(auth);
  return auth;
}

export function getPublicUsers(auth: AuthFile) {
  return auth.users.map(sanitizeAdminUser).sort((left, right) => left.username.localeCompare(right.username));
}

export function findUserByToken(auth: AuthFile, token: string | null | undefined) {
  if (!token) return null;
  return auth.users.find((entry) => safeEqual(entry.token, token)) ?? null;
}

export function verifyPassword(auth: AuthFile, username: string, password: string) {
  const normalizedUsername = username.trim().toLowerCase();
  const user = auth.users.find((entry) => entry.username.toLowerCase() === normalizedUsername);
  if (!user) return null;
  return verifyPasswordHash(password, user.passwordHash) ? user : null;
}

export async function createUser(auth: AuthFile, input: CreateUserRequest) {
  const username = validateUsername(input.username);
  ensureUniqueUsername(auth, username);
  const password = validatePassword(input.password, true);
  const createdAt = new Date().toISOString();
  const roles = resolveRolesFromInput(input, ['user']);
  const user: AuthFileUser = {
    id: randomUUID(),
    username,
    passwordHash: hashPassword(password ?? randomSecret(18)),
    token: randomSecret(32),
    roles,
    preferredMode: normalizePreferredMode(input.preferredMode, roles),
    canUseFullHost: Boolean(input.canUseFullHost) && roles.includes('developer'),
    createdAt,
    updatedAt: createdAt,
  };
  const next: AuthFile = {
    ...auth,
    users: [...auth.users, user],
    updatedAt: createdAt,
  };
  ensureAdminInvariant(next.users);
  await persistAuth(next);
  return {
    auth: next,
    user: sanitizeAdminUser(user),
  };
}

export async function updateUser(auth: AuthFile, userId: string, input: UpdateUserRequest) {
  const current = auth.users.find((entry) => entry.id === userId);
  if (!current) {
    throw new Error('User not found');
  }

  const username = input.username !== undefined ? validateUsername(input.username) : current.username;
  ensureUniqueUsername(auth, username, userId);

  const password = validatePassword(input.password, false);
  const updatedAt = new Date().toISOString();
  const roles = resolveRolesFromInput(input, current.roles);
  const nextUser: AuthFileUser = {
    ...current,
    username,
    roles,
    preferredMode: Object.prototype.hasOwnProperty.call(input, 'preferredMode')
      ? normalizePreferredMode(input.preferredMode ?? null, roles)
      : normalizePreferredMode(current.preferredMode, roles),
    canUseFullHost: (input.canUseFullHost ?? current.canUseFullHost) && roles.includes('developer'),
    passwordHash: password ? hashPassword(password) : current.passwordHash,
    token: input.regenerateToken ? randomSecret(32) : current.token,
    updatedAt,
  };

  const nextUsers = auth.users.map((entry) => (entry.id === userId ? nextUser : entry));
  ensureAdminInvariant(nextUsers);

  const next: AuthFile = {
    ...auth,
    users: nextUsers,
    updatedAt,
  };
  await persistAuth(next);
  return {
    auth: next,
    user: sanitizeAdminUser(nextUser),
  };
}

export async function deleteUser(auth: AuthFile, userId: string, actingUserId: string) {
  if (userId === actingUserId) {
    throw new Error('You cannot delete the current user');
  }

  const nextUsers = auth.users.filter((entry) => entry.id !== userId);
  if (nextUsers.length === auth.users.length) {
    throw new Error('User not found');
  }
  ensureAdminInvariant(nextUsers);

  const next: AuthFile = {
    ...auth,
    users: nextUsers,
    updatedAt: new Date().toISOString(),
  };
  await persistAuth(next);
  return next;
}

export function toUserRecord(user: AuthFileUser) {
  return sanitizeUser(user);
}

export function loginPageHtml() {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>remote-vibe-coding login</title>
    <style>
      :root {
        color-scheme: light;
        --bg: #f6f1e7;
        --surface: rgba(252, 248, 240, 0.92);
        --surface-strong: #fffaf0;
        --ink: #1e1b17;
        --muted: #5b554d;
        --line: rgba(43, 36, 30, 0.12);
        --accent: #0f766e;
        --radius-lg: 24px;
        --radius-md: 18px;
        --shadow: 0 18px 60px rgba(48, 39, 30, 0.12);
        font-family: "IBM Plex Sans", "Avenir Next", "Segoe UI", sans-serif;
      }

      * { box-sizing: border-box; }

      body {
        margin: 0;
        min-height: 100vh;
        display: grid;
        place-items: center;
        padding: 20px;
        color: var(--ink);
        background:
          radial-gradient(circle at top left, rgba(15, 118, 110, 0.16), transparent 30%),
          radial-gradient(circle at top right, rgba(180, 83, 9, 0.12), transparent 26%),
          linear-gradient(180deg, #f2ece1 0%, #f8f4ed 100%);
      }

      .card {
        width: min(420px, 100%);
        border: 1px solid var(--line);
        border-radius: var(--radius-lg);
        background: var(--surface);
        box-shadow: var(--shadow);
        padding: 28px;
      }

      .eyebrow {
        margin: 0 0 8px;
        text-transform: uppercase;
        letter-spacing: 0.18em;
        font-size: 0.73rem;
        color: var(--muted);
      }

      h1 {
        margin: 0 0 12px;
        font-size: 2rem;
        letter-spacing: -0.03em;
      }

      p {
        margin: 0 0 18px;
        color: var(--muted);
      }

      form {
        display: grid;
        gap: 12px;
      }

      label {
        display: grid;
        gap: 8px;
      }

      span {
        font-size: 0.88rem;
        color: var(--muted);
      }

      input {
        width: 100%;
        border: 1px solid var(--line);
        border-radius: 16px;
        padding: 12px 14px;
        background: rgba(255, 250, 240, 0.95);
        color: var(--ink);
        font: inherit;
      }

      button {
        border: 0;
        border-radius: 999px;
        padding: 12px 16px;
        background: var(--ink);
        color: #fff8ef;
        font: inherit;
        cursor: pointer;
      }

      .error {
        min-height: 1.4em;
        color: #b91c1c;
        font-size: 0.92rem;
      }

      .hint {
        margin-top: 18px;
        font-size: 0.88rem;
      }
    </style>
  </head>
  <body>
    <main class="card">
      <p class="eyebrow">Secure sign-in</p>
      <h1>remote-vibe-coding</h1>
      <p>Use your username and password. A personal token link still works as a fallback.</p>
      <form id="login-form">
        <label>
          <span>Username</span>
          <input name="username" autocomplete="username" required />
        </label>
        <label>
          <span>Password</span>
          <input name="password" type="password" autocomplete="current-password" required />
        </label>
        <button type="submit">Sign in</button>
      </form>
      <p class="error" id="error"></p>
      <p class="hint">Token fallback still works via <code>?token=...</code> on the URL.</p>
    </main>

    <script>
      const form = document.getElementById('login-form');
      const error = document.getElementById('error');

      form.addEventListener('submit', async (event) => {
        event.preventDefault();
        error.textContent = '';
        const data = new FormData(form);

        const response = await fetch('/api/auth/login', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            username: String(data.get('username') || ''),
            password: String(data.get('password') || ''),
          }),
        });

        if (!response.ok) {
          const body = await response.json().catch(() => ({}));
          error.textContent = body.error || 'Sign-in failed';
          return;
        }

        window.location.href = '/';
      });
    </script>
  </body>
</html>`;
}
