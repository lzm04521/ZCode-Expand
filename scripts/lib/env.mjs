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
 * 判断 ZCode.exe 是否在运行。
 * 判定失败时抛出而不是当作“未运行”，避免在占用状态下误写。
 */
export function assertZCodeNotRunning() {
  let out;
  try {
    out = execFileSync('tasklist', ['/FI', 'IMAGENAME eq ZCode.exe', '/NH'], {
      encoding: 'utf8',
      windowsHide: true,
    });
  } catch (err) {
    throw new Error(`无法确认 ZCode 进程状态（tasklist 调用失败）：${err.message}`);
  }
  if (/ZCode\.exe/i.test(out)) {
    throw new Error('ZCode 正在运行。请先完全退出（含托盘），再执行本操作。');
  }
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
