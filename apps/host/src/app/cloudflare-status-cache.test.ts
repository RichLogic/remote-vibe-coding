import test from 'node:test';
import assert from 'node:assert/strict';

import { CloudflareStatusCache } from './cloudflare-status-cache.js';

function buildStatus(publicUrl: string | null) {
  return {
    installed: true,
    version: '2026.3.0',
    state: 'connected' as const,
    mode: 'quick' as const,
    tunnelName: null,
    publicUrl,
    targetUrl: 'http://127.0.0.1:8787',
    targetSource: 'host' as const,
    connectorCount: 1,
    activeSource: 'local-manager' as const,
    startedAt: '2026-01-01T00:00:00.000Z',
    lastError: null,
    recentLogs: [],
  };
}

test('CloudflareStatusCache deduplicates concurrent refresh calls', async () => {
  let calls = 0;
  const cache = new CloudflareStatusCache({
    async getStatus() {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 10));
      return buildStatus(`https://example-${calls}.trycloudflare.com`);
    },
  } as any);

  const [left, right] = await Promise.all([cache.refresh(), cache.refresh()]);

  assert.equal(calls, 1);
  assert.equal(left.publicUrl, right.publicUrl);
});

test('CloudflareStatusCache serves primed cache until cleared', async () => {
  let calls = 0;
  const cache = new CloudflareStatusCache({
    async getStatus() {
      calls += 1;
      return buildStatus(`https://cached-${calls}.trycloudflare.com`);
    },
  } as any);

  cache.prime(buildStatus('https://primed.trycloudflare.com'));

  const first = await cache.get();
  const second = await cache.get({ preferFresh: true });

  assert.equal(first.publicUrl, 'https://primed.trycloudflare.com');
  assert.equal(second.publicUrl, 'https://primed.trycloudflare.com');
  assert.equal(calls, 0);

  cache.clear();
  const refreshed = await cache.get();
  assert.equal(refreshed.publicUrl, 'https://cached-1.trycloudflare.com');
  assert.equal(calls, 1);
});

test('CloudflareStatusCache can refresh in background while returning stale cache', async () => {
  let calls = 0;
  const cache = new CloudflareStatusCache({
    async getStatus() {
      calls += 1;
      return buildStatus(`https://fresh-${calls}.trycloudflare.com`);
    },
  } as any);

  cache.prime(buildStatus('https://stale.trycloudflare.com'));
  const status = await cache.get();

  assert.equal(status.publicUrl, 'https://stale.trycloudflare.com');
  assert.equal(calls, 0);
});
