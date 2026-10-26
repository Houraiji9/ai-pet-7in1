/**
 * ai-pet-7in1 —— Electron 主进程（单进程独立运行，不需要 DeepSeek Harness）。
 *
 * 由 PC2005-cloud/dsh-pet（MIT）的 runtime/electron-helper/main.js 改造：
 *   - 保留：透明置顶局部小窗、整窗点击穿透 + 命中区翻转（含主进程光标兜底）、置顶看门狗、
 *     Windows DPI 线性化、显示器热更新、多窗碰撞 broker（这些逻辑原样搬来，注释见原项目）；
 *   - 删掉：DSH 宿主进程、stdin/stdout bridge 管道、宿主存活探测、「打开 DSH 网站」；
 *   - 换成：自定义 scheme `dsh-pet-bridge://` 直接由本进程的 pet-api.js 应答（渲染端代码几乎不用改）；
 *   - 新增：前台窗口识别（foreground.js + matcher.js，规则来自主人之前的 C# 桌宠）、
 *     300ms 稳定防抖切换（switcher.js）、托盘菜单、调试窗口、本地碎碎念定时器、
 *     右键「查看余额」（main/balance/，按当前角色查 Codex / Cursor·Grok Bot / ZCode / DeepSeek）与余额设置窗口。
 */
'use strict';

const { app, BrowserWindow, ipcMain, screen, shell, protocol, Tray, Menu, nativeImage, clipboard, safeStorage, net } = require('electron');
const { createAssetSync } = require('./asset-sync.js');
const path = require('node:path');
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');

const { decideWindowIgnore, pointerZone } = require('./pointer-target.js');
const { TOPMOST_WATCHDOG_TICK_MS, shouldReassertTopmost } = require('./topmost-watchdog.js');
const { shouldLinearize, resolveForcedScale, resolvePetScale } = require('./dpi-linearization.js');
const { buildDeskGeometry } = require('./desktop-geometry.js');
const { parseJsonc } = require('./jsonc.js');
const { CHARACTERS, basename, validateAgentsConfig, classify } = require('./matcher.js');
const { Switcher } = require('./switcher.js');
const { createSpeciesStore } = require('./species.js');
const { createUiSettings, clampScale, autoStartExePath, SIZE_PRESETS } = require('./ui-settings.js');
const { createUpdater } = require('./updater.js');
let updater = null;
const { createPetApi } = require('./pet-api.js');
const { createForegroundProvider } = require('./foreground.js');
const { createSecretStore } = require('./balance/secrets.js');
const { createBalanceService } = require('./balance/index.js');

app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
app.setName('ai-pet-7in1');

const DPI_PROBE = process.env.DSH_PET_DPI_PROBE === '1';
const DPI_MARK = 'dsh-pet-primary-scale:';
const SMOKE_OUT = process.env.AIPET_SMOKE_OUT || '';

// 管道写失败（例如从终端启动后终端被关）不许变成 Electron 的模态错误框
for (const stream of [process.stdout, process.stderr]) stream.on('error', () => {});

if (process.platform === 'win32') app.disableHardwareAcceleration(); // 原项目 #37：透明分层窗软件合成更稳

// ---------- 路径 ----------
const APP_ROOT = path.join(__dirname, '..');
/** 用户目录：%APPDATA%\ai-pet-7in1（覆盖配置、额外素材、日志都在这里） */
const USER_DIR = process.env.AIPET_USER_DIR || app.getPath('userData');
/** 开发时（npm start）直接读项目目录 ai-pet-7in1/assets/<角色>/webm，免得每次复制素材 */
/** 测试隔离：userData/session/DPI 缓存全落到 AIPET_USER_DIR，外网一律拦掉，不启动自动更新 */
const TEST_ISOLATED = process.env.AIPET_TEST_ISOLATED === '1';
const testGuard = require('./test-guard.js');
if (TEST_ISOLATED) {
  app.setPath('userData', USER_DIR);
  app.setPath('sessionData', path.join(USER_DIR, 'session'));
  testGuard.installNodeGuard((u) => console.log('[隔离] 拦截外网请求 ' + u));
}
/** 测试可复现：AIPET_SMOKE_SEED 固定主进程 Math.random（渲染端由 preload 同样固定） */
if (process.env.AIPET_SMOKE_SEED) {
  let a = Number(process.env.AIPET_SMOKE_SEED) >>> 0 || 1;
  Math.random = () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const netFetch = TEST_ISOLATED ? testGuard.guardFetch((u, o) => net.fetch(u, o), (u) => console.log('[隔离] 拦截外网请求 ' + u)) : (u, o) => net.fetch(u, o);
const PROJECT_ASSETS = !app.isPackaged && fs.existsSync(path.join(APP_ROOT, '..', 'assets')) ? path.join(APP_ROOT, '..', 'assets') : null;
const LOG_FILE = path.join(USER_DIR, 'logs', 'ai-pet.log');

function log(...args) {
  const line = '[' + new Date().toLocaleString('zh-CN', { hour12: false }) + '] ' + args.map(String).join(' ');
  console.log(line);
  try {
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
    try {
      if (fs.statSync(LOG_FILE).size > 2 * 1024 * 1024) fs.renameSync(LOG_FILE, LOG_FILE + '.old');
    } catch {
      /* 还没有日志文件 */
    }
    fs.appendFileSync(LOG_FILE, line + '\n', 'utf8');
  } catch {
    /* 日志写不了不影响运行 */
  }
}

// ---------- DPI 线性化（原样移植，原理见 dsh-pet main.js 的长注释） ----------
function dpiCacheFile() {
  return path.join(app.getPath('userData'), 'primary-scale.json');
}
function readCachedPrimaryScale() {
  try {
    const v = Number(JSON.parse(fs.readFileSync(dpiCacheFile(), 'utf8')).scaleFactor);
    return Number.isFinite(v) && v > 0 ? v : 0;
  } catch {
    return 0;
  }
}
function parseProbeOutput(text) {
  const m = new RegExp(DPI_MARK + '([0-9.]+)').exec(String(text || ''));
  const v = m ? Number(m[1]) : 0;
  return Number.isFinite(v) && v > 0 ? v : 0;
}
function probePrimaryScale() {
  let out = '';
  try {
    out = execFileSync(process.execPath, app.isPackaged ? [] : [APP_ROOT], {
      env: { ...process.env, DSH_PET_DPI_PROBE: '1', AIPET_SMOKE_OUT: '' },
      timeout: 20000,
      encoding: 'utf8',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (e) {
    out = e && e.stdout ? String(e.stdout) : '';
  }
  const v = parseProbeOutput(out);
  if (v > 0) {
    try {
      fs.mkdirSync(path.dirname(dpiCacheFile()), { recursive: true });
      fs.writeFileSync(dpiCacheFile(), JSON.stringify({ scaleFactor: v }), 'utf8');
    } catch {
      /* ignore */
    }
  }
  return v;
}
let PRIMARY_SCALE = 0;
let FORCED_SCALE = 0;
const FORCE_DSF = process.env.DSH_PET_FORCE_DSF;
if (shouldLinearize({ platform: process.platform, dpiProbe: DPI_PROBE, forceDsf: FORCE_DSF })) {
  PRIMARY_SCALE = readCachedPrimaryScale() || probePrimaryScale();
  const forced = resolveForcedScale({ forceDsf: FORCE_DSF, primaryScale: PRIMARY_SCALE });
  if (forced > 0) {
    app.commandLine.appendSwitch('force-device-scale-factor', String(forced));
    FORCED_SCALE = forced;
  }
}
function petScale() {
  return resolvePetScale({ baseScale: process.env.DSH_PET_SCALE, primaryScale: PRIMARY_SCALE, forcedScale: FORCED_SCALE });
}

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'dsh-pet-bridge',
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, bypassCSP: true, corsEnabled: true },
  },
]);

