import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

import { ClaudeCodeCliRuntime } from './claude-code-runtime.js';

class FakeChildProcess extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  killed = false;

  kill() {
    this.killed = true;
    this.emit('exit', 0, 'SIGTERM');
    return true;
  }
}

test('ClaudeCodeCliRuntime builds a synthetic thread from Claude stream-json output', async () => {
  const children: FakeChildProcess[] = [];
  const runtime = new ClaudeCodeCliRuntime({
    executable: '/opt/homebrew/bin/claude',
    spawnProcess: () => {
      const child = new FakeChildProcess();
      children.push(child);
      return child as any;
    },
    randomId: (() => {
      const ids = ['thread-1', 'turn-1'];
      return () => ids.shift() ?? 'id-fallback';
    })(),
    now: (() => {
      let current = 1000;
      return () => ++current;
    })(),
  });

  const notifications: string[] = [];
  runtime.on('notification', (message) => {
    notifications.push(message.method);
  });

  const threadResponse = await runtime.startThread({
    cwd: '/tmp/project',
    securityProfile: 'repo-write',
    model: 'sonnet',
  });
  const turnResponse = await runtime.startTurn(threadResponse.thread.id, [{
    type: 'text',
    text: 'Fix the bug',
    text_elements: [],
  }], {
    model: 'sonnet',
    approvalMode: 'less-interruption',
    securityProfile: 'repo-write',
  });

  assert.equal(turnResponse.turn.id, 'turn-1');

  const child = children[0];
  assert.ok(child);
  child.stdout.write('{"type":"system","subtype":"init","claude_code_version":"2.1.76","model":"claude-sonnet-4-6"}\n');
  child.stdout.write('{"type":"assistant","message":{"content":[{"type":"text","text":"Done."}]}}\n');
  child.stdout.write('{"type":"result","is_error":false,"result":"Done."}\n');
  child.emit('exit', 0, null);

  await new Promise((resolve) => setTimeout(resolve, 10));

  const thread = await runtime.readThread('thread-1');
  assert.equal((thread.thread as { turns?: Array<{ status: string }> } | null)?.turns?.[0]?.status, 'completed');
  assert.equal((thread.thread as { cliVersion?: string } | null)?.cliVersion, '2.1.76');
  assert.deepEqual(notifications, [
    'thread/status/changed',
    'thread/status/changed',
    'turn/completed',
  ]);
});

test('ClaudeCodeCliRuntime interrupts active turns', async () => {
  const children: FakeChildProcess[] = [];
  const runtime = new ClaudeCodeCliRuntime({
    executable: '/opt/homebrew/bin/claude',
    spawnProcess: () => {
      const child = new FakeChildProcess();
      children.push(child);
      return child as any;
    },
    randomId: (() => {
      const ids = ['thread-2', 'turn-2'];
      return () => ids.shift() ?? 'id-fallback';
    })(),
  });

  const threadResponse = await runtime.startThread({
    cwd: '/tmp/project',
    securityProfile: 'repo-write',
    model: 'sonnet',
  });
  await runtime.startTurn(threadResponse.thread.id, [{
    type: 'text',
    text: 'Stop me',
    text_elements: [],
  }], {
    model: 'sonnet',
    approvalMode: 'detailed',
    securityProfile: 'repo-write',
  });

  await runtime.interruptTurn('thread-2', 'turn-2');
  await new Promise((resolve) => setTimeout(resolve, 10));

  const thread = await runtime.readThread('thread-2');
  assert.equal(children[0]?.killed, true);
  assert.equal((thread.thread as { turns?: Array<{ status: string }> } | null)?.turns?.[0]?.status, 'interrupted');
});
