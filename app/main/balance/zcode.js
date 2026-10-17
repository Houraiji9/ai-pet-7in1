'use strict';
/**
 * ZCode / GLM（GLM 角色）额度与余额。
 *
 * 移植自 Javis603/token-monitor src/shared/providers/zai/limits.js（MIT，见 app/LICENSE-token-monitor.txt），
 * 两条通道并行，有一条拿到数据就显示：
 *  A. 本机 ZCode 登录（免填）：zcode-discovery.js 读 %USERPROFILE%\.zcode\v2\ 的 setting.json / config.json /
 *     credentials.json（ZCode 用本机信息派生的 AES-GCM 加密），按当前选的套餐：
 *       - 编程套餐（coding plan）：GET {api.z.ai | open.bigmodel.cn}/api/monitor/usage/quota/limit
 *       - 入门套餐（start plan）/ 账号级计费：GET https://zcode.z.ai/api/v1/zcode-plan/billing/balance
 *  B. 手填的 GLM / Z.ai API Key（余额设置窗口，或环境变量 ZAI_API_KEY / GLM_API_KEY / ZHIPU_API_KEY）：
 *       同一个 quota/limit 接口 + 账户现金余额 /api/biz/account/query-customer-account-report
 * 凭证只在内存里用来请求官方接口：不写盘、不进日志、不回传渲染端。
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { discoverZcodeConnection, zcodeDataBaseDir } = require('./zcode-discovery.js');
const { fetchJson, balanceError, numberOrNull, clampPercent, toIso, resetText, fmtPercent, fmtMoney, linesResult } = require('./common.js');

const REGIONS = {
  global: { baseUrl: 'https://api.z.ai', currency: 'USD' },
  'bigmodel-cn': { baseUrl: 'https://open.bigmodel.cn', currency: 'CNY' },
};
const QUOTA_PATH = '/api/monitor/usage/quota/limit';
const SUBSCRIPTION_PATH = '/api/biz/subscription/list';
const CASH_PATH = '/api/biz/account/query-customer-account-report';
const START_PLAN_BALANCE_URL = 'https://zcode.z.ai/api/v1/zcode-plan/billing/balance';
const KEY_ENV_NAMES = ['ZAI_API_KEY', 'Z_AI_API_KEY', 'GLM_API_KEY', 'ZHIPU_API_KEY'];

function normalizeRegion(raw) {
  const s = String(raw || '').trim().toLowerCase();
  if (s === 'bigmodel-cn' || s === 'bigmodel' || s === 'cn' || s === 'china' || s.includes('bigmodel.cn')) return 'bigmodel-cn';
  return 'global';
}

// ---------- 解析：编程套餐 quota/limit ----------
function windowMinutes(unit, number) {
  if (!Number.isFinite(unit) || !Number.isFinite(number) || number <= 0) return null;
  if (unit === 5) return number;
  if (unit === 3) return number * 60;
  if (unit === 1) return number * 24 * 60;
  if (unit === 6) return number * 7 * 24 * 60;
  return null;
}

function usedPercent(limit) {
  const total = numberOrNull(limit && limit.usage);
  const remaining = numberOrNull(limit && limit.remaining);
  const current = numberOrNull(limit && (limit.currentValue ?? limit.current_value));
  if (total !== null && total > 0) {
    let used = null;
    if (remaining !== null) used = current === null ? total - remaining : Math.max(total - remaining, current);
    else if (current !== null) used = current;
    if (used !== null) return Math.max(0, Math.min(100, (Math.max(0, Math.min(total, used)) / total) * 100));
  }
  return clampPercent(limit && (limit.percentage ?? limit.usedPercent ?? limit.used_percent));
}

function firstSubscription(body) {
  const rows = Array.isArray(body && body.data) ? body.data.filter((r) => r && typeof r === 'object') : [];
  return (
    rows.find((r) => r.inCurrentPeriod === true && r.status === 'VALID') ||
    rows.find((r) => r.inCurrentPeriod === true) ||
    rows.find((r) => r.status === 'VALID') ||
    rows[0] ||
    null
  );
}

function planName(quotaBody, subBody) {
  const pick = (o, fields) => {
    if (!o || typeof o !== 'object') return '';
    for (const f of fields) {
      const v = String(o[f] || '').trim();
      if (v) return v;
    }
    return '';
  };
  const raw =
    pick(firstSubscription(subBody), ['product_name', 'productName', 'plan_name', 'planName', 'package_name', 'packageName', 'plan', 'plan_type', 'planType', 'level']) ||
    pick(quotaBody && quotaBody.data, ['planName', 'plan_name', 'packageName', 'package_name', 'plan', 'plan_type', 'planType', 'level']);
  return raw
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/\bglm\b/gi, 'GLM')
    .trim();
}

/** quota/limit → [{label, usedPercent, resetsAt}]：5 小时、周（token/credit 窗口）、MCP（每月） */
function parseZaiUsage(quotaBody, subBody = null) {
  const limits = Array.isArray(quotaBody && quotaBody.data && quotaBody.data.limits) ? quotaBody.data.limits : [];
  const token = [];
  let time = null;
  for (const l of limits) {
    if (!l || typeof l !== 'object') continue;
    const type = String(l.type || l.limit_type || '').trim().toUpperCase();
    if ((type === 'TOKENS_LIMIT' || type === 'CREDIT_LIMIT') && usedPercent(l) !== null) token.push(l);
    else if (type === 'TIME_LIMIT' && usedPercent(l) !== null) time = l;
  }
  const mins = (l) => windowMinutes(numberOrNull(l.unit), numberOrNull(l.number));
  token.sort((a, b) => (mins(a) ?? Number.MAX_SAFE_INTEGER) - (mins(b) ?? Number.MAX_SAFE_INTEGER));
  const only = token[0] || null;
  const isSession = (l) => {
    const m = l && mins(l);
    return m !== null && m !== undefined && m <= 6 * 60;
  };
  const session = token.length >= 2 ? token[0] : isSession(only) ? only : null;
  const weekly = token.length >= 2 ? token[token.length - 1] : session ? null : only;
  const sub = firstSubscription(subBody);
  const renew = toIso(sub && (sub.next_renew_time ?? sub.nextRenewTime));
  const windows = [];
  const w = (l, label, fallbackReset = null) => ({ label, usedPercent: usedPercent(l), resetsAt: toIso(l.nextResetTime ?? l.next_reset_time) || fallbackReset });
  if (session) windows.push(w(session, '5小时'));
  if (weekly) windows.push(w(weekly, '周'));
  if (time) windows.push(w(time, 'MCP 本月', renew));
  return { plan: planName(quotaBody, subBody), windows };
}

