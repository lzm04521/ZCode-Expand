// 环境定位：安装目录、版本、进程状态、补丁集查找
import { existsSync, readdirSync, statSync } from 'node:fs';
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

export function resolveInstallDir(args = {}) {
  const dir =
    args.home ||
    process.env.ZCODE_HOME ||
    join(process.env.LOCALAPPDATA ?? '', 'Programs', 'ZCode');
  if (!dir) throw new Error('无法确定 ZCode 安装目录：请用 --home=<路径> 或设置 ZCODE_HOME');
  if (!existsSync(join(dir, 'resources', 'app.asar'))) {
    throw new Error(`安装目录下未找到 resources/app.asar：${dir}`);
  }
  return dir;
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
