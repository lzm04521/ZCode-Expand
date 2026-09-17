// 环境定位：安装目录、版本、进程状态、补丁集查找
import { existsSync, readdirSync, statSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { openAsar, readEntry, closeAsar } from './asar.mjs';

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

export function parseArgs(argv = process.argv.slice(2)) {
  const out = { _: [] };
  for (const arg of argv) {
    const m = /^--([^=]+)(?:=(.*))?$/.exec(arg);
    if (m) out[m[1]] = m[2] === undefined ? true : m[2];
    else out._.push(arg);
  }
  return out;
}

/** 目录是否像一个 ZCode 安装（resources\app.asar 在位），检测链各级共用 */
const looksLikeInstall = (dir) => !!dir && existsSync(join(dir, 'resources', 'app.asar'));

/** 快捷方式搜索根：用户/全机开始菜单 + 用户/公共桌面（ZCode 不写注册表，lnk 是唯一可靠发现渠道，见 doc/20260917-实施计划-安装目录自动检测.md） */
function shortcutRoots() {
  return [
    join(process.env.APPDATA ?? '', 'Microsoft', 'Windows', 'Start Menu', 'Programs'),
    join(process.env.ProgramData ?? '', 'Microsoft', 'Windows', 'Start Menu', 'Programs'),
    join(process.env.USERPROFILE ?? '', 'Desktop'),
    join(process.env.PUBLIC ?? '', 'Desktop'),
  ].filter((d) => d && existsSync(d));
}

/** 递归查找 ZCode.lnk（严格匹配文件名，避免误匹配其它应用；限深 4 层防异常深树） */
function findShortcuts(roots) {
  const hits = [];
  const walk = (dir, depth) => {
    if (depth > 4) return;
    let names;
    try {
      names = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of names) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p, depth + 1);
      else if (e.name.toLowerCase() === 'zcode.lnk') hits.push(p);
    }
  };
  for (const r of roots) walk(r, 0);
  return hits;
}

/** PowerShell COM 解析 .lnk 的 TargetPath（与 listZCodeProcessPaths 同为 spawn powershell 的既有模式）；异常/空值返回 null */
function resolveShortcutTarget(lnkPath) {
  try {
    const out = execFileSync(
      'powershell',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `(New-Object -ComObject WScript.Shell).CreateShortcut('${lnkPath.replaceAll("'", "''")}').TargetPath`,
      ],
      { encoding: 'utf8', windowsHide: true }
    ).trim();
    return out || null;
  } catch {
    return null;
  }
}

/** 从快捷方式解析安装目录候选（去重；只保留 app.asar 在位的） */
export function detectInstallFromShortcuts() {
  const dirs = [];
  for (const lnk of findShortcuts(shortcutRoots())) {
    const target = resolveShortcutTarget(lnk);
    if (!target) continue;
    const dir = dirname(target);
    if (looksLikeInstall(dir) && !dirs.some((d) => d.toLowerCase() === dir.toLowerCase())) dirs.push(dir);
  }
  return dirs;
}

/** 上次成功解析的安装目录记忆（state/ 已 git 忽略；失效时检测链自动重新发现） */
function readInstallDirMemo() {
  try {
    return JSON.parse(readFileSync(join(stateDir(), 'install-dir.json'), 'utf8')).installDir ?? null;
  } catch {
    return null;
  }
}

function writeInstallDirMemo(dir) {
  try {
    mkdirSync(stateDir(), { recursive: true });
    writeFileSync(
      join(stateDir(), 'install-dir.json'),
      JSON.stringify({ installDir: dir, recordedAt: new Date().toISOString() }, null, 2) + '\n',
      'utf8'
    );
  } catch {
    // 记忆失败不阻塞主流程，下次重新检测即可
  }
}

/**
 * 定位 ZCode 安装目录。优先级：--home > ZCODE_HOME > 默认路径 > state 记忆 > 快捷方式解析。
 * 命中即写记忆；多候选不猜，列出让用户 --home 指定。
 */
