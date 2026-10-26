'use strict';
/**
 * 前台程序 → 角色 的匹配规则（纯函数，可单测）。
 *
 * 规则与语义移植自主人之前的 C# 桌宠（old-codex-pet/src/Pet.Core/Model.cs 的 Rules.Match，已在真机上验证过）：
 *   - 只看前台 HWND 所属进程的 exe 文件名 / 完整路径 / 包身份（Package Family Name），默认不看窗口标题；
 *   - exe 文件名必须在 executables 里（不区分大小写）；
 *   - 有 packagePrefix 时：包身份以它开头，或路径里某一段目录名以它开头（WindowsApps 安装目录）才算命中；
 *   - 有 pathSegment 时：规范化后的路径（\ 换成 /）必须包含 "/<段>/"（不区分大小写）；
 *   - 按配置顺序取第一条启用的规则。
 * 新增（默认关闭）：浏览器标签页标题规则 browserTitleRules，只在 exe 规则都没命中、且前台是浏览器时才看标题。
 */

const CHARACTERS = ['gpt', 'gemini', 'glm', 'claude', 'kimi', 'deepseek', 'grok'];

function basename(p) {
  const parts = String(p || '').replace(/\\/g, '/').split('/');
  return parts[parts.length - 1];
}

function normalizeCharacter(c) {
  const v = String(c || '').trim().toLowerCase();
  return CHARACTERS.includes(v) ? v : null;
}

/**
 * 校验并规整规则文件（agents.jsonc 解析后的对象）。
 * 返回 { config, errors }：errors 非空时调用方应提示用户并退回默认配置。
 */
function validateAgentsConfig(raw) {
  const errors = [];
  const cfg = raw && typeof raw === 'object' ? raw : {};
  const rulesIn = Array.isArray(cfg.rules) ? cfg.rules : null;
  if (!rulesIn) errors.push('缺少 rules 数组');
  const rules = [];
  const seen = new Set();
  (rulesIn || []).forEach((r, i) => {
    const where = `rules[${i}]` + (r && r.id ? `（${r.id}）` : '');
    if (!r || typeof r !== 'object') return errors.push(`${where} 不是对象`);
    const id = String(r.id || '').trim();
    if (!id) return errors.push(`${where} 缺少 id`);
    if (seen.has(id.toLowerCase())) return errors.push(`${where} id 重复`);
    seen.add(id.toLowerCase());
    const character = normalizeCharacter(r.character);
    if (!character) return errors.push(`${where} character 必须是 ${CHARACTERS.join('/')} 之一`);
    const exes = Array.isArray(r.executables) ? r.executables.map(String) : null;
    if (!exes) return errors.push(`${where} 缺少 executables 数组`);
    const bad = exes.find((e) => !e.trim() || e !== basename(e) || !/\.exe$/i.test(e));
    if (bad !== undefined) return errors.push(`${where} executables 里只能写 xxx.exe 文件名（不要带路径）：${JSON.stringify(bad)}`);
    rules.push({
      id,
      label: String(r.label || id),
      character,
      executables: exes,
      packagePrefix: r.packagePrefix ? String(r.packagePrefix) : null,
      pathSegment: r.pathSegment ? String(r.pathSegment) : null,
      enabled: r.enabled !== false,
      verified: r.verified !== false && r.unverified !== true,
    });
  });
  if (rules.length > 64) errors.push('规则太多（最多 64 条）');

  const bt = cfg.browserTitleRules && typeof cfg.browserTitleRules === 'object' ? cfg.browserTitleRules : {};
  const browserTitleRules = {
    enabled: bt.enabled === true,
    browsers: (Array.isArray(bt.browsers) ? bt.browsers : []).map((s) => String(s).toLowerCase()),
    rules: [],
  };
  (Array.isArray(bt.rules) ? bt.rules : []).forEach((r, i) => {
    const character = normalizeCharacter(r && r.character);
    const contains = r && typeof r.titleContains === 'string' ? r.titleContains : '';
    if (!character || !contains) {
      errors.push(`browserTitleRules.rules[${i}] 需要 titleContains 与合法 character`);
      return;
    }
    browserTitleRules.rules.push({ titleContains: contains, character, enabled: r.enabled !== false });
  });

  const num = (v, def, min, max) => (Number.isFinite(Number(v)) ? Math.min(max, Math.max(min, Number(v))) : def);
  return {
    errors,
    config: {
      defaultCharacter: normalizeCharacter(cfg.defaultCharacter) || 'deepseek',
      sampleIntervalMs: num(cfg.sampleIntervalMs, 100, 50, 5000),
      debounceMs: num(cfg.debounceMs, 300, 0, 10000),
      rules,
      browserTitleRules,
    },
  };
}

