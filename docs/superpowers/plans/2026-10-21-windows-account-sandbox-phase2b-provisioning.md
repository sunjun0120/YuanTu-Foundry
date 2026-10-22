# Windows 沙箱账户后端 第二期 2b：初始化、凭据、断网与 broker --account 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 创建/修复/卸载两个沙箱账户、本地组、DPAPI 凭据和按账户 SID 的 WFP 断网规则；broker 以真实账户启动 runner；在 GitHub Actions Windows runner（一次性、管理员）上做真实验收。

**Architecture:** crate 增加 `src/lib.rs`，把现有 `maintenance.rs`、`network.rs` 和公共 Win32 辅助移入库，供 `yuantu-appcontainer` 与 `yuantu-sandbox` 共用。新增库模块 `account/`（账户与组、登录权限、隐藏、seclogon、DPAPI 凭据、WFP 用户过滤、状态、卸载）。正式提权路径与现有一致：release 签名 + 受保护安装 + `ShellExecuteExW(runas)` 固定操作；debug 构建另有“已提权直通”路径仅供 CI 验收。

**Tech Stack:** Rust 2024、windows-sys 0.61（新增 NetManagement、Lsa、Registry、Services、Userenv 相关 feature）、GitHub Actions `windows-latest`。

**Spec:** `docs/superpowers/specs/2026-10-21-windows-account-sandbox-design.md`（§4、§5.1、§6.3、§7）

## Global Constraints

- 账户名固定：`YuanTuSandboxOffline`、`YuanTuSandboxOnline`；组 `YuanTuSandboxUsers`；组内只允许这两个账户。
- 不变量：除沙箱账户自己的 profile 外，不出现直接授予沙箱账户 SID 的 ACE。
- 正式提权只走 release 签名、受保护安装、固定操作；不接受路径、命令或 SID 参数。
- debug 直通：仅 `cfg(debug_assertions)`、进程已提权（`TokenIsElevated == 1`）、环境变量 `YUANTU_SANDBOX_DEV_PROVISION=1` 三者同时满足；不调用 `ShellExecuteExW`。
- 密码：32 字节系统随机数编码为可打印字符串；只在内存与交接管道中出现；DPAPI CurrentUser + 附加熵 `"YuanTu.SandboxAccount.v1:" + 账户 SID`。
- 凭据文件：`<当前用户 profile（SHGetKnownFolderPath FOLDERID_Profile）>\.yuantu\sandbox-state\windows-account\credentials.json`，受保护 DACL：当前用户 + SYSTEM，禁用继承。
- WFP：独立 provider/sublayer GUID（不与 AppContainer 的混用），条件 `FWPM_CONDITION_ALE_USER_ID` + 只允许离线账户 SID 的安全描述符，8 个 ALE 层（同现有 `LAYERS`）。
- 状态输出 JSON `version: 1`，未知字段拒绝。

## 推迟（记入后续）

私有桌面（`CreateDesktopW`）推迟到 2b 之后单独一项；2b 中 runner 继承调用者的窗口站/桌面（`CreateProcessWithLogonW` 会为该账户授予访问）。读白名单 ACE 由 2c 的 TS 侧负责（复用 ACL 日志机制）。

---

### Task 1: lib 拆分（行为不变）

**Files:** Create `src/lib.rs`；Modify `src/main.rs`、`src/maintenance.rs`、`src/network.rs`

- [ ] 把 `main.rs` 中 `Result`、`wide`、`win`、`Handle`、`Sid`、`profile_name`、`sid_text` 移到 `lib.rs`（`pub`），`pub mod maintenance; pub mod network;`；`main.rs` 改为 `use yuantu_appcontainer::*`。
- [ ] `cargo test --locked` 全部通过（现有 12 + 16 + 8）。
- [ ] 提交 `refactor(windows-sandbox): 抽出共享库，行为不变`。

### Task 2: 账户、凭据、WFP 用户过滤（不改系统的部分先测）

**Files:** Create `src/account/mod.rs`、`names.rs`、`password.rs`、`credentials.rs`、`users.rs`、`firewall.rs`、`status.rs`

接口：

```rust
pub const OFFLINE: &str = "YuanTuSandboxOffline";
pub const ONLINE: &str = "YuanTuSandboxOnline";
pub const GROUP: &str = "YuanTuSandboxUsers";
#[derive(Clone, Copy, Serialize, Deserialize, PartialEq, Debug)] #[serde(rename_all = "kebab-case")]
pub enum Account { Offline, Online }
impl Account { pub fn name(self) -> &'static str; pub const ALL: [Account; 2]; }
pub struct Secret(String);               // Drop 时清零
pub fn generate_password() -> Result<Secret>;
pub fn protect(secret: &Secret, sid: &str) -> Result<Vec<u8>>;   // DPAPI
pub fn unprotect(blob: &[u8], sid: &str) -> Result<Secret>;
#[derive(Serialize, Deserialize)] #[serde(deny_unknown_fields)]
pub struct CredentialFile { pub version: u32, pub accounts: Vec<StoredAccount> }
#[derive(Serialize, Deserialize)] #[serde(deny_unknown_fields)]
pub struct StoredAccount { pub account: Account, pub sid: String, pub blob: String /* base64 */ }
pub fn credentials_path() -> Result<PathBuf>;
pub fn store(accounts: &[(Account, String, Secret)]) -> Result<()>;
pub fn load(account: Account) -> Result<(String, Secret)>;
// users.rs（需管理员）
pub fn provision(passwords: &[(Account, Secret)]) -> Result<Vec<(Account, String)>>; // 返回 SID
pub fn remove() -> Result<()>;
pub fn lookup_sid(name: &str) -> Result<Option<String>>;
// firewall.rs
pub fn install_offline_filter(offline_sid: &str) -> Result<()>;  // 需管理员，事务，幂等（先删同 key）
pub fn remove_filters() -> Result<()>;
pub fn filter_status(offline_sid: &str) -> Result<bool>;
// status.rs
#[derive(Serialize)] pub struct Status { version: u32, ready: bool, development: bool, problems: Vec<String>, accounts: Vec<AccountStatus> }
pub fn status() -> Status;
```

