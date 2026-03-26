import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename } from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';

import type {
  ApprovalMode,
  CodexAgentMessageItem,
  CodexThread,
  CodexThreadInput,
  CodexTurn,
  ModelOption,
  ReasoningEffort,
  SecurityProfile,
} from './types.js';
import type { AgentRuntime } from './app/agent-runtime.js';

interface ClaudeCliSystemInitEvent {
  type: 'system';
  subtype?: string;
  session_id?: string;
  model?: string;
  permissionMode?: string;
  claude_code_version?: string;
}

interface ClaudeCliAssistantEvent {
  type: 'assistant';
  session_id?: string;
  error?: string;
  message?: {
    content?: Array<{
      type?: string;
      text?: string;
    }>;
  };
}

interface ClaudeCliResultEvent {
  type: 'result';
  session_id?: string;
  result?: string;
  is_error?: boolean;
}

type ClaudeCliEvent =
  | ClaudeCliSystemInitEvent
  | ClaudeCliAssistantEvent
  | ClaudeCliResultEvent;

interface ClaudeThreadState {
  thread: CodexThread;
  securityProfile: SecurityProfile;
  model: string | null;
  activeTurnId: string | null;
  activeProcess: ChildProcess | null;
  interrupted: boolean;
}

interface ClaudeCodeCliRuntimeOptions {
  executable?: string;
  spawnProcess?: typeof spawn;
  randomId?: () => string;
  now?: () => number;
  homeDir?: string;
}

const CLAUDE_DEFAULT_MODELS: ModelOption[] = [
  {
    id: 'sonnet',
    displayName: 'Claude Sonnet',
    model: 'sonnet',
    description: 'Claude Code default balanced model alias.',
    isDefault: true,
    hidden: false,
    defaultReasoningEffort: 'high',
    supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh'],
  },
  {
    id: 'opus',
    displayName: 'Claude Opus',
    model: 'opus',
    description: 'Claude Code higher-capability model alias.',
    isDefault: false,
    hidden: false,
    defaultReasoningEffort: 'xhigh',
    supportedReasoningEfforts: ['medium', 'high', 'xhigh'],
  },
];

function claudeCodeExecutable() {
  const configured = process.env.CLAUDE_BIN?.trim();
  if (configured) {
    return configured;
  }

  if (process.platform === 'darwin') {
    return '/opt/homebrew/bin/claude';
  }

  return 'claude';
}

export function claudeCodeExecutableAvailable() {
  const executable = claudeCodeExecutable();
  if (executable.includes('/')) {
    return existsSync(executable);
  }
  return false;
}

function promptFromThreadInput(input: CodexThreadInput[]) {
  const segments: string[] = [];
  for (const entry of input) {
    if (entry.type === 'text') {
      const text = entry.text.trim();
      if (text) {
        segments.push(text);
      }
      continue;
    }

    segments.push(`Image attachment path: ${entry.path}`);
  }
  return segments.join('\n\n').trim();
}

function previewFromInput(input: CodexThreadInput[]) {
  const prompt = promptFromThreadInput(input);
  return prompt ? prompt.slice(0, 160) : 'Claude Code session';
}

function claudePermissionMode(approvalMode: ApprovalMode) {
  if (approvalMode === 'full-auto') return 'bypassPermissions';
  if (approvalMode === 'less-interruption') return 'acceptEdits';
  return 'default';
}

function claudeAllowedTools(approvalMode: ApprovalMode) {
  if (approvalMode !== 'less-interruption') {
    return [];
  }

  return [
    'Bash',
    'Read',
    'Glob',
    'Grep',
    'Edit',
    'Write',
    'NotebookEdit',
    'TodoWrite',
    'WebFetch',
    'WebSearch',
  ];
}

function additionalDirectoriesForSecurityProfile(securityProfile: SecurityProfile, homeDir: string) {
  if (securityProfile === 'full-host') {
    return [homeDir];
  }
  return [];
}

function baseThread(threadId: string, cwd: string, now: number): CodexThread {
  return {
    id: threadId,
    preview: 'Claude Code session',
    cwd,
    name: basename(cwd) || null,
    path: cwd,
    cliVersion: null,
    source: 'claude-code',
    modelProvider: 'claude-code',
    status: { type: 'idle' },
    updatedAt: now,
    turns: [],
  };
}

