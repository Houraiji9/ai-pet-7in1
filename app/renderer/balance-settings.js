'use strict';
const $ = (id) => document.getElementById(id);
const TEXT = { saved: '已保存（加密）', env: '来自环境变量', none: '未设置' };

function show(status) {
  if (!status) return;
  for (const n of ['deepseek', 'zai']) {
    const el = $('st-' + n);
    const v = status.keys[n] || 'none';
    el.textContent = TEXT[v] || v;
    el.className = 'st ' + v;
  }
  $('region').value = status.settings.zaiRegion || 'bigmodel-cn';
  $('enc').hidden = status.encryptionAvailable;
}

function out(id, r) {
  const el = $(id);
  el.textContent = r ? r.text || r.message || '' : '';
  el.className = 'out' + (r && r.ok === false ? ' err' : '');
}

async function save(name, region) {
  const input = $('k-' + name);
  const r = await window.balanceSettings.save(name, input.value, region);
  input.value = ''; // 明文不在页面里多停留
  show(r.status);
  out(name === 'zai' ? 'out-zcode' : 'out-' + name, r.ok ? { ok: true, text: '已保存' } : { ok: false, text: r.message });
}

async function test(provider, outId) {
  out(outId, { ok: true, text: '正在查询…' });
  out(outId, await window.balanceSettings.test(provider));
}

$('save-deepseek').onclick = () => save('deepseek');
$('save-zai').onclick = () => save('zai', $('region').value);
$('clear-deepseek').onclick = async () => show((await window.balanceSettings.clear('deepseek')).status);
$('clear-zai').onclick = async () => show((await window.balanceSettings.clear('zai')).status);
$('test-deepseek').onclick = () => test('deepseek', 'out-deepseek');
$('test-zcode').onclick = () => test('zcode', 'out-zcode');
$('test-codex').onclick = () => test('codex', 'out-other');
$('test-cursor').onclick = () => test('cursor', 'out-other');
window.balanceSettings.status().then(show);
