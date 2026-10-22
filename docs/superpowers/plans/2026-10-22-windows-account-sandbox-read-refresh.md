# Windows 沙箱账户后端 2e：读根目录自动 refresh 与设置页简化 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 沙箱账户不再依赖用户在设置页手填「附加只读路径」就能读到桌面用户目录下的工具链（cargo、rustup、node/nvm、npm 全局包、pnpm、go、bun、deno、scoop 等）。读授权改为「自动发现 + 每个 Host 进程首次执行前不提权 refresh」，设置页收敛为状态行 + 默认折叠的「高级：沙箱可读目录」。

**Architecture:** 原生 helper 新增 `read-refresh --env FILE`：根据桌面端传入的环境变量发现工具链根目录，对每个根加一条**可继承**的 `YuanTuSandboxUsers` RX ACE（及祖先目录 traverse），撤销不再发现的自动授权，并按凭据文件清单做定点检查。用户手动添加的路径仍走现有**快照**授权（`grant_at`/`revoke_at`）。TS 侧在 `accountPrepare` 中、启动 broker 之前调用一次（按环境哈希缓存）。

**Tech Stack:** Rust（`packages/tools/windows-sandbox/native`，windows-sys）、TypeScript（node:test）、Electron 设置页。

**Spec:** `docs/superpowers/specs/2026-10-21-windows-account-sandbox-design.md`（本计划修订其 §5.2，见 Task 7）

**参考实现:** OpenAI Codex `codex-rs/windows-sandbox-rs/src/setup.rs`（`gather_read_roots`、`profile_read_roots`、`USERPROFILE_ROOT_EXCLUSIONS`）、`setup_provisioning.rs`（`apply_read_acls`）、`identity.rs`（`require_logon_sandbox_creds` 每次命令前非提权 refresh）。只借鉴机制，**不照搬范围**：Codex 授予整个 `%USERPROFILE%` 的每个子目录（含 Documents/Desktop/Downloads），我们只授工具链目录。

## 与设计文档的差异（本计划同时修订 spec §5.2）

- **自动发现的工具链根目录改用可继承 RX ACE**（`OBJECT_INHERIT_ACE | CONTAINER_INHERIT_ACE`），不再做整树快照。理由：快照每次补授权都要重走整棵树（`.rustup`、nvm 易逼近 100,000 对象上限），无法做到每次启动自动 refresh；工具链目录基本不会长出凭据目录。风险兜底：每次 refresh 对每个根做**凭据文件定点检查**（只 `exists()` 固定路径，不遍历），命中则对该路径加组的显式拒绝读 ACE；无法加拒绝时跳过整个根并记警告。
- **用户手动添加的任意路径保留快照授权**（现有 `grant_at` 语义不变）。
- 初始化不再调用 `grant_defaults`，改为执行一次 refresh；`grant_defaults` 删除。
- 不变量不变：除沙箱账户自己的 profile 外，不出现直接授予账户 SID 的 ACE；所有读 ACE 的受托者都是 `YuanTuSandboxUsers` 组。

## Global Constraints

- refresh **绝不提权**（不得触发 UAC）。只修改桌面用户自己有 `WRITE_DAC` 的对象；对单个根授权失败只记 `details` 警告并跳过，不让整个 refresh 失败。
- 已经允许 `Users` / `Authenticated Users` / `Everyone` 读取的根直接跳过（同 Codex `apply_read_acls`）。系统目录（`C:\Windows`、`Program Files`、`ProgramData`）因此无需处理，不要加入发现列表。
- 只授权位于桌面用户 profile 之下的目录；profile 根本身永不授权；拒绝清单永远优先（复用并扩充 `read_grants::allowed`）。
- 日志写入沿用 `journal_lock` + 先写日志后改 ACL 的顺序；refresh 必须幂等，并发调用安全。
- 不修改 `packages/tools/sandbox-windows.ts` 与 `windows-sandbox/acl.ps1`（旧后端）。
- 代码风格对齐周边：Rust 错误为 `Result<_, String>` 短句、模块顶部 `//!` 说明；TS 保持现有 `configuration.run` 注入方式以便测试替换。

---

### Task 1：读根目录发现 `account/read_roots.rs`

**Files:**

- Create: `packages/tools/windows-sandbox/native/src/account/read_roots.rs`
- Modify: `packages/tools/windows-sandbox/native/src/account/mod.rs`（`pub mod read_roots;`）
- Modify: `packages/tools/windows-sandbox/native/src/account/read_grants.rs`（扩充拒绝清单）

