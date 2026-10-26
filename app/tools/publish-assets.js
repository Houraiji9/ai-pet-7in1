#!/usr/bin/env node
/**
 * 把 assets/<角色>/webm/*.webm 打成 GitHub Release「assets」用的清单和按 sha256 命名的文件。
 * 用法（在仓库根目录）：
 *   node app/tools/publish-assets.js                 # 只生成到 dist/assets-pack/
 *   node app/tools/publish-assets.js --upload         # 再上传到 GitHub Release tag=assets（需 gh 已登录）
 *
 * 上传顺序：先传按 sha256 命名的文件（远端已有同名同大小的跳过），再列远端确认全部到位，
 * 最后才传 manifest.json。清单先做校验（名字/大小/哈希/核心动画齐全），空清单或残缺清单绝不发布。
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const ROLES = ['gpt', 'claude', 'gemini', 'glm', 'kimi', 'deepseek', 'grok'];
const CORE = '待机呼吸休闲';
const REPO = 'Houraiji9/ai-pet-7in1';
const TAG = 'assets';

function sha256(file) { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); }

function buildPack({ root, out, roles = ROLES }) {
  fs.mkdirSync(out, { recursive: true });
  const files = [];
  const seen = new Map();
  for (const id of roles) {
    const dir = path.join(root, 'assets', id, 'webm');
    if (!fs.existsSync(dir)) continue;
    for (const name of fs.readdirSync(dir).filter((f) => f.endsWith('.webm')).sort()) {
      const p = path.join(dir, name);
      const head = fs.readFileSync(p).subarray(0, 40).toString('utf8');
      if (head.startsWith('version https://git-lfs')) throw new Error('LFS 指针：' + p + '，请先 git lfs pull');
      const sha = sha256(p);
      const size = fs.statSync(p).size;
      if (!seen.has(sha)) { fs.copyFileSync(p, path.join(out, sha + '.webm')); seen.set(sha, size); }
      files.push({ id, name: name.slice(0, -5), sha256: sha, size });
    }
  }
  files.sort((a, b) => a.id.localeCompare(b.id) || a.name.localeCompare(b.name, 'zh'));
  return { manifest: { schema: 1, generated: new Date().toISOString(), files }, blobs: seen };
}

/** 返回错误列表；空数组 = 可发布。 */
function validateManifest(manifest, { out, roles = ROLES } = {}) {
  const errs = [];
  if (!manifest || manifest.schema !== 1 || !Array.isArray(manifest.files)) return ['清单结构不对'];
  if (!manifest.files.length) return ['清单为空'];
  const keys = new Set();
  for (const f of manifest.files) {
    const at = `${f.id}/${f.name}`;
    if (!roles.includes(f.id)) errs.push(`${at}: 未知角色`);
    if (typeof f.name !== 'string' || !f.name || /[\\/]|\.\./.test(f.name)) errs.push(`${at}: 名字非法`);
    if (!/^[0-9a-f]{64}$/.test(f.sha256 || '')) errs.push(`${at}: sha256 非法`);
    if (!Number.isInteger(f.size) || f.size <= 0) errs.push(`${at}: 大小非法`);
    if (keys.has(at)) errs.push(`${at}: 重复`);
    keys.add(at);
    if (out && /^[0-9a-f]{64}$/.test(f.sha256 || '')) {
      const p = path.join(out, f.sha256 + '.webm');
      if (!fs.existsSync(p)) errs.push(`${at}: 缺少文件 ${f.sha256}.webm`);
      else if (fs.statSync(p).size !== f.size) errs.push(`${at}: 文件大小不符`);
      else if (sha256(p) !== f.sha256) errs.push(`${at}: 文件哈希不符`);
    }
  }
  // deepseek（大肥鱼）动画在安装包内，不走资源包：只要求「清单里出现的角色」都带核心动画
  const present = new Set(manifest.files.map((f) => f.id));
  for (const id of roles) if (present.has(id) && !keys.has(`${id}/${CORE}`)) errs.push(`${id}: 缺少核心动画「${CORE}」`);
  return errs;
}

/** ops: { listRemote() -> [{name,size}], upload(paths[]), log } */
async function publish({ manifest, out, ops, roles = ROLES, batch = 40 }) {
  const log = ops.log || (() => {});
  const errs = validateManifest(manifest, { out, roles });
  if (errs.length) throw new Error('清单校验失败，不发布：\n  ' + errs.join('\n  '));
  const want = new Map();
  for (const f of manifest.files) want.set(f.sha256 + '.webm', f.size);
  const remote = new Map((await ops.listRemote()).map((a) => [a.name, a.size]));
  const todo = [...want].filter(([n, s]) => remote.get(n) !== s).map(([n]) => n);
  log(`[publish-assets] 需要上传 ${todo.length} 个，跳过已存在 ${want.size - todo.length} 个`);
  for (let i = 0; i < todo.length; i += batch) {
    await ops.upload(todo.slice(i, i + batch).map((n) => path.join(out, n)));
  }
  const after = new Map((await ops.listRemote()).map((a) => [a.name, a.size]));
  const missing = [...want].filter(([n, s]) => after.get(n) !== s).map(([n]) => n);
  if (missing.length) throw new Error('远端确认失败，未上传清单；缺：' + missing.join(', '));
  const mf = path.join(out, 'manifest.json');
  fs.writeFileSync(mf, JSON.stringify(manifest, null, 2));
  await ops.upload([mf]);
  return { uploaded: todo, skipped: want.size - todo.length };
}

function ghOps(repo = REPO, tag = TAG) {
  const gh = (...args) => {
    const r = spawnSync('gh', args, { encoding: 'utf8' });
    if (r.status !== 0) throw new Error((r.stderr || r.stdout || '').trim() || 'gh 失败');
    return r.stdout;
  };
  return {
    log: console.log,
    listRemote() {
      try { return JSON.parse(gh('release', 'view', tag, '--repo', repo, '--json', 'assets')).assets.map((a) => ({ name: a.name, size: a.size })); } catch (e) {
        if (!/not found/i.test(e.message)) throw e;
        gh('release', 'create', tag, '--repo', repo, '--title', '动画资源包（按需下载）',
          '--notes', '安装包启动后按 manifest.json 按需下载。文件名 = sha256.webm，客户端只下新增/变更的。');
        return [];
      }
    },
    upload(paths) { console.log(`[publish-assets] 上传 ${paths.length} 个`); gh('release', 'upload', tag, ...paths, '--repo', repo, '--clobber'); },
  };
}

async function main() {
  const root = path.join(__dirname, '..', '..');
  const out = path.join(root, 'dist', 'assets-pack');
  const { manifest, blobs } = buildPack({ root, out });
  const errs = validateManifest(manifest, { out });
  if (errs.length) { console.error('清单校验失败：\n  ' + errs.join('\n  ')); process.exit(1); }
  const total = manifest.files.reduce((s, f) => s + f.size, 0);
  console.log(`[publish-assets] ${manifest.files.length} 个动画，去重后 ${blobs.size} 个文件，共 ${(total / 1048576).toFixed(1)} MB → ${out}`);
  if (!process.argv.includes('--upload')) {
    fs.writeFileSync(path.join(out, 'manifest.json'), JSON.stringify(manifest, null, 2));
    return;
  }
  await publish({ manifest, out, ops: ghOps() });
  console.log('[publish-assets] 完成：https://github.com/' + REPO + '/releases/tag/' + TAG);
}

module.exports = { buildPack, validateManifest, publish, CORE, ROLES };
if (require.main === module) main().catch((e) => { console.error(e.message); process.exit(1); });
