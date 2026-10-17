'use strict';
// 余额接口的样例响应（结构照官方接口 / token-monitor 测试里的形状写的，数字是编的，没有任何真实账号数据）
module.exports = {
  deepseekBalance: {
    is_available: true,
    balance_infos: [
      { currency: 'USD', total_balance: '0.00', granted_balance: '0.00', topped_up_balance: '0.00' },
      { currency: 'CNY', total_balance: '11.06', granted_balance: '1.00', topped_up_balance: '10.06' },
    ],
  },
  // codex app-server account/rateLimits/read（camelCase，resetsAt 为秒）
  codexRpc: {
    rateLimits: {
      primary: { usedPercent: 32, windowDurationMins: 300, resetsAt: 1_792_000_000 },
      secondary: { usedPercent: 12.4, windowDurationMins: 10080, resetsAt: 1_792_300_000 },
      planType: 'plus',
    },
    rateLimitsByLimitId: {},
  },
  // chatgpt.com/backend-api/wham/usage（snake_case）
  codexUsage: {
    plan_type: 'pro',
    rate_limit: {
      primary_window: { used_percent: 55, limit_window_seconds: 18000, reset_at: 1_792_000_000 },
      secondary_window: { used_percent: 20, limit_window_seconds: 604800, reset_at: 1_792_300_000 },
    },
  },
  cursorLegacy: {
    summary: {
      billingCycleEnd: '2026-11-01T00:00:00.000Z',
      membershipType: 'pro',
      individualUsage: { plan: { used: 1200, limit: 2000, autoPercentUsed: 40, apiPercentUsed: 61.5 }, onDemand: { used: 350, limit: 2000 } },
    },
    me: { sub: 'user_abc123', email: 'x@example.com' },
    usage: {},
    sand: { usagePercent: 25, nextResetTimestampUtc: '2026-10-20T00:00:00Z', hasNonZeroIncludedLimit: true, isUnified: false },
    plan: { isMerged: false, planInfo: { planName: 'Pro' } },
  },
  cursorUnified: {
    summary: { membershipType: 'unified_ultra', individualUsage: { plan: { totalPercentUsed: 0 } } },
    me: { sub: 'user_abc123' },
    usage: {},
    sand: { usagePercent: 44, isUnified: true },
    plan: { isMerged: true, planInfo: { planName: 'Super', includedUsagePeriod: 'INCLUDED_USAGE_PERIOD_WEEKLY', includedUsageResetsAt: '1792000000000' } },
    prepaid: { availableCents: '1250' },
    period: { planUsage: { totalPercentUsed: 37.5 } },
  },
  zaiQuota: {
    code: 200,
    data: {
      limits: [
        { type: 'TOKENS_LIMIT', unit: 3, number: 5, usage: 1000, remaining: 700, nextResetTime: 1_792_000_000_000 },
        { type: 'TOKENS_LIMIT', unit: 6, number: 1, usage: 10000, remaining: 9000 },
        { type: 'TIME_LIMIT', unit: 5, number: 1, usage: 100, remaining: 90, currentValue: 10 },
      ],
    },
  },
  zaiSubscription: { code: 200, data: [{ productName: 'GLM_Coding_Pro', status: 'VALID', inCurrentPeriod: true }] },
  zaiCash: { code: 200, data: { availableBalance: 23.456 } },
  zcodeStartPlan: {
    code: 0,
    data: {
      plans: [{ name: 'Start Plan', status: 'active', plan_id: 'p1', entitlements: [{ entitlement_id: 'e1', period: 'daily' }] }],
      balances: [{ show_name: 'GLM-4.6', total_units: 200, remaining_units: 150, plan_id: 'p1', entitlement_id: 'e1', expires_at: 1_792_000_000 }],
    },
  },
};
