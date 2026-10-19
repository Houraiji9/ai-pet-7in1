const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('assetsProgress', {
  onUpdate: (cb) => ipcRenderer.on('assets:progress', (e, data) => cb(data)),
  hide: () => ipcRenderer.send('assets:hide'),
  retry: () => ipcRenderer.send('assets:retry'),
});
