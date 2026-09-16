/* ZCode-Expand · 备注独立存储（host 进程注入）
 * ---------------------------------------------------------------------------
 * 注入到 out/host/zcode-expand/zc-store.mjs（host 的 settings 服务进程）。
 * out/host/index.js 的读/写挂钩处通过 globalThis.__ZC_XP_STORE__ 调用：
 *   merge(settings)          读点：把 zcode-expand.json 的 projectRemarks 并进 settings
 *   extract(patch, merged)   写点：patch 带 projectRemarks 时落 store，
 *                             并从 merged 剔除该键（setting.json 保持官方纯净）
 *
 * 数据真身 ~/.zcode/v2/zcode-expand.json（与官方 setting.json 同目录但不同名，
 * 官方永远不会读写它——升级免疫）。原子写（tmp+rename），读侧带 mtime 缓存，
 * 手改 JSON 文件后 mtime 变化即失效重读。
 * ---------------------------------------------------------------------------
 */
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';

const STORE_FILE = join(homedir(), '.zcode', 'v2', 'zcode-expand.json');

function logError(op, detail) {
  console.error(`[ZCode-Expand] 备注 store ${op}：`, detail);
}

// mtime 缓存：settings get 走读点，避免每次落盘 IO；写后与外部改动都会刷新
let cache = null; // { mtimeMs, store }

async function statMtime() {
  try {
    return (await stat(STORE_FILE)).mtimeMs;
  } catch {
    return 0;
  }
}

function emptyStore() {
  return { version: 1, projectRemarks: {} };
}

function normalizeStore(parsed) {
  const remarks = parsed?.projectRemarks;
  return {
    version: 1,
    projectRemarks:
      remarks && typeof remarks === 'object' && !Array.isArray(remarks) ? remarks : {},
  };
}

async function readStore() {
  const mtimeMs = await statMtime();
  if (mtimeMs && cache && cache.mtimeMs === mtimeMs) return cache.store;
  try {
    const raw = await readFile(STORE_FILE, 'utf8');
    const store = normalizeStore(JSON.parse(raw));
    cache = { mtimeMs, store };
    return store;
  } catch (err) {
    if (err?.code !== 'ENOENT') logError('读取失败（回退空）', err?.message ?? err);
    const store = emptyStore();
    cache = { mtimeMs, store };
    return store;
  }
}

async function writeStore(store) {
  await mkdir(dirname(STORE_FILE), { recursive: true });
  const tmp = `${STORE_FILE}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, JSON.stringify(store, null, 2) + '\n', 'utf8');
  await rename(tmp, STORE_FILE);
  cache = { mtimeMs: await statMtime(), store };
}

globalThis.__ZC_XP_STORE__ = {
  /** 读点挂钩：store 有内容时替换 settings.projectRemarks（store 是唯一真身），否则原样返回 */
  async merge(settings) {
    if (!settings || typeof settings !== 'object') return settings;
    try {
      const store = await readStore();
      if (Object.keys(store.projectRemarks).length === 0) return settings;
      return { ...settings, projectRemarks: { ...store.projectRemarks } };
    } catch (err) {
      logError('merge 失败（settings 原样返回）', err?.message ?? err);
      return settings;
    }
  },
  /** 写点挂钩：patch 带 projectRemarks → 全量写 store 并从落盘内容剔除；否则 no-op */
  async extract(patch, merged) {
    try {
      if (!patch || typeof patch !== 'object' || !Object.hasOwn(patch, 'projectRemarks')) {
        return merged;
      }
      const value = patch.projectRemarks;
      const next = {
        version: 1,
        projectRemarks:
          value && typeof value === 'object' && !Array.isArray(value) ? value : {},
      };
      const store = await readStore();
      if (JSON.stringify(store.projectRemarks) !== JSON.stringify(next.projectRemarks)) {
        await writeStore(next);
      }
      const out = { ...merged };
      delete out.projectRemarks;
      return out;
    } catch (err) {
      // store 落盘失败不阻塞官方 setting.json 写入；渲染层内存值仍在，下次写入自愈
      logError('extract 失败（本次备注未落 store）', err?.message ?? err);
      return merged;
    }
  },
};
