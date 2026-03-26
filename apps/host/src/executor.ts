import type { AgentExecutor } from './types.js';

export const DEFAULT_AGENT_EXECUTOR: AgentExecutor = 'codex';
export const EXECUTOR_INIT_ENV_VAR = 'RVC_EXECUTOR_INIT';

export type ExecutorInitializationMode = 'auto' | 'codex' | 'claude-code' | 'both';

export function normalizeAgentExecutor(value: unknown): AgentExecutor {
  switch (value) {
    case 'claude-code':
    case 'claude_code':
    case 'claude':
      return 'claude-code';
    case 'codex':
    default:
      return 'codex';
  }
}

function trimmedString(value: unknown) {
  return typeof value === 'string'
    ? value.trim()
    : '';
}

export function normalizeExecutorInitializationMode(value: unknown): ExecutorInitializationMode {
  switch (trimmedString(value).toLowerCase()) {
    case '':
    case 'auto':
      return 'auto';
    case 'both':
    case 'all':
      return 'both';
    case 'claude-code':
    case 'claude_code':
    case 'claude':
      return 'claude-code';
    case 'codex':
      return 'codex';
    default: {
      const invalidValue = trimmedString(value) || String(value);
      throw new Error(
        `Invalid ${EXECUTOR_INIT_ENV_VAR} value "${invalidValue}". Expected one of: auto, codex, claude-code, both.`,
      );
    }
  }
}

export function resolveConfiguredExecutors(options: {
  mode?: unknown;
  claudeAvailable?: boolean;
} = {}) {
  const mode = normalizeExecutorInitializationMode(options.mode ?? process.env[EXECUTOR_INIT_ENV_VAR]);
  const claudeAvailable = options.claudeAvailable ?? false;

  switch (mode) {
    case 'codex':
      return ['codex'] as AgentExecutor[];
    case 'claude-code':
      return ['claude-code'] as AgentExecutor[];
    case 'both':
      return ['codex', 'claude-code'] as AgentExecutor[];
    case 'auto':
    default:
      return claudeAvailable
        ? ['codex', 'claude-code'] as AgentExecutor[]
        : ['codex'] as AgentExecutor[];
  }
}

export function defaultExecutorForConfiguredExecutors(executors: AgentExecutor[]): AgentExecutor {
  if (executors.includes(DEFAULT_AGENT_EXECUTOR)) {
    return DEFAULT_AGENT_EXECUTOR;
  }
  return executors[0] ?? DEFAULT_AGENT_EXECUTOR;
}
