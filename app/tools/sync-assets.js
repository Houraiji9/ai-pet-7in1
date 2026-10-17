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
    fs.copyFileSync(path.join(src, f), path.join(dst, f));
    n++;
  }
  console.log(`[sync-assets] ${id}: ${src} → ${dst}`);
}
console.log(`[sync-assets] 复制了 ${n} 个 webm`);
