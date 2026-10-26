/**
 * ai-pet-7in1：角色切换（新增文件，不在原项目里）。
 *
 * 做法：**同一个窗口、同一个 PetSprite 原地换角色**——换掉动画池 / 素材目录 / 名字，
 * 位置、拖拽落点、窗口都不动；先播新角色的「登场」动画（animations.events.登场），播完自动回待机
 * （登场属于事件动画，原项目的 handleEnded 对事件动画播完就回 idle）。
 * 所有角色共用同一个 size（species.jsonc 顶层），所以窗口大小不用变。
 */
'use strict';

/** 右键菜单「切换角色」子菜单：自动 + 每个可用角色 */
function speciesMenuBranch(currentId) {
  const pets = (config && config.pets) || [];
  const auto = window.__aipetMode !== 'lock';
  return {
    label: '切换角色',
    children: [{ label: (auto ? '● ' : '') + '自动（跟随前台程序）', action: 'species-auto' }].concat(
      pets.map((p) => ({
        label: (!auto && p.id === currentId ? '● ' : '') + '锁定为 ' + p.name,
        action: 'species-lock',
        species: p.id,
      })),
    ),
  };
}

PetSprite.prototype.switchSpecies = function switchSpecies(pet) {
  if (!pet || pet.id === this.pet.id) return false;
  const prev = this.pet.id;
  this.closeMenu();
  this.stopMove();
  this.pet = pet;
  this.animations = pet.animations;
  this.weights = pet.animationWeights;
  this.assetRoot = pet.assetRoot || pet.id;
  this.assetBase = BASE + '/thumb/' + encodeURIComponent(this.assetRoot) + '/';
  this.hit.setAttribute('aria-label', pet.name);
  // 旧角色的气泡/待切换状态全部作废
  this.whisperOn = false;
  // 旧角色的「正在查询余额…」/余额气泡和它的定时器一并作废
  this.bubbleOn = false;
  this.balanceView = null;
  this.balanceWrap = false;
  if (this.bubbleTimer !== null) {
    window.clearTimeout(this.bubbleTimer);
    this.bubbleTimer = null;
  }
  this.renderBubble();
  this.pending = null;
  this.anim = '';
  this.animFallback.reset(); // 隔离名单按角色算（不同角色可能有同名动画）
  window.__dshPetDebug.species = pet.id;
  window.__dshPetDebug.lastSwitch = { from: prev, to: pet.id, at: Date.now() };
  // 拖拽/飞行中：只换素材，等松手/落地后由原有逻辑接着播
  if (this.dragState.active || this.throwRef !== null) {
    if (this.animations.drag.length) this.switchTo(this.animations.drag[0], false);
    return true;
  }
  const enter = this.animations.events && this.animations.events['登场'];
  const enterName = enter && enter.length ? (Array.isArray(enter[0]) ? enter[0][0] : enter[0]) : '';
  if (enterName) this.playOnce(enterName);
  else this.playIdle();
  return true;
};

async function applySpecies(id) {
  if (!id || !sprites.length) {
    CONFIG.species = id || CONFIG.species;
    return;
  }
  let pet = config && config.pets.find((p) => p.id === id);
  if (!pet) {
    // 可能是刚放进来的新素材：重新拉一次配置
    try {
      const fresh = await loadConfig();
      config = fresh;
      pet = fresh.pets.find((p) => p.id === id);
    } catch (e) {
      console.warn('[ai-pet] 重新加载配置失败', e);
    }
  }
  if (!pet) {
    console.warn('[ai-pet] 角色 ' + id + ' 没有可用素材，保持当前形象');
    return;
  }
  CONFIG.species = id;
  for (const s of sprites) s.switchSpecies(pet);
}

window.__dshPetDebug.species = CONFIG.species;
if (window.petBridge && window.petBridge.onSpecies) {
  window.petBridge.onSpecies((msg) => {
    if (msg && msg.mode) window.__aipetMode = msg.mode;
    void applySpecies(msg && msg.species);
  });
}
