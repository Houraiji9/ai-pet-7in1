'use strict';
/**
 * 「查看余额」服务：角色 → 查询来源 → 统一结果（与原版 dsh-pet 的 /state sections.balance 叶子同一契约）。
 *
 * 第一批接入（2026-10）：
 *   gpt      → Codex（CLI app-server JSON-RPC，退路 auth.json）
 *   grok     → Cursor 账号（含 Grok Bot 额度）
 *   glm      → ZCode 本机登录 / 手填 GLM Key
 *   deepseek → DeepSeek 官方 API Key
 *   gemini / claude / kimi → 暂未接入（友好提示）
 *
 * 结果写给渲染端前只保留展示需要的字段；调试窗口只看 来源 / 状态 / 时间 / 我们自己写的说明。
 */
const { fetchDeepSeek } = require('./deepseek.js');
const { fetchCodex } = require('./codex.js');
const { fetchCursor } = require('./cursor.js');
const { fetchZcode } = require('./zcode.js');
const { failResult, resultFromError } = require('./common.js');

const PROVIDERS = {
  codex: { label: 'Codex（GPT）', fetch: fetchCodex },
  cursor: { label: 'Cursor / Grok Bot', fetch: fetchCursor },
  zcode: { label: 'ZCode / GLM', fetch: fetchZcode },
  deepseek: { label: 'DeepSeek API', fetch: fetchDeepSeek },
};

/** 角色 → provider id；null = 暂未接入 */
const CHARACTER_PROVIDER = { gpt: 'codex', grok: 'cursor', glm: 'zcode', deepseek: 'deepseek', gemini: null, claude: null, kimi: null };
const PENDING_NAMES = { gemini: 'Gemini / Antigravity', claude: 'Claude', kimi: 'Kimi' };

/** 同一来源多少毫秒内重复点，直接用上次结果（避免连点把 Codex 拉起好几次） */
const REUSE_MS = 5000;

/**
 * @param {{ secrets: ReturnType<import('./secrets').createSecretStore>, log?: (s: string) => void, ctx?: object, now?: () => number }} o
 */
function createBalanceService({ secrets, log = () => {}, ctx = {}, now = Date.now }) {
  const status = {}; // provider id → { provider, label, state, source, message, at }
  const inflight = new Map();
  const last = new Map(); // provider id → { at, result }

  function record(id, result, startedAt) {
    const p = PROVIDERS[id];
    status[id] = {
      provider: id,
      label: p ? p.label : id,
      state: result.ok ? 'ok' : result.reason,
      source: (result.data && result.data.source) || '',
      message: result.ok ? '' : result.message || '',
      at: now(),
      ms: now() - startedAt,
    };
    log(`[余额] ${id} → ${result.ok ? 'ok' : result.reason}（${now() - startedAt}ms）`);
  }

  async function queryProvider(id) {
    const p = PROVIDERS[id];
    if (!p) return failResult(id, 'unsupported', '未知的查询来源');
    const hit = last.get(id);
    if (hit && now() - hit.at < REUSE_MS) return hit.result;
    if (inflight.has(id)) return inflight.get(id);
    const startedAt = now();
    status[id] = { ...(status[id] || {}), provider: id, label: p.label, state: 'running', at: startedAt };
    const job = (async () => {
      let result;
      try {
        result = await p.fetch({ ...ctx, getSecret: (n) => secrets.get(n), getSetting: (n) => secrets.getSetting(n) });
      } catch (e) {
        result = resultFromError(id, e);
      }
      record(id, result, startedAt);
      last.set(id, { at: now(), result });
      return result;
    })();
    inflight.set(id, job);
    try {
      return await job;
    } finally {
      inflight.delete(id);
    }
  }

  /** 按角色查；返回给渲染端的叶子数据（带 character 与 manual 标记） */
  async function queryCharacter(character, { manual = true } = {}) {
    const id = Object.prototype.hasOwnProperty.call(CHARACTER_PROVIDER, character) ? CHARACTER_PROVIDER[character] : undefined;
    let result;
    if (id === undefined) result = failResult(String(character), 'unsupported', '这个角色还没有余额查询');
    else if (id === null) result = failResult(PENDING_NAMES[character] || character, 'unsupported', (PENDING_NAMES[character] || character) + ' 的余额查询暂未接入');
    else result = await queryProvider(id);
    return { ...result, character, manual };
  }

  function invalidate(id) {
    if (id) last.delete(id);
    else last.clear();
  }

  return {
    queryCharacter,
    queryProvider,
    invalidate,
    /** 调试窗口：每个来源的 来源 / 状态 / 时间 / 说明（不含任何凭证） */
    debugStatus() {
      return Object.keys(PROVIDERS).map((id) => status[id] || { provider: id, label: PROVIDERS[id].label, state: 'idle', source: '', message: '', at: 0 });
    },
  };
}

module.exports = { createBalanceService, CHARACTER_PROVIDER, PROVIDERS };
