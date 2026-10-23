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

| 阶段 / 任务                                                                                                                    | 状态                                                                |
| ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------- |
| 1 spike                                                                                                                        | 完成                                                                |
| 2a 原生执行链路（exec/broker/runner、IPC、Job）                                                                                | 完成，CI 通过                                                       |
| 2b 初始化/卸载/状态、DPAPI 凭据、WFP 按用户 SID 断网                                                                           | 完成，真实账户验收通过                                              |
| 2c TS 接入（provider、broker 管理、常驻 grant、构建产出 exe）                                                                  | 完成，真实账户 TS 验收 1 pass / 0 skip                              |
| 2d 桌面设置、读取白名单、初始化标记                                                                                            | 完成，Electron 设置 smoke 通过                                      |
| 2026-10-22 收尾：删除签名/受保护安装、统一初始化、标记就绪、去回退                                                             | 完成；真实账户 run `39728114611` 通过，后续 run `39729396999` 见 CI |
| 2e 读根目录自动 refresh、设置页三态（计划 `2026-10-22-…-read-refresh.md`）                                                     | 完成；真实账户 run `39741279867`（`4d08d1a`）通过                   |
| 加固 1：卸载前停进程、初始化/卸载互斥（计划 `2026-10-23-windows-sandbox-uninstall-lock.md`，分支 `windows-sandbox-hardening`） | 真实账户 run `39750365365` 通过                                     |
| 加固 2：私有桌面（计划 `2026-10-23-windows-sandbox-private-desktop.md`，分支 `windows-sandbox-hardening`）                     | 真实账户 run `39751168935` 通过                                     |
| 加固 3：SSH 配置引用的文件不进入可读根（计划 `2026-10-23-windows-sandbox-ssh-dependencies.md`）                                | 真实账户 run `39751914337` 通过                                     |
| 加固 4：终端走 ConPTY（计划 `2026-10-23-windows-sandbox-conpty.md`；修复 main 上 windows-account 终端无输出）                  | 本地 dev broker 与 node-pty 端到端通过，真实账户验收待 CI           |
| 全量 `CI`（`jobs=all`）与 PR                                                                                                   | 待用户触发/同意，见文末                                             |

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
- 应用命令及 hook 启动环境中的旧 `windows` 配置、桌面设置请求和隔离预设统一迁到 `native`，不再保留旧后端选择。底层 `windows` provider 仅保留给显式兼容性调用；它仍是较弱的受限令牌边界，桌面显示为自定义模式。

## 代码地图

- 原生 crate：`packages/tools/windows-sandbox/native/`
  - 库：`src/lib.rs`、`src/wfp.rs`、`src/account/`（`users.rs`、`credentials.rs`、`firewall.rs`、`grants.rs`、`read_grants.rs`、`setup_marker.rs`、`status.rs`、`password.rs`）
  - 二进制 `yuantu-sandbox`：`src/bin/yuantu-sandbox/`（`main.rs`、`exec.rs`、`broker.rs`、`runner.rs`、`spawn.rs`、`token.rs`、`pipe.rs`、`protocol.rs`、`frame.rs`、`provision.rs`）
  - 测试：`tests/sandbox_exec.rs`（`broker --dev`，无需账户）、`tests/account_acceptance.rs`（真实账户，需 `YUANTU_SANDBOX_ACCOUNT_ACCEPTANCE=1`）
- TS：`packages/tools/sandbox-account.ts`、`sandbox-account-broker.ts`、`sandbox-mode.ts`（`nativeSandboxBackend` 恒返回 `windows-account`）、`execution-capabilities.ts`、`sandbox-launch-failure.ts`
- 桌面：`apps/desktop/sandbox-setup.ts`、`renderer-sandbox-setup.ts`、`main.ts`（设置 IPC）、`permission-presets.ts` / `session-choices.ts`（隔离预设选择 `native`）
- 测试：`tests/sandbox-account.test.ts`、`tests/sandbox-account-native.test.ts`（真实账户，CI 专用）、`tests/windows-account-setup.test.ts`、`tests/windows-account-settings.smoke.mjs`
- CI：`.github/workflows/windows-account-sandbox.yml`（独立真实账户验收）、`.github/workflows/ci.yml`

