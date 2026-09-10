#!/usr/bin/env node
// 回滚：从 backups/ 恢复指定（默认最近一次）的原始 app.asar
//
// 用法：
//   node scripts/rollback.mjs                 # 恢复最近一次备份
//   node scripts/rollback.mjs --list          # 只看备份列表
//   node scripts/rollback.mjs --from=<文件>   # 恢复指定备份
//   node scripts/rollback.mjs --home=<目录>

import { existsSync, readdirSync, statSync, copyFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  parseArgs,
  resolveInstallDir,
  installPaths,
  readInstallInfo,
  assertTargetNotLocked,
  backupDir,
} from './lib/env.mjs';
import { sha256 } from './lib/asar.mjs';
import { readFileSync } from 'node:fs';

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
      console.log(`  ${b.name}\t${new Date(b.mtime).toLocaleString()}\t${b.size.toLocaleString()} 字节`);
    }
    return;
  }

  if (backups.length === 0) {
    throw new Error(`没有可用备份：${backupDir()}\n无法回滚。若安装目录被改动过，需重新安装 ZCode。`);
  }

  const installDir = resolveInstallDir(args);
  const p = installPaths(installDir);
  const install = readInstallInfo(installDir);
  const chosen = typeof args.from === 'string' ? { path: args.from, name: args.from } : backups[0];
  if (!existsSync(chosen.path)) throw new Error(`备份文件不存在：${chosen.path}`);

  const lock = assertTargetNotLocked(installDir);
  if (lock.running) {
    console.log('目标目录下的实例未运行（检测到其它位置的实例在跑，不影响本次写入）');
  }

  // 覆盖前先把当前状态也留一份，避免回滚后又想回退
  mkdirSync(backupDir(), { recursive: true });
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const safety = join(backupDir(), `app.asar.${install.appVersion}.pre-rollback-${stamp}`);
  copyFileSync(p.asar, safety);
  console.log(`已留存回滚前状态：${safety}`);

  copyFileSync(chosen.path, p.asar);
  const hash = sha256(readFileSync(p.asar));
  console.log(`已恢复：${chosen.name}`);
  console.log(`SHA256：${hash}`);
  console.log('\n重新启动 ZCode 后生效。');
}

main().catch((err) => {
  console.error(`\n失败：${err.message}`);
  process.exitCode = 1;
});
