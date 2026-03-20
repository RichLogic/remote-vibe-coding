import { access } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { spawn, type ChildProcessByStdio, execFile as execFileCallback } from 'node:child_process';
import type { Readable } from 'node:stream';
import { promisify } from 'node:util';

import { WEB_DIST_DIR, cloudflareRuntimeConfig, localHostUrl } from './config.js';
import type { CloudflareStatus, CloudflareTunnelMode, CloudflareTargetSource } from './types.js';

const execFile = promisify(execFileCallback);
const DEV_WEB_URL = 'http://127.0.0.1:5173';
const QUICK_TUNNEL_URL_PATTERN = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/gi;

function createInitialStatus(): CloudflareStatus {
  return {
    installed: false,
    version: null,
    state: 'idle',
    mode: null,
    publicUrl: null,
    targetUrl: localHostUrl(),
    targetSource: 'host',
    startedAt: null,
    lastError: null,
    recentLogs: [],
  };
}

async function pathExists(path: string) {
  try {
    await access(path, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function isReachable(url: string) {
  try {
    const response = await fetch(url, {
      method: 'GET',
      signal: AbortSignal.timeout(1500),
    });
    return response.ok || response.status < 500;
  } catch {
    return false;
  }
}

function trimRecentLogs(lines: string[]) {
  return lines.slice(-10);
}

function parsePublicUrlFromLine(line: string) {
  return line.match(QUICK_TUNNEL_URL_PATTERN)?.[0] ?? null;
}

export class CloudflareTunnelManager {
  private status: CloudflareStatus = createInitialStatus();
  private process: ChildProcessByStdio<null, Readable, Readable> | null = null;
  private connectPromise: Promise<CloudflareStatus> | null = null;
  private disconnecting = false;

  async getStatus() {
    await this.refreshInstallation();
    if (!this.process) {
      const target = await this.resolveTarget();
      this.status.targetUrl = target.url;
      this.status.targetSource = target.source;
      if (this.status.state !== 'error') {
        this.status.mode = this.status.mode ?? (cloudflareRuntimeConfig().tunnelToken ? 'token' : null);
      }
    }
    return this.snapshot();
  }

  async connect() {
    if (this.process && this.status.state === 'connected') {
      return this.snapshot();
    }

    if (this.connectPromise) {
      return this.connectPromise;
    }

    this.connectPromise = this.connectInternal().finally(() => {
      this.connectPromise = null;
    });
    return this.connectPromise;
  }

  async disconnect() {
    if (!this.process) {
      this.status.state = 'idle';
      this.status.publicUrl = null;
      this.status.startedAt = null;
      this.status.lastError = null;
      return this.snapshot();
    }

    this.disconnecting = true;
    const child = this.process;

    const exited = new Promise<void>((resolve) => {
      child.once('exit', () => resolve());
    });

    child.kill('SIGTERM');
    await Promise.race([
      exited,
      new Promise((resolve) => setTimeout(resolve, 3000)),
    ]);

    if (this.process) {
      this.process.kill('SIGKILL');
      await exited.catch(() => undefined);
    }

    this.process = null;
    this.disconnecting = false;
    this.status = {
      ...this.status,
      state: 'idle',
      publicUrl: null,
      startedAt: null,
      lastError: null,
    };
    return this.snapshot();
  }

  private async connectInternal() {
    await this.refreshInstallation();
    if (!this.status.installed) {
      throw new Error('cloudflared is not installed on this machine');
    }

    const runtime = cloudflareRuntimeConfig();
    const target = await this.resolveTarget();
    const mode: CloudflareTunnelMode = runtime.tunnelToken ? 'token' : 'quick';

    this.status = {
      ...this.status,
      state: 'connecting',
      mode,
      publicUrl: mode === 'token' ? runtime.publicUrl : null,
      targetUrl: target.url,
      targetSource: target.source,
      startedAt: new Date().toISOString(),
      lastError: null,
      recentLogs: [],
    };

    const args = runtime.tunnelToken
      ? ['--no-autoupdate', 'tunnel', 'run', '--token', runtime.tunnelToken]
      : ['--no-autoupdate', 'tunnel', '--url', target.url];

    const child = spawn('cloudflared', args, {
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    this.process = child;
    this.disconnecting = false;

    const connectionReadyPattern = /Registered tunnel connection|Connection [a-z0-9-]+ registered/i;

    return new Promise<CloudflareStatus>((resolve, reject) => {
      let settled = false;

      const settle = (handler: () => void) => {
        if (settled) return;
        settled = true;
        handler();
      };

      const connectTimeout = setTimeout(() => {
        settle(() => {
          const error = new Error('Timed out while waiting for cloudflared to establish the tunnel');
          this.status.state = 'error';
          this.status.lastError = error.message;
          reject(error);
        });
      }, 20000);

      const markConnected = (publicUrl: string | null) => {
        clearTimeout(connectTimeout);
        this.status.state = 'connected';
        this.status.publicUrl = publicUrl;
        this.status.lastError = null;
        settle(() => resolve(this.snapshot()));
      };

      const handleLine = (rawLine: string) => {
        const line = rawLine.trim();
        if (!line) return;

        this.status.recentLogs = trimRecentLogs([...this.status.recentLogs, line]);

        if (mode === 'quick') {
          const publicUrl = parsePublicUrlFromLine(line);
          if (publicUrl) {
            markConnected(publicUrl);
          }
          return;
        }

        if (runtime.publicUrl && connectionReadyPattern.test(line)) {
          markConnected(runtime.publicUrl);
        }
      };

      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');

      this.attachLineReader(child.stdout, handleLine);
      this.attachLineReader(child.stderr, handleLine);

      child.once('error', (error) => {
        clearTimeout(connectTimeout);
        this.process = null;
        this.status.state = 'error';
        this.status.lastError = error.message;
        settle(() => reject(error));
      });

      child.once('exit', (code, signal) => {
        clearTimeout(connectTimeout);
        this.process = null;

        if (this.disconnecting) {
          return;
        }

        const message = `cloudflared exited before the tunnel was ready (code=${code ?? 'null'}, signal=${signal ?? 'null'})`;
        this.status.state = 'error';
        this.status.lastError = message;
        settle(() => reject(new Error(message)));
      });
    });
  }

  private attachLineReader(stream: NodeJS.ReadableStream, onLine: (line: string) => void) {
    let buffer = '';
    stream.on('data', (chunk: Buffer | string) => {
      buffer += chunk.toString();

      let newlineIndex = buffer.indexOf('\n');
      while (newlineIndex >= 0) {
        const line = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);
        onLine(line);
        newlineIndex = buffer.indexOf('\n');
      }
    });
  }

  private async refreshInstallation() {
    try {
      const { stdout, stderr } = await execFile('cloudflared', ['--version']);
      const combined = `${stdout}\n${stderr}`.trim();
      this.status.installed = true;
      this.status.version = combined.split('\n')[0] ?? null;
    } catch {
      this.status.installed = false;
      this.status.version = null;
    }
  }

  private async resolveTarget(): Promise<{ url: string; source: CloudflareTargetSource }> {
    const runtime = cloudflareRuntimeConfig();
    if (runtime.targetUrl) {
      return {
        url: runtime.targetUrl,
        source: 'override',
      };
    }

    const hasBuiltWeb = await pathExists(`${WEB_DIST_DIR}/index.html`);
    if (hasBuiltWeb) {
      return {
        url: localHostUrl(),
        source: 'host',
      };
    }

    if (await isReachable(DEV_WEB_URL)) {
      return {
        url: DEV_WEB_URL,
        source: 'dev-web',
      };
    }

    return {
      url: localHostUrl(),
      source: 'host',
    };
  }

  private snapshot(): CloudflareStatus {
    return {
      ...this.status,
      recentLogs: [...this.status.recentLogs],
    };
  }
}