## 子命令速查（`yuantu-sandbox.exe`）

`account-status`（标记 + 凭据）｜`account-status --verify`（实时诊断）｜`account-setup` / `account-uninstall`（用户入口；已提权则同进程，否则 UAC）｜`account-initialize --handoff PIPE`、`account-remove --handoff PIPE`（UAC 半边，持锁到用户收尾确认；`account-remove --elevated` 保留为固定管理员操作）｜`broker --dev`（测试）｜`broker --account offline|online`｜`grant --root R --capability S`、`ungrant --root R`｜`read-refresh --env FILE`（自动根）｜`read-grant` / `read-ungrant`（用户路径）｜`exec --broker PIPE --request FILE`｜`runner --control ID --owner SID`

`--dev-direct`、`YUANTU_SANDBOX_DEV_PROVISION`、`install-preflight`、`maintenance.rs`、签名清单和受保护打包配置都已删除。

## 验证证据与剩余

- 2026-10-22 主流程迁移：Host、Git、程序执行、LSP、终端、npm 验证以及桌面账户旅程改用 `windows-account` / `native`。`.github/workflows/ci.yml` 和独立账户 workflow 在构建后调用 `scripts/windows-account-ci.mjs setup`，账户旅程无跳过验收后通过 `always()` 清理（包含初始化失败的情形）。脚本要求 GitHub 托管的一次性 Windows runner 和 `FOUNDRY_TEST_WINDOWS_ACCOUNT_JOURNEYS=1`；本机不创建账户。
- `npm run check:windows-sandbox` 现在验证账户主流程；`--desktop` 验证账户桌面流程。旧后端三个专属文件从默认发现中分离，仍可通过 `npm run check:windows-legacy-sandbox` 显式验证，不计作账户验收。未启用 CI 账户旅程的本地默认测试会明确跳过真实账户用例。
- 本次迁移的真实账户、桌面完整旅程尚未在 Actions 执行；以下历史账户 run 不代表本次迁移已经验收。
- 独立审查修复了 CI 资产授权范围：只递归授权 Node 安装目录和干净的 `dist` 树；源码 helper、程序 entry / worker / environment 四个文件单独授权 RX 并在卸载前撤回，避免扫描 Cargo target 硬链接。定向回归两轮 72 pass / 0 fail（run `1792682105492-27284-95535fb9-4a8f-4d7c-a6ef-f81bdfd8f5d2`）和 65 pass / 0 fail（run `1792682242999-11904-97bfa6cb-5fbe-4a76-a55b-b84ae27a30b3`）；账户旅程本机验证为 13 skip / 0 fail（run `1792681814474-16600-92f74c42-c2ea-4261-b50b-9e17f3ac66ae`），不计作真实账户通过。
- 本次默认全量 run `1792681658092-9656-0b96e215-bb76-4b21-8496-0c3f7b405fd5`：283 文件，2909 pass / 10 fail / 41 skip，10 个失败均为 `test-workflow.test.ts` 的临时调度器副本未复制新增 `windows-sandbox-suites.mjs`。补齐后该文件 29 / 29 复跑通过（包含在上述 72 项中）；其余文件全量未见失败。全量运行期间的修复已做定向复验，未再重复一次完整全量；本地真实账户跳过和 Actions 待验收边界不变。

