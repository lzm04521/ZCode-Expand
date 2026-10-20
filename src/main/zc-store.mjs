/* ZCode-Expand · 扩展数据存储 + BigModel 账号切换（host 进程注入）
 * ---------------------------------------------------------------------------
 * 注入到 out/host/zcode-expand/zc-store.mjs（host 的 settings 服务进程）。
 * out/host/index.js 的读/写挂钩处通过 globalThis.__ZC_XP_STORE__ 调用：
 *   merge(settings)          读点：把 zcode-expand.json 的 projectRemarks / accounts /
 *                                  zcAccountSwitch 并进 settings
 *   extract(patch, merged)   写点：从 patch 中拆出扩展键落 store，并把它们从
 *                                  落盘内容剔除（setting.json 保持官方纯净）
 *   saveAccount({...})       OAuth 落库成功后保存账号快照（persistOAuthSession 尾部挂钩）
 *
 * 数据真身 ~/.zcode/v2/zcode-expand.json（与官方 setting.json 同目录但不同名，
 * 官方永远不会读写它——升级免疫）。原子写（tmp+rename），读侧带 mtime 缓存，
 * 手改 JSON 文件后 mtime 变化即失效重读。
 *
 * 结构兼容（务必保持）：normalizeStore 透传未知键，任何一次写入都不得把
 * 已知扩展键之外的字段抹掉——否则改一次备注就会丢掉全部账号快照。
 *
 * 账号切换（切 BigModel 凭据）走「settings 字段状态机」：
 *   渲染层 update({zcAccountSwitch:{id,state:"pending",issuedAt}})
 *     → 本模块在 extract 里接住请求、落 pending 状态、串行执行切换
 *     → 执行完回写 done/failed + error 到 store
 *   渲染层通过 settingService.get()（读点 merge）轮询到结果后做收尾刷新。
 * ---------------------------------------------------------------------------
 */
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';

const STORE_FILE = join(homedir(), '.zcode', 'v2', 'zcode-expand.json');

// 只管理 BigModel 家族；Z.ai 不落快照、不参与切换
const PROVIDER = 'bigmodel';
const ACCOUNT_FORMAT_VERSION = 1;
// 切换请求有效期：宿主只接受"刚发出"的请求。store 里的 zcAccountSwitch 会随
// merge 回流到 settings，进而出现在后续任何一次 update 的合并输入里；没有这个
// 时间窗 + 单调去重，一次无关的设置写入就可能把历史切换请求重复触发一遍。
const SWITCH_REQUEST_TTL_MS = 2 * 60 * 1000;
// 切换前只读探活：用快照 access_token 打官方 BigModel userinfo（getCustomerInfo）。
// 明确失效/错配则中止切换；超时与网络异常一律放行——不得把网络故障判成凭据失效。
const PROBE_TIMEOUT_MS = 6000;
// health 合法状态：ok 校验通过 / invalid 明确失效 / mismatch 归属不一致 / unknown 无法判定
const HEALTH_STATES = new Set(['ok', 'invalid', 'mismatch', 'unknown']);
// 旧备注迁移失败最多尝试次数；达到后标记 save-failed，避免每次启动反复写
const PROJECT_NAME_MIGRATION_MAX_ATTEMPTS = 3;
// 迁移串行守卫：同一进程内重复调用复用同一次执行
let remarksMigrationPromise = null;
// 闲置保活：服务端 session 按不活跃清理（实测闲置 2~5 天即 200 空 body），定期带
// 快照 token 打一次 getCustomerInfo 维持。取 4h 而非 12h：定时器只活到会话结束，
// 单次运行不足 12h 时 12h 定时器可能整日不触发（方案 §3.3）。
const KEEPALIVE_INTERVAL_MS = 4 * 60 * 60 * 1000;
// 首轮延迟：避开启动高峰，覆盖 host OAuth 实例（__ZC_XP_OAUTH_RPC__）就绪时间
const KEEPALIVE_START_DELAY_MS = 2 * 60 * 1000;
// sweep 状态：lastSweepAt 供 diag 展示；sweeping 防手工 sweepNow 与定时轮重叠
let keepaliveLastSweepAt = 0;
let keepaliveSweeping = false;
let keepaliveTimer = null;

function logError(op, detail) {
  console.error(`[ZCode-Expand] store ${op}：`, detail);
}

function logInfo(...args) {
  console.log('[ZCode-Expand] store', ...args);
}

