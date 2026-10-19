'use strict';
/**
 * 自动更新：electron-updater + GitHub Releases（Houraiji9/ai-pet-7in1，读 latest.yml）。
 * 只在安装版（NSIS）里生效；开发模式 / 便携版不检查。
 * 启动后后台检查 → 有新版就后台下载（支持 blockmap 差分）→ 下好弹窗「新版本已下好，重启安装？」。
 * 托盘「检查更新」= 手动检查，会把「已是最新 / 出错」也告诉用户。
 */
const { app, dialog } = require('electron');

function isInstalledBuild(env = process.env) {
  return app.isPackaged && process.platform === 'win32' && !env.PORTABLE_EXECUTABLE_FILE;
}

function createUpdater({ log, onState }) {
  let autoUpdater = null;
  let state = 'idle'; // idle | checking | downloading | ready | error
  let manual = false;
  let prompted = false;
  let readyVersion = '';
  const set = (s) => { state = s; if (onState) onState(s); };

  function init() {
    if (autoUpdater || !isInstalledBuild()) return autoUpdater;
    ({ autoUpdater } = require('electron-updater'));
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.logger = { info: (m) => log('[更新] ' + m), warn: (m) => log('[更新] ' + m), error: (m) => log('[更新] ' + m), debug: () => {} };
    autoUpdater.on('checking-for-update', () => set('checking'));
    autoUpdater.on('update-available', (i) => {
      log('[更新] 发现新版本 ' + i.version + '，后台下载中');
      set('downloading');
      if (manual) dialog.showMessageBox({ type: 'info', title: 'AI 桌宠', message: `发现新版本 ${i.version}，正在后台下载，下好了会提醒您。` });
    });
    autoUpdater.on('update-not-available', () => {
      set('idle');
      if (manual) dialog.showMessageBox({ type: 'info', title: 'AI 桌宠', message: `已经是最新版本（${app.getVersion()}）。` });
      manual = false;
    });
    autoUpdater.on('error', (e) => {
      log('[更新] 出错：' + (e && e.message ? e.message : e));
      set('error');
      if (manual) dialog.showMessageBox({ type: 'warning', title: 'AI 桌宠', message: '检查更新失败，可能是网络连不上 GitHub，稍后再试。' });
      manual = false;
    });
    autoUpdater.on('update-downloaded', async (i) => {
      set('ready');
      readyVersion = i.version || readyVersion;
      manual = false;
      if (prompted) return;
      prompted = true;
      const r = await dialog.showMessageBox({
        type: 'question',
        title: 'AI 桌宠',
        message: `新版本 ${readyVersion} 已下好，重启安装？`,
        detail: '选「稍后」的话，下次退出桌宠时会自动安装。',
        buttons: ['重启安装', '稍后'],
        defaultId: 0,
        cancelId: 1,
      });
      if (r.response === 0) autoUpdater.quitAndInstall(true, true);
      else prompted = false;
    });
    return autoUpdater;
  }

  function check(isManual) {
    if (!isInstalledBuild()) {
      if (isManual) dialog.showMessageBox({ type: 'info', title: 'AI 桌宠', message: '只有安装版才能自动更新。请到 GitHub Releases 下载安装版。' });
      return;
    }
    const u = init();
    if (state === 'ready') { prompted = false; u.emit('update-downloaded', { version: readyVersion }); return; }
    if (state === 'checking' || state === 'downloading') {
      if (isManual) dialog.showMessageBox({ type: 'info', title: 'AI 桌宠', message: state === 'downloading' ? '新版本正在后台下载，下好了会提醒您。' : '正在检查更新…' });
      return;
    }
    manual = !!isManual;
    u.checkForUpdates().catch((e) => log('[更新] 检查失败：' + e));
  }

  return { check, getState: () => state, isInstalledBuild };
}

module.exports = { createUpdater, isInstalledBuild };
