'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { migrateUserConfigs } = require('../main/config-migrate.js');

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aipet-mig-'));
  const appRoot = path.join(root, 'app');
  const userDir = path.join(root, 'user');
  fs.mkdirSync(path.join(appRoot, 'config'), { recursive: true });
  fs.writeFileSync(path.join(appRoot, 'config', 'agents.jsonc'), 'NEW-agents');
  fs.writeFileSync(path.join(appRoot, 'config', 'species.jsonc'), 'NEW-species');
  const hashes = { 'agents.jsonc': [sha('OLD-agents')], 'species.jsonc': [sha('OLD-species')] };
  return { appRoot, userDir, hashes };
}
const rd = (d, n) => fs.readFileSync(path.join(d, n), 'utf8');
const noTmp = (d) => assert.deepEqual(fs.readdirSync(d).filter((n) => n.includes('.tmp-')), []);

test('全新安装：复制自带配置', () => {
  const f = fixture();
  const r = migrateUserConfigs(f);
  assert.deepEqual(r, { 'agents.jsonc': 'created', 'species.jsonc': 'created' });
  assert.equal(rd(f.userDir, 'species.jsonc'), 'NEW-species');
  noTmp(f.userDir);
});

test('旧版自带（没改过）：升级并留 .bak', () => {
  const f = fixture();
  fs.mkdirSync(f.userDir, { recursive: true });
  fs.writeFileSync(path.join(f.userDir, 'species.jsonc'), 'OLD-species');
  const r = migrateUserConfigs(f);
  assert.equal(r['species.jsonc'], 'upgraded');
  assert.equal(rd(f.userDir, 'species.jsonc'), 'NEW-species');
  assert.equal(rd(f.userDir, 'species.jsonc.bak'), 'OLD-species');
  noTmp(f.userDir);
});

test('用户改过：一个字节都不动', () => {
  const f = fixture();
  fs.mkdirSync(f.userDir, { recursive: true });
  fs.writeFileSync(path.join(f.userDir, 'species.jsonc'), 'MY-EDIT');
  const r = migrateUserConfigs(f);
  assert.equal(r['species.jsonc'], 'user-modified');
  assert.equal(rd(f.userDir, 'species.jsonc'), 'MY-EDIT');
  assert.equal(fs.existsSync(path.join(f.userDir, 'species.jsonc.bak')), false);
});

test('重复启动：第二次什么都不做', () => {
  const f = fixture();
  fs.mkdirSync(f.userDir, { recursive: true });
  fs.writeFileSync(path.join(f.userDir, 'agents.jsonc'), 'OLD-agents');
  migrateUserConfigs(f);
  const r = migrateUserConfigs(f);
  assert.deepEqual(r, { 'agents.jsonc': 'current', 'species.jsonc': 'current' });
  assert.equal(rd(f.userDir, 'agents.jsonc.bak'), 'OLD-agents');
});

test('写入失败（改名失败）：原文件保持旧内容，不留临时文件，不抛异常', () => {
  const f = fixture();
  fs.mkdirSync(f.userDir, { recursive: true });
  fs.writeFileSync(path.join(f.userDir, 'species.jsonc'), 'OLD-species');
  const logs = [];
  const failing = { ...fs, renameSync(a, b) { if (b.endsWith('species.jsonc')) throw new Error('EPERM 模拟'); return fs.renameSync(a, b); } };
  const r = migrateUserConfigs({ ...f, fs: failing, log: (m) => logs.push(m) });
  assert.equal(r['species.jsonc'], 'error');
  assert.equal(r['agents.jsonc'], 'created');
  assert.equal(rd(f.userDir, 'species.jsonc'), 'OLD-species');
  assert.ok(logs.some((m) => /EPERM 模拟/.test(m)));
  noTmp(f.userDir);
  // 下次启动成功补上
  assert.equal(migrateUserConfigs(f)['species.jsonc'], 'upgraded');
});

test('main.js 在建角色库之前同步配置', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'main', 'main.js'), 'utf8');
  const a = src.indexOf('ensureUserConfigCopies();');
  const b = src.indexOf('const store = createSpeciesStore(');
  assert.ok(a > 0 && b > 0 && a < b, '同步配置必须在 createSpeciesStore 之前');
});

test('真实的自带配置哈希表里包含当前自带版本（升级后不会被当成用户修改）', () => {
  const app = path.join(__dirname, '..');
  const hashes = require('../main/shipped-config-hashes.json');
  for (const n of ['agents.jsonc', 'species.jsonc']) {
    assert.ok(Array.isArray(hashes[n]) && hashes[n].length > 0);
  }
  void app;
});
