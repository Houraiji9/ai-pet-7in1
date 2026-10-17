'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');

const S = require('./fixtures/balance-samples.js');
const deepseek = require('../main/balance/deepseek.js');
const codex = require('../main/balance/codex.js');
const cursor = require('../main/balance/cursor.js');
const zcode = require('../main/balance/zcode.js');
const { createSecretStore } = require('../main/balance/secrets.js');
const { createBalanceService } = require('../main/balance/index.js');
const { createPetApi } = require('../main/pet-api.js');

const NOW = new Date('2026-10-17T12:00:00Z'); // 2026-10-17 是周六 → DeepSeek 低谷
const FAKE_KEY = 'sk-test-DO-NOT-LEAK-0123456789';

/** 假 fetch：按 URL 返回 JSON，并记录请求头 */
function fakeFetch(routes, calls = []) {
  return async (url, init = {}) => {
    calls.push({ url, headers: init.headers || {} });
    for (const [prefix, v] of Object.entries(routes)) {
      if (url.startsWith(prefix)) {
        const { status = 200, body } = typeof v === 'function' ? v(url, init) : { body: v };
        return { ok: status >= 200 && status < 300, status, json: async () => body };
      }
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
}

function loadShared() {
  const code = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'shared-core.js'), 'utf8');
  return vm.runInNewContext(code + '\n;PetShared', { console, fetch: () => {}, URL, Intl, Date, Math });
}

// ---------------- DeepSeek ----------------
test('DeepSeek：没 Key → credential-missing（提示去余额设置）', async () => {
  await assert.rejects(deepseek.fetchDeepSeek({ getSecret: () => '', env: {} }), (e) => e.balanceStatus === 'credential-missing' && /余额设置/.test(e.message));
});

test('DeepSeek：有 Key → money 形状，挑有钱的币种，带峰谷与 ¥20 基准', async () => {
  const calls = [];
  const r = await deepseek.fetchDeepSeek({ getSecret: () => FAKE_KEY, env: {}, fetch: fakeFetch({ [deepseek.DEEPSEEK_BALANCE_URL]: S.deepseekBalance }, calls), now: () => NOW });
  assert.equal(calls[0].headers.Authorization, 'Bearer ' + FAKE_KEY);
  assert.deepEqual(
    { shape: r.shape, currency: r.data.currency, total: r.data.total, full: r.data.fullBalance, tier: r.data.tier },
    { shape: 'money', currency: 'CNY', total: '11.06', full: '20', tier: 'idle' },
  );
});

test('DeepSeek：HTTP 401 → 凭证问题（消息里没有 Key）', async () => {
  const p = deepseek.fetchDeepSeek({ getSecret: () => FAKE_KEY, env: {}, fetch: fakeFetch({ 'https://api.deepseek.com': () => ({ status: 401, body: {} }) }) });
  await assert.rejects(p, (e) => e.balanceStatus === 'unauthorized' && !e.message.includes(FAKE_KEY));
});

test('DeepSeek：开发用地址覆盖只认 127.0.0.1', async () => {
  const calls = [];
  const f = fakeFetch({ 'http://127.0.0.1:5': S.deepseekBalance, 'https://api.deepseek.com': S.deepseekBalance }, calls);
  await deepseek.fetchDeepSeek({ getSecret: () => FAKE_KEY, env: { AIPET_DEEPSEEK_BASE_URL: 'http://127.0.0.1:5' }, fetch: f });
  await deepseek.fetchDeepSeek({ getSecret: () => FAKE_KEY, env: { AIPET_DEEPSEEK_BASE_URL: 'https://evil.example.com' }, fetch: f });
  assert.equal(calls[0].url, 'http://127.0.0.1:5/user/balance');
  assert.equal(calls[1].url, deepseek.DEEPSEEK_BALANCE_URL);
});

test('DeepSeek 峰谷：北京时间工作日 10 点高峰、20 点低谷', () => {
  assert.equal(deepseek.deepseekPricingTier(new Date('2026-10-14T02:00:00Z')), 'peak'); // 周三 10:00 CST
  assert.equal(deepseek.deepseekPricingTier(new Date('2026-10-14T12:00:00Z')), 'idle'); // 周三 20:00 CST
});

