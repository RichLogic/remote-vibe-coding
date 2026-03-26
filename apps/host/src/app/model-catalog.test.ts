import test from 'node:test';
import assert from 'node:assert/strict';

import { ModelCatalog } from './model-catalog.js';
import type { AgentRuntimeRegistry } from './agent-runtime.js';

function createRegistryHarness(entries: AgentRuntimeRegistry['entries']) {
  return {
    defaultExecutor: () => 'codex' as const,
    supportedExecutors: () => entries().map(({ executor }) => executor),
    entries,
  };
}

test('ModelCatalog refreshes visible models and resolves defaults', async () => {
  const catalog = new ModelCatalog(createRegistryHarness(() => [{
    executor: 'codex',
    runtime: {
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
    } as any,
  }]));

  await catalog.refresh();

  assert.deepEqual(catalog.list().map((entry) => entry.model), ['gpt-5-main']);
  assert.deepEqual(catalog.listByExecutor(), {
    codex: catalog.list(),
  });
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

  const catalog = new ModelCatalog(createRegistryHarness(() => [{
    executor: 'codex',
    runtime: {
      async listModels() {
        throw new Error('model list unavailable');
      },
    } as any,
  }]));

  try {
    await catalog.refresh();
  } finally {
    console.warn = originalWarn;
  }

  assert.equal(catalog.currentDefaultModel(), 'gpt-5-codex');
  assert.equal(catalog.currentDefaultEffort('missing-model'), 'xhigh');
  assert.match(warnings[0] ?? '', /model list unavailable/);
});

test('ModelCatalog tracks models separately for each executor', async () => {
  const catalog = new ModelCatalog(createRegistryHarness(() => [
    {
      executor: 'codex',
      runtime: {
        async listModels() {
          return [{
            id: 'gpt-5-codex',
            displayName: 'GPT-5 Codex',
            model: 'gpt-5-codex',
            description: 'Codex model',
            isDefault: true,
            hidden: false,
            defaultReasoningEffort: 'high',
            supportedReasoningEfforts: ['medium', 'high'],
          }];
        },
      } as any,
    },
    {
      executor: 'claude-code',
      runtime: {
        async listModels() {
          return [{
            id: 'claude-code-main',
            displayName: 'Claude Code Main',
            model: 'claude-code-main',
            description: 'Claude model',
            isDefault: true,
            hidden: false,
            defaultReasoningEffort: 'medium',
            supportedReasoningEfforts: ['low', 'medium'],
          }];
        },
      } as any,
    },
  ]));

  await catalog.refresh();

  assert.equal(catalog.currentDefaultModel('codex'), 'gpt-5-codex');
  assert.equal(catalog.currentDefaultModel('claude-code'), 'claude-code-main');
  assert.equal(catalog.findByModel('claude-code-main', 'claude-code')?.model, 'claude-code-main');
  assert.deepEqual(catalog.listByExecutor(), {
    codex: catalog.list('codex'),
    'claude-code': catalog.list('claude-code'),
  });
});
