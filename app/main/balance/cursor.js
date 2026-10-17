'use strict';
/**
 * Cursor / Grok Bot（Grok 角色）额度。
 *
 * 移植自 Javis603/token-monitor（MIT，见 app/LICENSE-token-monitor.txt）：
 *   src/shared/providers/cursor/auth.js      —— 从 Cursor 桌面版 state.vscdb 读登录 token、规范成 WorkosCursorSessionToken
 *   src/shared/providers/cursor/probe.js     —— cursor.com 各用量接口与解析（含 Grok Bot 的 get-sand-usage-status）
 *   src/shared/providers/cursor/limits.js    —— 合并计划（unified）与旧计划的额度窗口取舍
 * 去掉了 tokscale 多账号同步，只查本机 Cursor 当前登录的账号。
 *
 * 凭证：%APPDATA%\Cursor\User\globalStorage\state.vscdb（SQLite，node:sqlite 只读打开）里的
 * `cursorAuth/accessToken`。只在内存里拼成 Cookie 请求 cursor.com，绝不写盘、不进日志。
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const https = require('node:https');
const { balanceError, clampPercent, resetText, fmtPercent, linesResult } = require('./common.js');

const USAGE_SUMMARY_URL = 'https://cursor.com/api/usage-summary';
const AUTH_ME_URL = 'https://cursor.com/api/auth/me';
const REQUEST_USAGE_URL = 'https://cursor.com/api/usage';
const SAND_USAGE_URL = 'https://cursor.com/api/dashboard/get-sand-usage-status';
const PLAN_INFO_URL = 'https://cursor.com/api/dashboard/get-plan-info';
const PREPAID_BILLING_URL = 'https://cursor.com/api/dashboard/get-user-prepaid-billing';
const CURRENT_PERIOD_USAGE_URL = 'https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage';
const DASHBOARD_TIMEOUT_MS = 5000;
const TOKEN_KEY = 'cursorAuth/accessToken';
const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';

// ---------- 读本机登录 ----------
function stateDbCandidates({ env = process.env, platform = process.platform, home = os.homedir() } = {}) {
  if (platform === 'win32') {
    const out = [];
    if (env.APPDATA) out.push(path.join(env.APPDATA, 'Cursor', 'User', 'globalStorage', 'state.vscdb'));
    out.push(path.join(home, 'AppData', 'Roaming', 'Cursor', 'User', 'globalStorage', 'state.vscdb'));
    return [...new Set(out)];
  }
  if (platform === 'darwin') return [path.join(home, 'Library', 'Application Support', 'Cursor', 'User', 'globalStorage', 'state.vscdb')];
  return [path.join(home, '.config', 'Cursor', 'User', 'globalStorage', 'state.vscdb')];
}

/** 返回 token 字符串；没装/没登录 → null；运行环境没有 node:sqlite → 抛错 */
function readCursorDesktopAccessToken(ctx = {}) {
  const fsApi = ctx.fs || fs;
  const db = (ctx.dbPaths || stateDbCandidates(ctx)).find((p) => {
    try {
      return fsApi.statSync(p).isFile();
    } catch {
      return false;
    }
  });
  if (!db) return null;
  let sqlite = ctx.sqlite;
  if (sqlite === undefined) {
    try {
      sqlite = require('node:sqlite');
    } catch {
      sqlite = null;
    }
  }
  if (!sqlite || typeof sqlite.DatabaseSync !== 'function') throw balanceError('fetch-error', '当前运行环境读不了 Cursor 的登录数据库（缺 node:sqlite）');
  let database;
  try {
    database = new sqlite.DatabaseSync(db, { readOnly: true });
  } catch {
    throw balanceError('fetch-error', '打不开 Cursor 的 state.vscdb（可能被占用）');
  }
  try {
    const row = database.prepare('SELECT value FROM ItemTable WHERE key = ?').get(TOKEN_KEY);
    const v = row && row.value;
    const token = typeof v === 'string' ? v.trim() : Buffer.isBuffer(v) || v instanceof Uint8Array ? Buffer.from(v).toString('utf8').trim() : '';
    return token || null;
  } finally {
    try {
      database.close();
    } catch {
      /* ignore */
    }
  }
}

