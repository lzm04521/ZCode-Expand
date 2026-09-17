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
    await applyAccount(account);
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

globalThis.__ZC_XP_STORE__ = {
  /** 读点挂钩：把 store 的扩展键并进 settings；store 缺失时原样返回 */
  async merge(settings) {
    if (!isPlainObject(settings)) return settings;
    try {
      const store = await readStore();
      const out = { ...settings };
      if (Object.keys(store.projectRemarks).length > 0) {
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
   * 写点挂钩：patch 里的扩展键落 store，并从落盘内容剔除。
   * accounts 只由宿主维护（登录快照 / zcAccountDelete），渲染层从不提交它——
   * 官方 update 会把 patch 过一遍 zod（未知键会被剥掉），也会把合并后的设置
   * 写进 setting.json 与日志，明文令牌绝不能走这条路径。
   */
  async extract(patch, merged) {
    const out = isPlainObject(merged) ? { ...merged } : merged;
    try {
      if (!isPlainObject(patch) || !isPlainObject(out)) return out;

      const hasRemarks = Object.hasOwn(patch, 'projectRemarks');
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

      delete out.projectRemarks;
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

  /** 自检信息 */
  async diag() {
    try {
      const store = await readStore();
      const oauth = oauthService();
      return {
        module: 'zcode-expand/store',
        storeFile: STORE_FILE,
        remarkCount: Object.keys(store.projectRemarks).length,
        accountCount: (store.accounts ?? []).length,
        accounts: (store.accounts ?? []).map((it) => ({
          id: it.id,
          displayName: it.displayName,
          savedAt: it.savedAt,
          hasRefreshToken: !!it.tokenSet?.refreshToken,
          hasJwt: !!it.tokenSet?.zcodeJwtToken,
        })),
        switchState: store.zcAccountSwitch ?? null,
        oauthReady: !!oauth,
        oauthHandle: globalThis.__ZC_XP_OAUTH_RPC__ ? 'rpc' : globalThis.__ZC_XP_OAUTH__ ? 'host' : null,
        activeProvider: oauth ? await oauth.repo.getActiveProvider() : null,
      };
    } catch (err) {
      return { module: 'zcode-expand/store', error: String(err?.message ?? err) };
    }
  },
};
