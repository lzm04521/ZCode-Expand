# ZCode-Expand

按 **ZCode 版本** 维护的桌面端自定义扩展仓库。核心是把"改 ZCode 安装包"这件事变成可复现、可校验、可回滚的补丁集，而不是手工改一次就丢。

> **声明**：本项目**仅供个人学习与技术研究用途**，与 ZCode 及其开发方无关，亦未获其授权。仓库只包含补丁定义与脚本，不分发 ZCode 本体或修改后的安装包，请勿将补丁产物用于商业用途或再分发。使用即表示你理解：由此产生的一切风险（包括但不限于违反 ZCode 用户协议、程序损坏、数据丢失）由使用者自行承担，本项目不提供任何担保。如有侵权，请联系删除。

## 现状

| 条目 | 说明 |
| --- | --- |
| 目标应用 | ZCode Desktop `3.14.4`（构建 `10bbcea5`，2026-09-29）；历史版本补丁集 `3.11.2` / `3.12.2` / `3.12.3` / `3.14.0` / `3.14.1` / `3.14.3` 同库保留 |
| 补丁集与验证 | `patches/3.14.4/` 已应用于本机安装，apply / verify / 重复 apply / rollback 全循环验证通过（回滚限制见下文「已知限制」） |
| 项目列表备注 | 侧边栏项目行可写备注：有备注显备注、无备注回退文件夹名；弹窗打开光标定位到文本末尾（防一次输入覆盖旧内容），「编辑备注」点击后菜单自动收起。备注真身存 `~/.zcode/v2/zcode-expand.json` 明文 JSON（host 进程读写，官方 `setting.json` 保持纯净），升级不丢；localStorage 旧数据一次性自动迁移 |
| 项目行任务状态点 | 红蓝绿状态机，判定与官方任务行同源：等待确认（权限/输入，`__zcodeSessionActivity.pendingInteractions` 计数 > 0）→ **红**色静态点（官方 `bg-destructive`，优先级最高）；执行中（`__zcodeSessionActivity.phase ∈ prewarming/running`）→ **蓝**色脉冲点（复用官方 `sky` 类）；完成待查看 → **绿**色静态点（官方 `bg-success`），点开任务或下轮开跑才清 |
| 手机远控适配 | 手机网页项目列表显示备注名（屏幕小，不拼接文件夹名），改备注后已连接手机即时刷新；会话页顶部标题显示当前工作区备注，无备注降级文件夹名 |
| Directory Opus 适配 | Windows 检测到 Opus（`dopusrt`/`dopus`）时，「打开文件夹/资源管理器」各入口（会话右键、标题栏「文件」菜单、文件树右键、聊天文件链接/预览面板）改由 `dopusrt /acmd Go <路径> NEWTAB=tofront` 打开并定位选中；未装 Opus 行为不变，WSL 工作区仍走系统资源管理器 |
| BigModel 账号管理/快速切换 | OAuth 登录成功后把账号快照（凭据）存进 `zcode-expand.json` 的 `accounts`；模型设置页 BigModel 卡片「解绑」旁多出「**切换账号**」按钮，弹窗点选即换凭据、免重启。切换走 settings 字段状态机 + 官方 `OAuthCredentialRepo`/`logout`，失败按备份回滚；明文令牌刻意不进 `setting.json` 与 zod schema |
| Token 用量状态栏 · 展示 | 输入卡片下方居中的胶囊条：**速度**（tok/s 三档变色）、**上下文**（进度条+占比）、**本轮**、**会话累计**、**工具调用**、**今日合计**、**子代理**明细面板、⚙ 各项开关/窗口覆盖，悬停任意项出明细 tooltip；分屏每个 pane 一条、辅助对话（SidePane）独立一条，互不串显；字号跟随「设置 → 外观 → 界面字号」实时联动 |
| Token 用量状态栏 · 数据链路 | 只读本地 `~/.zcode/cli/db/db.sqlite`（`node:sqlite` worker 按需聚合，零 Python 零轮询）：`fs.watch` db 目录事件驱动 + 30s 心跳，请求完成落库后 1~3s 内跳数 |
| Token 用量状态栏 · 统计口径 | 口径透明自研（设计文档 §5/§13）：主循环白名单排除标题生成等杂项、`cancelled` 计入 `error` 不计、本轮直接用官方 `turn_usage` 预聚合、GLM 缓存**包含制**（上下文 = `input_tokens`）、窗口映射 `[1M]` 后缀 / GLM-5.3 系 = 1M，默认 128K（⚙ 可覆盖） |
| Token 用量状态栏 · 上游缺陷修复 | 相对上游（xhwxt/zcode-token-usage-statusbar，MIT）：6+6 快照池漏历史会话、「下半屏可见」启发式漏上半屏输入框、IPC 焦点通道断链三大缺陷均已根除（按需查询 + pane 容器锚） |
| Token 用量状态栏 · SSH 远程与排查 | 可选 SSH 远程会话：配置 `~/.zcode/zcode-expand/usage-config.json` 的 `remote` 段后，本地查不到的会话自动 SSH 到远端跑同一查询脚本（☁ 徽标、远端今日、负缓存/失败退避）；创建 `~/.zcode/zcode-expand/usage-debug` 标记文件可开泵链路排查日志 `pump-debug.log` |