// ---------------- Codex ----------------
/** 假 codex app-server：收到 initialize / account/rateLimits/read 就按 handler 回 */
function fakeSpawn(handler, spawned = []) {
  return (command, args) => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new PassThrough();
    child.pid = 4242;
    child.kill = () => setImmediate(() => child.emit('close', 0));
    spawned.push({ command, args });
    let buf = '';
    child.stdin.on('data', (c) => {
      buf += c;
      let i;
      while ((i = buf.indexOf('\n')) !== -1) {
        const msg = JSON.parse(buf.slice(0, i));
        buf = buf.slice(i + 1);
        if (msg.id === undefined) continue;
        const reply = handler(msg);
        if (reply) child.stdout.write(JSON.stringify({ id: msg.id, ...reply }) + '\n');
      }
    });
    return child;
  };
}

test('Codex：app-server JSON-RPC → 5小时 / 周 两行，百分比取最大', async () => {
  const spawned = [];
  const sp = fakeSpawn((m) => (m.method === 'initialize' ? { result: {} } : m.method === 'account/rateLimits/read' ? { result: S.codexRpc } : null), spawned);
  const r = await codex.fetchCodex({ commands: ['codex'], spawn: sp, platform: 'linux', env: {}, now: () => new Date(1_791_990_000_000) });
  assert.equal(r.shape, 'lines');
  assert.equal(r.data.percent, 32);
  assert.equal(r.data.rows[0].text, 'Codex Plus 额度');
  assert.match(r.data.rows[1].text, /^5小时 已用 32% · 2\.8 小时后重置$/);
  assert.match(r.data.rows[2].text, /^周 已用 12%/);
  assert.deepEqual(spawned[0].args, ['-s', 'read-only', '-a', 'never', 'app-server']);
});

test('Codex：第一个命令不存在（ENOENT）就试下一个', async () => {
  let n = 0;
  const ok = fakeSpawn((m) => (m.method === 'initialize' ? { result: {} } : { result: S.codexRpc }));
  const sp = (cmd, args, o) => {
    n++;
    if (cmd === 'missing') {
      const c = new EventEmitter();
      c.stdout = new PassThrough();
      c.stdin = new PassThrough();
      c.kill = () => {};
      setImmediate(() => c.emit('error', Object.assign(new Error('spawn missing ENOENT'), { code: 'ENOENT' })));
      return c;
    }
    return ok(cmd, args, o);
  };
  const r = await codex.fetchCodex({ commands: ['missing', 'codex'], spawn: sp, platform: 'linux', env: {} });
  assert.equal(n, 2);
  assert.equal(r.ok, true);
});

test('Codex：CLI 没有 → 退回 auth.json + wham/usage（token 只进请求头）', async () => {
  const sp = () => {
    const c = new EventEmitter();
    c.stdout = new PassThrough();
    c.stdin = new PassThrough();
    c.kill = () => {};
    setImmediate(() => c.emit('error', Object.assign(new Error('ENOENT'), { code: 'ENOENT' })));
    return c;
  };
  const calls = [];
  const readFileSync = (p) => {
    assert.equal(p, path.join('/fake-codex-home', 'auth.json'));
    return JSON.stringify({ tokens: { access_token: 'at-secret', account_id: 'acc-1' } });
  };
  const r = await codex.fetchCodex({ commands: ['codex'], spawn: sp, platform: 'linux', env: { CODEX_HOME: '/fake-codex-home' }, readFileSync, fetch: fakeFetch({ [codex.CODEX_USAGE_URL]: S.codexUsage }, calls) });
  assert.equal(calls[0].headers.Authorization, 'Bearer at-secret');
  assert.equal(calls[0].headers['chatgpt-account-id'], 'acc-1');
  assert.equal(r.data.rows[0].text, 'Codex Pro 额度');
  assert.equal(r.data.percent, 55);
  assert.ok(!JSON.stringify(r).includes('at-secret'));
});

test('Codex：CLI 没有、也没登录 → credential-missing', async () => {
  const sp = () => {
    const c = new EventEmitter();
    c.stdout = new PassThrough();
    c.stdin = new PassThrough();
    c.kill = () => {};
    setImmediate(() => c.emit('error', Object.assign(new Error('ENOENT'), { code: 'ENOENT' })));
    return c;
  };
  await assert.rejects(
    codex.fetchCodex({ commands: ['codex'], spawn: sp, platform: 'linux', env: {}, readFileSync: () => { throw new Error('ENOENT'); } }),
    (e) => e.balanceStatus === 'credential-missing' && /Codex/.test(e.message),
  );
});

