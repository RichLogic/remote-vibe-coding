import { DEFAULT_AGENT_EXECUTOR } from '../executor.js';
import type { AgentExecutor, ExecutorModelCatalog, ModelOption, ReasoningEffort } from '../types.js';
import type { AgentRuntimeRegistry, RuntimeModelCatalogPort } from './agent-runtime.js';

const FALLBACK_MODELS: ModelOption[] = [
  {
    id: 'gpt-5-codex',
    displayName: 'GPT-5 Codex',
    model: 'gpt-5-codex',
    description: 'Fallback default when the model catalog is unavailable.',
    isDefault: true,
    hidden: false,
    defaultReasoningEffort: 'xhigh',
    supportedReasoningEfforts: ['minimal', 'low', 'medium', 'high', 'xhigh'],
  },
];

type RuntimeCatalogSource = RuntimeModelCatalogPort | Pick<AgentRuntimeRegistry, 'defaultExecutor' | 'entries' | 'supportedExecutors'>;

function isRegistrySource(source: RuntimeCatalogSource): source is Pick<AgentRuntimeRegistry, 'defaultExecutor' | 'entries' | 'supportedExecutors'> {
  return typeof (source as Pick<AgentRuntimeRegistry, 'entries'>).entries === 'function';
}

export class ModelCatalog {
  private readonly modelsByExecutor = new Map<AgentExecutor, ModelOption[]>([
    [DEFAULT_AGENT_EXECUTOR, [...FALLBACK_MODELS]],
  ]);

  constructor(private readonly runtimeSource: RuntimeCatalogSource) {}

  private defaultExecutor() {
    return isRegistrySource(this.runtimeSource)
      ? this.runtimeSource.defaultExecutor()
      : DEFAULT_AGENT_EXECUTOR;
  }

  private configuredExecutors() {
    return isRegistrySource(this.runtimeSource)
      ? this.runtimeSource.supportedExecutors()
      : [DEFAULT_AGENT_EXECUTOR];
  }

  private runtimeEntries() {
    return isRegistrySource(this.runtimeSource)
      ? this.runtimeSource.entries().map(({ executor, runtime }: { executor: AgentExecutor; runtime: unknown }) => ({
        executor,
        runtime: runtime as RuntimeModelCatalogPort,
      }))
      : [{
        executor: DEFAULT_AGENT_EXECUTOR,
        runtime: this.runtimeSource,
      }];
  }

  private modelsFor(executor: AgentExecutor) {
    return this.modelsByExecutor.get(executor)
      ?? (executor === DEFAULT_AGENT_EXECUTOR ? FALLBACK_MODELS : []);
  }

  list(executor: AgentExecutor = this.defaultExecutor()) {
    return this.modelsFor(executor);
  }

  listByExecutor(): ExecutorModelCatalog {
    return Object.fromEntries(
      this.configuredExecutors().map((executor: AgentExecutor) => [executor, this.list(executor)]),
    ) as ExecutorModelCatalog;
  }

  async refresh() {
    for (const { executor, runtime } of this.runtimeEntries()) {
      try {
        const next = await runtime.listModels();
        if (next.length > 0) {
          this.modelsByExecutor.set(executor, next.filter((entry: ModelOption) => !entry.hidden));
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`model/list failed for ${executor}, using fallback catalog: ${message}`);
      }
    }

    return this.list();
  }

  currentDefaultModel(executor: AgentExecutor = this.defaultExecutor()) {
    const models = this.list(executor);
    return models.find((entry) => entry.isDefault)?.model ?? models[0]?.model ?? FALLBACK_MODELS[0]!.model;
  }

  findByModel(model: string | null | undefined, executor: AgentExecutor = this.defaultExecutor()) {
    return this.list(executor).find((entry) => entry.model === model) ?? null;
  }

  resolveOption(model: string | null | undefined, executor: AgentExecutor = this.defaultExecutor()) {
    const models = this.list(executor);
    return this.findByModel(model, executor)
      ?? models.find((entry) => entry.isDefault)
      ?? models[0]
      ?? FALLBACK_MODELS[0]!;
  }

  preferredReasoningEffortForModel(modelOption: ModelOption) {
    const preferredEfforts: ReasoningEffort[] = ['xhigh', 'high', 'medium', 'low', 'minimal', 'none'];
    for (const effort of preferredEfforts) {
      if (modelOption.supportedReasoningEfforts.includes(effort)) {
        return effort;
      }
    }

    if (modelOption.supportedReasoningEfforts.includes(modelOption.defaultReasoningEffort)) {
      return modelOption.defaultReasoningEffort;
    }

    return modelOption.supportedReasoningEfforts[0] ?? 'xhigh';
  }

  currentDefaultEffort(model: string | null | undefined, executor: AgentExecutor = this.defaultExecutor()) {
    return this.preferredReasoningEffortForModel(this.resolveOption(model, executor));
  }
}
