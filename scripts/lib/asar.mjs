// asar 读写实现（纯 Node，零依赖）
//
// 文件布局（本机 ZCode 3.11.2 实测）：
//   [0:4]   uint32 = 4                     外层 pickle 的 payload 长度
//   [4:8]   uint32 = 8 + jsonSize          pickle1 长度
//   [8:12]  uint32 = 4 + jsonSize          pickle2 长度
//   [12:16] uint32 = jsonSize              索引 JSON 字节数
//   [16:]   utf8 JSON 索引（压缩无空白）
//   之后为数据区，条目 offset 相对数据区起点
//
// 条目字段：普通文件 {size, offset, integrity}；unpacked 文件 {size, unpacked, integrity}
// integrity：{algorithm:'SHA256', hash: 全文 SHA256, blockSize: 4194304, blocks:[每块 SHA256]}
// 实测确认：hash 是全文 SHA256，blocks 是每 4MB 分块 SHA256（多块文件同样成立）。

import { createHash } from 'node:crypto';
import { openSync, closeSync, readSync, writeSync, statSync } from 'node:fs';

const BLOCK_SIZE = 4194304;
const COPY_CHUNK = 8 * 1024 * 1024;

export function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

export function integrityOf(buf) {
  const blocks = [];
  for (let i = 0; i < buf.length; i += BLOCK_SIZE) {
    blocks.push(sha256(buf.subarray(i, Math.min(i + BLOCK_SIZE, buf.length))));
  }
  return { algorithm: 'SHA256', hash: sha256(buf), blockSize: BLOCK_SIZE, blocks };
}

function normalize(path) {
  return '/' + String(path).replace(/\\/g, '/').split('/').filter(Boolean).join('/');
}

/** 统一路径形态（带前导斜杠）。补丁集里常写 out/xxx，asar 条目是 /out/xxx，必须收敛。 */
export function canonical(path) {
  return normalize(path);
}

export function findEntry(header, path) {
  const parts = normalize(path).split('/').filter(Boolean);
  let node = header;
  for (const part of parts) {
    if (!node.files || !node.files[part]) return null;
    node = node.files[part];
  }
  return node;
}

export function openAsar(file) {
  const fd = openSync(file, 'r');
  const size = statSync(file).size;
  const head = Buffer.alloc(16);
  if (readSync(fd, head, 0, 16, 0) !== 16) {
    closeSync(fd);
    throw new Error('asar 头部读取不足 16 字节');
  }
  const outer = head.readUInt32LE(0);
  const pickle1 = head.readUInt32LE(4);
  const pickle2 = head.readUInt32LE(8);
  const jsonSize = head.readUInt32LE(12);
  if (outer !== 4) {
    closeSync(fd);
    throw new Error(`asar 头部异常：首字段应为 4，实际 ${outer}`);
  }
  if (pickle1 !== 8 + jsonSize || pickle2 !== 4 + jsonSize) {
    closeSync(fd);
    throw new Error(`asar 头部长度字段不自洽：${pickle1} / ${pickle2} / ${jsonSize}`);
  }
  if (16 + jsonSize > size) {
    closeSync(fd);
    throw new Error('asar 索引长度超出文件大小');
  }
  const jsonBuf = Buffer.alloc(jsonSize);
  if (readSync(fd, jsonBuf, 0, jsonSize, 16) !== jsonSize) {
    closeSync(fd);
    throw new Error('asar 索引读取失败');
  }
  let header;
  try {
    header = JSON.parse(jsonBuf.toString('utf8'));
  } catch (err) {
    closeSync(fd);
    throw new Error(`asar 索引 JSON 解析失败：${err.message}`);
  }
  if (!header.files) {
    closeSync(fd);
    throw new Error('asar 索引缺少 files 根节点');
  }
  return { file, fd, size, jsonSize, dataStart: 16 + jsonSize, header };
}

export function closeAsar(a) {
  if (a && a.fd !== null && a.fd !== undefined) {
    closeSync(a.fd);
    a.fd = null;
  }
}

export function listEntries(a) {
  const out = [];
  (function walk(node, prefix) {
    for (const [name, meta] of Object.entries(node.files ?? {})) {
      const p = `${prefix}/${name}`;
      if (meta.files) walk(meta, p);
      else out.push({
        path: p,
        size: meta.size ?? 0,
        // 索引里 offset 以字符串存放（27281/27281 全部如此），Electron 读取时会 parseInt
        offset: meta.offset === undefined ? undefined : Number(meta.offset),
        unpacked: !!meta.unpacked,
      });
    }
  })(a.header, '');
  return out;
}

