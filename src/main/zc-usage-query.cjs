'use strict';
/* ZCode token 用量查询体（zc-usage-query.cjs）
 * 口径唯一依据：doc/20260930-设计文档-token用量状态栏重写.md §5 + §13（裁决 D1~D8）。
 * 双模式：worker（泵经 new Worker(src,{eval:true}) 载入，见文件尾 worker 段）+ CLI（node 本文件 <sid...> [remote]）。
 * 全程只读：DatabaseSync readOnly，打开前 existsSync 防新建空库。
 *
 * 计入规则（§5.1 + D1）：
 *   W      = query_source IN ('main_turn','target_completion_verification') AND status IN ('completed','cancelled')
 *            （cancelled 计入=钱已花；error 不计；标题类杂项 session_title/goal_summary_title 排除；
 *              target_completion_verification 是 turn_id=null 的 10 万级真实校验消耗，计入防低估）
 *   SAMPLE = query_source='main_turn' AND turn_id IS NOT NULL AND status='completed'
 *            （①② 瞬时样本只取挂轮的主循环完成行，D2）
 *   token 口径（D7 包含制）：input_tokens 已含全量上下文，cache_read 是其中命中缓存的部分；
 *            total = computed_total_tokens（= input + output）；reasoning 含于 output。
 */

const { DatabaseSync } = require('node:sqlite');
const { existsSync } = require('fs');
const path = require('path');
const os = require('os');

// ---- 口径常量（与上面注释一一对应，改口径先改设计文档再同步这里）----
const W = "query_source IN ('main_turn','target_completion_verification') AND status IN ('completed','cancelled')";
const SAMPLE = "query_source='main_turn' AND turn_id IS NOT NULL AND status='completed'";
const TURNS = "status IN ('completed','cancelled')";           // ③ 本轮/轮数：turn_usage 官方预聚合（D3）
const TOOLS_W = "status IN ('completed','error')";             // ⑤ 工具：running 行不计（原版同款）
const SUB_W = "query_source='subagent'";                       // ⑦ 子代理行标记（D4）
const SID_RE = /^[A-Za-z0-9_-]{1,80}$/;                        // sid 白名单（防注入，§7）
const SUB_ACTIVE_MS = 5 * 60 * 1000;                           // 子代理"运行中"近似窗口（D4：无 running 态）
const ACTIVE_MS = 30 * 1000;                                   // 会话 active（原版口径）

// 上下文窗口降级链后两层（§5.3 + D8）：⚙ 覆盖在 overlay localStorage，本层只管表 + 默认
const DEFAULT_WINDOW = 128000;
const MODEL_WINDOW_EXACT = new Map([                           // key 统一小写比较
  ['glm-5.3', 1000000],
  ['glm-5.3-flash', 1000000],
]);
function lookupWindow(modelId) {
  if (!modelId) return { w: DEFAULT_WINDOW, auto: false };
  if (/\[1m\]/i.test(modelId)) return { w: 1000000, auto: true };          // [1M] 后缀命名规律（D8）
  const hit = MODEL_WINDOW_EXACT.get(String(modelId).toLowerCase());
  if (hit) return { w: hit, auto: true };
  return { w: DEFAULT_WINDOW, auto: false };
}

