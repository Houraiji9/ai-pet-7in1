'use strict';
/**
 * 取代原项目「DSH 宿主半边」的本地接口（同一套 URL：/dsh-pet-7340/...），在 Electron 主进程里直接应答。
 * 渲染端代码（runtime/electron-helper 复制来的 sprite.js / events.js / renderer.js）几乎不用改。
 *
 * 可用：config / state / thumb（动画）/ font / pic（光标图）/ whisper（本地台词）/ anim（点播）/
 *       balance（查看余额：POST 只触发查询，结果异步写进 /state 的 sections.balance，见 main/balance/）
 * 关闭：chat（对话需要大模型，MVP 不做）、pet-display（显示位置）
 */
const fs = require('node:fs');
const path = require('node:path');

const PREFIX = '/dsh-pet-7340';
const MIME = { '.webm': 'video/webm', '.ttf': 'font/ttf', '.png': 'image/png', '.json': 'application/json' };

/** 轮询状态（与原项目 src/host/state.ts 同形：counter 严格递增） */
class PollState {
  constructor() {
    this.last = 0;
    this.sections = { balance: { counter: 0, data: null }, workStatus: { counter: 0, data: null }, notify: { counter: 0, data: null } };
    this.pets = {};
  }
  next() {
    this.last = Math.max(Date.now(), this.last + 1);
    return this.last;
  }
  writeSection(name, data) {
    this.sections[name] = { counter: this.next(), data };
  }
  writePet(petId, leaf, data) {
    if (!this.pets[petId]) this.pets[petId] = { say: { counter: 0, data: null }, anim: { counter: 0, data: null } };
    this.pets[petId][leaf] = { counter: this.next(), data };
  }
  read() {
    return { sections: { ...this.sections }, pets: { ...this.pets } };
  }
}

/**
 * @param {object} o
 * @param {ReturnType<import('./species').createSpeciesStore>} o.store
 * @param {string} o.appRoot
 * @param {() => void} [o.onReload]
 * @param {(petId: string) => void} [o.onBalance] 右键「查看余额」：主进程去查当前角色，查完调用 writeBalance
 */