// 只允许一个桌宠（再次双击 exe 会退出新实例）
if (!DPI_PROBE && !app.requestSingleInstanceLock()) {
  app.quit();
}

// ---------- 配置 ----------
const store = createSpeciesStore({ appRoot: APP_ROOT, userDir: USER_DIR, projectAssetsDir: PROJECT_ASSETS });
/** 界面设置：桌宠大小倍数 + 开机自启（ui-settings.json） */
const uiSettings = createUiSettings(path.join(USER_DIR, 'ui-settings.json'));

// ---------- 桌宠大小 ----------
function setPetScale(v, why) {
  const next = clampScale(v);
  if (next === uiSettings.get().petScale) return;
  uiSettings.setPetScale(next);
  log(`桌宠大小 → ${Math.round(next * 100)}%（${why}）`);
  lastRequestedBounds.clear();
  if (petWin && !petWin.isDestroyed()) petWin.webContents.send('pet:user-scale', next);
  refreshTray();
}

// ---------- 开机自动启动（只在 Windows 生效；安装版指向安装目录的 exe；便携版指向真正的 exe，而不是临时解压目录） ----------
function autoStartSupported() {
  return process.platform === 'win32' && app.isPackaged;
}
function applyAutoStart(on) {
  if (!autoStartSupported()) return;
  try {
    app.setLoginItemSettings({ openAtLogin: !!on, path: autoStartExePath(process.env, process.execPath), args: [] });
  } catch (e) {
    log('设置开机自启失败：' + e);
  }
}
function setAutoStart(on) {
  uiSettings.setAutoStart(on);
  applyAutoStart(on);
  log(on ? '已开启开机自动启动' : '已关闭开机自动启动');
  refreshTray();
}
let agents = validateAgentsConfig({ rules: [] }).config;
let agentsErrors = [];
let agentsFile = '';

function loadAgents() {
  const userFile = path.join(USER_DIR, 'agents.jsonc');
  const bundled = path.join(APP_ROOT, 'config', 'agents.jsonc');
  agentsFile = fs.existsSync(userFile) ? userFile : bundled;
  let parsed;
  try {
    parsed = parseJsonc(fs.readFileSync(agentsFile, 'utf8'));
  } catch (e) {
    agentsErrors = [`读取 ${agentsFile} 失败：${e && e.message ? e.message : e}`];
    parsed = null;
  }
  let r = parsed ? validateAgentsConfig(parsed) : null;
  if (r) agentsErrors = r.errors;
  if (!r || r.errors.length) {
    // 用户改坏了：退回程序自带的规则，错误在托盘/调试窗口里显示
    const fallback = validateAgentsConfig(parseJsonc(fs.readFileSync(bundled, 'utf8')));
    if (!r || r.config.rules.length === 0) r = fallback;
  }
  agents = r.config;
  if (agentsErrors.length) log('映射表有问题：' + agentsErrors.join('；'));
}

/** 把程序自带的配置复制到用户目录（不覆盖已有文件），方便用户用记事本改 */
function ensureUserConfigCopies() {
  fs.mkdirSync(path.join(USER_DIR, 'species'), { recursive: true });
  for (const name of ['agents.jsonc', 'species.jsonc']) {
    const dst = path.join(USER_DIR, name);
    const src = path.join(APP_ROOT, 'config', name);
    if (!fs.existsSync(dst)) fs.copyFileSync(src, dst);
    else {
      // 用户没改过（和以前某个版本自带的一模一样）→ 升级时换成新版自带的，否则修复（比如移动参数）永远不生效
      try {
        const h = require('crypto').createHash('sha256').update(fs.readFileSync(dst)).digest('hex');
        const known = (require('./shipped-config-hashes.json')[name] || []);
        if (known.includes(h) && !fs.readFileSync(dst).equals(fs.readFileSync(src))) {
          fs.copyFileSync(src, dst);
          log('配置 ' + name + ' 未被修改过，已升级为新版自带的');
        }
      } catch (e) {
        log('检查配置 ' + name + ' 是否需要升级失败：' + (e && e.message ? e.message : e));
      }
    }
  }
  for (const id of CHARACTERS) fs.mkdirSync(path.join(USER_DIR, 'species', id), { recursive: true });
}

// ---------- 状态 ----------
let petWin = null;
let tray = null;
let debugWin = null;
let balanceSettingsWin = null;
/** 余额：Key 存储与查询服务（app ready 之后才建，safeStorage 要等 ready） */
let secrets = null;
let balanceSvc = null;
let mode = 'auto'; // 'auto' | 'lock'
let switcher = null;
let fg = { provider: null, notes: [] };
let sampleTimer = null;
let whisperTimer = null;
let latest = null; // 最近一次采样 { fg, cls, at }
const history = []; // 最近的前台程序（不含桌宠自己），按路径去重，最多 15 条
let logForeground = false;
let quitting = false;

function speciesName(id) {
  const s = store.get().species[id];
  return s ? s.name : id;
}
function firstAvailable() {
  return CHARACTERS.find((id) => store.isAvailable(id)) || 'deepseek';
}

const petApi = createPetApi({ store, appRoot: APP_ROOT, onReload: () => reloadAll('右键菜单'), onBalance: () => queryBalanceForCurrent() });

// ---------- 查看余额 ----------
/** 右键「查看余额」：查**当前角色**，结果写进 /state，渲染端下一拍（≤1s）弹气泡 */
function queryBalanceForCurrent() {
  if (!balanceSvc) return;
  const character = switcher.current;
  balanceSvc
    .queryCharacter(character, { manual: true })
    .then((leaf) => petApi.writeBalance(leaf))
    .catch((e) => log('[余额] 查询异常：' + (e && e.name ? e.name : 'Error')));
}

