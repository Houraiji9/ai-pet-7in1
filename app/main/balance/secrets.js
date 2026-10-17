'use strict';
/**
 * 手填的余额 Key（DeepSeek API Key、GLM / Z.ai API Key）：
 *   - 用 Electron safeStorage 加密（Windows 上是 DPAPI，绑定当前 Windows 用户）后存在
 *     userData\balance-keys.json，文件里只有密文；
 *   - safeStorage 不可用时**拒绝保存**（绝不退化成明文落盘），可改用环境变量；
 *   - 只有主进程能读明文，渲染端 / 设置窗口永远拿不到明文（只拿「已设置 / 未设置 / 来自环境变量」）。
 * 环境变量兜底：DEEPSEEK_API_KEY；ZAI_API_KEY / GLM_API_KEY / ZHIPU_API_KEY。
 */
const fs = require('node:fs');
const path = require('node:path');

const SECRET_NAMES = ['deepseek', 'zai'];
const SETTING_NAMES = ['zaiRegion'];
const ENV_NAMES = { deepseek: ['DEEPSEEK_API_KEY'], zai: ['ZAI_API_KEY', 'Z_AI_API_KEY', 'GLM_API_KEY', 'ZHIPU_API_KEY'] };

/**
 * @param {{ file: string, safeStorage: { isEncryptionAvailable(): boolean, encryptString(s: string): Buffer, decryptString(b: Buffer): string }, env?: object }} o
 */
function createSecretStore({ file, safeStorage, env = process.env }) {
  function readFile() {
    try {
      const j = JSON.parse(fs.readFileSync(file, 'utf8'));
      return j && typeof j === 'object' ? j : {};
    } catch {
      return {};
    }
  }
  function writeFile(obj) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmp, file);
  }
  function envValue(name) {
    for (const n of ENV_NAMES[name] || []) {
      const v = String(env[n] || '').trim();
      if (v) return v;
    }
    return '';
  }
  function stored(name) {
    const enc = readFile().secrets?.[name];
    if (typeof enc !== 'string' || !enc) return '';
    try {
      if (!safeStorage.isEncryptionAvailable()) return '';
      return String(safeStorage.decryptString(Buffer.from(enc, 'base64')) || '').trim();
    } catch {
      return '';
    }
  }
  return {
    encryptionAvailable() {
      try {
        return !!safeStorage.isEncryptionAvailable();
      } catch {
        return false;
      }
    },
    /** 明文，只给主进程里的 provider 用 */
    get(name) {
      if (!SECRET_NAMES.includes(name)) return '';
      return stored(name) || envValue(name);
    },
    set(name, value) {
      if (!SECRET_NAMES.includes(name)) throw new Error('未知的 Key 名：' + name);
      const v = String(value || '').trim();
      if (!v) throw new Error('Key 不能为空');
      if (v.length > 4096 || /\s/.test(v)) throw new Error('Key 格式不对（不能有空格或换行）');
      if (!this.encryptionAvailable()) throw new Error('这台电脑的系统加密不可用，没法安全保存；可以改用环境变量');
      const obj = readFile();
      obj.secrets = { ...(obj.secrets || {}), [name]: safeStorage.encryptString(v).toString('base64') };
      writeFile(obj);
    },
    clear(name) {
      const obj = readFile();
      if (obj.secrets && name in obj.secrets) {
        delete obj.secrets[name];
        writeFile(obj);
      }
    },
    getSetting(name) {
      if (!SETTING_NAMES.includes(name)) return '';
      const v = readFile().settings?.[name];
      return typeof v === 'string' ? v : '';
    },
    setSetting(name, value) {
      if (!SETTING_NAMES.includes(name)) throw new Error('未知设置：' + name);
      const obj = readFile();
      obj.settings = { ...(obj.settings || {}), [name]: String(value || '') };
      writeFile(obj);
    },
    /** 设置窗口用：每个 Key 的来源，**不含任何明文** */
    status() {
      const out = {};
      for (const n of SECRET_NAMES) out[n] = stored(n) ? 'saved' : envValue(n) ? 'env' : 'none';
      return { keys: out, settings: { zaiRegion: this.getSetting('zaiRegion') || 'bigmodel-cn' }, encryptionAvailable: this.encryptionAvailable() };
    },
  };
}

module.exports = { createSecretStore, SECRET_NAMES, ENV_NAMES };
