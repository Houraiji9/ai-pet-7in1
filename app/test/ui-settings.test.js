'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createUiSettings, clampScale, autoStartExePath } = require('../main/ui-settings.js');

test('clampScale', () => {
  assert.strictEqual(clampScale(0.1), 0.3);
  assert.strictEqual(clampScale(5), 2);
  assert.strictEqual(clampScale('abc'), 1);
  assert.strictEqual(clampScale(1.254), 1.25);
});

test('settings persist', () => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'uis-')), 'ui-settings.json');
  const a = createUiSettings(f);
  assert.deepStrictEqual(a.get(), { petScale: 1, autoStart: false });
  a.setPetScale(1.5);
  a.setAutoStart(true);
  const b = createUiSettings(f);
  assert.deepStrictEqual(b.get(), { petScale: 1.5, autoStart: true });
});

test('autoStartExePath prefers portable exe', () => {
  assert.strictEqual(autoStartExePath({ PORTABLE_EXECUTABLE_FILE: 'D:\\pet.exe' }, 'C:\\tmp\\x.exe'), 'D:\\pet.exe');
  assert.strictEqual(autoStartExePath({}, 'C:\\tmp\\x.exe'), 'C:\\tmp\\x.exe');
});
