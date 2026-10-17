'use strict';
/**
 * 余额查询的公共小工具（纯 Node，可单测）。
 *
 * 部分解析口径移植自 Javis603/token-monitor（MIT，见 app/LICENSE-token-monitor.txt）：
 * src/shared/limits/providerHelpers.js 的 toIso / numberOrNull / clampPercent。
 *
 * 凭证纪律（主人同意的范围）：本地工具的登录凭证只在内存里用来请求官方接口，
 * 绝不写盘、不进日志、不回传渲染端。这里的错误信息只带「HTTP 状态码 / 我们自己写的说明」，
 * 不带任何响应体或请求头。
 */

const FETCH_TIMEOUT_MS = 12_000;

function numberOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

function clampPercent(value) {
  const n = numberOrNull(value);
  if (n === null) return null;
  return Math.max(0, Math.min(100, n));
}

/** 时间戳 → ISO：ISO 字符串 / 秒 / 毫秒都认（< 2e10 当秒） */
function toIso(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number' && Number.isFinite(value)) {
    if (value <= 0) return null;
    const d = new Date(value < 20_000_000_000 ? value * 1000 : value);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) return toIso(Number(value.trim()));
  const d = new Date(String(value));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** 「x 小时后重置 / x 天后重置」；没有时间返回空串 */
function resetText(iso, nowMs = Date.now()) {
  if (!iso) return '';
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return '';
  const delta = t - nowMs;
  if (delta <= 0) return '已重置';
  const hours = delta / 3_600_000;
  if (hours < 1) return Math.max(1, Math.round(delta / 60_000)) + ' 分钟后重置';
  if (hours >= 48) return (Math.round((hours / 24) * 10) / 10).toFixed(1) + ' 天后重置';
  return (Math.round(hours * 10) / 10).toFixed(1) + ' 小时后重置';
}

function fmtPercent(p) {
  return Math.round(p) + '%';
}

function fmtMoney(amount, currency) {
  const n = numberOrNull(amount);
  if (n === null) return '-';
  const sym = currency === 'USD' ? '$' : currency === 'CNY' ? '¥' : '';
  return sym + n.toFixed(2) + (sym ? '' : ' ' + (currency || ''));
}

/** 带状态的错误：status ∈ credential-missing / unauthorized / fetch-error / unsupported */
function balanceError(status, message) {
  const e = new Error(message || status);
  e.balanceStatus = status;
  return e;
}

function httpError(url, status) {
  let host = '';
  try {
    host = new URL(url).host;
  } catch {
    host = '';
  }
  if (status === 401 || status === 403) return balanceError('unauthorized', `登录已失效或 Key 无效（${host} HTTP ${status}）`);
  if (status === 429) return balanceError('fetch-error', `请求太频繁，稍后再试（${host} HTTP 429）`);
  return balanceError('fetch-error', `${host} 返回 HTTP ${status}`);
}

/**
 * GET/POST JSON（全局 fetch，带超时）。只把状态码放进错误信息。
 * @param {string} url
 * @param {{ method?: string, headers?: object, body?: string, fetch?: Function, timeoutMs?: number }} o
 */
async function fetchJson(url, o = {}) {
  const f = o.fetch || globalThis.fetch;
  let res;
  try {
    res = await f(url, {
      method: o.method || 'GET',
      headers: o.headers || {},
      body: o.body,
      signal: AbortSignal.timeout(o.timeoutMs || FETCH_TIMEOUT_MS),
    });
  } catch (e) {
    const timeout = e && (e.name === 'TimeoutError' || e.name === 'AbortError');
    let host = '';
    try {
      host = new URL(url).host;
    } catch {
      host = '';
    }
    throw balanceError('fetch-error', timeout ? `连接 ${host} 超时` : `连不上 ${host}（网络问题）`);
  }
  if (!res.ok) throw httpError(url, res.status);
  try {
    return await res.json();
  } catch {
    throw balanceError('fetch-error', '返回的不是 JSON');
  }
}

/** 统一的「多行气泡」成功结果（渲染端 shared-core 的 shape:'lines'） */
function linesResult(provider, rows, percent, extra = {}) {
  const p = clampPercent(percent);
  return { ok: true, provider, shape: 'lines', data: { rows, percent: p === null ? undefined : p, ...extra } };
}

function failResult(provider, reason, message) {
  const r = reason === 'unauthorized' ? 'credential-missing' : reason;
  const ok = ['unsupported', 'credential-missing', 'fetch-error'].includes(r) ? r : 'fetch-error';
  return message ? { ok: false, provider, reason: ok, message } : { ok: false, provider, reason: ok };
}

/** 把 provider 抛出的异常折成失败结果（未知异常只留类名，避免把意外内容带出去） */
function resultFromError(provider, e) {
  if (e && e.balanceStatus) return failResult(provider, e.balanceStatus, e.message);
  return failResult(provider, 'fetch-error', '查询出错（' + ((e && e.name) || 'Error') + '）');
}

module.exports = {
  FETCH_TIMEOUT_MS,
  numberOrNull,
  clampPercent,
  toIso,
  resetText,
  fmtPercent,
  fmtMoney,
  balanceError,
  httpError,
  fetchJson,
  linesResult,
  failResult,
  resultFromError,
};
