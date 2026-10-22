# Windows 沙箱加固 1：卸载前停止沙箱进程、初始化/卸载全局互斥 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 卸载时先禁用沙箱账户、结束它们的全部进程并等登录会话退出，再删除 WFP 与账户；初始化和卸载的提权部分由机器级互斥锁串行化。

**Architecture:** 新增两个原生模块：`account/setup_lock.rs`（`Global\YuanTuSandboxSetup` 命名互斥体，只允许 SYSTEM 与管理员打开）和 `account/processes.rs`（按用户 SID 枚举并结束进程、检查剩余登录会话）。`provision.rs` 的提权路径 `provision()` 与 `remove_everything()` 在锁内执行；卸载顺序改为「禁用账户 → 停进程/等会话 → 删 WFP → 删账户」，准备阶段失败则恢复账户状态并保留 WFP。

**Tech Stack:** Rust（`windows-sys` 0.61）、`yuantu-sandbox.exe`、GitHub Actions Windows runner 上的真实账户验收。

**Spec:** `docs/superpowers/specs/2026-10-21-windows-account-sandbox-design.md`（本计划修订 §4.1 卸载顺序与 §7 错误处理）；参照 Codex `codex-rs/windows-sandbox-rs/src/setup_mutex.rs`、`uninstall_windows.rs`、`uninstall_windows/processes.rs`（`openai/codex@86e17e9`）。

## 为什么

现在卸载的提权半边先删 WFP 再删账户。若此时离线账户还有命令在运行（runner 或其子进程），WFP 一删它立刻能联网；账户删除后进程仍以已删除的 SID 运行。两个 `account-setup` / `account-uninstall` 同时运行时，账户、组和 WFP 的增删可能交错，留下半完成状态。

## Global Constraints

- 只改分支 `windows-sandbox-hardening`；不推送 `main`，不 force push。
- 本机不得真实创建或删除沙箱账户；需要账户的验证只在 GitHub Actions 的 `Windows sandbox accounts` workflow 上做。
- 提交前本地通过：`cargo test --locked`（crate 目录，PowerShell 7 下 `env -u PSModulePath`）、`npm run format:check`、`npm run docs:check`。
- 提交信息中文，末尾 `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`。
- 不做 Codex 的 `retained_logons`：它服务于 Codex 的 SYSTEM 清理服务，我们没有对应组件。

## 文件结构

- Create `packages/tools/windows-sandbox/native/src/account/setup_lock.rs`：互斥锁获取与释放。
- Create `packages/tools/windows-sandbox/native/src/account/processes.rs`：按 SID 结束进程、检查登录会话。
- Modify `packages/tools/windows-sandbox/native/src/account/mod.rs`：导出两个模块。
- Modify `packages/tools/windows-sandbox/native/src/account/users.rs`：`disable()` / `DisabledAccounts::restore()`；已存在账户在 `ensure_user` 中清除禁用位。
- Modify `packages/tools/windows-sandbox/native/src/bin/yuantu-sandbox/provision.rs`：锁与新卸载顺序。
- Modify `packages/tools/windows-sandbox/native/Cargo.toml`：`windows-sys` 增加 `Win32_System_RemoteDesktop` 特性（`WTSEnumerateProcessesW`）。
- Modify `packages/tools/windows-sandbox/native/tests/account_acceptance.rs`：卸载时仍有命令在运行的真实验收。
- Modify 设计文档 §4.1、§7 与交接说明。

---

### Task 1：机器级初始化/卸载互斥锁

**Files:**
- Create: `src/account/setup_lock.rs`
- Modify: `src/account/mod.rs`、`src/bin/yuantu-sandbox/provision.rs`

**Interfaces:**
- Produces: `pub fn acquire(timeout_ms: u32) -> Result<SetupLock>`（全局名）；`pub(crate) fn acquire_named(name: &str, sddl: &str, timeout_ms: u32) -> Result<SetupLock>`（测试用局部名）；`SetupLock` 在 Drop 时 `ReleaseMutex`，`!Send`。

