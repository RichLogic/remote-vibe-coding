import test from 'node:test';
import assert from 'node:assert/strict';

import { ModelCatalog } from './model-catalog.js';

test('ModelCatalog refreshes visible models and resolves defaults', async () => {
  const catalog = new ModelCatalog({
    async listModels() {
      return [
        {
          id: 'hidden-model',
          displayName: 'Hidden',
          model: 'hidden-model',
          description: 'Hidden model',
          isDefault: false,
          hidden: true,
          defaultReasoningEffort: 'low',
          supportedReasoningEfforts: ['low'],
        },
        {
          id: 'gpt-5-main',
          displayName: 'GPT-5 Main',
          model: 'gpt-5-main',
          description: 'Primary model',
          isDefault: true,
          hidden: false,
          defaultReasoningEffort: 'high',
          supportedReasoningEfforts: ['low', 'medium', 'high'],
        },
      ];
    },
  } as any);

  await catalog.refresh();

  assert.deepEqual(catalog.list().map((entry) => entry.model), ['gpt-5-main']);
  assert.equal(catalog.currentDefaultModel(), 'gpt-5-main');
  assert.equal(catalog.currentDefaultEffort('gpt-5-main'), 'high');
  assert.equal(catalog.resolveOption('missing-model').model, 'gpt-5-main');
});

test('ModelCatalog prefers strongest supported reasoning effort', () => {
  const catalog = new ModelCatalog({
    async listModels() {
      return [];
    },
  } as any);

  assert.equal(
    catalog.preferredReasoningEffortForModel({
      id: 'test',
      displayName: 'Test',
      model: 'test',
      description: 'Test model',
      isDefault: false,
      hidden: false,
      defaultReasoningEffort: 'low',
      supportedReasoningEfforts: ['minimal', 'medium'],
    }),
    'medium',
  );
});

test('ModelCatalog falls back when codex model listing fails', async () => {
  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (message?: unknown) => {
    warnings.push(String(message ?? ''));
  };

  const catalog = new ModelCatalog({
    async listModels() {
      throw new Error('model list unavailable');
    },
  } as any);

  try {
    await catalog.refresh();
  } finally {
    console.warn = originalWarn;
  }

  assert.equal(catalog.currentDefaultModel(), 'gpt-5-codex');
  assert.equal(catalog.currentDefaultEffort('missing-model'), 'xhigh');
  assert.match(warnings[0] ?? '', /model list unavailable/);
});
