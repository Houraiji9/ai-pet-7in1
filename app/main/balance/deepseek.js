'use strict';
/**
 * DeepSeek 官方 API 余额：GET https://api.deepseek.com/user/balance（Bearer API Key）。
 *
 * 口径来源：
 *  - 原版 dsh-pet src/host/balance/providers/deepseek-official.ts + deepseek-common.ts（MIT）：
 *    money 形状、满额基准 ¥20、北京时间峰谷档位；
 *  - token-monitor src/shared/providers/deepseek/limits.js（MIT）：多币种行里挑有钱的那一行（selectFundedRow）。
 *
 * Key 来源：余额设置窗口（safeStorage 加密存 userData）> 环境变量 DEEPSEEK_API_KEY。
 */
const { fetchJson, balanceError, numberOrNull } = require('./common.js');

const DEEPSEEK_BALANCE_URL = 'https://api.deepseek.com/user/balance';
/** 余额 ≥ ¥20 视为「满」（未消耗）；据此折算已用百分比驱动余额档位动画（与原版 dsh-pet 一致） */
const DEEPSEEK_FULL_BALANCE = '20';

/** 北京时间峰谷：工作日 9-12、14-18 为高峰，其余（含周末全天）低谷（与原版 dsh-pet 一致） */
function deepseekPricingTier(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Shanghai', weekday: 'short', hour: '2-digit', hourCycle: 'h23' }).formatToParts(now);
  const pick = (t) => (parts.find((p) => p.type === t) || {}).value;
  const weekday = pick('weekday');
  const hour = Number(pick('hour'));
  if (weekday === 'Sat' || weekday === 'Sun') return 'idle';
  return (hour >= 9 && hour < 12) || (hour >= 14 && hour < 18) ? 'peak' : 'idle';
}

/** balance_infos 里挑一行：有余额的优先（金额大者），全为 0 时退回 USD/第一行 */
function selectFundedRow(rows) {
  const parsed = [];
  for (const row of rows || []) {
    const amount = numberOrNull(row && row.total_balance);
    const currency = String((row && row.currency) || '').trim().toUpperCase();
    if (amount === null || !currency) continue;
    parsed.push({ row, amount, currency });
  }
  if (!parsed.length) throw balanceError('fetch-error', 'DeepSeek 返回里没有可用的余额');
  const funded = parsed.filter((r) => r.amount > 0).sort((a, b) => b.amount - a.amount);
  return (funded[0] || parsed.find((r) => r.currency === 'USD') || parsed[0]).row;
}

/** 开发自测用：只允许把请求改到本机地址（冒烟测试的假服务器），防止 Key 被环境变量导去别处 */
function balanceUrl(env) {
  const o = String(env.AIPET_DEEPSEEK_BASE_URL || '').trim();
  if (o && /^http:\/\/127\.0\.0\.1:\d+$/.test(o)) return o + '/user/balance';
  return DEEPSEEK_BALANCE_URL;
}

/**
 * @param {{ getSecret: (name: string) => string, env?: object, fetch?: Function, now?: () => Date }} ctx
 */
async function fetchDeepSeek(ctx) {
  const env = ctx.env || process.env;
  const key = ctx.getSecret('deepseek');
  if (!key) throw balanceError('credential-missing', '托盘菜单 →「余额设置…」里填 DeepSeek API Key（或设环境变量 DEEPSEEK_API_KEY）');
  const body = await fetchJson(balanceUrl(env), { headers: { Authorization: 'Bearer ' + key, Accept: 'application/json' }, fetch: ctx.fetch });
  if (!body || !Array.isArray(body.balance_infos) || !body.balance_infos.length) throw balanceError('fetch-error', 'DeepSeek 返回格式不认识');
  const row = selectFundedRow(body.balance_infos);
  const s = (v) => (v === undefined || v === null ? undefined : String(v));
  return {
    ok: true,
    provider: 'deepseek',
    shape: 'money',
    data: {
      currency: String(row.currency).toUpperCase(),
      total: s(row.total_balance),
      granted: s(row.granted_balance),
      toppedUp: s(row.topped_up_balance),
      fullBalance: DEEPSEEK_FULL_BALANCE,
      tier: deepseekPricingTier(ctx.now ? ctx.now() : new Date()),
      available: body.is_available !== false,
      source: 'DeepSeek API Key',
    },
  };
}

module.exports = { fetchDeepSeek, selectFundedRow, deepseekPricingTier, DEEPSEEK_BALANCE_URL, DEEPSEEK_FULL_BALANCE };
