'use strict';
/**
 * 冒烟测试公共部分：临时目录、隔离环境、启动 Electron（失败处理/超时/清理）、素材缺失夹具。
 * 隔离规则：userData / session / DPI 缓存 / CODEX_HOME / HOME / APPDATA 全部指向临时目录，
 * AIPET_TEST_ISOLATED=1 让主进程拦掉所有非本机网络请求、不启动自动更新与素材下载。
 */
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { parseJsonc } = require('../main/jsonc.js');

const root = process.env.AIPET_APP_ROOT || path.join(__dirname, '..');
const temps = [];
const children = new Set();

function makeWork(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

function cleanup() {
  for (const c of children) {
    try { c.kill('SIGKILL'); } catch { /* 已退出 */ }
  }
  children.clear();
  if (process.env.AIPET_SMOKE_KEEP === '1') return;
  for (const d of temps.splice(0)) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* Windows 上文件可能还被占用，忽略 */ }
  }
}
process.on('exit', cleanup);
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { cleanup(); process.exit(130); });

/** 一套与真实账号/网络完全隔离的环境变量 */
function isolatedEnv(work, extra = {}) {
  const home = path.join(work, 'home');
  for (const d of ['home', 'appdata', 'localappdata', 'codex-home', 'user']) fs.mkdirSync(path.join(work, d), { recursive: true });
  const env = { ...process.env };
  for (const k of Object.keys(env)) {
    // 真实凭据一律不往下传
    if (/^(DEEPSEEK|ZHIPU|GLM|ZAI|KIMI|MOONSHOT|OPENAI|ANTHROPIC|CURSOR|CODEX|AIPET)_/i.test(k)) delete env[k];
  }
  delete env.ELECTRON_RUN_AS_NODE;
  Object.assign(env, {
    AIPET_TEST_ISOLATED: '1',
    AIPET_ASSET_SYNC: '0',
    AIPET_USER_DIR: path.join(work, 'user'),
    AIPET_SMOKE_SEED: process.env.AIPET_SMOKE_SEED || '12345',
    CODEX_HOME: path.join(work, 'codex-home'),
    HOME: home,
    USERPROFILE: home,
    APPDATA: path.join(work, 'appdata'),
    LOCALAPPDATA: path.join(work, 'localappdata'),
    XDG_CONFIG_HOME: path.join(home, '.config'),
    // 没有显式给 Codex 命令时，指向一个不存在的命令，绝不会去启动真实 codex
    AIPET_CODEX_COMMAND: JSON.stringify([process.execPath, path.join(work, 'no-such-codex.js')]),
    ...extra,
  });
  return env;
}

/** 启动 Electron；spawn 失败 / 超时都变成可读的失败，而不是挂住 */
function runElectron(env, { timeoutMs = 60000 } = {}) {
  return new Promise((resolve) => {
    let electron;
    try {
      electron = require('electron'); // node 下 require('electron') = 可执行文件路径
    } catch (e) {
      resolve({ code: null, error: 'electron 未安装：' + e.message, log: '' });
      return;
    }
    let logText = '';
    let done = false;
    const t0 = Date.now();
    const child = spawn(electron, [root, '--no-sandbox'], { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    children.add(child);
    const finish = (r) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      children.delete(child);
      resolve({ ...r, log: logText, ms: Date.now() - t0 });
    };
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* ignore */ }
      finish({ code: null, error: `electron 超过 ${timeoutMs}ms 没退出，已强制结束` });
    }, timeoutMs);
    child.stdout.on('data', (d) => (logText += d));
    child.stderr.on('data', (d) => (logText += d));
    child.on('error', (e) => finish({ code: null, error: '启动 electron 失败：' + e.message }));
    child.on('exit', (code) => finish({ code }));
  });
}

function readResult(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/** 素材缺失夹具：在临时用户目录写一份 species.jsonc，把 Claude 的待机动作指向不存在的素材 */
function writeMissingClaudeFixture(userDir) {
  const src = fs.readFileSync(path.join(root, 'config', 'species.jsonc'), 'utf8');
  const i = src.indexOf('"claude": {');
  if (i < 0) throw new Error('species.jsonc 里没有 claude 条目');
  const j = src.indexOf('"待机呼吸休闲"', i);
  const text = src.slice(0, j) + '"冒烟测试-不存在的素材"' + src.slice(j + '"待机呼吸休闲"'.length);
  fs.mkdirSync(userDir, { recursive: true });
  fs.writeFileSync(path.join(userDir, 'species.jsonc'), text);
}

function speciesConfig() {
  return parseJsonc(fs.readFileSync(path.join(root, 'config', 'species.jsonc'), 'utf8'));
}

function report(title, ok, fail) {
  console.log('== ' + title);
  for (const n of ok) console.log('  ✓ ' + n);
  for (const n of fail) console.log('  ✗ ' + n);
}

module.exports = { root, makeWork, cleanup, isolatedEnv, runElectron, readResult, writeMissingClaudeFixture, speciesConfig, report };
