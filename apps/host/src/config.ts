import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const DATA_DIR = join(homedir(), '.config', 'remote-vibe-coding');
export const SESSIONS_FILE = join(DATA_DIR, 'sessions.json');
export const AUTH_FILE = join(DATA_DIR, 'auth.json');
export const PORT = Number.parseInt(process.env.PORT ?? '8787', 10);
export const HOST = process.env.HOST ?? '127.0.0.1';

const HOST_APP_DIR = resolve(fileURLToPath(new URL('..', import.meta.url)));
export const WEB_DIST_DIR = resolve(HOST_APP_DIR, '../web/dist');

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
