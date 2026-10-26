'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const os = require('node:os');
const { createAssetSync, parseContentRange } = require('../main/asset-sync.js');

const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const BODY = Buffer.alloc(9000, 7);

/** 本机假服务器；mode 控制异常行为 */
async function serve(mode) {
  const hits = [];
  const sockets = new Set();
  const manifest = { schema: 1, files: [{ id: 'gpt', name: '下五子棋', sha256: sha(BODY), size: BODY.length }] };
  const server = http.createServer((req, res) => {
    hits.push({ url: req.url, range: req.headers.range || '' });
    if (req.url === '/manifest.json') {
      if (mode === 'hang-manifest') return; // 永远不回
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(manifest));
      return;
    }
    if (mode === 'hang-body') { res.writeHead(200, { 'content-length': BODY.length }); res.write(BODY.subarray(0, 100)); return; }
    if (mode === 'oversize') { res.writeHead(200); res.end(Buffer.concat([BODY, Buffer.alloc(5000, 1)])); return; }
    const range = req.headers.range;
    if (range && mode === 'bad-range' && hits.filter((h) => h.range).length === 1) {
      res.writeHead(206, { 'content-range': `bytes 0-${BODY.length - 1}/${BODY.length}` }); // 起点不对
      res.end(BODY);
      return;
    }
    if (range) {
      const start = Number(/bytes=(\d+)-/.exec(range)[1]);
      res.writeHead(206, { 'content-range': `bytes ${start}-${BODY.length - 1}/${BODY.length}` });
      res.end(BODY.subarray(start));
      return;
    }
    res.writeHead(200, { 'content-length': BODY.length });
    res.end(BODY);
  });
  server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const close = () => new Promise((r) => { for (const s of sockets) s.destroy(); server.close(r); });
  return { base: `http://127.0.0.1:${server.address().port}/`, hits, close };
}

function mk(srv, extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'as-r-'));
  const sync = createAssetSync({ dir, characters: ['gpt'], baseUrl: srv.base, fetch: globalThis.fetch, concurrency: 1, retryDelayMs: 1, idleTimeoutMs: 300, timeoutMs: 5000, ...extra });
  return { dir, sync, file: path.join(dir, 'gpt', '下五子棋.webm') };
}

describe('asset-sync 健壮性', () => {
  it('parseContentRange', () => {
    assert.deepEqual(parseContentRange('bytes 10-99/100'), { start: 10, end: 99, total: 100 });
    assert.deepEqual(parseContentRange('bytes 0-1/*'), { start: 0, end: 1, total: null });
    assert.equal(parseContentRange('garbage'), null);
  });

  it('.part 是目录（EISDIR）→ 清掉重下，不崩', async () => {
    const srv = await serve('ok');
    const { sync, file } = mk(srv);
    fs.mkdirSync(file + '.part', { recursive: true });
    const st = await sync.sync();
    assert.equal(st.state, 'done');
    assert.equal(sha(fs.readFileSync(file)), sha(BODY));
    await srv.close();
  });

  it('目标路径写不进去（是目录）→ 受控失败 partial，不抛异常', async () => {
    const srv = await serve('ok');
    const { sync, file } = mk(srv);
    fs.mkdirSync(path.join(file, 'x'), { recursive: true });
    const st = await sync.sync();
    assert.equal(st.state, 'partial');
    assert.equal(st.doneFiles, 0);
    await srv.close();
  });

  it('206 的 Content-Range 起点不对 → 清掉 .part，重下后成功', async () => {
    const srv = await serve('bad-range');
    const { sync, file } = mk(srv);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file + '.part', BODY.subarray(0, 3000));
    const st = await sync.sync();
    assert.equal(st.state, 'done');
    assert.equal(sha(fs.readFileSync(file)), sha(BODY));
    assert.equal(srv.hits.filter((h) => h.range).length, 1, '第二次不再带 Range');
    await srv.close();
  });

  it('内容超过清单大小 → 中断并清掉 .part，partial', async () => {
    const srv = await serve('oversize');
    const { sync, file } = mk(srv);
    const st = await sync.sync();
    assert.equal(st.state, 'partial');
    assert.ok(!fs.existsSync(file) && !fs.existsSync(file + '.part'));
    await srv.close();
  });

  it('下载中途卡住 → 空闲超时，partial（不会一直挂着）', async () => {
    const srv = await serve('hang-body');
    const { sync } = mk(srv);
    const t0 = Date.now();
    const st = await sync.sync();
    assert.equal(st.state, 'partial');
    assert.ok(Date.now() - t0 < 4000);
    await srv.close();
  });

  it('stop() 真正取消进行中的下载 → state=stopped，不是 done', async () => {
    const srv = await serve('hang-body');
    const { sync, file } = mk(srv, { idleTimeoutMs: 60000 });
    const p = sync.sync();
    await new Promise((r) => setTimeout(r, 200));
    const st = await sync.stop();
    assert.equal(st.state, 'stopped');
    assert.equal((await p).state, 'stopped');
    assert.ok(!fs.existsSync(file));
    await srv.close();
  });

  it('清单请求卡住时 stop() → stopped（不是 offline / done）', async () => {
    const srv = await serve('hang-manifest');
    const { sync } = mk(srv, { idleTimeoutMs: 60000 });
    const p = sync.sync();
    await new Promise((r) => setTimeout(r, 100));
    sync.stop();
    assert.equal((await p).state, 'stopped');
    await srv.close();
  });

  it('清单请求卡住 → 超时变 offline', async () => {
    const srv = await serve('hang-manifest');
    const { sync } = mk(srv, { idleTimeoutMs: 60000, timeoutMs: 300 });
    assert.equal((await sync.sync()).state, 'offline');
    await srv.close();
  });
});