function canonicalUserId(value) {
  const m = String(value || '').match(/user_[A-Za-z0-9_]+/);
  return m ? m[0] : '';
}

function userIdFromAccessToken(token) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) return '';
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    return canonicalUserId(payload && payload.sub);
  } catch {
    return '';
  }
}

/** 桌面版存的是 JWT；cursor.com 要的 Cookie 是 `<userId>%3A%3A<jwt>` */
function normalizeCursorSessionToken(input) {
  let token = String(input || '').trim();
  if (!token || token.length > 16 * 1024) return '';
  if (token.toLowerCase().startsWith('cookie:')) token = token.slice(7).trim();
  const m = token.match(/WorkosCursorSessionToken=([^;\s]+)/i);
  if (m) token = m[1];
  if ((token.startsWith('"') && token.endsWith('"')) || (token.startsWith("'") && token.endsWith("'"))) token = token.slice(1, -1).trim();
  if (!token || /\s/.test(token)) return '';
  const sep = token.indexOf('::');
  if (sep > 0) token = token.slice(0, sep) + '%3A%3A' + token.slice(sep + 2);
  else if (!token.includes('%3A%3A')) {
    const uid = userIdFromAccessToken(token);
    if (uid) token = uid + '%3A%3A' + token;
  }
  return token;
}

function sessionAccessToken(sessionToken) {
  let t = String(sessionToken || '');
  try {
    t = decodeURIComponent(t);
  } catch {
    return '';
  }
  const i = t.indexOf('::');
  if (i < 0) return '';
  const a = t.slice(i + 2).trim();
  return a.split('.').length === 3 ? a : '';
}

// ---------- 解析（与 token-monitor probe.js 同口径） ----------
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const pct = (used, limit) => (num(used) === null || num(limit) === null || limit <= 0 ? null : clampPercent((used / limit) * 100));
const isoOrNull = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};
function int64OrNull(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v !== 'string' || !/^-?\d+$/.test(v.trim())) return null;
  const n = Number(v);
  return Number.isSafeInteger(n) ? n : null;
}
const epochMsToIso = (v) => {
  const ms = int64OrNull(v);
  return ms === null || ms <= 0 ? null : isoOrNull(ms);
};

function parseGrokBotUsage(input) {
  const u = input && typeof input === 'object' ? input : {};
  return {
    usedPercent: clampPercent(num(u.usagePercent)),
    resetsAt: isoOrNull(u.nextResetTimestampUtc),
    hasNonZeroIncludedLimit: u.hasNonZeroIncludedLimit === true,
    isUnified: u.isUnified === true,
  };
}

function parsePlanInfo(input) {
  const r = input && typeof input === 'object' ? input : {};
  const info = r.planInfo && typeof r.planInfo === 'object' ? r.planInfo : {};
  const p = info.includedUsagePeriod;
  return {
    isMerged: r.isMerged === true,
    planName: typeof info.planName === 'string' ? info.planName : null,
    includedUsagePeriod: p === 'INCLUDED_USAGE_PERIOD_WEEKLY' ? 'weekly' : p === 'INCLUDED_USAGE_PERIOD_MONTHLY' ? 'monthly' : null,
    includedUsageResetsAt: epochMsToIso(info.includedUsageResetsAt),
    billingCycleEnd: epochMsToIso(info.billingCycleEnd),
  };
}

function parsePrepaidBilling(input) {
  const r = input && typeof input === 'object' ? input : {};
  const c = r.availableCents === undefined ? 0 : int64OrNull(r.availableCents);
  return { availableUsd: c === null ? null : Math.max(0, c) / 100 };
}

function parseCurrentPeriodUsage(input) {
  const plan = input && input.planUsage && typeof input.planUsage === 'object' ? input.planUsage : {};
  const v = typeof plan.totalPercentUsed === 'string' ? Number(plan.totalPercentUsed) : plan.totalPercentUsed;
  return { totalPercentUsed: clampPercent(num(v)) };
}