// 今日 0 点（本地时区）毫秒——⑥ 今日边界
function localDayStartMs(now) {
  const d = now ? new Date(now) : new Date();
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

function openDb() {
  const p = path.join(os.homedir(), '.zcode', 'cli', 'db', 'db.sqlite');
  if (!existsSync(p)) return null;                              // db 不存在 → 调用方按"无数据"处理（§8）
  try {
    return new DatabaseSync(p, { readOnly: true });             // 只读优先（WAL 竞态时可能失败）
  } catch {
    return new DatabaseSync(p);                                 // 回退普通打开，仍全程只 SELECT（§4.1）
  }
}

// 会话行快照（契约表 §13.3 逐字段；零值 stub 结构完整——overlay 零值渲染依赖）
function sessionSnapshot(db, sid) {
  const now = Date.now();
  const s = db.prepare('SELECT title, parent_id, summary_additions a, summary_deletions d, summary_files f FROM session WHERE id=?').get(sid);

  // ④ 会话累计：model_usage W 聚合（D1）
  const u = db.prepare(`SELECT COUNT(*) requests, COALESCE(SUM(input_tokens),0) input,
      COALESCE(SUM(output_tokens),0) output, COALESCE(SUM(reasoning_tokens),0) reasoning,
      COALESCE(SUM(cache_read_input_tokens),0) cache_read, COALESCE(SUM(cache_creation_input_tokens),0) cache_write,
      COALESCE(SUM(computed_total_tokens),0) total, COALESCE(SUM(tool_call_count),0) tool_calls,
      COALESCE(SUM(retry_count),0) retries, MAX(completed_at) lastAt
    FROM model_usage WHERE session_id=? AND ${W}`).get(sid);

  // ② 上下文样本：最近挂轮主循环完成行（D2 + D7：上下文 = input_tokens 包含制）
  const ctxRow = db.prepare(`SELECT input_tokens, model_id FROM model_usage
    WHERE session_id=? AND ${SAMPLE} ORDER BY completed_at DESC LIMIT 1`).get(sid);
  // ① 速度样本：另需 first_token_at 非空（D2；生成耗时 = completed-first_token 毫秒，D7 时间戳毫秒实证）
  const spRow = db.prepare(`SELECT output_tokens, completed_at, first_token_at, duration_ms,
      COALESCE(time_to_first_token_ms,0) ttft, model_id FROM model_usage
    WHERE session_id=? AND ${SAMPLE} AND first_token_at IS NOT NULL ORDER BY completed_at DESC LIMIT 1`).get(sid);

  // ② 超窗告警时间戳：error 行单独查（被计入规则排除，§5.2②）
  const excRow = db.prepare(`SELECT MAX(completed_at) m FROM model_usage
    WHERE session_id=? AND status='error' AND context_exceeded=1`).get(sid);

  // ③ 本轮 + 轮数：turn_usage 官方预聚合（D3）
  const turnCount = db.prepare(`SELECT COUNT(*) n FROM turn_usage WHERE session_id=? AND ${TURNS}`).get(sid).n;
  const t = db.prepare(`SELECT COALESCE(model_request_count,0) requests, COALESCE(model_retry_count,0) retries,
      COALESCE(tool_call_count,0) tool_calls, COALESCE(tool_error_count,0) tool_errors,
      COALESCE(input_tokens,0) input, COALESCE(output_tokens,0) output, COALESCE(reasoning_tokens,0) reasoning,
      COALESCE(cache_read_input_tokens,0) cache_read, COALESCE(cache_creation_input_tokens,0) cache_write,
      COALESCE(computed_total_tokens,0) total, COALESCE(duration_ms,0) duration_ms,
      COALESCE(time_to_first_token_ms,0) ttft_ms
    FROM turn_usage WHERE session_id=? AND ${TURNS} ORDER BY completed_at DESC LIMIT 1`).get(sid);

  // ⑤ 工具：tool_usage 按工具名聚合（TOOLS_W：running 不计）
  const toolRows = db.prepare(`SELECT tool_name name, COUNT(*) count, COALESCE(SUM(duration_ms),0) duration_ms,
      SUM(CASE WHEN status='error' THEN 1 ELSE 0 END) errors
    FROM tool_usage WHERE session_id=? AND ${TOOLS_W} GROUP BY tool_name ORDER BY count DESC, name`).all(sid);

  // ⑦ 子代理：model_usage subagent 行按子代理 sid 聚合（D4；独立统计不入主会话）
  const subRows = db.prepare(`SELECT m.session_id sid, s.title title, MAX(m.agent) agent,
      COUNT(*) requests, COALESCE(SUM(m.computed_total_tokens),0) total,
      COALESCE(SUM(m.input_tokens),0) input, COALESCE(SUM(m.output_tokens),0) output,
      COALESCE(SUM(m.cache_read_input_tokens),0) cache_read, COALESCE(SUM(m.reasoning_tokens),0) reasoning,
      COALESCE(SUM(m.cache_creation_input_tokens),0) cache_write, MAX(m.completed_at) last
    FROM model_usage m LEFT JOIN session s ON s.id=m.session_id
    WHERE ${SUB_W} AND m.session_id IN (SELECT id FROM session WHERE parent_id=?)
    GROUP BY m.session_id ORDER BY last DESC`).all(sid);

  const win = lookupWindow((spRow && spRow.model_id) || (ctxRow && ctxRow.model_id));
  const lastAt = u.lastAt || 0;
  const tps = spRow && spRow.completed_at > spRow.first_token_at
    ? Math.round(spRow.output_tokens * 1000 / (spRow.completed_at - spRow.first_token_at)) : 0;

  return {
    sid,
    title: (s && s.title) || '',
    active: !!lastAt && now - lastAt < ACTIVE_MS,
    parent: (s && s.parent_id) || null,
    // ④
    turns: turnCount, requests: u.requests,
    input: u.input, output: u.output, reasoning: u.reasoning,
    cache_read: u.cache_read, cache_write: u.cache_write, total: u.total,
    tool_calls: u.tool_calls, retries: u.retries,
    // ②（D7：ctx = input_tokens）
    ctx: ctxRow ? ctxRow.input_tokens : 0,
    context_window: win.w, context_auto: win.auto,
    ctx_exc: (excRow && excRow.m) || 0,
    // ①（无可算行全 0 + model:''，overlay 显示"—"）
    last: spRow
      ? { duration_ms: spRow.duration_ms, ttft_ms: spRow.ttft, model: spRow.model_id || '', tps }
      : { duration_ms: 0, ttft_ms: 0, model: (ctxRow && ctxRow.model_id) || '', tps: 0 },
    // ③（无轮 = _EMPTY_TURN 结构）
    last_turn: t
      ? { requests: t.requests, retries: t.retries, tool_calls: t.tool_calls, tool_errors: t.tool_errors,
          input: t.input, output: t.output, reasoning: t.reasoning, cache_read: t.cache_read,
          cache_write: t.cache_write, total: t.total, duration_ms: t.duration_ms, ttft_ms: t.ttft_ms }
      : { requests: 0, retries: 0, tool_calls: 0, tool_errors: 0, input: 0, output: 0, reasoning: 0,
          cache_read: 0, cache_write: 0, total: 0, duration_ms: 0, ttft_ms: 0 },
    // ⑤
    tools: {
      total: toolRows.reduce((a, r) => a + r.count, 0),
      errors: toolRows.reduce((a, r) => a + (r.errors || 0), 0),
      list: toolRows,
    },
    // ⑦（task 恒空串：§12 边界，不解析任务名）
    sub: {
      requests: subRows.reduce((a, r) => a + r.requests, 0),
      total: subRows.reduce((a, r) => a + r.total, 0),
      input: subRows.reduce((a, r) => a + r.input, 0),
      output: subRows.reduce((a, r) => a + r.output, 0),
      cache_read: subRows.reduce((a, r) => a + r.cache_read, 0),
      reasoning: subRows.reduce((a, r) => a + r.reasoning, 0),
      cache_write: subRows.reduce((a, r) => a + r.cache_write, 0),
      active: subRows.some((r) => r.last && now - r.last < SUB_ACTIVE_MS),
      list: subRows.map((r) => ({
        sid: r.sid, agent: String(r.agent || 'subagent').replace(/^zcode-/, ''), title: r.title || '', task: '',
        requests: r.requests, total: r.total, input: r.input, output: r.output,
        cache_read: r.cache_read, reasoning: r.reasoning, cache_write: r.cache_write,
        last: r.last || 0, active: !!(r.last && now - r.last < SUB_ACTIVE_MS),
      })),
    },
    // 代码变更（④ 明细，session 表 summary 三列）
    code: s ? { add: s.a, del: s.d, files: s.f } : { add: null, del: null, files: null },
    // 时间
    updated: lastAt ? new Date(lastAt).toTimeString().slice(0, 8) : '',
    last_at: lastAt,
  };
}

// ⑥ 今日合计：W + 今日 0 点（本地时区）起，跨会话（D1/D7）
function todayUsage(db) {
  const r = db.prepare(`SELECT COUNT(*) requests, COALESCE(SUM(input_tokens),0) input,
      COALESCE(SUM(output_tokens),0) output, COALESCE(SUM(reasoning_tokens),0) reasoning,
      COALESCE(SUM(cache_read_input_tokens),0) cache_read, COALESCE(SUM(cache_creation_input_tokens),0) cache_write,
      COALESCE(SUM(computed_total_tokens),0) total
    FROM model_usage WHERE ${W} AND started_at >= ?`).get(localDayStartMs());
  return r;
}

// 组装 payload：按需查询——pane 报什么 sid 算什么 sid，无快照池无轻量行（R1 根除）
function buildPayload(db, sids) {
  const legal = [], dropped = [];
  for (const s of Array.isArray(sids) ? sids : []) {
    if (typeof s === 'string' && SID_RE.test(s) && !legal.includes(s)) legal.push(s);
    else dropped.push(s);
  }
  const recent = db ? legal.map((sid) => sessionSnapshot(db, sid)) : [];
  return { recent, today: db ? todayUsage(db) : null, dropped };
}

module.exports = { openDb, sessionSnapshot, todayUsage, buildPayload, lookupWindow, W, SAMPLE, TURNS };

// ---- CLI 模式：node zc-usage-query.cjs <sid...> [remote] ----
// 输出与 worker result.payload 同构；尾参 remote 时 recent 各行带 remote:true（远端部署形态，泵直接合并 §4.1）
if (require.main === module) {
  const argv = process.argv.slice(2);
  const remote = argv[argv.length - 1] === 'remote';
  const sids = (remote ? argv.slice(0, -1) : argv).filter((s) => SID_RE.test(s));
  const db = openDb();
  if (!db) {
    console.log(JSON.stringify({ recent: [], today: null, dropped: argv, error: 'db not found' }));
    process.exit(0);
  }
  const payload = buildPayload(db, sids);
  if (remote) for (const r of payload.recent) r.remote = true;
  console.log(JSON.stringify(payload));
}

// ---- worker 模式（泵 readFileSync 本文件后 new Worker(src,{eval:true}) 载入）----
// 消息协议（Task 4 泵侧依赖）：泵→worker {type:'query', sids:[...], seq}；
// worker→泵 {type:'result', seq, payload:{recent,today}} 或 {type:'error', seq, message}。
// 单会话快照与 today 各 2s TTL 缓存（§5.4，扛 fs.watch 抖动期的重复聚合）。
const { isMainThread, parentPort } = require('worker_threads');
if (!isMainThread && parentPort) {
  let db = null;
  const snapCache = new Map();        // sid -> { snap, at }
  let todayCache = null;              // { v, at }
  const TTL_MS = 2000;
  parentPort.on('message', (m) => {
    if (!m || m.type !== 'query') return;
    try {
      if (!db) db = openDb();         // db 尚未建库时逐次重试打开（ZCode 首启竞态）
      let recent = [];
      let today = null;
      const seen = new Set();
      if (db) {
        recent = [];
        for (const sid of Array.isArray(m.sids) ? m.sids : []) {
          if (typeof sid !== 'string' || !SID_RE.test(sid) || seen.has(sid)) continue;
          seen.add(sid);
          const c = snapCache.get(sid);
          const snap = c && Date.now() - c.at < TTL_MS ? c.snap : sessionSnapshot(db, sid);
          snapCache.set(sid, { snap, at: Date.now() });
          recent.push(snap);
        }
        if (!todayCache || Date.now() - todayCache.at > TTL_MS) todayCache = { v: todayUsage(db), at: Date.now() };
        today = todayCache.v;
      }
      // known：legal sids 中本地真实存在的（session 表或 model_usage 有行，§7 双重白名单）——泵侧 SSH 分流依据
      const known = [];
      if (db) for (const sid of seen) {
        const hit = db.prepare('SELECT (SELECT COUNT(*) FROM session WHERE id=?) a, (SELECT COUNT(*) FROM model_usage WHERE session_id=?) b').get(sid, sid);
        if (hit.a + hit.b > 0) known.push(sid);
      }
      parentPort.postMessage({ type: 'result', seq: m.seq, payload: { recent, today, known } });
    } catch (e) {
      parentPort.postMessage({ type: 'error', seq: m.seq, message: String((e && e.stack) || e) });
    }
  });
}
