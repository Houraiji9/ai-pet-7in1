'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createBalanceRequests } = require('../main/balance/requests.js');
const { createBalanceGuard } = require('../renderer/balance-guard.js');
const { createPetApi } = require('../main/pet-api.js');

function deferred() {
  let resolve;
  const p = new Promise((r) => (resolve = r));
  return { p, resolve };
}

test('结果带 petId / seq / at，写给当前角色', async () => {
  const written = [];
  const r = createBalanceRequests({ query: async (id) => ({ ok: true, character: id, source: 'x' }), write: (l) => written.push(l), current: () => 'gpt', now: () => 123 });
  const out = await r.request('gpt');
  assert.equal(out.written, true);
  assert.deepEqual([written[0].petId, written[0].seq, written[0].at], ['gpt', 1, 123]);
});

test('查询途中切换了角色 → 旧角色的结果不写出（只进缓存）', async () => {
  let cur = 'gpt';
  const d = deferred();
  const written = [];
  const r = createBalanceRequests({ query: () => d.p, write: (l) => written.push(l), current: () => cur });
  const pending = r.request('gpt');
  cur = 'deepseek';
  d.resolve({ ok: true, character: 'gpt', source: 'codex' });
  const out = await pending;
  assert.equal(out.reason, 'switched');
  assert.equal(written.length, 0);
  assert.equal(r.cached('gpt').length, 1);
  assert.equal(r.cached('deepseek').length, 0);
});

test('同一角色乱序返回 → 只认最新一次请求', async () => {
  const d1 = deferred();
  const d2 = deferred();
  const qs = [d1, d2];
  const written = [];
  const r = createBalanceRequests({ query: () => qs.shift().p, write: (l) => written.push(l), current: () => 'gpt' });
  const a = r.request('gpt');
  const b = r.request('gpt');
  d2.resolve({ ok: true, v: 'new' });
  d1.resolve({ ok: true, v: 'old' });
  assert.equal((await b).written, true);
  assert.equal((await a).reason, 'stale');
  assert.deepEqual(written.map((l) => l.v), ['new']);
});

test('缓存按 角色+来源 分开', async () => {
  const r = createBalanceRequests({ query: async (id) => ({ ok: true, source: id === 'glm' ? 'zcode' : 'key' }), write() {}, current: () => 'glm' });
  await r.request('glm');
  await r.request('deepseek');
  assert.equal(r.cached('glm')[0].source, 'zcode');
  assert.equal(r.cached('deepseek')[0].source, 'key');
});

test('渲染端：别的角色的结果、旧 seq 的结果都丢掉', () => {
  const g = createBalanceGuard();
  assert.deepEqual(g.accept({ petId: 'gpt', seq: 1 }, 'deepseek'), { ok: false, reason: 'other-pet' });
  assert.deepEqual(g.accept({ petId: 'gpt', seq: 2 }, 'gpt'), { ok: true });
  assert.deepEqual(g.accept({ petId: 'gpt', seq: 2 }, 'gpt'), { ok: false, reason: 'stale' });
  assert.deepEqual(g.accept({ petId: 'gpt', seq: 1 }, 'gpt'), { ok: false, reason: 'stale' });
  assert.deepEqual(g.accept({ character: 'gpt', seq: 3 }, 'gpt'), { ok: true });
});

test('/balance 把请求里的 petId 交给主进程', async () => {
  const got = [];
  const store = { mergedConfig: () => ({}), resolveAnim: () => null, get: () => ({ species: {} }), isAvailable: () => true, describe: () => null };
  const api = createPetApi({ store, appRoot: __dirname, onBalance: (id) => got.push(id) });
  api.handle('POST', '/dsh-pet-7340/balance?pet=glm');
  await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(got, ['glm']);
});
