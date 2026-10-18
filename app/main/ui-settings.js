'use strict';
/**
 * ai-pet-7in1：界面设置（桌宠大小、开机自启），存在 %APPDATA%\ai-pet-7in1\ui-settings.json。
 * 纯 Node 模块，便于单测。
 */
const fs = require('fs');
const path = require('path');

/** 菜单里的大小档位（倍数 = 相对 species.jsonc 里的 size） */
const SIZE_PRESETS = [
  { label: '小（50%）', scale: 0.5 },
  { label: '中（75%）', scale: 0.75 },
  { label: '标准（100%）', scale: 1 },
  { label: '大（125%）', scale: 1.25 },
  { label: '特大（150%）', scale: 1.5 },
];
const MIN_SCALE = 0.3;
const MAX_SCALE = 2;
const DEFAULTS = { petScale: 1, autoStart: false };

function clampScale(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return 1;
  return Math.round(Math.min(MAX_SCALE, Math.max(MIN_SCALE, n)) * 100) / 100;
}

function createUiSettings(file) {
  let state = { ...DEFAULTS };
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    state = { petScale: clampScale(raw.petScale ?? 1), autoStart: raw.autoStart === true };
  } catch {
    /* 还没有设置文件 / 文件坏了：用默认 */
  }
  function save() {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(state, null, 2), 'utf8');
    } catch {
      /* 写不了不影响运行 */
    }
  }
  return {
    get: () => ({ ...state }),
    setPetScale(v) {
      state.petScale = clampScale(v);
      save();
      return state.petScale;
    },
    setAutoStart(on) {
      state.autoStart = !!on;
      save();
      return state.autoStart;
    },
  };
}

/** 开机自启要指向的 exe：便携版运行时 process.execPath 在临时解压目录，真实 exe 由 PORTABLE_EXECUTABLE_FILE 给出 */
function autoStartExePath(env, execPath) {
  return (env && env.PORTABLE_EXECUTABLE_FILE) || execPath;
}

module.exports = { createUiSettings, clampScale, autoStartExePath, SIZE_PRESETS, MIN_SCALE, MAX_SCALE };
