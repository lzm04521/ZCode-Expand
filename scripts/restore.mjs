#!/usr/bin/env node
// 还原 pristine：把干净的原始 app.asar 恢复到 ZCode 安装目录
//
// 设计要点：
// - pristine 是唯一还原真源（pristine/<版本>/app.asar + manifest.json），git 忽略、绝不入库
// - 首次运行若本机是干净安装（锚点未应用且无注入文件），自动采集为 pristine（自举）
// - 三方版本校验：本机 asar ↔ pristine ↔ 补丁集 manifest 的 appVersion + buildCommitId 必须一致
//   （同版本不同构建的 chunk 内容不同，锚点必然失配，必须拦截）
// - 还原是确定性操作：被覆盖的"上次 apply 产物"可随时由 restore → apply 重建，故不留留存。
//   区别于 rollback：它覆盖的状态可能不可重建，所以留 pre-rollback 留存；
//   且 rollback.mjs 的备份挑选只排除 .pre-rollback-，若此处引入 pre-restore 留存会被它
//   误当"apply 原始备份"选中，语义反转，故刻意不放 backups/。
//
// 用法：
//   node scripts/restore.mjs              # 还原 pristine 到安装目录（无 pristine 时自动采集）
//   node scripts/restore.mjs --check      # 只检查状态，不写任何文件
//   node scripts/restore.mjs --home=<目录>

