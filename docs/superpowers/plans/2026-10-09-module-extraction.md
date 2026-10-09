# Agent 与 SessionStore 渐进拆分计划

> **For agentic workers:** Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 先验收已有模块拆分，再继续缩小 `packages/core/agent.ts`、`packages/storage/sqlite.ts`，保持本轮开始时的行为与公开 API。

**Architecture:** 保留 Agent、SessionStore 作为公开入口；按职责搬移实现，通过类型明确的内部端口借用原有事务、连接和动态状态。运行循环与事件日志仍由原入口负责。

**Tech Stack:** Node 24、TypeScript、SQLite、现有 fixture 回归与桌面/Web smoke。

**Spec:** 用户本轮请求：先检查已有拆分，无问题后逐步拆分上述两个文件，行为与公开 API 不变。

## Global Constraints

- 在当前 checkout 继续用户的未提交拆分，保留其他来源改动，不自动提交或发布。
- 以本轮开始的工作区为行为/API 基线；HEAD 还缺少既有功能修复，不能直接回退到 HEAD。
- 每步先运行已有行为回归，搬移后复验；纯搬移不新增重复实现的测试。
- SQL、提示文本、回调时序、异常与返回类型不变；接口兼容通过 TypeScript checker 快照比对。
- 动态执行权限与环境按原时点读取；事务使用原 SessionStore 包装器。

## Review Focus

- 回调读取最新权限/环境/规划状态，不能在工厂构建时冻结。
- 子 Agent 的取消桥、队列满错误、资源归属与父会话日志保持一致。
- 旧数据库拒绝、迁移前备份、版本门槛与事务顺序保持一致。
- 文件恢复的归属校验、原子日志写入和旧格式读取保持一致。
- 搜索分页/子会话可见性、投影 checkpoint 拒绝/回退和计数保持一致。

## Tasks

### Task 1: 已有拆分验收

**Files:** 只读检查已有 Host/renderer、`packages/core/run-*.ts`、`packages/storage/session-*.ts`。
**Interfaces:** 消费当前工作区与 HEAD；产出本轮 API、源文件快照及审查记录。

- [x] 运行 `npm.cmd run check:full`，确认 0 fail、构建与 client/Web smoke 通过。
- [x] 独立源代码审查，核对状态共享、闭包、事务与清理；实质问题先修复并复验。

### Task 2: Agent 提示与通知

**Files:** 修改 `packages/core/agent.ts`，使用已有 `agent-notices.ts`，新增 `run-prompt.ts`。
**Interfaces:** `createRunPromptSections(options: RunPromptOptions): PromptSection[]`；通过 `planNotice(): string` 保持动态读取。

- [x] 搬移前跑 `prompt-sections`、`runtime-context`、`plan-mode`、`execution-environment`、`goal` 回归。
- [x] 复用已存在且文本一致的通知函数，搬移提示分节；不改变公共 AgentOptions/run 签名。
- [x] 类型检查与同组回归通过后，核对搬移函数和 API 快照。

### Task 3: 子 Agent 回合构建

**Files:** 修改 `packages/core/agent.ts`，新增 `run-child-turns.ts`。
**Interfaces:** `createChildTurns(options: ChildTurnOptions): ChildTurns`；以工厂 `createAgent(options: AgentOptions): Pick<Agent, 'run' | 'enqueue'>` 避免运行时循环导入。

- [x] 搬移前跑 `subagents`、`subagents-seams`（含 residency）、`subagents-fork`、`subagent-inbox` 回归。
- [x] 搬移 childTurns 闭包；保留每次 turn 创建 Agent、计数重置、取消桥和资源归属。
- [x] 类型检查与同组回归通过；核对 AST 与 API 快照。

### Task 4: 数据库初始化与迁移

**Files:** 修改 `packages/storage/sqlite.ts`，新增 `session-migrations.ts`。
**Interfaces:** `SessionMigrations` 借用原 db 与 `transaction<T>(fn: () => T): T`；原 `migrationSteps()` 返回不变。

- [x] 搬移前跑 `schema-migrations`、`storage-rules`、`daily-backups`、`database-maintenance` 回归。
- [x] 原样搬移初始化、身份检查与迁移列表及各迁移；连接与维护锁继续由 SessionStore 拥有。
- [x] 类型检查与同组回归通过；核对方法 AST 与 API 快照。

### Task 5: 文件变更日志与会话检索

**Files:** 修改 `packages/storage/sqlite.ts`，新增 `session-file-changes.ts`、`session-search.ts`。
**Interfaces:** `SessionFileChanges` 借用 db/transaction/get/append；`SessionSearch` 借用 db/flush；原公共方法保留完整签名与返回类型。

- [x] 搬移前跑 `storage`、`storage-audit-repairs`、`session-query`、`session-title`、`files`（含原子 undo）回归。
- [x] 先搬移文件快照方法并复验，再搬移 list/searchSessions/sessionHit 并复验。
- [x] 类型检查与同组回归通过；核对方法 AST 与 API 快照。

### Task 6: 投影 checkpoint 与最终验收

