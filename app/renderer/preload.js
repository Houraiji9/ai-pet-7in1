// preload 桥（复制自 dsh-pet runtime/electron-helper/preload.js，删掉了「打开 DSH 网站」，加了角色切换两条通道）
// 原有原语的说明见原项目：setBounds / setInteractive / setInputBusy / setInputRegions / 跨窗碰撞 / onDisplays。
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('petBridge', {
  setBounds(x, y, width, height, boxX, boxY, size, bottomPad, vx, vy, marginL, marginT) {
    ipcRenderer.send('pet:set-bounds', { x, y, width, height, boxX, boxY, size, bottomPad, vx, vy, marginL, marginT });
  },
  setInteractive(interactive) {
    ipcRenderer.send('pet:set-interactive', !!interactive);
  },
  setInputBusy(busy) {
    ipcRenderer.send('pet:input-busy', !!busy);
  },
  setInputRegions(input) {
    ipcRenderer.send('pet:input-regions', input);
  },
  openDshSite() {
    /* ai-pet-7in1：没有 DSH 网站可打开 */
  },
  reportFlight(state) {
    ipcRenderer.send('pet:report-flight', state);
  },
  onFlightStates(cb) {
    ipcRenderer.on('pet:flight-states', (e, states) => cb(states));
  },
  reportCollide(targetId, vx, vy) {
    ipcRenderer.send('pet:collide-result', { targetId, vx, vy });
  },
  onPetHit(cb) {
    ipcRenderer.on('pet:hit', (e, payload) => cb(payload));
  },
  onDisplays(cb) {
    ipcRenderer.on('pet:displays', (e, geo) => cb(geo));
  },
  // ---- ai-pet-7in1：角色切换 ----
  /** 主进程推来「现在该显示哪个角色」：{ species, mode: 'auto' | 'lock' } */
  onSpecies(cb) {
    ipcRenderer.on('pet:species', (e, msg) => cb(msg));
  },
  /** 右键菜单「切换角色」：{ mode: 'auto' } 或 { mode: 'lock', species } */
  setSpeciesMode(payload) {
    ipcRenderer.send('pet:species-mode', payload);
  },
  // ---- ai-pet-7in1：桌宠大小 ----
  /** 请主进程改大小倍数（保存后会经 onUserScale 回推） */
  setUserScale(v) {
    ipcRenderer.send('pet:set-user-scale', Number(v));
  },
  onUserScale(cb) {
    ipcRenderer.on('pet:user-scale', (e, v) => cb(v));
  },
});