test('Codex：Windows 候选含商店版自带的 codex.exe（新版本优先）与 npm 的 codex.cmd', () => {
  const env = { LOCALAPPDATA: 'C:\\U\\AppData\\Local', APPDATA: 'C:\\U\\AppData\\Roaming', PROGRAMFILES: 'C:\\Program Files' };
  const exists = new Set([
    'C:\\Program Files\\WindowsApps\\OpenAI.Codex_26.1.0.0_x64__2p2nqsd0c76g0\\app\\resources\\codex.exe',
    'C:\\Program Files\\WindowsApps\\OpenAI.Codex_26.2.0.0_x64__2p2nqsd0c76g0\\app\\resources\\codex.exe',
    'C:\\U\\AppData\\Roaming\\npm\\codex.cmd',
  ]);
  const readdirSync = (dir) =>
    dir === 'C:\\Program Files\\WindowsApps' ? ['OpenAI.Codex_26.1.0.0_x64__2p2nqsd0c76g0', 'OpenAI.Codex_26.2.0.0_x64__2p2nqsd0c76g0', 'Other.App_1'] : [];
  const c = codex.codexCommandCandidates(env, 'win32', { existsSync: (p) => exists.has(p), readdirSync });
  assert.deepEqual(c.slice(0, 3), [
    'C:\\Program Files\\WindowsApps\\OpenAI.Codex_26.2.0.0_x64__2p2nqsd0c76g0\\app\\resources\\codex.exe',
    'C:\\Program Files\\WindowsApps\\OpenAI.Codex_26.1.0.0_x64__2p2nqsd0c76g0\\app\\resources\\codex.exe',
    'C:\\U\\AppData\\Roaming\\npm\\codex.cmd',
  ]);
  const spec = codex.codexSpawnSpec('C:\\U\\AppData\\Roaming\\npm\\codex.cmd', 'win32');
  assert.equal(spec.command, 'cmd.exe');
});

// ---------------- Cursor / Grok Bot ----------------
function jwt(payload) {
  const b = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return b({ alg: 'none' }) + '.' + b(payload) + '.sig';
}

/** 假 https：按 hostname+path 路由，记录 Cookie / Authorization */
function fakeHttps(routes, calls = []) {
  return {
    request(opts, cb) {
      const req = new EventEmitter();
      req.setTimeout = () => {};
      req.write = () => {};
      req.destroy = () => {};
      req.end = () => {
        const key = opts.hostname + opts.path.split('?')[0];
        calls.push({ key, method: opts.method, headers: opts.headers });
        const body = routes[key];
        const res = new EventEmitter();
        res.resume = () => {};
        res.statusCode = body === undefined ? 404 : body === 401 ? 401 : 200;
        setImmediate(() => {
          cb(res);
          if (res.statusCode === 200) {
            res.emit('data', Buffer.from(JSON.stringify(body)));
            res.emit('end');
          }
        });
      };
      return req;
    },
  };
}

function cursorRoutes(s) {
  return {
    'cursor.com/api/usage-summary': s.summary,
    'cursor.com/api/auth/me': s.me,
    'cursor.com/api/usage': s.usage,
    'cursor.com/api/dashboard/get-sand-usage-status': s.sand,
    'cursor.com/api/dashboard/get-plan-info': s.plan,
    ...(s.prepaid ? { 'cursor.com/api/dashboard/get-user-prepaid-billing': s.prepaid } : {}),
    ...(s.period ? { 'api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage': s.period } : {}),
  };
}

const fakeSqlite = (value, seen = {}) => ({
  DatabaseSync: class {
    constructor(file, opts) {
      seen.file = file;
      seen.opts = opts;
    }
    prepare(sql) {
      seen.sql = sql;
      return { get: (k) => (k === 'cursorAuth/accessToken' && value ? { value } : undefined) };
    }
    close() {
      seen.closed = true;
    }
  },
});

test('Cursor：从 state.vscdb 只读取 token，拼成 userId%3A%3Ajwt', () => {
  const token = jwt({ sub: 'auth0|user_abc123' });
  const seen = {};
  const raw = cursor.readCursorDesktopAccessToken({ dbPaths: [__filename], sqlite: fakeSqlite(token, seen) });
  assert.equal(raw, token);
  assert.deepEqual(seen.opts, { readOnly: true });
  assert.equal(seen.closed, true);
  assert.equal(cursor.normalizeCursorSessionToken(raw), 'user_abc123%3A%3A' + token);
  assert.equal(cursor.sessionAccessToken('user_abc123%3A%3A' + token), token);
});

