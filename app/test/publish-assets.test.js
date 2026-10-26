'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { buildPack, validateManifest, publish, CORE } = require('../tools/publish-assets.js');

const ROLES = ['a', 'b'];
function fixture(extra = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pubassets-'));
  const put = (id, name, body) => { const d = path.join(root, 'assets', id, 'webm'); fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, name + '.webm'), body); };
  put('a', CORE, 'A-core'); put('a', '走路', 'A-walk'); put('b', CORE, 'B-core'); put('b', '复制', 'A-walk');
  for (const [k, v] of Object.entries(extra)) put(k.split('/')[0], k.split('/')[1], v);
  const out = path.join(root, 'out');
  return { root, out, ...buildPack({ root, out, roles: ROLES }) };
}
function fakeRemote(initial = [], { dropUpload } = {}) {
  const remote = new Map(initial.map((a) => [a.name, a.size]));
  const order = [];
  return { order, remote, ops: {
    listRemote: async () => [...remote].map(([name, size]) => ({ name, size })),
    upload: async (ps) => { for (const p of ps) { const n = path.basename(p); order.push(n); if (n !== dropUpload) remote.set(n, fs.statSync(p).size); } },
  } };
}

test('09 清单校验：正常 fixture 通过，去重', () => {
  const f = fixture();
  assert.deepStrictEqual(validateManifest(f.manifest, { out: f.out, roles: ROLES }), []);
  assert.strictEqual(f.blobs.size, 3);
});

test('09 空清单 / 缺核心 / 坏哈希 / 文件被改 → 拒绝', () => {
  const f = fixture();
  assert.deepStrictEqual(validateManifest({ schema: 1, files: [] }), ['清单为空']);
  const noCore = { schema: 1, files: f.manifest.files.filter((x) => !(x.id === 'a' && x.name === CORE)) };
  assert.ok(validateManifest(noCore, { roles: ROLES }).some((e) => e.includes('核心')));
  const bad = { schema: 1, files: f.manifest.files.map((x) => ({ ...x, sha256: 'zz', name: '../x' })) };
  const errs = validateManifest(bad, { roles: ROLES });
  assert.ok(errs.some((e) => e.includes('sha256')) && errs.some((e) => e.includes('名字')));
  fs.writeFileSync(path.join(f.out, f.manifest.files[0].sha256 + '.webm'), 'tampered!!');
  assert.ok(validateManifest(f.manifest, { out: f.out, roles: ROLES }).length > 0);
});

test('09 上传顺序：先文件，确认后最后传 manifest；已存在同大小的跳过', async () => {
  const f = fixture();
  const first = f.manifest.files[0];
  const r = fakeRemote([{ name: first.sha256 + '.webm', size: first.size }]);
  const res = await publish({ manifest: f.manifest, out: f.out, ops: r.ops, roles: ROLES });
  assert.strictEqual(res.skipped, 1);
  assert.strictEqual(r.order.length, 3);
  assert.strictEqual(r.order.at(-1), 'manifest.json');
  assert.ok(!r.order.includes(first.sha256 + '.webm'));
});

test('09 远端确认失败 / 清单残缺 → 不上传 manifest', async () => {
  const f = fixture();
  const drop = f.manifest.files[1].sha256 + '.webm';
  const r = fakeRemote([], { dropUpload: drop });
  await assert.rejects(publish({ manifest: f.manifest, out: f.out, ops: r.ops, roles: ROLES }), /远端确认失败/);
  assert.ok(!r.order.includes('manifest.json'));
  const r2 = fakeRemote();
  await assert.rejects(publish({ manifest: { schema: 1, files: [] }, out: f.out, ops: r2.ops, roles: ROLES }), /不发布/);
  assert.strictEqual(r2.order.length, 0);
});
