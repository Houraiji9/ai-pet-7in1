'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createReloadCoalescer, sanitizeRestorePos } = require('../main/reload-coalescer.js');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test('短时间内多次请求只重建一次，理由合并', async () => {
  const runs = [];
  const c = createReloadCoalescer({ delayMs: 20, snapshot: async () => ({ pos: { rx: 0.2, ry: 0.4 } }), run: async (why, snap) => runs.push({ why, snap }) });
  c.request('素材下载');
  c.request('素材下载');
  c.request('托盘菜单');
  await wait(60);
  assert.equal(runs.length, 1);
  assert.deepEqual(runs[0].why, ['素材下载', '托盘菜单']);
  assert.deepEqual(runs[0].snap.pos, { rx: 0.2, ry: 0.4 });
});

test('拖拽/飞行中先等，松手后再重建', async () => {
  let busy = true;
  const runs = [];
  const c = createReloadCoalescer({ delayMs: 10, retryMs: 10, snapshot: async () => ({ dragging: busy }), run: async () => runs.push(1) });
  c.request('x');
  await wait(60);
  assert.equal(runs.length, 0);
  busy = false;
  await wait(40);
  assert.equal(runs.length, 1);
});

test('一直在拖也不会永远不生效（超过 maxDeferMs 照样重建）', async () => {
  const runs = [];
  const c = createReloadCoalescer({ delayMs: 5, retryMs: 5, maxDeferMs: 30, snapshot: async () => ({ flying: true }), run: async () => runs.push(1) });
  c.request('x');
  await wait(100);
  assert.equal(runs.length, 1);
});

test('重建途中又来了请求 → 结束后再来一次', async () => {
  const runs = [];
  let c;
  c = createReloadCoalescer({ delayMs: 5, retryMs: 5, snapshot: async () => null, run: async (why) => { runs.push(why); if (runs.length === 1) c.request('又来了'); await wait(10); } });
  c.request('第一次');
  await wait(80);
  assert.deepEqual(runs, [['第一次'], ['又来了']]);
});

test('快照失败不卡住重建', async () => {
  const runs = [];
  const c = createReloadCoalescer({ delayMs: 5, snapshot: async () => { throw new Error('窗口没了'); }, run: async (w, snap) => runs.push(snap) });
  c.request('x');
  await wait(40);
  assert.deepEqual(runs, [null]);
});

test('恢复位置：非法值丢弃，越界夹到 [0,1]', () => {
  assert.equal(sanitizeRestorePos(null), null);
  assert.equal(sanitizeRestorePos({ rx: 'a', ry: 1 }), null);
  assert.equal(sanitizeRestorePos({ rx: NaN, ry: 0 }), null);
  assert.deepEqual(sanitizeRestorePos({ rx: 1.7, ry: -3 }), { rx: 1, ry: 0 });
  assert.deepEqual(sanitizeRestorePos({ rx: 0.3, ry: 0.5 }), { rx: 0.3, ry: 0.5 });
});
