/* ZCode-Expand · 移动端远程控制启动自动激活
 * ---------------------------------------------------------------------------
 * 本文件由 ZCode-Expand 注入到渲染层（out/renderer/zcode-expand/zc-webremote.js）。
 * 目标：ZCode 启动进入工作区后自动调用官方 startWebRemoteControl，让设备在 relay
 * 上线（waiting_terminal），手机无需先打开一次"移动端远程控制"弹层即可直接连接。
 *
 * 与包内补丁的唯一交互（styles-C9n_FfEX.js 的 _Tt 锚点）：工作区头渲染时把当前
 * 工作区上下文暴露到 window.__ZC_EXPAND_WEBREMOTE_WS__（组件卸载时清除），本模块
 * 只在该快照存在且远程控制空闲时触发官方 start。
 *
 * 复用官方链路：鉴权（auth-required 拦截）、featureGate、telemetry、底栏胶囊状态
 * 显示全部走官方实现；本模块只做"时机调度"，不接触 relay 连接本身。
 *
 * 对外契约（window.__ZC_EXPAND_WEBREMOTE__）：
 *   diag() -> Promise<object>   自检（配置/状态机/最近状态/最近错误/工作区快照）
 *   reload() -> Promise<object> 重读 localStorage 覆盖后返回 diag()
 *   stop() -> Promise<object>   停止远程控制并冻结本会话自动触发
 *   triggerNow() -> void        排障用：重置退避立即尝试一次（仍受
 *                               enabled / everStarted / frozen 约束）
 *
 * localStorage 覆盖（zcode-expand.webremote，改后 reload() 或刷新窗口生效）：
 *   {"enabled":true,"startDelayMs":10000,"pollMs":2000,"maxAttempts":3,"retryDelayMs":15000}
 *   enabled:false = 关闭自动激活，恢复纯手动（弹层行为不受影响）。
 *
 * 冻结语义：本会话一旦观察到任一运行态（starting/connecting/running/active）或
 * start 受理成功，即不再自动触发（尊重用户手动停止；官方 restore 拉起同样冻结）；
 * 重启进程后重新自动激活。
 * ---------------------------------------------------------------------------
 */
