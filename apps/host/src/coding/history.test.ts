import test from 'node:test';
import assert from 'node:assert/strict';

import type {
  SessionCommandEvent,
  SessionFileChangeEvent,
  SessionTranscriptEntry,
} from '../types.js';
import { buildPersistedCodingHistory, summarizePersistedCodingHistory } from './history.js';

function buildTranscriptEntry(overrides: Partial<SessionTranscriptEntry> = {}): SessionTranscriptEntry {
  const entry: SessionTranscriptEntry = {
    id: overrides.id ?? 'entry-1',
    index: overrides.index ?? 0,
    kind: overrides.kind ?? 'assistant',
    body: overrides.body ?? 'body',
    markdown: overrides.markdown ?? true,
    label: overrides.label ?? null,
    title: overrides.title ?? null,
    meta: overrides.meta ?? null,
    attachments: overrides.attachments ?? [],
  };
  if (overrides.fileChanges) {
    entry.fileChanges = overrides.fileChanges;
  }
  return entry;
}

function buildCommand(overrides: Partial<SessionCommandEvent> = {}): SessionCommandEvent {
  return {
    id: overrides.id ?? 'command-1',
    index: overrides.index ?? 0,
    command: overrides.command ?? 'npm test',
    cwd: overrides.cwd ?? '/tmp/repo',
    status: overrides.status ?? 'completed',
    exitCode: overrides.exitCode ?? 0,
    output: overrides.output ?? 'ok',
  };
}

function buildChange(overrides: Partial<SessionFileChangeEvent> = {}): SessionFileChangeEvent {
  return {
    id: overrides.id ?? 'change-1',
    index: overrides.index ?? 0,
    path: overrides.path ?? 'src/index.ts',
    kind: overrides.kind ?? 'update',
    status: overrides.status ?? 'completed',
    diff: overrides.diff ?? null,
  };
}

test('buildPersistedCodingHistory flattens turn projections and reindexes items', () => {
  const result = buildPersistedCodingHistory([
    {
      transcriptEntries: [
        buildTranscriptEntry({ id: 'entry-1', index: 0 }),
        buildTranscriptEntry({ id: 'entry-2', index: 1 }),
      ],
      commands: [buildCommand({ id: 'command-1', index: 3 })],
      changes: [buildChange({ id: 'change-1', index: 4 })],
    },
    {
      transcriptEntries: [buildTranscriptEntry({ id: 'entry-3', index: 0 })],
      commands: [buildCommand({ id: 'command-2', index: 0 })],
      changes: [buildChange({ id: 'change-2', index: 0 })],
    },
  ]);

  assert.deepEqual(
    result.transcriptEntries.map((entry) => ({ id: entry.id, index: entry.index })),
    [
      { id: 'entry-1', index: 0 },
      { id: 'entry-2', index: 1 },
      { id: 'entry-3', index: 2 },
    ],
  );
  assert.deepEqual(
    result.commands.map((entry) => ({ id: entry.id, index: entry.index })),
    [
      { id: 'command-1', index: 0 },
      { id: 'command-2', index: 1 },
    ],
  );
  assert.deepEqual(
    result.changes.map((entry) => ({ id: entry.id, index: entry.index })),
    [
      { id: 'change-1', index: 0 },
      { id: 'change-2', index: 1 },
    ],
  );
});

test('summarizePersistedCodingHistory keeps transcript count without flattening entries', () => {
  const result = summarizePersistedCodingHistory([
    {
      transcriptEntries: [
        buildTranscriptEntry({ id: 'entry-1', index: 0 }),
        buildTranscriptEntry({ id: 'entry-2', index: 1 }),
      ],
      commands: [buildCommand({ id: 'command-1', index: 3 })],
      changes: [buildChange({ id: 'change-1', index: 4 })],
    },
    {
      transcriptEntries: [buildTranscriptEntry({ id: 'entry-3', index: 0 })],
      commands: [buildCommand({ id: 'command-2', index: 0 })],
      changes: [buildChange({ id: 'change-2', index: 0 })],
    },
  ]);

  assert.equal(result.transcriptTotal, 3);
  assert.deepEqual(
    result.commands.map((entry) => ({ id: entry.id, index: entry.index })),
    [
      { id: 'command-1', index: 0 },
      { id: 'command-2', index: 1 },
    ],
  );
  assert.deepEqual(
    result.changes.map((entry) => ({ id: entry.id, index: entry.index })),
    [
      { id: 'change-1', index: 0 },
      { id: 'change-2', index: 1 },
    ],
  );
});
