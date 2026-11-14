// 只读锚点探针：对指定 asar 逐一计数补丁集全部 find 命中数与 marker 缺席情况，输出 chunk 映射与锚点状态。
// 用法：node scripts/adapt-probe.mjs <asar路径> <patches.json路径>
//       （asar 可传安装目录在用文件，也可传 backups/ 官方原始备份——对已打补丁的 asar 跑会全部 DRIFT 属预期）
// 适配时用于：①判断升级后影响面（哪些锚点漂移）②生成新 patches.json 后的复验（应全部 hits=expect 且 marker absent）。
import { openAsar, findEntry, readEntry, closeAsar } from 'file:///D:/GitHub/Zcode-Expand/scripts/lib/asar.mjs';
import { readFileSync } from 'node:fs';

const [, , asarPathArg, patchesArg] = process.argv;
const patches = JSON.parse(readFileSync(patchesArg, 'utf8'));
const a = await openAsar(asarPathArg);

const candidates = {
  main: ['chunk-53SIT7PA','chunk-5NE3TPF2','chunk-5SVAX2QO','chunk-AL54RMRC','chunk-C7Y4PUU3','chunk-CCQBT66Q','chunk-CM2YMK3U','chunk-ECDQBQ25','chunk-HH7N2YVI','chunk-LBO6FN6W','chunk-MC6LJHEM','chunk-N4BDK3A6','chunk-SB5FKEB5','chunk-SUT4TCAP','chunk-UUH5GOTC','chunk-V3ZDB5LI','chunk-VZB7LIRS','chunk-ZHR5V36R'].map(c => 'out/main/' + c + '.js'),
  host: ['chunk-5762NB3U','chunk-5IDO7J4H','chunk-AVVECCFL','chunk-BKHFVWJF','chunk-IEBWXNOE','chunk-IYVG6UP7','chunk-NTRLNFQR','chunk-O6MP7ZHZ','chunk-PXRLV5WX','chunk-RLEO6HKG','chunk-SINCCV5L','chunk-ZDLGWCUS'].map(c => 'out/host/' + c + '.js'),
};
const fixedMap = {
  'out/renderer/assets/validation-hnAQ_U3V.js': 'out/renderer/assets/validation-CBeRQvEb.js',
  'out/renderer/assets/styles-BhvI6_DD.js': 'out/renderer/assets/styles-a4AckxCl.js',
};

function countAll(hay, needle) {
  let n = 0, i = hay.indexOf(needle);
  while (i !== -1 && n < 99) { n++; i = hay.indexOf(needle, i + 1); }
  return n;
}

for (const t of patches.targets) {
  let newFile = fixedMap[t.file];
  let how = 'fixed-name';
  if (!newFile) {
    const isMain = t.file.startsWith('out/main/chunk-');
    const isHost = t.file.startsWith('out/host/chunk-');
    if (isMain || isHost) {
      const pool = isMain ? candidates.main : candidates.host;
      for (const f of pool) {
        if (!findEntry(a, f)) continue;
        const content = await readEntry(a, f);
        if (t.edits.every(ed => content.includes(ed.find))) { newFile = f; how = 'content-matched'; break; }
      }
      if (!newFile) {
        let best = null, bestN = -1;
        for (const f of pool) {
          const content = await readEntry(a, f);
          const n = t.edits.filter(ed => content.includes(ed.find)).length;
          if (n > bestN) { bestN = n; best = f; }
        }
        newFile = best; how = 'PARTIAL(' + bestN + '/' + t.edits.length + ')';
      }
    } else {
      newFile = t.file; how = 'same-path';
    }
  }
  console.log('=== ' + t.file + '  ->  ' + newFile + '  [' + how + ']');
  const content = await readEntry(a, newFile);
  t.edits.forEach((ed, idx) => {
    const n = countAll(content, ed.find);
    const ok = n === (ed.expect ?? 1);
    console.log('  #' + idx + ' hits=' + n + ' expect=' + (ed.expect ?? 1) + (ok ? ' OK' : ' **DRIFT**') +
      '  marker=' + (ed.marker ? (content.includes(ed.marker) ? 'PRESENT(bad-已应用?)' : 'absent(good)') : 'NO-MARKER') +
      '  find=' + JSON.stringify(ed.find.slice(0, 80)));
  });
}
await closeAsar(a);
console.log('PROBE-DONE');
