'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const os = require('node:os');
const { createAssetSync } = require('../main/asset-sync.js');

function sha(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }

describe('asset-sync', () => {
  it('downloads missing files, skips matching ones, resumes .part', async () => {
    const a = Buffer.alloc(12000, 1);
    const b = Buffer.alloc(8000, 2);
    const files = {
      [sha(a) + '.webm']: a,
      [sha(b) + '.webm']: b,
    };
    const manifest = {
      schema: 1,
      files: [
        { id: 'gpt', name: '待机呼吸休闲', sha256: sha(a), size: a.length },
        { id: 'gpt', name: '下五子棋', sha256: sha(b), size: b.length },
      ],
    };
    const server = http.createServer((req, res) => {
      if (req.url === '/manifest.json') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(manifest));
        return;
      }
      const name = req.url.slice(1);
      const body = files[name];
      if (!body) { res.writeHead(404); res.end(); return; }
      const range = req.headers.range;
      if (range) {
        const m = /^bytes=(\d+)-$/.exec(range);
        const start = Number(m[1]);
        res.writeHead(206, { 'content-range': `bytes ${start}-${body.length - 1}/${body.length}`, 'content-length': body.length - start });
        res.end(body.subarray(start));
      } else {
        res.writeHead(200, { 'content-length': body.length });
        res.end(body);
      }
    });
    await new Promise((r) => server.listen(0, r));
    const port = server.address().port;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'as-'));
    // pre-seed a with wrong content as .part for resume test on b
    fs.mkdirSync(path.join(dir, 'gpt'), { recursive: true });
    const part = path.join(dir, 'gpt', '下五子棋.webm.part');
    fs.writeFileSync(part, b.subarray(0, 3000));
    // bundled matching a
    const bundled = path.join(dir, 'bundled-a.webm');
    fs.writeFileSync(bundled, a);

    const sync = createAssetSync({
      dir,
      characters: ['gpt'],
      baseUrl: `http://127.0.0.1:${port}/`,
      fetch: global.fetch,
      bundledFile: (id, name) => (name === '待机呼吸休闲' ? bundled : null),
      concurrency: 1,
    });
    const st = await sync.sync();
    assert.equal(st.state, 'done');
    assert.equal(st.doneFiles, 1); // only b downloaded; a matched bundled
    assert.ok(fs.existsSync(path.join(dir, 'gpt', '下五子棋.webm')));
    assert.equal(sha(fs.readFileSync(path.join(dir, 'gpt', '下五子棋.webm'))), sha(b));
    assert.ok(!fs.existsSync(part));
    // second sync downloads nothing
    const st2 = await sync.sync();
    assert.equal(st2.totalFiles, 0);
    server.close();
  });
});
