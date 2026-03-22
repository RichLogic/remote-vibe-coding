import { EventEmitter } from 'node:events';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';

import WebSocket from 'ws';

import type { CodexThreadInput, ModelOption, ReasoningEffort, SecurityProfile } from './types.js';

type JsonRpcId = number | string;

interface JsonRpcResponse {
  id: JsonRpcId;
  result?: unknown;
  error?: {
    code: number;
    message: string;
  };
}

export interface JsonRpcNotification {
  method: string;
  params?: unknown;
}

export interface JsonRpcServerRequest extends JsonRpcNotification {
  id: JsonRpcId;
}

interface PendingRequest {
  resolve: (value: any) => void;
  reject: (error: Error) => void;
}

interface StartThreadOptions {
  cwd: string;
  securityProfile: SecurityProfile;
  model?: string | null;
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function codexExecutable() {
  const configured = process.env.CODEX_BIN?.trim();
  if (configured) {
    return configured;
  }

  if (process.platform === 'darwin') {
    return '/opt/homebrew/bin/codex';
  }

  return 'codex';
}

async function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close();
        reject(new Error('Failed to resolve a free port'));
        return;
      }

      const { port } = address;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(port);
      });
    });
  });
}

async function waitForReady(url: string) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        return;
      }
    } catch {
      // The process is still starting up.
    }
    await delay(100);
  }

  throw new Error(`Timed out waiting for Codex app-server readiness at ${url}`);
}

export class CodexAppServerClient extends EventEmitter {
  private readonly pending = new Map<JsonRpcId, PendingRequest>();
  private nextId = 1;
  private startPromise: Promise<void> | null = null;
  private ws: WebSocket | null = null;
  private process: ChildProcess | null = null;
  private listenUrl = '';

  async ensureStarted() {
    if (this.startPromise) {
      await this.startPromise;
      return;
    }

    this.startPromise = this.start();
    await this.startPromise;
  }

  private async start() {
    const port = await findFreePort();
    this.listenUrl = `ws://127.0.0.1:${port}`;

    const proc = spawn(codexExecutable(), ['app-server', '--listen', this.listenUrl], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    });
    this.process = proc;

    proc.stdout?.on('data', (chunk) => {
      const text = chunk.toString().trim();
      if (text) {
        this.emit('debug', text);
      }
    });

    proc.stderr?.on('data', (chunk) => {
      const text = chunk.toString().trim();
      if (text) {
        this.emit('debug', text);
      }
    });

    proc.on('exit', (code, signal) => {
      const message = `codex app-server exited (code=${code ?? 'null'}, signal=${signal ?? 'null'})`;
      this.emit('debug', message);
      this.emit('runtimeStopped', message);
      this.startPromise = null;
      this.ws = null;
      this.process = null;
    });

    await waitForReady(`http://127.0.0.1:${port}/readyz`);

    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(this.listenUrl);

      ws.once('open', () => {
        this.ws = ws;
        ws.on('message', (message) => {
          this.handleMessage(message.toString());
        });
        ws.on('error', (error) => {
          this.emit('debug', `codex websocket error: ${error.message}`);
        });
        resolve();
      });

      ws.once('error', reject);
    });

    await this.requestInternal('initialize', {
      clientInfo: {
        name: 'remote-vibe-coding-host',
        version: '0.1.0',
      },
      capabilities: null,
    });
    this.send({
      jsonrpc: '2.0',
      method: 'initialized',
    });
  }

  private handleMessage(raw: string) {
    const message = JSON.parse(raw) as JsonRpcResponse | JsonRpcNotification | JsonRpcServerRequest;

    if ('id' in message && !('method' in message)) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) {
        pending.reject(new Error(message.error.message));
        return;
      }
      pending.resolve(message.result);
      return;
    }

    if ('id' in message && 'method' in message) {
      this.emit('serverRequest', message);
      return;
    }

    if ('method' in message) {
      this.emit('notification', message);
    }
  }

  private send(payload: Record<string, unknown>) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('Codex app-server websocket is not connected');
    }
    this.ws.send(JSON.stringify(payload));
  }

  private requestInternal<T>(method: string, params: unknown): Promise<T> {
    const id = this.nextId++;

    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.send({
        jsonrpc: '2.0',
        id,
        method,
        params,
      });
    });
  }

  async request<T>(method: string, params: unknown): Promise<T> {
    await this.ensureStarted();
    return this.requestInternal<T>(method, params);
  }

  async respond(id: JsonRpcId, result: unknown) {
    await this.ensureStarted();
    this.send({
      jsonrpc: '2.0',
      id,
      result,
    });
  }

  async startThread(options: StartThreadOptions) {
    const sandbox = options.securityProfile === 'full-host'
      ? 'danger-full-access'
      : options.securityProfile === 'read-only'
        ? 'read-only'
        : 'workspace-write';
    return this.request<{
      thread: {
        id: string;
      };
    }>('thread/start', {
      cwd: options.cwd,
      approvalPolicy: 'on-request',
      approvalsReviewer: 'user',
      sandbox,
      ...(options.model ? { model: options.model } : {}),
      experimentalRawEvents: false,
      persistExtendedHistory: false,
    });
  }

  async startTurn(threadId: string, input: CodexThreadInput[], options?: { model?: string | null; effort?: ReasoningEffort | null }) {
    return this.request<{
      turn: {
        id: string;
        status: string;
      };
    }>('turn/start', {
      threadId,
      input,
      ...(options?.model ? { model: options.model } : {}),
      ...(options?.effort ? { effort: options.effort } : {}),
    });
  }

  async interruptTurn(threadId: string, turnId: string) {
    return this.request('turn/interrupt', {
      threadId,
      turnId,
    });
  }

  async listModels() {
    const response = await this.request<{
      data: Array<{
        id: string;
        displayName: string;
        model: string;
        description: string;
        isDefault: boolean;
        hidden: boolean;
        defaultReasoningEffort: ReasoningEffort;
        supportedReasoningEfforts: Array<{
          reasoningEffort: ReasoningEffort;
        }>;
      }>;
    }>('model/list', {
      includeHidden: false,
      limit: 100,
    });

    return response.data.map((entry): ModelOption => ({
      id: entry.id,
      displayName: entry.displayName,
      model: entry.model,
      description: entry.description,
      isDefault: entry.isDefault,
      hidden: entry.hidden,
      defaultReasoningEffort: entry.defaultReasoningEffort,
      supportedReasoningEfforts: entry.supportedReasoningEfforts.map((option) => option.reasoningEffort),
    }));
  }

  async readThread(threadId: string) {
    return this.request<{
      thread: unknown;
    }>('thread/read', {
      threadId,
      includeTurns: true,
    });
  }

  async stop() {
    this.ws?.close();
    if (this.process && !this.process.killed) {
      this.process.kill('SIGTERM');
    }
    this.ws = null;
    this.process = null;
    this.startPromise = null;
  }
}