- 2026-10-23 保留路径加固（设计 §5.1）：授权/撤销改为不跟随 reparse 的句柄写入（防检查后换 junction）；每条命令前随 `read-refresh` 复查保留路径并覆盖 `.git` 文件，保护失败则 Host 拒绝命令；根目录加组拒绝 `WRITE_DAC | WRITE_OWNER`、`OWNER RIGHTS` 与桌面用户 `READ_CONTROL | WRITE_DAC`，使沙箱建的 `.git` 也能被保护且撤不掉拒绝；卸载改为按 trustee 过滤，修复 `REVOKE_ACCESS` 留下拒绝 ACE 的旧问题。本地 Rust 单测覆盖 junction 替换、`.git` 文件、二次跳过、自带 DACL 拒绝、根 ACE 顺序与撤销；"沙箱账户确实撤不掉拒绝"只能由 `account_acceptance.rs` 新增段落在 Actions 真实账户上验证，尚未运行。
- 当前工作树的两处审查修复：SSH 依赖检查先规范化现存路径，并排除同一 profile 一级子目录下的候选根；初始化/卸载的锁扩展到用户目录授权、CurrentUser DPAPI 凭据和标记收尾，UAC 半边通过完成确认保持持锁。新增本地回归覆盖路径 `..`、同级工具目录、收尾持锁、失败及断连；真实 UAC/账户验收仍待 GitHub Actions，本机不执行。
- 本次本地验证：Rust 单元/协议/dev broker 共 104 项通过（真实账户测试未启用）；typecheck、format、docs、references、i18n、test:isolation 检查通过。项目全量 run `1792666417671-21452-33f4b224-292a-4a58-9935-512567be881c` 收齐 285 个文件，2924 pass / 39 fail / 29 skip；并行部分 2910 pass / 0 fail，失败均在旧 `windows` 后端的 9 个串行测试文件。
- 失败文件及原失败数：`host-program-process.test.ts`（1）、`native-git-native.test.ts`（1）、`program-process-native.test.ts`（1）、`restricted-consumers-native.test.ts`（6）、`sandbox-windows-assets.test.ts`（2）、`sandbox-windows-recovery.test.ts`（4）、`sandbox-windows.test.ts`（21）、`tools-native.test.ts`（1）、`windows-sandbox-host.test.ts`（2）。原默认 TEMP 的 ACL Pin 拒绝访问；工作区诊断 TEMP 又因继承 Low 完整性标签被旧后端安全拒绝。改用普通 `%LOCALAPPDATA%\Temp` 后，原样重跑这 9 个文件得到 48 pass / 1 fail / 0 skip（run `1792680028030-8364-a3295155-25fd-4897-9c09-0c7623bc2e4e`）；唯一失败是较长诊断目录下 apostrophe 用例触发 PowerShell `Add-Type` 路径过长，换短临时目录原样单测后 1 pass / 0 fail（run `1792680273347-26808-fa29cf67-79ea-4a91-b63f-a6c02c8e0bd0`）。旧后端源码与测试未修改，日志在 `.scratch/test-logs/`；这些环境对照不能替代一次普通环境的完整全量验收，默认环境全量仍未全绿。
- 崩溃边界：UAC 路径中如果提权 helper 在用户提交过程中被外部强杀，系统会释放它拥有的互斥锁；最终确认可报告失败，但不能保证用户进程与另一轮维护之间的崩溃原子性。本次验证不涵盖这一强杀交错。
- 全量 CI 基线 `11d9e28`：run `39724750494`（`jobs=all`）5 个 job 全绿；`check` 2986 = 2889 pass / 0 fail / 97 skip，`bench` 15 条规则通过，`native-macos` 通过。
- 任务 2 真实账户：run `39728114611` 全绿。Rust `account-setup`/`account-uninstall` 真实验收、TS provider 验收、Electron 设置 smoke 都实际执行，0 skip。
- 任务 3/4 真实账户：run `39729396999`（提交 `14596ef`）已触发；看 run 页面与原始日志确认标记写入/删除和设置 smoke。
- 2e（`da65401`/`9f20fbb`/`84f35a4`，CI 修复 `f5889f2` 状态字段名 `readRoots`、`4d08d1a` 验收卸载检查）：真实账户 run `39741279867` 通过；全量 CI run `39741320435`（jobs=all）check/bench/coverage/native-macos/desktop-smoke 全部通过。本地 `cargo test` 70 pass / 0 fail。desktop-smoke 同一 run 通过，5 个 job 全绿。
- 尚未完成：最终提交的全量 `CI`（`jobs=all`）需要用户手动触发；创建 PR 需用户同意。

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