- [ ] 定义 `pub fn discover(env: &BTreeMap<String, String>, profile: &Path) -> Vec<PathBuf>`，纯函数（只做 `is_dir()`/`canonicalize`），返回去重、规范化后的根目录。来源：
  - `PATH` 中位于 profile 下的目录（沿用现 `grant_defaults` 的过滤）。
  - `CARGO_HOME`（默认 `%USERPROFILE%\.cargo`）→ **只取 `bin`**，不授整个 `.cargo`（内含 `credentials.toml`）。
  - `RUSTUP_HOME`（默认 `%USERPROFILE%\.rustup`）。
  - `NVM_HOME`、`NVM_SYMLINK`；`%APPDATA%\npm`；`PNPM_HOME`（默认 `%LOCALAPPDATA%\pnpm`）。
  - `GOPATH`（默认 `%USERPROFILE%\go`）→ 只取 `bin`；`%USERPROFILE%\.bun\bin`、`%USERPROFILE%\.deno\bin`。
  - `%LOCALAPPDATA%\Programs` 下的直接子目录中出现在 `PATH` 里的那些（不整体授 `Programs`）。
  - scoop：`SCOOP`（默认 `%USERPROFILE%\scoop`）→ `shims` 与 `apps`。
  - 不在 profile 下、不存在、未通过 `allowed()` 的一律丢弃；若某根是另一根的子目录，只保留父根。
- [ ] `.gitconfig` 不放进 `discover`（它是文件，继续走快照授权，见 Task 3）。
- [ ] 在 `read_grants.rs` 扩充拒绝清单并让 `allowed()` 覆盖：`.cargo\credentials.toml`、`.cargo\credentials`、`.npmrc`、`.pypirc`、`.netrc`、`_netrc`、`.git-credentials`、`.docker\config.json`；导出 `pub const CREDENTIAL_FILES: &[&str]`（相对路径，供 Task 2 定点检查用：对每个根检查 `root.join(name)` 以及根内常见同名文件）。
- [ ] 单元测试（`#[cfg(test)]`，用临时目录模拟 profile）：PATH 过滤、默认值回落、只取 `bin`、子目录合并、profile 外路径丢弃、拒绝清单命中丢弃。

### Task 2：可继承授权与日志 v2

**Files:**

- Modify: `packages/tools/windows-sandbox/native/src/account/read_grants.rs`

- [ ] 日志 `read-grants.json` 升级到 `version: 2`：`ReadGrant` 增加 `source: "auto" | "user"` 与 `mode: "inherit" | "snapshot"`。`load` 读到 v1 时迁移为 `source=user, mode=snapshot` 并在下次 `save` 写成 v2；`deny_unknown_fields` 保留。
- [ ] 新增 `grant_inherit_at(root, profile, group, journal_path)`：
  - 先检查 `Users`/`Authenticated Users`/`Everyone` 是否已有 RX，有则不加 ACE 也不记日志。
  - 否则：记录根对象身份与原 SDDL（复用 `Entry`/`recorded`）→ `save` → 对根加一条 `READ_EXECUTE`、`OBJECT_INHERIT_ACE | CONTAINER_INHERIT_ACE` 的组 ACE（新写一个带继承参数的 `change` 变体，不要改动现有快照用的 `grfInheritance: 0` 路径）。
  - 根已有本组完全相同的可继承 ACE → 幂等返回；有不同掩码的本组 ACE → 报错 `"Read root has a conflicting sandbox group grant"`。
  - 成功后调用现有 `grant_metadata_at` 给祖先加 traverse。
- [ ] 新增 `revoke_inherit_locked`：按记录身份找回根对象，移除本组的 ACE（含继承到子对象的那部分会随父 ACE 移除自动消失，按 Windows 继承语义调用 `SetSecurityInfo` 传播）；权限被改过则保留日志并报错，与快照撤销同风格。
- [ ] 凭据定点检查 `guard_credentials(root, group)`：对 `CREDENTIAL_FILES` 中位于该根下的每个已存在路径加组的显式拒绝读 ACE（不可继承）并记入日志条目；加拒绝失败则撤销该根的可继承 ACE 并返回错误供上层跳过。
- [ ] `revoke_all` 与 `audit` 按 `mode` 分派：`inherit` 只检查根对象上的那条 ACE（掩码精确等于 `READ_EXECUTE`、带 OI|CI、受托者为组、无账户 SID 直授）和凭据拒绝 ACE 仍在；`snapshot` 沿用现逻辑。
- [ ] 单元测试：v1→v2 迁移；重复授权幂等；冲突 ACE 报错；撤销后根 DACL 与原 SDDL 一致（在 `target/unit-tmp` 下建临时目录，参照现有 `lock_tests`）。

