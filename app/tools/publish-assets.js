#!/usr/bin/env node
/**
 * 把 assets/<角色>/webm/*.webm 打成 GitHub Release「assets」用的清单和按 sha256 命名的文件。
 * 用法（在仓库根目录）：
 *   node app/tools/publish-assets.js                 # 只生成到 dist/assets-pack/
 *   node app/tools/publish-assets.js --upload         # 再上传到 GitHub Release tag=assets（需 gh 已登录）
 *
 * 安装包只带每个角色的「待机呼吸休闲.webm」；其余动画客户端按 manifest 按需下载。
 * 发布新动画：改完 webm 后重跑本脚本；客户端只下 sha256 变了的文件。
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..', '..');
const OUT = path.join(ROOT, 'dist', 'assets-pack');
const ROLES = ['gpt', 'claude', 'gemini', 'glm', 'kimi', 'deepseek', 'grok'];
const upload = process.argv.includes('--upload');

function sha256(file) {
  const h = crypto.createHash('sha256');
  h.update(fs.readFileSync(file));
  return h.digest('hex');
}

fs.mkdirSync(OUT, { recursive: true });
const files = [];
const seen = new Map(); // sha -> name (dedupe physical copies)
for (const id of ROLES) {
  const dir = path.join(ROOT, 'assets', id, 'webm');
  if (!fs.existsSync(dir)) continue;
  for (const name of fs.readdirSync(dir).filter((f) => f.endsWith('.webm'))) {
    const p = path.join(dir, name);
    const head = Buffer.alloc(40);
    const fd = fs.openSync(p, 'r'); fs.readSync(fd, head, 0, 40, 0); fs.closeSync(fd);
    if (head.toString('utf8').startsWith('version https://git-lfs')) {
      console.error('LFS 指针：' + p + '，请先 git lfs pull');
      process.exit(1);
    }
    const sha = sha256(p);
    const size = fs.statSync(p).size;
    const dest = path.join(OUT, sha + '.webm');
    if (!seen.has(sha)) {
      fs.copyFileSync(p, dest);
      seen.set(sha, name);
    }
    files.push({ id, name: name.slice(0, -5), sha256: sha, size });
  }
}
files.sort((a, b) => a.id.localeCompare(b.id) || a.name.localeCompare(b.name, 'zh'));
const manifest = { schema: 1, generated: new Date().toISOString(), files };
fs.writeFileSync(path.join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 2));
const total = files.reduce((s, f) => s + f.size, 0);
console.log(`[publish-assets] ${files.length} 个动画，去重后 ${seen.size} 个文件，共 ${(total / 1048576).toFixed(1)} MB → ${OUT}`);

if (!upload) process.exit(0);

function gh(...args) {
  const r = spawnSync('gh', args, { encoding: 'utf8' });
  if (r.status !== 0) {
    console.error(r.stderr || r.stdout);
    process.exit(r.status || 1);
  }
  return r.stdout;
}

const tag = 'assets';
const list = gh('release', 'list', '--repo', 'Houraiji9/ai-pet-7in1', '--limit', '50');
if (!list.split('\n').some((l) => l.startsWith(tag + '\t') || l.includes('\t' + tag + '\t'))) {
  console.log('[publish-assets] 创建 Release ' + tag);
  gh('release', 'create', tag, '--repo', 'Houraiji9/ai-pet-7in1', '--title', '动画资源包（按需下载）',
    '--notes', '安装包启动后按 manifest.json 按需下载。文件名 = sha256.webm，客户端只下新增/变更的。');
} else {
  console.log('[publish-assets] Release ' + tag + ' 已存在，覆盖上传');
}
const uploads = [path.join(OUT, 'manifest.json'), ...[...seen.keys()].map((sha) => path.join(OUT, sha + '.webm'))];
// gh 一次传太多会炸，分批
const BATCH = 40;
for (let i = 0; i < uploads.length; i += BATCH) {
  const chunk = uploads.slice(i, i + BATCH);
  console.log(`[publish-assets] 上传 ${i + 1}-${i + chunk.length}/${uploads.length}`);
  gh('release', 'upload', tag, ...chunk, '--repo', 'Houraiji9/ai-pet-7in1', '--clobber');
}
console.log('[publish-assets] 完成：https://github.com/Houraiji9/ai-pet-7in1/releases/tag/assets');
