import type { ChatMessageRecord } from '../chat-history.js';
import type { AgentExecutor, CodexThread, CodexThreadInput, ConversationRecord, ReasoningEffort } from '../types.js';
import type { RuntimeThreadStarter, RuntimeTurnStarter } from './agent-runtime.js';

interface GenerateChatConversationSummaryOptions {
  summaryRuntime: RuntimeThreadStarter & RuntimeTurnStarter;
  summaryExecutor: AgentExecutor;
  summaryModel: string;
  summaryEffort: ReasoningEffort;
  buildSummaryPrompt: (existingSummary: string | null, messages: ChatMessageRecord[]) => string;
  textThreadInput: (text: string) => CodexThreadInput;
  waitForTurnThread: (threadId: string, turnId: string, executor: AgentExecutor) => Promise<CodexThread>;
  assistantTextFromTurn: (thread: CodexThread, turnId: string) => string | null;
}

export async function generateChatConversationSummary(
  conversation: ConversationRecord,
  existingSummary: string | null,
  messages: ChatMessageRecord[],
  options: GenerateChatConversationSummaryOptions,
) {
  if (messages.length === 0) {
    return existingSummary?.trim() ?? '';
  }

  const threadResponse = await options.summaryRuntime.startThread({
    cwd: conversation.workspace,
    securityProfile: 'read-only',
    model: options.summaryModel,
  });
  const turnResponse = await options.summaryRuntime.startTurn(
    threadResponse.thread.id,
    [options.textThreadInput(options.buildSummaryPrompt(existingSummary, messages))],
    {
      model: options.summaryModel,
      effort: options.summaryEffort,
    },
  );
  const thread = await options.waitForTurnThread(
    threadResponse.thread.id,
    turnResponse.turn.id,
    options.summaryExecutor,
  );
  const summary = options.assistantTextFromTurn(thread, turnResponse.turn.id);
  if (!summary) {
    throw new Error(`Summary generation returned no assistant text for conversation ${conversation.id}`);
  }

  return summary.trim();
}
