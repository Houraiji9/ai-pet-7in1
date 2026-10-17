'use strict';
// 移植自 C# 桌宠 tests/Pet.Tests/Program.cs 的 Switcher 用例
const test = require('node:test');
const assert = require('node:assert/strict');
const { Switcher } = require('../main/switcher.js');

test('[旧桌宠] 300ms 稳定才切换（边界含 300）', () => {
  const s = new Switcher('gpt');
  assert.equal(s.observe('kimi', 0), false);
  assert.equal(s.observe('kimi', 299), false);
  assert.equal(s.observe('kimi', 300), true);
  assert.equal(s.current, 'kimi');
  assert.equal(s.observe('kimi', 999), false, '已经是当前角色');
});

test('[旧桌宠] 快速来回切不触发；普通程序取消候选并保留角色', () => {
  const s = new Switcher('gpt');
  for (let t = 0; t < 1000; t += 50) assert.equal(s.observe(t % 100 === 0 ? 'kimi' : 'glm', t), false);
  assert.equal(s.observe(null, 1300), false);
  assert.equal(s.current, 'gpt');
  assert.equal(s.observe('kimi', 1500), false);
  assert.equal(s.observe(null, 1600), false, '取消');
  assert.equal(s.observe('kimi', 1800), false, '重新计时');
  assert.equal(s.observe('kimi', 2100), true);
});

test('[旧桌宠] 锁定期间不切换，解锁后重新计时', () => {
  const s = new Switcher('gpt');
  s.locked = true;
  s.select('glm');
  assert.equal(s.observe('grok', 1000) || s.observe('grok', 1300), false);
  s.locked = false;
  assert.equal(s.observe('grok', 1500), false);
  assert.equal(s.observe('grok', 1800), true);
});

test('[旧桌宠] 时间倒退时重新计时', () => {
  const s = new Switcher('gpt');
  s.observe('kimi', 900);
  assert.equal(s.observe('kimi', 100), false);
  assert.equal(s.observe('kimi', 399), false);
  assert.equal(s.observe('kimi', 400), true);
});

test('没有素材的角色当作「不是 Agent」：保持当前角色', () => {
  const s = new Switcher('deepseek', { isAvailable: (id) => id !== 'claude' });
  assert.equal(s.observe('claude', 0), false);
  assert.equal(s.observe('claude', 1000), false);
  assert.equal(s.current, 'deepseek');
  assert.equal(s.observe('gpt', 1000), false);
  assert.equal(s.observe('gpt', 1300), true);
});

test('防抖时长可配置', () => {
  const s = new Switcher('gpt', { debounceMs: 0 });
  assert.equal(s.observe('kimi', 5), false, '第一拍只登记候选');
  assert.equal(s.observe('kimi', 5), true);
});
