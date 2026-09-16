/* ZCode-Expand · 项目备注 + 任务运行状态点
 * ---------------------------------------------------------------------------
 * 本文件由 ZCode-Expand 注入到渲染层（out/renderer/zcode-expand/zc-remarks.js）。
 * 包内补丁只通过 window.__ZC_EXPAND__ 与本文件交互，业务逻辑全部在这里，
 * 因此调整行为/样式只需改本文件并重新 apply，不必重新定位压缩代码。
 *
 * 对外契约：
 *   label(folderName, workspacePath, remarks) -> string
 *       项目行显示文本。remarks 即数据真身（host 进程读点已把
 *       ~/.zcode/v2/zcode-expand.json 的 projectRemarks 并进 settings）。
 *       有备注只显示备注本身，无备注时原样返回 folderName。
 *   remoteLabel(folderName, workspacePath, remarks) -> string
 *       web-remote-control（手机网页）项目列表用，数据同上；手机屏幕小、
 *       不拼接：有备注返回备注本身，无备注返回 folderName。
 *   migrate(settingsHook) -> 0|1
 *       一次性迁移：把 v1.4 存在 localStorage（zcode-expand.remarks.data）的
 *       备注并进 settings.projectRemarks（经官方 update IPC 落到 host 进程的
 *       zcode-expand.json），成功后删除 localStorage key。settings 未加载完
 *       （loading）时跳过待下次，失败保留数据下次启动重试。
 *   remarks() -> map
 *       返回 localStorage 迁移源的余量（调试用；v1.5 起真身在 JSON 文件）。
 *   edit({ name, current, onSave }) -> void
 *       弹出编辑对话框；onSave(next) 在用户保存时调用（next 为空串表示清除）。
 *   isTaskListBusy(taskItems) -> boolean
 *       项目下是否有正在执行的任务。与官方任务行 spinner（rbe）同源判定：
 *       任一 task 的 __zcodeSessionActivity.phase 处于 prewarming/running 即
 *       运行中。输入是 WorkspaceSidebarItem 的 taskItems prop。
 *   isTaskListDone(taskItems) -> boolean
 *       项目行绿点（完成待查看）：任一任务不在运行且带未读标记（unreadAt 为
 *       数字，与官方 hasUnread 同源）。刻意不用官方 taskListHasUnread——它的
 *       清除时机随版本变化（3.12.2 点击项目即清），自判定只跟随任务本身的
 *       未读状态：点开任务查看（官方清 unreadAt）或下一轮开跑才消失。
 *   diag() -> object
 *       自检信息，便于确认注入是否生效。
 * ---------------------------------------------------------------------------
 */
