'use strict';
/**
 * 测试隔离（AIPET_TEST_ISOLATED=1 时由 main.js 最早加载）：
 * 只放行 127.0.0.1 / localhost / ::1 的网络请求，其它一律抛错——冒烟测试永远不碰真实网络。
 * 纯函数部分可单测。
 */
function isLoopbackUrl(u) {
  let url;
  try { url = new URL(String(u && u.url ? u.url : u)); } catch { return false; }
  if (!/^https?:$|^wss?:$/.test(url.protocol)) return url.protocol === 'file:' || url.protocol === 'data:';
  const h = url.hostname.replace(/^\[|\]$/g, '');
  return h === '127.0.0.1' || h === 'localhost' || h === '::1';
}

function guardFetch(realFetch, onBlock) {
  return function guardedFetch(input, init) {
    if (!isLoopbackUrl(input)) {
      if (onBlock) onBlock(String(input && input.url ? input.url : input));
      return Promise.reject(new Error('AIPET_TEST_ISOLATED: 禁止访问外网 ' + String(input && input.url ? input.url : input)));
    }
    return realFetch(input, init);
  };
}

function installNodeGuard(onBlock) {
  if (typeof globalThis.fetch === 'function') globalThis.fetch = guardFetch(globalThis.fetch.bind(globalThis), onBlock);
  for (const mod of ['http', 'https']) {
    const m = require(mod);
    for (const fn of ['request', 'get']) {
      const orig = m[fn];
      m[fn] = function (...a) {
        const first = a[0];
        const host = typeof first === 'string' || first instanceof URL ? new URL(String(first)).hostname : (first && (first.hostname || first.host)) || 'localhost';
        if (!isLoopbackUrl('http://' + (host.includes(':') && !host.startsWith('[') ? '[' + host + ']' : host) + '/')) {
          if (onBlock) onBlock(mod + '://' + host);
          throw new Error('AIPET_TEST_ISOLATED: 禁止访问外网 ' + host);
        }
        return orig.apply(this, a);
      };
    }
  }
}

module.exports = { isLoopbackUrl, guardFetch, installNodeGuard };