test('Cursor：没装 / 没登录 → credential-missing', async () => {
  await assert.rejects(cursor.fetchCursor({ dbPaths: ['/no/such/state.vscdb'] }), (e) => e.balanceStatus === 'credential-missing');
  await assert.rejects(cursor.fetchCursor({ dbPaths: [__filename], sqlite: fakeSqlite(null) }), (e) => e.balanceStatus === 'credential-missing');
});

test('Cursor 旧计划：Grok Bot 一行 + 两个模型池 + 按量，Cookie 带 session token', async () => {
  const token = jwt({ sub: 'auth0|user_abc123' });
  const calls = [];
  const r = await cursor.fetchCursor({ dbPaths: [__filename], sqlite: fakeSqlite(token), httpsLib: fakeHttps(cursorRoutes(S.cursorLegacy), calls), now: () => new Date('2026-10-17T00:00:00Z') });
  const texts = r.data.rows.map((x) => x.text);
  assert.equal(texts[0], 'Cursor Pro 额度');
  assert.match(texts[1], /^Grok Bot 已用 25% · 3\.0 天后重置$/);
  assert.ok(texts.includes('其他模型 已用 62%'));
  assert.ok(texts.some((t) => t.startsWith('Cursor 模型 已用 40%')));
  assert.ok(texts.includes('按量 $3.50 / $20.00'));
  assert.equal(r.data.percent, 61.5);
  const sum = calls.find((c) => c.key === 'cursor.com/api/usage-summary');
  assert.equal(sum.headers.Cookie, 'WorkosCursorSessionToken=user_abc123%3A%3A' + token);
  assert.ok(calls.some((c) => c.key === 'cursor.com/api/dashboard/get-sand-usage-status' && c.method === 'POST'));
  assert.ok(!JSON.stringify(r).includes(token));
});

test('Cursor 合并计划（X 订阅）：共用额度用 GetCurrentPeriodUsage（Bearer jwt），显示预付余额', async () => {
  const token = jwt({ sub: 'auth0|user_abc123' });
  const calls = [];
  const r = await cursor.fetchCursor({ dbPaths: [__filename], sqlite: fakeSqlite(token), httpsLib: fakeHttps(cursorRoutes(S.cursorUnified), calls) });
  const texts = r.data.rows.map((x) => x.text);
  assert.equal(texts[0], 'Cursor Super 额度');
  assert.match(texts[1], /^共用额度（含 Grok Bot）已用 38%/);
  assert.ok(texts.includes('预付余额 $12.50'));
  assert.equal(r.data.percent, 37.5);
  const per = calls.find((c) => c.key.startsWith('api2.cursor.sh'));
  assert.equal(per.headers.Authorization, 'Bearer ' + token);
});

test('Cursor：401 → 提示重新登录', async () => {
  const token = jwt({ sub: 'auth0|user_abc123' });
  const routes = { ...cursorRoutes(S.cursorLegacy), 'cursor.com/api/usage-summary': 401 };
  await assert.rejects(cursor.fetchCursor({ dbPaths: [__filename], sqlite: fakeSqlite(token), httpsLib: fakeHttps(routes) }), (e) => e.balanceStatus === 'unauthorized' && /重新登录/.test(e.message));
});

// ---------------- ZCode / GLM ----------------
test('GLM 解析：5小时 / 周 / MCP 三个窗口，套餐名来自订阅', () => {
  const u = zcode.parseZaiUsage(S.zaiQuota, S.zaiSubscription);
  assert.equal(u.plan, 'GLM Coding Pro');
  assert.deepEqual(u.windows.map((w) => [w.label, Math.round(w.usedPercent)]), [['5小时', 30], ['周', 10], ['MCP 本月', 10]]);
});

test('GLM 入门套餐计费桶解析', () => {
  const u = zcode.parseZcodeStartPlanBalances(S.zcodeStartPlan);
  assert.equal(u.plan, 'Start Plan');
  assert.deepEqual(u.windows.map((w) => [w.label, w.usedPercent]), [['GLM-4.6', 25]]);
});

function zcodeDir(registryOpts) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aipet-zcode-'));
  fs.writeFileSync(path.join(dir, 'setting.json'), JSON.stringify({ providerFamilyDomain: 'bigmodel', providerFamilyConnectionSelections: { bigmodel: { kind: registryOpts.kind } } }));
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ provider: registryOpts.provider }));
  return dir;
}