## 快速开始

两种使用方式：**clone 本仓库跑 npm script**（开发、适配、日常维护，本节）或**下载 Release 便携包解压即用**（免 clone，见下节）。

运行前提：Windows + ZCode Desktop `3.14.4`（默认安装位置 `%LOCALAPPDATA%\Programs\ZCode`）+ Node ≥ 18。零 npm 依赖，离线可用。

```bash
# 看当前状态（安装版本、补丁是否就位、备份列表）
npm run inspect

# 校验锚点是否与当前安装匹配
npm run verify

# 演练：全量重建 + 语法门禁 + 逐条自检，不碰安装目录
npm run apply:dry

# 正式应用（必须先完全退出 ZCode，含托盘）
npm run apply

# 回滚
npm run rollback:list
npm run rollback
```

## 从 Release 便携包使用（免 clone）

[Releases](https://github.com/lzm04521/ZCode-Expand/releases) 提供轻量便携包 `zcode-expand-<版本>.zip`（约 85KB，只含脚本、补丁定义与功能源码，**不含 ZCode 本体**）。包内含全部已适配版本补丁集，按本机 ZCode 版本自动选择。

```bat
:: 1. 下载解压（需要 Node ≥ 18），完全退出 ZCode（含托盘）
restore.cmd --check      & :: 只读检查：版本三方校验、本机是否干净安装
restore.cmd              & :: 还原原始 asar；首次运行自动采集干净安装为 pristine（此后可随时还原）
apply.cmd                & :: 应用补丁（语法门禁 + 逐条自检 + 自动备份）
verify.cmd               & :: 校验锚点与补丁状态（只读）
```

- **日常更新**：解压新 Release 覆盖 → `restore.cmd` → `apply.cmd`（无条件还原再应用，`src/` 迭代后不会残留旧产物）
- **仅回滚原始 ZCode**：单跑 `restore.cmd`
- **pristine**：本机采集的原始 asar（`pristine/<版本>/`，含 SHA256 清单），是还原与完整包的唯一真源；同版本不同构建号（buildCommitId）的 ZCode 会被三方校验拦截——那需要按适配流程重建补丁集
- 发版格式 `pkg-<ZCode版本>-<序号>`：新版本适配后左段更新右段归 1，进包内容迭代右段 +1，由 GitHub Action 自动静态校验并发布

## 目录结构

```
scripts/
  lib/asar.mjs          asar 读写与重建（纯 Node，零依赖）
  lib/patch.mjs         补丁引擎：锚点计数校验、幂等应用
  lib/syntaxcheck.mjs   语法门禁：node --check
  lib/env.mjs           安装目录/版本/进程定位
  inspect.mjs           总览
  verify.mjs            校验锚点与补丁状态
  apply.mjs             应用补丁（备份 → 重建 → 自检 → 替换）
  restore.mjs           还原原始 asar（首次自动采集 pristine + 三方版本校验）
  rollback.mjs          从备份恢复
  package.mjs           组便携包（轻包 / --with-pristine 完整包）
  extract.mjs           从 asar 取内容/搜索锚点（版本适配主力工具）
patches/<版本>/
  manifest.json         目标版本与构建号
  patches.json          补丁定义（文件、锚点、替换、断言次数）
src/                    我们自己的源码（不进压缩包，apply 时注入）
  renderer/zc-remarks.js  项目备注 + 项目行状态点 + 手机端 label 适配功能模块
  renderer/zc-accounts.js BigModel 账号管理 + 快速切换（模型设置页卡片按钮 + 账号选择弹窗）
  main/zc-dopus.mjs       Directory Opus 接管「打开文件夹/资源管理器」入口模块
  main/zc-store.mjs       扩展数据存储 zcode-expand.json 读写 + BigModel 账号切换执行（host 进程注入）
  main/zc-usage.mjs       Token 用量状态栏泵（主进程：fs.watch db → 按需查询 → 推送；SSH 远程）
  main/zc-usage-query.cjs Token 用量查询体（node:sqlite 只读聚合，worker/CLI 双模式）
  main/zc-usage-overlay.js Token 用量胶囊状态条（原版 overlay 裁剪改造，纯 DOM 不碰 React）
backups/                原始 app.asar 备份（git 忽略）
state/                  应用记录（git 忽略）
pristine/               本机采集的原始 asar 与完整性清单（git 忽略，还原真源）
dist/                   组包产物（git 忽略）
docs/                   机制说明 / 自定义面清单 / 版本适配流程 / 设计记录
```

## 三条不可越过的安全线

1. **写盘前必须过语法门禁**。补丁后的每个 JS 文件都要通过 `node --check`，否则中止且不写任何文件。这不是形式主义：开发过程中就靠它抓到过一次少写一个 `}` 的补丁（原文件语法是好的，补丁后坏了）。
2. **写盘前必须过逐条自检**。重建产物要重新解析，全部未改动文件（数万个）逐字节比对，改动文件的 `size` 与 `integrity` 与内容核对一致，才允许替换。
3. **必须有备份**。`apply` 会先把原 `app.asar` 复制到 `backups/`；`rollback` 在覆盖前还会再留一份"回滚前状态"，避免回滚本身不可逆。

## 已知限制

- **应用补丁时 ZCode 必须完全退出**（含托盘）。运行中 `app.asar` 被占用，替换会失败。脚本会主动检查并拒绝执行。
- **ZCode 升级后补丁全部失效需重新适配**。`out/` 下的 chunk 文件名带内容哈希（如 `chunk-WR3FEWGO.js`），每次构建都会变；锚点字符串也可能随代码改动位移。流程见 `docs/03-版本适配流程.md`。
- **asar 的 `unpacked` 条目不支持替换**（本机是 node-pty 的 12 个原生模块）。补丁集若指向这类文件会直接报错。
- 自建 asar 工具而非依赖 `@electron/asar`，是为了离线可用与可审计；代价是这条链路由本仓库自己负责正确性，因此自检做得比较重。3.12.2 起官方包 asar 头 `jsonSize` 出现非 4 字节倍数，自建工具已补 pickle 对齐填充的读写支持。

## 新增补丁的工作方式

1. `node scripts/extract.mjs --list=<路径前缀>` 找到目标文件
2. `node scripts/extract.mjs --grep=<关键字> --file=<文件> --window=160` 打印上下文，敲定唯一锚点
3. 在 `patches/<版本>/patches.json` 增加 target/edit：`find` / `replace` / `expect` / `marker`
   - 锚点尽量**包含后继字符**（如把 `,locale:` 一起写进 `find`），这样补丁天然幂等，重复 apply 不会重复插入
   - **每一处编辑都要给 `marker`**：一个"只有该编辑应用后才会出现"的片段。缺了它，已应用的编辑会因锚点消失而匹配 0 次，脚本直接报错中止
   - 同一文件多处编辑若插入内容相同，`marker` 要各自带上锚点残段以免互相误判
4. 如果功能代码超过几行，放进 `src/`，在 `patchSet.addFiles` 里声明注入位置；包内只留一行调用 `window.__ZC_EXPAND__`（见 `docs/01-机制说明.md`）
5. `npm run apply:dry` 直到通过，再 `npm run apply`

## 许可证

[MIT](./LICENSE)，Copyright © 2026 lzm04521。

再次强调：本项目**仅学习用途**。许可证授予的是本仓库代码（脚本、补丁定义、文档）的使用权限；ZCode 名称与软件本体归其权利人所有，补丁产物请勿分发或商用。