- [ ] 单测：`generate_password` 长度/字符集、两次不同；`protect`/`unprotect` 往返，错误 SID 熵解不开；`CredentialFile` 未知字段拒绝；`firewall` 的用户条件安全描述符 SDDL 为 `O:SYD:(A;;CC;;;<sid>)`；filter key 不与 AppContainer 的 key 重叠；`status()` 在无账户机器上 `ready == false` 且 `problems` 含 `accounts-missing`（不改系统）。
- [ ] 实现：`users.rs` 用 `NetUserAdd`（`UF_DONT_EXPIRE_PASSWD | UF_PASSWD_CANT_CHANGE | UF_SCRIPT`）/ 已存在则 `NetUserSetInfo(1003)` 仅重设密码；`NetLocalGroupAdd` + `NetLocalGroupAddMembers`；组内多余成员视为错误（拒绝继续）；`LsaAddAccountRights` 加 `SeDenyNetworkLogonRight`、`SeDenyRemoteInteractiveLogonRight`；`HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon\SpecialAccounts\UserList\<name> = 0`；seclogon 若 `SERVICE_DISABLED` 则改为 `SERVICE_DEMAND_START`。`remove` 逆序撤销，并 `DeleteProfileW` 删除两个账户的 profile。
- [ ] `cargo test --locked` 通过；提交 `feat(windows-sandbox): 沙箱账户、DPAPI 凭据与按用户 WFP 过滤`。

### Task 3: 子命令与 broker --account

**Files:** Modify `src/bin/yuantu-sandbox/main.rs`、`broker.rs`；Create `src/bin/yuantu-sandbox/provision.rs`

- [ ] `account-status`：打印 `status()` JSON，退出 0。
- [ ] `account-initialize --handoff <pipe>`（release）/ `account-initialize --dev-direct`（debug 直通）：校验已提权；handoff 模式从管道读 `{version, passwords}`，执行 `provision` + `install_offline_filter`，向管道回写 `{version, sids}`；直通模式在进程内生成密码、执行、`store`。
- [ ] `account-setup`（release）：`maintenance::preflight` → 生成密码 → 交接管道（`D:P(A;;GA;;;<当前用户>)(A;;GA;;;BA)`，FIRST_PIPE_INSTANCE）→ `ShellExecuteExW(runas, "account-initialize --handoff <pipe>")` → 发送密码、读回 SID → `store` → `status()` 必须 ready。
- [ ] `account-uninstall`（release 走 UAC 固定操作 `account-remove`；debug 直通 `account-remove --dev-direct`）：`remove_filters` + `remove`，删除凭据文件。
- [ ] `broker --account offline|online`：`load` 凭据 → `CreateProcessWithLogonW(LOGON_WITH_PROFILE, CREATE_SUSPENDED | CREATE_NO_WINDOW)` 启动 runner → `AssignProcessToJobObject` → Resume → 立即清零密码；runner 控制管道 DACL 用该账户 SID。
- [ ] 单测：参数解析（未知参数拒绝；release 下 `--dev-direct` 被拒）；交接消息 `deny_unknown_fields`。
- [ ] 提交 `feat(windows-sandbox): 账户初始化/卸载/状态子命令与 broker --account`。

### Task 4: CI 真实验收

**Files:** Create `tests/account_acceptance.rs`；Modify `.github/workflows/ci.yml`

只在 `YUANTU_SANDBOX_ACCOUNT_ACCEPTANCE=1` 时运行（否则打印跳过原因）。测试按顺序执行（单个 `#[test]` 内分步骤）：

1. `account-initialize --dev-direct`（带 `YUANTU_SANDBOX_DEV_PROVISION=1`）→ `account-status` ready。
2. 建工作区 A、B（`CARGO_TARGET_TMPDIR` 下），`icacls` 授予 `*<组 SID>:(OI)(CI)M` 与各自能力 SID `(OI)(CI)M`。
3. `broker --account offline` + exec（能力 = A）：写 A 成功；写 B 失败；写桌面用户 profile 下文件失败；读桌面用户 profile 下文件失败。
4. 同一 broker 并发跑 A、B 两条命令，各自只能写自己的工作区。
5. fork：`node fork.cjs`、`node --test` 通过。
6. 网络：离线账户 `node` 连接 `1.1.1.1:443`、`[2606:4700:4700::1111]:443`、本机回环监听均失败；联网账户连接 `1.1.1.1:443` 成功。
7. `account-remove --dev-direct` → 账户、组、WFP 过滤器、凭据文件都不存在；`account-status` 报 `accounts-missing`。

- [ ] CI：在 Windows job 的 helper 步骤后加一步 `cargo test --locked --manifest-path ... --test account_acceptance`，环境变量 `YUANTU_SANDBOX_ACCOUNT_ACCEPTANCE=1`、`YUANTU_SANDBOX_DEV_PROVISION=1`。
- [ ] 本地运行时该测试跳过（未设变量）；提交 `test(windows-sandbox): 账户后端 CI 真实验收`。
- [ ] 推送后由用户确认 CI 结果（推送需用户同意）。
