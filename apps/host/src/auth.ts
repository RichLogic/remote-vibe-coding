import { randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';
import { chmod, readFile, writeFile } from 'node:fs/promises';

import { AUTH_FILE, ensureDataDir } from './config.js';
import type {
  AdminUserRecord,
  CreateUserRequest,
  SessionType,
  UpdateUserRequest,
  UserRecord,
} from './types.js';

export const AUTH_COOKIE_NAME = 'rvc_session';

interface AuthFileUser extends UserRecord {
  passwordHash: string;
  token: string;
}

interface AuthFile {
  version: 2;
  createdAt: string;
  updatedAt: string;
  users: AuthFileUser[];
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

function normalizedSessionTypes(sessionTypes: SessionType[] | undefined, fallback: SessionType[]) {
  const allowed = Array.from(new Set((sessionTypes ?? fallback).filter((entry): entry is SessionType => entry === 'code' || entry === 'chat')));
  return allowed.length > 0 ? allowed : fallback;
}

function sanitizeUser(user: AuthFileUser): UserRecord {
  return {
    id: user.id,
    username: user.username,
    isAdmin: user.isAdmin,
    allowedSessionTypes: [...user.allowedSessionTypes],
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

async function persistAuth(auth: AuthFile) {
  await writeFile(AUTH_FILE, `${JSON.stringify(auth, null, 2)}\n`, {
    mode: 0o600,
  });
  await chmod(AUTH_FILE, 0o600);
}

function createAdminUser(username: string, password: string, createdAt: string): AuthFileUser {
  return {
    id: randomUUID(),
    username,
    passwordHash: hashPassword(password),
    token: randomSecret(32),
    isAdmin: true,
    allowedSessionTypes: ['code', 'chat'],
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
  if (!users.some((entry) => entry.isAdmin)) {
    throw new Error('At least one admin user is required');
  }
}

export async function loadOrCreateAuthState() {
  await ensureDataDir();

  try {
    const content = await readFile(AUTH_FILE, 'utf8');
    const parsed = JSON.parse(content) as AuthFile | LegacyOwnerAuthConfig;

    if ('version' in parsed && parsed.version === 2 && Array.isArray(parsed.users)) {
      return {
        ...parsed,
        users: parsed.users.map((user) => ({
          ...user,
          allowedSessionTypes: normalizedSessionTypes(user.allowedSessionTypes, ['chat']),
          canUseFullHost: Boolean(user.canUseFullHost),
          isAdmin: Boolean(user.isAdmin),
        })),
      } satisfies AuthFile;
    }

    const legacy = parsed as LegacyOwnerAuthConfig;
    const createdAt = legacy.createdAt ?? new Date().toISOString();
    const password = legacy.passwordHash ? null : legacy.password;
    const migratedUser: AuthFileUser = {
      id: randomUUID(),
      username: legacy.username,
      passwordHash: legacy.passwordHash ?? hashPassword(password ?? randomSecret(18)),
      token: legacy.token,
      isAdmin: true,
      allowedSessionTypes: ['code', 'chat'],
      canUseFullHost: true,
      createdAt,
      updatedAt: createdAt,
    };
    const migrated: AuthFile = {
      version: 2,
      createdAt,
      updatedAt: new Date().toISOString(),
      users: [migratedUser],
    };
    await persistAuth(migrated);
    return migrated;
  } catch {
    const envUsername = process.env.RVC_AUTH_USERNAME?.trim();
    const envPassword = process.env.RVC_AUTH_PASSWORD?.trim();
    const createdAt = new Date().toISOString();
    const seedUser = envUsername && envPassword
      ? createAdminUser(envUsername, envPassword, createdAt)
      : createAdminUser('owner', randomSecret(18), createdAt);

    const auth: AuthFile = {
      version: 2,
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
  const user: AuthFileUser = {
    id: randomUUID(),
    username,
    passwordHash: hashPassword(password ?? randomSecret(18)),
    token: randomSecret(32),
    isAdmin: Boolean(input.isAdmin),
    allowedSessionTypes: normalizedSessionTypes(input.allowedSessionTypes, ['chat']),
    canUseFullHost: Boolean(input.canUseFullHost),
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
  const nextUser: AuthFileUser = {
    ...current,
    username,
    isAdmin: input.isAdmin ?? current.isAdmin,
    allowedSessionTypes: input.allowedSessionTypes
      ? normalizedSessionTypes(input.allowedSessionTypes, current.allowedSessionTypes)
      : current.allowedSessionTypes,
    canUseFullHost: input.canUseFullHost ?? current.canUseFullHost,
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
