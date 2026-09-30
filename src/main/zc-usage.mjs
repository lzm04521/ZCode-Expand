// ZCode-Expand：token 用量状态栏泵（主进程注入模块）
// 注入位置：out/main/zcode-expand/zc-usage.mjs，由 out/main/index.js 文件头的副作用 import 加载。
// 职责（doc/20260930-设计文档-token用量状态栏重写.md §4.1）：
//   fs.watch db 目录（WAL 写入在 -wal 文件，watch 主文件收不到事件）→ 去抖 300ms + 限频 1.5s
//   → 读各窗口 __zusageWantSids → worker 按需查询（zc-usage-query.cjs，eval 载入绕 asar 路径）
//   → 本地不存在的 sid 走 SSH 远端（config.remote，负缓存 2min/失败退避 60s）
//   → executeJavaScript 推 window.__zusageUpdate(payload)（U+2028/2029 转义）；did-finish-load 注入 overlay。
// 纯函数（escapeForExecuteJavaScript/parseWants/shouldQueryRemote）node 下可测；启动逻辑 electron 守卫。

import { Worker } from 'node:worker_threads';
import { readFileSync, existsSync, watch, appendFileSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { homedir } from 'node:os';

const SID_RE = /^[A-Za-z0-9_-]{1,80}$/;         // 与查询体同款白名单（独立复制，不跨文件 import）
const DEBOUNCE_MS = 300;                         // fs.watch 去抖
const MIN_INTERVAL_MS = 1500;                    // 实际查询限频
const HEARTBEAT_MS = 30 * 1000;                  // 兜底心跳
const QUERY_TIMEOUT_MS = 15 * 1000;              // worker 单查超时
const WANT_TIMEOUT_MS = 1000;                    // executeJavaScript 读 wants 超时
const REMOTE_NEG_OK_MS = 2 * 60 * 1000;          // 远端确认"无此会话"后 2min 不再问（§7）
const REMOTE_FAIL_BACKOFF_MS = 60 * 1000;        // ssh 失败 60s 退避（§7）
const LOG = (...a) => { try { console.log('[zc-usage]', ...a); } catch {} };
const noop = () => {};

// 排查日志：~/.zcode/zcode-expand/usage-debug 标记文件存在时启用（pump 链路各节点 append 到
// pump-debug.log，超 512KB 截断）。排查完删标记文件即恢复静默。
const DEBUG_DIR = join(homedir(), '.zcode', 'zcode-expand');
const DEBUG_MARK = join(DEBUG_DIR, 'usage-debug');
function debugLog(...a) {
  try {
    if (!existsSync(DEBUG_MARK)) return;
    try { mkdirSync(DEBUG_DIR, { recursive: true }); } catch {}
    const p = join(DEBUG_DIR, 'pump-debug.log');
    const line = new Date().toISOString().slice(11, 23) + ' ' + a.join(' ') + '\n';
    appendFileSync(p, line);
    try { if (statSync(p).size > 512 * 1024) writeFileSync(p, line); } catch {}
  } catch {}
}

// ---- 纯函数（node 下单测，Task 4 Step 3）----

// executeJavaScript 的字符串字面量必须是合法 JS：JSON.stringify 不转义 U+2028/2029（合法 JSON、
// 非法 JS 行终结符），会话标题/工具名等任意文本都可能携带 → 必须显式转义（设计 §11 教训）。
const U2028 = String.fromCharCode(0x2028);
const U2029 = String.fromCharCode(0x2029);
export function escapeForExecuteJavaScript(s) {
  return String(s)
    .split(U2028).join('\\u2028')
    .split(U2029).join('\\u2029');
}

// wants 汇总：非数组输入/非法 sid/重复项全部过滤
export function parseWants(raw) {
  const out = [];
  if (!Array.isArray(raw)) return out;
  for (const s of raw) {
    if (typeof s === 'string' && SID_RE.test(s) && !out.includes(s)) out.push(s);
  }
  return out;
}

// SSH 分流判定：remote 未配置/本地已存在/负缓存期内 → 不走远端（§7）
export function shouldQueryRemote(sid, knownSids, cfg, negCache, now) {
  if (!cfg || !cfg.remote || !cfg.remote.enabled) return false;
  if (Array.isArray(knownSids) && knownSids.includes(sid)) return false;
  const until = negCache && negCache.get(sid);
  if (typeof until === 'number' && now < until) return false;
  return true;
}

// ssh 失败退避门（§7：失败 60s 内不再 spawn；Final review I-1 修复——remoteFailAt 曾为死代码）
export function shouldFetchRemote(sids, failAt, now, backoffMs) {
  if (!Array.isArray(sids) || !sids.length) return false;
  return !(typeof failAt === 'number' && now - failAt < backoffMs);
}

// ---- 内部状态 ----
let config = { remote: { enabled: false } };
let worker = null;
let seq = 0;
const pending = new Map();                       // seq -> {resolve, reject, timer}
let crashTimes = [];
let workerDisabled = false;
let overlaySrc = null;
let lastPumpAt = 0;
let debounceTimer = null;
const remoteNegOk = new Map();                   // sid -> 负缓存到期时刻
let remoteFailAt = 0;
let remoteError = '';
let remoteTimer = null;
let BrowserWindowRef = null;

// ---- 运行时配置（§4.3：~/.zcode/zcode-expand/usage-config.json，缺失/损坏 = 默认 + remote 关）----
function loadConfig() {
  try {
    const p = join(homedir(), '.zcode', 'zcode-expand', 'usage-config.json');
    if (existsSync(p)) {
      const j = JSON.parse(readFileSync(p, 'utf8'));
      if (j && typeof j === 'object' && (!j.remote || typeof j.remote === 'object')) {
        config = { remote: { enabled: false, ...(j.remote || {}) } };
        return;
      }
    }
  } catch (e) {
    LOG('config 解析失败，按默认配置继续:', String((e && e.message) || e));
  }
  config = { remote: { enabled: false } };
}

// ---- worker 管理（eval 载入绕开 asar 路径对 Worker 的问题；崩溃退避 30s/3 次）----
function ensureWorker() {
  if (worker && !workerDisabled) return worker;
  if (workerDisabled) return null;
  const src = readFileSync(new URL('./zc-usage-query.cjs', import.meta.url), 'utf8');
  const w = new Worker(src, { eval: true });
  w.on('message', (m) => {
    const p = pending.get(m && m.seq);
    if (!p) return;
    pending.delete(m.seq);
    clearTimeout(p.timer);
    if (m.type === 'result') p.resolve(m.payload);
    else p.reject(new Error(m.message || 'worker error'));
  });
  const onGone = (why) => {
    for (const [, p] of pending) { clearTimeout(p.timer); p.reject(new Error('worker gone: ' + why)); }
    pending.clear();
    if (worker === w) worker = null;
    if (workerDisabled) return;
    crashTimes.push(Date.now());
    crashTimes = crashTimes.filter((t) => Date.now() - t < 30 * 1000);
    if (crashTimes.length >= 3) {
      workerDisabled = true;                     // 停用仅日志，不影响客户端（§8）
      LOG('worker 30s 内 3 次崩溃，停用状态栏查询');
    } else {
      LOG('worker 异常退出（' + why + '），将重建');
    }
  };
  w.on('error', (e) => { LOG('worker error:', String(e)); onGone('error'); });
  w.on('exit', (c) => { if (c !== 0) onGone('exit ' + c); });
  worker = w;
  return w;
}

function workerQuery(sids) {
  return new Promise((resolve, reject) => {
    const w = ensureWorker();
    if (!w) return reject(new Error('worker disabled'));
    const id = ++seq;
    const timer = setTimeout(() => {
      pending.delete(id);
      try { w.terminate(); } catch {}
      if (worker === w) worker = null;           // 超时重建（§8：15s terminate）
      reject(new Error('query timeout'));
    }, QUERY_TIMEOUT_MS);
    pending.set(id, { resolve, reject, timer });
    w.postMessage({ type: 'query', sids, seq: id });
  });
}

// ---- SSH 远端（§7：同一份查询脚本 CLI 模式；spawn 参数数组不经 shell 防注入）----
function fetchRemote(sids) {
  const rc = config.remote;
  const cmd = String(rc.ssh || '').trim().split(/\s+/).filter(Boolean);
  if (!cmd.length || !rc.script) return Promise.resolve({ error: 'remote config 缺 ssh/script' });
  const args = [...cmd.slice(1), rc.node || 'node', rc.script, ...sids, 'remote'];
  return new Promise((resolve) => {
    let p;
    try {
      p = spawn(cmd[0], args, { shell: false, windowsHide: true });
    } catch (e) {
      return resolve({ error: 'spawn: ' + String((e && e.message) || e) });
    }
    let out = '';
    let errT = '';
    const to = setTimeout(() => { try { p.kill(); } catch {} resolve({ error: 'ssh timeout' }); }, (rc.timeout_s || 6) * 1000);
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { errT += d; });
    p.on('error', (e) => { clearTimeout(to); resolve({ error: String((e && e.message) || e) }); });
    p.on('close', (code) => {
      clearTimeout(to);
      if (code !== 0) return resolve({ error: 'ssh exit ' + code + ': ' + errT.slice(0, 200) });
      try { resolve({ payload: JSON.parse(out) }); }
      catch { resolve({ error: '远端返回非 JSON: ' + out.slice(0, 200) }); }
    });
  });
}