import { existsSync, mkdirSync, copyFileSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import {
  parseArgs,
  resolveInstallDir,
  installPaths,
  readInstallInfo,
  assertTargetNotLocked,
  stateDir,
  REPO_ROOT,
} from './lib/env.mjs';
import { openAsar, closeAsar, readEntry, sha256 } from './lib/asar.mjs';
import { loadPatchSet, inspectPatchState } from './lib/patch.mjs';

const step = (msg) => console.log(`\n== ${msg}`);
const info = (msg) => console.log(`   ${msg}`);

/** pristine 根目录（.gitignore 忽略，体积大绝不入库） */
const pristineRoot = () => join(REPO_ROOT, 'pristine');

function pristinePaths(version) {
  const dir = join(pristineRoot(), version);
  return { dir, asar: join(dir, 'app.asar'), manifest: join(dir, 'manifest.json') };
}

/** 读 asar 内构建元数据：build-meta.json 不在补丁 targets 内，已打补丁的 asar 也能读出真实版本 */
function readBuildMeta(asarPath) {
  const asar = openAsar(asarPath);
  try {
    return JSON.parse(readEntry(asar, 'out/metadata/build-meta.json').toString('utf8'));
  } finally {
    closeAsar(asar);
  }
}

/** 本机 asar 是否干净（可作为 pristine 采集源）：锚点未应用且注入文件不存在 */
function probeCleanInstall(asarPath, patchSet) {
  const state = inspectPatchState(asarPath, patchSet);
  const counts = state.results.reduce((acc, r) => {
    acc[r.state] = (acc[r.state] ?? 0) + 1;
    return acc;
  }, {});
  const injected = state.addFiles.filter((a) => a.present).length;
  return {
    clean: state.results.every((r) => r.state === 'not-applied') && injected === 0,
    counts,
    injected,
  };
}

/** 三方一致性：本机 / pristine / 补丁集 manifest */
function assertVersionTriangle(install, pristineMeta, patchSet) {
  const problems = [];
  if (pristineMeta.appVersion !== install.appVersion) {
    problems.push(`pristine(${pristineMeta.appVersion}) ≠ 本机(${install.appVersion})`);
  }
  if (pristineMeta.buildCommitId !== install.buildCommitId) {
    problems.push(`pristine 构建(${pristineMeta.buildCommitId}) ≠ 本机构建(${install.buildCommitId})`);
  }
  const m = patchSet.manifest;
  if (m.appVersion !== install.appVersion) {
    problems.push(`补丁集(${m.appVersion}) ≠ 本机(${install.appVersion})`);
  }
  if (m.buildCommitId !== install.buildCommitId) {
    problems.push(`补丁集构建(${m.buildCommitId}) ≠ 本机构建(${install.buildCommitId})`);
  }
  if (problems.length > 0) {
    throw new Error(
      `三方版本校验未通过：\n  - ${problems.join('\n  - ')}\n` +
        `同版本不同构建的 asar 内容不同，锚点必然失配。\n` +
        `请按 docs/03-版本适配流程.md 为当前构建新建补丁集，或安装与补丁集一致的 ZCode 版本。`
    );
  }
}

/** 采集本机干净 asar 为 pristine，并写完整性清单 */
function capturePristine(p, pp, install) {
  mkdirSync(pp.dir, { recursive: true });
  copyFileSync(p.asar, pp.asar);
  const buf = readFileSync(pp.asar);
  writeFileSync(
    pp.manifest,
    JSON.stringify(
      {
        appVersion: install.appVersion,
        buildCommitId: install.buildCommitId,
        buildTime: install.buildTime,
        size: buf.length,
        sha256: sha256(buf),
        capturedAt: new Date().toISOString(),
        source: 'clean-install-capture',
      },
      null,
      2
    ) + '\n',
    'utf8'
  );
  info(`已采集：${pp.asar}`);
  info(`大小：${buf.length.toLocaleString()} 字节`);
  info(`SHA256：${sha256(buf)}`);
}

async function main() {
  const args = parseArgs();
  const checkOnly = !!args.check;

  const installDir = resolveInstallDir(args);
  const p = installPaths(installDir);
  const install = readInstallInfo(installDir);

  step('环境检查');
  info(`安装目录：${installDir}`);
  info(`应用版本：${install.appVersion}（构建 ${install.buildCommitId}）`);

  const patchSet = loadPatchSet(install.appVersion);
  const pp = pristinePaths(install.appVersion);

  if (!existsSync(pp.asar)) {
    step('pristine 不存在，尝试自举采集');
    const probe = probeCleanInstall(p.asar, patchSet);
    if (!probe.clean) {
      throw new Error(
        `本机不是干净安装，无法采集 pristine：${JSON.stringify(probe.counts)}，已注入 ${probe.injected} 个文件。\n` +
          `请先恢复原始 asar（重装 ZCode，或从留档拷贝到 ${pp.asar}）再试。`
      );
    }
    if (checkOnly) {
      info(`本机是干净安装，可采集为 pristine/${install.appVersion}/app.asar`);
      console.log('\n--check 通过：下次执行还原时将自动采集。');
      return;
    }
    capturePristine(p, pp, install);
  }

  step('pristine 校验');
  const buf = readFileSync(pp.asar);
  const pristineBuild = readBuildMeta(pp.asar);
  let meta;
  if (!existsSync(pp.manifest)) {
    // 手工放入的 pristine（重装 ZCode 后从留档拷贝等）：没有权威清单可对照，只能登记现状，
    // 此后校验以本清单为准；版本正确性仍由下方三方校验把关
    meta = {
      appVersion: pristineBuild.appVersion,
      buildCommitId: pristineBuild.buildCommitId,
      buildTime: pristineBuild.buildTime,
      size: buf.length,
      sha256: sha256(buf),
      registeredAt: new Date().toISOString(),
      source: 'manual-register',
    };
    writeFileSync(pp.manifest, JSON.stringify(meta, null, 2) + '\n', 'utf8');
    info('未找到 manifest.json，已按当前内容登记完整性清单（首次登记）');
  } else {
    meta = JSON.parse(readFileSync(pp.manifest, 'utf8'));
  }
  const actual = sha256(buf);
  if (actual !== meta.sha256) {
    throw new Error(
      `pristine SHA256 不一致：\n  记录 ${meta.sha256}\n  实际 ${actual}\n` +
        `pristine 可能损坏，请删除后重新采集（干净安装）或从留档恢复。`
    );
  }
  assertVersionTriangle(install, pristineBuild, patchSet);
  info(`SHA256 一致：${actual.slice(0, 16)}…`);
  info(`三方版本一致：${install.appVersion} / 构建 ${install.buildCommitId}`);

  if (checkOnly) {
    console.log('\n--check 通过：可以执行还原。');
    return;
  }

  step('进程检查');
  const lock = assertTargetNotLocked(installDir);
  if (!lock.running) {
    info('ZCode 未运行，可以写入');
  } else {
    info('目标目录下的实例未运行，其它位置的实例不影响本次写入');
  }

  step('还原');
  copyFileSync(pp.asar, p.asar);
  info(`已还原：${p.asar}`);
  info(`SHA256：${actual}`);

  // 还原后 apply 状态记录失效：当前 asar 已不是 apply 产物，留着会误报"已应用"（同 rollback.mjs 语义）
  const stateFile = join(stateDir(), `applied-${install.appVersion}.json`);
  if (existsSync(stateFile)) {
    unlinkSync(stateFile);
    info(`已清理应用状态记录：${stateFile}`);
  }

  console.log('\n还原完成。继续运行 apply.cmd 应用补丁，或保持原始状态。');
}

main().catch((err) => {
  console.error(`\n失败：${err.message}`);
  process.exitCode = 1;
});
