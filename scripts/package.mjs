#!/usr/bin/env node
// 组便携包：默认轻包（不含 asar，可公开分发）；--with-pristine 完整包（含原始 asar，仅本机留档，勿上传）
//
// 用法：
//   node scripts/package.mjs                    # dist/zcode-expand-<最新补丁集版本>.zip
//   node scripts/package.mjs --with-pristine    # dist/zcode-expand-<版本>-full.zip
//   node scripts/package.mjs --out=<目录>       # 默认 dist/

import { existsSync, mkdirSync, rmSync, cpSync, statSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseArgs, listPatchVersions, REPO_ROOT } from './lib/env.mjs';
import { sha256 } from './lib/asar.mjs';

const step = (msg) => console.log(`\n== ${msg}`);
const info = (msg) => console.log(`   ${msg}`);

/** 轻包内容清单：包内结构即仓库运行集（入口 + 脚本 + 全部补丁集 + 功能源码），单点维护 */
const CONTENTS = [
  'scripts',
  'patches',
  'src',
  'package.json',
  'apply.cmd',
  'restore.cmd',
  'verify.cmd',
  'README-PACKAGE.md',
];

// Git Bash 下 node 子进程按名找不到 powershell（已实证 ENOENT），必须绝对路径。
// 32 位进程的 System32 会被重定向到 SysWOW64，那里同样有 powershell.exe，不受影响。
const POWERSHELL = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';

function zipDir(stagingDir, zipPath) {
  if (process.platform === 'win32') {
    const r = spawnSync(
      POWERSHELL,
      ['-NoProfile', '-Command', `Compress-Archive -Path '${stagingDir}\\*' -DestinationPath '${zipPath}' -Force`],
      { stdio: 'inherit' }
    );
    if (r.status !== 0) throw new Error(`Compress-Archive 失败（退出码 ${r.status}）`);
  } else {
    // GitHub Actions ubuntu runner 与 macOS 均自带 zip
    const r = spawnSync('zip', ['-r', '-q', zipPath, '.'], { cwd: stagingDir, stdio: 'inherit' });
    if (r.status !== 0) throw new Error(`zip 失败（退出码 ${r.status}）`);
  }
}

async function main() {
  const args = parseArgs();
  const withPristine = !!args['with-pristine'];
  // 绝对化：zip 在 cwd=staging 下执行，相对路径的产物路径会被解析到 staging 内（Action 实测踩坑）
  const outDir = resolve(typeof args.out === 'string' ? args.out : join(REPO_ROOT, 'dist'));

  const versions = listPatchVersions();
  if (versions.length === 0) throw new Error('patches/ 下没有补丁集，无包可组。');
  // tag 名以最新适配的 ZCode 版本为锚；包内含全部已适配版本补丁集，按目标机器版本自动选择
  const latest = versions[versions.length - 1];

  step(`组包（${withPristine ? '完整包：含 pristine asar' : '轻包：不含 asar'}）`);
  const staging = join(outDir, `staging-${Date.now()}`);
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });
  for (const item of CONTENTS) {
    const src = join(REPO_ROOT, item);
    if (!existsSync(src)) throw new Error(`打包内容缺失：${item}`);
    cpSync(src, join(staging, item), { recursive: true });
  }
  if (withPristine) {
    const pv = join(REPO_ROOT, 'pristine', latest);
    if (!existsSync(join(pv, 'app.asar'))) {
      throw new Error(`pristine/${latest}/app.asar 不存在：完整包需先在本机采集 pristine（restore.mjs 自举或手工放入）。`);
    }
    mkdirSync(join(staging, 'pristine'), { recursive: true });
    cpSync(pv, join(staging, 'pristine', latest), { recursive: true });
  }

  step('压缩');
  const zipPath = join(outDir, `zcode-expand-${latest}${withPristine ? '-full' : ''}.zip`);
  zipDir(staging, zipPath);
  rmSync(staging, { recursive: true, force: true });

  info(`产物：${zipPath}`);
  info(`大小：${statSync(zipPath).size.toLocaleString()} 字节`);
  info(`SHA256：${sha256(readFileSync(zipPath))}`);
  if (withPristine) {
    console.log('\n注意：完整包含 ZCode 原始 app.asar，仅限本机留档，勿上传或分发。');
  }
}

main().catch((err) => {
  console.error(`\n失败：${err.message}`);
  process.exitCode = 1;
});
