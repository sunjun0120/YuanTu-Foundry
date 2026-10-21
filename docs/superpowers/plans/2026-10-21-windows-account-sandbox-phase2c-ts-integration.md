# Windows 沙箱账户后端 第二期 2c：TS 接入 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 Agent 的命令真正通过 `windows-account` 后端运行：新模式、provider、broker 进程管理、工作区授权、`native` 在就绪时自动选它，并在 CI 上用真实账户从 TS 侧端到端验证。

**Architecture:** TS provider 的 `prepare` 确保工作区已授权（原生 `grant` 子命令，常驻授权，记录在 `grants.json`）、确保对应账户的 broker 已启动（每个 Host 进程每个账户一个，按需启动，退出码 3 后下次重启），把请求写进 Host 私有目录，返回 `SandboxPlan{executable: yuantu-sandbox.exe, args: ['exec', …]}`。scratch 与用户目录环境变量由 runner 处理。

**Tech Stack:** TypeScript（node:test）、Rust（yuantu-sandbox）。

**Spec:** `docs/superpowers/specs/2026-10-21-windows-account-sandbox-design.md`

## 与设计文档的差异（本计划同时修订 spec）

- §5.1 工作区写授权改为 **Codex 式常驻授权**：首次使用时授予 `YuanTuSandboxUsers`（Modify，OICI）与该工作区能力 SID（Modify，OICI），保留到卸载或显式撤销；不再逐命令/逐会话做日志化恢复。理由：只有持有该工作区能力 SID 的受限令牌（仅 runner 会造）才能通过第二次访问检查；同时避免与旧后端共享 `acl.ps1` 的租约与日志。保留路径（`.git`、`.yuantu`、`.agents`、`.codex`、`.aws`、`.ssh`、`.gnupg`）中已存在者，对组加拒绝写入 ACE。
- scratch 由 runner 在沙箱账户自己的 `%TEMP%` 下按命令创建并删除；请求中的 `TEMP`/`TMP` 与 `USERPROFILE`/`APPDATA`/`LOCALAPPDATA`/`HOMEDRIVE`/`HOMEPATH` 由 runner 换成自身环境的值。
- 网络：`config.network === 'denied'` → 离线账户；否则 → 联网账户。

## Global Constraints

- 不修改 `packages/tools/sandbox-windows.ts` 与 `windows-sandbox/acl.ps1`（另一会话在改）；只读引用其导出。
- `native` 解析保持同步：读取进程内缓存的就绪状态；缓存由 Host 启动时与初始化/卸载后异步刷新；未就绪 → `windows`。
- 显式 `windows-account` 未就绪 → `prepare` 抛错，不回退。
- 能力 SID：`S-1-5-21-<4 个随机 u32>`，按规范化（小写、`realpath`）工作区路径持久化在 `<profile>/.yuantu/sandbox-state/windows-account/cap-sids.json`。
- 请求文件放在 `<state>/requests/`（只有桌面用户能读写），exec 读后即删；`cleanup` 删除残留。

---

### Task 1：原生 grant/ungrant 与 runner 环境、scratch

**Files:** Create `src/account/grants.rs`；Modify `src/account/mod.rs`、`src/account/status.rs`（输出组 SID）、`src/bin/yuantu-sandbox/main.rs`、`runner.rs`、`spawn.rs`

- [ ] 库函数 `grant(root, group_sid, capability_sid)`、`ungrant(root, group_sid, capability_sid)`：拒绝 reparse point 根与卷根；用 `SetEntriesInAclW` + `SetNamedSecurityInfoW` 合并 ACE（自动继承传播）；保留路径存在时加组拒绝写 ACE；`grants.json` 记录 `{root, capability}`，`ungrant_all()` 供卸载调用。
- [ ] 子命令 `grant --root R --capability S` / `ungrant --root R`（桌面用户身份，不提权；组 SID 由 `lookup_sid(GROUP)` 得到，组不存在则拒绝）。`account-remove` 先 `ungrant_all`。
- [ ] runner：每命令在自身 `%TEMP%` 下建 `yuantu-<id>` 目录，覆盖请求环境中的 TEMP/TMP 与用户目录变量为 runner 自身值，命令结束删除。
- [ ] 测试：`grant` 对临时目录 + 任意 SID 生效（读回 DACL 含两条 OICI Modify ACE、`.git` 有拒绝 ACE），`ungrant` 后不含；reparse 根被拒；env 覆盖的纯函数单测；账户验收里改用 `grant` 子命令代替 icacls/PowerShell。
- [ ] 提交。

### Task 2：模式与 provider

**Files:** Modify `packages/protocol/execution.ts`、`packages/tools/sandbox-mode.ts`、`packages/tools/execution-capabilities.ts`、`packages/tools/sandbox.ts`；Create `packages/tools/sandbox-account.ts`、`packages/tools/sandbox-account-broker.ts`；Test `tests/sandbox-account.test.ts`

- [ ] `ExecutionMode` 加 `'windows-account'`；`SANDBOX_MODES` 与 `parseSandboxMode` 错误文案同步；`nativeSandboxBackend()` 在 win32 上读 `accountBackendReady()` 缓存。
- [ ] `WINDOWS_ACCOUNT_CAPABILITIES`：`processFiles: config.files ?? 'workspace-write'`，`network: config.network ?? 'unrestricted'`（两种都能真正执行），`pathKind: 'local'`，`links: 'refused'`。
- [ ] `sandbox-account.ts`：`accountStatus()`（运行 `account-status`，解析并校验 JSON）、`refreshAccountReadiness()`、`accountBackendReady()`；`capabilityFor(root)`（持久化）；`ensureGrant(root)`（进程内缓存 + `grant` 子命令）；`accountCommand(request)` 生成 `{argv, verbatim}`（命令字符串 → ComSpec `/d /s /c "…"`；argv 且无需 shell 且程序为绝对路径 → 原样；否则走 shell）；provider `prepare`/`cleanup`/`available`。
- [ ] `sandbox-account-broker.ts`：`brokerPipe(account)`：首次 spawn `broker --account X`，读首行 JSON，stdin 保持打开；子进程退出即从缓存删除，下次重启；并发调用共享同一启动 promise；Host 退出时 stdin 自然关闭。
- [ ] 单测（注入执行器，不需真实账户）：状态解析与校验、能力 SID 稳定且按路径区分、命令构造三种形态、显式模式未就绪拒绝、`native` 就绪/未就绪选择、broker 并发只启动一次且退出后重启、请求文件内容与清理。
- [ ] `npm run typecheck`、相关测试、`test:isolation:check` 通过；提交。

### Task 3：打包与 CI 端到端

**Files:** Modify `scripts/build-windows-sandbox.mjs`、`scripts/copy-sandbox-assets.mjs`、`scripts/check-windows-package.mjs`、`.github/workflows/windows-account-sandbox.yml`；Create `tests/sandbox-account-native.test.ts`

- [ ] 构建脚本同时复制 `yuantu-sandbox.exe`；dist 资产与打包检查包含它（签名清单约束留给受保护发布流程，见 2d）。
- [ ] `tests/sandbox-account-native.test.ts`（仅 `YUANTU_SANDBOX_ACCOUNT_ACCEPTANCE=1`）：用 debug 构建的 exe 执行 `account-initialize --dev-direct`，`refreshAccountReadiness()`，通过 provider 跑：两个工作区并发写各自目录且互相写不进去、`node --test` fork、`network: 'denied'` 下连接失败；最后 `account-remove --dev-direct`。
- [ ] workflow 增加 `npm ci` 与该测试；推送分支验证。
- [ ] 提交。
