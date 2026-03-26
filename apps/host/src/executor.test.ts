import test from 'node:test';
import assert from 'node:assert/strict';

import {
  defaultExecutorForConfiguredExecutors,
  normalizeExecutorInitializationMode,
  resolveConfiguredExecutors,
} from './executor.js';

test('normalizeExecutorInitializationMode accepts supported aliases', () => {
  assert.equal(normalizeExecutorInitializationMode(undefined), 'auto');
  assert.equal(normalizeExecutorInitializationMode('claude'), 'claude-code');
  assert.equal(normalizeExecutorInitializationMode('claude_code'), 'claude-code');
  assert.equal(normalizeExecutorInitializationMode('both'), 'both');
});

test('normalizeExecutorInitializationMode rejects invalid values', () => {
  assert.throws(
    () => normalizeExecutorInitializationMode('invalid-runtime'),
    /Invalid RVC_EXECUTOR_INIT value "invalid-runtime"/,
  );
});

test('resolveConfiguredExecutors keeps auto mode backward compatible', () => {
  assert.deepEqual(resolveConfiguredExecutors({ claudeAvailable: false }), ['codex']);
  assert.deepEqual(resolveConfiguredExecutors({ claudeAvailable: true }), ['codex', 'claude-code']);
});

test('resolveConfiguredExecutors honors explicit runtime selection', () => {
  assert.deepEqual(resolveConfiguredExecutors({ mode: 'codex', claudeAvailable: true }), ['codex']);
  assert.deepEqual(resolveConfiguredExecutors({ mode: 'claude-code', claudeAvailable: false }), ['claude-code']);
  assert.deepEqual(resolveConfiguredExecutors({ mode: 'both', claudeAvailable: false }), ['codex', 'claude-code']);
});

test('defaultExecutorForConfiguredExecutors prefers codex when present', () => {
  assert.equal(defaultExecutorForConfiguredExecutors(['codex', 'claude-code']), 'codex');
  assert.equal(defaultExecutorForConfiguredExecutors(['claude-code']), 'claude-code');
});
