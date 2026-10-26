'use strict';
/**
 * 「查看余额」请求编排：结果绑定到发起请求的角色。
 *  - 每次请求一个递增 seq；同一角色只认最新一次请求的结果（旧请求晚到 → 丢）
 *  - 结果回来时当前角色已经换了 → 只进缓存，不写给渲染端
 *  - 写出去的叶子带 petId / seq / at，渲染端再按当前角色和 seq 过滤一次
 *  - 缓存按 角色 + 来源（provider）分开
 */
function createBalanceRequests({ query, write, current, now = () => Date.now(), log = () => {} }) {
  let seq = 0;
  const latest = new Map(); // petId → 最新请求 seq
  const cache = new Map(); // `${petId}|${source}` → leaf

  function request(petId) {
    const my = ++seq;
    latest.set(petId, my);
    return Promise.resolve()
      .then(() => query(petId))
      .then((leaf) => {
        const tagged = { ...leaf, petId, seq: my, at: now() };
        cache.set(petId + '|' + String((leaf && (leaf.source || leaf.provider)) || ''), tagged);
        if (latest.get(petId) !== my) {
          log(`[余额] 丢弃过期结果 pet=${petId} seq=${my}`);
          return { written: false, reason: 'stale', leaf: tagged };
        }
        if (current() !== petId) {
          log(`[余额] 角色已切换，丢弃 pet=${petId} 的结果`);
          return { written: false, reason: 'switched', leaf: tagged };
        }
        write(tagged);
        return { written: true, leaf: tagged };
      });
  }

  return {
    request,
    cached(petId) {
      return [...cache.entries()].filter(([k]) => k.startsWith(petId + '|')).map(([, v]) => v);
    },
  };
}

module.exports = { createBalanceRequests };
