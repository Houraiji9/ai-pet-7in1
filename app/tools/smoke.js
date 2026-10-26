#!/usr/bin/env node
/**
 * 冒烟测试（开发用，Linux 上配合 xvfb-run 跑）：用 mock 前台数据驱动真实的 Electron 桌宠，
 * 检查「前台程序 → 角色」切换的整条链路（采样 → 规则 → 300ms 防抖 → 渲染端换素材播登场）。
 * 两套夹具：完整素材（Claude 有素材 → 会切过去）、素材缺失（Claude 指向不存在的素材 → 保持原角色）。
 * 步骤按顺序执行并等待可观察的状态，不靠固定毫秒；全程与真实账号、网络隔离（见 smoke-lib.js）。
 *   xvfb-run -a node tools/smoke.js
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const lib = require('./smoke-lib.js');

const CODEX = { pid: 200, path: 'C:\\Program Files\\WindowsApps\\OpenAI.Codex_26.1.0.0_x64__2p2nqsd0c76g0\\app\\ChatGPT.exe', packageFamily: 'OpenAI.Codex_2p2nqsd0c76g0' };
const EXPLORER = { pid: 100, path: 'C:\\Windows\\explorer.exe', packageFamily: '' };
const WECHAT = { pid: 300, path: 'C:\\Program Files\\Tencent\\WeChat\\WeChat.exe', packageFamily: '' };
const DSH = { pid: 400, path: 'C:\\Users\\me\\AppData\\Local\\Programs\\DeepSeek Harness\\DeepSeek Harness.exe', packageFamily: '' };
const CLAUDE = { pid: 500, path: 'C:\\Users\\me\\AppData\\Local\\AnthropicClaude\\app-1.0.0\\Claude.exe', packageFamily: '' };

async function run(name, { missing }) {
  const work = lib.makeWork('aipet-smoke-');
  const mock = path.join(work, 'fg.json');
  const out = path.join(work, 'result.json');
  fs.writeFileSync(mock, JSON.stringify(EXPLORER));
  const env = lib.isolatedEnv(work, { AIPET_FOREGROUND_MOCK: mock, AIPET_SMOKE_OUT: out, AIPET_SMOKE_MS: '45000', AIPET_SMOKE_SHOTS: '1500' });
  if (missing) lib.writeMissingClaudeFixture(env.AIPET_USER_DIR);
  const script = [
    { mark: 'boot', do: 'wait', until: { configOk: true, species: 'deepseek' } },
    { mark: 'explorer', do: 'sleep', ms: 800 },
    { mark: 'codex', do: 'fg', fg: CODEX },
    { do: 'wait', until: { main: 'gpt', species: 'gpt', front: 'gpt/登场-星光现身.webm' } },
    { do: 'wait', until: { species: 'gpt', front: 'gpt/', frontNot: 'gpt/登场-星光现身.webm' }, timeoutMs: 10000 },
    { mark: 'wechat', do: 'fg', fg: WECHAT },
    { do: 'sleep', ms: 1000 },
    { mark: 'dsh', do: 'fg', fg: DSH },
    { do: 'wait', until: { main: 'deepseek', species: 'deepseek', front: 'deepseek/女仆屈膝礼仪.webm' } },
    { mark: 'claude', do: 'fg', fg: CLAUDE },
    missing ? { do: 'sleep', ms: 1200 } : { do: 'wait', until: { main: 'claude', species: 'claude' } },
    { mark: 'flash', do: 'fg', fg: CODEX },
    { do: 'sleep', ms: 150 },
    { do: 'fg', fg: EXPLORER },
    { mark: 'after-flash', do: 'sleep', ms: 1200 },
  ];
  env.AIPET_SMOKE_SCRIPT = JSON.stringify(script);
  const r = await lib.runElectron(env, { timeoutMs: 60000 });
  const res = lib.readResult(out);
  const ok = [];
  const fail = [];
  const check = (n, c) => (c ? ok : fail).push(n);
  check('electron 正常启动并退出', !r.error && r.code === 0);
  if (!res) {
    lib.report(name, ok, fail.concat(['没有结果文件']));
    console.log(r.error || '', r.log.slice(-3000));
    return false;
  }
  check('脚本在总超时内跑完', !res.timedOut);
  const ph = (p) => res.rows.filter((x) => x.phase === p);
  const waits = res.events.filter((e) => e.do === 'wait');
  check('启动：配置加载成功、只有 1 只宠物', waits[0] && waits[0].ok && waits[0].row.sprites === 1);
  check('explorer.exe（不是 Agent）→ 默认 deepseek', ph('explorer').length > 0 && ph('explorer').every((x) => x.main === 'deepseek' && x.species === 'deepseek'));
  check('切到 Codex（ChatGPT.exe + OpenAI.Codex_ 包）→ gpt，先播 登场-星光现身', waits[1] && waits[1].ok);
  check('登场 播完回待机或其它 gpt 动作', waits[2] && waits[2].ok);
  const wx = ph('wechat').filter((x) => x.fgExe === 'WeChat.exe');
  check('微信（不是 Agent）→ 保持 gpt', wx.length > 0 && wx.every((x) => x.main === 'gpt' && x.species === 'gpt'));
  check('DeepSeek Harness.exe → deepseek，登场 女仆屈膝礼仪', waits[3] && waits[3].ok);
  const cl = ph('claude').filter((x) => x.fgExe === 'Claude.exe');
  if (missing) check('Claude.exe（规则命中但素材缺失）→ 保持 deepseek', cl.length > 0 && cl.every((x) => x.main === 'deepseek'));
  else check('Claude.exe（有素材）→ claude', waits[4] && waits[4].ok);
  const expect = missing ? 'deepseek' : 'claude';
  const af = ph('after-flash');
  check(`Codex 只闪 150ms（< 300ms 防抖）→ 不切换，保持 ${expect}`, af.length > 0 && af.every((x) => x.main === expect));
  check('渲染端没有报错条', res.rows.every((x) => !x.errorText));
  check('渲染端无 JS 异常', res.rows.every((x) => !(x.errors || []).length));
  check('没有脚本步骤报错', res.events.every((e) => !e.err));
  check('没有任何外网请求（隔离）', !/\[隔离\] 拦截外网请求/.test(r.log));
  lib.report(name, ok, fail);
  if (fail.length) {
    console.log(JSON.stringify(res.events, null, 1).slice(0, 3000));
    for (const x of res.rows.filter((_, i) => i % 2 === 0)) console.log(JSON.stringify(x));
    console.log('\n--- 日志尾部 ---\n' + r.log.slice(-2500));
  }
  console.log(`  electron 退出码 ${r.code}，用时 ${r.ms}ms`);
  return fail.length === 0;
}

(async () => {
  const a = await run('完整素材夹具', { missing: false });
  const b = await run('素材缺失夹具（独立临时目录）', { missing: true });
  process.exitCode = a && b ? 0 : 1;
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
