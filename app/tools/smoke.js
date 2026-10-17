#!/usr/bin/env node
/**
 * 冒烟测试（开发用，Linux 上配合 xvfb-run 跑）：用 mock 前台数据驱动真实的 Electron 桌宠，
 * 检查「前台程序 → 角色」切换的整条链路（采样 → 规则 → 300ms 防抖 → 渲染端换素材播登场）。
 *   xvfb-run -a node tools/smoke.js
 */
'use strict';
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = process.env.AIPET_APP_ROOT || path.join(__dirname, '..');
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'aipet-smoke-'));
const mock = path.join(work, 'fg.json');
const out = path.join(work, 'result.json');
const userDir = path.join(work, 'user');

const CODEX = 'C:\\Program Files\\WindowsApps\\OpenAI.Codex_26.1.0.0_x64__2p2nqsd0c76g0\\app\\ChatGPT.exe';
const timeline = [
  [0, { pid: 100, path: 'C:\\Windows\\explorer.exe', packageFamily: '' }],
  [2000, { pid: 200, path: CODEX, packageFamily: 'OpenAI.Codex_2p2nqsd0c76g0' }],
  [4500, { pid: 300, path: 'C:\\Program Files\\Tencent\\WeChat\\WeChat.exe', packageFamily: '' }],
  [6000, { pid: 400, path: 'C:\\Users\\me\\AppData\\Local\\Programs\\DeepSeek Harness\\DeepSeek Harness.exe', packageFamily: '' }],
  [8000, { pid: 500, path: 'C:\\Users\\me\\AppData\\Local\\AnthropicClaude\\app-1.0.0\\Claude.exe', packageFamily: '' }],
  [9000, { pid: 200, path: CODEX, packageFamily: 'OpenAI.Codex_2p2nqsd0c76g0' }],
  [9150, { pid: 100, path: 'C:\\Windows\\explorer.exe', packageFamily: '' }],
];
const write = (o) => fs.writeFileSync(mock, JSON.stringify(o));
write(timeline[0][1]);

const electron = require('electron'); // node 下 require('electron') = 可执行文件路径
const env = { ...process.env, AIPET_FOREGROUND_MOCK: mock, AIPET_SMOKE_OUT: out, AIPET_SMOKE_MS: '11500', AIPET_SMOKE_SHOTS: '1500,3500', AIPET_USER_DIR: userDir };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(electron, [root, '--no-sandbox'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
let logText = '';
child.stdout.on('data', (d) => (logText += d));
child.stderr.on('data', (d) => (logText += d));
const t0 = Date.now();
for (const [at, fg] of timeline.slice(1)) setTimeout(() => write(fg), at);

child.on('exit', (code) => {
  const ok = [];
  const fail = [];
  const check = (name, cond) => (cond ? ok : fail).push(name);
  let res = null;
  try {
    res = JSON.parse(fs.readFileSync(out, 'utf8'));
  } catch (e) {
    console.error('没有结果文件', e.message, '\n', logText.slice(-3000));
    process.exit(1);
  }
  const at = (ms) => res.rows.filter((r) => r.t <= ms).pop() || {};
  const between = (a, b) => res.rows.filter((r) => r.t >= a && r.t <= b);
  check('启动 1.5s：配置加载成功、只有 1 只宠物', at(1500).configOk === true && at(1500).sprites === 1);
  const whenFg = (exe) => res.rows.filter((r) => r.fgExe === exe);
  const firstPhase = res.rows.filter((r) => r.fgExe === 'explorer.exe' && r.t < 3000);
  check('explorer.exe（不是 Agent）→ 默认 deepseek', firstPhase.length > 0 && firstPhase.every((r) => r.main === 'deepseek' && r.species === 'deepseek'));
  check('切到 Codex（ChatGPT.exe + OpenAI.Codex_ 包）→ gpt', at(3200).main === 'gpt' && at(3200).species === 'gpt');
  check('gpt 先播 登场-星光现身', between(2000, 4400).some((r) => r.front === 'gpt/登场-星光现身.webm'));
  check('登场 播完回待机（待机呼吸休闲）或其它 gpt 动作', between(3000, 6000).some((r) => r.front.startsWith('gpt/') && r.front !== 'gpt/登场-星光现身.webm'));
  check('微信（不是 Agent）→ 保持 gpt', whenFg('WeChat.exe').length > 0 && whenFg('WeChat.exe').every((r) => r.main === 'gpt' && r.species === 'gpt'));
  check('DeepSeek Harness.exe → deepseek', at(7800).main === 'deepseek' && at(7800).species === 'deepseek');
  check('deepseek 登场（女仆屈膝礼仪）', between(6000, 8000).some((r) => r.front === 'deepseek/女仆屈膝礼仪.webm'));
  check('Claude.exe（规则命中但没素材）→ 保持 deepseek', whenFg('Claude.exe').length > 0 && whenFg('Claude.exe').every((r) => r.main === 'deepseek'));
  check('Codex 只闪 150ms（< 300ms 防抖）→ 不切换', at(11000).main === 'deepseek');
  check('渲染端没有报错条', res.rows.every((r) => !r.errorText));
  const errs = res.rows.flatMap((r) => r.errors || []);
  check('渲染端无 JS 异常', errs.length === 0);
  console.log('结果目录：' + work);
  for (const n of ok) console.log('  ✓ ' + n);
  for (const n of fail) console.log('  ✗ ' + n);
  if (fail.length) {
    console.log('\n--- 采样 ---');
    for (const r of res.rows.filter((_, i) => i % 2 === 0)) console.log(JSON.stringify(r));
    console.log('\n--- 日志尾部 ---\n' + logText.slice(-2500));
  }
  console.log(`electron 退出码 ${code}，用时 ${Date.now() - t0}ms`);
  process.exit(fail.length ? 1 : 0);
});