// ---- 推送主循环 ----
async function pumpOnce(reason) {
  const wins = (BrowserWindowRef ? BrowserWindowRef.getAllWindows() : []).filter((w) => w && !w.isDestroyed() && w.webContents);
  if (!wins.length) { debugLog(reason, 'wins=0 skip'); return; }
  const wantLists = await Promise.all(wins.map((w) =>
    Promise.race([
      w.webContents.executeJavaScript('window.__zusageWantSids||null', true).catch(() => null),
      new Promise((r) => setTimeout(() => r(null), WANT_TIMEOUT_MS)),
    ])));
  const sids = [];
  for (const list of wantLists) for (const s of parseWants(list)) if (!sids.includes(s)) sids.push(s);
  if (!sids.length) debugLog(reason, 'wants empty → today-only push');   // draft/新建任务页：无会话 sid 可上报，仍查推 today-only payload（workerQuery([]) recent 空、today 照算）让 overlay 退出加载态并持续显示今日合计
  let payload;
  try {
    payload = await workerQuery(sids);
  } catch (e) {
    debugLog(reason, 'query FAIL', String((e && e.message) || e));
    LOG('查询失败(' + reason + '):', String((e && e.message) || e));
    return;
  }
  // SSH 分流：本地不存在的 sid 且负缓存外（§7）；ssh 失败 60s 退避期内整体跳过（I-1）
  const unknown = sids.filter((s) => shouldQueryRemote(s, payload.known, config, remoteNegOk, Date.now()));
  let remoteMerged = false;
  if (unknown.length && shouldFetchRemote(unknown, remoteFailAt, Date.now(), REMOTE_FAIL_BACKOFF_MS)) {
    const r = await fetchRemote(unknown);
    if (r.error) {
      remoteFailAt = Date.now();                 // 失败退避 60s
      remoteError = r.error;
      LOG('远端查询失败:', r.error);
    } else if (r.payload) {
      remoteError = '';
      const knownRemote = new Set((r.payload.recent || []).map((x) => x.sid));
      for (const s of unknown) {
        if (knownRemote.has(s)) remoteNegOk.delete(s);
        else remoteNegOk.set(s, Date.now() + REMOTE_NEG_OK_MS);  // 远端也没有 → 负缓存 2min
      }
      payload.recent = [...(payload.recent || []), ...(r.payload.recent || [])];
      if (r.payload.today) payload.remote_today = r.payload.today;
      remoteMerged = true;
    }
  } else {
    remoteError = '';
  }
  payload.remote_error = remoteError;
  // 远程会话聚焦期间按 poll_ms 轮询（本地 fs.watch 收不到远端写入，§4.1）
  if (remoteMerged && config.remote.poll_ms >= 1000) {
    if (!remoteTimer) remoteTimer = setInterval(() => pumpOnce('remote-poll'), config.remote.poll_ms);
  } else if (remoteTimer && !remoteMerged) {
    clearInterval(remoteTimer);
    remoteTimer = null;
  }
  const code = 'window.__zusageUpdate(' + escapeForExecuteJavaScript(JSON.stringify(payload)) + ')';
  let pushed = 0;
  for (const w of wins) {
    try { w.webContents.executeJavaScript(code, true).then(() => { pushed++; }, () => {}); } catch {}
  }
  debugLog(reason, 'pushed_pending=' + wins.length, 'sids=' + sids.join(',').slice(0, 120), 'known=' + (payload.known || []).length);
  lastPumpAt = Date.now();
}

