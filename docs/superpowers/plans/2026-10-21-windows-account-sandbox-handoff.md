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

## 2026-10-21 接续状态（覆盖上文旧状态）

- 已确认 `61f1a20` 的账户 workflow `39565576275` 步骤成功，Rust 真实账户验收通过。随后检查本轮 `39571602614` 原始日志发现：TS 步骤被隔离运行器清除 `YUANTU_*` 开关而跳过，不能按成功步骤认定真验收。本轮改用测试运行器保留的 `FOUNDRY_TEST_WINDOWS_ACCOUNT_ACCEPTANCE`，且 workflow 强制 1 pass / 0 skip；真实验收仍限 GitHub Actions。通用 CI `39565576344` 的格式阻断已修正。
- 2d 桌面账户状态、初始化/修复/卸载、自定义读取路径及中英文入口已实现。维护前停止本 Host 的 broker，维护后刷新桌面和运行中 Host 的就绪缓存；真实 Electron 开发版 smoke 验证了入口、中英文及禁用 UAC 操作。
- 读取白名单已实现，覆盖默认用户 PATH 目录与 `.gitconfig`，支持显式增删；按卷序列号、文件 ID、创建时间记录对象并撤权，同卷移动和重命名也能恢复。卸载先以桌面用户身份撤销读/工作区授权，再执行固定 UAC 操作。
- 安全审查修订 spec §5.2：读取授权采用**不可继承的逐对象 RX 快照**。原定继承 RX 会让后来新建的 `.ssh` 自动可读，因此选择拒绝规则优先；新增工具文件须重新授权。撤销不遍历后来新增的敏感目录或链接，权限/身份冲突保留恢复记录。
- 发布链已接入两份 helper 的独立签名哈希、时间戳校验和打包后验证；本轮没有执行真实签名、安装或本机账户初始化。受保护安装生命周期仍保持原有验收门槛，私有 desktop 仍为可选后续项。
- 本地验证：Rust 普通全回归、相关 TS 回归、真实 Electron smoke、typecheck、format、i18n 和隔离检查通过。一次本地 `npm test` 因 `host-carrier-auth.test.ts` 进程清理检查中断，18/287 文件结算，327 用例通过，**不是全量通过**；原始日志保留于 `.scratch/account-full-test.log`。
- 最新分支改动仍需推送后的 Actions 账户验收及通用 `check` 确认；后续结果追加本节。不要在本机设定账户验收或建户开关。
- `9577f2b` 已修复 TS 验收被跳过和 Electron 准备问题。真实运行 TS provider 后进一步复现：profile 下工作区的祖先目录缺少读取属性权限，Node 在 `AppData` 的 lstat 上 EPERM。本轮补充了仅遍历/属性的不可继承祖先授权，独立记录、按文件身份撤销；它不会授予目录枚举或文件内容读取。原生回归先复现缺失接口再通过，真实行为仍由后续 Actions 验证。
- `444a2af` 的通用 `check` 已通过。账户 TS 验收发现并发工作区准备会争用祖先授权日志锁，已改为最长 5 秒的有界等待；工作区授权日志也复用该锁串行提交，验收新增同时保留两条恢复记录的断言。后续需确认该并发修复的账户 workflow 全部通过。
- `ab52137` 的通用 `check`、coverage、bench 已通过（run `39575625311`）；native-macos 与旧 Windows desktop-smoke 仍失败，遵循分工未修改。账户 run `39575625096` 已通过并发授权及 Node fork 检查，随后被临时目录的 Windows 8.3 短路径误判阻断；验收改为命令执行期间解析真实路径，同时核对账户身份、profile 归属与临时目录可写性，后续 Actions 确认。