(function () {
  'use strict';

  var VERSION = '1.5.0';

  // v1.4 遗留的 localStorage 存储键：现在只作迁移源（真身在 host 进程的
  // ~/.zcode/v2/zcode-expand.json，由包内补丁的读/写挂钩提供）。migrate() 成功
  // 后会删除该 key。
  var STORE_KEY = 'zcode-expand.remarks.data';

  // localStorage 覆盖：可在不改包、不重新 apply 的情况下临时调参或整体关掉。
  //   localStorage.setItem('zcode-expand.remarks', JSON.stringify({enabled:false}))
  //   localStorage.setItem('zcode-expand.remarks', JSON.stringify({runningDot:{color:'#38bdf8'}}))
  // 改完执行 window.__ZC_EXPAND__.reload() 生效（或刷新窗口）。
  var OVERRIDE_KEY = 'zcode-expand.remarks';

  var CONFIG = {
    // 总开关。false 时显示名回退为原名、菜单项点击无反应、运行状态点不再渲染
    enabled: true,
    // 有备注时的显示格式：只显示备注本身（无备注时 label() 直接回退文件夹名，
    // 不进 format）。想恢复「备注 · 文件夹名」拼接或改「文件夹名 (备注)」，只改这一行。
    format: function (remark, folderName) {
      return remark;
    },
    dialogTitle: '编辑项目备注',
    dialogHint: '留空保存即清除备注。备注写入设置文件，随应用设置一起保存。',
    placeholder: '例如：生产环境',
    maxLength: 80,
    // 运行中蓝点（zc-xp-running，脉冲动画由本模块注入）。颜色默认走补丁里
    // 的官方类 bg-sky-500 dark:bg-sky-400（与官方未读点一致）；这里只作
    // 覆盖钩子，显式给颜色才注入 background 规则。
    runningDot: {
      color: '',
    },
    // 完成待查看绿点（zc-xp-done，静态）。默认走官方类 bg-success。
    doneDot: {
      color: '',
    },
    // 兜底配色：优先使用应用自身的主题变量，取不到时用这些值
    fallback: {
      surface: '#1f1f22',
      text: '#e8e8ea',
      subtle: '#9aa0a6',
      border: '#3a3a40',
      accent: '#4f8cff',
    },
  };

  function applyOverrides() {
    var raw = null;
    try {
      raw = window.localStorage.getItem(OVERRIDE_KEY);
    } catch (err) {
      console.warn('[ZCode-Expand] 读取 localStorage 覆盖配置失败：', err);
      return '';
    }
    if (!raw) return '';
    try {
      var parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object') return raw;
      if (typeof parsed.enabled === 'boolean') CONFIG.enabled = parsed.enabled;
      if (typeof parsed.maxLength === 'number' && parsed.maxLength > 0) CONFIG.maxLength = parsed.maxLength;
      if (typeof parsed.dialogTitle === 'string') CONFIG.dialogTitle = parsed.dialogTitle;
      if (typeof parsed.dialogHint === 'string') CONFIG.dialogHint = parsed.dialogHint;
      if (typeof parsed.placeholder === 'string') CONFIG.placeholder = parsed.placeholder;
      if (parsed.runningDot && typeof parsed.runningDot === 'object') {
        if (typeof parsed.runningDot.color === 'string') CONFIG.runningDot.color = parsed.runningDot.color;
      }
      if (parsed.doneDot && typeof parsed.doneDot === 'object') {
        if (typeof parsed.doneDot.color === 'string') CONFIG.doneDot.color = parsed.doneDot.color;
      }
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

  function normalizeRemark(value) {
    if (typeof value !== 'string') return '';
    return value.replace(/[\r\n\t]+/g, ' ').trim();
  }

  // ---------------------------------------------------------------------------
  // 显示名（remarks 参数即真身：host 读点已并入 zcode-expand.json）
  // ---------------------------------------------------------------------------

  /** v1.4 遗留的 localStorage 数据（迁移源），仅供 migrate 与调试读取 */
  function readMigrationSource() {
    try {
      var raw = window.localStorage.getItem(STORE_KEY);
      if (!raw) return {};
      var parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
      return parsed;
    } catch (err) {
      console.warn('[ZCode-Expand] 读取 localStorage 迁移源失败：', err);
      return {};
    }
  }

  function remarks() {
    return readMigrationSource();
  }

  function label(folderName, workspacePath, remarks) {
    var base = typeof folderName === 'string' ? folderName : '';
    if (!CONFIG.enabled) return base;
    if (!workspacePath || !remarks || typeof remarks !== 'object') return base;
    var remark = normalizeRemark(remarks[workspacePath]);
    if (!remark) return base;
    try {
      return CONFIG.format(remark, base);
    } catch (err) {
      // 自定义 format 抛错时退回原始名，避免整行渲染失败
      console.warn('[ZCode-Expand] format() 抛错，已退回原始名称：', err);
      return base;
    }
  }

  function remoteLabel(folderName, workspacePath, remarks) {
    var base = typeof folderName === 'string' ? folderName : '';
    if (!CONFIG.enabled) return base;
    if (!workspacePath || !remarks || typeof remarks !== 'object') return base;
    // 手机网页屏幕小，不与文件夹名拼接：有备注给备注，没有给原名
    return normalizeRemark(remarks[workspacePath]) || base;
  }

  // ---------------------------------------------------------------------------
  // v1.4 → v1.5 存储迁移（localStorage → host 的 zcode-expand.json）
  // ---------------------------------------------------------------------------

  var migrationDone = false;

  /**
   * 把 localStorage 里的旧备注并进 settings.projectRemarks（走官方 update IPC，
   * host 写点会拆出落到 ~/.zcode/v2/zcode-expand.json），成功后清除 localStorage。
   * settings 未加载完（loading）时不置完成标记，等下一次渲染重试。
   */
  function migrate(settingsHook) {
    if (migrationDone || !CONFIG.enabled) return 0;
    if (!settingsHook || typeof settingsHook.update !== 'function') return 0;
    var settings = settingsHook.settings;
    if (!settings || typeof settings !== 'object') return 0;

    var legacy = readMigrationSource();
    var legacyKeys = Object.keys(legacy);
    var current = settings.projectRemarks && typeof settings.projectRemarks === 'object'
      ? settings.projectRemarks
      : {};
    var merged = {};
    Object.keys(current).forEach(function (key) {
      var value = normalizeRemark(current[key]);
      if (value) merged[key] = value;
    });
    var changed = false;
    legacyKeys.forEach(function (key) {
      var value = normalizeRemark(legacy[key]);
      if (value && merged[key] !== value) {
        merged[key] = value;
        changed = true;
      }
    });
    migrationDone = true;
    if (!changed && legacyKeys.length === 0) return 0;

    // setTimeout 避开 render 阶段同步触发 settings 更新
    window.setTimeout(function () {
      settingsHook.update({ projectRemarks: merged }).then(function () {
        try { window.localStorage.removeItem(STORE_KEY); } catch (err) { /* ignore */ }
        console.info('[ZCode-Expand] localStorage 备注已迁移到 ~/.zcode/v2/zcode-expand.json');
      }).catch(function (err) {
        console.warn('[ZCode-Expand] 备注迁移失败（localStorage 数据保留，下次启动重试）：', err);
        migrationDone = false;
      });
    }, 0);
    return 1;
  }

  // ---------------------------------------------------------------------------
  // 任务运行状态点
  // ---------------------------------------------------------------------------

  function isTaskListBusy(taskItems) {
    if (!CONFIG.enabled) return false;
    if (!Array.isArray(taskItems)) return false;
    for (var i = 0; i < taskItems.length; i++) {
      var task = taskItems[i];
      if (!task || typeof task !== 'object') continue;
      var activity = task.__zcodeSessionActivity;
      if (activity && typeof activity === 'object') {
        var phase = activity.phase;
        if (phase === 'prewarming' || phase === 'running') return true;
      }
    }
    return false;
  }

  // 完成待查看（绿点）：任务不在运行且带未读标记。未读判定与官方 hasUnread
  // 同源（typeof unreadAt === 'number'），先看 taskMeta.unreadAt（官方数据层
  // 优先写这里），回退顶层 unreadAt。
  function isTaskListDone(taskItems) {
    if (!CONFIG.enabled) return false;
    if (!Array.isArray(taskItems)) return false;
    for (var i = 0; i < taskItems.length; i++) {
      var task = taskItems[i];
      if (!task || typeof task !== 'object') continue;
      var activity = task.__zcodeSessionActivity;
      var phase = activity && typeof activity === 'object' ? activity.phase : undefined;
      if (phase === 'prewarming' || phase === 'running') continue;
      var meta = task.taskMeta && typeof task.taskMeta === 'object' ? task.taskMeta : null;
      var unreadAt = meta && typeof meta.unreadAt === 'number'
        ? meta.unreadAt
        : (typeof task.unreadAt === 'number' ? task.unreadAt : undefined);
      if (typeof unreadAt === 'number') return true;
    }
    return false;
  }

  // 运行点/完成点的动画与可选配色覆盖（class zc-xp-running / zc-xp-done）。
  // 颜色默认走补丁里复用的官方类（bg-sky-500 dark:bg-sky-400 / bg-success），
  // 只有显式配置了颜色才注入 background 规则（非 layer 规则可覆盖
  // Tailwind utilities）。动画尊重系统"减少动态效果"偏好。
  function ensureRunningDotStyle() {
    var STYLE_ID = 'zc-xp-running-style';
    // 已存在时先移除，保证 reload() 改配置后能按新参数重建
    var existing = document.getElementById(STYLE_ID);
    if (existing && existing.parentNode) existing.parentNode.removeChild(existing);
    if (!CONFIG.enabled) return;
    var rules = [
      '.zc-xp-running{animation:zc-xp-pulse 2s cubic-bezier(.4,0,.6,1) infinite}',
      '@keyframes zc-xp-pulse{50%{opacity:.35}}',
      '@media (prefers-reduced-motion: reduce){.zc-xp-running{animation:none;opacity:.85}}',
    ];
    if (CONFIG.runningDot.color) {
      rules.push('.zc-xp-running{background:' + CONFIG.runningDot.color + '}');
    }
    if (CONFIG.doneDot && CONFIG.doneDot.color) {
      rules.push('.zc-xp-done{background:' + CONFIG.doneDot.color + '}');
    }
    var el = document.createElement('style');
    el.id = STYLE_ID;
    el.textContent = rules.join('\n');
    document.head.appendChild(el);
  }

  var openDialog = null;

  function edit(options) {
    var opts = options || {};
    if (!CONFIG.enabled) return;
    if (openDialog) {
      openDialog.close();
      openDialog = null;
    }

    var fallback = CONFIG.fallback;
    var surface = pick('--color-card', fallback.surface);
    var text = pick('--color-foreground', fallback.text);
    var subtle = pick('--color-foreground-subtle', fallback.subtle);
    var border = pick('--color-border', fallback.border);
    var accent = pick('--color-brand', fallback.accent);

    var overlay = document.createElement('div');
    overlay.setAttribute('data-zc-expand', 'remarks-dialog');
    overlay.style.cssText = [
      'position:fixed', 'inset:0', 'z-index:2147483646',
      'display:flex', 'align-items:center', 'justify-content:center',
      'background:rgba(0,0,0,0.42)',
    ].join(';');

    var panel = document.createElement('div');
    panel.style.cssText = [
      'box-sizing:border-box', 'width:420px', 'max-width:calc(100vw - 48px)',
      'padding:18px', 'border-radius:14px',
      'background:' + surface, 'color:' + text,
      'border:1px solid ' + border,
      'box-shadow:0 18px 48px rgba(0,0,0,0.35)',
      'font:13px/1.5 system-ui,-apple-system,"Segoe UI","Microsoft YaHei",sans-serif',
    ].join(';');

    var titleId = 'zc-expand-remarks-title';
    var title = document.createElement('div');
    title.id = titleId;
    title.textContent = CONFIG.dialogTitle;
    title.style.cssText = 'font-size:14px;font-weight:600;margin-bottom:6px';

    var target = document.createElement('div');
    target.textContent = opts.name || '';
    target.style.cssText = [
      'font-family:ui-monospace,Consolas,monospace', 'font-size:12px',
      'color:' + subtle, 'margin-bottom:12px',
      'word-break:break-all', 'max-height:44px', 'overflow:hidden',
    ].join(';');

    var input = document.createElement('input');
    input.type = 'text';
    input.maxLength = CONFIG.maxLength;
    input.value = normalizeRemark(opts.current);
    input.placeholder = CONFIG.placeholder;
    input.setAttribute('aria-labelledby', titleId);
    input.style.cssText = [
      'box-sizing:border-box', 'width:100%', 'height:34px', 'padding:0 10px',
      'border-radius:8px', 'outline:none',
      'background:transparent', 'color:' + text,
      'border:1px solid ' + border,
    ].join(';');

    var hint = document.createElement('div');
    hint.textContent = CONFIG.dialogHint;
    hint.style.cssText = 'font-size:12px;color:' + subtle + ';margin-top:8px';

    var toolbar = document.createElement('div');
    toolbar.style.cssText = 'display:flex;justify-content:flex-end;gap:8px;margin-top:16px';

    function button(textContent, kind) {
      var el = document.createElement('button');
      el.type = 'button';
      el.textContent = textContent;
      var baseCss = [
        'height:30px', 'padding:0 14px', 'border-radius:8px', 'cursor:pointer',
        'font:inherit', 'border:1px solid ' + border, 'background:transparent', 'color:' + text,
      ];
      if (kind === 'primary') {
        baseCss = [
          'height:30px', 'padding:0 14px', 'border-radius:8px', 'cursor:pointer',
          'font:inherit', 'border:1px solid ' + accent, 'background:' + accent,
          // 文字色跟随主题反色变量：zai-dark 下 brand 为 #fff，foreground-inverse
          // 为 #000，官方实心按钮同样用这对组合（bg-brand text-foreground-inverse）
          'color:var(--color-foreground-inverse,#fff)',
        ];
      }
      el.style.cssText = baseCss.join(';');
      return el;
    }

    var cancelBtn = button('取消');
    var clearBtn = button('清除');
    var saveBtn = button('保存', 'primary');
    toolbar.appendChild(clearBtn);
    toolbar.appendChild(cancelBtn);
    toolbar.appendChild(saveBtn);

    panel.appendChild(title);
    panel.appendChild(target);
    panel.appendChild(input);
    panel.appendChild(hint);
    panel.appendChild(toolbar);
    overlay.appendChild(panel);
    document.body.appendChild(overlay);

    // 弹窗期间把应用主树设为 inert（不可点击/聚焦/按键），杜绝底层 UI
    // 误响应弹窗内的操作；关闭时恢复。浏览器不支持 inert 时静默跳过。
    var appRoot = document.getElementById('root');
    if (appRoot) {
      try { appRoot.inert = true; } catch (err) { /* ignore */ }
    }

    var finished = false;

    function close() {
      if (finished) return;
      finished = true;
      document.removeEventListener('keydown', onKeyDown, true);
      if (appRoot) {
        try { appRoot.inert = false; } catch (err) { /* ignore */ }
      }
      if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
      if (openDialog && openDialog.close === close) openDialog = null;
    }

    function commit(value) {
      if (finished) return;
      var next = normalizeRemark(value);
      close();
      try {
        if (typeof opts.onSave === 'function') opts.onSave(next);
      } catch (err) {
        console.error('[ZCode-Expand] 保存备注失败：', err);
      }
    }

    function onKeyDown(ev) {
      // 拦截冒泡，避免触发应用自身的快捷键（如 Esc 关闭面板、字母键进命令面板）
      ev.stopPropagation();
      if (ev.key === 'Escape') {
        ev.preventDefault();
        close();
      } else if (ev.key === 'Enter' && !ev.shiftKey) {
        ev.preventDefault();
        commit(input.value);
      }
    }

    // 拦截弹窗内指针事件的冒泡（含 pointerdown 等现代事件类型），
    // 防止应用挂在 document/window 上的全局监听器响应弹窗内的点击。
    ['pointerdown', 'mousedown', 'mouseup', 'click', 'contextmenu', 'wheel'].forEach(function (type) {
      overlay.addEventListener(type, function (ev) {
        if (ev.type === 'mousedown' && ev.target === overlay) close();
        ev.stopPropagation();
      });
      panel.addEventListener(type, function (ev) {
        ev.stopPropagation();
      });
    });
    cancelBtn.addEventListener('click', function (ev) {
      ev.stopPropagation();
      close();
    });
    clearBtn.addEventListener('click', function (ev) {
      ev.stopPropagation();
      commit('');
    });
    saveBtn.addEventListener('click', function (ev) {
      ev.stopPropagation();
      commit(input.value);
    });
    document.addEventListener('keydown', onKeyDown, true);

    openDialog = { close: close };
    input.focus();
    input.select();
  }

  function diag() {
    return {
      module: 'zcode-expand/remarks',
      version: VERSION,
      injected: true,
      override: {
        key: OVERRIDE_KEY,
        raw: currentOverrideRaw,
      },
      storage: {
        jsonFile: '~/.zcode/v2/zcode-expand.json',
        migrationSourceEntries: Object.keys(readMigrationSource()).length,
      },
      config: {
        enabled: CONFIG.enabled,
        maxLength: CONFIG.maxLength,
        dialogTitle: CONFIG.dialogTitle,
        runningDotColor: CONFIG.runningDot.color || '(official sky)',
        doneDotColor: CONFIG.doneDot.color || '(official success)',
      },
    };
  }

  // 读取一次覆盖配置；之后可用 reload() 重新读取
  var currentOverrideRaw = applyOverrides();
  ensureRunningDotStyle();

  window.__ZC_EXPAND__ = {
    version: VERSION,
    config: CONFIG,
    label: label,
    remoteLabel: remoteLabel,
    migrate: migrate,
    remarks: remarks,
    edit: edit,
    isTaskListBusy: isTaskListBusy,
    isTaskListDone: isTaskListDone,
    diag: diag,
    reload: function () {
      currentOverrideRaw = applyOverrides();
      ensureRunningDotStyle();
      return diag();
    },
  };

  console.log('[ZCode-Expand] 项目备注/运行状态模块已注入 v' + VERSION + '，自检：__ZC_EXPAND__.diag()');
})();