function parseUsageSummary(input, { requestUsage = null, unifiedPlan = false } = {}) {
  const s = input && typeof input === 'object' ? input : {};
  const ind = s.individualUsage && typeof s.individualUsage === 'object' ? s.individualUsage : {};
  const plan = ind.plan && typeof ind.plan === 'object' ? ind.plan : {};
  const onDemand = ind.onDemand && typeof ind.onDemand === 'object' ? ind.onDemand : {};
  const overall = ind.overall && typeof ind.overall === 'object' ? ind.overall : {};
  const planLimit = num(plan.limit) ?? 0;
  let planPercent = clampPercent(num(plan.totalPercentUsed));
  if (planPercent === null) {
    if (planLimit > 0) planPercent = pct(num(plan.used), planLimit);
    else if (!unifiedPlan && num(overall.limit) > 0) planPercent = pct(num(overall.used), num(overall.limit));
  }
  const ru = requestUsage && typeof requestUsage === 'object' ? requestUsage['gpt-4'] || requestUsage.gpt4 || {} : {};
  const odUsed = num(onDemand.used) ?? 0;
  const odLimit = num(onDemand.limit);
  return {
    planPercent,
    autoPercent: clampPercent(num(plan.autoPercentUsed)),
    apiPercent: clampPercent(num(plan.apiPercentUsed)),
    onDemandUsedUsd: Math.round(odUsed) / 100,
    onDemandLimitUsd: odLimit === null ? null : Math.round(odLimit) / 100,
    requestsUsed: num(ru.numRequestsTotal) ?? num(ru.numRequests),
    requestsLimit: num(ru.maxRequestUsage),
    billingCycleEnd: typeof s.billingCycleEnd === 'string' ? s.billingCycleEnd : null,
    membershipType: typeof s.membershipType === 'string' ? s.membershipType : null,
    isUnlimited: s.isUnlimited === true,
    hasOverallUsage: [overall.used, overall.limit].some((v) => num(v) !== null),
  };
}

// ---------- HTTP ----------
function requestJson(url, sessionToken, { timeoutMs = 15000, httpsLib = https, method = 'GET', headers = {}, body = null, bearerToken = '' } = {}) {
  return new Promise((resolve) => {
    const u = new URL(url);
    let done = false;
    const finish = (v) => {
      if (!done) {
        done = true;
        resolve(v);
      }
    };
    let req;
    try {
      req = httpsLib.request(
        {
          method,
          hostname: u.hostname,
          path: u.pathname + u.search,
          headers: {
            Accept: '*/*',
            'Accept-Language': 'en-US,en;q=0.9',
            Referer: 'https://cursor.com/dashboard',
            'User-Agent': BROWSER_UA,
            ...headers,
            ...(bearerToken ? { Authorization: 'Bearer ' + bearerToken } : { Cookie: 'WorkosCursorSessionToken=' + sessionToken }),
          },
        },
        (res) => {
          if (res.statusCode === 401 || res.statusCode === 403) {
            res.resume && res.resume();
            return finish({ ok: false, kind: 'unauthorized', status: res.statusCode });
          }
          if (typeof res.statusCode !== 'number' || res.statusCode < 200 || res.statusCode >= 300) {
            res.resume && res.resume();
            return finish({ ok: false, kind: 'http', status: res.statusCode });
          }
          let text = '';
          res.on('data', (c) => (text += c.toString('utf8')));
          res.on('end', () => {
            try {
              finish({ ok: true, json: JSON.parse(text) });
            } catch {
              finish({ ok: false, kind: 'parse' });
            }
          });
          res.on('error', () => finish({ ok: false, kind: 'network' }));
        },
      );
    } catch {
      return finish({ ok: false, kind: 'network' });
    }
    if (typeof req.setTimeout === 'function') req.setTimeout(timeoutMs, () => req.destroy(new Error('timeout')));
    req.on('error', () => finish({ ok: false, kind: 'network' }));
    if (body !== null && body !== undefined) req.write(String(body));
    req.end();
  });
}