// ---------- 解析：ZCode 入门套餐计费桶 ----------
function billingTs(v) {
  const n = typeof v === 'string' && /^\d+$/.test(v.trim()) ? Number(v.trim()) : v;
  if (typeof n === 'number') return n > 0 ? n : null;
  return v;
}

function parseZcodeStartPlanBalances(payload) {
  const balances = Array.isArray(payload && payload.data && payload.data.balances) ? payload.data.balances : [];
  const groups = new Map();
  for (const b of balances) {
    if (!b || typeof b !== 'object') continue;
    const total = numberOrNull(b.total_units);
    let used = numberOrNull(b.used_units);
    let remaining = numberOrNull(b.remaining_units);
    if (used === null && total !== null && remaining !== null) used = Math.max(0, total - remaining);
    if (remaining === null && total !== null && used !== null) remaining = Math.max(0, total - used);
    if (total === null && used === null && remaining === null) continue;
    let p = null;
    if (total !== null && total > 0) p = remaining !== null ? clampPercent(100 - (remaining / total) * 100) : clampPercent((used / total) * 100);
    if (p === null) p = clampPercent(b.percentage);
    const label = String(b.show_name || '').trim() || 'Start Plan';
    const resetsAt = toIso(billingTs(b.expires_at) ?? billingTs(b.period_end));
    // 同一个模型名的多个桶合并（与 token-monitor 一样按 show_name 聚合）
    const key = label.toLowerCase();
    const g = groups.get(key);
    if (!g) groups.set(key, { label, total, used, remaining, usedPercent: p, resetsAt });
    else {
      if (g.total !== null && total !== null && g.remaining !== null && remaining !== null) {
        g.total += total;
        g.remaining += remaining;
        g.used = (g.used || 0) + (used || 0);
        g.usedPercent = g.total > 0 ? clampPercent(100 - (g.remaining / g.total) * 100) : g.usedPercent;
      }
      if (resetsAt && (!g.resetsAt || resetsAt < g.resetsAt)) g.resetsAt = resetsAt;
    }
  }
  const plans = (Array.isArray(payload && payload.data && payload.data.plans) ? payload.data.plans : []).filter((p) => p && p.status === 'active');
  return { plan: String((plans[0] && plans[0].name) || '').trim(), windows: [...groups.values()].sort((a, b) => a.label.localeCompare(b.label)) };
}

