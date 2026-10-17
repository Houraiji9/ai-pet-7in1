'use strict';
/**
 * 极简 JSONC 解析：去掉 // 与 /* *\/ 注释、去掉对象/数组末尾多余的逗号，再交给 JSON.parse。
 * 字符串里的 // 与逗号不受影响（逐字符扫描并跟踪字符串状态）。
 */
function stripJsonc(text) {
  let out = '';
  let i = 0;
  const n = text.length;
  let inStr = false;
  while (i < n) {
    const c = text[i];
    const d = text[i + 1];
    if (inStr) {
      out += c;
      if (c === '\\') {
        out += d ?? '';
        i += 2;
        continue;
      }
      if (c === '"') inStr = false;
      i++;
      continue;
    }
    if (c === '"') {
      inStr = true;
      out += c;
      i++;
      continue;
    }
    if (c === '/' && d === '/') {
      while (i < n && text[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && d === '*') {
      i += 2;
      while (i < n && !(text[i] === '*' && text[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    out += c;
    i++;
  }
  // 去尾逗号（第二遍，同样跳过字符串）
  let res = '';
  inStr = false;
  for (let j = 0; j < out.length; j++) {
    const c = out[j];
    if (inStr) {
      res += c;
      if (c === '\\') {
        res += out[j + 1] ?? '';
        j++;
      } else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') {
      inStr = true;
      res += c;
      continue;
    }
    if (c === ',') {
      let k = j + 1;
      while (k < out.length && /\s/.test(out[k])) k++;
      if (out[k] === '}' || out[k] === ']') continue;
    }
    res += c;
  }
  return res;
}

function parseJsonc(text) {
  // 去掉 UTF-8 BOM（Windows 记事本保存时可能带上）
  return JSON.parse(stripJsonc(String(text).replace(/^\uFEFF/, '')));
}

module.exports = { parseJsonc, stripJsonc };
