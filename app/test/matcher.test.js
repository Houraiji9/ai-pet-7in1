'use strict';
// 用例移植自主人之前 C# 桌宠的 tests/Pet.Tests/Program.cs（规则匹配 + 防抖），并补上新加规则的用例。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { parseJsonc } = require('../main/jsonc.js');
const { validateAgentsConfig, matchRule, classify } = require('../main/matcher.js');

const raw = parseJsonc(fs.readFileSync(path.join(__dirname, '..', 'config', 'agents.jsonc'), 'utf8'));
const { config, errors } = validateAgentsConfig(raw);
const rules = config.rules;
const id = (p, pkg) => (matchRule(rules, { path: p, packageFamily: pkg }) || {}).id;
const ch = (p, pkg) => (matchRule(rules, { path: p, packageFamily: pkg }) || {}).character;

test('自带的 agents.jsonc 合法', () => {
  assert.deepEqual(errors, []);
  assert.equal(config.sampleIntervalMs, 100);
  assert.equal(config.debounceMs, 300);
  assert.equal(config.defaultCharacter, 'deepseek');
  assert.equal(config.browserTitleRules.enabled, false, '浏览器标题规则默认关闭');
});

test('[旧桌宠] 精确 exe 映射与 Gemini 版本目录', () => {
  const examples = [
    ['C:/Program Files/WindowsApps/OpenAI.Codex_1.2.3_x64/ChatGPT.exe', 'gpt'],
    ['C:/test/ZCode.exe', 'zcode'],
    ['C:/test/Kimi.exe', 'kimi'],
    ['C:/Users/test/AppData/Local/Google/Gemini/app-99.0/Gemini.exe', 'gemini'],
    ['C:/test/DeepSeek Harness.exe', 'deepseek'],
    ['C:/test/Grok Bot.exe', 'grok-bot'],
  ];
  for (const [file, rid] of examples) assert.equal(id(file), rid, file);
  assert.equal(id('C:\\Google\\Gemini\\app-1\\Gemini.exe'), 'gemini', '反斜杠路径');
  assert.equal(id('c:/test/chatGPT.EXE', 'OpenAI.Codex_2p2nqsd0c76g0'), 'gpt', '包身份');
});

test('[旧桌宠] 排除后台 CLI、浏览器、伪装后缀、未启用的 Grok Build', () => {
  for (const file of ['codex.exe', 'chrome.exe', 'msedge.exe', 'fakeKimi.exe', 'Kimi.exe.bak', 'DeepSeek.exe', 'ChatGPT.exe', 'Gemini.exe', 'Grok Build.exe']) {
    assert.equal(id('C:/other/' + file), undefined, file);
  }
  assert.equal(matchRule(rules, { path: null }), null);
  const gb = rules.find((r) => r.id === 'grok-build');
  assert.equal(gb.enabled, false);
  assert.equal(gb.character, 'grok');
});

test('[旧桌宠] 不区分大小写、不依赖版本号', () => {
  assert.equal(ch('C:/new-version/KIMI.EXE'), 'kimi');
  assert.equal(ch('C:/Google/Gemini/app-next/Gemini.exe'), 'gemini');
});

test('ChatGPT.exe 不在 Codex 包里（普通 ChatGPT 安装）不算 gpt —— 与旧桌宠一致', () => {
  assert.equal(id('C:/Users/me/AppData/Local/Programs/ChatGPT/ChatGPT.exe'), undefined);
  assert.equal(id('C:/x/ChatGPT.exe', 'OpenAI.ChatGPT-Desktop_2p2nqsd0c76g0'), undefined);
});

test('新增规则（已验证）：Claude / Antigravity / WorkBuddy / Cursor', () => {
  const cases = [
    ['C:/Users/me/AppData/Local/AnthropicClaude/app-0.9/Claude.exe', 'claude', 'claude'],
    ['C:/Users/me/AppData/Local/Programs/Antigravity/Antigravity.exe', 'antigravity', 'gemini'],
    ['C:/Program Files/WorkBuddy/WorkBuddy.exe', 'workbuddy', 'deepseek'],
    ['C:/Users/me/AppData/Local/Programs/cursor/Cursor.exe', 'cursor', 'grok'],
  ];
  for (const [p, rid, c] of cases) {
    const r = matchRule(rules, { path: p });
    assert.equal(r && r.id, rid, p);
    assert.equal(r.character, c);
    assert.equal(r.verified, true, rid + ' 应为已验证');
  }
  for (const rid of ['gpt', 'zcode', 'kimi', 'gemini', 'deepseek', 'grok-bot']) {
    assert.equal(rules.find((r) => r.id === rid).verified, true, rid + ' 应为已验证');
  }
});

test('classify：桌宠自己的窗口 / 未知程序 → 不切换', () => {
  const self = { pid: 4242, exe: 'C:/apps/ai-pet-7in1.exe' };
  assert.equal(classify(config, { pid: 4242, path: 'C:/apps/ai-pet-7in1.exe' }, self).via, 'self');
  assert.equal(classify(config, { pid: 1, path: 'C:/APPS/AI-PET-7IN1.EXE' }, self).via, 'self');
  const wx = classify(config, { pid: 9, path: 'C:/Program Files/Tencent/WeChat/WeChat.exe' }, self);
  assert.equal(wx.character, null);
  assert.equal(wx.via, 'unmatched');
  assert.equal(classify(config, null, self).character, null);
  assert.equal(classify(config, { pid: 3, path: 'C:/x/Kimi.exe' }, self).character, 'kimi');
});

test('浏览器标题规则：默认关闭；打开后只对浏览器生效', () => {
  const chrome = { pid: 5, path: 'C:/Program Files/Google/Chrome/Application/chrome.exe', title: 'ChatGPT - Google Chrome' };
  assert.equal(classify(config, chrome).character, null, '默认关闭');
  const on = validateAgentsConfig({ ...raw, browserTitleRules: { ...raw.browserTitleRules, enabled: true } }).config;
  assert.equal(classify(on, chrome).character, 'gpt');
  assert.equal(classify(on, { ...chrome, title: 'Claude' }).character, 'claude');
  assert.equal(classify(on, { pid: 6, path: 'C:/x/notepad.exe', title: 'ChatGPT 笔记.txt' }).character, null, '非浏览器不看标题');
  assert.equal(classify(on, { ...chrome, path: 'C:/x/Kimi.exe' }).via, 'exe', 'exe 规则优先');
});

test('校验：坏配置给出可读错误', () => {
  const bad = validateAgentsConfig({
    rules: [
      { id: 'a', character: 'gpt', executables: ['C:/x/ChatGPT.exe'] },
      { id: 'b', character: 'nope', executables: ['x.exe'] },
      { id: 'c', character: 'kimi', executables: ['Kimi'] },
      { id: 'a', character: 'kimi', executables: ['Kimi.exe'] },
      { character: 'kimi', executables: ['Kimi.exe'] },
    ],
  });
  assert.equal(bad.errors.length, 5, bad.errors.join('\n'));
  assert.equal(validateAgentsConfig({}).errors.length, 1);
  // 大小写不敏感的角色名（旧配置写的是 "GPT"）
  assert.equal(validateAgentsConfig({ rules: [{ id: 'x', character: 'GPT', executables: ['ChatGPT.exe'] }] }).config.rules[0].character, 'gpt');
});
