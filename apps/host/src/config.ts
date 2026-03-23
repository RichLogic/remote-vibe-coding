import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const DATA_DIR = join(homedir(), '.config', 'remote-vibe-coding');
export const SESSIONS_FILE = join(DATA_DIR, 'sessions.json');
export const SESSIONS_BACKUP_FILE = join(DATA_DIR, 'sessions.json.bak');
export const AUTH_FILE = join(DATA_DIR, 'auth.json');
export const AUTH_BACKUP_FILE = join(DATA_DIR, 'auth.json.bak');
export const WORKSPACE_ROOT = resolve(homedir(), 'Coding');
export const MONGODB_URL = process.env.MONGODB_URL?.trim() || 'mongodb://127.0.0.1:27017';
export const MONGODB_DB_NAME = process.env.MONGODB_DB_NAME?.trim() || 'remote_vibe_coding';
export const PORT = Number.parseInt(process.env.PORT ?? '8787', 10);
export const HOST = process.env.HOST ?? '127.0.0.1';

const HOST_APP_DIR = resolve(fileURLToPath(new URL('..', import.meta.url)));
export const WEB_DIST_DIR = resolve(HOST_APP_DIR, '../web/dist');
export const CHAT_SYSTEM_PROMPT_FILE = resolve(HOST_APP_DIR, 'chat-system-prompt.json');
export const CHAT_ROLE_PRESETS_FILE = resolve(HOST_APP_DIR, 'chat-role-presets.json');

function normalizeOptionalString(value: string | undefined) {
  const next = value?.trim();
  return next ? next : null;
}

export function localHostUrl() {
  return `http://127.0.0.1:${PORT}`;
}

export function cloudflareRuntimeConfig() {
  return {
    publicUrl: normalizeOptionalString(process.env.CLOUDFLARE_PUBLIC_URL),
    targetUrl: normalizeOptionalString(process.env.CLOUDFLARE_TARGET_URL),
    tunnelToken: normalizeOptionalString(process.env.CLOUDFLARE_TUNNEL_TOKEN),
  };
}

export async function ensureDataDir() {
  await mkdir(DATA_DIR, { recursive: true });
}

export async function ensureWorkspaceRoot() {
  await mkdir(WORKSPACE_ROOT, { recursive: true });
}
