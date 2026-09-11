// ZCode-Expand：Directory Opus 接管「打开文件夹/资源管理器」入口（主进程注入模块）
// 注入位置：out/main/zcode-expand/zc-dopus.mjs，由 out/main/index.js 文件头的副作用 import 加载。
// 调用点（均为可选链调用，本模块缺失或返回 false 时走 ZCode 原逻辑）：
//   - m4（openPathViaShell）     → openInEditor('explorer') 的目录分支
//   - b4（openPathInFileManager）→ openInFileManager IPC
//   - v4 explorer 文件分支        → 原 explorer.exe /select,
// 对接结论来源：paseo 项目 handoff 20260911（/acmd 而非 /cmd、探测顺序、env 清理、退出码不可靠）
// + 本机实测 2026-09-11（Go 传文件完整路径 = 定位到所在目录并选中）。

import { spawn } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';

// Electron 主进程的环境变量会继承给子进程，剥掉控制类变量让 dopusrt 拿到干净环境
const ENV_KEYS_TO_STRIP = [
  'ELECTRON_RUN_AS_NODE',
  'ELECTRON_NO_ATTACH_CONSOLE',
  'ELECTRON_ENABLE_LOGGING',
  'NODE_OPTIONS',
];

function firstExisting(paths) {
  for (const p of paths) if (p && existsSync(p)) return p;
  return null;
}

function findOnPath(name) {
  for (const dir of (process.env.PATH || '').split(';')) {
    if (!dir) continue;
    const p = join(dir, name);
    if (existsSync(p)) return p;
  }
  return null;
}

// 探测顺序（对齐 paseo resolveOpusRuntime）：ProgramFiles → ProgramFiles(x86) → PATH；
// dopusrt.exe 优先（可复用已开 lister），dopus.exe 兜底（只能开新窗）。都没有返回 null。
function resolveOpusRuntime() {
  if (process.platform !== 'win32') return null;
  const dirs = [];
  if (process.env.ProgramFiles) dirs.push(join(process.env.ProgramFiles, 'GPSoftware', 'Directory Opus'));
  if (process.env['ProgramFiles(x86)']) dirs.push(join(process.env['ProgramFiles(x86)'], 'GPSoftware', 'Directory Opus'));
  const dopusrt = firstExisting([...dirs.map((d) => join(d, 'dopusrt.exe')), findOnPath('dopusrt.exe')]);
  if (dopusrt) return { exe: dopusrt, rt: true };
  const dopus = firstExisting([...dirs.map((d) => join(d, 'dopus.exe')), findOnPath('dopus.exe')]);
  if (dopus) return { exe: dopus, rt: false };
  return null;
}

function launchDetached(exe, args) {
  const env = { ...process.env };
  for (const key of ENV_KEYS_TO_STRIP) delete env[key];
  try {
    spawn(exe, args, { detached: true, stdio: 'ignore', windowsHide: true, env }).unref();
    return true;
  } catch {
    // dopusrt 对无效命令静默退出且退出码不可靠，这里只把 spawn 的同步异常当失败
    return false;
  }
}

// 用 Directory Opus 打开路径；返回 false 表示不接管（非 win32 / 未装 Opus / 路径不存在 / spawn 失败）。
// 路径原样传给 Go：目录 → 打开目录；文件 → Opus 定位到所在目录并选中（本机实测 2026-09-11）。
function tryOpenInOpus(p) {
  if (process.platform !== 'win32') return false;
  if (typeof p !== 'string' || !p.trim()) return false;
  const runtime = resolveOpusRuntime();
  if (!runtime) return false;
  try {
    // 仅存在性检查；不存在则返回 false 走原逻辑（由 ZCode 原有路径报错），避免 dopusrt 静默失败造成假成功
    statSync(p);
  } catch {
    return false;
  }
  return runtime.rt
    ? launchDetached(runtime.exe, ['/acmd', 'Go', p, 'NEWTAB=tofront'])
    : launchDetached(runtime.exe, [p]);
}

globalThis.__ZC_EXPAND_DOPUS__ = tryOpenInOpus;