// mtime 缓存：settings get 走读点，避免每次落盘 IO；写后与外部改动都会刷新
let cache = null; // { mtimeMs, store }
// store 写入串行队列：并发写入（切账号 + 备注 + 登录快照）不得互相覆盖
let writeQueue = Promise.resolve();
// 切换执行串行队列：后到覆盖先到（渲染层用 issuedAt 丢弃过期回包）
let switchQueue = Promise.resolve();
// 已处理过的切换请求时间戳，单调递增，重复请求直接丢弃
let lastHandledIssuedAt = 0;

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** JSON 深拷贝（账号资料来自官方对象，可能带原型/循环引用，落盘前统一净化） */
function jsonClone(value) {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// 净化：store 是明文 JSON，读写两侧都不信任入参
// ---------------------------------------------------------------------------

function sanitizeRemarks(value) {
  if (!isPlainObject(value)) return {};
  const out = {};
  for (const key of Object.keys(value)) {
    if (typeof value[key] === 'string') out[key] = value[key];
  }
  return out;
}

/** 旧工作区路径与官方项目根目录的统一比较形式。Windows 盘符/UNC 大小写不敏感。 */
function normalizeProjectPath(value) {
  let path = String(value ?? '').trim();
  if (!path) return '';
  if (/^[A-Za-z]:[\\/]/.test(path) || path.startsWith('\\\\')) {
    return path.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
  }
  return path.replace(/\\/g, '/').replace(/\/+$/, '');
}

/** 迁移状态只保留已知字段；未知/损坏内容不会进入后续写入 */
function migrationState(value) {
  const src = isPlainObject(value) ? value : {};
  return {
    version: 1,
    migrated: isPlainObject(src.migrated) ? { ...src.migrated } : {},
    skipped: isPlainObject(src.skipped) ? { ...src.skipped } : {},
    attempts: isPlainObject(src.attempts) ? { ...src.attempts } : {},
    ...(Number.isFinite(src.lastRunAt) ? { lastRunAt: src.lastRunAt } : {}),
    ...(Number.isFinite(src.doneAt) ? { doneAt: src.doneAt } : {}),
  };
}

/** 官方 tokenSet 形态：{accessToken, refreshToken?, zcodeJwtToken?}，accessToken 必需 */
function sanitizeTokenSet(value) {
  if (!isPlainObject(value)) return null;
  const out = {};
  for (const key of ['accessToken', 'refreshToken', 'zcodeJwtToken']) {
    if (typeof value[key] === 'string' && value[key]) out[key] = value[key];
  }
  return out.accessToken ? out : null;
}

function sanitizeAccount(raw) {
  if (!isPlainObject(raw) || typeof raw.id !== 'string' || !raw.id) return null;
  const tokenSet = sanitizeTokenSet(raw.tokenSet);
  if (!tokenSet) return null;
  const profile = isPlainObject(raw.profile) ? jsonClone(raw.profile) : null;
  if (!profile) return null;
  // health 走白名单：不显式放行会在每次 store 读写时被 sanitize 抹掉
  const health = sanitizeHealth(raw.health);
  return {
    id: raw.id,
    provider: typeof raw.provider === 'string' ? raw.provider : PROVIDER,
    displayName: typeof raw.displayName === 'string' ? raw.displayName : '',
    username: typeof raw.username === 'string' ? raw.username : '',
    avatarUrl: typeof raw.avatarUrl === 'string' ? raw.avatarUrl : '',
    tokenSet,
    profile,
    savedAt: Number.isFinite(raw.savedAt) ? raw.savedAt : Date.now(),
    formatVersion: Number.isFinite(raw.formatVersion) ? raw.formatVersion : ACCOUNT_FORMAT_VERSION,
    ...(health ? { health } : {}),
  };
}

function sanitizeAccounts(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const out = [];
  for (const raw of value) {
    const account = sanitizeAccount(raw);
    if (!account || seen.has(account.id)) continue;
    seen.add(account.id);
    out.push(account);
  }
  return out;
}

/** 探活结果净化：状态白名单 + 时间戳；detail 只留文案，绝不落令牌 */
function sanitizeHealth(value) {
  if (!isPlainObject(value)) return null;
  if (!HEALTH_STATES.has(value.state)) return null;
  const out = {
    state: value.state,
    checkedAt: Number.isFinite(value.checkedAt) ? value.checkedAt : Date.now(),
  };
  if (typeof value.detail === 'string' && value.detail) out.detail = value.detail.slice(0, 200);
  return out;
}

function sanitizeSwitchState(value) {
  if (!isPlainObject(value) || typeof value.id !== 'string' || !value.id) return null;
  const state = value.state === 'done' || value.state === 'failed' ? value.state : 'pending';
  return {
    id: value.id,
    state,
    issuedAt: Number.isFinite(value.issuedAt) ? value.issuedAt : Date.now(),
    ...(Number.isFinite(value.finishedAt) ? { finishedAt: value.finishedAt } : {}),
    ...(typeof value.error === 'string' && value.error ? { error: value.error } : {}),
  };
}

// ---------------------------------------------------------------------------
// 读写
// ---------------------------------------------------------------------------

async function statMtime() {
  try {
    return (await stat(STORE_FILE)).mtimeMs;
  } catch {
    return 0;
  }
}

function emptyStore() {
  return { version: 1, projectRemarks: {}, accounts: [] };
}

function normalizeStore(parsed) {
  const src = isPlainObject(parsed) ? parsed : {};
  const out = {};
  // 未知键原样保留：后续任何一次写入都不能把手工加进去的数据抹掉
  for (const key of Object.keys(src)) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
    out[key] = src[key];
  }
  if (!Number.isFinite(out.version)) out.version = 1;
  out.projectRemarks = sanitizeRemarks(out.projectRemarks);
  out.accounts = sanitizeAccounts(out.accounts);
  const sw = sanitizeSwitchState(out.zcAccountSwitch);
  if (sw) out.zcAccountSwitch = sw;
  else delete out.zcAccountSwitch;
  return out;
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

/**
 * 串行的读-改-写。mutator(next) 直接改 next 并返回是否需要落盘。
 * @returns {Promise<object>} 变更后的 store（未落盘时是内存副本）
 */
function mutateStore(mutator) {
  const run = writeQueue.then(async () => {
    const current = await readStore();
    const next = { ...current };
    if (!mutator(next)) return next;
    await writeStore(next);
    return next;
  });
  writeQueue = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

// ---------------------------------------------------------------------------
// 账号快照
// ---------------------------------------------------------------------------

/** 官方 user_info → 快照记录（id 用官方 profile.id，切换时按它定位） */
function buildAccount({ tokenSet, profile }) {
  const cleanProfile = isPlainObject(profile) ? jsonClone(profile) : null;
  if (!cleanProfile) return null;
  const userId = typeof cleanProfile.id === 'string' ? cleanProfile.id.trim() : '';
  if (!userId) return null;
  const cleanTokens = sanitizeTokenSet(tokenSet);
  if (!cleanTokens) return null;
  return {
    id: `${PROVIDER}:${userId}`,
    provider: PROVIDER,
    displayName: typeof cleanProfile.displayName === 'string' ? cleanProfile.displayName : '',
    username: typeof cleanProfile.username === 'string' ? cleanProfile.username : '',
    avatarUrl: typeof cleanProfile.avatarUrl === 'string' ? cleanProfile.avatarUrl : '',
    tokenSet: cleanTokens,
    profile: cleanProfile,
    savedAt: Date.now(),
    formatVersion: ACCOUNT_FORMAT_VERSION,
  };
}

/**
 * OAuth 落库成功后保存/刷新账号快照。同 id 幂等覆盖。
 * 刻意不抛异常：调用点挂在官方登录流程尾部，快照失败不能影响登录。
 */
async function saveAccount({ provider, tokenSet, profile } = {}) {
  try {
    if (provider !== PROVIDER) return false;
    const account = buildAccount({ tokenSet, profile });
    if (!account) {
      logError('快照跳过（资料或令牌不完整）', String(provider));
      return false;
    }
    await mutateStore((store) => {
      const list = Array.isArray(store.accounts) ? store.accounts.slice() : [];
      const index = list.findIndex((it) => it && it.id === account.id);
      if (index >= 0) list[index] = account;
      else list.push(account);
      store.accounts = list;
      return true;
    });
    logInfo('账号快照已保存：', account.displayName || account.id);
    return true;
  } catch (err) {
    logError('保存账号快照失败', err?.message ?? err);
    return false;
  }
}

// ---------------------------------------------------------------------------
// 账号切换
// ---------------------------------------------------------------------------

function oauthService() {
  // 优先用渲染层真正在用的那台 OAuthService（RPC 注册表里的实例）：代际计数与
  // onProviderLogout 回调都挂在实例上，打在 agent/CUA 那台上不会让渲染层失效。
  // 两者共用同一份 credentials.json（credentialService 每次直读文件、无缓存），
  // 所以即便只拿到备用句柄，凭据读写依然正确。
  const preferred = globalThis.__ZC_XP_OAUTH_RPC__;
  if (preferred && preferred.repo) return preferred;
  const service = globalThis.__ZC_XP_OAUTH__;
  return service && service.repo ? service : null;
}

// ---------------------------------------------------------------------------
// 切换前只读探活（口径见 doc/20261014-实施方案-账号切换前探活.md §3.2）
// ---------------------------------------------------------------------------

/** 快照 id 形如 `bigmodel:<user_id>`，取后缀与官方 userinfo 的 customerNumber 比对 */
function accountUserId(account) {
  const id = typeof account?.id === 'string' ? account.id : '';
  const cut = id.indexOf(':');
  return cut >= 0 ? id.slice(cut + 1) : '';
}

function firstNonEmptyString(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

/** 与官方 isUnauthorizedError 同口径（host 侧正则 \b401\b|\b403\b|unauthorized|forbidden） */
function isUnauthorizedText(text) {
  const s = String(text ?? '').toLowerCase();
  return /\b401\b|\b403\b/.test(s) || s.includes('unauthorized') || s.includes('forbidden');
}

/** 超时保护；被丢下的请求仍可能 reject，挂空 catch 防 unhandledRejection */
function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label}超时（${ms}ms）`)), ms);
  });
  promise.catch(() => {});
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * 用快照凭据做一次只读校验：非 2xx 的 401/403 或响应无 data → invalid；
 * data 账号 id 与快照不符 → mismatch；超时/网络异常/配置缺失 → unknown（放行）。
 * 刻意不走 adapter.fetchUserInfo：它把空 body 转成占位 profile，丢掉官方最关键的
 * 失效信号（Ww 对 BigModel 的 emptyBodyMeansInvalid 口径）。
 */
async function probeAccount(account) {
  const oauth = oauthService();
  const adapters = oauth && oauth.adapters;
  if (!oauth || !adapters || typeof adapters.get !== 'function' || !oauth.apiClient) {
    return { state: 'unknown', reason: 'OAuth 服务尚未就绪' };
  }
  const adapter = adapters.get(PROVIDER);
  if (!adapter || !adapter.config || typeof adapter.config.userinfoUrl !== 'string') {
    return { state: 'unknown', reason: '探活配置不可用（adapter 缺失）' };
  }
  if (adapter.meta && adapter.meta.enabled === false) {
    return { state: 'unknown', reason: 'provider 已禁用' };
  }
  if (typeof oauth.apiClient.request !== 'function') {
    return { state: 'unknown', reason: '网络客户端不可用' };
  }
  const token = typeof account?.tokenSet?.accessToken === 'string' ? account.tokenSet.accessToken.trim() : '';
  if (!token) return { state: 'invalid', reason: '快照缺少 access_token' };

  let res;
  try {
    res = await withTimeout(
      oauth.apiClient.request(adapter.config.userinfoUrl, {
        method: 'GET',
        timeoutMs: PROBE_TIMEOUT_MS,
        // BigModel 传裸 token（官方 fetchUserInfo 同款），不带 Bearer 前缀
        headers: { Authorization: token, 'Content-Type': 'application/json' },
      }),
      PROBE_TIMEOUT_MS + 500,
      '账号探活'
    );
  } catch (err) {
    const message = String(err?.message ?? err);
    if (isUnauthorizedText(message)) return { state: 'invalid', reason: '服务端拒绝该凭据（401/403）' };
    return { state: 'unknown', reason: `无法确认：${message}` };
  }

  if (!res || res.ok !== true) {
    const status = res && typeof res.status === 'number' ? res.status : null;
    if (status === 401 || status === 403) {
      return { state: 'invalid', reason: `服务端拒绝该凭据（HTTP ${status}）` };
    }
    let text = '';
    try {
      text = await res.text();
    } catch {
      // 读不出正文不影响判定，按"无法确认"处理
    }
    if (isUnauthorizedText(text)) return { state: 'invalid', reason: '服务端拒绝该凭据（401/403）' };
    return { state: 'unknown', reason: `请求未成功（HTTP ${status ?? '未知'}）` };
  }

  let body = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  const data = isPlainObject(body) && isPlainObject(body.data) ? body.data : null;
  if (!data) return { state: 'invalid', reason: '服务端未返回账号资料（凭据可能已失效）' };
  const returnedId = firstNonEmptyString(data.customerNumber, data.customer_number, data.id);
  if (!returnedId) return { state: 'unknown', reason: '响应缺少账号标识' };
  const expected = accountUserId(account);
  if (expected && returnedId !== expected) {
    return { state: 'mismatch', reason: `凭据归属不一致（服务端返回 ${returnedId}）` };
  }
  return { state: 'ok' };
}

/** 探活结果写回快照（列表角标据此显示）；失败不阻塞主流程 */
async function setAccountHealth(id, health) {
  const clean = sanitizeHealth(health);
  if (!clean || typeof id !== 'string' || !id) return false;
  try {
    await mutateStore((store) => {
      const list = Array.isArray(store.accounts) ? store.accounts.slice() : [];
      const index = list.findIndex((it) => it && it.id === id);
      if (index < 0) return false;
      list[index] = { ...list[index], health: clean };
      store.accounts = list;
      return true;
    });
    return true;
  } catch (err) {
    logError('写入账号健康状态失败', err?.message ?? err);
    return false;
  }
}

async function setSwitchState(state) {
  const clean = sanitizeSwitchState(state);
  if (!clean) return false;
  try {
    await mutateStore((store) => {
      store.zcAccountSwitch = clean;
      return true;
    });
    return true;
  } catch (err) {
    logError('回写切换状态失败', err?.message ?? err);
    return false;
  }
}

function isFreshSwitchRequest(request) {
  if (!isPlainObject(request) || typeof request.id !== 'string' || !request.id) return false;
  // 只处理渲染层刚发出的 pending 请求；done/failed 会被 merge 回流，必须排除
  if (request.state !== 'pending') return false;
  const issuedAt = Number.isFinite(request.issuedAt) ? request.issuedAt : 0;
  if (!issuedAt) return false;
  const now = Date.now();
  if (issuedAt > now + 60 * 1000) return false;
  if (now - issuedAt > SWITCH_REQUEST_TTL_MS) return false;
  return issuedAt > lastHandledIssuedAt;
}

/** 切换失败时把凭据恢复原状（含切换前 active 家族的凭据） */
async function restoreCredentials(repo, backup) {
  try {
    const { current, previous } = backup;
    if (current.tokenSet) await repo.saveTokenSet(PROVIDER, current.tokenSet);
    else await repo.clearProvider(PROVIDER);
    if (current.profile) await repo.saveUserProfile(PROVIDER, current.profile);
    else await repo.clearUserProfile(PROVIDER);
    if (previous) {
      // 切换前 active 家族已被官方 logout 清空，按备份原样写回
      if (previous.tokenSet) await repo.saveTokenSet(previous.provider, previous.tokenSet);
      if (previous.profile) await repo.saveUserProfile(previous.provider, previous.profile);
      await repo.setActiveProvider(previous.provider);
    } else {
      await repo.setActiveProvider(null);
    }
  } catch (err) {
    logError('切换失败后的凭据回滚也失败', err?.message ?? err);
  }
}

/**
 * 用快照覆盖官方 BigModel 凭据并置为 active。
 * 不复刻官方 persistOAuthSession 的 clearProvider(互斥家族)：切换前先经官方
 * logout(旧 active) 已清掉旧会话所属家族的凭据，BigModel↔BigModel 不涉及。
 * 也刻意不用 oauth.runSessionMutation 包裹整段——logout 内部自己会进同一个
 * 串行队列，外层再包一层会自锁；切换串行由本模块的 switchQueue 保证。
 */
async function applyAccount(account) {
  const oauth = oauthService();
  if (!oauth) throw new Error('OAuth 服务尚未就绪（__ZC_XP_OAUTH__ 缺失）');
  const repo = oauth.repo;

  const previousActive = await repo.getActiveProvider();
  const backup = {
    current: {
      tokenSet: await repo.loadTokenSet(PROVIDER),
      profile: await repo.loadUserProfile(PROVIDER),
    },
    previous:
      previousActive && previousActive !== PROVIDER
        ? {
            provider: previousActive,
            tokenSet: await repo.loadTokenSet(previousActive),
            profile: await repo.loadUserProfile(previousActive),
          }
        : null,
  };

  try {
    // 官方 logout：oauthSessionGeneration+1 → clearActiveSession → notifyProviderLogout
    // （顶掉旧会话；渲染层的登出态由收尾序列重建）
    await oauth.logout(previousActive ?? undefined);
    await repo.saveTokenSet(PROVIDER, account.tokenSet);
    await repo.saveUserProfile(PROVIDER, account.profile);
    await repo.setActiveProvider(PROVIDER);
    if (typeof oauth.cancelPending === 'function') await oauth.cancelPending();
    return { previousActive };
  } catch (err) {
    await restoreCredentials(repo, backup);
    throw err;
  }
}

async function runSwitch(request) {
  const issuedAt = Number.isFinite(request.issuedAt) ? request.issuedAt : Date.now();
  try {
    const store = await readStore();
    const account = (store.accounts ?? []).find((it) => it && it.id === request.id);
    if (!account) throw new Error(`账号快照不存在：${request.id}`);

    // 探活必须在 applyAccount 之前：applyAccount 一进来就 logout 旧会话并覆盖凭据槽位，
    // 失效账号切进去只会被官方 logoutIfCurrentCredentialRequest 踢下线（见方案 §1）。
    const probe = await probeAccount(account);
    if (probe.state === 'invalid' || probe.state === 'mismatch') {
      await setAccountHealth(request.id, {
        state: probe.state,
        detail: probe.reason,
        checkedAt: Date.now(),
      });
      throw new Error(`${probe.reason}，已中止切换；请重新登录该账号后再试`);
    }
    if (probe.state === 'unknown') logInfo('账号探活无法判定（放行切换）：', probe.reason);

    await applyAccount(account);
    await setAccountHealth(request.id, { state: 'ok', checkedAt: Date.now() });
    await setSwitchState({ id: request.id, state: 'done', issuedAt, finishedAt: Date.now() });
    logInfo('已切换 BigModel 账号：', account.displayName || account.id);
  } catch (err) {
    const message = err?.message ? String(err.message) : String(err);
    await setSwitchState({
      id: request.id,
      state: 'failed',
      issuedAt,
      finishedAt: Date.now(),
      error: message,
    });
    logError('切换 BigModel 账号失败', message);
  }
}

function enqueueSwitch(request) {
  const run = switchQueue.then(
    () => runSwitch(request),
    () => runSwitch(request)
  );
  switchQueue = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

// ---------------------------------------------------------------------------
// 启动自愈：上次运行残留的 pending 一律判失败（凭据状态以官方落库为准）
// ---------------------------------------------------------------------------
(async () => {
  try {
    const store = await readStore();
    const sw = store.zcAccountSwitch;
    if (sw && sw.state === 'pending') {
      lastHandledIssuedAt = Math.max(lastHandledIssuedAt, sw.issuedAt ?? 0);
      await setSwitchState({
        id: sw.id,
        state: 'failed',
        issuedAt: sw.issuedAt,
        finishedAt: Date.now(),
        error: '切换未完成（应用已重启，凭据以官方落库为准）',
      });
      logInfo('已把残留的 pending 切换标记为 failed：', sw.id);
    }
  } catch (err) {
    logError('启动自愈失败', err?.message ?? err);
  }
})();

// ---------------------------------------------------------------------------
// 账号闲置保活（doc/20261020-实施方案-账号快照闲置保活.md）
// ---------------------------------------------------------------------------

/**
 * 对全部账号快照做一轮只读探活并回写 health（复用切换前探活的 probeAccount）。
 * 服务端 session 按不活跃清理，定期碰一次接口续命；判定口径与切换前探活一致。
 * unknown 不落 store：保住旧 checkedAt，下一轮立即重试——一次网络故障不得吃掉
 * 一个保活间隔。force=true 忽略间隔门控全量探（sweepNow 手工入口）。
 */
async function sweepKeepalive({ force = false } = {}) {
  if (keepaliveSweeping) return { ok: false, skipped: 'sweep-in-progress' };
  keepaliveSweeping = true;
  try {
    const store = await readStore();
    const results = [];
    for (const account of store.accounts ?? []) {
      if (!account) continue;
      const checkedAt = account.health?.checkedAt ?? 0;
      if (!force && Date.now() - checkedAt < KEEPALIVE_INTERVAL_MS) {
        results.push({ id: account.id, skipped: 'recent' });
        continue;
      }
      const probe = await probeAccount(account);
      if (probe.state !== 'unknown') {
        await setAccountHealth(account.id, {
          state: probe.state,
          detail: probe.reason,
          checkedAt: Date.now(),
        });
      }
      results.push({
        id: account.id,
        state: probe.state,
        ...(probe.reason ? { reason: probe.reason } : {}),
      });
    }
    keepaliveLastSweepAt = Date.now();
    logInfo('账号保活 sweep：', JSON.stringify(results));
    return { ok: true, at: keepaliveLastSweepAt, results };
  } catch (err) {
    logError('账号保活 sweep 失败', err?.message ?? err);
    return { ok: false, error: String(err?.message ?? err) };
  } finally {
    keepaliveSweeping = false;
  }
}

// 调度：首轮延迟 2 分钟，此后每 4h 一轮。timer 只活到 host 进程生命周期，
// unref 不阻止进程退出；sweepKeepalive 自身不抛，外层 catch 兜底防回归。
const runKeepaliveSweep = () =>
  sweepKeepalive().catch((err) => logError('账号保活调度异常', err?.message ?? err));
setTimeout(() => {
  runKeepaliveSweep();
  keepaliveTimer = setInterval(runKeepaliveSweep, KEEPALIVE_INTERVAL_MS);
  keepaliveTimer.unref();
}, KEEPALIVE_START_DELAY_MS).unref();

/**
 * 一次性把旧 projectRemarks 迁移为官方 projects.name。
 * 仅处理：根目录唯一匹配 + 官方名仍为默认（nameOverridden=0）的项目；
 * 官方已命名项目、无匹配、歧义匹配一律跳过。旧 projectRemarks 原样保留。
 */
async function migrateProjectRemarks(projectService) {
  if (remarksMigrationPromise) return remarksMigrationPromise;
  remarksMigrationPromise = (async () => {
    if (
      !projectService ||
      typeof projectService.readProjects !== 'function' ||
      typeof projectService.saveProject !== 'function'
    ) {
      return { ok: false, error: 'project-service-unavailable' };
    }

    const current = await readStore();
    const remarks = current.projectRemarks ?? {};
    const keys = Object.keys(remarks).filter(
      (key) => typeof remarks[key] === 'string' && remarks[key].trim()
    );
    const state = migrationState(current.projectNameMigration);
    if (state.doneAt) {
      return {
        ok: true,
        done: true,
        migrated: Object.keys(state.migrated).length,
        skipped: Object.keys(state.skipped).length,
      };
    }
    if (keys.length === 0) return { ok: true, noRemarks: true, migrated: 0, skipped: 0 };

    let projects;
    try {
      const result = await projectService.readProjects();
      projects = Array.isArray(result) ? result : Array.isArray(result?.projects) ? result.projects : [];
    } catch (err) {
      logError('读取项目列表失败（迁移稍后重试）', err?.message ?? err);
      return { ok: false, error: 'read-projects-failed' };
    }

    const rootIndex = new Map();
    for (const project of projects) {
      if (!isPlainObject(project) || project.deleted) continue;
      for (const root of Array.isArray(project.roots) ? project.roots : []) {
        const path = typeof root === 'string' ? root : root?.rootPath;
        const normalized = normalizeProjectPath(path);
        if (!normalized) continue;
        const list = rootIndex.get(normalized) ?? [];
        list.push(project);
        rootIndex.set(normalized, list);
      }
    }

    const migrated = { ...state.migrated };
    const skipped = { ...state.skipped };
    const attempts = { ...state.attempts };

    for (const key of keys) {
      if (migrated[key] || skipped[key]) continue;
      const candidates = rootIndex.get(normalizeProjectPath(key)) ?? [];
      if (candidates.length === 0) {
        skipped[key] = 'no-project';
        continue;
      }
      if (candidates.length > 1) {
        skipped[key] = 'ambiguous';
        continue;
      }
      const project = candidates[0];
      if (project.nameOverridden) {
        skipped[key] = 'official-name';
        continue;
      }
      const name = String(remarks[key]).trim();
      try {
        const saved = await projectService.saveProject({
          id: project.id,
          hostId: project.hostId,
          name,
        });
        migrated[key] = {
          projectId: project.id,
          hostId: project.hostId,
          name: typeof saved?.name === 'string' ? saved.name : name,
          at: Date.now(),
        };
        delete attempts[key];
        logInfo('旧备注已迁移为官方项目名称：', project.id);
      } catch (err) {
        const count = (Number(attempts[key]) || 0) + 1;
        attempts[key] = count;
        if (count >= PROJECT_NAME_MIGRATION_MAX_ATTEMPTS) {
          skipped[key] = 'save-failed';
          delete attempts[key];
        }
        logError('旧备注迁移失败', `${project.id}: ${err?.message ?? err}`);
      }
    }

    const pending = keys.filter((key) => !migrated[key] && !skipped[key]);
    const next = {
      version: 1,
      migrated,
      skipped,
      attempts,
      lastRunAt: Date.now(),
      ...(pending.length === 0 ? { doneAt: Date.now() } : {}),
    };
    await mutateStore((store) => {
      if (JSON.stringify(store.projectNameMigration ?? null) === JSON.stringify(next)) return false;
      store.projectNameMigration = next;
      return true;
    });
    return {
      ok: true,
      done: pending.length === 0,
      migrated: Object.keys(migrated).length,
      skipped: Object.keys(skipped).length,
      pending: pending.length,
    };
  })().catch((err) => {
    logError('旧备注迁移异常', err?.message ?? err);
    return { ok: false, error: String(err?.message ?? err) };
  });
  return remarksMigrationPromise;
}

globalThis.__ZC_XP_STORE__ = {
  /** 读点挂钩：3.16.2 起只合并账号数据；默认保留历史版本的备注接管 */
  async merge(settings, { includeRemarks = true } = {}) {
    if (!isPlainObject(settings)) return settings;
    try {
      const store = await readStore();
      const out = { ...settings };
      if (includeRemarks && Object.keys(store.projectRemarks).length > 0) {
        out.projectRemarks = { ...store.projectRemarks };
      }
      out.accounts = store.accounts;
      if (store.zcAccountSwitch) out.zcAccountSwitch = store.zcAccountSwitch;
      return out;
    } catch (err) {
      logError('merge 失败（settings 原样返回）', err?.message ?? err);
      return settings;
    }
  },

  /**
   * 写点挂钩：patch 里的扩展键落 store，并从落盘内容剔除；includeRemarks=false 时不接管备注。
   * accounts 只由宿主维护（登录快照 / zcAccountDelete），渲染层从不提交它——
   * 官方 update 会把 patch 过一遍 zod（未知键会被剥掉），也会把合并后的设置
   * 写进 setting.json 与日志，明文令牌绝不能走这条路径。
   */
  async extract(patch, merged, { includeRemarks = true } = {}) {
    const out = isPlainObject(merged) ? { ...merged } : merged;
    try {
      if (!isPlainObject(patch) || !isPlainObject(out)) return out;

      const hasRemarks = includeRemarks && Object.hasOwn(patch, 'projectRemarks');
      const hasAccounts = Object.hasOwn(patch, 'accounts');
      const deleteRequest = isPlainObject(patch.zcAccountDelete) ? patch.zcAccountDelete : null;
      const switchRequest = isPlainObject(patch.zcAccountSwitch) ? patch.zcAccountSwitch : null;

      if (hasRemarks || hasAccounts || deleteRequest) {
        await mutateStore((store) => {
          let changed = false;
          if (hasRemarks) {
            const next = sanitizeRemarks(patch.projectRemarks);
            if (JSON.stringify(store.projectRemarks) !== JSON.stringify(next)) {
              store.projectRemarks = next;
              changed = true;
            }
          }
          if (hasAccounts) {
            const next = sanitizeAccounts(patch.accounts);
            if (JSON.stringify(store.accounts) !== JSON.stringify(next)) {
              store.accounts = next;
              changed = true;
            }
          }
          if (deleteRequest && typeof deleteRequest.id === 'string' && deleteRequest.id) {
            const list = (store.accounts ?? []).filter((it) => it && it.id !== deleteRequest.id);
            if (list.length !== (store.accounts ?? []).length) {
              store.accounts = list;
              changed = true;
            }
          }
          return changed;
        });
      }

      if (isFreshSwitchRequest(switchRequest)) {
        const issuedAt = switchRequest.issuedAt;
        lastHandledIssuedAt = issuedAt;
        await setSwitchState({ id: switchRequest.id, state: 'pending', issuedAt });
        enqueueSwitch({ id: switchRequest.id, issuedAt });
      }

      if (includeRemarks) delete out.projectRemarks;
      delete out.accounts;
      delete out.zcAccountSwitch;
      delete out.zcAccountDelete;
      return out;
    } catch (err) {
      // store 落盘失败不阻塞官方 setting.json 写入；渲染层内存值仍在，下次写入自愈。
      // projectRemarks 交回官方 setting.json（沿用既有兜底），但 accounts 与切换
      // 请求一律不回写——它们含明文令牌，不能进 setting.json / 日志。
      logError('extract 失败（本次写入未落 store）', err?.message ?? err);
      if (isPlainObject(merged)) {
        const fallback = { ...merged };
        delete fallback.accounts;
        delete fallback.zcAccountSwitch;
        delete fallback.zcAccountDelete;
        return fallback;
      }
      return merged;
    }
  },

  /** persistOAuthSession 尾部挂钩：BigModel 登录成功后存快照 */
  saveAccount,

  /** 旧 projectRemarks 一次性迁移为官方项目名称（仅默认名，详见函数说明） */
  migrateProjectRemarks,

  /** 只读探活（手工验证/排查用）：不写 store、不碰官方凭据 */
  async probe(id) {
    try {
      const store = await readStore();
      const account = (store.accounts ?? []).find((it) => it && it.id === id);
      if (!account) return { ok: false, error: `账号快照不存在：${id}` };
      const result = await probeAccount(account);
      return { ok: true, id, ...result };
    } catch (err) {
      return { ok: false, error: String(err?.message ?? err) };
    }
  },

  /** 立即强制全量保活一轮（忽略 4h 门控）：手工验证/手动保活入口 */
  async sweepNow() {
    return sweepKeepalive({ force: true });
  },

  /** 自检信息 */
  async diag() {
    try {
      const store = await readStore();
      const oauth = oauthService();
      const migration = migrationState(store.projectNameMigration);
      return {
        module: 'zcode-expand/store',
        storeFile: STORE_FILE,
        remarkCount: Object.keys(store.projectRemarks).length,
        projectNameMigration:
          migration.doneAt || Object.keys(migration.migrated).length || Object.keys(migration.skipped).length
            ? {
                doneAt: migration.doneAt ?? null,
                migrated: Object.keys(migration.migrated).length,
                skipped: Object.keys(migration.skipped).length,
                pending: Math.max(
                  0,
                  Object.keys(store.projectRemarks).length -
                    Object.keys(migration.migrated).length -
                    Object.keys(migration.skipped).length
                ),
              }
            : null,
        accountCount: (store.accounts ?? []).length,
        accounts: (store.accounts ?? []).map((it) => ({
          id: it.id,
          displayName: it.displayName,
          savedAt: it.savedAt,
          hasRefreshToken: !!it.tokenSet?.refreshToken,
          hasJwt: !!it.tokenSet?.zcodeJwtToken,
          health: it.health ?? null,
        })),
        switchState: store.zcAccountSwitch ?? null,
        keepalive: {
          intervalMs: KEEPALIVE_INTERVAL_MS,
          lastSweepAt: keepaliveLastSweepAt || null,
          timerActive: !!keepaliveTimer,
        },
        oauthReady: !!oauth,
        oauthHandle: globalThis.__ZC_XP_OAUTH_RPC__ ? 'rpc' : globalThis.__ZC_XP_OAUTH__ ? 'host' : null,
        activeProvider: oauth ? await oauth.repo.getActiveProvider() : null,
      };
    } catch (err) {
      return { module: 'zcode-expand/store', error: String(err?.message ?? err) };
    }
  },
};
