'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createSpeciesStore, validateSpeciesRaw } = require('../main/species.js');

const APP = path.join(__dirname, '..');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'aipet-schema-'));
const write = (dir, v) => fs.writeFileSync(path.join(dir, 'species.jsonc'), typeof v === 'string' ? v : JSON.stringify(v));
const GOOD = { size: 300, species: { deepseek: { name: '小鲸', animations: { idle: ['待机呼吸休闲'] } } } };

test('null → 不崩，报 (根) 错误，退回自带配置', () => {
  const u = tmp();
  write(u, 'null');
  const st = createSpeciesStore({ appRoot: APP, userDir: u }).get();
  assert.equal(st.broken, true);
  assert.equal(st.source, 'bundled');
  assert.ok(st.errors.some((e) => /\(根\)/.test(e)));
  assert.equal(st.species.deepseek.name, 'DeepSeek 娘');
});

test('{} → 不再静默变成 0 个角色，而是报「缺少 species」并退回', () => {
  const u = tmp();
  write(u, {});
  const store = createSpeciesStore({ appRoot: APP, userDir: u });
  assert.equal(store.get().broken, true);
  assert.ok(store.get().errors.some((e) => /species: 缺少/.test(e)));
  assert.equal(store.isAvailable('deepseek'), true);
});

test('events.whisper = {} → 不崩，带字段路径的警告，其余配置照用', () => {
  const u = tmp();
  write(u, { species: { deepseek: { name: '小鲸', animations: { idle: ['待机呼吸休闲'], events: { whisper: {} } } } } });
  const store = createSpeciesStore({ appRoot: APP, userDir: u });
  const st = store.get();
  assert.equal(st.broken, false);
  assert.ok(st.errors.some((e) => e.includes('species.deepseek.animations.events.whisper')));
  assert.equal(st.species.deepseek.name, '小鲸');
  const cfg = store.mergedConfig();
  assert.ok(Array.isArray(cfg.deepseek.animations.events.whisper));
  assert.ok(store.describe('deepseek'));
});

test('字段类型错误带路径', () => {
  const v = validateSpeciesRaw({ species: { gpt: { enabled: 'yes', whisperLines: 'x', animations: { idle: 'a', moves: { actions: [1] } } } } });
  const all = v.fatal.concat(v.warnings).join('\n');
  assert.match(all, /species\.gpt\.enabled/);
  assert.match(all, /species\.gpt\.whisperLines/);
  assert.match(all, /species\.gpt\.animations\.idle/);
  assert.match(all, /species\.gpt\.animations\.moves\.actions\[0\]/);
});

test('重载时配置坏了 → 用上一次能用的（不是自带的），用户文件不被改写', () => {
  const u = tmp();
  write(u, GOOD);
  const store = createSpeciesStore({ appRoot: APP, userDir: u });
  assert.equal(store.get().size, 300);
  write(u, '{ 坏了');
  const before = fs.readFileSync(path.join(u, 'species.jsonc'), 'utf8');
  store.load();
  assert.equal(store.get().source, 'last-good');
  assert.equal(store.get().size, 300);
  assert.equal(store.get().species.deepseek.name, '小鲸');
  assert.equal(fs.readFileSync(path.join(u, 'species.jsonc'), 'utf8'), before);
  write(u, null);
  store.load();
  assert.equal(store.get().source, 'last-good');
});

test('用户把所有角色都禁用 ≠ 配置损坏', () => {
  const u = tmp();
  const species = {};
  for (const id of ['deepseek', 'gpt']) species[id] = { enabled: false, animations: { idle: ['待机呼吸休闲'] } };
  write(u, { species });
  const st = createSpeciesStore({ appRoot: APP, userDir: u }).get();
  assert.equal(st.broken, false);
  assert.equal(st.allDisabled, true);
  assert.deepEqual(st.errors, []);
});

test('自带配置通过校验、没有警告', () => {
  const st = createSpeciesStore({ appRoot: APP, userDir: tmp() }).get();
  assert.equal(st.broken, false);
  assert.equal(st.allDisabled, false);
  assert.deepEqual(st.errors, []);
});

test('agents.jsonc：部分规则写错 → 保留其余规则，提示文字说「跳过」而不是「已用默认规则」', () => {
  const { resolveAgentsConfig, agentsNotice } = require('../main/matcher.js');
  const { parseJsonc } = require('../main/jsonc.js');
  const bundled = parseJsonc(fs.readFileSync(path.join(APP, 'config', 'agents.jsonc'), 'utf8'));
  const user = { rules: [{ id: 'mine', character: 'gpt', executables: ['Mine.exe'] }, { id: 'bad', character: 'nope', executables: ['x.exe'] }] };
  const r = resolveAgentsConfig(user, bundled, '');
  assert.equal(r.fallback, 'partial');
  assert.deepEqual(r.config.rules.map((x) => x.id), ['mine']);
  assert.match(agentsNotice(r.fallback), /跳过/);
  assert.doesNotMatch(agentsNotice(r.fallback), /默认规则|自带/);
  const r2 = resolveAgentsConfig(null, bundled, '');
  assert.equal(r2.fallback, 'bundled');
  assert.ok(r2.config.rules.length > 0);
  assert.match(agentsNotice('bundled'), /自带/);
  const r3 = resolveAgentsConfig(null, bundled, '读取失败');
  assert.deepEqual(r3.errors, ['读取失败']);
  assert.equal(resolveAgentsConfig(bundled, bundled, '').fallback, 'none');
});