### Task 3：`read-refresh` 命令与初始化接入

**Files:**

- Create: `packages/tools/windows-sandbox/native/src/account/read_refresh.rs`（或放在 `read_grants.rs` 内，按文件大小决定；`read_grants.rs` 已 860 行，建议新文件）
- Modify: `packages/tools/windows-sandbox/native/src/bin/yuantu-sandbox/main.rs`
- Modify: `packages/tools/windows-sandbox/native/src/bin/yuantu-sandbox/provision.rs`

- [ ] `pub fn refresh(env: &BTreeMap<String,String>, group: &str) -> Result<RefreshReport>`：持 `journal_lock` →`discover` → 对新根 `grant_inherit_at` + `guard_credentials` → 对已有 `auto` 根再跑 `guard_credentials`（新出现的凭据文件）→ 撤销日志里 `source=auto` 但本次未发现的根 → 确保 `%USERPROFILE%\.gitconfig` 存在时有一条 `source=auto, mode=snapshot` 的快照授权（文件消失则撤销）。单根失败写入 `report.skipped: Vec<{path, reason}>`，不中断。
- [ ] `main.rs` 增加 `["read-refresh", "--env", file]`：读取 JSON 文件 `{ "version": 1, "env": { ... } }`（`deny_unknown_fields`），读后删除，调用 `refresh`，stdout 输出 `{"version":1,"roots":[...],"skipped":[...]}`。更新 `usage()` 文本。
- [ ] `provision.rs::finish_initialization`：用当前进程环境调用 `refresh` 取代 `grants::reads::grant_defaults(&group)?`；删除 `grant_defaults`。初始化时 refresh 的单根失败不应导致初始化失败。
- [ ] `read-grant`/`read-ungrant` 保留，写入 `source=user, mode=snapshot`；`read-ungrant` 拒绝撤销 `source=auto` 的条目（返回错误 `"Automatic read roots are managed by refresh"`）。

### Task 4：状态输出暴露读根目录

**Files:**

- Modify: `packages/tools/windows-sandbox/native/src/account/status.rs`
- Modify: `packages/tools/sandbox-account.ts`（`parseAccountStatus`）

- [ ] `Status` 增加 `read_roots: Vec<ReadRootView>`，序列化为 `readRoots: [{ "path": string, "source": "auto" | "user" }]`，来自日志（`status` 与 `verify` 都填；读日志失败时为空并在 `details` 记一条）。`version` 保持 1，但 TS 解析须容忍并要求新字段（同一次提交里两边一起改）。
- [ ] `parseAccountStatus` 严格校验新字段形状，`AccountStatus` 类型增加 `readRoots`。
- [ ] 更新 `tests/windows-account-setup.test.ts` 等使用 status 夹具的测试。

### Task 5：TS 执行路径调用 refresh

**Files:**

- Modify: `packages/tools/sandbox-account.ts`
- Test: `tests/windows-account-setup.test.ts`（或该文件所在的 sandbox-account 测试）

- [ ] 仿照 `ensureGrant` 新增 `ensureReadRefresh(env)`：以 `PATH`、`CARGO_HOME`、`RUSTUP_HOME`、`NVM_HOME`、`NVM_SYMLINK`、`PNPM_HOME`、`GOPATH`、`SCOOP`、`APPDATA`、`LOCALAPPDATA`、`USERPROFILE` 的值计算哈希作为缓存键；同键在本进程内只跑一次，失败则删除缓存以便下次重试。环境写入 `<state>/requests/<random>.json`（`flag: 'wx'`），调用 `['read-refresh', '--env', file]`。
- [ ] 在 `accountPrepare` 中 `ensureGrant` 之后、`brokerPipe` 之前调用，使用与请求相同的 `toolEnvironment()` 合并结果。refresh 失败**不阻断**命令执行（记录日志即可），因为工作区读写不依赖它。
- [ ] `refreshAccountBackend()` 与 `configureAccountBackend()` 同时清空 refresh 缓存。
- [ ] 测试：同环境只调用一次；`PATH` 改变后再次调用；失败后可重试；refresh 失败不影响 `prepare` 返回计划。

### Task 6：设置页简化

**Files:**

