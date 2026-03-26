import type { AgentExecutor } from './types.js';

export const DEFAULT_AGENT_EXECUTOR: AgentExecutor = 'codex';

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