function dashboardRpc(url, token, opts) {
  return requestJson(url, token, {
    ...opts,
    timeoutMs: DASHBOARD_TIMEOUT_MS,
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json', Origin: 'https://cursor.com' },
    body: '{}',
  });
}

/** 与 token-monitor probe() 同流程：usage-summary 必须成功，其余尽力而为 */
async function probe(sessionToken, opts = {}) {
  const sandP = dashboardRpc(SAND_USAGE_URL, sessionToken, opts);
  const planP = dashboardRpc(PLAN_INFO_URL, sessionToken, opts);
  const [usageR, userR] = await Promise.all([requestJson(USAGE_SUMMARY_URL, sessionToken, opts), requestJson(AUTH_ME_URL, sessionToken, opts)]);
  if (!usageR.ok) return usageR;
  const sub = userR.ok && userR.json && typeof userR.json.sub === 'string' ? userR.json.sub : null;
  let requestUsage = null;
  if (sub) {
    const r = await requestJson(REQUEST_USAGE_URL + '?user=' + encodeURIComponent(sub), sessionToken, opts);
    if (r.ok) requestUsage = r.json;
  }
  const [sandR, planR] = await Promise.all([sandP, planP]);
  const grokBot = sandR.ok ? parseGrokBotUsage(sandR.json) : null;
  const planInfo = planR.ok ? parsePlanInfo(planR.json) : null;
  const unified = planInfo ? planInfo.isMerged : !!(grokBot && grokBot.isUnified);
  let prepaid = null;
  let periodPercent = null;
  if (unified) {
    const access = sessionAccessToken(sessionToken);
    const [preR, perR] = await Promise.all([
      dashboardRpc(PREPAID_BILLING_URL, sessionToken, opts),
      access
        ? requestJson(CURRENT_PERIOD_USAGE_URL, sessionToken, {
            ...opts,
            timeoutMs: DASHBOARD_TIMEOUT_MS,
            method: 'POST',
            headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'Connect-Protocol-Version': '1' },
            body: '{}',
            bearerToken: access,
          })
        : Promise.resolve(null),
    ]);
    if (preR.ok) prepaid = parsePrepaidBilling(preR.json);
    if (perR && perR.ok) periodPercent = parseCurrentPeriodUsage(perR.json).totalPercentUsed;
  }
  const usage = { ...parseUsageSummary(usageR.json, { requestUsage, unifiedPlan: unified }), grokBot, planInfo, prepaid, unified };
  if (unified) {
    const sand = grokBot && grokBot.isUnified ? grokBot.usedPercent : null;
    const summaryFallback = planInfo && planInfo.includedUsagePeriod === 'monthly' ? usage.planPercent : null;
    usage.planPercent = periodPercent !== null ? periodPercent : sand !== null ? sand : summaryFallback;
  }
  return { ok: true, usage };
}

