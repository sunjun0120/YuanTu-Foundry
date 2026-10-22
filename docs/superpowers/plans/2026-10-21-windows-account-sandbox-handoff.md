# Windows 沙箱账户后端：交接说明（给接手的 Agent）

日期：2026-10-22　分支：`windows-account-sandbox`（不要推送到 `main`，不要 force push）

## 现状

按 Codex `elevated` 思路实现的账户沙箱已经完成，并按 2026-10-22 的决定删除 helper 签名校验、统一开发版/正式版初始化、改用初始化标记判断就绪、去掉自动回退。当前提交：

- `20579e9` 删除 helper 签名校验与受保护安装
- `d1e2586` 开发版与正式版统一账户初始化流程
- `1bde623` 用初始化标记判断账户就绪
- `14596ef` 去掉 `native` 到 `windows` 的自动回退
- `da65401` 自动发现并授权工具链读根目录（2e，原生）
- `9f20fbb` 沙箱可读目录改为自动发现，设置页收敛为三态（2e，TS/桌面）
- `84f35a4` 可继承读授权真正传播到子对象，修正已删除对象与重叠授权（2e 本地实跑单测后的修复）

| 阶段 / 任务                                                                | 状态                                                                |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| 1 spike                                                                    | 完成                                                                |
| 2a 原生执行链路（exec/broker/runner、IPC、Job）                            | 完成，CI 通过                                                       |
| 2b 初始化/卸载/状态、DPAPI 凭据、WFP 按用户 SID 断网                       | 完成，真实账户验收通过                                              |
| 2c TS 接入（provider、broker 管理、常驻 grant、构建产出 exe）              | 完成，真实账户 TS 验收 1 pass / 0 skip                              |
| 2d 桌面设置、读取白名单、初始化标记                                        | 完成，Electron 设置 smoke 通过                                      |
| 2026-10-22 收尾：删除签名/受保护安装、统一初始化、标记就绪、去回退         | 完成；真实账户 run `39728114611` 通过，后续 run `39729396999` 见 CI |
| 2e 读根目录自动 refresh、设置页三态（计划 `2026-10-22-…-read-refresh.md`） | 完成；本地 `cargo test` 69 pass，真实账户验收待 CI                  |
| 私有桌面                                                                   | **未做**（已知限制，见设计 §3.3 / §7.1）                            |
| 全量 `CI`（`jobs=all`）与 PR                                               | 待用户触发/同意，见文末                                             |

真实账户验收只允许在一次性 GitHub Actions Windows runner 上进行；**不要在本机初始化或移除账户**。

## 架构

`native` 在 Windows 上**始终**选择 `windows-account`：

```
agent-host（桌面用户）
  ├─ yuantu-sandbox.exe broker --account offline|online
  │    └─ CreateProcessWithLogonW(沙箱账户) → runner
  │         └─ 受限令牌 → CreateProcessAsUserW，每条命令一个 Job
  └─ yuantu-sandbox.exe exec --broker PIPE --request FILE
```

- 两个本地账户 `YuanTuSandboxOffline` / `YuanTuSandboxOnline`，组 `YuanTuSandboxUsers`。
- 离线账户由 WFP 按用户 SID 断网；联网账户不受限。
- 工作区写授权用组 + 每工作区能力 SID；读白名单是不可继承的逐对象 RX 快照。
- 密码由 DPAPI（CurrentUser）保存，只经提权交接管道传输。
- 初始化的最后一步原子写入 `%USERPROFILE%\.yuantu\sandbox-state\windows-account\setup_marker.json`；`account-status` 只读标记和凭据，`account-status --verify` 做实时诊断。
- `windows` 仍是用户手动选择的较弱后端（受限令牌）：无独立账户、网络隔离更弱、子进程可能 `spawn EPERM`；任何地方都不再自动切过去。

## 代码地图

- 原生 crate：`packages/tools/windows-sandbox/native/`
  - 库：`src/lib.rs`、`src/wfp.rs`、`src/account/`（`users.rs`、`credentials.rs`、`firewall.rs`、`grants.rs`、`read_grants.rs`、`setup_marker.rs`、`status.rs`、`password.rs`）
  - 二进制 `yuantu-sandbox`：`src/bin/yuantu-sandbox/`（`main.rs`、`exec.rs`、`broker.rs`、`runner.rs`、`spawn.rs`、`token.rs`、`pipe.rs`、`protocol.rs`、`frame.rs`、`provision.rs`）
  - 测试：`tests/sandbox_exec.rs`（`broker --dev`，无需账户）、`tests/account_acceptance.rs`（真实账户，需 `YUANTU_SANDBOX_ACCOUNT_ACCEPTANCE=1`）