function initBalance() {
  secrets = createSecretStore({ file: path.join(USER_DIR, 'balance-keys.json'), safeStorage });
  balanceSvc = createBalanceService({ secrets, log });
}

// ---------- 前台窗口采样 ----------
function startWatcher() {
  if (sampleTimer) clearInterval(sampleTimer);
  if (fg.provider) fg.provider.dispose();
  fg = createForegroundProvider({ intervalMs: agents.sampleIntervalMs, withTitle: agents.browserTitleRules.enabled, log });
  log('前台识别：' + fg.notes.join('；'));
  const self = { pid: process.pid, exe: process.execPath };
  sampleTimer = setInterval(() => {
    let sample = null;
    try {
      sample = fg.provider.read({ withTitle: agents.browserTitleRules.enabled });
    } catch (e) {
      sample = { error: String(e && e.message ? e.message : e) };
    }
    const cls = classify(agents, sample, self);
    const now = Date.now();
    latest = { fg: sample, cls, at: now };
    if (sample && sample.path && cls.via !== 'self') {
      if (!history.length || history[0].path !== sample.path) {
        history.unshift({ path: sample.path, exe: basename(sample.path), packageFamily: sample.packageFamily || '', cls, at: now });
        history.length = Math.min(history.length, 15);
        if (logForeground) {
          log(`[前台] ${basename(sample.path)} | ${sample.path} | 包身份=${sample.packageFamily || '无'} | ` +
              (cls.character ? `→ ${cls.character}（规则 ${cls.ruleId}${cls.verified ? '' : '，未验证'}）` : '→ 不是 Agent，保持当前角色'));
        }
        if (process.platform !== 'win32' && tray) refreshTray();
      }
    }
    if (switcher.observe(cls.character, now)) {
      log(`切换角色 → ${switcher.current}（${basename(sample.path)}，规则 ${cls.ruleId}）`);
      pushSpecies();
    }
  }, agents.sampleIntervalMs);
}

function pushSpecies() {
  if (assetSync) assetSync.prioritize(switcher.current);
  if (assetsReloadPending) {
    // 切到的角色有新下好的动画：重建宠物窗口让新配置生效
    assetsReloadPending = false;
    reloadAll('新下载的动画生效');
    return;
  }
  if (petWin && !petWin.isDestroyed()) petWin.webContents.send('pet:species', { species: switcher.current, mode });
  refreshTray();
}

// ---------- 动画资源按需下载（main/asset-sync.js） ----------
let assetSync = null;
let assetsReloadPending = false;
let assetsWin = null;
let assetsWinDismissed = false;
let assetsRetryTimer = null;
const ASSET_SYNC_ON = app.isPackaged ? process.env.AIPET_ASSET_SYNC !== '0' : process.env.AIPET_ASSET_SYNC === '1';

