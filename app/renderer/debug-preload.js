const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('dbg', {
  onUpdate: (cb) => ipcRenderer.on('debug:update', (e, data) => cb(data)),
  copy: (text) => ipcRenderer.send('debug:copy', text),
  openConfig: () => ipcRenderer.send('debug:open-config'),
  openBalanceSettings: () => ipcRenderer.send('debug:open-balance-settings'),
});
