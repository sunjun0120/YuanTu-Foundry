# Windows 沙箱账户后端：交接说明（给接手的 Agent）

日期：2026-10-21　分支：`windows-account-sandbox`（不要推送到 `main`）

## 先读

1. 设计：`docs/superpowers/specs/2026-10-21-windows-account-sandbox-design.md`
2. 已完成的计划（含结论与偏差）：`docs/superpowers/plans/2026-10-21-windows-account-sandbox-phase1-spike.md`、`…-phase2a-native-exec.md`、`…-phase2b-provisioning.md`、`…-phase2c-ts-integration.md`

## 目标与现状

把 Windows 原生沙箱从“从桌面用户令牌派生受限令牌”换成 Codex elevated 式：专用低权限本地账户（`YuanTuSandboxOffline`/`YuanTuSandboxOnline`，组 `YuanTuSandboxUsers`）+ 一次性管理员初始化 + 常驻执行器（broker 以桌面用户运行，runner 以沙箱账户运行）。根因结论：旧后端 `spawn EPERM` 是因为 `WRITE_RESTRICTED` 令牌的限制 SID 里没有令牌用户 SID（libuv 建 stdio 管道要 `WRITE_DAC`）；新令牌配方 = 能力 SID… + 用户 SID + logon + Everyone，不降 Low。

| 阶段                                                                                                     | 状态                                                                                 |
| -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| 1 spike                                                                                                  | 完成                                                                                 |
| 2a 原生执行链路（exec/broker/runner、IPC、Job）                                                          | 完成，CI 通过                                                                        |
| 2b 初始化/卸载/状态、DPAPI 凭据、WFP 按用户 SID 断网                                                     | 完成，**真实机器验收通过**（workflow `Windows sandbox accounts`，run 39561590575）   |
| 2c TS 接入（`windows-account` 模式、provider、broker 管理、`native` 自动选择、常驻 grant、构建产出 exe） | 代码已提交（`27c892b`、`4ae8c11`、`61f1a20`）；**commit 61f1a20 的 CI 结果尚未确认** |
| 2d                                                                                                       | 未开始，见下                                                                         |

## 代码地图

- 原生 crate：`packages/tools/windows-sandbox/appcontainer/`
  - 库：`src/lib.rs`、`src/network.rs`（WFP，含按语义比对安全描述符）、`src/maintenance.rs`（受保护安装/签名校验、固定操作 UAC）、`src/account/`（`users.rs` 账户与组、`credentials.rs` DPAPI、`firewall.rs` 用户 SID 过滤、`grants.rs` 常驻工作区授权、`status.rs`、`password.rs`）
  - 二进制 `yuantu-sandbox`：`src/bin/yuantu-sandbox/`（`main.rs` 子命令、`exec.rs`、`broker.rs`、`runner.rs`、`spawn.rs` Job 内创建与 profile 环境替换、`token.rs` 令牌配方、`pipe.rs`、`protocol.rs`、`frame.rs`、`provision.rs` 初始化/卸载/grant）
  - 测试：`tests/sandbox_exec.rs`（`broker --dev`，无需账户）、`tests/account_acceptance.rs`（真实账户，需环境变量）
- TS：`packages/tools/sandbox-account.ts`（provider、状态、能力 SID、grant、命令构造）、`packages/tools/sandbox-account-broker.ts`、`packages/tools/sandbox-mode.ts`（`setWindowsAccountReady`、`nativeSandboxBackend`）、`packages/tools/execution-capabilities.ts`；Host 启动时 `apps/agent-host/main.ts` 调 `refreshAccountReadiness()`
- 测试：`tests/sandbox-account.test.ts`（单测，注入假 helper/broker）、`tests/sandbox-account-native.test.ts`（真实账户，CI 专用）
- CI：`.github/workflows/windows-account-sandbox.yml`（独立于 `ci.yml`，一次性管理员 runner 上真实建/删账户）

## 子命令速查（`yuantu-sandbox.exe`）

