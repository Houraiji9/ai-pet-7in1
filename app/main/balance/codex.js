'use strict';
/**
 * Codex（GPT 角色）额度：5 小时 / 每周窗口已用百分比。
 *
 * 移植自 Javis603/token-monitor src/shared/providers/codex/limits.js（MIT，见 app/LICENSE-token-monitor.txt），
 * 只保留单账号、只读查询这一条路：
 *  1. 首选：启动本机 Codex CLI 的 `codex -s read-only -a never app-server`，走 JSON-RPC
 *     `initialize` → `account/rateLimits/read`。我们不碰任何 token，Codex 自己去问官方。
 *     商店版 Codex 桌面程序自带 codex.exe（WindowsApps\OpenAI.Codex_*\app\resources\codex.exe），
 *     npm 装的 codex.cmd 也认。
 *  2. 退路：读 %USERPROFILE%\.codex\auth.json（CODEX_HOME 可改）里的 access token，
 *     GET https://chatgpt.com/backend-api/wham/usage。token 只在内存里用这一次。
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { fetchJson, balanceError, clampPercent, toIso, resetText, fmtPercent, linesResult } = require('./common.js');

const CODEX_USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage';
const CODEX_RPC_TIMEOUT_MS = 20_000;

function envValue(env, name) {
  if (Object.prototype.hasOwnProperty.call(env, name)) return env[name];
  const k = Object.keys(env).find((c) => c.toLowerCase() === name.toLowerCase());
  return k ? env[k] : undefined;
}

function codexHome(env) {
  return env.CODEX_HOME || path.join(os.homedir(), '.codex');
}

function packageVersion(name) {
  const m = /^OpenAI\.Codex_(\d+(?:\.\d+)*)_/.exec(String(name || ''));
  return m ? m[1].split('.').map((x) => Number(x) || 0) : [];
}
/** 新版本排前面 */
function comparePackages(a, b) {
  const av = packageVersion(a);
  const bv = packageVersion(b);
  for (let i = 0; i < Math.max(av.length, bv.length); i++) {
    const d = (bv[i] || 0) - (av[i] || 0);
    if (d) return d;
  }
  return String(a).localeCompare(String(b));
}

function listDirs(dir, readdirSync) {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => typeof e === 'string' || (e && typeof e.isDirectory === 'function' ? e.isDirectory() : true))
      .map((e) => (typeof e === 'string' ? e : e.name));
  } catch {
    return [];
  }
}