function parseClaudeCliEvent(raw: string): ClaudeCliEvent | null {
  try {
    return JSON.parse(raw) as ClaudeCliEvent;
  } catch {
    return null;
  }
}

function assistantTextFromEvent(event: ClaudeCliAssistantEvent) {
  const content = Array.isArray(event.message?.content) ? event.message.content : [];
  return content
    .filter((entry) => entry.type === 'text' && typeof entry.text === 'string')
    .map((entry) => entry.text?.trim() ?? '')
    .filter(Boolean)
    .join('\n\n');
}

function finalizeTurnStatus(interrupted: boolean, isError: boolean) {
  if (interrupted) return 'interrupted';
  if (isError) return 'error';
  return 'completed';
}

export class ClaudeCodeCliRuntime extends EventEmitter implements AgentRuntime {
  private readonly threads = new Map<string, ClaudeThreadState>();
  private readonly executable: string;
  private readonly spawnProcess: typeof spawn;
  private readonly randomId: () => string;
  private readonly now: () => number;
  private readonly homeDir: string;
  private started = false;

  constructor(options: ClaudeCodeCliRuntimeOptions = {}) {
    super();
    this.executable = options.executable ?? claudeCodeExecutable();
    this.spawnProcess = options.spawnProcess ?? spawn;
    this.randomId = options.randomId ?? (() => randomUUID());
    this.now = options.now ?? (() => Date.now());
    this.homeDir = options.homeDir ?? homedir();
  }

  async ensureStarted() {
    this.started = true;
  }

  async startThread(options: {
    cwd: string;
    securityProfile: SecurityProfile;
    model?: string | null;
  }) {
    await this.ensureStarted();
    const threadId = this.randomId();
    this.threads.set(threadId, {
      thread: baseThread(threadId, options.cwd, this.now()),
      securityProfile: options.securityProfile,
      model: options.model ?? null,
      activeTurnId: null,
      activeProcess: null,
      interrupted: false,
    });

    return {
      thread: {
        id: threadId,
      },
    };
  }

