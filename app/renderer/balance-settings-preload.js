// 余额设置窗口的桥：只能「交 Key / 清 Key / 查状态 / 试查一次」，拿不回任何明文 Key
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('balanceSettings', {
  status: () => ipcRenderer.invoke('balance-settings:status'),
  save: (name, value, region) => ipcRenderer.invoke('balance-settings:save', { name, value, region }),
  clear: (name) => ipcRenderer.invoke('balance-settings:clear', name),
  test: (provider) => ipcRenderer.invoke('balance-settings:test', provider),
});
