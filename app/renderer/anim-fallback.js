'use strict';
/**
 * 素材播放失败兜底（纯逻辑；浏览器挂 window.AnimFallback，Node 测试 require）：
 *  - 失败的动画「隔离」一小会儿（默认 60s），期间不再去加载它
 *  - 选兜底：上一段成功播放的动画 → 待机池里第一个没被隔离的 → 没有就 null（保持现状）
 */
(function (root) {
  function createAnimFallback({ quarantineMs = 60000, now = () => Date.now() } = {}) {
    const bad = new Map(); // name → 解除隔离的时间
    let lastGood = '';
    function isQuarantined(name) {
      const t = bad.get(name);
      if (t === undefined) return false;
      if (now() >= t) {
        bad.delete(name);
        return false;
      }
      return true;
    }
    return {
      isQuarantined,
      fail(name) {
        bad.set(name, now() + quarantineMs);
        if (lastGood === name) lastGood = '';
      },
      ok(name) {
        lastGood = name;
        bad.delete(name);
      },
      get lastGood() {
        return lastGood;
      },
      pick(failed, idlePool) {
        const okName = (n) => typeof n === 'string' && n && n !== failed && !isQuarantined(n);
        if (okName(lastGood)) return lastGood;
        for (const n of idlePool || []) if (okName(n)) return n;
        return null;
      },
      reset() {
        bad.clear();
        lastGood = '';
      },
    };
  }
  if (typeof module === 'object' && module.exports) module.exports = { createAnimFallback };
  else root.AnimFallback = { createAnimFallback };
})(typeof window !== 'undefined' ? window : globalThis);
