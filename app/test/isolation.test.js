'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { isLoopbackUrl, guardFetch } = require('../main/test-guard.js');
const { codexSpawnSpec } = require('../main/balance/codex.js');

test('isLoopbackUrl：只放行本机地址', () => {
  for (const u of ['http://127.0.0.1:8080/x', 'http://localhost/', 'http://[::1]:3/', 'file:///tmp/a']) assert.ok(isLoopbackUrl(u), u);
  for (const u of ['https://api.deepseek.com/user/balance', 'https://chatgpt.com/', 'http://10.0.0.1/', 'http://127.0.0.1.evil.com/', 'not a url']) assert.ok(!isLoopbackUrl(u), u);
});

test('guardFetch：外网直接拒绝、不调用真实 fetch；本机照常', async () => {
  const calls = [];
  const blocked = [];
  const f = guardFetch(async (u) => (calls.push(u), 'ok'), (u) => blocked.push(u));
  await assert.rejects(f('https://api.deepseek.com/user/balance'), /禁止访问外网/);
  assert.deepStrictEqual(calls, []);
  assert.deepStrictEqual(blocked, ['https://api.deepseek.com/user/balance']);
  assert.strictEqual(await f('http://127.0.0.1:1/x'), 'ok');
});

test('codexSpawnSpec：JSON 数组形式 = 解释器 + 脚本（不依赖 shebang），并要求 ELECTRON_RUN_AS_NODE', () => {
  const spec = codexSpawnSpec(JSON.stringify(['C:\\e\\electron.exe', 'C:\\t\\fake-codex.js']), 'win32');
  assert.strictEqual(spec.command, 'C:\\e\\electron.exe');
  assert.deepStrictEqual(spec.args.slice(0, 1), ['C:\\t\\fake-codex.js']);
  assert.ok(spec.args.includes('app-server'));
  assert.strictEqual(spec.runAsNode, true);
  // 普通路径不受影响
  assert.strictEqual(codexSpawnSpec('codex', 'linux').command, 'codex');
  assert.strictEqual(codexSpawnSpec('[broken', 'linux').command, '[broken');
});

test('readCodexRpc：JSON 数组命令把 ELECTRON_RUN_AS_NODE 传给子进程', async () => {
  const { EventEmitter } = require('node:events');
  const { readCodexRpc } = require('../main/balance/codex.js');
  let seenEnv = null;
  const spawn = (cmd, args, opts) => {
    seenEnv = opts.env;
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = { write: (line) => { const m = JSON.parse(line); if (m.id !== undefined) setImmediate(() => child.stdout.emit('data', JSON.stringify({ id: m.id, result: {} }) + '\n')); return true; }, end() {}, on() {} };
    child.kill = () => {};
    child.pid = 1;
    return child;
  };
  await readCodexRpc({ env: { AIPET_CODEX_COMMAND: JSON.stringify(['/bin/node', '/tmp/fake.js']) }, platform: 'linux', spawn }).catch(() => {});
  assert.ok(seenEnv, 'spawn 被调用');
  assert.strictEqual(seenEnv.ELECTRON_RUN_AS_NODE, '1');
});
