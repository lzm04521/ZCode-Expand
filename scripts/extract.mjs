#!/usr/bin/env node
// 从 asar 取内容 —— 版本适配时的主要工具
//
// 用法：
//   node scripts/extract.mjs --list=<路径前缀>
//       列出 asar 内文件（可按前缀过滤）
//   node scripts/extract.mjs --file=<asar内路径> [--out=<本地文件>]
//       导出文件；不指定 --out 则打印（--text 已默认按 utf8）
//   node scripts/extract.mjs --grep=<关键字> [--file=<限定文件>] [--window=240] [--max=15] [--regex]
//       在 asar 内搜索关键字并打印上下文，用于重新定位锚点
//
// 例：
//   node scripts/extract.mjs --grep="recentProjects" --file=out/main/chunk-WR3FEWGO.js --window=160
//   node scripts/extract.mjs --file=out/metadata/build-meta.json

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { parseArgs, resolveInstallDir, installPaths } from './lib/env.mjs';
import { openAsar, closeAsar, listEntries, readEntry, canonical } from './lib/asar.mjs';

function context(text, index, window) {
  const from = Math.max(0, index - window);
  const to = Math.min(text.length, index + window);
  return text.slice(from, to).replace(/\s+/g, ' ');
}

async function main() {
  const args = parseArgs();
  // --from=<文件> 允许直接读任意 asar（例如 apply --dry-run 的产物），便于比对补丁前后
  const asarPath =
    typeof args.from === 'string' ? args.from : installPaths(resolveInstallDir(args)).asar;
  const asar = openAsar(asarPath);
  console.log(`# 来源：${asarPath}\n`);

  try {
    const entries = listEntries(asar);

    if (args.list) {
      const prefix = String(args.list).replace(/\\/g, '/');
      const matched = entries.filter((e) => e.path.includes(prefix));
      console.log(`匹配 ${matched.length} 个文件：`);
      for (const e of matched.slice(0, 200)) {
        console.log(`  ${String(e.size).padStart(10, ' ')}  ${e.path}${e.unpacked ? '  [unpacked]' : ''}`);
      }
      if (matched.length > 200) console.log(`  ... 共 ${matched.length} 个，已截断`);
      return;
    }

    if (args.grep) {
      const needle = String(args.grep);
      const window = Number(args.window ?? 240);
      const max = Number(args.max ?? 15);
      const re = args.regex ? new RegExp(needle, 'g') : null;
      const targets = args.file
        ? entries.filter((e) => e.path === canonical(String(args.file)))
        : entries.filter((e) => !e.unpacked && /\.(js|cjs|mjs|json|html|css|txt|yml)$/.test(e.path));
      if (targets.length === 0) {
        console.log('没有匹配的文件（--file 需写 asar 内完整路径，如 out/main/index.js）');
        process.exitCode = 1;
        return;
      }
      let total = 0;
      for (const e of targets) {
        const text = readEntry(asar, e.path).toString('utf8');
        const hits = [];
        if (re) {
          let m;
          while ((m = re.exec(text)) !== null) {
            hits.push(m.index);
            if (m.index === re.lastIndex) re.lastIndex += 1;
          }
        } else {
          let idx = 0;
          while ((idx = text.indexOf(needle, idx)) !== -1) {
            hits.push(idx);
            idx += needle.length;
          }
        }
        if (hits.length === 0) continue;
        console.log(`\n### ${e.path}  (${e.size} 字节, ${hits.length} 处)`);
        for (const h of hits.slice(0, max)) {
          console.log(`  @${h}: ${context(text, h, window)}`);
        }
        if (hits.length > max) console.log(`  ... 另有 ${hits.length - max} 处未显示`);
        total += hits.length;
      }
      console.log(`\n合计 ${total} 处匹配。`);
      return;
    }

    if (args.file) {
      const path = String(args.file).replace(/\\/g, '/');
      const buf = readEntry(asar, path);
      if (typeof args.out === 'string') {
        mkdirSync(dirname(args.out), { recursive: true });
        writeFileSync(args.out, buf);
        console.log(`已导出 ${buf.length} 字节到 ${args.out}`);
      } else {
        process.stdout.write(buf.toString('utf8'));
      }
      return;
    }

    console.log('请指定 --list / --file / --grep，详见文件头注释。');
  } finally {
    closeAsar(asar);
  }
}

main().catch((err) => {
  console.error(`\n失败：${err.message}`);
  process.exitCode = 1;
});