function createPetApi({ store, appRoot, onReload = () => {}, onBalance = null }) {
  const state = new PollState();
  let configVersion = 1;
  const lastLine = {};

  const json = (status, obj) => ({ status, contentType: 'application/json; charset=utf-8', body: JSON.stringify(obj) });
  const text = (status, s) => ({ status, contentType: 'text/plain; charset=utf-8', body: s });

  function pickLine(id) {
    const s = store.get().species[id];
    const lines = (s && s.whisperLines) || [];
    if (!lines.length) return null;
    let line = lines[Math.floor(Math.random() * lines.length)];
    if (lines.length > 1 && line === lastLine[id]) line = lines[(lines.indexOf(line) + 1) % lines.length];
    lastLine[id] = line;
    return line;
  }

  /** 碎碎念配图：与原项目一致，从该角色 memes 池随机抽 1 张（文件缺失的跳过） */
  function pickMeme(id) {
    const cfg = store.get();
    if (cfg.whisperImageEnabled === false) return '';
    const s = cfg.species[id];
    const dir = path.join(appRoot, 'assets', 'pic', 'memes', id);
    const keys = Object.keys((s && s.memes) || {}).filter((k) => fs.existsSync(path.join(dir, k + '.png')));
    return keys.length ? keys[Math.floor(Math.random() * keys.length)] : '';
  }

  /** 让某个角色说一句（右键「碎碎念」和自动定时器共用） */
  function whisper(id) {
    const line = pickLine(id);
    if (!line) return false;
    const image = pickMeme(id);
    state.writePet(id, 'say', image ? { text: line, image } : { text: line });
    return true;
  }

  function serveFile(file) {
    const ext = path.extname(file).toLowerCase();
    return { status: 200, contentType: MIME[ext] || 'application/octet-stream', file };
  }

  /** 安全地在 root 下找文件（拒绝 ../ 逃逸） */
  function within(root, rel) {
    const f = path.resolve(root, rel);
    if (f !== root && !f.startsWith(root + path.sep)) return null;
    try {
      return fs.statSync(f).isFile() ? f : null;
    } catch {
      return null;
    }
  }

  /** 处理一个请求：pathname 形如 /dsh-pet-7340/config?x=1 */
  function handle(method, rawUrl, _body) {
    const url = new URL(rawUrl, 'http://localhost');
    if (!url.pathname.startsWith(PREFIX + '/')) return text(404, 'not found');
    let rest;
    try {
      rest = decodeURIComponent(url.pathname.slice(PREFIX.length + 1));
    } catch {
      return text(400, 'bad url');
    }
    const petId = String(url.searchParams.get('pet') || '');

    if (rest === 'config') {
      if (method !== 'GET') return json(405, { error: 'method not allowed' });
      return json(200, store.mergedConfig());
    }
    if (rest === 'state') {
      return json(200, { ...state.read(), configVersion: String(configVersion) });
    }
    if (rest === 'whisper') {
      if (method !== 'POST') return json(405, { error: 'method not allowed' });
      return json(200, whisper(petId) ? { ok: true } : { ok: false, reason: 'no-lines', message: '这个角色没有配置 whisperLines' });
    }
    if (rest === 'anim') {
      if (method !== 'POST') return json(405, { error: 'method not allowed' });
      let name = '';
      try {
        name = String(JSON.parse(_body || '{}').name || '');
      } catch {
        return json(400, { error: 'invalid JSON body' });
      }
      if (!store.resolveAnim(petId, name)) return json(200, { ok: false, reason: 'not-found' });
      state.writePet(petId, 'anim', { name });
      return json(200, { ok: true });
    }
    if (rest === 'chat') {
      // 对话需要接大模型（凭证、计费），MVP 明确关闭，返回结构化失败而不是假装成功
      return json(200, { ok: false, reason: 'disabled', message: '对话功能在这个版本里还没开放' });
    }
    if (rest === 'balance') {
      if (method !== 'POST') return json(405, { error: 'method not allowed' });
      if (!onBalance) return json(200, { ok: false, reason: 'disabled' });
      setTimeout(() => onBalance(petId), 0);
      return json(200, { ok: true });
    }
    if (rest === 'reload') {
      if (method !== 'POST') return json(405, { error: 'method not allowed' });
      configVersion++;
      setTimeout(onReload, 0);
      return json(200, { reloading: true });
    }
    if (rest === 'pet-display') return json(200, { ok: false, reason: 'disabled' });

    const [scope, ...parts] = rest.split('/');
    if (scope === 'font') {
      const f = within(path.join(appRoot, 'assets', 'fonts'), parts.join('/'));
      return f ? serveFile(f) : text(404, 'font not found');
    }
    if (scope === 'pic') {
      const f = within(path.join(appRoot, 'assets', 'pic'), parts.join('/'));
      return f ? serveFile(f) : text(404, 'pic not found');
    }
    if (scope === 'thumb') {
      const [sid, ...nameParts] = parts;
      const file = nameParts.join('/');
      if (!sid || !file.toLowerCase().endsWith('.webm')) return text(400, 'expected /thumb/<角色>/<动画>.webm');
      const hit = store.resolveAnim(sid, file.slice(0, -5));
      return hit ? serveFile(hit.file) : text(404, 'asset not found: ' + sid + '/' + file);
    }
    return text(404, 'not found');
  }

  return {
    handle,
    whisper,
    /** 余额结果（已经是渲染端认的叶子数据：ok/shape/data 或 ok:false/reason/message，外加 manual） */
    writeBalance(data) {
      state.writeSection('balance', data);
    },
    bumpConfigVersion() {
      configVersion++;
    },
  };
}

module.exports = { createPetApi, PollState, PREFIX };