export function resolveInstallDir(args = {}) {
  const explicit = args.home || process.env.ZCODE_HOME;
  if (explicit) {
    if (!looksLikeInstall(explicit)) {
      throw new Error(`指定的安装目录下未找到 resources/app.asar：${explicit}`);
    }
    writeInstallDirMemo(explicit);
    return explicit;
  }
  const def = join(process.env.LOCALAPPDATA ?? '', 'Programs', 'ZCode');
  if (looksLikeInstall(def)) {
    writeInstallDirMemo(def);
    return def;
  }
  const memo = readInstallDirMemo();
  if (looksLikeInstall(memo)) return memo;
  const candidates = detectInstallFromShortcuts();
  if (candidates.length === 1) {
    writeInstallDirMemo(candidates[0]);
    return candidates[0];
  }
  if (candidates.length > 1) {
    throw new Error(`发现多个 ZCode 安装：\n  - ${candidates.join('\n  - ')}\n请用 --home=<目录> 指定。`);
  }
  throw new Error(
    `未找到 ZCode 安装目录（已尝试：--home / ZCODE_HOME / 默认 ${def || '(LOCALAPPDATA 未设置)'} / state 记忆 / 开始菜单与桌面快捷方式）。\n` +
      `请用 --home=<目录> 指定，或设置 ZCODE_HOME 环境变量。`
  );
}

export function installPaths(installDir) {
  return {
    installDir,
    resources: join(installDir, 'resources'),
    asar: join(installDir, 'resources', 'app.asar'),
    unpacked: join(installDir, 'resources', 'app.asar.unpacked'),
  };
}

export function readInstallInfo(installDir) {
  const p = installPaths(installDir);
  const asar = openAsar(p.asar);
  try {
    const meta = JSON.parse(readEntry(asar, 'out/metadata/build-meta.json').toString('utf8'));
    return {
      ...p,
      asarSize: asar.size,
      entryCount: null,
      appVersion: meta.appVersion,
      buildCommitId: meta.buildCommitId,
      buildTime: meta.buildTime,
      electronBuilderVersion: meta.electronBuilderVersion,
    };
  } finally {
    closeAsar(asar);
  }
}

/**
 * 列出正在运行的 ZCode 进程及其可执行文件路径。
 * 用于判断"运行中的实例是否会锁住我们要写的 app.asar"。
 * @returns {{ok: boolean, paths: string[], error?: string}}
 */
export function listZCodeProcessPaths() {
  let out;
  try {
    out = execFileSync(
      'powershell',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        "Get-Process -Name ZCode -ErrorAction SilentlyContinue | ForEach-Object { $_.Path }",
      ],
      { encoding: 'utf8', windowsHide: true }
    );
  } catch (err) {
    // Windows PowerShell 5.1：Get-Process 找不到进程时，即使 SilentlyContinue
    // 抑制了报错，-Command 的退出码仍为 1（error record 使 $? 为 False）。
    // 这是"无进程"的正常路径，不是调用失败，必须放行。
    if (err.status === 1 && err.stdout === '' && !err.stderr) {
      return { ok: true, paths: [] };
    }
    return { ok: false, paths: [], error: err.message };
  }
  const paths = out
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
  return { ok: true, paths };
}

/**
 * 确认目标安装目录没有被运行中的实例占用。
 * 判定不清时抛错（保守），不把"无法确认"当作"没占用"。
 */
export function assertTargetNotLocked(installDir) {
  const probe = listZCodeProcessPaths();
  if (!probe.ok) {
    throw new Error(
      `无法确认 ZCode 进程状态（PowerShell 调用失败）：${probe.error}\n` +
        `请手动确认 ZCode 已退出后重试。`
    );
  }
  if (probe.paths.length === 0) return { running: false, others: [] };

  const target = resolve(join(installDir, 'ZCode.exe')).toLowerCase();
  const locking = probe.paths.filter((pr) => resolve(pr).toLowerCase() === target);
  if (locking.length > 0) {
    throw new Error(
      `目标安装目录下的 ZCode 正在运行：${installDir}\n` +
        `请先完全退出（含托盘），再执行本操作。运行中 app.asar 被占用，替换会失败。`
    );
  }
  // 有别的实例在跑，但不是要改的这个目录（例如对副本/离线包操作）
  return { running: true, others: probe.paths };
}

export function listPatchVersions() {
  const dir = join(REPO_ROOT, 'patches');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((n) => statSync(join(dir, n)).isDirectory())
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
}

export function patchSetDir(version) {
  const dir = join(REPO_ROOT, 'patches', version);
  if (!existsSync(dir)) {
    throw new Error(`不存在版本 ${version} 的补丁集：${dir}\n可用版本：${listPatchVersions().join(', ') || '(无)'}`);
  }
  return dir;
}

export const stateDir = () => join(REPO_ROOT, 'state');
export const backupDir = () => join(REPO_ROOT, 'backups');

/** 备份文件名的本地时间戳（yyyyMMdd-HHmmss），apply 备份与 rollback 留存共用同一格式 */
export function timestamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}
