#!/usr/bin/env node
// 总览：安装信息、可用补丁集、当前补丁状态、备份情况
//
// 用法：node scripts/inspect.mjs [--home=<目录>]

import { existsSync, readdirSync, statSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { parseArgs, resolveInstallDir, listPatchVersions, backupDir, stateDir, REPO_ROOT } from './lib/env.mjs';
import { openAsar, closeAsar, listEntries, readEntry } from './lib/asar.mjs';
import { loadPatchSet, inspectPatchState } from './lib/patch.mjs';

function zcodeRunning() {
  try {
    const out = execFileSync('tasklist', ['/FI', 'IMAGENAME eq ZCode.exe', '/NH'], {
      encoding: 'utf8',
      windowsHide: true,
    });
    return /ZCode\.exe/i.test(out);
  } catch {
    return null;
  }
}

function readBytes(path) {
  return statSync(path).size;
}

async function main() {
  const args = parseArgs();
  console.log('=== ZCode-Expand 总览 ===');
  console.log(`仓库：${REPO_ROOT}`);

  let installDir = null;
  try {
    installDir = resolveInstallDir(args);
  } catch (err) {
    console.log(`\n[安装] ${err.message}`);
  }

  if (installDir) {
    const asarPath = join(installDir, 'resources', 'app.asar');
    const asar = openAsar(asarPath);
    try {
      const meta = JSON.parse(readEntry(asar, 'out/metadata/build-meta.json').toString('utf8'));
      const entries = listEntries(asar);
      console.log('\n[安装]');
      console.log(`  目录：${installDir}`);
      console.log(`  版本：${meta.appVersion}  构建：${meta.buildCommitId}  ${meta.buildTime}`);
      console.log(`  asar：${readBytes(asarPath).toLocaleString()} 字节，${entries.length} 个条目`);
    } finally {
      closeAsar(asar);
    }

    const running = zcodeRunning();
    console.log(`  进程：${running === null ? '无法判定（tasklist 调用失败）' : running ? '运行中（写入前需退出）' : '未运行'}`);
  }

  console.log('\n[补丁集]');
  const versions = listPatchVersions();
  if (versions.length === 0) console.log('  （无）');
  for (const v of versions) {
    let line = `  ${v}`;
    try {
      const set = loadPatchSet(v);
      line += `  ${set.patches.targets.length} 个文件 / ${set.patches.addFiles?.length ?? 0} 个新增文件`;
      line += `  构建 ${set.manifest.buildCommitId}`;
    } catch (err) {
      line += `  [读取失败] ${err.message}`;
    }
    console.log(line);
  }

  if (installDir) {
    const asarPath = join(installDir, 'resources', 'app.asar');
    const asar = openAsar(asarPath);
    let appVersion;
    try {
      appVersion = JSON.parse(readEntry(asar, 'out/metadata/build-meta.json').toString('utf8')).appVersion;
    } finally {
      closeAsar(asar);
    }
    const set = versions.includes(appVersion) ? loadPatchSet(appVersion) : null;
    console.log(`\n[当前补丁状态]（对照补丁集 ${appVersion}）`);
    if (!set) {
      console.log(`  没有与安装版本 ${appVersion} 匹配的补丁集，需按 docs/03-版本适配流程.md 新建。`);
    } else {
      const state = inspectPatchState(asarPath, set);
      const counts = state.results.reduce((acc, r) => {
        acc[r.state] = (acc[r.state] ?? 0) + 1;
        return acc;
      }, {});
      console.log(`  包内目标：${JSON.stringify(counts)}`);
      const missing = state.addFiles.filter((f) => !f.present);
      console.log(`  新增文件：${state.addFiles.length - missing.length}/${state.addFiles.length} 已注入`);
    }
  }

  console.log('\n[备份]');
  const dir = backupDir();
  const backups = existsSync(dir)
    ? readdirSync(dir)
        .filter((n) => n.startsWith('app.asar.'))
        .sort()
    : [];
  if (backups.length === 0) console.log('  （无）');
  for (const b of backups.slice(-8)) {
    console.log(`  ${b}\t${readBytes(join(dir, b)).toLocaleString()} 字节`);
  }
  if (backups.length > 8) console.log(`  ... 共 ${backups.length} 个`);

  console.log('\n[最近应用记录]');
  const sdir = stateDir();
  const applied = existsSync(sdir)
    ? readdirSync(sdir).filter((n) => n.startsWith('applied-'))
    : [];
  if (applied.length === 0) console.log('  （无）');
  for (const f of applied) {
    const data = JSON.parse(readFileSync(join(sdir, f), 'utf8'));
    console.log(`  ${f}\t${data.appliedAt}\t改动 ${data.changedPaths.length} 个文件\t备份 ${data.backup}`);
  }
}

main().catch((err) => {
  console.error(`\n失败：${err.message}`);
  process.exitCode = 1;
});