- TS：`packages/tools/sandbox-account.ts`、`sandbox-account-broker.ts`、`sandbox-mode.ts`（`nativeSandboxBackend` 恒返回 `windows-account`）、`execution-capabilities.ts`、`sandbox-launch-failure.ts`
- 桌面：`apps/desktop/sandbox-setup.ts`、`renderer-sandbox-setup.ts`、`main.ts`（设置 IPC）、`permission-presets.ts` / `session-choices.ts`（预设保留显式 `windows` 后端）
- 测试：`tests/sandbox-account.test.ts`、`tests/sandbox-account-native.test.ts`（真实账户，CI 专用）、`tests/windows-account-setup.test.ts`、`tests/windows-account-settings.smoke.mjs`
- CI：`.github/workflows/windows-account-sandbox.yml`（独立真实账户验收）、`.github/workflows/ci.yml`

## 子命令速查（`yuantu-sandbox.exe`）

`account-status`（标记 + 凭据）｜`account-status --verify`（实时诊断）｜`account-setup` / `account-uninstall`（用户入口；已提权则同进程，否则 UAC）｜`account-initialize --handoff PIPE`、`account-remove --elevated`（UAC 半边）｜`broker --dev`（测试）｜`broker --account offline|online`｜`grant --root R --capability S`、`ungrant --root R`｜`read-refresh --env FILE`（自动根）｜`read-grant` / `read-ungrant`（用户路径）｜`exec --broker PIPE --request FILE`｜`runner --control ID --owner SID`

`--dev-direct`、`YUANTU_SANDBOX_DEV_PROVISION`、`install-preflight`、`maintenance.rs`、签名清单和受保护打包配置都已删除。

## 验证证据与剩余

- 全量 CI 基线 `11d9e28`：run `39724750494`（`jobs=all`）5 个 job 全绿；`check` 2986 = 2889 pass / 0 fail / 97 skip，`bench` 15 条规则通过，`native-macos` 通过。
- 任务 2 真实账户：run `39728114611` 全绿。Rust `account-setup`/`account-uninstall` 真实验收、TS provider 验收、Electron 设置 smoke 都实际执行，0 skip。
- 任务 3/4 真实账户：run `39729396999`（提交 `14596ef`）已触发；看 run 页面与原始日志确认标记写入/删除和设置 smoke。
- 2e（`da65401`/`9f20fbb`/`84f35a4`）：本地 `cargo test` 69 pass / 0 fail，typecheck、format、i18n、docs、references、isolation 检查通过；推送后看 CI 与 Windows sandbox accounts 的 run。
- 尚未完成：最终提交的全量 `CI`（`jobs=all`）需要用户手动触发；创建 PR 需用户同意；私有桌面未做。

## 约定与坑

- 每个改动先写/改测试，提交前本地通过：`cargo test --locked`（crate 目录）、`npm run typecheck`、`npm run format:check`、`npm run i18n:check`、`npm run test:isolation:check`、`npm run docs:check`、`npm run references:check`，以及相关 `node scripts/run-tests.mjs <files>`。
- 提交信息中文，按仓库风格，末尾带 `Co-Authored-By: DeepSeek <noreply@deepseek.com>`。
- 只推送 `windows-account-sandbox`；不要推送 `main`，不要 force push。
- 本机 Windows 11 家庭版：不要在本机真实初始化账户；真实账户只在 GitHub Actions 上验证。
- 用脚本写含反斜杠的 Rust/TS 代码会被转义吞掉，直接用编辑器写文件。
- 从 PowerShell 7 启动 `cargo test` 时，子进程 Windows PowerShell 5.1 需要 `env_remove("PSModulePath")`；本机 `%TEMP%`（`D:\Temp\sunjun`）下旧 `windows` 后端的 ACL `Pin` 会失败，这是本机环境问题，不等同于 CI 失败。
- `npm run smoke:desktop` 在 Windows 上没有初始化账户时使用 `windows` 后端：CI 的 smoke 步骤设置 `YUANTU_SANDBOX=windows`；本机手动跑也可这样设置。
- 读授权 ACL 单测必须在受保护的临时目录上跑（`make_profile_like`）：数据盘默认给 `Users` 读，根目录会被 `broadly_readable` 跳过，测试会在什么都没测的情况下提前返回。
- 可继承 ACE 必须用 `SetSecurityInfo` 写才会传播到已有子对象；`SetKernelObjectSecurity` 不传播。`OpenFileById` 打开已删除文件返回 87（`ERROR_INVALID_PARAMETER`），按"对象已删除"处理。
- `bench` 和 `native-macos` 当前基线已通过，不要在无证据时改门槛或加 skip。
