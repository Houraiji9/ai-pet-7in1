#!/usr/bin/env node
/**
 * 打包前：把项目目录 ai-pet-7in1/assets/<角色>/webm/*.webm 复制进 app/assets/<角色>/webm/，
 * 这样打出来的 exe 自带这些素材（开发时 npm start 直接读项目目录，不需要跑这个）。
 * deepseek 的素材本来就在 app/assets/deepseek/webm（来自原项目），不会被删。
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const app = path.join(__dirname, '..');
const project = path.join(app, '..', 'assets');
const CHARACTERS = ['gpt', 'gemini', 'glm', 'claude', 'kimi', 'deepseek', 'grok'];
let n = 0;
for (const id of CHARACTERS) {
  const src = path.join(project, id, 'webm');
  if (!fs.existsSync(src)) continue;
  const dst = path.join(app, 'assets', id, 'webm');
  fs.mkdirSync(dst, { recursive: true });
  for (const f of fs.readdirSync(src)) {
    if (!f.toLowerCase().endsWith('.webm')) continue;
    const from = path.join(src, f);
    // 素材走 Git LFS：没执行 git lfs pull 时这里只是几百字节的指针文件，打出来的包会没有动画
    const head = Buffer.alloc(40);
    const fd = fs.openSync(from, 'r'); fs.readSync(fd, head, 0, 40, 0); fs.closeSync(fd);
    if (head.toString('utf8').startsWith('version https://git-lfs')) {
      console.error(`[sync-assets] ${from} 是 Git LFS 指针，请先运行 git lfs pull`);
      process.exit(1);
    }
    fs.copyFileSync(from, path.join(dst, f));
    n++;
  }
  console.log(`[sync-assets] ${id}: ${src} → ${dst}`);
}
console.log(`[sync-assets] 复制了 ${n} 个 webm`);

// 许可文件随包分发（根目录为准，复制进 app/ 供 electron-builder 打包；app/ 下这几份不提交）
for (const f of ['LICENSE', 'LICENSE-ASSETS.md', 'NOTICE.md']) {
  const from = path.join(app, '..', f);
  if (fs.existsSync(from)) fs.copyFileSync(from, path.join(app, f));
}
