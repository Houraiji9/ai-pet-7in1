#!/usr/bin/env node
/**
 * 第二个冒烟测试：右键菜单「切换角色」锁定/自动、托盘菜单内容、碎碎念气泡、重新加载配置、调试窗口、
 * 右键「查看余额」（假 codex app-server + 本机假 DeepSeek 接口，不碰任何真实账号）、余额设置窗口。
 *   xvfb-run -a node tools/smoke-ui.js
 */
'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const lib = require('./smoke-lib.js');

const work = lib.makeWork('aipet-smoke-ui-');
const mock = path.join(work, 'fg.json');
const out = path.join(work, 'result.json');
const CODEX = 'C:\\Program Files\\WindowsApps\\OpenAI.Codex_26.1.0.0_x64__2p2nqsd0c76g0\\app\\ChatGPT.exe';
const DSH = 'C:\\Users\\me\\AppData\\Local\\Programs\\DeepSeek Harness\\DeepSeek Harness.exe';
fs.writeFileSync(mock, JSON.stringify({ pid: 400, path: DSH, packageFamily: '' }));
// 假 codex：实现 initialize + account/rateLimits/read 两个 JSON-RPC。
// 用 Electron 自己（ELECTRON_RUN_AS_NODE）+ 脚本路径启动，不依赖 shebang（Windows 上直接跑 .js 会 EFTYPE）
const fakeCodex = path.join(work, 'fake-codex.js');
fs.writeFileSync(
  fakeCodex,
  `let buf = '';
process.stdin.on('data', (c) => {
  buf += c;
  let i;
  while ((i = buf.indexOf('\\n')) !== -1) {
    const m = JSON.parse(buf.slice(0, i));
    buf = buf.slice(i + 1);
    if (m.id === undefined) continue;
    const result = m.method === 'initialize' ? {} : { rateLimits: { primary: { usedPercent: 32, windowDurationMins: 300, resetsAt: Math.floor(Date.now() / 1000) + 7200 }, secondary: { usedPercent: 12, windowDurationMins: 10080 }, planType: 'plus' } };
    process.stdout.write(JSON.stringify({ id: m.id, result }) + '\\n');
  }
});
process.stdin.on('end', () => process.exit(0));
`,
);
// 假 DeepSeek /user/balance（只认测试用的假 Key）
const DUMMY_KEY = 'sk-smoke-dummy';
let deepseekHits = 0;
const dsServer = http.createServer((req, res) => {
  deepseekHits++;
  const ok = req.url === '/user/balance' && req.headers.authorization === 'Bearer ' + DUMMY_KEY;
  res.writeHead(ok ? 200 : 401, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(ok ? { is_available: true, balance_infos: [{ currency: 'CNY', total_balance: '11.06', granted_balance: '0.00', topped_up_balance: '11.06' }] } : {}));
});
const gptLines = lib.speciesConfig().species.gpt.whisperLines;
const script = [
  { mark: 'boot', do: 'wait', until: { configOk: true, species: 'deepseek' } },
  { do: 'context-menu' },
  { do: 'menu-lock', species: 'gpt' }, // 前台还是 DeepSeek Harness，但锁定 gpt
  { do: 'wait', until: { species: 'gpt' } },
  { mark: 'locked', do: 'tray' },
  { do: 'whisper' },
  { do: 'wait', until: { bubbleIn: gptLines } },
  { do: 'sleep', ms: 500 },
  { mark: 'auto', do: 'menu-auto' }, // 回到自动 → 300ms 后跟随前台回 deepseek
  { mark: 'auto-back', do: 'wait', until: { main: 'deepseek', species: 'deepseek' } },
  { do: 'place', rx: 0.3, ry: 0.5 },
  { mark: 'reload', do: 'reload', times: 3 },
  { do: 'wait', until: { configOk: true, species: 'deepseek' } },
  { mark: 'after-reload', do: 'sleep', ms: 800 },
  { mark: 'codex', do: 'fg', fg: { pid: 200, path: CODEX, packageFamily: 'OpenAI.Codex_2p2nqsd0c76g0' } },
  { do: 'wait', until: { main: 'gpt', species: 'gpt' } },
  { do: 'debug-window', expect: 'ChatGPT\\.exe' },
  { mark: 'balance-gpt', do: 'balance' }, // 自动跟随 Codex → gpt → 假 codex app-server
  { do: 'menu-lock', species: 'deepseek' },
  { do: 'wait', until: { species: 'deepseek' } },
  { mark: 'balance-ds', do: 'balance' }, // deepseek → 假 DeepSeek 接口
  { do: 'balance-settings', expect: '来自环境变量' },
  { do: 'debug-window', expect: '查看余额[\\s\\S]*DeepSeek' },
];