  async startTurn(
    threadId: string,
    input: CodexThreadInput[],
    options?: {
      model?: string | null;
      effort?: ReasoningEffort | null;
      approvalMode?: ApprovalMode;
      securityProfile?: SecurityProfile;
    },
  ) {
    await this.ensureStarted();
    const state = this.threads.get(threadId);
    if (!state) {
      throw new Error(`Claude Code thread "${threadId}" is not initialized.`);
    }
    if (state.activeProcess) {
      throw new Error(`Claude Code thread "${threadId}" already has an active turn.`);
    }

    const turnId = this.randomId();
    const turn: CodexTurn = {
      id: turnId,
      status: 'running',
      error: null,
      items: [{
        type: 'userMessage',
        id: `${turnId}-user`,
        content: input,
      }],
    };

    state.thread.turns.push(turn);
    state.thread.preview = previewFromInput(input);
    state.thread.updatedAt = this.now();
    state.thread.status = { type: 'active' };
    state.activeTurnId = turnId;
    state.interrupted = false;
    this.emit('notification', {
      method: 'thread/status/changed',
      params: {
        threadId,
        status: {
          type: 'active',
        },
      },
    });

    const args = [
      '--print',
      '--verbose',
      '--output-format',
      'stream-json',
      '--session-id',
      threadId,
      '--permission-mode',
      claudePermissionMode(options?.approvalMode ?? 'detailed'),
    ];

    const model = options?.model ?? state.model ?? 'sonnet';
    if (model) {
      args.push('--model', model);
    }
    const allowedTools = claudeAllowedTools(options?.approvalMode ?? 'detailed');
    if (allowedTools.length > 0) {
      args.push('--allowedTools', allowedTools.join(','));
    }
    for (const directory of additionalDirectoriesForSecurityProfile(
      options?.securityProfile ?? state.securityProfile,
      this.homeDir,
    )) {
      args.push('--add-dir', directory);
    }
    args.push(promptFromThreadInput(input) || 'Continue.');

    const child = this.spawnProcess(this.executable, args, {
      cwd: state.thread.cwd,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    state.activeProcess = child;

    let stdoutBuffer = '';
    let assistantText = '';
    let resultText = '';
    let errorText = '';
    let isError = false;
    let finalized = false;

    const appendAssistantMessage = (text: string) => {
      const trimmed = text.trim();
      if (!trimmed) {
        return;
      }
      const existing = turn.items.find((item): item is CodexAgentMessageItem => item.type === 'agentMessage');
      if (existing) {
        existing.text = trimmed;
        return;
      }
      turn.items.push({
        type: 'agentMessage',
        id: `${turn.id}-assistant`,
        text: trimmed,
        phase: null,
      });
    };

    const handleLine = (line: string) => {
      const event = parseClaudeCliEvent(line);
      if (!event) {
        this.emit('debug', `[claude-code] ${line}`);
        return;
      }

      if (event.type === 'system' && event.subtype === 'init') {
        state.thread.cliVersion = event.claude_code_version ?? state.thread.cliVersion ?? null;
        state.thread.modelProvider = 'claude-code';
        state.thread.source = 'claude-code';
        if (typeof event.model === 'string' && event.model) {
          state.model = event.model;
        }
        return;
      }

      if (event.type === 'assistant') {
        const nextText = assistantTextFromEvent(event);
        if (nextText) {
          assistantText = nextText;
          appendAssistantMessage(nextText);
        }
        if (typeof event.error === 'string' && event.error) {
          isError = true;
          errorText = event.error;
        }
        return;
      }

      if (event.type === 'result') {
        if (typeof event.result === 'string' && event.result.trim()) {
          resultText = event.result.trim();
        }
        if (event.is_error) {
          isError = true;
        }
      }
    };

    const finalize = () => {
      if (finalized) {
        return;
      }
      finalized = true;

      const finalText = assistantText || resultText || errorText;
      if (finalText && !state.interrupted) {
        appendAssistantMessage(finalText);
      }

      const interrupted = state.interrupted;
      turn.status = finalizeTurnStatus(interrupted, isError);
      turn.error = turn.status === 'error'
        ? {
          message: finalText || 'Claude Code turn failed.',
        }
        : null;

      state.activeProcess = null;
      state.activeTurnId = null;
      state.thread.updatedAt = this.now();
      state.thread.status = {
        type: isError ? 'systemError' : 'idle',
      };

      setTimeout(() => {
        this.emit('notification', {
          method: 'thread/status/changed',
          params: {
            threadId,
            status: {
              type: isError ? 'systemError' : 'idle',
            },
          },
        });
        this.emit('notification', {
          method: 'turn/completed',
          params: {
            threadId,
            turnId,
          },
        });
      }, 0);
    };

    child.stdout?.on('data', (chunk: Buffer | string) => {
      stdoutBuffer += chunk.toString();
      let newlineIndex = stdoutBuffer.indexOf('\n');
      while (newlineIndex >= 0) {
        const line = stdoutBuffer.slice(0, newlineIndex).trim();
        stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
        if (line) {
          handleLine(line);
        }
        newlineIndex = stdoutBuffer.indexOf('\n');
      }
    });

    child.stderr?.on('data', (chunk: Buffer | string) => {
      const text = chunk.toString().trim();
      if (text) {
        this.emit('debug', `[claude-code] ${text}`);
        errorText = errorText ? `${errorText}\n${text}` : text;
      }
    });

    child.on('error', (error: Error) => {
      isError = true;
      errorText = error.message;
      finalize();
    });

    child.on('exit', () => {
      const trailing = stdoutBuffer.trim();
      if (trailing) {
        handleLine(trailing);
      }
      finalize();
    });

    return {
      turn: {
        id: turnId,
        status: 'running',
      },
    };
  }

  async interruptTurn(threadId: string, turnId: string) {
    const state = this.threads.get(threadId);
    if (!state || !state.activeProcess || state.activeTurnId !== turnId) {
      return;
    }
    state.interrupted = true;
    state.activeProcess.kill('SIGTERM');
  }

  async listModels() {
    return CLAUDE_DEFAULT_MODELS;
  }

  async readThread(threadId: string) {
    return {
      thread: this.threads.get(threadId)?.thread ?? null,
    };
  }

  async respond() {
    return undefined;
  }

  async stop() {
    for (const state of this.threads.values()) {
      state.interrupted = true;
      state.activeProcess?.kill('SIGTERM');
      state.activeProcess = null;
      state.activeTurnId = null;
    }
    this.threads.clear();
    this.started = false;
  }
}