export function readEntry(a, path) {
  const entry = findEntry(a.header, path);
  if (!entry) throw new Error(`asar 中不存在：${path}`);
  if (entry.files) throw new Error(`${path} 是目录，不是文件`);
  if (entry.unpacked) throw new Error(`${path} 是 unpacked 条目，内容在 app.asar.unpacked 下，无法从 asar 读取`);
  if (entry.offset === undefined) throw new Error(`${path} 缺少 offset`);
  const offset = Number(entry.offset);
  if (!Number.isFinite(offset)) throw new Error(`${path} 的 offset 不是数字：${entry.offset}`);
  if (a.dataStart + offset + entry.size > a.size) throw new Error(`${path} 的 offset/size 越界`);
  const buf = Buffer.alloc(entry.size);
  if (entry.size > 0 && readSync(a.fd, buf, 0, entry.size, a.dataStart + offset) !== entry.size) {
    throw new Error(`${path} 内容读取失败`);
  }
  return buf;
}

/** 计算新布局：返回新 header、数据区条目顺序、以及改动集合 */
export function computeLayout(a, ops = {}) {
  // 统一收敛到带前导斜杠的规范路径，避免“键写 out/x、条目是 /out/x”导致静默漏改
  const replace = new Map();
  for (const [k, v] of ops.replace ?? new Map()) replace.set(normalize(k), v);
  const add = new Map();
  for (const [k, v] of ops.add ?? new Map()) add.set(normalize(k), v);
  const header = JSON.parse(JSON.stringify(a.header));

  for (const path of replace.keys()) {
    const entry = findEntry(header, path);
    if (!entry) throw new Error(`替换目标在 asar 中不存在：${path}`);
    if (entry.files) throw new Error(`替换目标是目录：${path}`);
    if (entry.unpacked) throw new Error(`替换目标是 unpacked 条目，本工具暂不支持：${path}`);
  }
  for (const path of add.keys()) {
    if (findEntry(header, path)) throw new Error(`新增目标已存在，拒绝覆盖：${path}`);
    const parts = normalize(path).split('/').filter(Boolean);
    if (parts.length === 0) throw new Error('新增目标路径为空');
    let node = header;
    for (const part of parts.slice(0, -1)) {
      if (!node.files) node.files = {};
      const next = node.files[part];
      if (!next) node.files[part] = { files: {} };
      else if (!next.files) throw new Error(`新增目标的中间层级是文件而非目录：${path}`);
      node = node.files[part];
    }
    node.files[parts[parts.length - 1]] = { size: 0 };
  }

  const packed = listEntries(a)
    .filter((e) => !e.unpacked && e.offset !== undefined)
    .sort((x, y) => x.offset - y.offset);

  const layout = [];
  const consumed = new Set();
  for (const e of packed) {
    const key = normalize(e.path);
    const buf = replace.get(key) ?? null;
    if (buf) consumed.add(key);
    layout.push({ path: key, buf, size: buf ? buf.length : e.size, srcOffset: buf ? null : e.offset });
  }
  for (const [path, buf] of add) {
    layout.push({ path, buf, size: buf.length, srcOffset: null });
  }

  // 守门：声明了替换却没命中任何条目，说明路径写错或该条目不可替换，必须报错而不是放过
  const unused = [...replace.keys()].filter((k) => !consumed.has(k));
  if (unused.length > 0) {
    throw new Error(`以下替换目标未匹配到任何可替换条目（检查路径或 unpacked 状态）：\n  ${unused.join('\n  ')}`);
  }

  let cursor = 0;
  for (const item of layout) {
    const entry = findEntry(header, item.path);
    item.offset = cursor;
    entry.size = item.size;
    // 与原索引保持一致：offset 写字符串
    entry.offset = String(cursor);
    if (item.buf) entry.integrity = integrityOf(item.buf);
    cursor += item.size;
  }

  return { header, layout, dataSize: cursor, changed: new Set([...replace.keys(), ...add.keys()]) };
}
function headerBuffer(header) {
  const jsonBuf = Buffer.from(JSON.stringify(header), 'utf8');
  const head = Buffer.alloc(16);
  head.writeUInt32LE(4, 0);
  head.writeUInt32LE(8 + jsonBuf.length, 4);
  head.writeUInt32LE(4 + jsonBuf.length, 8);
  head.writeUInt32LE(jsonBuf.length, 12);
  return { head, jsonBuf, dataStart: 16 + jsonBuf.length };
}

function writeAll(fd, buf, offset) {
  let done = 0;
  while (done < buf.length) {
    done += writeSync(fd, buf, done, buf.length - done, offset + done);
  }
}

