#!/usr/bin/env node
/**
 * 跨平台单测入口：`node --test test/` 在 Windows + Node 22/24 上会把目录当模块解析而 MODULE_NOT_FOUND，
 * 这里自己列出 test/*.test.js 再交给 node --test（Node 20 / 22 / 24 通用）。
 */
'use strict';
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const dir = path.join(__dirname, '..', 'test');
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.test.js')).sort().map((f) => path.join(dir, f));
if (!files.length) {
  console.error('test/ 下没有 *.test.js');
  process.exit(1);
}
const r = spawnSync(process.execPath, ['--test', ...process.argv.slice(2), ...files], { stdio: 'inherit', env: { ...process.env, AIPET_TEST_ISOLATED: '1' } });
if (r.error) {
  console.error('启动 node --test 失败：' + r.error.message);
  process.exit(1);
}
process.exit(r.status === null ? 1 : r.status);