function assetsRoleText(s) {
  const id = s.current ? s.current.split('/')[0] : '';
  return id ? `正在下 ${speciesName(id)}，` : '';
}
function assetsStatusLabel() {
  if (!assetSync) return '';
  const s = assetSync.getStatus();
  if (s.state === 'downloading') return `动画资源：下载中 ${s.percent}%（点开看进度）`;
  if (s.state === 'checking') return '动画资源：检查中…';
  if (s.state === 'offline') return '动画资源：暂时连不上 GitHub（点击重试）';
  if (s.state === 'partial') return '动画资源：有些没下完（点击重试）';
  if (s.state === 'done') return '动画资源：已是最新（点击重新检查）';
  return '动画资源：检查更新';
}
function sendAssetsProgress(s) {
  if (assetsWin && !assetsWin.isDestroyed()) assetsWin.webContents.send('assets:progress', { ...s, roleText: assetsRoleText(s) });
}
function openAssetsWindow() {
  if (assetsWin && !assetsWin.isDestroyed()) { assetsWin.showInactive(); return; }
  const wa = screen.getPrimaryDisplay().workArea;
  const W = 340, H = 92;
  assetsWin = new BrowserWindow({
    width: W, height: H, x: wa.x + wa.width - W - 16, y: wa.y + wa.height - H - 16,
    frame: false, transparent: true, resizable: false, skipTaskbar: true, alwaysOnTop: true, show: false, focusable: true,
    title: 'AI 桌宠：下载动画资源',
    webPreferences: { preload: path.join(APP_ROOT, 'renderer', 'assets-progress-preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  assetsWin.loadFile(path.join(APP_ROOT, 'renderer', 'assets-progress.html'));
  assetsWin.webContents.once('did-finish-load', () => { sendAssetsProgress(assetSync.getStatus()); assetsWin.showInactive(); });
  assetsWin.on('closed', () => { assetsWin = null; });
}
function scheduleAssetsRetry(ms) {
  if (assetsRetryTimer) clearTimeout(assetsRetryTimer);
  assetsRetryTimer = setTimeout(() => runAssetSync(false), ms);
}
function runAssetSync(manual) {
  if (!assetSync) return;
  if (manual && assetSync.isRunning()) { assetsWinDismissed = false; openAssetsWindow(); return; }
  if (manual) assetsWinDismissed = false;
  assetSync.prioritize(switcher.current);
  assetSync.sync().then((s) => {
    refreshTray();
    if (s.state === 'offline' || s.state === 'partial') scheduleAssetsRetry(10 * 60 * 1000);
    else scheduleAssetsRetry(6 * 3600 * 1000);
    if (manual && s.state === 'done' && !s.totalFiles) {
      assetsWinDismissed = false; openAssetsWindow();
    }
    if (assetsWin && !assetsWin.isDestroyed() && s.state === 'done') setTimeout(() => assetsWin && !assetsWin.isDestroyed() && assetsWin.close(), 4000);
    if (manual && s.state === 'offline') { openAssetsWindow(); }
  });
}
function initAssetSync() {
  if (!ASSET_SYNC_ON) return;
  assetSync = createAssetSync({
    dir: path.join(USER_DIR, 'assets'),
    characters: CHARACTERS,
    fetch: (url, opts) => netFetch(url, opts),
    baseUrl: process.env.AIPET_ASSET_BASE || undefined,
    log,
    bundledFile: (id, name) => {
      const f = path.join(APP_ROOT, 'assets', id, 'webm', name + '.webm');
      return fs.existsSync(f) ? f : null;
    },
    onProgress: (s) => {
      sendAssetsProgress(s);
      // 要下的东西多（第一次启动）才弹进度窗；被用户点了「隐藏」就不再自己弹
      if (s.state === 'downloading' && s.totalBytes > 3 * 1048576 && !assetsWinDismissed && !assetsWin) openAssetsWindow();
    },
    onRoleDone: (id, changed) => {
      if (!changed) return;
      log(`[素材] ${speciesName(id)} 新下好 ${changed} 个动画`);
      store.load();
      if (id === switcher.current) reloadAll('新下载的动画生效');
      else assetsReloadPending = true;
    },
  });
  ipcMain.on('assets:hide', () => { assetsWinDismissed = true; if (assetsWin && !assetsWin.isDestroyed()) assetsWin.close(); });
  ipcMain.on('assets:retry', () => runAssetSync(true));
  setTimeout(() => runAssetSync(false), 2000);
}

function setMode(next, species) {
  if (next === 'lock' && store.isAvailable(species)) {
    mode = 'lock';
    switcher.locked = true;
    switcher.select(species);
    log('锁定角色：' + species);
  } else {
    mode = 'auto';
    switcher.locked = false;
    switcher.clearPending();
    log('自动切换模式');
  }
  pushSpecies();
}

function startWhisperTimer() {
  if (whisperTimer) clearInterval(whisperTimer);
  const sec = store.get().whisperIntervalSec;
  if (sec > 0) whisperTimer = setInterval(() => petApi.whisper(switcher.current), sec * 1000);
}

// ---------- 宠物窗口（单窗口，原项目 createPetWindows 的单宠版本） ----------
const lastRequestedBounds = new Map();
const winMargins = new Map();
const petStates = new Map();
const windowIgnore = new Map();
const inputBusy = new Map();
const inputRegions = new Map();
const offBodyMs = new Map();
const POINTER_POLL_MS = 60;
let pointerFallbackPaused = false;

function setWindowIgnore(win, ignore) {
  win.setIgnoreMouseEvents(ignore, { forward: true });
  windowIgnore.set(win.id, ignore);
}
function deskGeometry() {
  return buildDeskGeometry(screen.getAllDisplays(), screen.getPrimaryDisplay().id, process.platform);
}
function petWindowSize(size) {
  const height = (size * 9) / 16;
  const bottomPad = (size * (9 / 16) * (360 - 330)) / 360;
  const m = Math.round(size * 0.5);
  return { width: Math.round(size) + m * 2, height: Math.round(height + bottomPad) + m * 2 };
}

function createPetWindow() {
  const geo = deskGeometry();
  const area = geo.hull;
  const scale = petScale();
  const userScale = uiSettings.get().petScale;
  const { width, height } = petWindowSize(store.get().size * userScale * scale);
  const win = new BrowserWindow({
    width,
    height,
    x: area.x,
    y: area.y,
    show: false,
    useContentSize: true,
    enableLargerThanScreen: true,
    transparent: true,
    frame: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    hasShadow: false,
    focusable: true,
    title: 'AI 桌宠 7 合 1',
    webPreferences: {
      preload: path.join(APP_ROOT, 'renderer', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      paintWhenInitiallyHidden: false,
      spellcheck: false,
    },
  });
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.webContents.setBackgroundThrottling(false);
  win.webContents.on('context-menu', (e) => e.preventDefault());
  win.webContents.on('did-finish-load', () => win.webContents.setZoomFactor(scale));
  win.webContents.on('console-message', (event) => {
    const msg = event.message || '';
    if (/error|失败|warn/i.test(msg) || process.env.AIPET_DEBUG === '1') log('[渲染] ' + msg.slice(0, 400));
  });
  setWindowIgnore(win, true);
  win.once('ready-to-show', () => win.showInactive());
  win.webContents.once('did-finish-load', () => {
    setTimeout(() => {
      if (!win.isDestroyed() && !win.isVisible()) win.showInactive();
    }, 400);
  });
  const pointerTimer = setInterval(() => {
    if (pointerFallbackPaused || win.isDestroyed()) return;
    const b = win.getBounds();
    if (b.width < 8 || b.height < 8) return;
    const ignoring = windowIgnore.get(win.id) !== false;
    const busy = inputBusy.get(win.id) === true;
    const point = screen.getCursorScreenPoint();
    const mg = winMargins.get(win.id);
    const zone = pointerZone(b, point, mg);
    const nextMs = !busy && zone === 'margin' ? (offBodyMs.get(win.id) ?? 0) + POINTER_POLL_MS : 0;
    offBodyMs.set(win.id, nextMs);
    const next = decideWindowIgnore(b, point, ignoring, busy, nextMs, inputRegions.get(win.id), mg);
    if (next !== ignoring) setWindowIgnore(win, next);
  }, POINTER_POLL_MS);
  let lastTopmostAssertMs = Date.now();
  const topmostTimer = setInterval(() => {
    const nowMs = Date.now();
    if (!shouldReassertTopmost({ nowMs, lastAssertMs: lastTopmostAssertMs, destroyed: win.isDestroyed(), visible: win.isVisible(), paused: pointerFallbackPaused })) return;
    lastTopmostAssertMs = nowMs;
    win.setAlwaysOnTop(true, 'screen-saver');
  }, TOPMOST_WATCHDOG_TICK_MS);
  const winId = win.id;
  win.on('closed', () => {
    clearInterval(pointerTimer);
    clearInterval(topmostTimer);
    for (const m of [lastRequestedBounds, winMargins, windowIgnore, inputBusy, inputRegions, offBodyMs]) m.delete(winId);
    if (petWin === win) {
      petWin = null;
      if (!quitting) app.quit(); // 宠物窗口被意外关掉 = 退出（重新加载时换的是旧窗口，不会走到这里）
    }
  });
  win
    .loadFile(path.join(APP_ROOT, 'renderer', 'index.html'), {
      query: {
        configUrl: 'http://127.0.0.1:1/dsh-pet-7340/config', // 只用来推导 origin，实际请求全走 bridge scheme
        bridge: '1',
        openTarget: 'site',
        scale: String(scale),
        userScale: String(userScale),
        petIndex: '0',
        species: switcher.current,
        workAreaW: String(area.width),
        workAreaH: String(area.height),
        workAreaX: String(area.x),
        workAreaY: String(area.y),
        areas: JSON.stringify(geo.areas),
        workAreas: JSON.stringify(geo.workAreas),
        topInsetRatio: String(geo.topInsetRatio),
        panels: JSON.stringify(geo.panels),
        primaryIndex: String(geo.primaryIndex),
      },
    })
    .catch((e) => log('宠物窗口加载失败：' + e));
  win.webContents.once('did-finish-load', () => win.webContents.send('pet:species', { species: switcher.current, mode }));
  petWin = win;
}

function petIdOf(win) {
  return win === petWin ? 'pet' : null;
}

function registerIpc() {
  ipcMain.on('pet:set-bounds', (event, bounds) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || win.isDestroyed()) return;
    const x = Number(bounds?.x);
    const y = Number(bounds?.y);
    const width = Number(bounds?.width);
    const height = Number(bounds?.height);
    if (![x, y, width, height].every(Number.isFinite)) return;
    const rect = { x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height) };
    const key = rect.x + ',' + rect.y + ',' + rect.width + ',' + rect.height;
    if (lastRequestedBounds.get(win.id) !== key) {
      lastRequestedBounds.set(win.id, key);
      win.setContentBounds(rect, false);
    }
    const ml = Number(bounds?.marginL);
    const mt = Number(bounds?.marginT);
    if (Number.isFinite(ml) && Number.isFinite(mt)) winMargins.set(win.id, { l: ml, t: mt });
    const pid = petIdOf(win);
    if (pid) {
      petStates.set(pid, {
        x: Number(bounds?.boxX) || x,
        y: Number(bounds?.boxY) || y,
        size: Number(bounds?.size) || 0,
        bottomPad: Number(bounds?.bottomPad) || 0,
        vx: Number(bounds?.vx) || 0,
        vy: Number(bounds?.vy) || 0,
      });
    }
  });
  // 只有一只宠物：碰撞 broker 无事可做，但保留通道以免渲染端报错
  ipcMain.on('pet:report-flight', () => {});
  ipcMain.on('pet:collide-result', () => {});
  ipcMain.on('pet:set-interactive', (event, interactive) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || win.isDestroyed()) return;
    const input = inputRegions.get(win.id);
    const ignoring =
      interactive && input && inputBusy.get(win.id)
        ? decideWindowIgnore(win.getContentBounds(), screen.getCursorScreenPoint(), false, true, 0, input, winMargins.get(win.id))
        : !interactive;
    setWindowIgnore(win, ignoring);
  });
  ipcMain.on('pet:input-busy', (event, busy) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win && !win.isDestroyed()) inputBusy.set(win.id, !!busy);
  });
  ipcMain.on('pet:input-regions', (event, input) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || win.isDestroyed() || !input || !Array.isArray(input.rects)) return;
    const rects = input.rects.filter((r) => r && [r.x, r.y, r.width, r.height].every(Number.isFinite) && r.width > 0 && r.height > 0);
    inputRegions.set(win.id, { dragging: input.dragging === true, rects });
  });
  ipcMain.on('pet:open-site', () => {});
  ipcMain.on('pet:species-mode', (_e, payload) => {
    if (payload && payload.mode === 'lock') setMode('lock', String(payload.species || ''));
    else setMode('auto');
  });
  // 桌宠大小：右键菜单选档 / Ctrl+滚轮
  ipcMain.on('pet:set-user-scale', (_e, v) => setPetScale(v, '桌宠窗口'));
  ipcMain.on('debug:copy', (_e, textValue) => clipboard.writeText(String(textValue || '')));
  ipcMain.on('debug:open-balance-settings', () => openBalanceSettings());
  // ---- 余额设置窗口：明文 Key 只进不出（窗口只拿得到「已设置 / 未设置 / 来自环境变量」） ----
  const fromSettings = (event) => balanceSettingsWin && !balanceSettingsWin.isDestroyed() && event.sender === balanceSettingsWin.webContents;
  ipcMain.handle('balance-settings:status', (event) => (fromSettings(event) ? secrets.status() : null));
  ipcMain.handle('balance-settings:save', (event, payload) => {
    if (!fromSettings(event)) return { ok: false, message: 'denied' };
    try {
      const name = String(payload && payload.name);
      const value = payload && typeof payload.value === 'string' ? payload.value : '';
      if (value.trim() || name !== 'zai') secrets.set(name, value); // GLM 允许只改区域不填 Key
      if (name === 'zai' && payload && payload.region) secrets.setSetting('zaiRegion', payload.region === 'global' ? 'global' : 'bigmodel-cn');
      balanceSvc.invalidate(name === 'zai' ? 'zcode' : name);
      log('[余额] 已更新 ' + name + ' 的设置（Key 已加密保存）');
      return { ok: true, status: secrets.status() };
    } catch (e) {
      return { ok: false, message: String(e && e.message ? e.message : e), status: secrets.status() };
    }
  });
  ipcMain.handle('balance-settings:clear', (event, name) => {
    if (!fromSettings(event)) return { ok: false };
    secrets.clear(String(name));
    balanceSvc.invalidate(String(name) === 'zai' ? 'zcode' : String(name));
    log('[余额] 已清除 ' + name + ' 的 Key');
    return { ok: true, status: secrets.status() };
  });
  ipcMain.handle('balance-settings:test', async (event, provider) => {
    if (!fromSettings(event)) return null;
    const id = ['deepseek', 'zcode', 'codex', 'cursor'].includes(provider) ? provider : 'deepseek';
    balanceSvc.invalidate(id);
    const r = await balanceSvc.queryProvider(id);
    // 只回展示文字，不回任何原始数据
    if (r.ok && r.shape === 'lines') return { ok: true, text: r.data.rows.map((x) => x.text).join('\n') };
    if (r.ok && r.shape === 'money') return { ok: true, text: `余额 ${r.data.currency === 'USD' ? '$' : '¥'}${r.data.total}` };
    return { ok: false, text: r.message || r.reason };
  });
  ipcMain.on('debug:open-config', () => openConfigFolder());
}