// ---------- 气泡 ----------
function cursorRows(usage, nowMs = Date.now()) {
  const rows = [];
  const percents = [];
  const add = (text, p, resetsAt) => {
    const r = resetText(resetsAt, nowMs);
    rows.push({ role: 'sub', text: text + (r ? ' · ' + r : '') });
    if (p !== null && p !== undefined) percents.push(p);
  };
  const billingEnd = isoOrNull(usage.billingCycleEnd) || (usage.planInfo && usage.planInfo.billingCycleEnd) || null;
  const planName = (usage.planInfo && usage.planInfo.planName) || usage.membershipType || '';
  rows.push({ role: 'label', text: 'Cursor' + (planName ? ' ' + String(planName).replace(/_/g, ' ') : '') + ' 额度' });
  if (usage.unified) {
    if (usage.planPercent !== null) {
      const weekly = !usage.planInfo || usage.planInfo.includedUsagePeriod !== 'monthly';
      add(`共用额度（含 Grok Bot）已用 ${fmtPercent(usage.planPercent)}`, usage.planPercent, weekly ? usage.planInfo && usage.planInfo.includedUsageResetsAt : billingEnd);
    }
    if (usage.prepaid && usage.prepaid.availableUsd > 0) rows.push({ role: 'sub', text: '预付余额 $' + usage.prepaid.availableUsd.toFixed(2) });
  } else {
    const gb = usage.grokBot;
    if (gb && gb.hasNonZeroIncludedLimit && gb.usedPercent !== null) add(`Grok Bot 已用 ${fmtPercent(gb.usedPercent)}`, gb.usedPercent, gb.resetsAt);
    if (num(usage.requestsUsed) !== null && num(usage.requestsLimit) > 0) {
      add(`请求 ${usage.requestsUsed}/${usage.requestsLimit}`, pct(usage.requestsUsed, usage.requestsLimit), billingEnd);
    } else if (usage.autoPercent !== null || usage.apiPercent !== null) {
      if (usage.autoPercent !== null) add(`Cursor 模型 已用 ${fmtPercent(usage.autoPercent)}`, usage.autoPercent, billingEnd);
      if (usage.apiPercent !== null) add(`其他模型 已用 ${fmtPercent(usage.apiPercent)}`, usage.apiPercent, null);
    } else if (usage.planPercent !== null) {
      add(`本期 已用 ${fmtPercent(usage.planPercent)}`, usage.planPercent, billingEnd);
    }
  }
  if (usage.onDemandUsedUsd > 0 || (usage.onDemandLimitUsd || 0) > 0) {
    const lim = usage.onDemandLimitUsd ? ' / $' + usage.onDemandLimitUsd.toFixed(2) : '';
    rows.push({ role: 'sub', text: '按量 $' + usage.onDemandUsedUsd.toFixed(2) + lim });
  }
  if (rows.length === 1) {
    if (usage.isUnlimited) rows.push({ role: 'sub', text: '不限量套餐' });
    else rows.push({ role: 'sub', text: '这个账号没有可显示的额度' });
  }
  return { rows, percent: percents.length ? Math.max(...percents) : null };
}

/**
 * @param {{ env?, platform?, home?, fs?, sqlite?, dbPaths?, httpsLib?, now? }} ctx
 */
async function fetchCursor(ctx = {}) {
  const raw = readCursorDesktopAccessToken(ctx);
  if (!raw) throw balanceError('credential-missing', '没找到 Cursor 登录信息：请先在 Cursor 桌面版里登录（Grok Bot 的额度也从这个账号查）');
  const token = normalizeCursorSessionToken(raw);
  if (!token || !/user_[A-Za-z0-9_]+/.test(decodeURIComponent(token.split('%3A%3A')[0] || ''))) {
    throw balanceError('credential-missing', 'Cursor 的登录信息不完整：请在 Cursor 里重新登录');
  }
  const r = await probe(token, { httpsLib: ctx.httpsLib });
  if (!r.ok) {
    if (r.kind === 'unauthorized') throw balanceError('unauthorized', 'Cursor 登录已过期：请在 Cursor 里重新登录');
    if (r.kind === 'http') throw balanceError('fetch-error', 'cursor.com 返回 HTTP ' + r.status);
    if (r.kind === 'parse') throw balanceError('fetch-error', 'cursor.com 返回格式不认识');
    throw balanceError('fetch-error', '连不上 cursor.com（网络问题或超时）');
  }
  const { rows, percent } = cursorRows(r.usage, ctx.now ? ctx.now().getTime() : Date.now());
  return linesResult('cursor', rows, percent, { source: 'Cursor state.vscdb → cursor.com' });
}

module.exports = {
  fetchCursor,
  readCursorDesktopAccessToken,
  normalizeCursorSessionToken,
  sessionAccessToken,
  stateDbCandidates,
  parseUsageSummary,
  parseGrokBotUsage,
  parsePlanInfo,
  parsePrepaidBilling,
  parseCurrentPeriodUsage,
  probe,
  cursorRows,
  USAGE_SUMMARY_URL,
  SAND_USAGE_URL,
};
