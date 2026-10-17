'use strict';
// 用真正的 node:sqlite 读一个假的 state.vscdb（Electron 43 自带 Node 24 有 node:sqlite；系统 Node 20 没有就跳过）。
// 手动跑：ELECTRON_RUN_AS_NODE=1 npx electron --test test/balance-sqlite.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cursor = require('../main/balance/cursor.js');

let sqlite = null;
try {
  sqlite = require('node:sqlite');
} catch {
  sqlite = null;
}

test('Cursor：node:sqlite 只读打开 state.vscdb 取 cursorAuth/accessToken', { skip: !sqlite && '当前 Node 没有 node:sqlite' }, () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'aipet-vscdb-')), 'state.vscdb');
  const db = new sqlite.DatabaseSync(file);
  db.exec('CREATE TABLE ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)');
  db.prepare('INSERT INTO ItemTable (key, value) VALUES (?, ?)').run('cursorAuth/accessToken', 'aaa.bbb.ccc');
  db.close();
  assert.equal(cursor.readCursorDesktopAccessToken({ dbPaths: [file] }), 'aaa.bbb.ccc');
  // 只读：写入会失败
  const ro = new sqlite.DatabaseSync(file, { readOnly: true });
  assert.throws(() => ro.exec("INSERT INTO ItemTable VALUES ('x','y')"));
  ro.close();
});
