'use strict';
/**
 * 启动时（在建角色库 / 读映射表 / 开窗口之前）把程序自带配置同步到用户目录：
 *  - 用户目录里没有 → 复制一份（原子：写临时文件再改名）
 *  - 有，且和以前某个版本自带的一模一样（用户没改过）→ 换成新版自带的，旧的留一份 .bak
 *  - 用户改过 → 一个字节都不动
 * 任何一步失败都不会留下写了一半的文件；失败只记日志，程序照常用现有文件启动。
 */
const fsDefault = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const CONFIG_NAMES = ['agents.jsonc', 'species.jsonc'];
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

function atomicWrite(fs, dst, data) {
  const tmp = `${dst}.tmp-${process.pid}-${Date.now()}`;
  try {
    fs.writeFileSync(tmp, data);
    fs.renameSync(tmp, dst);
  } catch (e) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* ignore */ }
    throw e;
  }
}

function migrateUserConfigs({ appRoot, userDir, hashes, log = () => {}, fs = fsDefault, names = CONFIG_NAMES }) {
  const results = {};
  fs.mkdirSync(userDir, { recursive: true });
  for (const name of names) {
    const dst = path.join(userDir, name);
    const src = path.join(appRoot, 'config', name);
    try {
      const shipped = fs.readFileSync(src);
      if (!fs.existsSync(dst)) {
        atomicWrite(fs, dst, shipped);
        results[name] = 'created';
        continue;
      }
      const cur = fs.readFileSync(dst);
      if (cur.equals(shipped)) { results[name] = 'current'; continue; }
      const known = (hashes && hashes[name]) || [];
      if (!known.includes(sha256(cur))) { results[name] = 'user-modified'; continue; }
      const bak = `${dst}.bak`;
      atomicWrite(fs, bak, cur);
      atomicWrite(fs, dst, shipped);
      results[name] = 'upgraded';
      log(`配置 ${name} 未被修改过，已升级为新版自带的（旧的备份为 ${path.basename(bak)}）`);
    } catch (e) {
      results[name] = 'error';
      log(`同步配置 ${name} 失败（继续用现有文件）：${e && e.message ? e.message : e}`);
    }
  }
  return results;
}

module.exports = { migrateUserConfigs, atomicWrite, CONFIG_NAMES };
