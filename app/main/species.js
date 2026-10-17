'use strict';
/**
 * 角色（种类）配置与素材查找。纯 Node（不依赖 Electron），可单测。
 */
const fs = require('node:fs');
const path = require('node:path');
const { parseJsonc } = require('./jsonc.js');
const { CHARACTERS } = require('./matcher.js');

const ANIM_EXT = '.webm';
/** 合法的动画名：不能带路径分隔符/保留字符（防止 ../ 逃出素材目录） */
const BAD_NAME = /[\\/:*?"<>|\x00-\x1f]/;

/** 与原项目 config.jsonc 相同的全局默认（拖拽物理、字体等），每个角色条目都带一份 */
const GLOBAL_DEFAULTS = {
  chatMemoryRounds: 5,
  whisperModel: { provider: '', model: '' },
  chatModel: { provider: '', model: '' },
  whisperImageEnabled: false,
  chatImageEnabled: false,
  chatImageLimit: 10,
  memes: {},
  notificationsEnabled: false,
  confineToScreen: false,
  workStatusTexts: [[''], [''], [''], [''], [''], ['']],
  physics: { gravity: 1400, restitution: 0.78, groundFriction: 2.5, ceilingBounce: true, throwPower: 1, petCollision: false },
  font: { family: 'candy', size: 21, followPet: true },
  eventsRefreshSec: { balance: 1800, whisper: 300 },
};

const DEFAULT_POSITION = { corner: 'bottom-right', marginX: 40, marginY: 40 };
const CORNERS = ['top-left', 'top-right', 'bottom-left', 'bottom-right'];

/** 动画配置里引用到的所有动画名 */
function referencedAnims(animations) {
  const a = animations || {};
  const names = new Set();
  for (const k of ['idle', 'turn', 'drag', 'clicks']) for (const n of a[k] || []) names.add(n);
  for (const m of (a.moves && a.moves.actions) || []) names.add(m.name);
  for (const c of a.categories || []) for (const n of c.actions || []) names.add(n);
  for (const pool of Object.values(a.events || {})) {
    for (const slot of pool || []) for (const n of Array.isArray(slot) ? slot : [slot]) names.add(n);
  }
  return [...names].filter((n) => typeof n === 'string' && n);
}

/** 补齐动画配置的必填结构（原项目渲染端要求这些字段都存在） */
function normalizeAnimations(a) {
  const src = a && typeof a === 'object' ? a : {};
  const arr = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string' && x) : []);
  const moves = src.moves && typeof src.moves === 'object' ? src.moves : {};
  return {
    idle: arr(src.idle),
    turn: arr(src.turn),
    drag: arr(src.drag),
    clicks: arr(src.clicks),
    moves: {
      default: Object.assign({ minDist: 60, maxDist: 240, margin: 20, leadSec: 1, tailSec: 1 }, moves.default || {}),
      actions: (Array.isArray(moves.actions) ? moves.actions : []).filter((m) => m && typeof m.name === 'string'),
    },
    categories: (Array.isArray(src.categories) ? src.categories : []).filter((c) => c && Array.isArray(c.actions)),
    events: src.events && typeof src.events === 'object' ? src.events : {},
  };
}

/**
 * @param {object} o
 * @param {string} o.appRoot     app 目录（含 config/ assets/）
 * @param {string} o.userDir     用户目录（%APPDATA%\ai-pet-7in1），可放覆盖配置与素材
 * @param {string|null} o.projectAssetsDir 开发时的项目素材目录（ai-pet-7in1/assets），打包后为 null
 */
function createSpeciesStore({ appRoot, userDir, projectAssetsDir = null }) {
  let state = { size: 400, position: DEFAULT_POSITION, whisperIntervalSec: 300, species: {}, errors: [], file: '' };
  const fileCache = new Map();

  function configFile() {
    const user = userDir ? path.join(userDir, 'species.jsonc') : '';
    if (user && fs.existsSync(user)) return user;
    return path.join(appRoot, 'config', 'species.jsonc');
  }

  function load() {
    fileCache.clear();
    const file = configFile();
    const errors = [];
    let raw = {};
    try {
      raw = parseJsonc(fs.readFileSync(file, 'utf8'));
    } catch (e) {
      errors.push(`读取 ${file} 失败：${e && e.message ? e.message : e}`);
      // 用户配置坏了：退回程序自带的
      const fallback = path.join(appRoot, 'config', 'species.jsonc');
      if (file !== fallback) {
        try {
          raw = parseJsonc(fs.readFileSync(fallback, 'utf8'));
        } catch {
          raw = {};
        }
      }
    }
    const size = Number(raw.size) >= 120 && Number(raw.size) <= 1600 ? Number(raw.size) : 400;
    const pos = raw.position && typeof raw.position === 'object' ? raw.position : {};
    const position = {
      corner: CORNERS.includes(pos.corner) ? pos.corner : DEFAULT_POSITION.corner,
      marginX: Number.isFinite(Number(pos.marginX)) ? Number(pos.marginX) : DEFAULT_POSITION.marginX,
      marginY: Number.isFinite(Number(pos.marginY)) ? Number(pos.marginY) : DEFAULT_POSITION.marginY,
    };
    const whisperIntervalSec = Number.isFinite(Number(raw.whisperIntervalSec)) ? Math.max(0, Number(raw.whisperIntervalSec)) : 300;
    const species = {};
    const src = raw.species && typeof raw.species === 'object' ? raw.species : {};
    for (const id of CHARACTERS) {
      const s = src[id];
      if (!s || typeof s !== 'object') {
        species[id] = { id, name: id, enabled: false, whisperPrompt: '', whisperLines: [], animations: normalizeAnimations({}), animationWeights: { idle: 100, turn: 0, move: 0 } };
        continue;
      }
      const w = s.animationWeights && typeof s.animationWeights === 'object' ? s.animationWeights : {};
      species[id] = {
        id,
        name: String(s.name || id),
        enabled: s.enabled !== false,
        whisperPrompt: String(s.whisperPrompt || ''),
        whisperLines: (Array.isArray(s.whisperLines) ? s.whisperLines : []).map(String).filter(Boolean),
        animations: normalizeAnimations(s.animations),
        animationWeights: { idle: Number(w.idle) || 0, turn: Number(w.turn) || 0, move: Number(w.move) || 0 },
      };
      if (!species[id].animations.idle.length) errors.push(`角色 ${id} 没有配置 animations.idle`);
    }
    for (const k of Object.keys(src)) if (!CHARACTERS.includes(k)) errors.push(`未知角色 id：${k}（只认 ${CHARACTERS.join('/')}）`);
    state = { size, position, whisperIntervalSec, species, errors, file };
    return state;
  }

  /** 某个角色的素材目录（按优先级） */
  function assetDirs(id) {
    const dirs = [];
    if (userDir) dirs.push({ dir: path.join(userDir, 'species', id), kind: 'user' });
    if (projectAssetsDir) dirs.push({ dir: path.join(projectAssetsDir, id, 'webm'), kind: 'project' });
    dirs.push({ dir: path.join(appRoot, 'assets', id, 'webm'), kind: 'bundled' });
    dirs.push({ dir: path.join(appRoot, 'assets', 'placeholder', id), kind: 'placeholder' });
    return dirs;
  }

  /** 找动画文件：返回 { file, kind } 或 null。name 不带扩展名 */
  function resolveAnim(id, name) {
    if (!CHARACTERS.includes(id) || typeof name !== 'string' || !name || BAD_NAME.test(name) || name.includes('..')) return null;
    const key = id + '/' + name;
    if (fileCache.has(key)) return fileCache.get(key);
    let hit = null;
    for (const { dir, kind } of assetDirs(id)) {
      const f = path.join(dir, name + ANIM_EXT);
      try {
        if (fs.statSync(f).isFile()) {
          hit = { file: f, kind };
          break;
        }
      } catch {
        /* 不存在 */
      }
    }
    fileCache.set(key, hit);
    return hit;
  }

  function isAvailable(id) {
    const s = state.species[id];
    if (!s || !s.enabled || !s.animations.idle.length) return false;
    return resolveAnim(id, s.animations.idle[0]) !== null;
  }

  /** 角色素材概况（调试窗口 / 托盘用） */
  function describe(id) {
    const s = state.species[id];
    if (!s) return null;
    const names = referencedAnims(s.animations);
    const found = {};
    const missing = [];
    for (const n of names) {
      const r = resolveAnim(id, n);
      if (r) found[n] = r.kind;
      else missing.push(n);
    }
    const kinds = new Set(Object.values(found));
    return {
      id,
      name: s.name,
      enabled: s.enabled,
      available: isAvailable(id),
      placeholder: kinds.has('placeholder'),
      total: names.length,
      missing,
    };
  }

  /** 去掉找不到素材的动画名，避免渲染端点到 404（例如 gpt 只到了一部分素材时） */
  function prunedAnimations(id) {
    const s = state.species[id];
    const a = JSON.parse(JSON.stringify(s.animations));
    const ok = (n) => resolveAnim(id, n) !== null;
    for (const k of ['idle', 'turn', 'drag', 'clicks']) a[k] = a[k].filter(ok);
    a.moves.actions = a.moves.actions.filter((m) => ok(m.name));
    a.categories = a.categories.map((c) => ({ ...c, actions: c.actions.filter(ok) })).filter((c) => c.actions.length);
    const ev = {};
    for (const [k, pool] of Object.entries(a.events)) {
      const kept = (pool || [])
        .map((slot) => (Array.isArray(slot) ? slot.filter(ok) : ok(slot) ? slot : null))
        .filter((slot) => slot && (!Array.isArray(slot) || slot.length));
      if (kept.length) ev[k] = kept;
    }
    // 碎碎念必须有一个动画池（渲染端要求）：没有就用待机
    if (!ev.whisper && a.idle.length) ev.whisper = [a.idle[0]];
    a.events = ev;
    return a;
  }

  /** 交给渲染端的「成品聚合」配置：与原项目 GET /config 同形（{ 条目: {...全局字段, pets, animations, animationWeights} }），只含可用角色 */
  function mergedConfig() {
    const out = {};
    for (const id of CHARACTERS) {
      if (!isAvailable(id)) continue;
      const s = state.species[id];
      const anims = prunedAnimations(id);
      out[id] = {
        ...JSON.parse(JSON.stringify(GLOBAL_DEFAULTS)),
        whisperPrompt: s.whisperPrompt,
        pets: [
          {
            name: s.name,
            id,
            size: state.size,
            // 只控制「查看余额后播档位动画」：主进程不做自动余额轮询，所以这里打开不会定时弹气泡
            balanceEnabled: Array.isArray(anims.events.balance) && anims.events.balance.length === 6,
            whisperEnabled: false, // 自动碎碎念由主进程定时器负责（见 main.js），渲染端不自己轮询
            workStatusEnabled: false,
            fixedEnabled: false,
            display: 'desktop',
            position: state.position,
          },
        ],
        animations: anims,
        animationWeights: s.animationWeights,
      };
    }
    return out;
  }

  function get() {
    return state;
  }

  load();
  return { load, get, assetDirs, resolveAnim, isAvailable, describe, mergedConfig, configFile };
}

module.exports = { createSpeciesStore, referencedAnims, normalizeAnimations, GLOBAL_DEFAULTS };
