// 补丁引擎：锚点计数校验 + 幂等应用 + 新文件装载
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { patchSetDir, REPO_ROOT } from './env.mjs';
import { openAsar, closeAsar, readEntry, findEntry, listEntries } from './asar.mjs';

export function loadPatchSet(version) {
  const dir = patchSetDir(version);
  const manifestPath = join(dir, 'manifest.json');
  const patchesPath = join(dir, 'patches.json');
  if (!existsSync(manifestPath)) throw new Error(`缺少 manifest.json：${manifestPath}`);
  if (!existsSync(patchesPath)) throw new Error(`缺少 patches.json：${patchesPath}`);
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const patches = JSON.parse(readFileSync(patchesPath, 'utf8'));
  if (patches.appVersion !== manifest.appVersion) {
    throw new Error(`manifest(${manifest.appVersion}) 与 patches(${patches.appVersion}) 版本不一致`);
  }
  return { dir, manifest, patches };
}

export function countOccurrences(haystack, needle) {
  if (!needle) throw new Error('锚点不能为空');
  let count = 0;
  let idx = 0;
  while ((idx = haystack.indexOf(needle, idx)) !== -1) {
    count += 1;
    idx += needle.length;
  }
  return count;
}

/**
 * 对单个文件文本应用一组编辑。
 * 每个编辑含：{find, replace, expect=1, marker, note}
 * - marker 已存在 → 视为已应用，跳过（保证幂等，不会重复插入）
 * - find 出现次数 !== expect → 抛错（补丁与当前版本不匹配）
 */
export function applyEdits(text, edits, label) {
  let out = text;
  const report = [];
  for (let i = 0; i < edits.length; i += 1) {
    const edit = edits[i];
    const where = `${label} #${i + 1}${edit.note ? ` (${edit.note})` : ''}`;
    if (edit.marker && out.includes(edit.marker)) {
      report.push({ where, status: 'already-applied' });
      continue;
    }
    const expect = edit.expect ?? 1;
    const found = countOccurrences(out, edit.find);
    if (found !== expect) {
      throw new Error(
        `${where} 锚点匹配 ${found} 次，期望 ${expect} 次。该补丁不适配当前文件内容。\n` +
          `锚点片段：${JSON.stringify(edit.find.slice(0, 120))}`
      );
    }
    out = out.split(edit.find).join(edit.replace);
    report.push({ where, status: 'applied', matches: found });
  }
  return { text: out, report };
}

/** 读取补丁集中声明的全部“新增文件”内容 */
export function loadAddedFiles(patchSet) {
  const add = new Map();
  for (const item of patchSet.patches.addFiles ?? []) {
    const src = join(REPO_ROOT, item.from);
    if (!existsSync(src)) throw new Error(`新增文件源缺失：${src}`);
    const content = readFileSync(src);
    if (!item.to) throw new Error(`新增文件缺少目标路径：${item.from}`);
    add.set(item.to, content);
  }
  return add;
}

/** 在给定 asar 上按补丁集生成 replace 映射 */
export function buildReplacements(asar, patchSet) {
  const replace = new Map();
  const report = [];
  for (const target of patchSet.patches.targets ?? []) {
    const entry = findEntry(asar.header, target.file);
    if (!entry) {
      throw new Error(`目标文件在 asar 中不存在：${target.file}（${target.description ?? ''}）`);
    }
    if (entry.unpacked) {
      throw new Error(`目标文件是 unpacked 条目，本工具暂不支持：${target.file}`);
    }
    const text = readEntry(asar, target.file).toString('utf8');
    const { text: next, report: r } = applyEdits(text, target.edits ?? [], target.file);
    replace.set(target.file, Buffer.from(next, 'utf8'));
    report.push({ file: target.file, description: target.description, edits: r });
  }
  return { replace, report };
}

/** 校验：锚点是否就位、补丁是否已应用 */
export function inspectPatchState(installDirAsarPath, patchSet) {
  const asar = openAsar(installDirAsarPath);
  try {
    const results = [];
    for (const target of patchSet.patches.targets ?? []) {
      const entry = findEntry(asar.header, target.file);
      if (!entry) {
        results.push({ file: target.file, state: 'file-missing' });
        continue;
      }
      const text = readEntry(asar, target.file).toString('utf8');
      const edits = (target.edits ?? []).map((edit, i) => {
        const hasMarker = edit.marker ? text.includes(edit.marker) : false;
        const anchorCount = countOccurrences(text, edit.find);
        return {
          index: i + 1,
          note: edit.note,
          applied: hasMarker,
          anchorCount,
          expect: edit.expect ?? 1,
        };
      });
      const allApplied = edits.every((e) => e.applied);
      const anchorsOk = edits.every((e) => e.applied || e.anchorCount === e.expect);
      results.push({
        file: target.file,
        description: target.description,
        state: allApplied ? 'applied' : anchorsOk ? 'not-applied' : 'anchor-mismatch',
        edits,
      });
    }
    const addFiles = (patchSet.patches.addFiles ?? []).map((item) => ({
      to: item.to,
      present: !!findEntry(asar.header, item.to),
    }));
    return { results, addFiles, entryCount: listEntries(asar).length };
  } finally {
    closeAsar(asar);
  }
}
