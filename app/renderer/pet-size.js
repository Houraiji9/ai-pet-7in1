/**
 * ai-pet-7in1：桌宠大小（新增文件，不在原项目里）。
 *
 * 大小 = species.jsonc 的 size × 用户倍数（CONFIG.userScale）。倍数由主进程保存（ui-settings.json），
 * 右键/托盘「桌宠大小」或 Ctrl+滚轮改动 → 主进程保存 → 回推 pet:user-scale → 这里就地重建 sprite。
 * PetSprite 的尺寸在构造时定死（命中区/余量/抛掷空间都由它派生），所以换大小 = 新建一只同角色的 sprite，
 * 并让**脚底中点**留在原处（脚底 = 包围盒顶 + 舞台高，见 sprite.js 里 bottomPad 的推导）。
 */
'use strict';

const PET_SIZE_PRESETS = [
  { label: '小（50%）', scale: 0.5 },
  { label: '中（75%）', scale: 0.75 },
  { label: '标准（100%）', scale: 1 },
  { label: '大（125%）', scale: 1.25 },
  { label: '特大（150%）', scale: 1.5 },
];
const PET_SCALE_MIN = 0.3;
const PET_SCALE_MAX = 2;
const PET_SCALE_STEP = 0.05;

function clampPetScale(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return 1;
  return Math.round(Math.min(PET_SCALE_MAX, Math.max(PET_SCALE_MIN, n)) * 100) / 100;
}

/** 配置里的宠物 → 按当前倍数放大后的副本（配置本身不动，换角色时仍拿原值） */
function scaledPet(pet) {
  return { ...pet, size: Math.round(pet.size * clampPetScale(CONFIG.userScale)) };
}

/** 右键菜单「桌宠大小」子菜单 */
function petSizeMenuBranch() {
  const cur = clampPetScale(CONFIG.userScale);
  return {
    label: '桌宠大小（' + Math.round(cur * 100) + '%）',
    children: PET_SIZE_PRESETS.map((p) => ({
      label: (p.scale === cur ? '● ' : '') + p.label,
      action: 'pet-size',
      scale: p.scale,
    })),
  };
}

function requestPetScale(v) {
  const next = clampPetScale(v);
  if (window.petBridge && window.petBridge.setUserScale) window.petBridge.setUserScale(next);
  else applyPetScale(next); // 没有主进程（浏览器里调试）：直接生效
}

/** 主进程确认后的新倍数：就地重建 sprite，脚底不动 */
function applyPetScale(v) {
  const next = clampPetScale(v);
  if (next === clampPetScale(CONFIG.userScale) && sprites.length && sprites[0].size === scaledPet(sprites[0].pet).size) return;
  CONFIG.userScale = next;
  window.__dshPetDebug.userScale = next;
  const old = sprites[0];
  if (!old) return; // 还没 boot：boot 时会按 CONFIG.userScale 建
  const pet = (config && config.pets.find((p) => p.id === old.pet.id)) || old.pet;
  const footX = old.pos.x + old.halfW;
  const footY = old.pos.y + old.height;
  old.dispose();
  const s = new PetSprite(scaledPet(pet));
  sprites = [s];
  s.customPos = { rx: footX / VIEW.w, ry: (footY - s.height + s.halfH) / VIEW.h };
  s.position();
  s.playIdle();
}

// Ctrl+滚轮：攒一小段再发，避免每格滚轮都重建一次
let wheelScale = null;
let wheelTimer = null;
function onPetWheel(e) {
  if (!e.ctrlKey) return;
  e.preventDefault();
  const s = sprites[0];
  if (!s || s.dragState.active || s.menuOpen) return;
  const base = wheelScale ?? clampPetScale(CONFIG.userScale);
  wheelScale = clampPetScale(base + (e.deltaY < 0 ? PET_SCALE_STEP : -PET_SCALE_STEP));
  if (wheelTimer) clearTimeout(wheelTimer);
  wheelTimer = setTimeout(() => {
    wheelTimer = null;
    const v = wheelScale;
    wheelScale = null;
    requestPetScale(v);
  }, 120);
}

if (window.petBridge && window.petBridge.onUserScale) {
  window.petBridge.onUserScale((v) => applyPetScale(v));
}
