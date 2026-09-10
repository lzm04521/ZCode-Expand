// 语法门禁：补丁产出的 JS 必须先通过 node --check，才允许写入 asar。
// 目的：把“补丁锚点匹配但代码被改坏”这类问题挡在写盘之前。
//
// 判定方式：同一份内容先按 ESM(.mjs) 检查，失败再按 CJS(.cjs) 检查；
// 两种都失败才算不通过，并回报 ESM 模式下的报错（更贴近打包产物的真实形态）。

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const JS_EXT = /\.(js|cjs|mjs)$/;

function tryCheck(file) {
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe', windowsHide: true });
    return { ok: true };
  } catch (err) {
    const stderr = (err.stderr ?? Buffer.alloc(0)).toString('utf8').trim();
    return { ok: false, message: stderr || err.message };
  }
}

/**
 * @param {Map<string, Buffer>} files asar 内路径 -> 新内容
 * @returns {{checked:number, failures:Array<{path:string,message:string}>}}
 */
export function checkJavaScript(files) {
  const dir = mkdtempSync(join(tmpdir(), 'zcexpand-syntax-'));
  const failures = [];
  let checked = 0;
  try {
    let seq = 0;
    for (const [path, buf] of files) {
      if (!JS_EXT.test(path)) continue;
      checked += 1;
      seq += 1;
      const base = join(dir, `f${seq}`);
      const asEsm = `${base}.mjs`;
      writeFileSync(asEsm, buf);
      const esm = tryCheck(asEsm);
      if (esm.ok) continue;
      const asCjs = `${base}.cjs`;
      writeFileSync(asCjs, buf);
      const cjs = tryCheck(asCjs);
      if (cjs.ok) continue;
      failures.push({ path, message: esm.message });
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  return { checked, failures };
}