/** exe 规则匹配（移植自 C# Rules.Match）。fg = { path, packageFamily }。返回命中的规则或 null */
function matchRule(rules, fg) {
  const exePath = fg && fg.path;
  if (!exePath) return null;
  const normalized = String(exePath).replace(/\\/g, '/');
  const name = basename(normalized).toLowerCase();
  const segs = normalized.split('/');
  const pkg = fg.packageFamily ? String(fg.packageFamily).toLowerCase() : '';
  const lowerPath = normalized.toLowerCase();
  for (const r of rules) {
    if (!r.enabled) continue;
    if (!r.executables.some((e) => e.toLowerCase() === name)) continue;
    if (r.packagePrefix) {
      const pre = r.packagePrefix.toLowerCase();
      const ok = (pkg && pkg.startsWith(pre)) || segs.some((s) => s.toLowerCase().startsWith(pre));
      if (!ok) continue;
    }
    if (r.pathSegment) {
      const seg = '/' + r.pathSegment.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '').toLowerCase() + '/';
      if (!lowerPath.includes(seg)) continue;
    }
    return r;
  }
  return null;
}

/** 浏览器标题规则（默认关闭）。返回命中的规则或 null */
function matchBrowserTitle(bt, fg) {
  if (!bt || !bt.enabled || !fg || !fg.path || !fg.title) return null;
  const name = basename(fg.path).toLowerCase();
  if (!bt.browsers.includes(name)) return null;
  const title = String(fg.title).toLowerCase();
  for (const r of bt.rules) {
    if (r.enabled && title.includes(r.titleContains.toLowerCase())) return r;
  }
  return null;
}

/**
 * 综合判定：返回 { character, ruleId, via }，character 为 null 表示「不是 Agent 程序」（保持上一个角色）。
 * selfPid / selfExe：桌宠自己的窗口一律不算（保持上一个角色）。
 */
function classify(config, fg, self) {
  if (!fg || !fg.path) return { character: null, ruleId: null, via: 'none' };
  if (self) {
    if (self.pid && fg.pid === self.pid) return { character: null, ruleId: null, via: 'self' };
    if (self.exe && String(fg.path).toLowerCase() === String(self.exe).toLowerCase()) {
      return { character: null, ruleId: null, via: 'self' };
    }
  }
  const r = matchRule(config.rules, fg);
  if (r) return { character: r.character, ruleId: r.id, via: 'exe', verified: r.verified };
  const b = matchBrowserTitle(config.browserTitleRules, fg);
  if (b) return { character: b.character, ruleId: 'browser:' + b.titleContains, via: 'title', verified: false };
  return { character: null, ruleId: null, via: 'unmatched' };
}

/**
 * 用户规则 + 自带规则 → 实际生效的规则。
 * 用户文件读不出来 / 一条可用规则都没有 → 用自带规则（fallback='bundled'）；
 * 有部分规则出错 → 保留其余的用户规则，只忽略出错的那几条（fallback='partial'）。
 */
function resolveAgentsConfig(parsed, bundledParsed, readError) {
  const r = parsed && !readError ? validateAgentsConfig(parsed) : null;
  const errors = readError ? [readError] : r ? r.errors : ['映射表不是有效的对象'];
  if (!r || r.config.rules.length === 0) {
    return { config: validateAgentsConfig(bundledParsed).config, errors, fallback: errors.length || !r ? 'bundled' : 'none' };
  }
  return { config: r.config, errors, fallback: errors.length ? 'partial' : 'none' };
}

/** 托盘里的提示文字（和实际行为一致） */
function agentsNotice(fallback) {
  if (fallback === 'bundled') return '⚠ 映射表有错误，已改用程序自带的规则（看调试窗口）';
  if (fallback === 'partial') return '⚠ 映射表有几条规则写错了，已跳过它们，其余照用（看调试窗口）';
  return '';
}

module.exports = { resolveAgentsConfig, agentsNotice, CHARACTERS, basename, normalizeCharacter, validateAgentsConfig, matchRule, matchBrowserTitle, classify };
