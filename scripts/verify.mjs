#!/usr/bin/env node
// 校验当前安装状态：补丁锚点是否就位、是否已应用、新增文件是否存在
//
// 用法：node scripts/verify.mjs [--patch=3.11.2] [--home=<目录>]
// 退出码：0 全部一致；1 存在不匹配（需要适配新版本）

import { parseArgs, resolveInstallDir, installPaths, readInstallInfo, listPatchVersions, REPO_ROOT } from './lib/env.mjs';
import { loadPatchSet, inspectPatchState } from './lib/patch.mjs';
import { join } from 'node:path';
import { existsSync } from 'node:fs';

const STATUS_TEXT = {
  applied: '已应用',
  'not-applied': '未应用（锚点就位，可直接 apply）',
  'anchor-mismatch': '锚点失配（需适配）',
  'file-missing': '目标文件不存在（需适配）',
};

async function main() {
  const args = parseArgs();
  const installDir = resolveInstallDir(args);
  const p = installPaths(installDir);
  const install = readInstallInfo(installDir);

  console.log(`安装目录：${install.installDir}`);
  console.log(`应用版本：${install.appVersion}（构建 ${install.buildCommitId}）`);

  const patchVersion = typeof args.patch === 'string' ? args.patch : install.appVersion;
  let patchSet;
  try {
    patchSet = loadPatchSet(patchVersion);
  } catch (err) {
    console.log(`\n未找到版本 ${patchVersion} 的补丁集。`);
    console.log(`可用补丁集：${listPatchVersions().join(', ') || '(无)'}`);
    console.log('\n需要按 docs/03-版本适配流程.md 为新版本建立补丁集。');
    process.exitCode = 1;
    return;
  }
  console.log(`补丁集：${patchVersion}`);

  const state = inspectPatchState(p.asar, patchSet);

  let bad = 0;
  let pending = 0;
  console.log('\n[包内补丁]');
  for (const r of state.results) {
    const text = STATUS_TEXT[r.state] ?? r.state;
    if (r.state === 'anchor-mismatch' || r.state === 'file-missing') bad += 1;
    if (r.state === 'not-applied') pending += 1;
    console.log(`  ${text.padEnd(24, ' ')} ${r.file}`);
    if (r.description) console.log(`      ${r.description}`);
    for (const e of r.edits) {
      const mark = e.applied ? '已应用' : e.anchorCount === e.expect ? '锚点OK' : `锚点${e.anchorCount}≠${e.expect}`;
      console.log(`      #${e.index} ${mark}${e.note ? ` — ${e.note}` : ''}`);
    }
  }

  console.log('\n[新增文件]');
  for (const f of state.addFiles) {
    if (!f.present) pending += 1;
    console.log(`  ${f.present ? '已存在' : '未注入'}\t${f.to}`);
  }

  console.log('\n[仓库侧源文件]');
  for (const item of patchSet.patches.addFiles ?? []) {
    const src = join(REPO_ROOT, item.from);
    console.log(`  ${existsSync(src) ? '存在' : '缺失'}\t${item.from}`);
  }

  console.log('\n小结：');
  if (bad > 0) {
    console.log(`  ${bad} 个目标锚点失配或文件缺失 —— 该补丁集不适配当前版本，需重新定位锚点。`);
    process.exitCode = 1;
  } else if (pending > 0) {
    console.log(`  锚点全部就位，${pending} 项待应用 —— 可执行 node scripts/apply.mjs`);
  } else {
    console.log('  补丁已全部应用且锚点一致。');
  }
}

main().catch((err) => {
  console.error(`\n失败：${err.message}`);
  process.exitCode = 1;
});
