import { access, readFile } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { spawn, type ChildProcessByStdio, execFile as execFileCallback } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import { promisify } from 'node:util';

import { WEB_DIST_DIR, cloudflareRuntimeConfig, localHostUrl } from './config.js';
import type { CloudflareStatus, CloudflareTunnelMode, CloudflareTargetSource } from './types.js';

const execFile = promisify(execFileCallback);
const DEV_WEB_URL = 'http://127.0.0.1:5173';
const QUICK_TUNNEL_URL_PATTERN = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/gi;
const CLOUDFLARED_CONFIG_PATH = join(homedir(), '.cloudflared', 'config.yml');

interface ParsedIngressEntry {
  hostname: string | null;
  service: string | null;
}

interface NamedTunnelConfig {
  configPath: string;
  publicUrl: string;
  service: string;
  tunnelName: string;
}

interface TunnelInfoResponse {
  conns?: Array<{
    conns?: Array<unknown>;
  }>;
}

function createInitialStatus(): CloudflareStatus {
  return {
    installed: false,
    version: null,
    state: 'idle',
    mode: null,
    tunnelName: null,
    publicUrl: null,
    targetUrl: localHostUrl(),
    targetSource: 'host',
    connectorCount: 0,
    activeSource: null,
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

function parseCloudflaredConfig(content: string) {
  const entries: ParsedIngressEntry[] = [];
  let tunnelName: string | null = null;
  let current: ParsedIngressEntry | null = null;

  for (const line of content.split(/\r?\n/)) {
    const tunnelMatch = line.match(/^\s*tunnel:\s*(\S+)/);
    if (tunnelMatch && !tunnelName) {
      tunnelName = tunnelMatch[1]?.trim() ?? null;
      continue;
    }

    const hostnameMatch = line.match(/^\s*-\s*hostname:\s*(\S+)/);
    if (hostnameMatch) {
      current = {
        hostname: hostnameMatch[1]?.trim() ?? null,
        service: null,
      };
      entries.push(current);
      continue;
    }

    const serviceMatch = line.match(/^\s*service:\s*(\S+)/);
    if (serviceMatch && current && !current.service) {
      current.service = serviceMatch[1]?.trim() ?? null;
    }
  }

  return {
    tunnelName,
    entries,
  };
}

function serviceTargetsTargetUrl(service: string | null, targetUrl: string) {
  if (!service) return false;

  try {
    const serviceUrl = new URL(service);
    const target = new URL(targetUrl);
    const normalizedServicePort = serviceUrl.port || (serviceUrl.protocol === 'https:' ? '443' : '80');
    const normalizedTargetPort = target.port || (target.protocol === 'https:' ? '443' : '80');

    return serviceUrl.protocol === target.protocol && normalizedServicePort === normalizedTargetPort;
  } catch {
    return false;
  }
}

export class CloudflareTunnelManager {
  private status: CloudflareStatus = createInitialStatus();
  private process: ChildProcessByStdio<null, Readable, Readable> | null = null;
  private connectPromise: Promise<CloudflareStatus> | null = null;
  private disconnecting = false;

  async getStatus() {
    await this.refreshInstallation();
    const target = await this.resolveTarget();
    const namedTunnel = await this.resolveNamedTunnel(target.url);
    const runtime = cloudflareRuntimeConfig();
    this.status.targetUrl = target.url;
    this.status.targetSource = target.source;

    if (!this.process && this.status.state !== 'error') {
      if (runtime.tunnelToken) {
        this.status.mode = 'token';
        this.status.publicUrl = runtime.publicUrl;
        this.status.tunnelName = null;
      } else if (namedTunnel) {
        this.status.mode = 'named';
        this.status.publicUrl = namedTunnel.publicUrl;
        this.status.tunnelName = namedTunnel.tunnelName;
      } else {
        this.status.mode = null;
        this.status.publicUrl = null;
        this.status.tunnelName = null;
      }
    }

    if (namedTunnel) {
      const tunnelInfo = await this.readTunnelInfo(namedTunnel.tunnelName);
      const connectorCount = tunnelInfo?.conns?.reduce((count, connector) => count + (connector.conns?.length ?? 0), 0) ?? 0;
      this.status.connectorCount = connectorCount;

      if (!this.process) {
        this.status.activeSource = connectorCount > 0 ? 'system' : null;
        if (this.status.state !== 'error') {
          this.status.state = connectorCount > 0 ? 'connected' : 'idle';
        }
      } else {
        this.status.activeSource = 'local-manager';
      }
    } else if (!this.process) {
      this.status.connectorCount = 0;
      this.status.activeSource = null;
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
    const namedTunnel = runtime.tunnelToken ? null : await this.resolveNamedTunnel(target.url);
    const mode: CloudflareTunnelMode = runtime.tunnelToken ? 'token' : namedTunnel ? 'named' : 'quick';
    const stablePublicUrl = runtime.tunnelToken ? runtime.publicUrl : namedTunnel?.publicUrl ?? null;

    this.status = {
      ...this.status,
      state: 'connecting',
      mode,
      tunnelName: namedTunnel?.tunnelName ?? null,
      publicUrl: stablePublicUrl,
      targetUrl: target.url,
      targetSource: target.source,
      connectorCount: 0,
      activeSource: mode === 'named' ? 'local-manager' : null,
      startedAt: new Date().toISOString(),
      lastError: null,
      recentLogs: [],
    };

    const args = runtime.tunnelToken
      ? ['--no-autoupdate', 'tunnel', 'run', '--token', runtime.tunnelToken]
      : namedTunnel
        ? ['--no-autoupdate', '--config', namedTunnel.configPath, 'tunnel', 'run', namedTunnel.tunnelName]
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
          this.status.activeSource = null;
          reject(error);
        });
      }, 20000);

      const markConnected = (publicUrl: string | null) => {
        clearTimeout(connectTimeout);
        this.status.state = 'connected';
        this.status.publicUrl = publicUrl;
        this.status.lastError = null;
        this.status.activeSource = mode === 'named' ? 'local-manager' : this.status.activeSource;
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

        if (stablePublicUrl && connectionReadyPattern.test(line)) {
          markConnected(stablePublicUrl);
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
        this.status.activeSource = null;
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
        this.status.activeSource = null;
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

  private async resolveNamedTunnel(targetUrl: string): Promise<NamedTunnelConfig | null> {
    if (!(await pathExists(CLOUDFLARED_CONFIG_PATH))) {
      return null;
    }

    const content = await readFile(CLOUDFLARED_CONFIG_PATH, 'utf8');
    const parsed = parseCloudflaredConfig(content);
    if (!parsed.tunnelName) {
      return null;
    }

    const matchingEntry = parsed.entries.find((entry) =>
      serviceTargetsTargetUrl(entry.service, targetUrl) && entry.hostname,
    );
    if (!matchingEntry?.hostname || !matchingEntry.service) {
      return null;
    }

    return {
      configPath: CLOUDFLARED_CONFIG_PATH,
      publicUrl: `https://${matchingEntry.hostname}`,
      service: matchingEntry.service,
      tunnelName: parsed.tunnelName,
    };
  }

  private async readTunnelInfo(tunnelName: string) {
    try {
      const { stdout } = await execFile('cloudflared', ['tunnel', 'info', '--output', 'json', tunnelName]);
      return JSON.parse(stdout) as TunnelInfoResponse;
    } catch {
      return null;
    }
  }

  private snapshot(): CloudflareStatus {
    return {
      ...this.status,
      recentLogs: [...this.status.recentLogs],
    };
  }
}
