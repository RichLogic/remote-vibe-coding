import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const DATA_DIR = join(homedir(), '.config', 'remote-vibe-coding');
export const SESSIONS_FILE = join(DATA_DIR, 'sessions.json');

export async function ensureDataDir() {
  await mkdir(DATA_DIR, { recursive: true });
}