// ---------- 托盘 ----------
function trayIcon() {
  const img = nativeImage.createFromPath(path.join(APP_ROOT, 'build', 'tray.png'));
  return img.isEmpty() ? nativeImage.createEmpty() : img.resize({ width: 16, height: 16 });
}

function clsText(c) {
  if (!c) return '';
  if (c.via === 'self') return '桌宠自己的窗口（忽略）';
  if (!c.character) return '不是 Agent → 保持当前角色';
  return `→ ${speciesName(c.character)}（规则 ${c.ruleId}${c.verified ? '' : '，未验证'}）`;
}

function buildTrayMenu() {
  const items = [];
  items.push({ label: `当前：${speciesName(switcher.current)}（${mode === 'auto' ? '自动' : '锁定'}）`, enabled: false });
  if (agentsErrors.length) items.push({ label: '⚠ 映射表有错误，已用默认规则（看调试窗口）', enabled: false });
  items.push({ type: 'separator' });
  items.push({ label: '自动切换（跟随前台程序）', type: 'radio', checked: mode === 'auto', click: () => setMode('auto') });
  items.push({
    label: '锁定角色',
    submenu: CHARACTERS.map((id) => {
      const ok = store.isAvailable(id);
      return {
        label: speciesName(id) + (ok ? '' : '（还没有素材）'),
        type: 'radio',
        enabled: ok,
        checked: mode === 'lock' && switcher.current === id,
        click: () => setMode('lock', id),
      };
    }),
  });
  items.push({ type: 'separator' });
  items.push({ label: `查看余额（${speciesName(switcher.current)}）`, click: () => petWin && !petWin.isDestroyed() && petWin.webContents.executeJavaScript('sprites[0] && sprites[0].onMenuAction({ action: "show-balance" })').catch(() => {}) });
  items.push({ label: '余额设置（API Key）…', click: openBalanceSettings });
  items.push({ type: 'separator' });
  const curScale = uiSettings.get().petScale;
  const onPreset = SIZE_PRESETS.some((p) => p.scale === curScale);
  items.push({
    label: `桌宠大小（现在 ${Math.round(curScale * 100)}%）`,
    submenu: SIZE_PRESETS.map((p) => ({ label: p.label, type: 'radio', checked: p.scale === curScale, click: () => setPetScale(p.scale, '托盘菜单') })).concat(
      onPreset ? [] : [{ label: `自定义（${Math.round(curScale * 100)}%）`, type: 'radio', checked: true, enabled: false }],
      [{ type: 'separator' }, { label: '小技巧：鼠标放在桌宠身上，按住 Ctrl 滚动滚轮也能调', enabled: false }],
    ),
  });
  items.push({
    label: '开机自动启动',
    type: 'checkbox',
    checked: uiSettings.get().autoStart,
    enabled: autoStartSupported(),
    click: (mi) => setAutoStart(mi.checked),
  });
  items.push({
    label: updater && updater.getState() === 'downloading' ? '检查更新（新版本下载中…）' : updater && updater.getState() === 'ready' ? '检查更新（新版本已下好）' : '检查更新',
    click: () => updater && updater.check(true),
  });
  if (assetSync) items.push({ label: assetsStatusLabel(), click: () => runAssetSync(true) });
  items.push({ type: 'separator' });
  items.push({ label: '调试：查看前台窗口…', click: openDebugWindow });
  items.push({
    label: '最近的前台程序（点击复制路径）',
    submenu: history.length
      ? history.map((h) => ({ label: `${h.exe}  ${clsText(h.cls)}`, toolTip: h.path, click: () => clipboard.writeText(h.path) }))
      : [{ label: '（还没有记录）', enabled: false }],
  });
  items.push({
    label: '把前台窗口变化记到日志',
    type: 'checkbox',
    checked: logForeground,
    click: (mi) => {
      logForeground = mi.checked;
      log(logForeground ? '开始记录前台窗口变化' : '停止记录前台窗口变化');
    },
  });
  items.push({ label: '打开日志文件', click: () => shell.openPath(LOG_FILE) });
  items.push({ type: 'separator' });
  items.push({ label: '打开配置文件夹', click: openConfigFolder });
  items.push({ label: '重新加载配置', click: () => reloadAll('托盘菜单') });
  items.push({ type: 'separator' });
  items.push({ label: '退出', click: () => app.quit() });
  return Menu.buildFromTemplate(items);
}

