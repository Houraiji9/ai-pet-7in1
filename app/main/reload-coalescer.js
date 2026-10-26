'use strict';
/**
 * 「重建宠物窗口」合并器：素材下载完、改了配置、托盘点重载……短时间内多次请求只重建一次；
 * 用户正在拖 / 宠物正在飞时先等等（最多 maxDeferMs，超时照样重建，免得永远不生效）。
 */
function createReloadCoalescer({ run, snapshot, delayMs = 300, retryMs = 300, maxDeferMs = 10000, timers = { setTimeout, clearTimeout }, now = () => Date.now() }) {
  let reasons = [];
  let timer = null;
  let firstAt = 0;
  let running = false;

  function schedule(ms) {
    if (timer !== null) return;
    timer = timers.setTimeout(tick, ms);
  }
  async function tick() {
    timer = null;
    if (running) return schedule(retryMs);
    let snap = null;
    try {
      snap = await snapshot();
    } catch {
      snap = null;
    }
    if (snap && (snap.dragging || snap.flying) && now() - firstAt < maxDeferMs) return schedule(retryMs);
    const why = reasons;
    reasons = [];
    running = true;
    try {
      await run(why, snap);
    } finally {
      running = false;
      if (reasons.length) schedule(delayMs);
    }
  }
  return {
    request(why) {
      if (!reasons.length) firstAt = now();
      if (!reasons.includes(why)) reasons.push(why);
      schedule(delayMs);
    },
    get pending() {
      return reasons.slice();
    },
  };
}

/** 渲染端报回的位置（中心点占可视区的比例）→ 合法才用 */
function sanitizeRestorePos(p) {
  if (!p || typeof p !== 'object') return null;
  const rx = Number(p.rx);
  const ry = Number(p.ry);
  if (!Number.isFinite(rx) || !Number.isFinite(ry)) return null;
  // 先粗夹到 [0,1]；精确的「夹回可见工作区」由渲染端按新几何（S.clampPointToRegion）做
  return { rx: Math.min(1, Math.max(0, rx)), ry: Math.min(1, Math.max(0, ry)) };
}

module.exports = { createReloadCoalescer, sanitizeRestorePos };