test('GLM：ZCode 编程套餐（3.11 明文镜像 Key）→ open.bigmodel.cn quota', async () => {
  const dir = zcodeDir({ kind: 'individual-coding-plan', provider: { 'builtin:bigmodel-coding-plan': { options: { apiKey: 'zk-mirror' } } } });
  const calls = [];
  const f = fakeFetch({ 'https://open.bigmodel.cn/api/monitor/usage/quota/limit': S.zaiQuota, 'https://open.bigmodel.cn/api/biz/subscription/list': S.zaiSubscription }, calls);
  const r = await zcode.fetchZcode({ getSecret: () => '', env: {}, fetch: f, zcodeDir: dir, homeDir: dir });
  assert.equal(r.data.rows[0].text, 'GLM GLM Coding Pro 额度');
  assert.equal(r.data.percent, 30);
  assert.equal(calls[0].headers.Authorization, 'Bearer zk-mirror');
  assert.equal(r.data.source, 'ZCode 本机登录');
});

test('GLM：没装 ZCode、也没填 Key → credential-missing', async () => {
  await assert.rejects(zcode.fetchZcode({ getSecret: () => '', env: {}, zcodeDir: '/no/such/zcode' }), (e) => e.balanceStatus === 'credential-missing' && /ZCode/.test(e.message));
});

test('GLM：手填 Key（国内版）→ 额度 + 账户现金余额', async () => {
  const f = fakeFetch({
    'https://open.bigmodel.cn/api/monitor/usage/quota/limit': S.zaiQuota,
    'https://open.bigmodel.cn/api/biz/subscription/list': S.zaiSubscription,
    'https://open.bigmodel.cn/api/biz/account/query-customer-account-report': S.zaiCash,
  });
  const r = await zcode.fetchZcode({ getSecret: (n) => (n === 'zai' ? 'manual-key' : ''), getSetting: () => 'bigmodel-cn', env: {}, fetch: f, zcodeDir: '/no/such/zcode' });
  assert.ok(r.data.rows.some((x) => x.text === '账户余额 ¥23.46'));
  assert.equal(r.data.source, '手填 GLM Key');
});

test('GLM：网关 200 + code 401 → 凭证失效', async () => {
  const f = fakeFetch({ 'https://open.bigmodel.cn': () => ({ body: { code: 401, msg: 'token expired' } }) });
  await assert.rejects(zcode.fetchZcode({ getSecret: () => 'manual-key', env: {}, fetch: f, zcodeDir: '/no/such/zcode' }), (e) => e.balanceStatus === 'unauthorized');
});

// ---------------- Key 存储 ----------------
function fakeSafeStorage(available = true) {
  return {
    isEncryptionAvailable: () => available,
    encryptString: (s) => Buffer.from('ENC:' + Buffer.from(s).toString('hex')),
    decryptString: (b) => Buffer.from(b.toString().slice(4), 'hex').toString(),
  };
}

test('Key 存储：加密后落盘，文件里没有明文；status 不含明文；环境变量兜底', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'aipet-keys-')), 'balance-keys.json');
  const st = createSecretStore({ file, safeStorage: fakeSafeStorage(), env: { ZHIPU_API_KEY: 'env-zai' } });
  st.set('deepseek', FAKE_KEY);
  assert.ok(!fs.readFileSync(file, 'utf8').includes(FAKE_KEY));
  assert.equal(st.get('deepseek'), FAKE_KEY);
  assert.equal(st.get('zai'), 'env-zai');
  const status = st.status();
  assert.deepEqual(status.keys, { deepseek: 'saved', zai: 'env' });
  assert.ok(!JSON.stringify(status).includes(FAKE_KEY));
  st.clear('deepseek');
  assert.equal(st.get('deepseek'), '');
});

test('Key 存储：系统加密不可用时拒绝保存（不退化成明文）', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'aipet-keys-')), 'balance-keys.json');
  const st = createSecretStore({ file, safeStorage: fakeSafeStorage(false), env: {} });
  assert.throws(() => st.set('deepseek', FAKE_KEY), /加密不可用/);
  assert.equal(fs.existsSync(file), false);
});

