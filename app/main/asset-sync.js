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
const { pipeline } = require('node:stream/promises');
const { Readable, Transform } = require('node:stream');

const DEFAULT_BASE = 'https://github.com/Houraiji9/ai-pet-7in1/releases/download/assets/';
const SHA_RE = /^[0-9a-f]{64}$/;
const BAD_NAME = /[\\/:*?"<>|\x00-\x1f]/;
const MAX_FILE = 200 * 1024 * 1024;
const MAX_MANIFEST = 4 * 1024 * 1024;

/** 主动停止（stop() / 退出）——和网络失败区分开，不重试、不算失败 */
class StoppedError extends Error {
  constructor() { super('已停止'); this.stopped = true; }
}

/** 解析 206 的 Content-Range：bytes <start>-<end>/<total> */
function parseContentRange(v) {
  const m = /^bytes (\d+)-(\d+)\/(\d+|\*)$/.exec(String(v || '').trim());
  if (!m) return null;
  return { start: Number(m[1]), end: Number(m[2]), total: m[3] === '*' ? null : Number(m[3]) };
}

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
      SHA_RE.test(f.sha256) && Number.isInteger(f.size) && f.size > 0 && f.size < MAX_FILE,
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

  const overallMs = o.timeoutMs || 10 * 60 * 1000; // 单个请求总时长上限
  const idleMs = o.idleTimeoutMs || 30 * 1000; // 多久没收到数据就算卡死
  const controllers = new Set();

  /** 带总超时 / 空闲超时 / stop() 取消的请求；返回 { res, ctl, touch, done } */
  async function request(url, opts = {}) {
    if (stopped) throw new StoppedError();
    const ctl = new AbortController();
    controllers.add(ctl);
    let why = '';
    const abort = (reason) => { if (!ctl.signal.aborted) { why = reason; ctl.abort(); } };
    const overall = setTimeout(() => abort('超时'), overallMs);
    let idle = setTimeout(() => abort('长时间没有数据'), idleMs);
    const touch = () => { clearTimeout(idle); idle = setTimeout(() => abort('长时间没有数据'), idleMs); };
    const done = () => { clearTimeout(overall); clearTimeout(idle); controllers.delete(ctl); };
    const fail = (e) => {
      if (stopped) return new StoppedError();
      if (why) return new Error('请求' + why);
      return e;
    };
    let res;
    try {
      res = await fetchImpl(url, { ...opts, signal: ctl.signal });
    } catch (e) {
      done();
      throw fail(e);
    }
    touch();
    return { res, ctl, touch, done, fail };
  }

  async function getJson(url) {
    const q = await request(url, { cache: 'no-store', headers: { accept: 'application/octet-stream' } });
    try {
      if (!q.res.ok) throw new Error('HTTP ' + q.res.status);
      const text = await q.res.text();
      if (text.length > MAX_MANIFEST) throw new Error('清单太大');
      return JSON.parse(text);
    } catch (e) {
      throw q.fail(e);
    } finally {
      q.done();
    }
  }

  function rmPart(part) { try { fs.rmSync(part, { force: true, recursive: true }); } catch { /* 删不掉就下次再说 */ } }

  /** 下一个文件：.part 续传 → 校验（Content-Range / 大小 / sha256 / 上限）→ 改名。所有读写错误都变成普通失败 */
  async function downloadOne(f, onBytes) {
    const p = target(f);
    const part = p + '.part';
    fs.mkdirSync(path.dirname(p), { recursive: true });
    let have = 0;
    try {
      const st = fs.statSync(part);
      have = st.isFile() ? st.size : -1;
    } catch { have = 0; }
    if (have < 0 || have >= f.size) { rmPart(part); have = 0; } // 不是普通文件（例如同名目录）/ 比目标还大：清掉重下
    const headers = have ? { range: `bytes=${have}-` } : {};
    const q = await request(base + f.sha256 + '.webm', { headers });
    try {
      const r = q.res;
      if (r.status === 416) { rmPart(part); throw new Error('续传位置不对，重下'); }
      if (!r.ok) throw new Error('HTTP ' + r.status);
      if (have && r.status === 206) {
        const cr = parseContentRange(r.headers && r.headers.get ? r.headers.get('content-range') : '');
        if (!cr || cr.start !== have || (cr.total !== null && cr.total !== f.size)) { rmPart(part); throw new Error('续传的 Content-Range 对不上，清掉重下'); }
      } else if (have) {
        have = 0; // 服务器不认 Range：从头来
      }
      if (!r.body) throw new Error('响应没有内容');
      if (have) onBytes(have);
      let written = have;
      const counter = new Transform({
        transform(chunk, _enc, cb) {
          if (stopped) { cb(new StoppedError()); return; }
          written += chunk.length;
          if (written > f.size || written > MAX_FILE) { cb(new Error('下载内容超过清单里的大小')); return; }
          q.touch();
          onBytes(chunk.length);
          cb(null, chunk);
        },
      });
      const src = typeof r.body.getReader === 'function' ? Readable.fromWeb(r.body) : r.body;
      await pipeline(src, counter, fs.createWriteStream(part, { flags: have ? 'a' : 'w' }), { signal: q.ctl.signal });
      if (written !== f.size) { rmPart(part); throw new Error(`大小不对（${written}/${f.size}）`); }
      const sha = await sha256File(part);
      if (sha !== f.sha256) { rmPart(part); throw new Error('校验不通过（sha256 不一致）'); }
      fs.renameSync(part, p);
      const st = fs.statSync(p);
      index[f.id + '/' + f.name] = { sha256: sha, size: st.size, mtimeMs: st.mtimeMs };
    } catch (e) {
      const err = q.fail(e);
      if (!(err && err.stopped) && /超过清单|大小不对/.test(String(err && err.message))) rmPart(part);
      throw err;
    } finally {
      q.done();
    }
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
        if (stopped || (e && e.stopped)) { status.state = 'stopped'; status.error = '已停止'; emit(); return getStatus(); }
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
              if (stopped || (e && e.stopped)) break;
              log(`[素材] ${f.id}/${f.name} 第 ${attempt} 次下载失败：${e && e.message ? e.message : e}`);
              if (attempt < 3) await new Promise((res) => setTimeout(res, (o.retryDelayMs ?? 1500) * attempt));
            }
          }
          if (!ok && stopped) { queue.unshift(f); break; }
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
      const unfinished = status.totalFiles - status.doneFiles;
      if (stopped) {
        status.state = 'stopped';
        status.error = `已停止，还有 ${unfinished} 个没下`;
      } else {
        status.state = failed || unfinished ? 'partial' : 'done';
        if (failed || unfinished) status.error = `${failed || unfinished} 个文件没下成功，稍后会自动重试`;
      }
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
    /** 真正停下：取消所有进行中的请求，正在跑的一轮以 state='stopped' 结束 */
    stop() {
      stopped = true;
      for (const c of controllers) { try { c.abort(); } catch { /* ignore */ } }
      return running || Promise.resolve(getStatus());
    },
    isRunning: () => !!running,
  };
}

module.exports = { createAssetSync, validManifest, sha256File, parseContentRange, DEFAULT_BASE };
