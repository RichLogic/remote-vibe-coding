import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { chmod, readFile, writeFile } from 'node:fs/promises';

import { AUTH_FILE, ensureDataDir } from './config.js';

export const AUTH_COOKIE_NAME = 'rvc_owner';

export interface OwnerAuthConfig {
  username: string;
  passwordHash: string;
  token: string;
  createdAt: string;
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

function hashPassword(password: string) {
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

async function persistAuth(auth: OwnerAuthConfig) {
  await writeFile(AUTH_FILE, `${JSON.stringify(auth, null, 2)}\n`, {
    mode: 0o600,
  });
  await chmod(AUTH_FILE, 0o600);
}

export async function loadOrCreateOwnerAuth() {
  await ensureDataDir();

  const envUsername = process.env.RVC_AUTH_USERNAME?.trim();
  const envPassword = process.env.RVC_AUTH_PASSWORD?.trim();
  const envToken = process.env.RVC_AUTH_TOKEN?.trim();

  if (envUsername && envPassword && envToken) {
    return {
      username: envUsername,
      passwordHash: hashPassword(envPassword),
      token: envToken,
      createdAt: 'environment',
    } satisfies OwnerAuthConfig;
  }

  try {
    const content = await readFile(AUTH_FILE, 'utf8');
    const parsed = JSON.parse(content) as LegacyOwnerAuthConfig;

    if (parsed.passwordHash) {
      return {
        username: parsed.username,
        passwordHash: parsed.passwordHash,
        token: parsed.token,
        createdAt: parsed.createdAt,
      } satisfies OwnerAuthConfig;
    }

    if (parsed.password) {
      const migrated: OwnerAuthConfig = {
        username: parsed.username,
        passwordHash: hashPassword(parsed.password),
        token: parsed.token,
        createdAt: parsed.createdAt,
      };
      await persistAuth(migrated);
      return migrated;
    }

    throw new Error('Auth config is missing a password hash');
  } catch {
    const generatedPassword = randomSecret(18);
    const auth: OwnerAuthConfig = {
      username: 'owner',
      passwordHash: hashPassword(generatedPassword),
      token: randomSecret(32),
      createdAt: new Date().toISOString(),
    };

    await persistAuth(auth);
    return auth;
  }
}

export function verifyPassword(auth: OwnerAuthConfig, username: string, password: string) {
  return safeEqual(auth.username, username) && verifyPasswordHash(password, auth.passwordHash);
}

export function verifyToken(auth: OwnerAuthConfig, token: string | null | undefined) {
  if (!token) return false;
  return safeEqual(auth.token, token);
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
      <p class="eyebrow">Owner login</p>
      <h1>remote-vibe-coding</h1>
      <p>Password login is enabled. A token link still works as a fallback.</p>
      <form id="login-form">
        <label>
          <span>Username</span>
          <input name="username" autocomplete="username" value="owner" required />
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

        const formData = new FormData(form);
        const payload = {
          username: String(formData.get('username') || ''),
          password: String(formData.get('password') || ''),
        };

        const response = await fetch('/api/auth/login', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(payload),
        });

        if (response.ok) {
          window.location.href = '/';
          return;
        }

        const body = await response.json().catch(() => null);
        error.textContent = body?.error || 'Login failed';
      });
    </script>
  </body>
</html>`;
}
