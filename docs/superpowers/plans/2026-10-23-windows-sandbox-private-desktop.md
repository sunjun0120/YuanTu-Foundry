# Windows 沙箱加固 2：私有桌面 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 沙箱命令运行在 broker 创建的私有桌面上，不能通过窗口消息、UI Automation、钩子或输入合成操作用户桌面（包括审批界面）。

**Architecture:** broker（桌面用户）启动时 `CreateDesktopW` 创建一个随机命名的私有桌面，DACL 只给桌面用户完全访问、给沙箱账户（`--dev` 时为当前用户）参与访问，broker 持有句柄直到退出。runner 启动参数增加 `--desktop NAME`；runner 启动时 `OpenDesktopW` 校验它存在（不回退到 Default），之后每条命令的 `STARTUPINFO.lpDesktop` 设为 `Winsta0\NAME`。runner 自身仍在 Default 桌面：显式指定桌面时 `CreateProcessWithLogonW` 不再代为授予窗口站权限。

**Tech Stack:** Rust（`windows-sys` 0.61，`Win32_System_StationsAndDesktops`）、`yuantu-sandbox.exe`、GitHub Actions 真实账户验收。

**Spec:** `docs/superpowers/specs/2026-10-21-windows-account-sandbox-design.md` §3.3 / §7.1（本计划把「私有桌面未实现」改为已实现）；参照 Codex `desktop.rs`、`elevated/runner_client.rs`、`process.rs`（`openai/codex@86e17e9`）。

## 为什么

`CreateProcessWithLogonW` 启动的 runner 与调用者共享 logon SID，而命令的受限令牌把 logon SID 列为限制 SID；Default 桌面授予的正是这个 logon SID。所以现在沙箱命令可以在用户桌面上枚举窗口、发消息、装钩子、合成输入，审批界面也在其中。

## Global Constraints

- 分支 `windows-sandbox-hardening`；不推送 `main`，不 force push。
- 本机不得真实创建或删除沙箱账户；账户路径只在 `Windows sandbox accounts` workflow 上验证。`broker --dev` 路径可本地验证。
- 提交前本地通过：`cargo test --locked`、`npm run format:check`、`npm run docs:check`。
- 不新增产品子命令；桌面探测用测试专用二进制 `desktop-probe`（打包只复制 `yuantu-sandbox.exe`）。
- 提交信息中文，末尾 `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`。

## 文件结构

- Create `src/bin/yuantu-sandbox/desktop.rs`：`PrivateDesktop::create(participant_sid)`、`name()`、`validate_name()`、`open(name)`。
- Create `src/bin/desktop-probe.rs`：打印当前线程所在桌面名。
- Modify `src/bin/yuantu-sandbox/broker.rs`：创建桌面，runner 命令行加 `--desktop`。
- Modify `src/bin/yuantu-sandbox/main.rs`、`runner.rs`、`spawn.rs`：解析与传递桌面名，`lpDesktop`。
- Modify `Cargo.toml`：`Win32_System_StationsAndDesktops`。
- Modify `tests/sandbox_exec.rs`、`tests/account_acceptance.rs`、设计文档、交接说明。

---

### Task 1：私有桌面对象

**Interfaces:**

- Produces: `pub struct PrivateDesktop`（Drop 时 `CloseDesktop`）；`pub fn create(participant_sid: &str) -> Result<PrivateDesktop>`；`pub fn name(&self) -> &str`；`pub fn validate_name(name: &str) -> bool`（`YuanTuSandboxDesktop-` 后接 32 位十六进制）；`pub fn open(name: &str) -> Result<OpenedDesktop>`（校验名字后 `OpenDesktopW`，不存在即错误）；`pub fn startup_name(name: &str) -> String`（`Winsta0\{name}`）。

- [x] **Step 1：失败测试**（`desktop.rs` 内）：`create(当前用户 SID)` 得到合法名字，`open(name)` 成功；Drop 后 `open` 失败；`validate_name` 拒绝 `Default`、`YuanTuSandboxDesktop-`、带非十六进制或超长后缀。
- [x] **Step 2：确认失败**。
- [x] **Step 3：实现**：名字用 `password::generate` 同源的随机数生成 128 位十六进制；SDDL `D:P(A;;0x{ALL:x};;;{owner})(A;;0x{PARTICIPANT:x};;;{participant})`，`ALL` 与 `PARTICIPANT` 取值同 Codex（参与者去掉 `WRITE_DAC | WRITE_OWNER | DELETE`）；owner 为当前进程令牌用户 SID（不用 logon SID：它与沙箱共享）。
- [x] **Step 4：通过并提交** `feat(windows-sandbox): broker 侧私有桌面对象`。

### Task 2：broker → runner → 命令接入

- [x] **Step 1：失败测试**（`tests/sandbox_exec.rs`）：`broker --dev` 下以 `desktop-probe` 为命令，输出以 `YuanTuSandboxDesktop-` 开头且不是 `Default`；新建 `src/bin/desktop-probe.rs`（`GetThreadDesktop(GetCurrentThreadId())` + `GetUserObjectInformationW(UOI_NAME)`）。
- [x] **Step 2：确认失败**（输出为 `Default`）。
- [x] **Step 3：实现**：broker 启动时 `desktop::create(participant)`（`--account` 为账户 SID，`--dev` 为当前用户 SID），保存在 broker 状态中；runner 命令行追加 `--desktop {name}`；`main.rs` 匹配 `["runner", "--control", c, "--owner", o, "--desktop", d]` 且 `validate_name(d)`；`runner::run` 启动时 `desktop::open(d)` 并保存，`spawn` 设置 `StartupInfo.lpDesktop`。
- [x] **Step 4：全量 `cargo test --locked` 通过并提交** `feat(windows-sandbox): 沙箱命令运行在私有桌面上`。

### Task 3：真实账户验收与文档

- [ ] **Step 1：验收**：离线 broker 下以 `desktop-probe` 为命令（先给其目录授予组 RX，同现有 icacls 步骤），断言输出为私有桌面名。
- [ ] **Step 2：文档**：设计 §3.3 改为已实现并写明桌面 DACL、生命周期与 runner 留在 Default 的原因；§7.1 删除「私有桌面未做」；交接表更新。
- [ ] **Step 3：本地检查、推送一次、看真实账户 run；全绿后手动触发 `CI jobs=all`。**
