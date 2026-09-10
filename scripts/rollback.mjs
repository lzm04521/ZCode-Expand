#!/usr/bin/env node
// 回滚：从 backups/ 恢复指定（默认最近一次）的原始 app.asar
//
// 用法：
//   node scripts/rollback.mjs                 # 恢复最近一次备份
//   node scripts/rollback.mjs --list          # 只看备份列表
//   node scripts/rollback.mjs --from=<文件>   # 恢复指定备份
//   node scripts/rollback.mjs --home=<目录>

import { existsSync, readdirSync, statSync, copyFileSync, mkdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import {
  parseArgs,
  resolveInstallDir,
  installPaths,
  readInstallInfo,
  assertTargetNotLocked,
  backupDir,
  stateDir,
  timestamp,
} from './lib/env.mjs';
import { sha256 } from './lib/asar.mjs';
import { readFileSync } from 'node:fs';

/** pre-rollback 留存是“回滚前状态”（通常已打补丁），不是 apply 时留下的原始备份。 */
function isPreRollback(name) {
  return name.includes('.pre-rollback-');
}

function listBackups() {
  const dir = backupDir();
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((n) => n.startsWith('app.asar.'))
    .map((n) => ({ name: n, path: join(dir, n), mtime: statSync(join(dir, n)).mtimeMs, size: statSync(join(dir, n)).size }))
    .sort((a, b) => b.mtime - a.mtime);
}

async function main() {
  const args = parseArgs();
  const backups = listBackups();

  if (args.list) {
    if (backups.length === 0) {
      console.log('backups/ 下没有备份。');
      return;
    }
    console.log('可用备份（新 → 旧）：');
    for (const b of backups) {
      const tag = isPreRollback(b.name) ? '\t[回滚前留存，不作默认候选]' : '';
      console.log(`  ${b.name}\t${new Date(b.mtime).toLocaleString()}\t${b.size.toLocaleString()} 字节${tag}`);
    }
    return;
  }

  if (backups.length === 0) {
    throw new Error(`没有可用备份：${backupDir()}\n无法回滚。若安装目录被改动过，需重新安装 ZCode。`);
  }

  // 默认只从 apply 留下的原始备份里挑最新；pre-rollback 留存文件最新，
  // 若不排除，连续 rollback 第二次会把“回滚前状态”（通常已打补丁）恢复回去，语义反转。
  const candidates = backups.filter((b) => !isPreRollback(b.name));
  if (candidates.length === 0) {
    throw new Error(
      `backups/ 下只有 pre-rollback 留存文件，没有 apply 时留下的原始备份。\n` +
        `如确要从留存文件恢复，请用 --from=<文件> 显式指定。`
    );
  }

  const installDir = resolveInstallDir(args);
  const p = installPaths(installDir);
  const install = readInstallInfo(installDir);
  const chosen = typeof args.from === 'string' ? { path: args.from, name: args.from } : candidates[0];
  if (!existsSync(chosen.path)) throw new Error(`备份文件不存在：${chosen.path}`);

  const lock = assertTargetNotLocked(installDir);
  if (lock.running) {
    console.log('目标目录下的实例未运行（检测到其它位置的实例在跑，不影响本次写入）');
  }

  // 覆盖前先把当前状态也留一份，避免回滚后又想回退
  mkdirSync(backupDir(), { recursive: true });
  const stamp = timestamp();
  const safety = join(backupDir(), `app.asar.${install.appVersion}.pre-rollback-${stamp}`);
  copyFileSync(p.asar, safety);
  console.log(`已留存回滚前状态：${safety}`);

  copyFileSync(chosen.path, p.asar);
  const hash = sha256(readFileSync(p.asar));
  console.log(`已恢复：${chosen.name}`);
  console.log(`SHA256：${hash}`);

  // apply 的状态记录随回滚失效：当前 asar 已不是 apply 产物，留着会误报“已应用”
  const stateFile = join(stateDir(), `applied-${install.appVersion}.json`);
  if (existsSync(stateFile)) {
    unlinkSync(stateFile);
    console.log(`已清理应用状态记录：${stateFile}`);
  }

  console.log('\n重新启动 ZCode 后生效。');
}

main().catch((err) => {
  console.error(`\n失败：${err.message}`);
  process.exitCode = 1;
});
