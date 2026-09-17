# ZCode-Expand 便携包使用说明

按版本维护的 ZCode Desktop `app.asar` 补丁集与替换机制。本包为轻量代码包（不含 ZCode 本体）；首次运行时若目标机器是干净的同版本安装，会自动采集原始 asar 作为还原基准（pristine）。

## 前置条件

- Windows + ZCode Desktop（版本与包内最新补丁集一致；包内含全部已适配版本补丁集，按本机版本自动选择）
- Node.js ≥ 18（`node` 在 PATH 中）
- 安装位置不限：默认位置、开始菜单/桌面快捷方式、上次成功位置（自动记忆）任一可发现即可；都找不到时用 `restore.cmd --home=<目录>` 显式指定
- 操作安装目录前 ZCode 必须**完全退出（含托盘图标）**，否则 `app.asar` 被占用，替换失败

## 首次使用（干净安装）

```
restore.cmd --check     ← 检查：本机是否干净、版本是否匹配
restore.cmd             ← 自动采集 pristine 并还原（干净机器上等于原样复制）
apply.cmd               ← 应用补丁（语法门禁 + 逐条自检 + 自动备份）
verify.cmd              ← 校验锚点与补丁状态（只读）
```

启动 ZCode 生效。

## 日常更新（src/ 功能或补丁集新版本）

```
restore.cmd             ← 还原到原始 asar（清掉旧补丁产物，确定性重来）
apply.cmd               ← 应用新补丁
```

## 仅回滚到原始 ZCode

```
restore.cmd
```

## 目录说明

- `pristine/<版本>/app.asar` — 本机采集的原始 asar（自动生成，含 SHA256 清单，`restore.cmd` 依赖它做还原与完整性校验）
- `backups/` — `apply.cmd` 每次应用前的原始备份与 `rollback.cmd` 的回滚前留存
- `state/` — 应用状态记录（还原后自动清理）

## 注意

- 同一 `appVersion` 但构建号（buildCommitId）不同的 ZCode 会被三方校验拦截：同版本不同构建的 asar 内容不同，锚点必然失配，需按版本适配流程重建补丁集。
- 本包仅限个人使用与技术研究，不分发 ZCode 本体或修改后的安装包。
