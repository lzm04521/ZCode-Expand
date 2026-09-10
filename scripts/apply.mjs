#!/usr/bin/env node
// 应用补丁：把补丁集打到已安装的 app.asar 上
//
// 用法：
//   node scripts/apply.mjs [--patch=3.11.2] [--home=<ZCode安装目录>] [--dry-run] [--output=<文件>]
//
// 行为：
//   1. 校验安装目录、版本、补丁集一致
//   2. 要求 ZCode 已退出（运行中会占用 app.asar）
//   3. 备份原 app.asar 到 backups/
//   4. 重建 asar 并逐条自检，通过后才替换
//
// 任何一步不通过都不会改动安装目录。

import { existsSync, mkdirSync, copyFileSync, renameSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  parseArgs,
  resolveInstallDir,
  installPaths,
  readInstallInfo,
  assertZCodeNotRunning,
  listPatchVersions,
  backupDir,
  stateDir,
} from './lib/env.mjs';
import { loadPatchSet, buildReplacements, loadAddedFiles } from './lib/patch.mjs';
import {
  openAsar,
  closeAsar,
  selfCheck,
  holderFromOpenAsar,
  writeRepacked,
  sha256,
  readEntry,
  findEntry,
} from './lib/asar.mjs';
import { checkJavaScript } from './lib/syntaxcheck.mjs';

function timestamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function step(msg) {
  console.log(`\n== ${msg}`);
}

function info(msg) {
  console.log(`   ${msg}`);
}

