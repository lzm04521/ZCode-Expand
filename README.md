# ZCode-Expand

按 **ZCode 版本** 维护的桌面端自定义扩展仓库。核心是把"改 ZCode 安装包"这件事变成可复现、可校验、可回滚的补丁集，而不是手工改一次就丢。

> **声明**：本项目**仅供个人学习与技术研究用途**，与 ZCode 及其开发方无关，亦未获其授权。仓库只包含补丁定义与脚本，不分发 ZCode 本体或修改后的安装包，请勿将补丁产物用于商业用途或再分发。使用即表示你理解：由此产生的一切风险（包括但不限于违反 ZCode 用户协议、程序损坏、数据丢失）由使用者自行承担，本项目不提供任何担保。如有侵权，请联系删除。

## 现状

- 目标应用：ZCode Desktop `3.11.2`（构建 `89817f5b`，2026-09-04）
- 已实现补丁集：`patches/3.11.2/`
- 已实现功能：**项目列表备注 + 项目行任务状态点 + 手机远控（Web 远程控制）适配**
  - 侧边栏项目行可写备注，备注随设置保存，显示名为「备注 · 文件夹名」
  - 项目行状态点（蓝绿状态机）：项目下有任务正在执行时显示**蓝色脉冲点**（判定与官方任务行 spinner 同源：`__zcodeSessionActivity.phase ∈ prewarming/running`，颜色复用官方 `sky` 类）；任务结束但有未读输出（多为完成待查看）时转**绿色静态点**（官方 `bg-success`），点开任务即灭
  - 手机网页适配：项目列表显示备注名（屏幕小，不拼接文件夹名）、改备注后已连接手机即时刷新；会话页（新建会话/历史会话详细）顶部标题显示当前工作区备注，无备注降级文件夹名
- 补丁已应用于本机安装，apply / verify / 重复 apply / rollback 全循环验证通过；回滚见下文「已知限制」

## 快速开始

运行前提：Windows + ZCode Desktop `3.11.2`（默认安装位置 `%LOCALAPPDATA%\Programs\ZCode`）+ Node ≥ 18。零 npm 依赖，离线可用。

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
  rollback.mjs          从备份恢复
  extract.mjs           从 asar 取内容/搜索锚点（版本适配主力工具）
patches/<版本>/
  manifest.json         目标版本与构建号
  patches.json          补丁定义（文件、锚点、替换、断言次数）
src/                    我们自己的源码（不进压缩包，apply 时注入）
  renderer/zc-remarks.js  项目备注 + 项目行状态点 + 手机端 label 适配功能模块
backups/                原始 app.asar 备份（git 忽略）
state/                  应用记录（git 忽略）
docs/                   机制说明 / 自定义面清单 / 版本适配流程 / 设计记录
```

## 三条不可越过的安全线

1. **写盘前必须过语法门禁**。补丁后的每个 JS 文件都要通过 `node --check`，否则中止且不写任何文件。这不是形式主义：开发过程中就靠它抓到过一次少写一个 `}` 的补丁（原文件语法是好的，补丁后坏了）。
2. **写盘前必须过逐条自检**。重建产物要重新解析，27276 个未改动文件逐字节比对，改动文件的 `size` 与 `integrity` 与内容核对一致，才允许替换。
3. **必须有备份**。`apply` 会先把原 `app.asar` 复制到 `backups/`；`rollback` 在覆盖前还会再留一份"回滚前状态"，避免回滚本身不可逆。

## 已知限制

- **应用补丁时 ZCode 必须完全退出**（含托盘）。运行中 `app.asar` 被占用，替换会失败。脚本会主动检查并拒绝执行。
- **ZCode 升级后补丁全部失效需重新适配**。`out/` 下的 chunk 文件名带内容哈希（如 `chunk-WR3FEWGO.js`），每次构建都会变；锚点字符串也可能随代码改动位移。流程见 `docs/03-版本适配流程.md`。
- **asar 的 `unpacked` 条目不支持替换**（本机是 node-pty 的 12 个原生模块）。补丁集若指向这类文件会直接报错。
- 自建 asar 工具而非依赖 `@electron/asar`，是为了离线可用与可审计；代价是这条链路由本仓库自己负责正确性，因此自检做得比较重。

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
