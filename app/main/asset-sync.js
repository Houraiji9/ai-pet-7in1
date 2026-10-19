'use strict';
/**
 * 动画素材按需下载（安装包只带每个角色的待机动画，其余动画第一次启动 / 缺了的时候从 GitHub 下）。
 *
 * 发布方式（见 tools/publish-assets.js）：GitHub 上一个固定的 Release，tag = assets，里面放
 *   - manifest.json：{ schema: 1, generated, files: [{ id, name, sha256, size }] }
 *   - <sha256>.webm：每个动画一份，用内容的 sha256 命名（Release 附件名不能带中文，也正好天然去重 / 增量）
 * 客户端：拉 manifest → 和本地（%APPDATA%\ai-pet-7in1\assets\<角色>\<动画名>.webm）比 sha256 →
 * 只下新增或变了的文件；.part 断点续传（Range）；下完校验 sha256 才改名生效。当前角色优先，其余角色排在后面。
 * 没网：静默失败，过一会再试；已经下好的 / 安装包自带的照常用（缺的动画渲染端会自动跳过，最差只播待机）。
 * 纯 Node，fetch 由外面注入（主进程传 electron 的 net.fetch，走系统代理），可单测。
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const DEFAULT_BASE = 'https://github.com/Houraiji9/ai-pet-7in1/releases/download/assets/';
const SHA_RE = /^[0-9a-f]{64}$/;
const BAD_NAME = /[\\/:*?"<>|\x00-\x1f]/;

function sha256File(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(file).on('error', reject).on('data', (d) => h.update(d)).on('end', () => resolve(h.digest('hex')));
  });
}

function validManifest(m, characters) {
  if (!m || m.schema !== 1 || !Array.isArray(m.files)) throw new Error('manifest 格式不对');
  return m.files.filter(
    (f) => f && characters.includes(f.id) && typeof f.name === 'string' && f.name && !BAD_NAME.test(f.name) && !f.name.includes('..') &&
      SHA_RE.test(f.sha256) && Number.isInteger(f.size) && f.size > 0 && f.size < 200 * 1024 * 1024,
  );
}

/**
 * @param {object} o
 * @param {string} o.dir            下载目录（userData/assets）
 * @param {string[]} o.characters   角色 id 列表
 * @param {(id:string,name:string)=>string|null} o.bundledFile 安装包自带的同名文件路径（有且 sha 一样就不下）
 * @param {Function} o.fetch        fetch 实现
 * @param {string} [o.baseUrl]
 * @param {Function} [o.log]
 * @param {(s:object)=>void} [o.onProgress]
 * @param {(id:string, changed:number)=>void} [o.onRoleDone] 某个角色这一轮下完（changed=新下的个数）
 */
