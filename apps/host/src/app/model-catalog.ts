import type { CodexAppServerClient } from '../codex-app-server.js';
import type { ModelOption, ReasoningEffort } from '../types.js';

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

export class ModelCatalog {
  private models = [...FALLBACK_MODELS];

  constructor(private readonly codex: CodexAppServerClient) {}

  list() {
    return this.models;
  }

  async refresh() {
    try {
      const next = await this.codex.listModels();
      if (next.length > 0) {
        this.models = next.filter((entry) => !entry.hidden);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`model/list failed, using fallback catalog: ${message}`);
    }

    return this.models;
  }

  currentDefaultModel() {
    return this.models.find((entry) => entry.isDefault)?.model ?? this.models[0]?.model ?? FALLBACK_MODELS[0]!.model;
  }

  findByModel(model: string | null | undefined) {
    return this.models.find((entry) => entry.model === model) ?? null;
  }

  resolveOption(model: string | null | undefined) {
    return this.findByModel(model)
      ?? this.models.find((entry) => entry.isDefault)
      ?? this.models[0]
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

  currentDefaultEffort(model: string | null | undefined) {
    return this.preferredReasoningEffortForModel(this.resolveOption(model));
  }
}