function schedulePump() {
  if (workerDisabled) return;
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    const wait = MIN_INTERVAL_MS - (Date.now() - lastPumpAt);
    if (wait > 0) { debounceTimer = setTimeout(() => pumpOnce('debounce'), wait); return; }
    pumpOnce('watch');
  }, DEBOUNCE_MS);
}

// ---- overlay 注入（文件缺失时跳过不崩，Task 4 阶段 overlay 尚未就位）----
function attach(win) {
  try {
    if (!win || win.isDestroyed() || !win.webContents) return;
    const inject = () => {
      if (!overlaySrc || win.isDestroyed()) return;
      try { win.webContents.executeJavaScript(overlaySrc, true).catch(noop); } catch {}
    };
    win.webContents.on('did-finish-load', inject);
  } catch {}
}

// ---- 启动（Electron 主进程守卫：node 下 import 本模块零副作用，供单测）----
if (process.versions.electron) {
  const { app, BrowserWindow } = await import('electron');
  BrowserWindowRef = BrowserWindow;
  loadConfig();
  app.whenReady().then(() => {
    try {
      overlaySrc = readFileSync(new URL('./zc-usage-overlay.js', import.meta.url), 'utf8');
    } catch {
      LOG('overlay 文件缺失，跳过注入（仅数据推送）');
    }
    const dbDir = join(homedir(), '.zcode', 'cli', 'db');
    try {
      if (existsSync(dbDir)) watch(dbDir, schedulePump);
      else LOG('db 目录不存在，仅心跳轮询:', dbDir);
    } catch (e) {
      LOG('fs.watch 失败，仅心跳轮询:', String((e && e.message) || e));
    }
    setInterval(() => pumpOnce('heartbeat'), HEARTBEAT_MS);
    app.on('browser-window-created', (_e, win) => attach(win));
    for (const w of BrowserWindow.getAllWindows()) attach(w);
    pumpOnce('boot');
    // 启动加速：boot 时 overlay 常刚注入、__zusageWantSids 未就绪（协调器 600ms 首 tick 才写），
    // 若只等 fs.watch/30s 心跳，加载态会空转到心跳——补三次抢首帧（wants 空时 pumpOnce 立即返回，代价可忽略）
    [1000, 3000, 8000].forEach((ms) => setTimeout(() => pumpOnce('boot-retry'), ms));
  });
}
