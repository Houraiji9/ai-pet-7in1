'use strict';
let last = null;
const $ = (id) => document.getElementById(id);
function rows(el, list) {
  el.innerHTML = '';
  for (const [k, v, cls] of list) {
    const tr = document.createElement('tr');
    const a = document.createElement('td');
    a.className = 'k';
    a.textContent = k;
    const b = document.createElement('td');
    b.textContent = v == null || v === '' ? '—' : String(v);
    if (cls) b.className = cls;
    tr.append(a, b);
    el.appendChild(tr);
  }
}
function fgText(d) {
  const f = d.foreground || {};
  return [`exe 文件名: ${f.exe || ''}`, `完整路径: ${f.path || ''}`, `包身份: ${f.packageFamily || '无'}`, `识别结果: ${d.classificationText}`].join('\n');
}
window.dbg.onUpdate((d) => {
  last = d;
  const f = d.foreground || {};
  const c = d.classification || {};
  rows($('fg'), [
    ['exe 文件名', f.exe, 'big'],
    ['完整路径', f.path],
    ['包身份', f.packageFamily || '无（不是商店应用）'],
    ['进程 PID', f.pid],
    ...(d.titleRules ? [['窗口标题', f.title]] : []),
    ['识别结果', d.classificationText, c.character ? (c.verified ? 'ok' : 'warn') : ''],
    ...(f.error ? [['读取问题', f.error, 'warn']] : []),
  ]);
  rows($('pet'), [
    ['当前角色', `${d.currentName}（${d.current}）`, 'big'],
    ['模式', d.mode === 'auto' ? '自动（跟随前台程序）' : '锁定'],
    ['待定候选', d.pending ? `${d.pending}（稳定 ${d.debounceMs}ms 后切换）` : '无'],
  ]);
  rows(
    $('hist'),
    d.history.map((h) => [new Date(h.at).toLocaleTimeString('zh-CN', { hour12: false }), `${h.exe}  ${h.text}\n${h.path}${h.packageFamily ? '\n包身份: ' + h.packageFamily : ''}`]),
  );
  rows(
    $('species'),
    d.species.map((s) => [
      s.id,
      `${s.name}：` + (!s.enabled ? '已禁用' : s.available ? `可用（${s.total - s.missing.length}/${s.total} 个动画）` : '还没有素材，切到它时保持当前角色') +
        (s.available && s.missing.length ? `；缺：${s.missing.join('、')}` : ''),
      s.available ? 'ok' : '',
    ]),
  );
  const BAL = { ok: '正常', running: '查询中…', idle: '还没查过', unsupported: '不支持', 'credential-missing': '缺凭证 / 未登录', 'fetch-error': '查询失败' };
  rows(
    $('balance'),
    (d.balance || []).map((b) => [
      b.label,
      `${BAL[b.state] || b.state}` +
        (b.at ? `  ${new Date(b.at).toLocaleTimeString('zh-CN', { hour12: false })}` : '') +
        (b.ms ? `（${b.ms}ms）` : '') +
        (b.source ? `\n来源：${b.source}` : '') +
        (b.message ? `\n${b.message}` : ''),
      b.state === 'ok' ? 'ok' : b.state === 'idle' || b.state === 'running' ? '' : 'warn',
    ]),
  );
  rows($('cfgt'), [
    ['识别方式', d.provider + (d.providerNotes.length ? '（' + d.providerNotes.join('；') + '）' : '')],
    ...(d.providerError ? [['识别报错', d.providerError, 'warn']] : []),
    ['采样/防抖', `${d.sampleIntervalMs}ms 采样，候选稳定 ${d.debounceMs}ms 才切换`],
    ['映射表', d.agentsFile],
    ...(d.agentsErrors.length ? [['映射表错误', d.agentsErrors.join('\n'), 'warn']] : []),
    ['角色配置', d.speciesFile],
    ...(d.speciesErrors.length ? [['角色配置错误', d.speciesErrors.join('\n'), 'warn']] : []),
    ['用户目录', d.userDir],
    ['日志', d.logFile],
  ]);
});
$('copy').onclick = () => last && window.dbg.copy(fgText(last));
$('copyHist').onclick = () =>
  last && window.dbg.copy(last.history.map((h) => `${h.exe}\t${h.path}\t${h.packageFamily || ''}\t${h.text}`).join('\n'));
$('cfg').onclick = () => window.dbg.openConfig();
$('balset').onclick = () => window.dbg.openBalanceSettings();