(function () {
  'use strict';

  var VERSION = '1.0.0';
  var OVERRIDE_KEY = 'zcode-expand.webremote';

  var CONFIG = {
    enabled: true,
    // 启动延迟：让官方 restorePreviouslyEnabled 先跑，避免与其并发 start
    startDelayMs: 10000,
    pollMs: 2000,
    maxAttempts: 3,
    retryDelayMs: 15000,
  };

  // 运行态集合：观察到任一即认为会话已存在（官方 restore / 用户手动 / 本模块拉起）
  var RUNNING_STATES = { starting: 1, connecting: 1, running: 1, active: 1 };

  var state = {
    startedAt: Date.now(),
    everStarted: false, // 本会话已存在过会话 → 不再自动触发
    frozen: false, // stop() 显式冻结 → 不再自动触发
    attempts: 0,
    lastAttemptAt: 0,
    lastError: '',
    lastStatus: null,
    lastStatusKey: '',
    lastStartedWorkspace: '',
  };

  var inFlight = false;
  var stopped = false;

  function log() {
    try {
      var args = ['[zc-webremote]'].concat([].slice.call(arguments));
      console.info.apply(console, args);
    } catch (e) {}
  }

  function readOverride() {
    try {
      var raw = window.localStorage.getItem(OVERRIDE_KEY);
      if (!raw) return null;
      var parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    } catch (e) {}
    return null;
  }

  function effectiveConfig() {
    var over = readOverride() || {};
    var cfg = {};
    for (var k in CONFIG) cfg[k] = CONFIG[k];
    for (var k2 in over) {
      if (!Object.prototype.hasOwnProperty.call(CONFIG, k2)) continue;
      var v = over[k2];
      if (typeof CONFIG[k2] === 'number') {
        if (typeof v === 'number' && isFinite(v) && v >= 0) cfg[k2] = v;
      } else if (typeof v === typeof CONFIG[k2]) {
        cfg[k2] = v;
      }
    }
    return cfg;
  }

  /** preload 桥可用性：缺任一远程控制方法即视为不可用 */
  function bridge() {
    var z = window.zcode;
    if (!z) return null;
    if (typeof z.getWebRemoteControlStatus !== 'function') return null;
    if (typeof z.startWebRemoteControl !== 'function') return null;
    return z;
  }

  function workspaceSnapshot() {
    var ws = window.__ZC_EXPAND_WEBREMOTE_WS__;
    if (!ws || typeof ws.workspacePath !== 'string' || !ws.workspacePath) return null;
    return ws;
  }

  async function queryStatus(z) {
    try {
      return await z.getWebRemoteControlStatus();
    } catch (e) {
      return null;
    }
  }

  function noteStatus(status) {
    if (!status || typeof status.status !== 'string') return;
    state.lastStatus = status;
    var key = status.status + (status.sessionId ? ':' + status.sessionId : '');
    if (key !== state.lastStatusKey) {
      state.lastStatusKey = key;
      log('状态 ->', status.status);
    }
  }

  /** 单次轮询：状态机判定 + 条件满足时触发官方 start */
  async function poll() {
    if (inFlight) return;
    var z = bridge();
    if (!z) return;
    inFlight = true;
    try {
      var cfg = effectiveConfig();
      var status = await queryStatus(z);
      noteStatus(status);

      if (status && RUNNING_STATES[status.status]) {
        if (!state.everStarted) {
          state.everStarted = true;
          log('会话已存在（' + status.status + '），冻结本会话自动触发');
        }
        return;
      }
      // auth-required：等登录（官方登录成功后自行恢复），不计尝试次数
      if (status && status.status === 'auth-required') return;

      if (!cfg.enabled || state.frozen || state.everStarted) return;
      if (state.attempts >= cfg.maxAttempts) return;
      if (Date.now() - state.startedAt < cfg.startDelayMs) return;
      if (state.lastAttemptAt && Date.now() - state.lastAttemptAt < cfg.retryDelayMs) return;

      var ws = workspaceSnapshot();
      if (!ws) return; // 无打开的工作区（_Tt 未挂载）→ 不触发

      // 触发前重查一次：官方 restore 可能恰好刚拉起，避免双 start
      var fresh = await queryStatus(z);
      noteStatus(fresh);
      if (fresh && RUNNING_STATES[fresh.status]) {
        state.everStarted = true;
        log('会话已存在（' + fresh.status + '），跳过自动触发');
        return;
      }

      var ctx = { workspacePath: ws.workspacePath };
      if (ws.workspaceIdentity) ctx.workspaceIdentity = ws.workspaceIdentity;
      if (ws.remoteSessionId) ctx.remoteSessionId = ws.remoteSessionId;
      if (ws.initialTaskId) ctx.initialTaskId = ws.initialTaskId;

      state.attempts += 1;
      state.lastAttemptAt = Date.now();
      log('自动激活移动端远程控制（第 ' + state.attempts + '/' + cfg.maxAttempts + ' 次）', ctx.workspacePath);
      try {
        var res = await z.startWebRemoteControl(ctx);
        // start 受理即达 QR-ready（waiting_terminal/paired），本会话冻结
        state.everStarted = true;
        state.lastStartedWorkspace = ws.workspacePath;
        state.lastError = '';
        log('start 已受理，状态', res && res.status ? res.status : '(未知)');
      } catch (err) {
        state.lastError = String((err && err.message) || err);
        log('start 失败', state.lastError);
        // auth-required 场景 start 必然抛错：对齐状态并归还这次尝试（不计入上限）
        var after = await queryStatus(z);
        noteStatus(after);
        if (after && after.status === 'auth-required') {
          state.attempts = Math.max(0, state.attempts - 1);
          log('未登录，等待登录后继续');
        }
      }
    } finally {
      inFlight = false;
    }
  }

  /** 自适应轮询：pollMs 可经 localStorage 覆盖，reload 后下一轮生效 */
  function schedule() {
    if (stopped) return;
    var delay = CONFIG.pollMs;
    try {
      var cfg = effectiveConfig();
      if (cfg.pollMs >= 500) delay = cfg.pollMs;
    } catch (e) {}
    window.setTimeout(function () {
      poll().catch(function () {});
      schedule();
    }, delay);
  }

  function diag() {
    return Promise.resolve({
      version: VERSION,
      config: effectiveConfig(),
      bridgeAvailable: !!bridge(),
      workspace: workspaceSnapshot() || null,
      state: {
        everStarted: state.everStarted,
        frozen: state.frozen,
        attempts: state.attempts,
        maxAttempts: effectiveConfig().maxAttempts,
        lastAttemptAt: state.lastAttemptAt,
        lastError: state.lastError,
        lastStartedWorkspace: state.lastStartedWorkspace,
        startedAt: state.startedAt,
      },
      lastStatus: state.lastStatus,
    });
  }

  window.__ZC_EXPAND_WEBREMOTE__ = {
    diag: diag,
    reload: function () {
      log('重读覆盖配置', JSON.stringify(readOverride() || {}));
      return diag();
    },
    stop: async function () {
      state.frozen = true;
      state.everStarted = true;
      var z = bridge();
      if (z && typeof z.stopWebRemoteControl === 'function') {
        try {
          await z.stopWebRemoteControl();
          log('已请求停止远程控制，本会话冻结自动触发');
        } catch (e) {
          log('停止失败', String((e && e.message) || e));
        }
      }
      return diag();
    },
    triggerNow: function () {
      // 排障入口：重置退避与次数，仍尊重 enabled / everStarted / frozen
      state.attempts = 0;
      state.lastAttemptAt = 0;
      state.startedAt = 0;
      poll().catch(function () {});
    },
  };

  schedule();
  log('v' + VERSION + ' 已加载，等待工作区就绪');
})();
