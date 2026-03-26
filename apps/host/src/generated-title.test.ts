import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizeChatGeneratedTitle, normalizeGeneratedTitle } from './generated-title.js';

test('chat titles prefer a compact first clause for long Chinese prompts', () => {
  assert.equal(
    normalizeChatGeneratedTitle('我在做一个面向设计师的作品集网站，想让你帮我梳理首页信息架构、视觉方向和首屏文案。'),
    '我在做一个面向设计师的作品集网站',
  );
});

test('chat titles strip generic prefixes before truncating', () => {
  assert.equal(
    normalizeChatGeneratedTitle('请帮我看下这个报错：TypeError: Cannot read properties of undefined when opening dashboard after login'),
    'TypeError: Cannot read properties…',
  );
});

test('generic title normalization still keeps the wider default length', () => {
  assert.equal(
    normalizeGeneratedTitle('Build a pricing page for a B2B analytics SaaS with annual discount positioning and enterprise upsell'),
    'Build a pricing page for a B2B analytics SaaS with annual…',
  );
});