function cashBalance(body, region) {
  const remaining = numberOrNull(body && body.data && body.data.availableBalance);
  if (remaining === null) return null;
  return { amount: Math.max(0, remaining), currency: REGIONS[region].currency };
}

// ---------- 请求 ----------
/** 智谱的网关常常 HTTP 200 + body.code=401 表示凭证失效 */
function checkBody(body) {
  const code = body && body.code;
  if (code === 401 || code === 403) throw balanceError('unauthorized', 'GLM 登录已失效或 Key 无效');
  return body;
}

async function getJson(url, key, ctx, extraHeaders = {}) {
  return checkBody(await fetchJson(url, { headers: { Authorization: 'Bearer ' + key, Accept: 'application/json', ...extraHeaders }, fetch: ctx.fetch }));
}

function deviceMid(ctx) {
  const read = ctx.readFileSync || fs.readFileSync;
  try {
    const s = JSON.parse(read(path.join(zcodeDataBaseDir(ctx.env || process.env, ctx.homeDir || os.homedir()), '.zcode', 'v2', 'telemetry-state.json'), 'utf8'));
    return String((s && s.deviceMid) || '').trim() || null;
  } catch {
    return null;
  }
}

async function startPlanBilling(token, ctx) {
  const mid = deviceMid(ctx);
  return parseZcodeStartPlanBalances(await getJson(START_PLAN_BALANCE_URL, token, ctx, mid ? { 'X-Device-Mid': mid } : {}));
}

async function quotaLane(region, key, ctx) {
  const base = REGIONS[region].baseUrl;
  const q = await getJson(base + QUOTA_PATH, key, ctx);
  let usage = parseZaiUsage(q);
  if (usage.windows.length) {
    try {
      usage = parseZaiUsage(q, await getJson(base + SUBSCRIPTION_PATH, key, ctx));
    } catch {
      /* 套餐名只是锦上添花 */
    }
  }
  return usage;
}

/** 通道 A：本机 ZCode 登录 */
async function zcodeLane(ctx) {
  const d = discoverZcodeConnection({}, { readFileSync: ctx.readFileSync || fs.readFileSync, env: ctx.env || process.env, homeDir: ctx.homeDir || os.homedir(), zcodeDir: ctx.zcodeDir });
  if (d.kind === 'none') return { found: false };
  if (d.kind === 'api-unsupported') return { found: true, note: 'ZCode 当前用的是 API Key 接入，查不到套餐额度' };
  const parts = [];
  let plan = '';
  const errors = [];
  if (d.kind === 'coding-quota' && d.entitled && d.credential && d.credential.token) {
    const region = d.family === 'bigmodel' ? 'bigmodel-cn' : 'global';
    try {
      const u = await quotaLane(region, d.credential.token, ctx);
      parts.push(...u.windows);
      plan = u.plan;
    } catch (e) {
      errors.push(e);
    }
  }
  const billingToken = d.kind === 'start-billing' ? d.credential && d.credential.token : d.billing && d.billing.credential && d.billing.credential.token;
  if (billingToken) {
    try {
      const b = await startPlanBilling(billingToken, ctx);
      parts.push(...b.windows);
      plan = plan || b.plan;
    } catch (e) {
      errors.push(e);
    }
  }
  if (!billingToken && !(d.credential && d.credential.token)) return { found: true, note: 'ZCode 里还没登录套餐账号' };
  return { found: true, plan, windows: parts, error: parts.length ? null : errors[0] || null };
}