- [ ] **Step 1：写失败测试**（`setup_lock.rs` 内 `#[cfg(test)]`）。非提权用户没有 `SeCreateGlobalPrivilege`，测试用 `Local\` 名：
  - 同一名字，持锁时另一线程 `acquire_named(.., 50)` 返回 `Err` 且含 `timed out`；
  - Drop 后另一线程能立即获取；
  - 持锁线程不释放就退出（abandoned）后，下一次获取成功。
- [ ] **Step 2：运行确认失败**：`cargo test --locked --lib setup_lock` → 编译失败（模块不存在）。
- [ ] **Step 3：实现**：SDDL `D:P(A;;GA;;;SY)(A;;GA;;;BA)` 生成 `SECURITY_ATTRIBUTES`，`CreateMutexW(.., FALSE, name)`；`WaitForSingleObject` 的 `WAIT_OBJECT_0 | WAIT_ABANDONED` 视为获得（崩溃的持有者不应永久阻塞，初始化本身会修复半完成状态），`WAIT_TIMEOUT` 返回 `"Timed out waiting for the sandbox setup lock after {ms} ms"`。测试 SDDL 用 `D:P(A;;GA;;;<当前用户 SID>)`。
- [ ] **Step 4：接入**：`provision()` 与 `remove_everything()` 开头 `let _lock = setup_lock::acquire(30_000)?;`。两者都只在提权进程中调用（`account-initialize`、`account-remove --elevated` 与两条已提权同进程路径）。
- [ ] **Step 5：运行通过并提交**：`cargo test --locked`；提交 `feat(windows-sandbox): 初始化与卸载的提权部分由机器级互斥锁串行化`。

### Task 2：按 SID 结束进程并等待登录会话退出

**Files:**
- Create: `src/account/processes.rs`
- Modify: `src/account/mod.rs`、`Cargo.toml`

**Interfaces:**
- Produces: `pub fn stop(sids: &[String], deadline: Duration) -> Result<()>`；内部 `fn stop_where(select: impl Fn(u32, &str) -> bool, sids_for_logons: &[String], deadline: Duration) -> Result<()>`（`u32` 为 PID，`&str` 为进程令牌用户 SID）；`fn blocking_logon(sids: &[String]) -> Result<Option<String>>`。

- [ ] **Step 1：写失败测试**：
  - 启动 `cmd.exe /c ping -n 60 127.0.0.1 > NUL` 子进程，`stop_where(|pid, _| pid == child_pid, &[], 5s)` 返回 `Ok`，随后 `child.try_wait()` 为 `Some`；
  - `stop_where(|_, _| false, &[], 1s)` 立即 `Ok`，测试进程本身仍在；
  - `blocking_logon(&["S-1-5-21-1-2-3-999999".into()])` 为 `Ok(None)`。
- [ ] **Step 2：运行确认失败**。
- [ ] **Step 3：实现**（照 Codex `processes.rs`）：循环直到截止时间——`WTSEnumerateProcessesW` 取快照，对 `pUserSid` 命中且 `select` 为真的项 `OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_TERMINATE | SYNCHRONIZE)`，打开后再用 `OpenProcessToken` 读一次用户 SID 复核（防 PID 复用），`TerminateProcess` 后 `WaitForSingleObject` 剩余时间；本轮无进程后调用 `blocking_logon`，`LsaEnumerateLogonSessions` + `LsaGetLogonSessionData`，跳过 `0:0x3e7` 与已消失会话，SID 命中即返回描述；仍有则 sleep 50ms 重试，超时返回 `"Sandbox processes or logons remain after the uninstall deadline: {detail}"`。`OpenProcess` 返回 `ERROR_INVALID_PARAMETER`（进程已退出）跳过。
- [ ] **Step 4：Cargo 特性**：`windows-sys` 增加 `"Win32_System_RemoteDesktop"`。
- [ ] **Step 5：运行通过并提交**：`feat(windows-sandbox): 按账户 SID 结束沙箱进程并等待登录会话退出`。

### Task 3：卸载顺序与账户禁用

**Files:**
- Modify: `src/account/users.rs`、`src/bin/yuantu-sandbox/provision.rs`

**Interfaces:**
- Consumes: Task 1 `setup_lock::acquire`、Task 2 `processes::stop`。
- Produces: `pub fn disable() -> Result<DisabledAccounts>`（返回存在的账户名、SID 与原 `usri1_flags`）；`impl DisabledAccounts { pub fn sids(&self) -> Vec<String>; pub fn restore(&self) -> Result<()> }`。

- [ ] **Step 1：实现 `disable`**：对 `Account::ALL` 中存在的账户 `NetUserGetInfo(level 1)` 读 `usri1_flags`，`NetUserSetInfo(level 1008, flags | UF_ACCOUNTDISABLE)`；任一失败则恢复已改的账户并返回错误。`restore` 写回原 flags，忽略 `NERR_UserNotFound`。
- [ ] **Step 2：`ensure_user` 清除禁用位**：账户已存在时，除重置密码外读取 flags，若带 `UF_ACCOUNTDISABLE` 则清除（中断的卸载不能让下次初始化得到一个登录不了的账户）。
- [ ] **Step 3：`remove_everything` 新顺序**：
  ```rust
  fn remove_everything() -> Result<()> {
      let _lock = setup_lock::acquire(30_000)?;
      let disabled = users::disable()?;
      if let Err(error) = processes::stop(&disabled.sids(), Duration::from_secs(10)) {
          // WFP and the accounts are still in place, so restoring the flags returns to a safe, working state.
          return Err(match disabled.restore() {
              Ok(()) => error,
              Err(restore) => format!("{error}; restoring the sandbox accounts also failed: {restore}"),
          });
      }
      firewall::remove_filters()?;
      users::remove()
  }
  ```
- [ ] **Step 4：本地验证**：`cargo test --locked` 全过（本机无账户时 `disable` 返回空集，不改动任何账户）。
- [ ] **Step 5：提交**：`fix(windows-sandbox): 卸载先禁用账户并结束其进程，再删除网络过滤与账户`。

### Task 4：真实账户验收与文档

**Files:**
- Modify: `tests/account_acceptance.rs`、设计文档、交接说明

- [ ] **Step 1：验收**：在第 7 步卸载前，用离线 broker 以 `exec` 启动一个不会自行退出的命令（`node -e "setInterval(()=>{},1000)"`），这次不等待（新增 `exec_spawn` 返回 `Child`）；然后 `account-uninstall`，断言：
  - 卸载成功；
  - 15 秒内该 `exec` 子进程退出（runner 被结束，管道断开）；
  - 卸载后 `account-status --verify` 报 `accounts-missing`（已有检查）。
- [ ] **Step 2：文档**：设计 §4.1 写明卸载顺序与锁；§7 增加「卸载准备失败时恢复账户、保留 WFP」；交接说明加入本计划与 Codex 对照。
- [ ] **Step 3：本地检查**：`cargo test --locked`、`npm run format:check`、`npm run docs:check`。
- [ ] **Step 4：推送一次**，看 `Windows sandbox accounts` run；全绿后再手动触发 `CI jobs=all`。
- [ ] **Step 5：提交**：`test(windows-sandbox): 卸载时仍有命令运行的真实账户验收`、`docs(windows-sandbox): 卸载顺序与互斥锁`。