async function main() {
  await new Promise((r, j) => dsServer.listen(0, '127.0.0.1', r).on('error', j));
  // 缺素材夹具：Claude 待机指向不存在的文件 → 托盘里应显示「还没有素材」并禁用
  const env = lib.isolatedEnv(work, {
    AIPET_FOREGROUND_MOCK: mock,
    AIPET_SMOKE_OUT: out,
    AIPET_SMOKE_MS: '60000',
    AIPET_SMOKE_SCRIPT: JSON.stringify(script),
    AIPET_CODEX_COMMAND: JSON.stringify([require('electron'), fakeCodex]),
    DEEPSEEK_API_KEY: DUMMY_KEY,
    AIPET_DEEPSEEK_BASE_URL: 'http://127.0.0.1:' + dsServer.address().port,
  });
  lib.writeMissingClaudeFixture(env.AIPET_USER_DIR);
  let r;
  try {
    r = await lib.runElectron(env, { timeoutMs: 75000 });
  } finally {
    dsServer.close();
  }
  const code = r.code;
  const logText = r.log;
  if (r.error) console.log(r.error);
  const res = lib.readResult(out);
  if (!res) {
    console.log('没有结果文件\n' + logText.slice(-3000));
    process.exitCode = 1;
    return;
  }

  const ev = (name) => res.events.find((e) => e.do === name) || {};
  const ok = [];
  const fail = [];
  const check = (n, c) => (c ? ok : fail).push(n);
  const menu = ev('context-menu').menu || {};
  check('右键菜单有 查看余额/碎碎念/回到初始位置/切换角色/重载配置，没有 打开网站/对话', /查看余额/.test(menu.root) && /碎碎念/.test(menu.root) && /切换角色/.test(menu.root) && /重载配置/.test(menu.root) && !/打开网站|对话|显示位置/.test(menu.root));
  check('「切换角色」子菜单列出可用角色', /自动（跟随前台程序）/.test(menu.all) && /锁定为 GPT 龙娘/.test(menu.all) && /锁定为 DeepSeek 娘/.test(menu.all));
  check('右键锁定 gpt → 立即变 gpt（不管前台）', ev('menu-lock').after.main === 'gpt' && ev('menu-lock').after.mode === 'lock');
  const ph = (p) => res.rows.filter((r) => r.phase === p);
  const locked = ph('locked');
  check('锁定期间前台是 DeepSeek Harness 也保持 gpt（渲染端也是 gpt）', locked.length > 0 && locked.every((r) => r.main === 'gpt' && r.species === 'gpt'));
  const tray = (ev('tray').tray || []).join('\n');
  check('托盘菜单：当前角色 + 自动 + 锁定（无素材的角色禁用）+ 调试 + 退出', /当前：GPT 龙娘（锁定）/.test(tray) && /锁定角色 > \[.*GPT 龙娘\*.*Claude 娘（还没有素材）\(禁用\)/.test(tray) && /调试：查看前台窗口/.test(tray) && /退出/.test(tray));
  check('托盘「最近的前台程序」里有 DeepSeek Harness.exe', /最近的前台程序.*DeepSeek Harness\.exe/.test(tray));
  check('碎碎念：气泡显示 GPT 的台词', gptLines.length > 0 && ph('locked').some((r) => gptLines.includes(r.bubble)));
  check('切回自动 → 跟随前台回 deepseek', ev('menu-auto').after.mode === 'auto' && (res.events.find((e) => e.mark === 'auto-back') || {}).ok === true);
  const afterReload = ph('after-reload');
  const rl = ev('reload');
  check('连续 3 次重载请求只重建 1 次窗口（合并）', rl.windowsCreated === 1);
  check('重载后宠物留在原位置（不跳回角落）', !!rl.restorePos && Math.abs(rl.restorePos.rx - 0.3) < 0.02 && Math.abs(rl.restorePos.ry - 0.5) < 0.05);
  check('重新加载配置后窗口重建、角色不变、无报错', afterReload.length > 0 && afterReload.every((r) => r.configOk && r.species === 'deepseek' && !r.errorText));
  check('重新加载后自动切换仍然有效（Codex → gpt）', ph('codex').some((r) => r.main === 'gpt' && r.species === 'gpt'));
  const dbg = ev('debug-window').debugText || '';
  check('调试窗口显示前台 exe 文件名与完整路径', dbg.includes('ChatGPT.exe') && dbg.includes('OpenAI.Codex_26.1.0.0_x64__2p2nqsd0c76g0'));
  const bal = res.events.filter((e) => e.do === 'balance');
  check('查看余额：先显示「正在查询余额…」', bal.length === 2 && bal.every((b) => /正在查询余额/.test(b.loading || '')));
  check('查看余额（gpt）：假 codex app-server → Codex Plus 额度 / 5小时 已用 32%', bal[0] && bal[0].species === 'gpt' && /Codex Plus 额度/.test(bal[0].bubble) && /5小时 已用 32%/.test(bal[0].bubble));
  check('查看余额（deepseek）：本机假接口 → ¥11.06', bal[1] && bal[1].species === 'deepseek' && /余额（[谷峰]）¥11\.06/.test(bal[1].bubble) && deepseekHits === 1);
  const st = (ev('balance-settings').settingsText || '');
  check('余额设置窗口：DeepSeek 显示「来自环境变量」，界面里没有 Key 明文', /DeepSeek/.test(st) && /来自环境变量/.test(st) && !st.includes(DUMMY_KEY));
  const dbg2 = (res.events.filter((e) => e.do === 'debug-window')[1] || {}).debugText || '';
  check('调试窗口「查看余额」：Codex / DeepSeek 正常、时间，Cursor 还没查过，无 Key 明文', /查看余额/.test(dbg2) && /Codex[^\n]*\t?正常/.test(dbg2.replace(/\n来源/g, ' 来源')) && /DeepSeek[^\n]*正常/.test(dbg2) && /还没查过/.test(dbg2) && !dbg2.includes(DUMMY_KEY) && !logText.includes(DUMMY_KEY));
  check('等待的状态都在超时内出现', res.events.filter((e) => e.do === 'wait').every((e) => e.ok));
  check('脚本在总超时内跑完、electron 正常退出', !res.timedOut && code === 0);
  check('没有任何外网请求（隔离）', !/\[隔离\] 拦截外网请求/.test(logText));
  check('没有脚本步骤报错', res.events.every((e) => !e.err));
  check('渲染端无 JS 异常', res.rows.every((r) => !(r.errors || []).length));
  console.log('结果目录：' + work);
  for (const n of ok) console.log('  ✓ ' + n);
  for (const n of fail) console.log('  ✗ ' + n);
  if (fail.length) {
    console.log(JSON.stringify(res.events, null, 1).slice(0, 4000));
    for (const r of res.rows.filter((_, i) => i % 2 === 0)) console.log(JSON.stringify(r));
    console.log(logText.slice(-2000));
  }
  console.log('electron 退出码 ' + code);
  process.exitCode = fail.length ? 1 : 0;
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
