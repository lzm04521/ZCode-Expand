/* ZCode-Expand · 项目备注 + 任务运行状态点
 * ---------------------------------------------------------------------------
 * 本文件由 ZCode-Expand 注入到渲染层（out/renderer/zcode-expand/zc-remarks.js）。
 * 包内补丁只通过 window.__ZC_EXPAND__ 与本文件交互，业务逻辑全部在这里，
 * 因此调整行为/样式只需改本文件并重新 apply，不必重新定位压缩代码。
 *
 * 对外契约：
 *   label(folderName, workspacePath, remarks) -> string
 *       项目行显示文本。无备注时原样返回 folderName。
 *   edit({ name, current, onSave }) -> void
 *       弹出编辑对话框；onSave(next) 在用户保存时调用（next 为空串表示清除）。
 *   isBusy(workspaceState) -> boolean
 *       项目是否有正在执行的任务。判定与官方"移除运行中 workspace"确认框
 *       同源：draftRuntime.status 或任一 taskRuntimeByTaskId[*].status
 *       处于 runningStates（默认 creating/restoring/streaming）即认为运行中。
 *   diag() -> object
 *       自检信息，便于确认注入是否生效。
 * ---------------------------------------------------------------------------
 */
(function () {
  'use strict';

  var VERSION = '1.1.0';

  // localStorage 覆盖：可在不改包、不重新 apply 的情况下临时调参或整体关掉。
  //   localStorage.setItem('zcode-expand.remarks', JSON.stringify({enabled:false}))
  //   localStorage.setItem('zcode-expand.remarks', JSON.stringify({runningStates:['streaming']}))
  // 改完执行 window.__ZC_EXPAND__.reload() 生效（或刷新窗口）。
  var OVERRIDE_KEY = 'zcode-expand.remarks';

  var CONFIG = {
    // 总开关。false 时显示名回退为原名、菜单项点击无反应、运行状态点不再渲染
    enabled: true,
    // 有备注时的显示格式。想改成「文件夹名 (备注)」之类，只改这一行即可。
    format: function (remark, folderName) {
      return remark + ' \u00b7 ' + folderName;
    },
    dialogTitle: '编辑项目备注',
    dialogHint: '留空保存即清除备注。备注写入设置文件，随应用设置一起保存。',
    placeholder: '例如：生产环境',
    maxLength: 80,
    // 认定为「正在执行」的任务状态集合。与官方 uwt()（移除运行中 workspace
    // 确认框）的判定保持同源：creating/restoring/streaming。
    runningStates: ['creating', 'restoring', 'streaming'],
    // 运行状态点样式（class zc-xp-running，由本模块注入 <style>）。
    // 颜色优先应用主题变量，取不到用兜底绿色。
    runningDot: {
      color: 'var(--color-success, #22c55e)',
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
      if (Array.isArray(parsed.runningStates)) {
        var states = parsed.runningStates.filter(function (s) {
          return typeof s === 'string' && s.length > 0;
        });
        if (states.length > 0) CONFIG.runningStates = states;
      }
      if (parsed.runningDot && typeof parsed.runningDot === 'object') {
        if (typeof parsed.runningDot.color === 'string') CONFIG.runningDot.color = parsed.runningDot.color;
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

  // ---------------------------------------------------------------------------
  // 任务运行状态点
  // ---------------------------------------------------------------------------

  function isBusy(workspaceState) {
    if (!CONFIG.enabled) return false;
    if (!workspaceState || typeof workspaceState !== 'object') return false;
    var states = CONFIG.runningStates;
    var draft = workspaceState.draftRuntime;
    if (draft && typeof draft === 'object' && states.indexOf(draft.status) !== -1) return true;
    var byTaskId = workspaceState.taskRuntimeByTaskId;
    if (byTaskId && typeof byTaskId === 'object') {
      for (var key in byTaskId) {
        if (!Object.prototype.hasOwnProperty.call(byTaskId, key)) continue;
        var runtime = byTaskId[key];
        if (runtime && typeof runtime === 'object' && states.indexOf(runtime.status) !== -1) {
          return true;
        }
      }
    }
    return false;
  }

  // 运行点的 class 是自定义的 zc-xp-running：不依赖应用 CSS 里是否存在
  // emerald/pulse 等 Tailwind 类（JIT 按需生成，未用过的类不会有 CSS），
  // 颜色跟随主题变量，动画尊重系统"减少动态效果"偏好。
  function ensureRunningDotStyle() {
    var STYLE_ID = 'zc-xp-running-style';
    // 已存在时先移除，保证 reload() 改配置后能按新参数重建
    var existing = document.getElementById(STYLE_ID);
    if (existing && existing.parentNode) existing.parentNode.removeChild(existing);
    if (!CONFIG.enabled) return;
    var el = document.createElement('style');
    el.id = STYLE_ID;
    el.textContent = [
      '.zc-xp-running{background:' + CONFIG.runningDot.color + ';animation:zc-xp-pulse 2s cubic-bezier(.4,0,.6,1) infinite}',
      '@keyframes zc-xp-pulse{50%{opacity:.35}}',
      '@media (prefers-reduced-motion: reduce){.zc-xp-running{animation:none;opacity:.85}}',
    ].join('\n');
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
      config: {
        enabled: CONFIG.enabled,
        maxLength: CONFIG.maxLength,
        dialogTitle: CONFIG.dialogTitle,
        runningStates: CONFIG.runningStates,
        runningDotColor: CONFIG.runningDot.color,
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
    edit: edit,
    isBusy: isBusy,
    diag: diag,
    reload: function () {
      currentOverrideRaw = applyOverrides();
      ensureRunningDotStyle();
      return diag();
    },
  };

  console.log('[ZCode-Expand] 项目备注/运行状态模块已注入 v' + VERSION + '，自检：__ZC_EXPAND__.diag()');
})();
