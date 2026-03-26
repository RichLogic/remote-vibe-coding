import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizeWorkspaceFilePath } from './workspace-paths.js';

test('normalizeWorkspaceFilePath keeps relative paths inside the workspace', () => {
  assert.equal(
    normalizeWorkspaceFilePath('/tmp/workspace', './src/index.ts'),
    'src/index.ts',
  );
});

test('normalizeWorkspaceFilePath converts absolute workspace paths to relative paths', () => {
  assert.equal(
    normalizeWorkspaceFilePath('/tmp/workspace', '/tmp/workspace/src/index.ts'),
    'src/index.ts',
  );
});

test('normalizeWorkspaceFilePath leaves out-of-workspace paths unchanged', () => {
  assert.equal(
    normalizeWorkspaceFilePath('/tmp/workspace', '../secret.txt'),
    '../secret.txt',
  );
  assert.equal(
    normalizeWorkspaceFilePath('/tmp/workspace', '/tmp/secret.txt'),
    '/tmp/secret.txt',
  );
});
