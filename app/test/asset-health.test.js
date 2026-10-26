'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { checkAssetFile, createSpeciesStore } = require('../main/species.js');
const { createAnimFallback } = require('../renderer/anim-fallback.js');

const APP = path.join(__dirname, '..');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'aipet-health-'));
const WEBM = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(60)]);

test('素材体检：空文件 / LFS 指针 / 非 WebM / 正常', () => {
  const d = tmp();
  const f = (n, c) => { const p = path.join(d, n); fs.writeFileSync(p, c); return p; };
  assert.match(checkAssetFile(f('a.webm', '')), /空文件/);
  assert.match(checkAssetFile(f('b.webm', 'version https://git-lfs.github.com/spec/v1\noid sha256:abc\nsize 123\n')), /LFS/);
  assert.match(checkAssetFile(f('c.webm', '<html>404</html> not a video at all......')), /无法解码/);
  assert.equal(checkAssetFile(f('d.webm', WEBM)), '');
});

test('坏素材当作没有：用户目录里的 LFS 指针不挡住后面目录的好文件，调试信息里能看到', () => {
  const user = tmp();
  const proj = tmp();
  fs.mkdirSync(path.join(user, 'species', 'kimi'), { recursive: true });
  fs.writeFileSync(path.join(user, 'species', 'kimi', '待机呼吸休闲.webm'), 'version https://git-lfs.github.com/spec/v1\n');
  fs.mkdirSync(path.join(proj, 'kimi', 'webm'), { recursive: true });
  fs.writeFileSync(path.join(proj, 'kimi', 'webm', '待机呼吸休闲.webm'), WEBM);
  const store = createSpeciesStore({ appRoot: APP, userDir: user, projectAssetsDir: proj });
  assert.equal(store.resolveAnim('kimi', '待机呼吸休闲').kind, 'project');
  assert.ok(store.describe('kimi').bad.some((x) => /LFS/.test(x)));
});

test('只有空文件 → 角色不可用（不会开一个播不了的窗口）', () => {
  const user = tmp();
  fs.mkdirSync(path.join(user, 'species', 'kimi'), { recursive: true });
  fs.writeFileSync(path.join(user, 'species', 'kimi', '待机呼吸休闲.webm'), '');
  const store = createSpeciesStore({ appRoot: APP, userDir: user });
  if (store.resolveAnim('kimi', '待机呼吸休闲')) return; // 程序自带了 kimi 素材：自带的兜底，跳过
  assert.equal(store.isAvailable('kimi'), false);
});

test('播放兜底：失败的动画隔离一段时间，优先退回上一段能播的，其次待机', () => {
  let t = 0;
  const fb = createAnimFallback({ quarantineMs: 1000, now: () => t });
  fb.ok('挥手');
  fb.fail('跳舞');
  assert.equal(fb.isQuarantined('跳舞'), true);
  assert.equal(fb.pick('跳舞', ['待机']), '挥手');
  fb.fail('挥手');
  assert.equal(fb.pick('挥手', ['挥手', '待机']), '待机');
  fb.fail('待机');
  assert.equal(fb.pick('待机', ['待机']), null, '全坏了 → 不再循环重试');
  t = 1500;
  assert.equal(fb.isQuarantined('跳舞'), false, '隔离到期自动解除');
  fb.reset();
  assert.equal(fb.lastGood, '');
});

test('sprite.js：切换带世代令牌、会撤掉旧监听和定时器、失败后改播兜底', () => {
  const src = fs.readFileSync(path.join(APP, 'renderer', 'sprite.js'), 'utf8');
  assert.match(src, /__aipetCancelLoad/);
  assert.match(src, /animFallback\.fail\(next\)/);
  assert.match(src, /animFallback\.isQuarantined\(next\)/);
  const html = fs.readFileSync(path.join(APP, 'renderer', 'index.html'), 'utf8');
  assert.ok(html.indexOf('./anim-fallback.js') < html.indexOf('src="./sprite.js"'));
});
