import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';

import { ChatPromptConfigStore } from './chat-prompt-config.js';
import { CHAT_ROLE_PRESETS_FILE, CHAT_SYSTEM_PROMPT_FILE } from './config.js';

async function readOrNull(path: string) {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return null;
  }
}

async function restoreFile(path: string, content: string | null) {
  if (content === null) {
    return;
  }
  await writeFile(path, content, 'utf8');
}

test('chat prompt config store loads, normalizes, saves, and strips prompt sections', { concurrency: false }, async (t) => {
  const originalRolePresets = await readOrNull(CHAT_ROLE_PRESETS_FILE);
  const originalSystemPrompt = await readOrNull(CHAT_SYSTEM_PROMPT_FILE);
  t.after(async () => {
    await restoreFile(CHAT_ROLE_PRESETS_FILE, originalRolePresets);
    await restoreFile(CHAT_SYSTEM_PROMPT_FILE, originalSystemPrompt);
  });

  await writeFile(CHAT_ROLE_PRESETS_FILE, JSON.stringify({
    defaultPresetId: 'missing',
    presets: [
      {
        id: 'preset-1',
        label: 'Preset 1',
        instructions: ['Line 1', 'Line 2'],
      },
      {
        id: 'preset-1',
        label: 'Duplicate',
        prompt: 'Should be dropped',
      },
      {
        id: '',
        label: 'Invalid',
        prompt: '',
      },
    ],
  }), 'utf8');
  await writeFile(CHAT_SYSTEM_PROMPT_FILE, JSON.stringify({
    prompt: 'System preface',
  }), 'utf8');

  const warnings: string[] = [];
  const store = new ChatPromptConfigStore((message) => warnings.push(message));

  const loadedConfig = await store.loadRolePresetConfig();
  assert.deepEqual(loadedConfig, {
    defaultPresetId: null,
    presets: [{
      id: 'preset-1',
      label: 'Preset 1',
      description: null,
      promptText: 'Line 1\nLine 2',
    }],
  });

  const systemPrompt = await store.loadSystemPromptText();
  assert.equal(systemPrompt, 'System preface');

  const savedConfig = await store.saveRolePresetConfig({
    defaultPresetId: 'preset-1',
    presets: [{
      id: 'preset-1',
      label: 'Preset 1',
      description: 'Description',
      promptText: 'Prompt body',
    }],
  });
  assert.equal(savedConfig.defaultPresetId, 'preset-1');
  assert.equal(store.promptTextForRolePreset('preset-1'), 'Prompt body');
  assert.equal(
    store.stripPromptPreface('System preface\nPrompt body\nUser question', 'preset-1'),
    'User question',
  );
  assert.deepEqual(store.apiRolePresets(savedConfig), [{
    id: 'preset-1',
    label: 'Preset 1',
    description: 'Description',
    isDefault: true,
  }]);
  assert.deepEqual(warnings, []);
});
