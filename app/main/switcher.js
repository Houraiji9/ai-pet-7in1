'use strict';
/**
 * 角色切换防抖（移植自 C# 桌宠 Pet.Core/Model.cs 的 Switcher）：
 *   - 采样到的候选角色必须**连续稳定** debounceMs（默认 300ms）才真正切换；
 *   - 采样到「不是 Agent」（null）或与当前角色相同 → 取消待定候选，保持当前角色；
 *   - 锁定模式（locked）下不自动切换。
 * 额外：isAvailable(character) 为 false（该角色还没有素材）时当作 null 处理，保持当前角色。
 */
class Switcher {
  constructor(initial, opts = {}) {
    this.current = initial;
    this.debounceMs = Number.isFinite(opts.debounceMs) ? opts.debounceMs : 300;
    this.isAvailable = opts.isAvailable || (() => true);
    this.locked = false;
    this.pending = null;
    this.since = 0;
  }
  clearPending() {
    this.pending = null;
  }
  select(character) {
    this.current = character;
    this.clearPending();
  }
  /** 喂一个采样；返回 true 表示这一拍发生了切换（this.current 已更新） */
  observe(character, now) {
    if (character && !this.isAvailable(character)) character = null;
    if (this.locked || !character || character === this.current) {
      this.clearPending();
      return false;
    }
    if (this.pending !== character || now < this.since) {
      this.pending = character;
      this.since = now;
      return false;
    }
    if (now - this.since < this.debounceMs) return false;
    this.select(character);
    return true;
  }
}

module.exports = { Switcher };
