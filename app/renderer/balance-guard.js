'use strict';
/**
 * 余额结果只给「发起请求的那个角色」看：
 *  - 结果带 petId / seq / at（主进程 main/balance/requests.js 打的标）
 *  - 不是当前角色的 → 丢；seq 不比上次新的（乱序/过期）→ 丢
 * 浏览器里挂在 window.BalanceGuard，Node 测试里 require。
 */
(function (root) {
  function createBalanceGuard() {
    let lastSeq = 0;
    return {
      /** @returns {{ok:true}|{ok:false, reason:'other-pet'|'stale'}} */
      accept(data, currentPetId) {
        if (!data || typeof data !== 'object') return { ok: false, reason: 'stale' };
        const pet = data.petId || data.character;
        if (pet && currentPetId && pet !== currentPetId) return { ok: false, reason: 'other-pet' };
        if (typeof data.seq === 'number') {
          if (data.seq <= lastSeq) return { ok: false, reason: 'stale' };
          lastSeq = data.seq;
        }
        return { ok: true };
      },
      get lastSeq() {
        return lastSeq;
      },
    };
  }
  if (typeof module === 'object' && module.exports) module.exports = { createBalanceGuard };
  else root.BalanceGuard = { createBalanceGuard };
})(typeof window !== 'undefined' ? window : globalThis);