async function main() {
  const args = parseArgs();
  const dryRun = !!args['dry-run'];
  const installDir = resolveInstallDir(args);
  const p = installPaths(installDir);

  step('环境检查');
  const install = readInstallInfo(installDir);
  info(`安装目录：${install.installDir}`);
  info(`应用版本：${install.appVersion}（构建 ${install.buildCommitId} / ${install.buildTime}）`);
  info(`asar 大小：${install.asarSize.toLocaleString()} 字节`);

  const patchVersion = typeof args.patch === 'string' ? args.patch : install.appVersion;
  const patchSet = loadPatchSet(patchVersion);
  info(`补丁集：${patchVersion}（${patchSet.patches.targets.length} 个文件 / ${patchSet.patches.addFiles?.length ?? 0} 个新增文件）`);

  if (patchSet.manifest.appVersion !== install.appVersion) {
    throw new Error(
      `补丁集面向 ${patchSet.manifest.appVersion}，当前安装的是 ${install.appVersion}。\n` +
        `可用补丁集：${listPatchVersions().join(', ')}\n` +
        `升级后请按 docs/03-版本适配流程.md 新建对应版本的补丁集。`
    );
  }

  if (!dryRun) {
    step('进程检查');
    assertZCodeNotRunning();
    info('ZCode 未运行，可以写入');
  } else {
    step('进程检查（dry-run 跳过）');
  }

  const asar = openAsar(p.asar);
  let result;
  try {
    step('生成补丁内容');
    const { replace, report } = buildReplacements(asar, patchSet);
    for (const r of report) {
      const applied = r.edits.filter((e) => e.status === 'applied').length;
      const skipped = r.edits.filter((e) => e.status === 'already-applied').length;
      info(`${r.file}：应用 ${applied} 项${skipped ? `，跳过已应用 ${skipped} 项` : ''}`);
    }

    const add = loadAddedFiles(patchSet);
    const addEffective = new Map();
    for (const [path, buf] of add) {
      const existing = findEntry(asar.header, path);
      if (!existing) {
        addEffective.set(path, buf);
        info(`新增：${path}（${buf.length} 字节）`);
        continue;
      }
      const current = readEntry(asar, path);
      if (current.equals(buf)) info(`新增文件内容一致，无需更新：${path}`);
      else {
        // 已有该文件但内容不同（例如改过 src 后重新 apply）→ 作为替换处理
        throw new Error(
          `目标路径已存在且内容不同：${path}\n` +
            `说明：该文件此前已被写入 asar，无法直接覆盖。请先 rollback 到原始 app.asar，再重新 apply。`
        );
      }
    }

    if (replace.size === 0 && addEffective.size === 0) {
      console.log('\n补丁已全部就位，未做任何改动。');
      return;
    }

    step('语法门禁（node --check）');
    const syntax = checkJavaScript(new Map([...replace, ...addEffective]));
    info(`已检查 ${syntax.checked} 个 JS 文件`);
    if (syntax.failures.length > 0) {
      throw new Error(
        `补丁后的 JS 语法未通过，已中止且未写入任何文件：\n` +
          syntax.failures
            .map((f) => `  - ${f.path}\n    ${f.message.split('\n').slice(0, 4).join('\n    ')}`)
            .join('\n')
      );
    }
    info('语法检查通过');

    step('重建 asar');
    const outFile = dryRun ? join(process.cwd(), 'app.asar.dryrun') : `${p.asar}.zcexpand.tmp`;
    const writeSummary = writeRepacked(asar, { replace, add: addEffective }, outFile);
    info(`产物大小：${writeSummary.bytesWritten.toLocaleString()} 字节`);
    info(`数据区起始：${writeSummary.dataStart.toLocaleString()}`);

    step('自检（逐条比对未改动文件 / 核对改动文件 integrity）');
    const produced = openAsar(outFile);
    let check;
    try {
      check = selfCheck(holderFromOpenAsar(asar), holderFromOpenAsar(produced), writeSummary.changed);
    } finally {
      closeAsar(produced);
    }
    info(`逐字节校验未改动文件：${check.checked} 个`);
    info(`核对改动文件：${check.changedSeen} 个`);
    if (check.mismatches.length > 0) {
      throw new Error(
        `自检未通过，共 ${check.mismatches.length} 处异常，已中止且未替换安装目录文件：\n` +
          check.mismatches.slice(0, 20).map((m) => `  - ${m}`).join('\n')
      );
    }
    info('自检通过');
    result = { replace, add: addEffective, writeSummary, outFile };
  } finally {
    closeAsar(asar);
  }

  if (dryRun) {
    console.log(`\ndry-run 完成，产物在：${result.outFile}`);
    console.log('（安装目录未被改动；确认无误后去掉 --dry-run 重跑）');
    return;
  }

  if (typeof args.output === 'string') {
    copyFileSync(result.outFile, args.output);
    console.log(`\n已输出到：${args.output}（安装目录未改动）`);
    return;
  }

  step('备份并替换');
  mkdirSync(backupDir(), { recursive: true });
  mkdirSync(stateDir(), { recursive: true });
  const backupName = `app.asar.${install.appVersion}.${timestamp()}`;
  const backupPath = join(backupDir(), backupName);
  copyFileSync(p.asar, backupPath);
  info(`已备份：${backupPath}`);

  renameSync(result.outFile, p.asar);
  const newHash = sha256(readFileSync(p.asar));
  info(`已替换：${p.asar}`);
  info(`新 asar SHA256：${newHash}`);

  const stateFile = join(stateDir(), `applied-${install.appVersion}.json`);
  writeFileSync(
    stateFile,
    JSON.stringify(
      {
        appVersion: install.appVersion,
        buildCommitId: install.buildCommitId,
        patchVersion,
        appliedAt: new Date().toISOString(),
        backup: backupName,
        asarSha256: newHash,
        changedPaths: [...result.replace.keys(), ...result.add.keys()],
      },
      null,
      2
    ) + '\n',
    'utf8'
  );
  info(`状态记录：${stateFile}`);

  console.log('\n完成。重新启动 ZCode 后生效。');
  console.log('回滚：node scripts/rollback.mjs');
}

main().catch((err) => {
  console.error(`\n失败：${err.message}`);
  process.exitCode = 1;
});
