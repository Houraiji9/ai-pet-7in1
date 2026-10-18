'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { parseJsonc } = require('../main/jsonc.js');
const { createSpeciesStore, referencedAnims } = require('../main/species.js');
const { createPetApi } = require('../main/pet-api.js');

const APP = path.join(__dirname, '..');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'aipet-test-'));

test('JSONC：注释、尾逗号、字符串里的 // 与逗号', () => {
  const v = parseJsonc('\uFEFF{\n // c\n "a": "http://x,y", /* b */ "b": [1,2,],\n}');
  assert.deepEqual(v, { a: 'http://x,y', b: [1, 2] });
  assert.deepEqual(parseJsonc('{"s":"a\\"//b"}'), { s: 'a"//b' });
});

test('species.jsonc：7 个角色都在；deepseek 引用的动画全部存在于程序自带素材', () => {
  const store = createSpeciesStore({ appRoot: APP, userDir: tmp() });
  const st = store.get();
  assert.deepEqual(st.errors, []);
  assert.deepEqual(Object.keys(st.species).sort(), ['claude', 'deepseek', 'gemini', 'glm', 'gpt', 'grok', 'kimi']);
  const d = store.describe('deepseek');
  assert.equal(d.available, true);
  assert.deepEqual(d.missing, []);
  for (const id of ['gemini', 'glm', 'claude', 'kimi', 'grok']) {
    assert.ok(st.species[id].whisperPrompt.length > 0, id + ' 有人设');
    assert.ok(st.species[id].whisperLines.length > 0, id + ' 有台词');
  }
});

test('素材查找顺序：用户目录 > 项目目录 > 程序自带；放入即可用', () => {
  const user = tmp();
  const proj = tmp();
  const store = createSpeciesStore({ appRoot: APP, userDir: user, projectAssetsDir: proj });
  fs.mkdirSync(path.join(proj, 'kimi', 'webm'), { recursive: true });
  fs.writeFileSync(path.join(proj, 'kimi', 'webm', '待机呼吸休闲.webm'), 'x');
  store.load(); // 清缓存（托盘「重新加载配置」做的就是这个）
  assert.equal(store.isAvailable('kimi'), true);
  assert.equal(store.resolveAnim('kimi', '待机呼吸休闲').kind, 'project');
  fs.mkdirSync(path.join(user, 'species', 'kimi'), { recursive: true });
  fs.writeFileSync(path.join(user, 'species', 'kimi', '待机呼吸休闲.webm'), 'y');
  store.load();
  assert.equal(store.resolveAnim('kimi', '待机呼吸休闲').kind, 'user');
  // 只有待机：其它动画名被剪掉，渲染端不会点到 404（程序自带 kimi 素材已同步时跳过）
  if (fs.existsSync(path.join(APP, 'assets', 'kimi', 'webm', '原地左转走路.webm'))) return;
  const a = store.mergedConfig().kimi.animations;
  assert.deepEqual(a.idle, ['待机呼吸休闲']);
  assert.deepEqual(a.clicks, []);
  assert.deepEqual(a.moves.actions, []);
  assert.deepEqual(a.events, { whisper: ['待机呼吸休闲'] });
});

test('素材名不能逃出目录', () => {
  const store = createSpeciesStore({ appRoot: APP, userDir: tmp() });
  for (const bad of ['../x', '..\\x', 'a/b', 'C:x', '', '..']) assert.equal(store.resolveAnim('deepseek', bad), null, bad);
  assert.equal(store.resolveAnim('nope', '待机呼吸休闲'), null);
});

test('用户的 species.jsonc 优先；写坏了退回自带的并报错', () => {
  const user = tmp();
  fs.writeFileSync(path.join(user, 'species.jsonc'), '{ "size": 300, "species": { "deepseek": { "name": "小鲸", "animations": { "idle": ["待机呼吸休闲"] } } } }');
  let store = createSpeciesStore({ appRoot: APP, userDir: user });
  assert.equal(store.get().size, 300);
  assert.equal(store.get().species.deepseek.name, '小鲸');
  assert.equal(store.isAvailable('gpt'), false, '用户文件里没写 gpt → 不可用');
  fs.writeFileSync(path.join(user, 'species.jsonc'), '{ 坏了');
  store = createSpeciesStore({ appRoot: APP, userDir: user });
  assert.equal(store.get().errors.length, 1);
  assert.equal(store.get().species.deepseek.name, 'DeepSeek 娘');
});

test('referencedAnims 覆盖所有池', () => {
  const n = referencedAnims({ idle: ['a'], turn: ['b'], drag: ['c'], clicks: ['d'], moves: { actions: [{ name: 'e' }] }, categories: [{ actions: ['f'] }], events: { x: ['g', ['h', 'i']] } });
  assert.deepEqual(n.sort(), ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i']);
});

test('接口：config / state / thumb / whisper / chat 关闭 / 路径穿越', () => {
  const store = createSpeciesStore({ appRoot: APP, userDir: tmp() });
  const api = createPetApi({ store, appRoot: APP });
  const cfg = JSON.parse(api.handle('GET', '/dsh-pet-7340/config').body);
  assert.ok(cfg.deepseek);
  assert.equal(cfg.deepseek.pets[0].id, 'deepseek');
  assert.equal(cfg.deepseek.pets[0].display, 'desktop');
  assert.ok(cfg.deepseek.physics && cfg.deepseek.font, '渲染端要的全局字段都在');
  const st1 = JSON.parse(api.handle('GET', '/dsh-pet-7340/state').body);
  assert.deepEqual(st1.pets, {});
  assert.equal(st1.sections.balance.data, null);
  const w = JSON.parse(api.handle('POST', '/dsh-pet-7340/whisper?pet=deepseek').body);
  assert.equal(w.ok, true);
  const st2 = JSON.parse(api.handle('GET', '/dsh-pet-7340/state').body);
  assert.ok(store.get().species.deepseek.whisperLines.includes(st2.pets.deepseek.say.data.text));
  assert.ok(st2.pets.deepseek.say.counter > 0);
  assert.equal(JSON.parse(api.handle('POST', '/dsh-pet-7340/chat?pet=deepseek', '{"text":"hi"}').body).reason, 'disabled');
  const t = api.handle('GET', '/dsh-pet-7340/thumb/deepseek/' + encodeURIComponent('待机呼吸休闲') + '.webm');
  assert.equal(t.status, 200);
  assert.equal(t.contentType, 'video/webm');
  assert.ok(fs.existsSync(t.file));
  assert.equal(api.handle('GET', '/dsh-pet-7340/thumb/deepseek/%2E%2E%2F%2E%2E%2Fpackage.webm').status, 404);
  assert.equal(api.handle('GET', '/dsh-pet-7340/font/..%2F..%2Fpackage.json').status, 404);
  assert.equal(api.handle('GET', '/dsh-pet-7340/font/' + encodeURIComponent('上首软糖体') + '.ttf').status, 200);
  assert.equal(api.handle('GET', '/dsh-pet-7340/pic/cursor-grab.png').status, 200);
});
