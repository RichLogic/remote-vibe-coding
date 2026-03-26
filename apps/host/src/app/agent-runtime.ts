import type {
  AgentExecutor,
  ApprovalMode,
  CodexThreadInput,
  ModelOption,
  ReasoningEffort,
  SecurityProfile,
} from '../types.js';
import { DEFAULT_AGENT_EXECUTOR } from '../executor.js';

export type AgentRuntimeRequestId = number | string;

export interface AgentRuntimeNotification {
  method: string;
  params?: unknown;
}

export interface AgentRuntimeServerRequest extends AgentRuntimeNotification {
  id: AgentRuntimeRequestId;
}

export interface AgentRuntimeEventSource {
  on(event: 'debug', handler: (message: string) => void): void;
  on(event: 'notification', handler: (message: AgentRuntimeNotification) => void): void;
  on(event: 'serverRequest', handler: (message: AgentRuntimeServerRequest) => void): void;
  on(event: 'runtimeStopped', handler: (message: string) => void): void;
}

export interface RuntimeThreadStarter {
  startThread(options: {
    cwd: string;
    securityProfile: SecurityProfile;
    model?: string | null;
  }): Promise<{
    thread: {
      id: string;
    };
  }>;
}

export interface RuntimeTurnStarter {
  startTurn(
    threadId: string,
    input: CodexThreadInput[],
    options?: {
      model?: string | null;
      effort?: ReasoningEffort | null;
      approvalMode?: ApprovalMode;
      securityProfile?: SecurityProfile;
    },
  ): Promise<{
    turn: {
      id: string;
      status: string;
    };
  }>;
}

export interface RuntimeTurnInterrupter {
  interruptTurn(threadId: string, turnId: string): Promise<unknown>;
}

export interface RuntimeThreadReader {
  readThread(threadId: string): Promise<{
    thread: unknown;
  }>;
}

export interface RuntimeApprovalResponder {
  respond(id: AgentRuntimeRequestId, result: unknown): Promise<unknown>;
}

export interface RuntimeModelCatalogPort {
  listModels(): Promise<ModelOption[]>;
}

export interface AgentRuntime extends
  AgentRuntimeEventSource,
  RuntimeThreadStarter,
  RuntimeTurnStarter,
  RuntimeTurnInterrupter,
  RuntimeThreadReader,
  RuntimeApprovalResponder,
  RuntimeModelCatalogPort {
  ensureStarted(): Promise<void>;
  stop(): Promise<void>;
}

export interface AgentRuntimeRegistryEntry {
  executor: AgentExecutor;
  runtime: AgentRuntime;
}

export interface AgentRuntimeRegistry {
  defaultExecutor(): AgentExecutor;
  defaultRuntime(): AgentRuntime;
  supportedExecutors(): AgentExecutor[];
  get(executor: AgentExecutor): AgentRuntime | null;
  require(executor: AgentExecutor): AgentRuntime;
  entries(): AgentRuntimeRegistryEntry[];
}

export class StaticAgentRuntimeRegistry implements AgentRuntimeRegistry {
  private readonly runtimes: Map<AgentExecutor, AgentRuntime>;
  private readonly preferredDefaultExecutor: AgentExecutor;

  constructor(
    runtimes: Partial<Record<AgentExecutor, AgentRuntime>>,
    defaultExecutor: AgentExecutor = DEFAULT_AGENT_EXECUTOR,
  ) {
    this.runtimes = new Map(
      Object.entries(runtimes) as Array<[AgentExecutor, AgentRuntime]>,
    );
    this.preferredDefaultExecutor = defaultExecutor;
  }

  defaultExecutor() {
    if (this.runtimes.has(this.preferredDefaultExecutor)) {
      return this.preferredDefaultExecutor;
    }
    return this.supportedExecutors()[0] ?? DEFAULT_AGENT_EXECUTOR;
  }

  defaultRuntime() {
    return this.require(this.defaultExecutor());
  }

  supportedExecutors() {
    return [...this.runtimes.keys()];
  }

  get(executor: AgentExecutor) {
    return this.runtimes.get(executor) ?? null;
  }

  require(executor: AgentExecutor) {
    const runtime = this.get(executor);
    if (!runtime) {
      throw new Error(`Runtime "${executor}" is not configured.`);
    }
    return runtime;
  }

  entries() {
    return [...this.runtimes.entries()].map(([executor, runtime]) => ({ executor, runtime }));
  }
}