function createAssetSync(o) {
  const dir = o.dir;
  const base = o.baseUrl || DEFAULT_BASE;
  const log = o.log || (() => {});
  const fetchImpl = o.fetch;
  const indexFile = path.join(dir, 'index.json');
  const concurrency = o.concurrency || 3;
  let index = {};
  try { index = JSON.parse(fs.readFileSync(indexFile, 'utf8')) || {}; } catch { index = {}; }
  const bundledSha = new Map();

  let status = { state: 'idle', doneBytes: 0, totalBytes: 0, doneFiles: 0, totalFiles: 0, current: '', error: '', perRole: {} };
  let queue = []; // 待下载 [{id,name,sha256,size}]
  let running = null;
  let priority = null;
  let stopped = false;

  const emit = () => { if (o.onProgress) o.onProgress(getStatus()); };
  function getStatus() {
    const pct = status.totalBytes ? Math.floor((status.doneBytes / status.totalBytes) * 100) : status.state === 'done' ? 100 : 0;
    return { ...status, percent: Math.min(100, pct), perRole: JSON.parse(JSON.stringify(status.perRole)) };
  }
  function saveIndex() {
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(indexFile + '.tmp', JSON.stringify(index));
      fs.renameSync(indexFile + '.tmp', indexFile);
    } catch (e) { log('[素材] 写索引失败：' + e.message); }
  }
  const target = (f) => path.join(dir, f.id, f.name + '.webm');

  /** 本地已有且内容一致？（先看索引里记的 size+mtime，对不上才重新算 sha） */
  async function haveLocal(f) {
    const p = target(f);
    const key = f.id + '/' + f.name;
    try {
      const st = fs.statSync(p);
      const rec = index[key];
      if (rec && rec.size === st.size && rec.mtimeMs === st.mtimeMs) return rec.sha256 === f.sha256;
      if (st.size !== f.size) return false;
      const sha = await sha256File(p);
      index[key] = { sha256: sha, size: st.size, mtimeMs: st.mtimeMs };
      return sha === f.sha256;
    } catch { /* 没有 */ }
    const b = o.bundledFile ? o.bundledFile(f.id, f.name) : null;
    if (b) {
      if (!bundledSha.has(b)) { try { bundledSha.set(b, await sha256File(b)); } catch { bundledSha.set(b, ''); } }
      if (bundledSha.get(b) === f.sha256) return true;
    }
    return false;
  }

  async function getJson(url) {
    const r = await fetchImpl(url, { cache: 'no-store', headers: { accept: 'application/octet-stream' } });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return r.json();
  }

  /** 下一个文件：.part 续传 → 校验 → 改名 */
  async function downloadOne(f, onBytes) {
    const p = target(f);
    const part = p + '.part';
    fs.mkdirSync(path.dirname(p), { recursive: true });
    let have = 0;
    try { have = fs.statSync(part).size; } catch { have = 0; }
    if (have >= f.size) { try { fs.unlinkSync(part); } catch {} have = 0; }
    const headers = have ? { range: `bytes=${have}-` } : {};
    const r = await fetchImpl(base + f.sha256 + '.webm', { headers });
    if (r.status === 416) { try { fs.unlinkSync(part); } catch {} throw new Error('续传位置不对，重下'); }
    if (!r.ok) throw new Error('HTTP ' + r.status);
    if (have && r.status !== 206) have = 0; // 服务器不认 Range：从头来
    if (have) onBytes(have);
    const out = fs.createWriteStream(part, { flags: have ? 'a' : 'w' });
    try {
      const reader = r.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (stopped) throw new Error('已停止');
        if (!out.write(Buffer.from(value))) await new Promise((res) => out.once('drain', res));
        onBytes(value.byteLength);
      }
    } finally {
      await new Promise((res) => out.end(res));
    }
    const sha = await sha256File(part);
    if (sha !== f.sha256) { fs.unlinkSync(part); throw new Error('校验不通过（sha256 不一致）'); }
    fs.renameSync(part, p);
    const st = fs.statSync(p);
    index[f.id + '/' + f.name] = { sha256: sha, size: st.size, mtimeMs: st.mtimeMs };
  }

  function sortQueue() {
    if (!priority) return;
    queue.sort((a, b) => (a.id === priority ? 0 : 1) - (b.id === priority ? 0 : 1));
  }

  /** 一轮同步。返回 Promise；重复调用时复用正在跑的那一轮 */
  function sync() {
    if (running) return running;
    stopped = false;
    running = (async () => {
      status = { state: 'checking', doneBytes: 0, totalBytes: 0, doneFiles: 0, totalFiles: 0, current: '', error: '', perRole: {} };
      emit();
      let files;
      try {
        files = validManifest(await getJson(base + 'manifest.json'), o.characters);
      } catch (e) {
        status.state = 'offline';
        status.error = String(e && e.message ? e.message : e);
        log('[素材] 拿不到清单（多半是没网或连不上 GitHub），先用已有的素材：' + status.error);
        emit();
        return getStatus();
      }
      const need = [];
      for (const f of files) if (!(await haveLocal(f))) need.push(f);
      saveIndex();
      queue = need;
      sortQueue();
      for (const f of need) {
        const r = (status.perRole[f.id] = status.perRole[f.id] || { done: 0, total: 0 });
        r.total++;
      }
      status.totalFiles = need.length;
      status.totalBytes = need.reduce((s, f) => s + f.size, 0);
      if (!need.length) { status.state = 'done'; emit(); return getStatus(); }
      log(`[素材] 需要下载 ${need.length} 个动画，共 ${(status.totalBytes / 1048576).toFixed(1)} MB`);
      status.state = 'downloading';
      emit();
      let failed = 0;
      const changedByRole = {};
      const remaining = {};
      for (const f of need) remaining[f.id] = (remaining[f.id] || 0) + 1;
      const worker = async () => {
        while (queue.length && !stopped) {
          const f = queue.shift();
          status.current = f.id + '/' + f.name;
          let ok = false;
          for (let attempt = 1; attempt <= 3 && !ok && !stopped; attempt++) {
            let got = 0;
            try {
              await downloadOne(f, (n) => { got += n; status.doneBytes += n; emit(); });
              ok = true;
            } catch (e) {
              status.doneBytes -= got;
              log(`[素材] ${f.id}/${f.name} 第 ${attempt} 次下载失败：${e && e.message ? e.message : e}`);
              if (attempt < 3) await new Promise((res) => setTimeout(res, 1500 * attempt));
            }
          }
          if (ok) {
            status.doneFiles++;
            status.perRole[f.id].done++;
            changedByRole[f.id] = (changedByRole[f.id] || 0) + 1;
          } else {
            failed++;
            status.doneBytes += 0;
          }
          if (--remaining[f.id] === 0) {
            saveIndex();
            if (o.onRoleDone) try { o.onRoleDone(f.id, changedByRole[f.id] || 0); } catch (e) { log('[素材] onRoleDone 出错：' + e); }
          }
          emit();
        }
      };
      await Promise.all(Array.from({ length: concurrency }, worker));
      saveIndex();
      status.current = '';
      status.state = failed ? 'partial' : 'done';
      if (failed) status.error = `${failed} 个文件没下成功，稍后会自动重试`;
      log(`[素材] 本轮结束：下好 ${status.doneFiles}/${status.totalFiles}${failed ? `，失败 ${failed}` : ''}`);
      emit();
      return getStatus();
    })().finally(() => { running = null; });
    return running;
  }

  return {
    sync,
    getStatus,
    /** 当前角色优先 */
    prioritize(id) { priority = id; sortQueue(); },
    stop() { stopped = true; },
    isRunning: () => !!running,
  };
}

module.exports = { createAssetSync, validManifest, sha256File, DEFAULT_BASE };