`account-status`｜`account-setup`/`account-uninstall`（release：签名+受保护安装，UAC 固定操作）｜`account-initialize --handoff PIPE`、`account-remove --elevated`（提权半边）｜debug 专用：`account-initialize --dev-direct`、`account-remove --dev-direct`（需已提权 + `YUANTU_SANDBOX_DEV_PROVISION=1`）、`broker --dev`｜`broker --account offline|online`｜`grant --root R --capability S`、`ungrant --root R`｜`exec --broker PIPE --request FILE`｜`runner --control ID --owner SID`

## 剩余工作

1. **确认 2c 在 CI 上通过**：`Windows sandbox accounts` workflow 对 commit `61f1a20` 的两步验收（cargo `account_acceptance` 与 `node scripts/run-tests.mjs tests/sandbox-account-native.test.ts`），以及 `CI` workflow 的 `check`。失败就修。
2. **2d 桌面端**：`apps/desktop/sandbox-setup.ts` 增加账户后端的 status/initialize/uninstall（结构同现有 `WindowsSandboxSetup`，调用 `account-status`/`account-setup`/`account-uninstall`），设置面板显示 未初始化/就绪/损坏（原因来自 status 的 `problems`），初始化/卸载后调用 `refreshAccountReadiness()`；`windows` 回退时 EPERM 提示（`packages/tools/sandbox-launch-failure.ts` 的 `SANDBOX_CHILD_SPAWN_NOTE`）改为引导“初始化沙箱账户”。界面文案走现有 i18n（`npm run i18n:check`）。
3. **读取白名单（spec §5.2）**：沙箱账户读不到桌面用户 profile，nvm/`%APPDATA%\npm` 等工具链不可用。在 `grants.rs` 增加只读授权（组 RX、可继承），默认条目为桌面用户 PATH 中位于其 profile 下的目录与 `.gitconfig`，拒绝列表永远优先（`.ssh`、`.aws`、`.gnupg`、`.azure`、`.kube`、`.docker`、浏览器 profile、Credentials、DPAPI、本产品凭据目录）；记录并在卸载时撤销。
4. **发布**：`yuantu-sandbox.exe` 纳入签名清单与受保护安装（参照 `scripts/copy-sandbox-assets.mjs`、`scripts/check-windows-package.mjs`、`electron-builder.protected.config.cjs` 对 `yuantu-appcontainer.exe` 的处理）。
5. 可选：私有桌面（runner 与命令在独立 desktop，spec §3.3）；终端（ConPTY）不在范围。

## 约定与坑

- 每个改动先写/改测试，`cargo test --locked`（crate 目录）、`npm run typecheck`、`npm run format:check`、`npm run test:isolation:check`、相关 `node scripts/run-tests.mjs <files>` 通过后再提交；提交信息中文、末尾带 Co-Authored-By 行（按仓库既有风格）。
- 不要修改 `packages/tools/sandbox-windows.ts` 与 `windows-sandbox/acl.ps1` —— 另有会话（分支 `claude/quizzical-vaughan-bc49fa`）在修旧后端；`bench`（`claude/elated-pike-1e2260`）、`native-macos`（`claude/happy-mestorf-a631c3`）也各有会话在修，不要碰。
- 本机是 Windows 11 家庭版，**不要在本机真实初始化账户**；真实账户只在 GitHub Actions 上验证。
- 用脚本（`sed`/`node -e`）写含反斜杠的 Rust/TS 代码会被转义吞掉——这次出过三次 bug（含 runner 工作目录 `C:\WindowsSystem32`），改用编辑器直接写。
- 本机系统 TEMP 在某些执行环境下不可写；测试用 `CARGO_TARGET_TMPDIR` 或仓库内目录。
- CI 日志需登录 GitHub 才能下载；验收测试在 GitHub Actions 下会把失败原因写成 annotation（`::error`），不登录也能在 run 页面看到。
- `cargo test` 从 PowerShell 7 启动时，子进程 Windows PowerShell 5.1 需要 `env_remove("PSModulePath")`。
- WFP 会规范化安全描述符（通用权限映射、`AI` 标志），比对必须按语义（`network.rs` 的 `same_security`）。
- 工作区里 `apps/desktop/layout.css`、`apps/desktop/renderer-permissions.ts` 有用户自己未提交的改动，不要提交或覆盖。
