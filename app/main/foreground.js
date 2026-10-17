'use strict';
/**
 * 读取「当前前台窗口」所属进程的信息：{ pid, path, packageFamily, title? }。
 *
 * 做法与主人之前的 C# 桌宠（old-codex-pet/src/Pet.Windows/Native.cs 的 ReadForeground）一致：
 *   GetForegroundWindow → GetWindowThreadProcessId → OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION)
 *   → QueryFullProcessImageNameW（完整 exe 路径）→ GetPackageFamilyName（MSIX/商店应用的包身份，没有就为空）。
 * 只查询，不注入、不读窗口内容。窗口标题只有在开启了「浏览器标题规则」时才读。
 *
 * 三种实现，按顺序尝试：
 *   1. koffi（直接调用 Win32 API，最快，推荐）；
 *   2. PowerShell 常驻子进程（koffi 加载失败时的后备，稍慢但不需要原生模块）；
 *   3. mock（测试/非 Windows：从 AIPET_FOREGROUND_MOCK 指向的 JSON 文件读）。
 */
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

function createKoffiProvider() {
  const koffi = require('koffi');
  const user32 = koffi.load('user32.dll');
  const kernel32 = koffi.load('kernel32.dll');
  const GetForegroundWindow = user32.func('void* __stdcall GetForegroundWindow()');
  const GetWindowThreadProcessId = user32.func(
    'uint32 __stdcall GetWindowThreadProcessId(void* hwnd, _Out_ uint32* pid)',
  );
  const GetWindowTextW = user32.func('int __stdcall GetWindowTextW(void* hwnd, _Out_ uint16* buf, int max)');
  const OpenProcess = kernel32.func('void* __stdcall OpenProcess(uint32 access, int inherit, uint32 pid)');
  const CloseHandle = kernel32.func('int __stdcall CloseHandle(void* h)');
  const QueryFullProcessImageNameW = kernel32.func(
    'int __stdcall QueryFullProcessImageNameW(void* h, uint32 flags, _Out_ uint16* buf, _Inout_ uint32* size)',
  );
  let GetPackageFamilyName = null;
  try {
    GetPackageFamilyName = kernel32.func(
      'long __stdcall GetPackageFamilyName(void* h, _Inout_ uint32* len, _Out_ uint16* name)',
    );
  } catch {
    /* Windows 7/8 没有这个 API：包身份恒为空 */
  }
  const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
  const pathBuf = Buffer.alloc(32768 * 2);
  const pkgBuf = Buffer.alloc(1024 * 2);
  const titleBuf = Buffer.alloc(1024 * 2);
  const wstr = (buf, chars) => buf.toString('utf16le', 0, chars * 2);

  return {
    kind: 'koffi',
    read(opts = {}) {
      const hwnd = GetForegroundWindow();
      if (!hwnd) return null;
      const pidOut = [0];
      GetWindowThreadProcessId(hwnd, pidOut);
      const pid = pidOut[0];
      if (!pid) return null;
      let title;
      if (opts.withTitle) {
        const n = GetWindowTextW(hwnd, titleBuf, 1024);
        title = n > 0 ? wstr(titleBuf, n) : '';
      }
      const h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
      if (!h) return { pid, path: '', packageFamily: '', title, error: 'OpenProcess 失败（可能是管理员权限进程）' };
      try {
        const size = [32768];
        const ok = QueryFullProcessImageNameW(h, 0, pathBuf, size);
        const path = ok ? wstr(pathBuf, size[0]) : '';
        let packageFamily = '';
        if (GetPackageFamilyName) {
          const len = [1024];
          if (GetPackageFamilyName(h, len, pkgBuf) === 0 && len[0] > 0) {
            packageFamily = wstr(pkgBuf, len[0]).replace(/\0+$/, '');
          }
        }
        return { pid, path, packageFamily, title };
      } finally {
        CloseHandle(h);
      }
    },
    dispose() {},
  };
}

/** PowerShell 后备：常驻一个 powershell 子进程，每 intervalMs 打印一行 JSON */
function createPowerShellProvider(intervalMs, withTitle) {
  const cs = fs.readFileSync(path.join(__dirname, 'foreground-ps.cs'), 'utf8');
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "Add-Type -TypeDefinition @'\n" + cs + "\n'@",
    '[Console]::OutputEncoding = [Text.Encoding]::UTF8',
    'while ($true) {',
    '  $r = [AiPetFg]::Read($' + (withTitle ? 'true' : 'false') + ')',
    "  if ($r) { $o = [ordered]@{ pid = [int]$r[0]; path = $r[1]; packageFamily = $r[2]; title = $r[3] }; [Console]::Out.WriteLine(($o | ConvertTo-Json -Compress)) } else { [Console]::Out.WriteLine('null') }",
    '  [Console]::Out.Flush()',
    '  Start-Sleep -Milliseconds ' + Math.max(50, intervalMs | 0),
    '}',
  ].join('\n');
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], {
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let latest = null;
  let buf = '';
  let lastError = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buf += chunk;
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      try {
        latest = JSON.parse(line);
      } catch {
        /* 半行或乱码：跳过 */
      }
    }
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (d) => (lastError = String(d).slice(0, 500)));
  child.on('error', (e) => (lastError = String(e && e.message)));
  return {
    kind: 'powershell',
    read() {
      return latest;
    },
    get lastError() {
      return lastError;
    },
    dispose() {
      try {
        child.kill();
      } catch {
        /* ignore */
      }
    },
  };
}

/** mock：读 JSON 文件（{pid,path,packageFamily,title}），测试与非 Windows 平台用 */
function createMockProvider(file) {
  return {
    kind: 'mock',
    read() {
      if (!file) return null;
      try {
        return JSON.parse(fs.readFileSync(file, 'utf8'));
      } catch {
        return null;
      }
    },
    dispose() {},
  };
}

/**
 * 选一个可用的实现。返回 { provider, notes[] }（notes 记录为什么回退，调试窗口里能看到）。
 */
function createForegroundProvider({ intervalMs = 100, withTitle = false, log = () => {} } = {}) {
  const notes = [];
  const mockFile = process.env.AIPET_FOREGROUND_MOCK;
  if (mockFile) {
    notes.push('使用 mock 前台数据：' + mockFile);
    return { provider: createMockProvider(mockFile), notes };
  }
  if (process.platform !== 'win32') {
    notes.push('非 Windows 平台：没有前台窗口识别（只能手动锁定角色）。可用 AIPET_FOREGROUND_MOCK 模拟。');
    return { provider: createMockProvider(null), notes };
  }
  if (process.env.AIPET_FOREGROUND_PROVIDER !== 'powershell') {
    try {
      const p = createKoffiProvider();
      p.read();
      notes.push('使用 koffi 直接调用 Win32 API');
      return { provider: p, notes };
    } catch (e) {
      const msg = 'koffi 加载失败，改用 PowerShell 后备：' + (e && e.message ? e.message : String(e));
      notes.push(msg);
      log(msg);
    }
  }
  notes.push('使用 PowerShell 后备读取前台窗口');
  return { provider: createPowerShellProvider(intervalMs, withTitle), notes };
}

module.exports = { createForegroundProvider, createMockProvider };