**Files:** 修改 `packages/storage/sqlite.ts`，新增 `session-checkpoints.ts`，更新本记录。
**Interfaces:** `SessionCheckpoints` 借用 db/projections/transaction/checkedLog/events；内部持有 foldCounters；公共方法签名不变。

- [x] 搬移前跑 `projection-checkpoint`、`session-projections`、`session-log`、`storage-audit-repairs` 回归。
- [x] 搬移折叠/持久化/计数，保留 checkedLog、事务和 checkpoint 信任校验调用。
- [x] 同组回归、API 快照与 AST 比较通过后，运行完整关卡和 `npm.cmd run smoke:desktop`（并行任务曾阻断组合命令，关卡分别执行）。
- [x] 对本轮改动做独立审查，记录证据和验证边界；不提交。

## Execution Record

- 初次沙箱运行通过格式/文档/引用/i18n/类型检查；ACP 子进程 realpath 报 EPERM，仓库内 TEMP 同样复现。完整基线改用正常本机环境重新验证。
- 已保存本轮开始的 Agent/SessionStore 源文件与 TypeScript checker 公开 API 快照，暂存于 `.scratch/refactor-2026-10-09/`。
- Task 1 完成：正常本机 `check:full` 返回 0；单元测试 1647 pass / 8 skip / 0 fail，构建通过，client/SDK smoke 4/4，Web smoke 9/9。独立审查未发现现有调用路径上的实质拆分回归。
- Task 2 完成：`node scripts/run-tests.mjs --concurrency=2 tests/prompt-sections.test.ts tests/runtime-context.test.ts tests/plan-mode.test.ts tests/execution-environment.test.ts tests/goal.test.ts`，59/59；类型检查通过；提示数组 AST 和通知/系统文本一致；公开类型快照一致（忽略 compiler 实例生成的 well-known symbol 内部编号）。
- Task 3 完成：`node scripts/run-tests.mjs --concurrency=2 tests/subagents.test.ts tests/subagents-seams.test.ts tests/subagents-fork.test.ts tests/subagent-inbox.test.ts`，76/76；类型检查通过；childTurns AST 在参数/工厂替换后一致；公开 API 快照一致。
- Task 4 完成：schema-migrations/storage-rules/daily-backups/database-maintenance 38/38；16 个搬移方法 AST 在端口替换后保持一致。旧故障注入测试曾失败，原因是注入 SessionStore 私有方法不再命中新归属；仅调整到 SessionMigrations 同名私有方法，恢复断言不变。
- Task 5 完成：storage/storage-audit-repairs/files 36/36；session-query/session-title/session 35/35；7 个文件方法与 3 个检索方法 AST 在端口替换后一致；公开 API 快照一致。
- Task 6 局部验收：projection-checkpoint/session-projections/session-log/storage-audit-repairs 51/51；8 个搬移方法 AST 一致。并发测试原先覆盖旧私有折叠函数，提取后注入没有发生；改用公开 projections.register 在同一窗口提交第二连接事件，保留原断言并断言注入实际发生。
- 当前文件行数：agent.ts 3428 → 2925；sqlite.ts 3227 → 2015（相对本轮开始的工作区）。
- 最终 check:full 的格式关卡被其他任务新增的程序运行器文件阻断；用户确认另一个任务正在同时修改工作区。保留这些文件，改为执行本轮范围的格式检查，分别执行其余全量关卡与 smoke；记录实际结果，不把并行任务的改动归入本轮。
- 最终独立审查通过：相对保存基线没有 Critical / Important / Minor；34 个存储方法、子回合闭包、提示数组、通知/系统文本和公开 API 一致，测试适配保留原故障/竞态覆盖。审查明确排除其他任务的程序运行器/安全工具新增行为及相对 HEAD 已存在的功能修复。
- 最终范围内格式、全量文档/引用/i18n、产品构建通过；client/SDK smoke 4/4、Web smoke 9/9。全仓库类型检查被并行任务 `tests/program-handshake.test.ts:60` 的 TS2352 阻断（ChildProcess 类型断言）；不修改该任务文件。
- 后续刷新：并行任务修复 TS2352 后，全仓库 TypeScript diagnostics 为 0，`npm.cmd run typecheck` 通过；格式检查只剩其 `tests/program-handshake.test.ts`。Electron 桌面七组 smoke 完整通过，48/48（325.89s）。
- 最终验收完成：并行任务修复格式后，全仓库 `format:check` 通过；其余关卡分别执行通过。169 个文件的完整回归（`node scripts/run-tests.mjs --concurrency=2`）1672 pass / 8 skip / 0 fail，501.62s；源码/API 比对再次通过；无提交。
- 最终完整测试日志：`.scratch/test-logs/1791508820097-31552-78b3620f-d0ec-4343-9b08-a49709b6668b.log`；桌面日志：`.scratch/test-logs/1791508839694-4212-cfc7f267-ef83-4de1-ad20-c2916fa79206.log`。临时提取脚本、基线工作副本与摘要日志在交付前清理，以上原始测试日志保留。