/** 可能的 codex 可执行文件（按优先级）；绝对路径的只留存在的 */
function codexCommandCandidates(env = process.env, platform = process.platform, deps = {}) {
  const existsSync = deps.existsSync || fs.existsSync;
  const readdirSync = deps.readdirSync || fs.readdirSync;
  if (env.AIPET_CODEX_COMMAND) return [env.AIPET_CODEX_COMMAND];
  const pj = platform === 'win32' ? path.win32.join : path.posix.join;
  const out = [];
  if (platform === 'win32') {
    const local = envValue(env, 'LOCALAPPDATA');
    const pf = envValue(env, 'PROGRAMFILES');
    const pf86 = envValue(env, 'PROGRAMFILES(X86)');
    const appData = envValue(env, 'APPDATA');
    if (local) out.push(pj(local, 'Programs', 'Codex', 'resources', 'codex.exe'));
    if (pf) out.push(pj(pf, 'Codex', 'resources', 'codex.exe'));
    if (pf86) out.push(pj(pf86, 'Codex', 'resources', 'codex.exe'));
    if (local) {
      const bin = pj(local, 'OpenAI', 'Codex', 'bin');
      out.push(pj(bin, 'codex.exe'));
      for (const d of listDirs(bin, readdirSync)) if (/^[A-Za-z0-9._-]+$/.test(d)) out.push(pj(bin, d, 'codex.exe'));
      const pkgs = pj(local, 'Packages');
      for (const name of listDirs(pkgs, readdirSync).filter((n) => /^OpenAI\.Codex_[^\\/:*?"<>|]+$/.test(n)).sort(comparePackages)) {
        out.push(pj(pkgs, name, 'LocalCache', 'Local', 'OpenAI', 'Codex', 'bin', 'codex.exe'));
      }
    }
    for (const root of [...new Set([pf, envValue(env, 'ProgramW6432')].filter(Boolean))]) {
      const apps = pj(root, 'WindowsApps');
      for (const name of listDirs(apps, readdirSync).filter((n) => /^OpenAI\.Codex_[^\\/:*?"<>|]+$/.test(n)).sort(comparePackages)) {
        out.push(pj(apps, name, 'app', 'resources', 'codex.exe'));
      }
    }
    if (appData) out.push(pj(appData, 'npm', 'codex.cmd'));
    out.push('codex.cmd', 'codex.exe');
  } else if (platform === 'darwin') {
    out.push('/Applications/Codex.app/Contents/Resources/codex', '/Applications/ChatGPT.app/Contents/Resources/codex');
  }
  out.push('codex');
  const abs = platform === 'win32' ? path.win32.isAbsolute : path.posix.isAbsolute;
  return [...new Set(out)].filter((c) => !abs(c) || existsSync(c));
}

/** Windows 上 .cmd 必须经 cmd.exe 启动；参数都是固定安全词，只有路径需要加引号 */
function codexSpawnSpec(command, platform = process.platform) {
  const args = ['-s', 'read-only', '-a', 'never', 'app-server'];
  if (platform !== 'win32' || !/\.(cmd|bat)$/i.test(command)) return { command, args };
  const q = (s) => (/^[A-Za-z0-9_./:=\\-]+$/.test(s) ? s : '"' + String(s).replace(/"/g, '\\"') + '"');
  return { command: 'cmd.exe', args: ['/d', '/s', '/c', [q(command), ...args].join(' ')] };
}

function killTree(child, platform, env, spawnFn) {
  if (!child) return;
  try {
    if (platform === 'win32' && child.pid) {
      const root = envValue(env, 'SystemRoot') || 'C:\\Windows';
      const k = spawnFn(path.win32.join(root, 'System32', 'taskkill.exe'), ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true });
      if (k && k.on) k.on('error', () => {});
    }
    child.kill();
  } catch {
    /* 已经退出 */
  }
}

/** 一行一个 JSON 的 JSON-RPC 客户端 */
function jsonRpc(child, timeoutMs) {
  let id = 1;
  let buf = '';
  let closed = false;
  let closeErr = null;
  const pending = new Map();
  const failAll = (e) => {
    if (closed) return;
    closed = true;
    closeErr = e;
    for (const p of pending.values()) {
      clearTimeout(p.timer);
      p.reject(e);
    }
    pending.clear();
  };
  child.stdout.on('data', (chunk) => {
    buf += chunk.toString();
    let i;
    while ((i = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (!msg || msg.id === undefined || !pending.has(msg.id)) continue;
      const p = pending.get(msg.id);
      pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) p.reject(Object.assign(new Error('codex 返回错误：' + String(msg.error.message || 'unknown').slice(0, 120)), { rpcError: true }));
      else p.resolve(msg.result);
    }
  });
  if (child.stderr) child.stderr.on('data', () => {}); // 不收集 stderr（里面可能有账号信息）
  const transport = (e) => failAll(Object.assign(e instanceof Error ? e : new Error(String(e)), { transport: true }));
  child.on('error', transport);
  child.on('close', (code) => transport(new Error('codex app-server 退出（' + code + '）')));
  if (child.stdin && child.stdin.on) child.stdin.on('error', transport);
  const write = (obj) => {
    if (closed) return;
    try {
      child.stdin.write(JSON.stringify(obj) + '\n');
    } catch (e) {
      transport(e);
    }
  };
  return {
    send(method, params) {
      if (closed) return Promise.reject(closeErr || new Error('closed'));
      const mid = id++;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(mid);
          reject(Object.assign(new Error(method + ' 超时'), { transport: method === 'initialize' }));
        }, timeoutMs);
        pending.set(mid, { resolve, reject, timer });
        write(params === undefined ? { method, id: mid } : { method, id: mid, params });
      });
    },
    notify(method, params) {
      write(params === undefined ? { method } : { method, params });
    },
    close() {
      failAll(new Error('closed'));
    },
  };
}

async function readRpcWith(command, ctx) {
  const env = ctx.env || process.env;
  const platform = ctx.platform || process.platform;
  const spawnFn = ctx.spawn || spawn;
  const spec = codexSpawnSpec(command, platform);
  const child = spawnFn(spec.command, spec.args, { windowsHide: true, env, stdio: ['pipe', 'pipe', 'pipe'] });
  const rpc = jsonRpc(child, ctx.rpcTimeoutMs || CODEX_RPC_TIMEOUT_MS);
  try {
    await rpc.send('initialize', { clientInfo: { name: 'ai-pet-7in1', title: 'AI Pet 7in1', version: '0.1.0' } });
    rpc.notify('initialized', {});
    const result = await rpc.send('account/rateLimits/read');
    return result || {};
  } finally {
    rpc.close();
    killTree(child, platform, env, spawnFn);
  }
}

/** 依次试候选命令：找不到/起不来就试下一个；真正问到了就用它的答案 */
async function readCodexRpc(ctx = {}) {
  const env = ctx.env || process.env;
  const platform = ctx.platform || process.platform;
  const cands = ctx.commands || codexCommandCandidates(env, platform, ctx);
  let lastErr = null;
  for (const cmd of cands) {
    try {
      const r = await readRpcWith(cmd, ctx);
      return { result: r, command: cmd };
    } catch (e) {
      lastErr = e;
      if (e && (e.transport || e.code === 'ENOENT')) continue;
      break;
    }
  }
  throw lastErr || balanceError('credential-missing', '没找到 Codex CLI');
}

// ---------- 统一成窗口 ----------
function windowLabel(mins, key) {
  const m = Number(mins) || 0;
  if (m === 300) return '5小时';
  if (m >= 28 * 24 * 60) return '月';
  if (m >= 7 * 24 * 60) return '周';
  if (m >= 24 * 60) return '日';
  if (m > 0) return m % 60 === 0 ? m / 60 + '小时' : m + '分钟';
  return key === 'secondary' ? '周' : '5小时';
}

/** RPC（camelCase，windowDurationMins）与 wham/usage（snake_case，limit_window_seconds）两种形状 → windows */
function codexWindows(snapshot) {
  const out = [];
  if (!snapshot || typeof snapshot !== 'object') return out;
  for (const key of ['primary', 'secondary']) {
    const w = snapshot[key] || snapshot[key + 'Window'] || snapshot[key + '_window'];
    if (!w || typeof w !== 'object') continue;
    const used = clampPercent(w.usedPercent ?? w.used_percent);
    if (used === null) continue;
    const secs = Number(w.limitWindowSeconds ?? w.limit_window_seconds);
    const mins = w.windowDurationMins ?? w.window_duration_mins ?? (Number.isFinite(secs) ? secs / 60 : undefined);
    out.push({ key, label: windowLabel(mins, key), usedPercent: used, resetsAt: toIso(w.resetsAt ?? w.resets_at ?? w.resetAt ?? w.reset_at) });
  }
  return out;
}

/** RPC 结果里的主额度桶（优先 rateLimitsByLimitId.codex，其次 rateLimits） */
function rpcSnapshot(result) {
  const byId = (result && (result.rateLimitsByLimitId || result.rate_limits_by_limit_id)) || {};
  if (byId.codex) return byId.codex;
  return (result && (result.rateLimits || result.rate_limits)) || {};
}

function usageSnapshot(body) {
  return (body && (body.rate_limit || body.rateLimit)) || {};
}

function planLabel(raw) {
  const s = String(raw || '').trim().toLowerCase();
  const map = { free: 'Free', plus: 'Plus', pro: 'Pro', prolite: 'Pro', team: 'Team', business: 'Business', enterprise: 'Enterprise', edu: 'Edu' };
  return map[s] || (s ? s.charAt(0).toUpperCase() + s.slice(1) : '');
}

function codexResult(windows, plan, source, nowMs = Date.now()) {
  if (!windows.length) throw balanceError('fetch-error', 'Codex 这次没返回额度数据（可能是 API Key 登录，没有订阅额度）');
  const rows = [];
  const title = 'Codex' + (plan ? ' ' + plan : '') + ' 额度';
  rows.push({ role: 'label', text: title });
  for (const w of windows) {
    const r = resetText(w.resetsAt, nowMs);
    rows.push({ role: 'sub', text: `${w.label} 已用 ${fmtPercent(w.usedPercent)}${r ? ' · ' + r : ''}` });
  }
  return linesResult('codex', rows, Math.max(...windows.map((w) => w.usedPercent)), { source });
}

// ---------- 退路：auth.json + wham/usage ----------
function readAuthJson(ctx) {
  const env = ctx.env || process.env;
  const read = ctx.readFileSync || fs.readFileSync;
  let auth;
  try {
    auth = JSON.parse(read(path.join(codexHome(env), 'auth.json'), 'utf8'));
  } catch {
    return null;
  }
  const t = (auth && auth.tokens) || auth || {};
  const accessToken = String(t.access_token || t.accessToken || '').trim();
  if (!accessToken) return null;
  const accountId = String(t.account_id || t.accountId || auth.account_id || '').trim();
  return { accessToken, accountId };
}

async function fetchCodexUsage(ctx) {
  const auth = readAuthJson(ctx);
  if (!auth) throw balanceError('credential-missing', '没找到 Codex 登录信息：请先在 Codex 里登录 ChatGPT 账号');
  const headers = { Authorization: 'Bearer ' + auth.accessToken, Accept: 'application/json', 'User-Agent': 'ai-pet-7in1' };
  if (auth.accountId) headers['chatgpt-account-id'] = auth.accountId;
  return fetchJson(CODEX_USAGE_URL, { headers, fetch: ctx.fetch, timeoutMs: 20_000 });
}

/**
 * @param {{ env?, platform?, spawn?, fetch?, readFileSync?, existsSync?, readdirSync?, commands?, now? }} ctx
 */
async function fetchCodex(ctx = {}) {
  const nowMs = ctx.now ? ctx.now().getTime() : Date.now();
  let rpcErr = null;
  try {
    const { result } = await readCodexRpc(ctx);
    const snap = rpcSnapshot(result);
    const windows = codexWindows(snap);
    if (windows.length) return codexResult(windows, planLabel(snap.planType ?? snap.plan_type), 'Codex CLI (app-server)', nowMs);
    rpcErr = balanceError('fetch-error', 'Codex CLI 没返回额度');
  } catch (e) {
    rpcErr = e;
  }
  try {
    const body = await fetchCodexUsage(ctx);
    return codexResult(codexWindows(usageSnapshot(body)), planLabel(body && (body.plan_type ?? body.planType)), 'auth.json → chatgpt.com', nowMs);
  } catch (e) {
    // 两条路都没走通：没装 CLI 又没登录 → 提示登录；其余报退路的错误
    if (e && e.balanceStatus === 'credential-missing' && rpcErr && !rpcErr.balanceStatus) {
      throw balanceError('credential-missing', '没找到 Codex：请先安装并登录 Codex（桌面版或 CLI）');
    }
    throw e;
  }
}

module.exports = {
  fetchCodex,
  readCodexRpc,
  codexCommandCandidates,
  codexSpawnSpec,
  codexWindows,
  rpcSnapshot,
  usageSnapshot,
  codexResult,
  windowLabel,
  CODEX_USAGE_URL,
};