function refreshTray() {
  if (!tray) return;
  tray.setToolTip(`AI 桌宠：${speciesName(switcher.current)}（${mode === 'auto' ? '自动' : '锁定'}）`);
  if (process.platform !== 'win32') tray.setContextMenu(buildTrayMenu());
}

function createTray() {
  tray = new Tray(trayIcon());
  if (process.platform === 'win32') {
    // Windows：每次点开都现建菜单，「最近的前台程序」等信息才是最新的
    const pop = () => tray.popUpContextMenu(buildTrayMenu());
    tray.on('click', pop);
    tray.on('right-click', pop);
  }
  refreshTray();
}

function openConfigFolder() {
  try {
    ensureUserConfigCopies();
  } catch (e) {
    log('复制配置失败：' + e);
  }
  shell.openPath(USER_DIR);
}

// ---------- 调试窗口 ----------
function debugPayload() {
  const f = latest && latest.fg;
  return {
    now: Date.now(),
    provider: fg.provider ? fg.provider.kind : '',
    providerNotes: fg.notes,
    providerError: fg.provider && fg.provider.lastError ? fg.provider.lastError : '',
    foreground: f
      ? { exe: f.path ? basename(f.path) : '', path: f.path || '', packageFamily: f.packageFamily || '', pid: f.pid || 0, title: f.title, error: f.error }
      : null,
    classification: latest ? latest.cls : null,
    classificationText: latest ? clsText(latest.cls) : '',
    mode,
    current: switcher.current,
    currentName: speciesName(switcher.current),
    pending: switcher.pending,
    history: history.map((h) => ({ exe: h.exe, path: h.path, packageFamily: h.packageFamily, text: clsText(h.cls), at: h.at })),
    species: CHARACTERS.map((id) => store.describe(id)),
    agentsFile,
    agentsErrors,
    speciesFile: store.configFile(),
    speciesErrors: store.get().errors,
    userDir: USER_DIR,
    logFile: LOG_FILE,
    sampleIntervalMs: agents.sampleIntervalMs,
    debounceMs: agents.debounceMs,
    titleRules: agents.browserTitleRules.enabled,
    balance: balanceSvc ? balanceSvc.debugStatus() : [],
  };
}

let debugTimer = null;
function openDebugWindow() {
  if (debugWin && !debugWin.isDestroyed()) {
    debugWin.show();
    return;
  }
  debugWin = new BrowserWindow({
    width: 640,
    height: 560,
    title: 'AI 桌宠 调试：前台窗口',
    alwaysOnTop: true, // 切到别的程序时这个窗口还在，方便看
    autoHideMenuBar: true,
    webPreferences: { preload: path.join(APP_ROOT, 'renderer', 'debug-preload.js'), contextIsolation: true, nodeIntegration: false },
  });
  debugWin.loadFile(path.join(APP_ROOT, 'renderer', 'debug.html'));
  debugTimer = setInterval(() => {
    if (debugWin && !debugWin.isDestroyed()) debugWin.webContents.send('debug:update', debugPayload());
  }, 250);
  debugWin.on('closed', () => {
    clearInterval(debugTimer);
    debugWin = null;
  });
}