/** 通道 B：手填 Key */
async function keyLane(key, region, ctx) {
  const base = REGIONS[region].baseUrl;
  const [quota, cash] = await Promise.allSettled([quotaLane(region, key, ctx), getJson(base + CASH_PATH, key, ctx)]);
  const usage = quota.status === 'fulfilled' ? quota.value : { plan: '', windows: [] };
  const money = cash.status === 'fulfilled' ? cashBalance(cash.value, region) : null;
  const error = !usage.windows.length && !money ? (quota.status === 'rejected' ? quota.reason : cash.status === 'rejected' ? cash.reason : null) : null;
  return { plan: usage.plan, windows: usage.windows, money, error };
}

function zcodeRows({ plan, windows, money }, nowMs) {
  const rows = [{ role: 'label', text: 'GLM' + (plan ? ' ' + plan : '') + ' 额度' }];
  for (const w of windows) {
    if (w.usedPercent === null || w.usedPercent === undefined) continue;
    const r = resetText(w.resetsAt, nowMs);
    rows.push({ role: 'sub', text: `${w.label} 已用 ${fmtPercent(w.usedPercent)}${r ? ' · ' + r : ''}` });
  }
  if (money) rows.push({ role: 'sub', text: '账户余额 ' + fmtMoney(money.amount, money.currency) });
  return rows;
}

/**
 * @param {{ getSecret: (n: string) => string, getSetting?: (n: string) => string, env?, fetch?, readFileSync?, homeDir?, zcodeDir?, now? }} ctx
 */
async function fetchZcode(ctx) {
  const env = ctx.env || process.env;
  const nowMs = ctx.now ? ctx.now().getTime() : Date.now();
  let key = ctx.getSecret ? ctx.getSecret('zai') : '';
  if (!key) for (const n of KEY_ENV_NAMES) if (!key && String(env[n] || '').trim()) key = String(env[n]).trim();
  const region = normalizeRegion((ctx.getSetting && ctx.getSetting('zaiRegion')) || env.ZAI_API_REGION || 'bigmodel-cn');
  const [laneA, laneB] = await Promise.all([
    zcodeLane(ctx).catch((e) => ({ found: true, windows: [], error: e })),
    key ? keyLane(key, region, ctx).catch((e) => ({ windows: [], error: e })) : Promise.resolve(null),
  ]);
  const windows = [...(laneA.windows || []), ...((laneB && laneB.windows) || [])];
  // 同名窗口（两条通道查到同一个账号）只留一份
  const seen = new Set();
  const uniq = windows.filter((w) => {
    const k = w.label + ':' + Math.round(w.usedPercent ?? -1);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  const money = laneB && laneB.money;
  if (uniq.length || money) {
    const percents = uniq.map((w) => w.usedPercent).filter((p) => p !== null && p !== undefined);
    return linesResult('zcode', zcodeRows({ plan: laneA.plan || (laneB && laneB.plan) || '', windows: uniq, money }, nowMs), percents.length ? Math.max(...percents) : null, {
      source: [laneA.windows && laneA.windows.length ? 'ZCode 本机登录' : '', laneB && (laneB.windows.length || laneB.money) ? '手填 GLM Key' : ''].filter(Boolean).join(' + '),
    });
  }
  const err = (laneB && laneB.error) || laneA.error;
  if (err) throw err;
  if (!laneA.found && !key) throw balanceError('credential-missing', '没找到 ZCode 登录信息：请先打开 ZCode 登录，或在「余额设置…」里填 GLM API Key');
  throw balanceError('fetch-error', laneA.note || 'GLM 这次没返回额度数据');
}

module.exports = { fetchZcode, parseZaiUsage, parseZcodeStartPlanBalances, cashBalance, zcodeRows, normalizeRegion, START_PLAN_BALANCE_URL, QUOTA_PATH, CASH_PATH };