- Modify: `apps/desktop/sandbox-setup.ts`
- Modify: `apps/desktop/renderer-sandbox-setup.ts`
- Modify: `apps/desktop/index.html`（`#sandbox-setup-section`，约第 569 行起）
- Modify: `apps/desktop/main.ts`（如需新增「选择文件夹」IPC）
- Modify: `apps/desktop/i18n-panels.ts`
- Test: `tests/windows-sandbox-setup.test.ts`、`tests/sandbox-setup-renderer.test.ts`

- [ ] `SandboxSetupView` 增加 `readRoots?: { path: string; source: 'auto' | 'user' }[]`，由 `inspect` 从 status 填充。
- [ ] 命令集：`status`、`verify`、`initialize`、`uninstall`、`read-add`（无 `path`，主进程弹 `dialog.showOpenDialog({ properties: ['openDirectory'] })`，用户取消则原样返回 view）、`read-remove`（带 `path`，必须是当前 `readRoots` 中 `source === 'user'` 的一项，否则拒绝）。更新 `parseSandboxSetupCommand` 白名单与校验。
- [ ] 界面状态：
  - 不支持：整块隐藏（现有）。
  - `uninitialized`：一句说明 + 「初始化沙箱账户」按钮。
  - `damaged`：问题列表 + 「修复」按钮；进入该状态时自动发一次 `verify` 取诊断详情。
  - `ready`：一行「✓ 沙箱账户已就绪」+「卸载」文字按钮；其下 `<details>`（默认折叠）「高级：沙箱可读目录」：自动项只读列表并标「自动」，用户项每行「移除」，底部「添加目录…」。
  - 删除「检查状态」按钮、手输路径框、「授予/撤销只读访问」按钮与 `sandbox-read-note` 长说明。
- [ ] i18n：删除 `sandboxSetup.refresh`、`sandboxSetup.read.note`、`sandboxSetup.read.add`、`sandboxSetup.read.remove`；新增 `sandboxSetup.readyLine`、`sandboxSetup.read.advanced`、`sandboxSetup.read.auto`、`sandboxSetup.read.choose`、`sandboxSetup.read.removeItem`（中英双语，沿用 `[zh, en]` 结构）。确认无其他引用后再删键。
- [ ] 窄窗口布局沿用现有设置页样式类；不新增全局样式。
- [ ] 测试：各状态下可见元素与按钮启用状态；`read-remove` 拒绝 auto 项与列表外路径；`read-add` 取消对话框不发 helper 调用。

### Task 7：失败提示与 spec 修订

**Files:**

- Modify: `packages/tools/sandbox-launch-failure.ts`
- Modify: `docs/superpowers/specs/2026-10-21-windows-account-sandbox-design.md`

- [ ] `windows-account` 后端出现 EPERM / 拒绝访问时，提示追加「如需读取用户目录下的其他工具，可在 设置 → 通用设置 → Windows 沙箱账户 → 高级：沙箱可读目录 中添加」。
- [ ] 修订 spec §5.2：默认条目改为自动发现规则（列出 Task 1 来源）；授予方式分为「自动根：可继承 RX + 凭据定点拒绝」与「用户路径：快照」；写明放弃整树快照用于自动根的理由与残余风险（自动根下以后新建、且不在凭据清单中的敏感文件会继承可读）；refresh 时机为每个 Host 进程首次执行前、环境变化后。

### Task 8：验收

**Files:**

- Modify: `packages/tools/windows-sandbox/native/tests/account_acceptance.rs`

- [ ] 初始化后**不做任何手动授权**，沙箱离线账户可执行 PATH 中位于 profile 下的工具（CI 上至少 `cargo --version`；有 node 时 `node --version`）。
- [ ] 在已授权的自动根下新建一个可执行文件，不重新 refresh，沙箱账户能读取（验证可继承）。
- [ ] 在自动根下放一个 `.npmrc`/`credentials.toml` 后 refresh，沙箱账户读取该文件失败。
- [ ] 卸载后所有自动根与用户路径上的组 ACE 均被移除，`read-grants.json` / `traverse-grants.json` 为空或删除。
- [ ] 全量运行：`cargo test`（native 目录）、仓库 TS 测试（`npm test` 或项目约定命令）通过；`account-status --verify` 在就绪机器上 `ready: true`。

---

## 建议提交切分

1. Task 1–3（原生发现、可继承授权、refresh 命令、初始化接入）+ Task 8 中的原生验收。
2. Task 4–5（status 字段、TS 执行前 refresh）。
3. Task 6–7（设置页、失败提示、spec 修订）。