// ---------- 余额设置窗口 ----------
function openBalanceSettings() {
  if (balanceSettingsWin && !balanceSettingsWin.isDestroyed()) {
    balanceSettingsWin.show();
    balanceSettingsWin.focus();
    return;
  }
  balanceSettingsWin = new BrowserWindow({
    width: 520,
    height: 700,
    title: 'AI 桌宠：余额设置',
    autoHideMenuBar: true,
    webPreferences: { preload: path.join(APP_ROOT, 'renderer', 'balance-settings-preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  balanceSettingsWin.loadFile(path.join(APP_ROOT, 'renderer', 'balance-settings.html'));
  balanceSettingsWin.on('closed', () => {
    balanceSettingsWin = null;
  });
}

// ---------- 重新加载 ----------
function reloadAll(why) {
  log('重新加载配置（' + why + '）');
  store.load();
  loadAgents();
  switcher.debounceMs = agents.debounceMs;
  if (!store.isAvailable(switcher.current)) switcher.select(firstAvailable());
  if (mode === 'lock' && !store.isAvailable(switcher.current)) setMode('auto');
  startWatcher();
  startWhisperTimer();
  petApi.bumpConfigVersion();
  const old = petWin;
  createPetWindow();
  if (old && !old.isDestroyed()) old.destroy();
  refreshTray();
}

// ---------- 冒烟自检（AIPET_SMOKE_OUT=结果文件；只给开发测试用） ----------
function startSmoke() {
  const totalMs = Number(process.env.AIPET_SMOKE_MS || 12000);
  const shots = String(process.env.AIPET_SMOKE_SHOTS || '').split(',').map(Number).filter((n) => n > 0);
  const started = Date.now();
  const rows = [];
  const events = [];
  let phase = 'start';
  let finished = false;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  async function sampleRow() {
    if (!petWin || petWin.isDestroyed()) return null;
    try {
      const r = await petWin.webContents.executeJavaScript(`(() => {
        const d = window.__dshPetDebug || {};
        const v = [...document.querySelectorAll('video.pet-video')].find((x) => x.classList.contains('is-front'));
        return { species: d.species, configOk: d.configOk, sprites: d.spriteCount, errors: (d.errors || []).slice(-3),
                 front: v ? decodeURIComponent(v.src.split('/thumb/')[1] || '') : '', paused: v ? v.paused : null,
                 errorText: (document.getElementById('pet-error') || { textContent: '' }).textContent,
                 bubble: (document.querySelector('.pet-bubble.is-on') || { textContent: '' }).textContent };
      })()`);
      return { t: Date.now() - started, phase, main: switcher.current, mode, fgExe: latest && latest.fg && latest.fg.path ? basename(latest.fg.path) : '', ...r };
    } catch (e) {
      return { t: Date.now() - started, phase, err: String(e) };
    }
  }
  /** 轮询直到 pred 成立或超时；返回最后一次取到的值 */
  async function waitValue(get, pred, timeoutMs) {
    const end = Date.now() + timeoutMs;
    let v;
    for (;;) {
      try { v = await get(); } catch { v = undefined; }
      if (pred(v) || Date.now() >= end || finished) return v;
      await sleep(50);
    }
  }
  const tick = setInterval(async () => {
    const r = await sampleRow();
    if (r) rows.push(r);
  }, 250);
  for (const at of shots) {
    setTimeout(async () => {
      try {
        const img = await petWin.webContents.capturePage();
        fs.writeFileSync(SMOKE_OUT.replace(/\.json$/, '') + '-' + at + '.png', img.toPNG());
      } catch (e) {
        rows.push({ t: at, shotErr: String(e) });
      }
    }, at);
  }
  function finish(timedOut) {
    if (finished) return;
    finished = true;
    clearInterval(tick);
    fs.writeFileSync(SMOKE_OUT, JSON.stringify({ rows, events, timedOut: !!timedOut, debug: debugPayload() }, null, 2));
    app.quit();
  }
  // 脚本化操作按顺序执行：[{ at?（最早开始时间）, mark?（阶段名，写进采样行）, do, ... }]
  let script = [];
  try {
    script = JSON.parse(process.env.AIPET_SMOKE_SCRIPT || '[]');
  } catch {
    script = [];
  }
  const cap = setTimeout(() => finish(script.length > 0), totalMs); // 没脚本时按时长结束；有脚本时这是总超时
  if (!script.length) return;
  (async () => {
    for (const step of script) {
      if (finished) return;
      if (step.at) await sleep(Math.max(0, step.at - (Date.now() - started)));
      if (step.mark) phase = step.mark;
      if (!step.do) continue;
      const rec = { t: Date.now() - started, do: step.do, mark: step.mark };
      try {
        if (step.do === 'menu-lock' || step.do === 'menu-auto') {
          // 走真实的渲染端右键菜单处理函数 → IPC → 主进程 setMode
          const leaf = step.do === 'menu-lock' ? { action: 'species-lock', species: step.species } : { action: 'species-auto' };
          await petWin.webContents.executeJavaScript(`sprites[0].onMenuAction(${JSON.stringify(leaf)}); true`);
        } else if (step.do === 'pet-size' || step.do === 'wheel' || step.do === 'size-probe') {
          // 桌宠大小：菜单选档 / Ctrl+滚轮 / 读当前尺寸和脚底位置
          if (step.do === 'pet-size') await petWin.webContents.executeJavaScript(`sprites[0].onMenuAction({ action: 'pet-size', scale: ${Number(step.scale)} }); true`);
          if (step.do === 'wheel')
            await petWin.webContents.executeJavaScript(`(() => { const h = sprites[0].hit; for (let i = 0; i < ${Number(step.n || 1)}; i++) h.dispatchEvent(new WheelEvent('wheel', { deltaY: ${Number(step.deltaY || -100)}, ctrlKey: true, bubbles: true, cancelable: true })); return true; })()`);
          rec.size = await petWin.webContents.executeJavaScript(
            `(() => { const s = sprites[0]; return { size: s.size, footX: s.pos.x + s.halfW, footY: s.pos.y + s.height, userScale: CONFIG.userScale }; })()`,
          );
          rec.saved = uiSettings.get().petScale;
          rec.win = petWin.getContentBounds();
        } else if (step.do === 'context-menu') {
          rec.menu = await petWin.webContents.executeJavaScript(`(async () => {
            const hit = document.querySelector('.pet-hit'); const r = hit.getBoundingClientRect();
            hit.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: r.x + r.width / 2, clientY: r.y + r.height / 2 }));
            const m = document.querySelector('.dsh-pet-menu'); const root = m ? m.textContent : '';
            const br = [...(m ? m.querySelectorAll('.dsh-pet-menu-branch') : [])].find((b) => b.textContent.includes('切换角色'));
            if (br) br.dispatchEvent(new MouseEvent('mouseenter', { bubbles: false, relatedTarget: m }));
            await new Promise((r) => setTimeout(r, 80));
            const all = m ? m.textContent : '';
            sprites[0].closeMenu();
            return { root, all };
          })()`);
        } else if (step.do === 'tray') {
          rec.tray = buildTrayMenu().items.map((i) => (i.submenu ? i.label + ' > [' + i.submenu.items.map((x) => x.label + (x.checked ? '*' : '') + (x.enabled ? '' : '(禁用)')).join(' | ') + ']' : i.label));
        } else if (step.do === 'fg') {
          fs.writeFileSync(process.env.AIPET_FOREGROUND_MOCK, JSON.stringify(step.fg));
        } else if (step.do === 'sleep') {
          await sleep(step.ms || 0);
        } else if (step.do === 'wait') {
          // 等可观察的状态，而不是固定毫秒：{ until: { main?, species?, mode?, front?, frontNot?, bubbleIn?, configOk? }, timeoutMs? }
          const u = step.until || {};
          const match = (r) =>
            !!r && (u.main === undefined || r.main === u.main) && (u.species === undefined || r.species === u.species) && (u.mode === undefined || r.mode === u.mode) &&
            (u.configOk === undefined || r.configOk === u.configOk) && (u.front === undefined || String(r.front).startsWith(u.front)) &&
            (u.frontNot === undefined || (r.front && r.front !== u.frontNot)) && (u.bubbleIn === undefined || u.bubbleIn.includes(r.bubble));
          const r = await waitValue(sampleRow, match, step.timeoutMs || 8000);
          rec.ok = match(r);
          rec.row = r;
        } else if (step.do === 'whisper') {
          petApi.whisper(switcher.current);
        } else if (step.do === 'reload') {
          reloadAll('冒烟测试');
        } else if (step.do === 'balance') {
          // 走真实的右键菜单处理函数 → POST /balance → 主进程查询 → /state → 气泡
          await petWin.webContents.executeJavaScript(`sprites[0].onMenuAction({ action: 'show-balance' }); true`);
          const bubble = () => petWin.webContents.executeJavaScript(`(document.querySelector('.pet-bubble.is-on') || { textContent: '' }).textContent`);
          rec.loading = await waitValue(bubble, (t) => /正在查询/.test(t), 2000);
          rec.bubble = await waitValue(bubble, (t) => t && !/正在查询/.test(t), step.waitMs || 8000);
          rec.species = switcher.current;
        } else if (step.do === 'balance-settings') {
          openBalanceSettings();
          rec.settingsText = await waitValue(() => balanceSettingsWin.webContents.executeJavaScript('document.body ? document.body.innerText.slice(0, 1500) : ""'), (t) => new RegExp(step.expect || '.{20}').test(t), 6000);
          const img = await balanceSettingsWin.webContents.capturePage();
          fs.writeFileSync(SMOKE_OUT.replace(/\.json$/, '') + '-balance-settings.png', img.toPNG());
        } else if (step.do === 'debug-window') {
          openDebugWindow();
          rec.debugText = await waitValue(() => debugWin.webContents.executeJavaScript('document.body ? document.body.innerText.slice(0, 6000) : ""'), (t) => new RegExp(step.expect || '.{20}').test(t), 6000);
          const img = await debugWin.webContents.capturePage();
          fs.writeFileSync(SMOKE_OUT.replace(/\.json$/, '') + '-debug.png', img.toPNG());
        }
      } catch (e) {
        rec.err = String(e && e.stack ? e.stack : e);
      }
      rec.after = { main: switcher.current, mode };
      events.push(rec);
    }
    const last = await sampleRow();
    if (last) rows.push(last);
    clearTimeout(cap);
    finish(false);
  })();
}

// ---------- 启动 ----------
app.on('second-instance', () => {
  if (tray) tray.displayBalloon?.({ title: 'AI 桌宠', content: '桌宠已经在运行了（看右下角托盘图标）' });
});

app.whenReady().then(() => {
  if (DPI_PROBE) {
    process.stdout.write(DPI_MARK + screen.getPrimaryDisplay().scaleFactor + '\n');
    setTimeout(() => app.exit(0), 0);
    return;
  }
  fs.mkdirSync(USER_DIR, { recursive: true });
  initBalance();
  loadAgents();
  const initial = store.isAvailable(agents.defaultCharacter) ? agents.defaultCharacter : firstAvailable();
  switcher = new Switcher(initial, { debounceMs: agents.debounceMs, isAvailable: (id) => store.isAvailable(id) });
  log(`启动：角色=${initial}，可用角色=${CHARACTERS.filter((id) => store.isAvailable(id)).join(',')}，规则=${agentsFile}，素材(开发目录)=${PROJECT_ASSETS || '无'}`);

  protocol.handle('dsh-pet-bridge', async (request) => {
    const headers = { 'access-control-allow-origin': '*' };
    try {
      const url = new URL(request.url);
      const method = request.method || 'GET';
      const body = method === 'POST' || method === 'PUT' ? await request.text() : undefined;
      const resp = petApi.handle(method, url.pathname + url.search, body);
      if (resp.contentType) headers['content-type'] = resp.contentType;
      if (resp.file) {
        const data = await fs.promises.readFile(resp.file);
        return new Response(new Uint8Array(data), { status: resp.status || 200, headers });
      }
      return new Response(resp.body ?? '', { status: resp.status || 200, headers });
    } catch (e) {
      log('接口出错：' + (e && e.stack ? e.stack : e));
      return new Response('ai-pet: internal error', { status: 500, headers });
    }
  });

  registerIpc();
  // 每次启动按保存的设置重写一次自启项：便携版 exe 被挪了位置也能跟上
  if (uiSettings.get().autoStart) applyAutoStart(true);
  createPetWindow();
  createTray();
  startWatcher();
  startWhisperTimer();
  updater = createUpdater({ log, onState: () => refreshTray() });
  if (!TEST_ISOLATED) setTimeout(() => updater.check(false), 15000); // 启动 15 秒后静默检查一次
  if (!TEST_ISOLATED) setInterval(() => updater.check(false), 6 * 3600 * 1000); // 常驻时每 6 小时再查一次
  initAssetSync();

  let displaysTimer = null;
  const scheduleDisplays = () => {
    if (displaysTimer) clearTimeout(displaysTimer);
    displaysTimer = setTimeout(() => {
      displaysTimer = null;
      lastRequestedBounds.clear();
      if (petWin && !petWin.isDestroyed()) petWin.webContents.send('pet:displays', deskGeometry());
    }, 300);
  };
  screen.on('display-metrics-changed', scheduleDisplays);
  screen.on('display-added', scheduleDisplays);
  screen.on('display-removed', scheduleDisplays);

  if (SMOKE_OUT) startSmoke();
});

app.on('before-quit', () => {
  quitting = true;
  if (fg.provider) fg.provider.dispose();
});
app.on('window-all-closed', () => {
  // 调试窗口关掉不退出；宠物窗口的退出逻辑在它自己的 closed 里
});
