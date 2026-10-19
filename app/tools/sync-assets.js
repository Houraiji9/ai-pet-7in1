#!/usr/bin/env node
/**
 * 打包前同步素材。
 *
 * 默认（安装包瘦身）：每个角色只拷「核心」动画（待机 / 走 / 拖 / 点 / 登场），
 * 其余动画安装后由 main/asset-sync.js 从 GitHub Release tag=assets 按需下载。
 * 开发时 npm start 仍直接读项目目录 ../assets，不受这里影响。
 *
 * AIPET_SYNC_ALL=1 时拷全部（本地打全量包调试用）。
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const app = path.join(__dirname, '..');
const project = path.join(app, '..', 'assets');
const CHARACTERS = ['gpt', 'gemini', 'glm', 'claude', 'kimi', 'deepseek', 'grok'];
const CORE = new Set([
  '待机呼吸休闲', '原地左转走路', '被鼠标拖拽悬空反馈', '登场-星光现身',
  '点击回应-开心害羞', '点击回应-开心跃动',
]);
// DeepSeek 用原名；走路也有「原地左转奔跑」等，安装包把 deepseek 全带上（体积本来就在包里）
const SYNC_ALL = process.env.AIPET_SYNC_ALL === '1';
let n = 0;
for (const id of CHARACTERS) {
  const src = path.join(project, id, 'webm');
  if (!fs.existsSync(src)) continue;
  const dst = path.join(app, 'assets', id, 'webm');
  fs.mkdirSync(dst, { recursive: true });
  // 清掉上次全量同步残留（避免安装包又胀回去）；deepseek 目录里的原文件若项目侧没有同名则保留
  if (!SYNC_ALL && id !== 'deepseek') {
    for (const f of fs.readdirSync(dst)) {
      if (!f.endsWith('.webm')) continue;
      const name = f.slice(0, -5);
      if (!CORE.has(name) && !name.startsWith('点击回应-')) {
        try { fs.unlinkSync(path.join(dst, f)); } catch {}
      }
    }
  }
  for (const f of fs.readdirSync(src)) {
    if (!f.toLowerCase().endsWith('.webm')) continue;
    const name = f.slice(0, -5);
    const keep = SYNC_ALL || id === 'deepseek' || CORE.has(name) || name.startsWith('点击回应-');
    if (!keep) continue;
    const from = path.join(src, f);
    const head = Buffer.alloc(40);
    const fd = fs.openSync(from, 'r'); fs.readSync(fd, head, 0, 40, 0); fs.closeSync(fd);
    if (head.toString('utf8').startsWith('version https://git-lfs')) {
      console.error(`[sync-assets] ${from} 是 Git LFS 指针，请先运行 git lfs pull`);
      process.exit(1);
    }
    fs.copyFileSync(from, path.join(dst, f));
    n++;
  }
  console.log(`[sync-assets] ${id}: ${SYNC_ALL || id === 'deepseek' ? '全部' : '核心'} → ${dst}`);
}
console.log(`[sync-assets] 复制了 ${n} 个 webm（${SYNC_ALL ? '全量' : '瘦身'}）`);
for (const f of ['LICENSE', 'LICENSE-ASSETS.md', 'NOTICE.md']) {
  const from = path.join(app, '..', f);
  if (fs.existsSync(from)) fs.copyFileSync(from, path.join(app, f));
}
