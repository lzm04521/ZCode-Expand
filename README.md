# ZCode-Expand

[![Release](https://img.shields.io/github/v/tag/lzm04521/ZCode-Expand?label=release&sort=semver)](https://github.com/lzm04521/ZCode-Expand/releases)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)
![Platform](https://img.shields.io/badge/platform-Windows-blue)
![ZCode](https://img.shields.io/badge/ZCode-3.16.3-8A2BE2)

按 **ZCode 版本** 维护的桌面端自定义扩展仓库。核心是把"改 ZCode 安装包"这件事变成**可复现、可校验、可回滚**的补丁集，而不是手工改一次就丢：零 npm 依赖、纯 Node、离线可用，写盘前过语法门禁 + 逐条自检，全程自动备份。

> [!IMPORTANT]
> **免责声明**：本项目**仅供个人学习与技术研究用途**，与 ZCode 及其开发方无关，亦未获其授权。仓库只包含补丁定义与脚本，**不分发 ZCode 本体或修改后的安装包**，请勿将补丁产物用于商业用途或再分发。使用即表示你理解：由此产生的一切风险（包括但不限于违反 ZCode 用户协议、程序损坏、数据丢失）由使用者自行承担，本项目不提供任何担保。如有侵权，请联系删除。

## 当前适配

**ZCode Desktop `3.16.3`**（构建 `a82dd43e`，2026-10-23）——`patches/3.16.3/`：40 处编辑、8 个目标文件、7 个注入文件，自 `3.16.2` 平移适配（功能集不变），dry-run / apply / verify 全链路通过。历史版本补丁集同库保留：`3.11.2` / `3.12.2` / `3.12.3` / `3.14.0` / `3.14.1` / `3.14.3` / `3.14.4` / `3.14.5` / `3.15.1` / `3.15.3` / `3.16.2`。

## ✨ 功能

### 侧栏任务状态点（三态，v1.9.0 口径）

在官方侧栏四个位置加同一套三态状态点，优先级 **红等待 > 蓝未读 > 绿运行**：

| 状态 | 判定（与官方任务行同源） | 样式 |
| --- | --- | --- |
| 等待确认（红） | `__zcodeSessionActivity.pendingInteractions` 权限/输入计数 > 0 | 静态点 7px，官方 `bg-destructive` |
| 跑完未读（蓝） | 任务不在运行且带 `unreadAt`（`taskMeta` 优先，顶层回退） | 静态点 7px，官方未读同色 `bg-icon-blue` / `bg-sky-500 dark:bg-sky-400` |
| 执行中（绿） | `__zcodeSessionActivity.phase ∈ prewarming/running` | 官方 loader 图标 spinner 14px / `strokeWidth:3`，色由注入模块给 `var(--color-success)` |

覆盖位置：**任务行**（两套行组件同步）、**项目行**（按该项目任务聚合）、**任务分区头**（该分区完整任务数组聚合，不受「显示更多」/收起影响）、**项目分区头**（所有项目任务并集聚合，`projectId != null && !archived`，含置顶任务与远程项目）。自定义分组与日期分桶头不加点。状态点存续期间分区头标题与图标不置灰（`button:has(>[data-zcxp-*])` 注入规则，点消失自动恢复官方灰）。

### 项目名称（官方接管）

ZCode 3.16.2 已有官方项目编辑入口（名称存于 SQLite `projects.name` / `name_overridden`），本扩展的自定义项目备注就此**退役**：编辑、显示、远控同步、schema 读写全部恢复官方行为。首次启动由 host 自动把旧 `projectRemarks` 按项目根目录唯一匹配迁移到官方名称，**只补 `name_overridden=0` 的默认名项目**（官方已命名、无匹配、歧义项跳过并记录）；旧 `~/.zcode/v2/zcode-expand.json` 与 localStorage 备注保留不删。历史版本补丁集仍使用原备注功能。

### BigModel 账号管理与快速切换

OAuth 登录后把账号快照存进 `zcode-expand.json`；模型设置页 BigModel 卡片多出「切换账号」按钮，弹窗点选即换凭据、免重启。切换走 settings 字段状态机 + 官方 `OAuthCredentialRepo`/`logout`，失败按备份回滚；**切换前对官方 userinfo 做一次只读探活**（401/403 或空 body 即判失效并中止，超时与网络异常放行）。明文令牌不进 `setting.json`。

### Token 用量状态栏

输入卡片下方居中的胶囊条：**速度**（tok/s 三档变色）、**上下文**（进度条+占比）、**本轮**、**会话累计**、**工具调用**、**今日合计**、**子代理**明细、⚙ 开关。分屏每 pane 一条、辅助对话独立一条，子代理 tab 的条浮在滚动区预留底部空带内显示该子代理自身消耗；字号跟随界面设置实时联动。

数据链路只读本地 `~/.zcode/cli/db/db.sqlite`（`node:sqlite` worker 按需聚合，`fs.watch` 事件驱动 + 30s 心跳，请求落库 1~3s 内跳数）；统计口径自研透明（主循环白名单、`cancelled` 计入 error、GLM 缓存包含制、`[1M]` 窗口映射、子代理自动分型）；可选 SSH 远程会话（`usage-config.json` 的 `remote` 段，☁ 徽标/失败退避）。相对上游 [zcode-token-usage-statusbar](https://github.com/xhwxt/zcode-token-usage-statusbar)（MIT）修复了快照池漏会话、可见性启发式、IPC 断链三大缺陷。

### Directory Opus 适配

Windows 检测到 Opus（`dopusrt`/`dopus`）时，「打开文件夹/资源管理器」各入口（会话右键、标题栏「文件」菜单、文件树右键、聊天文件链接/预览）改由 `dopusrt /acmd Go <路径> NEWTAB=tofront` 打开并定位选中；未装 Opus 行为不变，WSL 工作区仍走系统资源管理器。

## 🚀 快速开始

运行前提：**Windows + ZCode Desktop 3.16.3**（默认安装位置 `%LOCALAPPDATA%\Programs\ZCode`）+ **Node ≥ 18**。

### 方式一：clone 本仓库（开发、适配、日常维护）

```bash
npm run inspect        # 总览：安装版本、补丁是否就位、备份列表
npm run verify         # 校验锚点与补丁应用状态（只读）
npm run apply:dry      # 演练：全量重建 + 语法门禁 + 逐条自检，不碰安装目录
npm run apply          # 正式应用（必须先完全退出 ZCode，含托盘）
npm run rollback:list  # 列出可回滚备份
npm run rollback       # 从备份恢复
```

### 方式二：Release 便携包（免 clone）

[Releases](https://github.com/lzm04521/ZCode-Expand/releases) 提供轻量便携包 `zcode-expand-<版本>.zip`（约 260KB，只含脚本、补丁定义与功能源码，**不含 ZCode 本体**），包内含全部已适配版本补丁集，按本机 ZCode 版本自动选择。

```bat
:: 下载解压（需 Node ≥ 18），完全退出 ZCode（含托盘）
restore.cmd --check      & :: 只读检查：版本三方校验、本机是否干净安装
restore.cmd              & :: 还原原始 asar；首次运行自动采集干净安装为 pristine
apply.cmd                & :: 应用补丁（语法门禁 + 逐条自检 + 自动备份）
verify.cmd               & :: 校验锚点与补丁状态（只读）
```

- **日常更新**：解压新 Release 覆盖 → `restore.cmd` → `apply.cmd`（无条件还原再应用，`src/` 迭代后不残留旧产物）
- **pristine**：本机采集的原始 asar（`pristine/<版本>/`，含 SHA256 清单），还原与完整包的唯一真源；同版本不同构建号会被三方校验拦截
- 发版格式 `pkg-<ZCode版本>-<序号>`：新版本适配后左段更新右段归 1，进包内容迭代右段 +1，GitHub Action 自动校验并发布

## 📁 目录结构

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
src/                    自有功能源码（apply 时经 addFiles 注入，包内只留一行调用）
  renderer/zc-remarks.js    三态状态点判定/配色/不置灰 CSS 注入；含旧版备注兼容代码（3.16.2 不调用）
  renderer/zc-accounts.js   BigModel 账号管理 + 快速切换 UI
  main/zc-dopus.mjs         Directory Opus 接管「打开文件夹」入口
  main/zc-store.mjs         扩展数据存储 + 账号切换执行 + 切换前只读探活
  main/zc-usage.mjs         Token 用量状态栏泵（fs.watch → 按需查询 → 推送；SSH 远程）
  main/zc-usage-query.cjs   Token 用量查询体（node:sqlite 只读聚合）
  main/zc-usage-overlay.js  Token 用量胶囊条（纯 DOM 不碰 React）
backups/  state/  pristine/  dist/    备份 / 应用记录 / 原始 asar 真源 / 组包产物（均 git 忽略）
docs/                                  机制说明 / 自定义面清单 / 版本适配流程 / 设计记录
```

## 🛡️ 安全设计：三条不可越过的线

1. **写盘前必须过语法门禁**。补丁后的每个 JS 文件都要通过 `node --check`，否则中止且不写任何文件。这不是形式主义：开发过程中就靠它抓到过一次少写一个 `}` 的补丁。
2. **写盘前必须过逐条自检**。重建产物重新解析，全部未改动文件（数万个）逐字节比对，改动文件的 `size` 与 `integrity` 与内容核对一致，才允许替换。
3. **必须有备份**。`apply` 先把原 `app.asar` 复制到 `backups/`；`rollback` 覆盖前再留一份"回滚前状态"，回滚本身也可逆。

## ⚠️ 已知限制

- **应用补丁时 ZCode 必须完全退出**（含托盘），运行中 `app.asar` 被占用；脚本内置进程检测并主动拒绝执行。
- **ZCode 升级后补丁全部失效需重新适配**：`out/` chunk 文件名带内容哈希，锚点也可能位移。按 [docs/03-版本适配流程.md](docs/03-版本适配流程.md) 重建 `patches/<新版本>/`。
- **asar 的 `unpacked` 条目不支持替换**（如 node-pty 原生模块），补丁集指向这类文件会直接报错。
- 自建 asar 工具（而非 `@electron/asar`）换取离线可用与可审计，代价是自检做得比较重。

## 🔧 进阶：新增补丁与版本适配

1. `node scripts/extract.mjs --list=<路径前缀>` 找到目标文件
2. `node scripts/extract.mjs --grep=<关键字> --file=<文件> --window=160` 打印上下文，敲定唯一锚点
3. 在 `patches/<版本>/patches.json` 增加 target/edit（`find` / `replace` / `expect` / `marker`）：
   - 锚点尽量**包含后继字符**（如把 `,locale:` 一起写进 `find`），补丁天然幂等
   - **每处编辑必须给 `marker`**：只有该编辑应用后才会出现的片段，缺了它重复 apply 会因锚点消失而报错中止
   - 同一文件多处相同插入，`marker` 各自带锚点残段避免误判
4. 功能代码超过几行放 `src/`，经 `addFiles` 注入（见 [docs/01-机制说明.md](docs/01-机制说明.md)）
5. `npm run apply:dry` 通过后再 `npm run apply`

机制细节见 [docs/01-机制说明.md](docs/01-机制说明.md)，全部自定义面清单见 [docs/02-自定义面清单.md](docs/02-自定义面清单.md)，设计取舍见 [docs/04-设计与取舍记录.md](docs/04-设计与取舍记录.md)。

## 📄 许可证

[MIT](./LICENSE)，Copyright © 2026 lzm04521。

再次强调：本项目**仅供个人学习与技术研究**，与 ZCode 及其开发方无关。许可证授予的是本仓库代码（脚本、补丁定义、文档）的使用权限；**ZCode 名称与软件本体归其权利人所有**，补丁产物请勿分发或商用。
