import { readFile, rename, writeFile } from 'node:fs/promises';

import type {
  ChatRolePreset as ApiChatRolePreset,
  ChatRolePresetDetail as ApiChatRolePresetDetail,
  ChatRolePresetListResponse,
} from './chat/types.js';
import { CHAT_ROLE_PRESETS_FILE, CHAT_SYSTEM_PROMPT_FILE } from './config.js';

export interface ChatRolePresetConfigEntry {
  id: string;
  label: string;
  description: string | null;
  promptText: string;
}

export interface ChatRolePresetConfigState {
  defaultPresetId: string | null;
  presets: ChatRolePresetConfigEntry[];
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function trimOptional(value: unknown) {
  return typeof value === 'string' && value.trim().length > 0
    ? value.trim()
    : null;
}

function promptTextFromConfig(value: { prompt?: unknown; instructions?: unknown }) {
  return typeof value.prompt === 'string'
    ? value.prompt.trim()
    : Array.isArray(value.instructions)
      ? value.instructions.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0).join('\n')
      : '';
}

export class ChatPromptConfigStore {
  private cachedSystemPromptText: string | null = null;
  private cachedRolePresetConfig: ChatRolePresetConfigState = {
    defaultPresetId: null,
    presets: [],
  };

  constructor(private readonly warn: (message: string) => void) {}

  getCachedRolePresetConfig() {
    return this.cachedRolePresetConfig;
  }

  private normalizeChatRolePresetConfig(
    parsed: {
      defaultPresetId?: unknown;
      presets?: unknown;
    },
  ): ChatRolePresetConfigState {
    const presets = Array.isArray(parsed.presets)
      ? parsed.presets.flatMap((entry): ChatRolePresetConfigEntry[] => {
          if (!entry || typeof entry !== 'object') {
            return [];
          }
          const record = entry as {
            id?: unknown;
            label?: unknown;
            description?: unknown;
            prompt?: unknown;
            instructions?: unknown;
          };
          const id = trimOptional(record.id);
          const label = trimOptional(record.label);
          const promptText = promptTextFromConfig(record);
          if (!id || !label || !promptText) {
            return [];
          }
          return [{
            id,
            label,
            description: trimOptional(record.description),
            promptText,
          }];
        })
      : [];
    const dedupedPresets = presets.filter((preset, index, current) => (
      current.findIndex((entry) => entry.id === preset.id) === index
    ));
    const config: ChatRolePresetConfigState = {
      defaultPresetId: null,
      presets: dedupedPresets,
    };
    config.defaultPresetId = this.normalizeRolePresetId(trimOptional(parsed.defaultPresetId), config);
    return config;
  }

  private async writeJsonFileAtomic(filePath: string, payload: unknown) {
    const content = `${JSON.stringify(payload, null, 2)}\n`;
    const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tempPath, content, 'utf8');
    await rename(tempPath, filePath);
  }

  async saveRolePresetConfig(config: ChatRolePresetConfigState) {
    const normalized = this.normalizeChatRolePresetConfig({
      defaultPresetId: config.defaultPresetId,
      presets: config.presets.map((preset) => ({
        id: preset.id,
        label: preset.label,
        description: preset.description,
        prompt: preset.promptText,
      })),
    });
    await this.writeJsonFileAtomic(CHAT_ROLE_PRESETS_FILE, {
      version: 1,
      name: 'chat-role-presets',
      defaultPresetId: normalized.defaultPresetId,
      presets: normalized.presets.map((preset) => ({
        id: preset.id,
        label: preset.label,
        description: preset.description,
        prompt: preset.promptText,
      })),
    });
    this.cachedRolePresetConfig = normalized;
    return normalized;
  }

  normalizeRolePresetId(
    value: string | null | undefined,
    config = this.cachedRolePresetConfig,
  ) {
    const nextId = trimOptional(value);
    if (!nextId) {
      return null;
    }
    return config.presets.some((preset) => preset.id === nextId) ? nextId : null;
  }

  promptTextForRolePreset(
    rolePresetId: string | null | undefined,
    config = this.cachedRolePresetConfig,
  ) {
    const normalizedId = this.normalizeRolePresetId(rolePresetId, config);
    return config.presets.find((preset) => preset.id === normalizedId)?.promptText ?? null;
  }

  promptSections(
    rolePresetId: string | null | undefined,
    config = this.cachedRolePresetConfig,
  ) {
    return [
      this.cachedSystemPromptText?.trim() ?? null,
      this.promptTextForRolePreset(rolePresetId, config)?.trim() ?? null,
    ];
  }

  stripPromptPreface(
    value: string | null | undefined,
    rolePresetId: string | null | undefined,
    config = this.cachedRolePresetConfig,
  ) {
    const raw = (value ?? '').trim();
    if (!raw) {
      return null;
    }

    let stripped = raw;
    for (const section of this.promptSections(rolePresetId, config)) {
      if (!section || !stripped.startsWith(section)) {
        continue;
      }
      stripped = stripped.slice(section.length).trim();
    }

    return stripped || null;
  }

  async loadSystemPromptText() {
    try {
      const raw = await readFile(CHAT_SYSTEM_PROMPT_FILE, 'utf8');
      const parsed = JSON.parse(raw) as {
        prompt?: unknown;
        instructions?: unknown;
      };
      const promptText = promptTextFromConfig(parsed);
      this.cachedSystemPromptText = promptText || null;
      return this.cachedSystemPromptText;
    } catch (error) {
      this.warn(`chat system prompt load failed: ${errorMessage(error)}`);
      this.cachedSystemPromptText = null;
      return null;
    }
  }

  async loadRolePresetConfig() {
    try {
      const raw = await readFile(CHAT_ROLE_PRESETS_FILE, 'utf8');
      const parsed = JSON.parse(raw) as {
        defaultPresetId?: unknown;
        presets?: unknown;
      };
      this.cachedRolePresetConfig = this.normalizeChatRolePresetConfig(parsed);
      return this.cachedRolePresetConfig;
    } catch (error) {
      this.warn(`chat role presets load failed: ${errorMessage(error)}`);
      this.cachedRolePresetConfig = {
        defaultPresetId: null,
        presets: [],
      };
      return this.cachedRolePresetConfig;
    }
  }

  apiRolePresets(config = this.cachedRolePresetConfig): ApiChatRolePreset[] {
    return config.presets.map(({ id, label, description }) => ({
      id,
      label,
      description,
      isDefault: config.defaultPresetId === id,
    }));
  }

  apiRolePresetDetails(config = this.cachedRolePresetConfig): ApiChatRolePresetDetail[] {
    return config.presets.map(({ id, label, description, promptText }) => ({
      id,
      label,
      description,
      prompt: promptText,
      isDefault: config.defaultPresetId === id,
    }));
  }

  rolePresetListResponse(config = this.cachedRolePresetConfig): ChatRolePresetListResponse {
    return {
      rolePresets: this.apiRolePresetDetails(config),
      defaultRolePresetId: config.defaultPresetId,
    };
  }
}