// ---------------- 服务 / 角色路由 ----------------
test('角色路由：Gemini / Claude / Kimi → 暂未接入（友好提示）', async () => {
  const svc = createBalanceService({ secrets: { get: () => '', getSetting: () => '' } });
  for (const [id, name] of [['gemini', 'Gemini'], ['claude', 'Claude'], ['kimi', 'Kimi']]) {
    const r = await svc.queryCharacter(id);
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'unsupported');
    assert.match(r.message, new RegExp(name + '.*暂未接入'));
    assert.equal(r.manual, true);
  }
});

test('服务：DeepSeek 结果带角色；调试状态只有 来源/状态/时间，不含 Key；5 秒内连点复用结果', async () => {
  let n = 0;
  const f = async () => {
    n++;
    return { ok: true, status: 200, json: async () => S.deepseekBalance };
  };
  const svc = createBalanceService({ secrets: { get: () => FAKE_KEY, getSetting: () => '' }, ctx: { fetch: f, env: {} } });
  const a = await svc.queryCharacter('deepseek');
  const b = await svc.queryCharacter('deepseek');
  assert.equal(a.character, 'deepseek');
  assert.equal(a.shape, 'money');
  assert.equal(n, 1);
  assert.equal(b.data.total, '11.06');
  const dbg = svc.debugStatus();
  assert.equal(dbg.find((x) => x.provider === 'deepseek').state, 'ok');
  assert.ok(!JSON.stringify(dbg).includes(FAKE_KEY));
});

test('服务：provider 抛未知异常 → fetch-error，只留异常类名', async () => {
  const svc = createBalanceService({ secrets: { get: () => FAKE_KEY, getSetting: () => '' }, ctx: { fetch: async () => { throw new TypeError('boom ' + FAKE_KEY); }, env: {} } });
  const r = await svc.queryCharacter('deepseek');
  assert.equal(r.reason, 'fetch-error');
  assert.ok(!JSON.stringify(r).includes(FAKE_KEY));
});

test('pet-api：POST /balance 触发查询，writeBalance 写进 /state 的 sections.balance', async () => {
  let asked = 0;
  const store = { get: () => ({ species: {} }), mergedConfig: () => ({}), resolveAnim: () => null };
  const api = createPetApi({ store, appRoot: '/tmp', onBalance: () => asked++ });
  assert.equal(JSON.parse(api.handle('POST', '/dsh-pet-7340/balance?pet=gpt').body).ok, true);
  assert.equal(api.handle('GET', '/dsh-pet-7340/balance').status, 405);
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(asked, 1);
  const before = JSON.parse(api.handle('GET', '/dsh-pet-7340/state').body).sections.balance.counter;
  api.writeBalance({ ok: false, provider: 'Kimi', reason: 'unsupported', message: 'Kimi 的余额查询暂未接入', manual: true });
  const leaf = JSON.parse(api.handle('GET', '/dsh-pet-7340/state').body).sections.balance;
  assert.ok(leaf.counter > before);
  assert.equal(leaf.data.message, 'Kimi 的余额查询暂未接入');
});

// ---------------- 渲染端展示（shared-core） ----------------
test('气泡：lines 形状原样出行，百分比驱动档位；暂未接入只显示一句说明', () => {
  const P = loadShared();
  const st = P.toBalanceState({ ok: true, provider: 'codex', shape: 'lines', data: { rows: [{ role: 'label', text: 'Codex 额度' }, { role: 'sub', text: '5小时 已用 32%' }], percent: 32 } });
  assert.equal(P.balancePercent(st), 32);
  assert.deepEqual(JSON.parse(JSON.stringify(P.balanceBubbleView(st))), [{ role: 'label', text: 'Codex 额度' }, { role: 'sub', text: '5小时 已用 32%' }]);
  const un = P.toBalanceState({ ok: false, provider: 'Gemini / Antigravity', reason: 'unsupported', message: 'Gemini / Antigravity 的余额查询暂未接入' });
  assert.deepEqual(JSON.parse(JSON.stringify(P.balanceBubbleView(un))), [{ role: 'error', text: 'Gemini / Antigravity 的余额查询暂未接入' }]);
  const money = P.toBalanceState({ ok: true, provider: 'deepseek', shape: 'money', data: { currency: 'CNY', total: '11.06', fullBalance: '20', tier: 'idle' } });
  assert.equal(P.balanceBubbleView(money).map((r) => r.text).join(''), '余额（谷）¥11.06');
  assert.equal(Math.round(P.balancePercent(money)), 45);
});
