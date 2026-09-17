/* ZCode-Expand · BigModel 账号管理 + 快速切换
 * ---------------------------------------------------------------------------
 * 本文件由 ZCode-Expand 注入到渲染层（out/renderer/zcode-expand/zc-accounts.js）。
 * 包内补丁只在三处与本文件交互（业务逻辑全在这里，改行为/样式只需改本文件重 apply）：
 *   1. ModelProviderSection（rVt）每次渲染调用 bindRefresh({...})
 *      把收尾刷新回调、settings 读写、凭据服务等引用交进来
 *   2. gzt（模型设置页的 BigModel 卡片）调用 switchButton({jsx, Button, ...})
 *      取一个 React 元素，作为「切换账号」按钮渲染在「解绑」旁边
 *   3. 弹窗本体用原生 DOM 渲染（与备注弹窗同一套样式与焦点处理经验）
 *
 * 对外契约：
 *   bindRefresh(refs) -> refs
 *       由组件在渲染期调用，模块持有引用；每次渲染刷新一遍，闭包里的 settings 不
 *       会过期。
 *   switchButton({jsx, Button, settings, update, refresh}) -> ReactElement|null
 *       构造「切换账号」按钮。jsx 是包内 react/jsx-runtime 的 jsx，Button 是官方
 *       按钮组件——用官方组件保证与「解绑」同款外观，且不把样式类名抄死。
 *   diag() -> Promise<object>
 *       自检信息（注入是否生效、账号数、当前绑定账号、最近一次切换状态）。
 *   reload() -> Promise<object>
 *       重读 localStorage 覆盖配置后返回 diag()。
 *
 * 数据来源：host 进程读点把 ~/.zcode/v2/zcode-expand.json 的 accounts /
 * zcAccountSwitch 并进 settings，所以这里直接读 settings.accounts 即可，不需要
 * 新的 RPC 通道。
 * ---------------------------------------------------------------------------
 */