/** 流式把重建结果写入目标文件（避免把 300MB+ 产物整块驻留内存） */
export function writeRepacked(a, ops, destFile) {
  const { header, layout, dataSize, changed } = computeLayout(a, ops);
  const { head, jsonBuf, dataStart } = headerBuffer(header);
  const fd = openSync(destFile, 'w');
  try {
    writeAll(fd, head, 0);
    writeAll(fd, jsonBuf, 16);
    const scratch = Buffer.alloc(COPY_CHUNK);
    for (const item of layout) {
      const at = dataStart + item.offset;
      if (item.buf) {
        writeAll(fd, item.buf, at);
        continue;
      }
      let done = 0;
      while (done < item.size) {
        const want = Math.min(COPY_CHUNK, item.size - done);
        const got = readSync(a.fd, scratch, 0, want, a.dataStart + item.srcOffset + done);
        if (got !== want) throw new Error(`原样搬移失败：${item.path}（偏移 ${item.srcOffset + done}）`);
        writeAll(fd, scratch.subarray(0, want), at + done);
        done += want;
      }
    }
  } finally {
    closeSync(fd);
  }
  return { bytesWritten: dataStart + dataSize, dataStart, entryCount: layout.length, changed, header };
}

/** 一次性产出 Buffer（供 dry-run 检视或小规模场景） */
export function repack(a, ops = {}) {
  const { header, layout, dataSize } = computeLayout(a, ops);
  const { head, jsonBuf, dataStart } = headerBuffer(header);
  const out = Buffer.alloc(dataStart + dataSize);
  head.copy(out, 0);
  jsonBuf.copy(out, 16);
  const scratch = Buffer.alloc(COPY_CHUNK);
  for (const item of layout) {
    const at = dataStart + item.offset;
    if (item.buf) {
      item.buf.copy(out, at);
      continue;
    }
    let done = 0;
    while (done < item.size) {
      const want = Math.min(COPY_CHUNK, item.size - done);
      const got = readSync(a.fd, scratch, 0, want, a.dataStart + item.srcOffset + done);
      if (got !== want) throw new Error(`原样搬移失败：${item.path}（偏移 ${item.srcOffset + done}）`);
      scratch.copy(out, at + done, 0, want);
      done += want;
    }
  }
  return out;
}

/** 统一的读取句柄，供自检比对两种来源（原 asar 文件 / 落盘产物） */
export function holderFromOpenAsar(a) {
  return { header: a.header, readBytes: (path) => readEntry(a, path) };
}

/** 自检：逐条比对未改动条目必须字节一致，并核对改动条目的 integrity 自洽 */
/** 收集索引中的全部叶节点：path -> meta。不含任何提前返回，保证遍历完整。 */
function leavesOf(header) {
  const out = new Map();
  (function walk(node, prefix) {
    for (const [name, meta] of Object.entries(node.files ?? {})) {
      const p = `${prefix}/${name}`;
      if (meta.files) walk(meta, p);
      else out.set(p, meta);
    }
  })(header, '');
  return out;
}

/**
 * 自检：逐条比对产物与原始 asar。
 * - 原始有、产物没有 → 报错（漏了条目）
 * - 产物有、原始没有 → 必须在 expectedChanges 里，否则报错
 * - 两侧都有且不在 expectedChanges → 大小与字节必须完全一致
 * - 在 expectedChanges 里 → 核对 size 与 integrity 是否与内容自洽
 *
 * 注意：这里刻意先把叶节点收成 Map 再比对，不用“边遍历边提前返回”的写法 ——
 * 在 for...of 里 return 会跳出整个目录、静默漏检同级条目。
 */
export function selfCheck(before, after, expectedChanges = new Set()) {
  const mismatches = [];
  const expected = new Set([...expectedChanges].map(normalize));
  const beforeLeaves = leavesOf(before.header);
  const afterLeaves = leavesOf(after.header);

  let checked = 0;
  let changedSeen = 0;

  for (const [path, meta] of afterLeaves) {
    const old = beforeLeaves.get(path);
    if (!old) {
      if (!expected.has(path)) mismatches.push(`产物多出未预期条目：${path}`);
      else changedSeen += 1;
      continue;
    }
    if (old.unpacked || meta.unpacked) continue;
    if (expected.has(path)) {
      changedSeen += 1;
      const bytes = after.readBytes(path);
      if (bytes === null) {
        mismatches.push(`改动条目无法读取：${path}`);
        continue;
      }
      if ((meta.size ?? -1) !== bytes.length) {
        mismatches.push(`改动条目 size 与内容不符：${path} 索引 ${meta.size} / 实际 ${bytes.length}`);
      }
      if (meta.integrity?.hash !== integrityOf(bytes).hash) {
        mismatches.push(`改动条目 integrity 与内容不符：${path}`);
      }
      continue;
    }
    if ((old.size ?? -1) !== (meta.size ?? -1)) {
      mismatches.push(`未改动文件大小变化：${path} ${old.size} -> ${meta.size}`);
    }
    const a1 = before.readBytes(path);
    const a2 = after.readBytes(path);
    if (!a1.equals(a2)) mismatches.push(`未改动文件内容变化：${path}`);
    checked += 1;
  }

  for (const path of beforeLeaves.keys()) {
    if (!afterLeaves.has(path)) mismatches.push(`产物缺少原条目：${path}`);
  }

  return { checked, changedSeen, mismatches };
}