(function () {
  'use strict';

  var VERSION = '1.0.0';

  // localStorage 覆盖：不改包、不重新 apply 就能调参或整体关掉
  //   localStorage.setItem('zcode-expand.accounts', JSON.stringify({enabled:false}))
  // 改完执行 window.__ZC_ACCOUNTS__.reload() 生效（或刷新窗口）。
  var OVERRIDE_KEY = 'zcode-expand.accounts';

  var CONFIG = {
    enabled: true,
    // 弹窗文案（硬编码中文，与备注功能一致，不走 i18n）
    dialogTitle: '切换 BigModel 账号',
    dialogHint: '这里列出用 BigModel 方式绑定过的账号。切换只替换登录凭据，不改变当前模型选择。',
    emptyText: '还没有可用账号。用 BigModel 方式绑定过的账号会自动出现在这里。',
    switchConfirmText: '切换后当前登录会立即变成该账号（无需重启）。',
    runningSessionsWarnText: '检测到有正在运行的任务，切换登录可能影响它们，建议等任务结束后再切换。',
    deleteConfirmText: '只删除这条本地快照，不影响当前登录状态。',
    closeLabel: '关闭',
    cancelLabel: '取消',
    confirmSwitchLabel: '确认切换',
    confirmDeleteLabel: '确认删除',
    switchTimeoutMs: 10000,
    pollIntervalMs: 500,
    // 兜底配色：优先使用应用自身的主题变量，取不到时用这些值
    fallback: {
      surface: '#1f1f22',
      text: '#e8e8ea',
      subtle: '#9aa0a6',
      border: '#3a3a40',
      accent: '#4f8cff',
      danger: '#ef4444',
    },
  };

  function applyOverrides() {
    var raw = null;
    try {
      raw = window.localStorage.getItem(OVERRIDE_KEY);
    } catch (err) {
      return '';
    }
    if (!raw) return '';
    try {
      var parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object') return raw;
      if (typeof parsed.enabled === 'boolean') CONFIG.enabled = parsed.enabled;
      if (typeof parsed.switchTimeoutMs === 'number' && parsed.switchTimeoutMs > 0) {
        CONFIG.switchTimeoutMs = parsed.switchTimeoutMs;
      }
      if (typeof parsed.dialogTitle === 'string') CONFIG.dialogTitle = parsed.dialogTitle;
      if (typeof parsed.dialogHint === 'string') CONFIG.dialogHint = parsed.dialogHint;
      if (typeof parsed.emptyText === 'string') CONFIG.emptyText = parsed.emptyText;
      if (parsed.fallback && typeof parsed.fallback === 'object') {
        Object.keys(parsed.fallback).forEach(function (key) {
          if (typeof parsed.fallback[key] === 'string') CONFIG.fallback[key] = parsed.fallback[key];
        });
      }
      return raw;
    } catch (err) {
      console.warn('[ZCode-Expand] localStorage 覆盖配置不是合法 JSON，已忽略：', err);
      return raw;
    }
  }

  function pick(name, fallback) {
    // 应用用 Tailwind v4 的 --color-* 变量；读不到就用兜底色
    var v = getComputedStyle(document.documentElement).getPropertyValue(name);
    v = (v || '').trim();
    return v || fallback;
  }

  /**
   * 写应用日志（~/.zcode/v2/logs/<yyyy-MM-dd>.log）。
   * 打包版没有 DevTools，这是本模块唯一的可观测通道；同时保留 console 输出。
   */
  function logToApp(level, args) {
    try {
      if (window.zcode && typeof window.zcode.log === 'function') window.zcode.log(level, args);
    } catch (err) {
      /* ignore */
    }
    try {
      var fn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
      fn.apply(console, args);
    } catch (err) {
      /* ignore */
    }
  }

  // 关键节点各记一次，避免每帧刷屏
  var loggedKeys = {};
  function logOnce(key, message, detail) {
    if (loggedKeys[key]) return;
    loggedKeys[key] = true;
    logToApp('info', ['[ZCode-Expand] ' + message, detail === undefined ? '' : detail]);
  }

  function sleep(ms) {
    return new Promise(function (resolve) {
      window.setTimeout(resolve, ms);
    });
  }

  // ---------------------------------------------------------------------------
  // 宿主引用（组件渲染期交进来，模块持有）
  // ---------------------------------------------------------------------------

  var refs = {
    services: null,
    settings: null,
    update: null,
    refresh: null,
    credentials: null,
    setUser: null,
    setOAuthError: null,
    refreshAll: null,
    refreshProviders: null,
    refreshPlanSnapshots: null,
    refreshPurchaseToken: null,
    familyDomainOf: null,
    clearCodingPlanWebviewStorage: null,
    boundAt: 0,
  };

  function bindRefresh(next) {
    if (!next || typeof next !== 'object') return refs;
    Object.keys(next).forEach(function (key) {
      var value = next[key];
      if (value === undefined || value === null) return;
      refs[key] = value;
    });
    refs.boundAt = Date.now();
    logOnce('bindRefresh', '已绑定 ModelProviderSection（settings/update/credentials 就绪）');
    return refs;
  }

  /** 取最新设置：优先直接问 host（不受 React 渲染时序影响），失败回退组件快照 */
  async function readSettings() {
    var svc = refs.services;
    if (svc && svc.settingService && typeof svc.settingService.get === 'function') {
      try {
        var fresh = await svc.settingService.get();
        if (fresh && typeof fresh === 'object') {
          refs.settings = fresh;
          return fresh;
        }
      } catch (err) {
        console.warn('[ZCode-Expand] 读取设置失败，回退组件快照：', err);
      }
    }
    return refs.settings || null;
  }

  /** 当前已绑定的 BigModel 账号 id（读官方凭据库的 user_info，与快照 id 同源） */
  async function readCurrentAccountId() {
    var credentials = refs.credentials;
    if (!credentials || typeof credentials.load !== 'function') return null;
    try {
      var raw = await credentials.load('oauth:bigmodel:user_info');
      if (!raw) return null;
      var profile = typeof raw === 'string' ? JSON.parse(raw) : raw;
      if (profile && typeof profile.id === 'string' && profile.id) return 'bigmodel:' + profile.id;
    } catch (err) {
      console.warn('[ZCode-Expand] 读取当前绑定的 BigModel 账号失败：', err);
    }
    return null;
  }

  async function readActiveProvider() {
    var credentials = refs.credentials;
    if (!credentials || typeof credentials.load !== 'function') return null;
    try {
      var raw = await credentials.load('oauth:active_provider');
      return typeof raw === 'string' && raw ? raw : null;
    } catch (err) {
      return null;
    }
  }

  async function readSwitchState() {
    var svc = refs.services;
    if (svc && svc.settingService && typeof svc.settingService.get === 'function') {
      try {
        var fresh = await svc.settingService.get();
        return fresh && fresh.zcAccountSwitch ? fresh.zcAccountSwitch : null;
      } catch (err) {
        /* 落到下面的回退 */
      }
    }
    try {
      if (typeof refs.refresh === 'function') await refs.refresh();
    } catch (err) {
      /* ignore */
    }
    var snapshot = refs.settings;
    return snapshot && snapshot.zcAccountSwitch ? snapshot.zcAccountSwitch : null;
  }

  /** 正在运行的桌面会话数；服务不可用时返回 null（用保守文案） */
  async function readRunningSessionCount() {
    var svc = refs.services;
    if (!svc) return null;
    var candidates = [svc];
    try {
      Object.keys(svc).forEach(function (key) {
        var value = svc[key];
        if (value && typeof value === 'object' && candidates.indexOf(value) < 0) candidates.push(value);
      });
    } catch (err) {
      /* ignore */
    }
    for (var i = 0; i < candidates.length; i += 1) {
      var probe = candidates[i];
      if (!probe || typeof probe.getDesktopSessionActivity !== 'function') continue;
      try {
        var activity = await probe.getDesktopSessionActivity();
        if (activity && typeof activity.runningAgentSessionCount === 'number') {
          return activity.runningAgentSessionCount;
        }
        return null;
      } catch (err) {
        return null;
      }
    }
    return null;
  }

  // ---------------------------------------------------------------------------
  // 切换执行
  // ---------------------------------------------------------------------------

  function profileOf(account) {
    var profile = account && account.profile ? account.profile : {};
    var out = {
      id: profile.id,
      username: profile.username,
      displayName: profile.displayName,
    };
    if (typeof profile.avatarUrl === 'string' && profile.avatarUrl) out.avatarUrl = profile.avatarUrl;
    return out;
  }

  /**
   * 请求 host 切换。host 侧串行执行并把结果回写 store，这里轮询 settings 上的
   * zcAccountSwitch，按 id + issuedAt 认自己的那次请求（并发连点时丢弃过期回包）。
   */
  async function requestSwitch(account) {
    if (typeof refs.update !== 'function') return { ok: false, error: '设置服务不可用' };
    var issuedAt = Date.now();
    var previousActive = await readActiveProvider();

    await refs.update({ zcAccountSwitch: { id: account.id, state: 'pending', issuedAt: issuedAt } });

    var deadline = Date.now() + CONFIG.switchTimeoutMs;
    while (Date.now() < deadline) {
      await sleep(CONFIG.pollIntervalMs);
      var state = await readSwitchState();
      if (!state || state.id !== account.id || state.issuedAt !== issuedAt) continue;
      if (state.state === 'done') {
        await finalizeAfterSwitch(account, previousActive);
        return { ok: true };
      }
      if (state.state === 'failed') {
        return { ok: false, error: state.error || '切换失败（宿主未给出原因）' };
      }
    }
    // 状态通道读不到（settingService 不可用等）时别急着报失败：直接问凭据库，
    // 已经绑成目标账号就按成功走收尾，避免"切换其实成功了但提示失败"。
    var boundId = await readCurrentAccountId();
    if (boundId && boundId === account.id) {
      await finalizeAfterSwitch(account, previousActive);
      return { ok: true };
    }
    return { ok: false, error: '切换超时（' + Math.round(CONFIG.switchTimeoutMs / 1000) + ' 秒内未收到宿主回执）' };
  }

  /** 对照官方解绑/登录收尾：清 webview 登录态 → 重建用户态 → 刷新 provider 与套餐快照 */
  async function finalizeAfterSwitch(account, previousActive) {
    try {
      var cleared = refs.clearCodingPlanWebviewStorage && refs.clearCodingPlanWebviewStorage();
      if (cleared && typeof cleared.then === 'function') await cleared;
    } catch (err) {
      console.warn('[ZCode-Expand] 清理编程套餐 webview 登录态失败：', err);
    }

    try {
      if (typeof refs.setUser === 'function') refs.setUser(profileOf(account));
    } catch (err) {
      console.warn('[ZCode-Expand] 重建渲染层用户态失败：', err);
    }

    // BigModel↔BigModel 不动 providerFamilyDomain；从 Z.ai 切过来才同步家族域
    if (previousActive && previousActive !== 'bigmodel') {
      try {
        var domain = typeof refs.familyDomainOf === 'function' ? refs.familyDomainOf('bigmodel') : null;
        var settings = refs.settings || {};
        if (typeof domain === 'string' && domain && settings.providerFamilyDomain !== domain) {
          var selections = {};
          var existing = settings.providerFamilyConnectionSelections;
          if (existing && typeof existing === 'object') {
            Object.keys(existing).forEach(function (key) {
              selections[key] = existing[key];
            });
          }
          selections[domain] = { kind: 'individual-coding-plan' };
          await refs.update({
            providerFamilyDomain: domain,
            providerFamilyDomainUpdatedAt: Date.now(),
            providerFamilyDomainMigrated: true,
            providerFamilyConnectionSelections: selections,
          });
        }
      } catch (err) {
        console.warn('[ZCode-Expand] 同步 providerFamilyDomain 失败：', err);
      }
    }

    try {
      if (typeof refs.refreshAll === 'function') await refs.refreshAll({});
      else if (typeof refs.refreshProviders === 'function') await refs.refreshProviders();
    } catch (err) {
      console.warn('[ZCode-Expand] 切换后刷新 provider 列表失败：', err);
    }
  }

  async function requestDelete(account) {
    if (typeof refs.update !== 'function') return { ok: false, error: '设置服务不可用' };
    await refs.update({ zcAccountDelete: { id: account.id, issuedAt: Date.now() } });
    return { ok: true };
  }

  // ---------------------------------------------------------------------------
  // 弹窗
  // ---------------------------------------------------------------------------

  var openDialog = null;

  function accountLabel(account) {
    var name = (account.displayName || '').trim();
    if (name) return name;
    var username = (account.username || '').trim();
    if (username) return username;
    return account.id || '(未命名账号)';
  }

  function relativeTime(ts) {
    if (!Number.isFinite(ts)) return '';
    var diff = Date.now() - ts;
    if (diff < 60 * 1000) return '刚刚';
    if (diff < 60 * 60 * 1000) return Math.floor(diff / 60000) + ' 分钟前';
    if (diff < 24 * 60 * 60 * 1000) return Math.floor(diff / 3600000) + ' 小时前';
    if (diff < 30 * 24 * 60 * 60 * 1000) return Math.floor(diff / 86400000) + ' 天前';
    var d = new Date(ts);
    var p = function (n) {
      return String(n).padStart(2, '0');
    };
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
  }

  function button(textContent, kind, theme) {
    var el = document.createElement('button');
    el.type = 'button';
    el.textContent = textContent;
    var border = kind === 'primary' ? theme.accent : kind === 'danger' ? theme.danger : theme.border;
    var color = kind === 'danger' ? theme.danger : theme.text;
    var css = [
      'height:30px',
      'padding:0 14px',
      'border-radius:8px',
      'cursor:pointer',
      'font:inherit',
      'border:1px solid ' + border,
      'color:' + color,
    ];
    if (kind === 'primary') {
      css.push('background:' + theme.accent, 'color:var(--color-foreground-inverse,#fff)', 'border-color:' + theme.accent);
    } else {
      css.push('background:transparent');
    }
    el.style.cssText = css.join(';');
    return el;
  }

  async function openModal() {
    if (!CONFIG.enabled) return;
    if (openDialog) {
      openDialog.close();
      openDialog = null;
    }

    var theme = {
      surface: pick('--color-card', CONFIG.fallback.surface),
      text: pick('--color-foreground', CONFIG.fallback.text),
      subtle: pick('--color-foreground-subtle', CONFIG.fallback.subtle),
      border: pick('--color-border', CONFIG.fallback.border),
      accent: pick('--color-brand', CONFIG.fallback.accent),
      danger: CONFIG.fallback.danger,
    };

    var overlay = document.createElement('div');
    overlay.setAttribute('data-zc-expand', 'accounts-dialog');
    overlay.style.cssText = [
      'position:fixed',
      'inset:0',
      'z-index:2147483646',
      'display:flex',
      'align-items:center',
      'justify-content:center',
      'background:rgba(0,0,0,0.42)',
    ].join(';');

    var panel = document.createElement('div');
    panel.style.cssText = [
      'box-sizing:border-box',
      'width:460px',
      'max-width:calc(100vw - 48px)',
      'padding:18px',
      'border-radius:14px',
      'background:' + theme.surface,
      'color:' + theme.text,
      'border:1px solid ' + theme.border,
      'box-shadow:0 18px 48px rgba(0,0,0,0.35)',
      'font:13px/1.5 system-ui,-apple-system,"Segoe UI","Microsoft YaHei",sans-serif',
    ].join(';');

    var titleId = 'zc-expand-accounts-title';
    var title = document.createElement('div');
    title.id = titleId;
    title.textContent = CONFIG.dialogTitle;
    title.style.cssText = 'font-size:14px;font-weight:600;margin-bottom:6px';

    var hint = document.createElement('div');
    hint.textContent = CONFIG.dialogHint;
    hint.style.cssText = 'font-size:12px;color:' + theme.subtle + ';margin-bottom:12px';

    var body = document.createElement('div');
    body.style.cssText = 'max-height:320px;overflow:auto;margin-bottom:12px';

    var status = document.createElement('div');
    status.style.cssText = 'font-size:12px;min-height:18px;margin-bottom:8px';

    var toolbar = document.createElement('div');
    toolbar.style.cssText = 'display:flex;justify-content:flex-end;gap:8px';

    panel.appendChild(title);
    panel.appendChild(hint);
    panel.appendChild(body);
    panel.appendChild(status);
    panel.appendChild(toolbar);
    overlay.appendChild(panel);
    document.body.appendChild(overlay);

    // 弹窗期间主树设为 inert，杜绝底层 UI 误响应（与备注弹窗同一处理）
    var appRoot = document.getElementById('root');
    if (appRoot) {
      try {
        appRoot.inert = true;
      } catch (err) {
        /* ignore */
      }
    }

    var finished = false;
    var busy = false;
    var view = { mode: 'list', account: null, accounts: [], currentId: null, running: null };

    function close() {
      if (finished) return;
      finished = true;
      document.removeEventListener('keydown', onKeyDown, true);
      if (appRoot) {
        try {
          appRoot.inert = false;
        } catch (err) {
          /* ignore */
        }
      }
      if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
      if (openDialog && openDialog.close === close) openDialog = null;
    }

    function setStatus(text, kind) {
      status.textContent = text || '';
      status.style.color = kind === 'error' ? theme.danger : kind === 'ok' ? theme.subtle : theme.subtle;
    }

    function setBusy(next) {
      busy = next;
      render();
    }

    function row(account) {
      var el = document.createElement('div');
      el.setAttribute('role', 'button');
      el.tabIndex = 0;
      var isCurrent = view.currentId && account.id === view.currentId;
      el.style.cssText = [
        'display:flex',
        'align-items:center',
        'gap:10px',
        'padding:8px 10px',
        'border-radius:10px',
        'border:1px solid ' + (isCurrent ? theme.accent : theme.border),
        'margin-bottom:8px',
        'cursor:pointer',
      ].join(';');

      var avatar = document.createElement('div');
      var initial = accountLabel(account).slice(0, 1).toUpperCase();
      avatar.textContent = initial;
      avatar.style.cssText = [
        'flex:0 0 auto',
        'width:28px',
        'height:28px',
        'border-radius:50%',
        'display:flex',
        'align-items:center',
        'justify-content:center',
        'font-size:12px',
        'font-weight:600',
        'border:1px solid ' + theme.border,
        'color:' + theme.subtle,
        'overflow:hidden',
      ].join(';');
      if (typeof account.avatarUrl === 'string' && account.avatarUrl) {
        var img = document.createElement('img');
        img.src = account.avatarUrl;
        img.alt = '';
        img.style.cssText = 'width:100%;height:100%;object-fit:cover';
        img.addEventListener('error', function () {
          // 头像取不到时退回首字母兜底
          if (img.parentNode) img.parentNode.removeChild(img);
        });
        avatar.appendChild(img);
      }

      var meta = document.createElement('div');
      meta.style.cssText = 'flex:1 1 auto;min-width:0';
      var name = document.createElement('div');
      name.textContent = accountLabel(account);
      name.style.cssText = 'font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap';
      var sub = document.createElement('div');
      sub.textContent = [
        isCurrent ? '当前账号' : '',
        relativeTime(account.savedAt) ? '快照 ' + relativeTime(account.savedAt) : '',
      ]
        .filter(Boolean)
        .join(' · ');
      sub.style.cssText = 'font-size:11px;color:' + theme.subtle + ';overflow:hidden;text-overflow:ellipsis;white-space:nowrap';
      meta.appendChild(name);
      meta.appendChild(sub);

      var del = button('删除', 'ghost', theme);
      del.style.cssText += ';height:26px;padding:0 10px;font-size:12px;color:' + theme.subtle;
      del.addEventListener('click', function (ev) {
        ev.stopPropagation();
        if (busy) return;
        view.mode = 'confirm-delete';
        view.account = account;
        setStatus('');
        render();
      });

      el.appendChild(avatar);
      el.appendChild(meta);
      el.appendChild(del);
      el.addEventListener('click', function () {
        if (busy || isCurrent) return;
        view.mode = 'confirm-switch';
        view.account = account;
        setStatus('');
        render();
      });
      el.addEventListener('keydown', function (ev) {
        if (ev.key !== 'Enter' && ev.key !== ' ') return;
        ev.preventDefault();
        if (busy || isCurrent) return;
        view.mode = 'confirm-switch';
        view.account = account;
        setStatus('');
        render();
      });
      return el;
    }

    function listView() {
      if (!view.accounts.length) {
        var empty = document.createElement('div');
        empty.textContent = CONFIG.emptyText;
        empty.style.cssText = 'font-size:12px;color:' + theme.subtle + ';padding:12px 2px';
        body.appendChild(empty);
      } else {
        view.accounts.forEach(function (account) {
          body.appendChild(row(account));
        });
      }

      var closeBtn = button(CONFIG.closeLabel, 'ghost', theme);
      closeBtn.addEventListener('click', function (ev) {
        ev.stopPropagation();
        close();
      });
      toolbar.appendChild(closeBtn);
    }

    function confirmView() {
      var isDelete = view.mode === 'confirm-delete';
      var account = view.account;

      var box = document.createElement('div');
      box.style.cssText = [
        'padding:10px',
        'border-radius:10px',
        'border:1px solid ' + theme.border,
        'font-size:12px',
        'line-height:1.6',
      ].join(';');

      var line1 = document.createElement('div');
      line1.textContent = (isDelete ? '删除快照：' : '切换到：') + accountLabel(account);
      line1.style.cssText = 'font-size:13px';
      box.appendChild(line1);

      var line2 = document.createElement('div');
      line2.textContent = isDelete ? CONFIG.deleteConfirmText : CONFIG.switchConfirmText;
      line2.style.cssText = 'color:' + theme.subtle + ';margin-top:4px';
      box.appendChild(line2);

      if (!isDelete && view.running !== null && view.running > 0) {
        var warn = document.createElement('div');
        warn.textContent = CONFIG.runningSessionsWarnText;
        warn.style.cssText = 'color:' + theme.danger + ';margin-top:4px';
        box.appendChild(warn);
      }
      body.appendChild(box);

      var backBtn = button(CONFIG.cancelLabel, 'ghost', theme);
      backBtn.disabled = busy;
      backBtn.addEventListener('click', function (ev) {
        ev.stopPropagation();
        if (busy) return;
        view.mode = 'list';
        view.account = null;
        setStatus('');
        render();
      });

      var okBtn = button(isDelete ? CONFIG.confirmDeleteLabel : CONFIG.confirmSwitchLabel, isDelete ? 'danger' : 'primary', theme);
      okBtn.disabled = busy;
      okBtn.addEventListener('click', async function (ev) {
        ev.stopPropagation();
        if (busy) return;
        await runAction(isDelete);
      });

      toolbar.appendChild(backBtn);
      toolbar.appendChild(okBtn);
    }

    async function runAction(isDelete) {
      var account = view.account;
      setBusy(true);
      setStatus(isDelete ? '正在删除…' : '正在切换…');
      try {
        var result = isDelete ? await requestDelete(account) : await requestSwitch(account);
        if (!result.ok) {
          setBusy(false);
          setStatus(result.error || '操作失败', 'error');
          return;
        }
        var settings = await readSettings();
        view.accounts = settings && Array.isArray(settings.accounts) ? settings.accounts : [];
        view.currentId = await readCurrentAccountId();
        view.running = await readRunningSessionCount();
        view.mode = 'list';
        view.account = null;
        busy = false;
        setStatus(isDelete ? '快照已删除。' : '已切换。', 'ok');
        render();
      } catch (err) {
        console.error('[ZCode-Expand] 账号操作失败：', err);
        setBusy(false);
        setStatus(String((err && err.message) || err), 'error');
      }
    }

    function render() {
      body.textContent = '';
      toolbar.textContent = '';
      if (view.mode === 'list') listView();
      else confirmView();
    }

    function onKeyDown(ev) {
      // 拦截冒泡，避免触发应用自身的快捷键
      ev.stopPropagation();
      if (ev.key !== 'Escape') return;
      ev.preventDefault();
      if (busy) return;
      if (view.mode !== 'list') {
        view.mode = 'list';
        view.account = null;
        render();
        return;
      }
      close();
    }

    // 拦截弹窗内指针事件冒泡，防止应用挂在 document/window 上的全局监听器响应
    ['pointerdown', 'mousedown', 'mouseup', 'click', 'contextmenu', 'wheel'].forEach(function (type) {
      overlay.addEventListener(type, function (ev) {
        if (ev.type === 'mousedown' && ev.target === overlay) close();
        ev.stopPropagation();
      });
      panel.addEventListener(type, function (ev) {
        ev.stopPropagation();
      });
    });
    document.addEventListener('keydown', onKeyDown, true);

    openDialog = { close: close };

    // 先渲染（拿组件快照），再异步取宿主最新设置与账号态后重绘
    setStatus('加载中…');
    render();
    var settings = await readSettings();
    if (finished) return;
    view.accounts = settings && Array.isArray(settings.accounts) ? settings.accounts : [];
    view.currentId = await readCurrentAccountId();
    if (finished) return;
    view.running = await readRunningSessionCount();
    if (finished) return;
    setStatus('');
    render();

    var first = toolbar.querySelector('button');
    if (first) first.focus();
  }

  // ---------------------------------------------------------------------------
  // 「切换账号」按钮（由 gzt 渲染，取回一个官方 Button 元素）
  // ---------------------------------------------------------------------------

  /**
   * 可见条件收在这里而不是写在补丁表达式里：卡片属于 BigModel 家族就给入口。
   * 官方「解绑」只在当前选中的 provider 上才挂 onDisconnect，按那个条件判会让
   * API key 模式彻底没有入口。
   */
  function switchButton(props) {
    var options = props || {};
    var providerId = options.oauthProviderId;
    // 每张详情卡片记一条：菜单没出现时，从这里能看出到底是哪张卡片被渲染了
    logOnce(
      'card:' + String(providerId),
      '详情卡片已渲染',
      'oauthProviderId=' + String(providerId) + ' presetId=' + String(options.presetId)
    );
    if (!CONFIG.enabled) return null;
    if (providerId !== 'bigmodel') return null;

    // 兼容两种传法：直接给 jsx 函数，或给 react/jsx-runtime 命名空间对象
    var jsx = options.jsx;
    if (jsx && typeof jsx !== 'function' && typeof jsx.jsx === 'function') jsx = jsx.jsx;
    var Button = options.Button;
    if (typeof jsx !== 'function' || typeof Button !== 'function') {
      logOnce(
        'bad-props:' + String(providerId),
        '账号按钮未渲染：jsx/Button 类型不符（jsx=' + typeof options.jsx + ' Button=' + typeof options.Button + '）'
      );
      return null;
    }
    if (typeof refs.update !== 'function') {
      logOnce('no-update', '账号按钮已渲染，但设置写入口尚未绑定（ModelProviderSection 未渲染过）');
    }
    // 组件渲染期顺手同步引用（refresh 只有设置 hook 上有）
    if (options.settings) refs.settings = options.settings;
    if (typeof options.update === 'function') refs.update = options.update;
    if (typeof options.refresh === 'function') refs.refresh = options.refresh;

    logOnce('button', 'BigModel 卡片「切换账号」按钮已挂载');
    return jsx(Button, {
      type: 'button',
      variant: 'outline',
      size: 'lg',
      onClick: function () {
        openModal().catch(function (err) {
          logToApp('error', ['[ZCode-Expand] 打开账号弹窗失败', String((err && err.message) || err)]);
        });
      },
      children: '切换账号',
    });
  }

  // ---------------------------------------------------------------------------
  // 自检
  // ---------------------------------------------------------------------------

  var currentOverrideRaw = applyOverrides();

  async function diag() {
    var settings = refs.settings;
    var accounts = settings && Array.isArray(settings.accounts) ? settings.accounts : [];
    return {
      module: 'zcode-expand/accounts',
      version: VERSION,
      injected: true,
      override: { key: OVERRIDE_KEY, raw: currentOverrideRaw },
      bound: refs.boundAt > 0,
      boundAt: refs.boundAt ? new Date(refs.boundAt).toISOString() : null,
      hasSettingsService: !!(refs.services && refs.services.settingService),
      accountCount: accounts.length,
      accounts: accounts.map(function (it) {
        return { id: it.id, displayName: it.displayName, savedAt: it.savedAt };
      }),
      currentAccountId: await readCurrentAccountId(),
      activeProvider: await readActiveProvider(),
      switchState: settings ? settings.zcAccountSwitch || null : null,
      config: { enabled: CONFIG.enabled, switchTimeoutMs: CONFIG.switchTimeoutMs },
    };
  }

  window.__ZC_ACCOUNTS__ = {
    version: VERSION,
    config: CONFIG,
    bindRefresh: bindRefresh,
    switchButton: switchButton,
    diag: diag,
    reload: function () {
      currentOverrideRaw = applyOverrides();
      return diag();
    },
  };

  logToApp('info', ['[ZCode-Expand] BigModel 账号切换模块已注入 v' + VERSION + '，自检：__ZC_ACCOUNTS__.diag()']);
})();
