# YuanTu-Foundry 代码审计报告

| 项       | 内容                                                                                                 |
| -------- | ---------------------------------------------------------------------------------------------------- |
| 报告日期 | 2026-10-23                                                                                           |
| 审计基线 | `windows-sandbox-hardening @ 970d50b`（审计开始时工作树干净）                                        |
| 审计范围 | `apps/desktop`、`apps/agent-host`、`apps/shared`、`packages/*`、关键 `scripts/`、`tests/` 与构建配置 |
| 审计方式 | 静态代码阅读、类型/分层/隔离检查、benchmark、定向测试、本机测量                                      |
| 结论     | 架构成立；5 个 P0、4 个 P1、12 个 P2；主要风险在不可信输入、文件边界、每轮装配成本和恢复能力         |
| 文档状态 | 基于固定提交 `970d50b` 的审计记录；行号以该提交为准，后续改动可能漂移                                |

> 审计期间工作区出现了未提交的并行修改，主要是 `packages/tools/sandbox-account.ts`、Windows sandbox native 代码及对应文档/测试。本报告以审计开始时的 `970d50b` 为基线，这些改动不纳入结论。
>
> 同内容 Word 版：`artifacts/audit/YuanTu-Foundry-code-audit-2026-10-23.docx`（本地生成物，`artifacts/` 未纳入版本控制）。

---

## 执行摘要

YuanTu-Foundry 把桌面外壳、渲染器和 Agent Host 分成三个进程边界；Host 内以 Agent run loop 为核心，工具、审批、沙箱、会话存储和恢复各自有明确模块。这个结构是项目最大的资产：它让失败可以被隔离、让会话可以从日志重放，也让桌面端不必直接持有模型密钥或命令执行能力。

本次审查没有发现 Agent 主循环层面的灾难性逻辑错误。真正需要优先处理的是边界质量：一段畸形 HTML 可以让 Host 主线程停顿十余秒，一个巨大的 `AGENTS.md` 可以在预算生效前被完整读入内存，会话数据库和 runtime 文件没有把本地权限/符号链接边界收干净。

| 指标                  | 结果       | 说明                                 |
| --------------------- | ---------- | ------------------------------------ |
| 每个 run 重建工具目录 | 50–116 ms  | 63 个工具 + Ajv 编译；本机测量       |
| 1 MB 畸形 HTML 解析   | 15.98 s    | 未闭合 `<script>`；Host 主线程       |
| 10k 消息存储放大      | 约 3×      | messages 行约 4.4 MB，整库约 13.1 MB |
| P0 / P1 / P2 问题数   | 5 / 4 / 12 | 详见第 3–6 节                        |

### 关键结论

- **架构不是主要问题。** 分层、进程隔离、工具 pipeline、审批与恢复设计完整；import cycles 为 0，18 个 package 分布在 11 层。
- **最高风险在不可信输入。** HTML 正则解析、Office 解析、超大 instructions 文件都属于“用户/仓库可控输入进入 Host 主线程”的路径。
- **最明确的性能成本是每轮装配。** 每次 run 都新建 63 个工具并重新编译 Ajv schema，本机实测 50–116 ms；限流器也是 run 级而不是 Host 级。
- **两个能力缺口会直接影响使用。** 运行中的审批/提问无法在重连后恢复；普通 run 没有总 token/时间/轮次预算。
- **发布边界需要单独决策。** Linux CLI 默认 native 不可用、macOS 关窗即退出、Playwright 可能不在桌面发布包、Windows 安装包未签名。

### 建议的第一批动作

如果只能先做四件事，建议是：把 HTML 解析移出回溯正则、给 instructions 读取加前置大小上限、显式收紧 session DB/runtime 目录权限、拦截 Windows 保留设备名。四项都是小范围改动，但收益和安全影响最大。

排期建议：P0 立即处理，P1 本周内处理，P2 按“性能/能力/工程债”分批安排。每节都给出代码位置，附录 A 提供完整问题索引。

---

## 1. 审查范围与方法

### 1.1 审查范围

审查覆盖当前工作树中的桌面端、Agent Host、共享运行时、核心包和关键构建/测试配置。重点路径包括：

`apps/desktop/`、`apps/agent-host/`、`apps/shared/`、`packages/core/`、`packages/tools/`、`packages/storage/`、`packages/client/`、`packages/carrier/`、`packages/workspaces/`、`packages/search/`、`packages/lsp/`、`packages/mcp/`、`packages/office/`、`packages/providers/`、`packages/platform/`，以及 `package.json`、`electron-builder.config.cjs`、关键 `scripts/` 与 `tests/`。

### 1.2 审查方法

- **静态阅读**：沿进程边界、run loop、工具 pipeline、存储事务、恢复路径和渲染路径阅读实现。
- **结构检查**：运行 typecheck、import cycles、layer、test isolation、format、i18n、audit 和 benchmark 门禁。
- **定向测量**：对工具目录构建、畸形 HTML 解析、`lastSeq`、`createTools` 等热路径做本机测量。
- **定向测试**：在 `YUANTU_SANDBOX=host` 下复跑 client 与 host-workflows 测试。
- **不依赖文档**：不以 README/docs 的描述作为正确性证据，结论只引用代码、测试和构建配置。

### 1.3 问题分级

| 级别 | 定义                                                         | 处理窗口          |
| ---- | ------------------------------------------------------------ | ----------------- |
| P0   | 安全边界、数据泄露、Host 稳定性或可直接冻结/击穿进程的问题。 | 立即，建议 0–2 天 |
| P1   | 明确的性能硬成本、成本失控风险或关键交互能力缺失。           | 近期，建议 3–5 天 |
| P2   | 中长期性能、架构债、平台/发布缺口或工程治理问题。            | 1–2 周或持续      |

### 1.4 不包含的内容

- 不评价具体模型能力、回答质量或提示词效果；没有做在线模型评测。
- 没有做完整生产数据量压测；性能数字来自当前工作树和本机样本。
- 没有替代 Windows/macOS 沙箱验收、安装包签名验证或渗透测试。
- 没有修改任何产品代码；本报告是只读审查结果。

---

## 2. 架构评估

### 2.1 进程与模块边界

项目采用“桌面外壳 + 独立 Agent Host”的结构。Electron main 负责窗口、设置、备份和 IPC；`CarrierService` 把 Host 的协议状态映射成界面快照；`AgentHostClient` 通过 JSONL 与 Host 子进程通信；Host 内部由 Agent run loop、`ToolRegistry`、`SessionStore`、子 Agent 协调器和资源池组成。

```text
Electron main
  └─ CarrierService → AgentHostClient ── JSONL ── Agent Host child
       ├─ Agent / run loop
       ├─ ToolRegistry → files / command / sandbox / search / LSP / MCP / office
       ├─ SessionStore（SQLite WAL + 事件日志 + projections + checkpoints）
       └─ SubAgent（默认同进程，可选子进程 provider）

Renderer：sandbox + contextIsolation + CSP + preload bridge
```

### 2.2 架构优点

- **进程隔离清楚。** Renderer 不持有 Node 能力；Host 是独立子进程；Host 崩溃可以重启，桌面不必跟着崩。
- **安全基线扎实。** `sandbox: true`、`contextIsolation`、严格 CSP、禁止导航/新窗口、Host 只监听 loopback 且带 token 和 `timingSafeEqual`。
- **事件日志是事实源。** 消息、审批、问题、run 生命周期和任务状态都能从 durable log 折叠出来；崩溃恢复不依赖进程内状态。
- **工具治理完整。** validate → pre-execute → guards → prepare → approval → execute → post-execute → finalize → result 的 pipeline 把“策略只能拒绝、不能授权”写成了结构。
- **工程门禁完整。** typecheck、import cycles、layers、test isolation、format、i18n、audit、benchmark 都有独立入口。

### 2.3 结构性约束

以下不是单点 bug，但会限制性能、隔离和演进速度；后文对应问题会展开。

- **Host 单进程 + 同步 SQLite。** `SessionStore` 使用 `node:sqlite` 的同步 API；任何慢查询、慢解析都会阻塞该 Host 的所有会话和流式输出。见 PERF-04。
- **每轮重建 Agent/ToolRegistry。** 每次 run 都重新构造 63 个工具和 Ajv validator，是当前最明确的固定开销。见 PERF-01。
- **子 Agent 默认同进程。** 内置 provider 让子 Agent 在 Host 内运行；一个子 Agent 的同步 CPU 工作会影响父会话。项目已有可选子进程 provider，但不是默认。见 CAP-04/PERF-04。
- **多份状态并存。** 事件日志、messages 写穿表、FTS、projection checkpoint 同时存在，带来约 3 倍存储放大和更高的迁移复杂度。见 ENG-03。

### 2.4 依赖与分层检查

| 检查项               | 结果 | 说明                                                   |
| -------------------- | ---- | ------------------------------------------------------ |
| TypeScript typecheck | 通过 | strict + noUncheckedIndexedAccess + erasableSyntaxOnly |
| Import cycles        | 通过 | 459 个文件、1137 条 value edge、0 cycles               |
| Layer boundaries     | 通过 | 18 个 package、11 层、701 条有序 import                |
| Test isolation       | 通过 | 0 violations                                           |
| Format / i18n        | 通过 | Prettier 与 i18n 检查均通过                            |
| Benchmark gate       | 通过 | 15 条规则                                              |

这些结果说明“代码组织是可控的”。问题不在于模块乱，而在于少数热路径/输入边界没有被放到正确的隔离层。

---

## 3. 高优先级缺陷（P0）

P0 的共同特征是：不需要复杂的用户交互就能触发，且影响的是 Host 稳定性、数据边界或本地数据保密性。建议优先修复。

### SEC-01｜HTML 解析的二次复杂度可以冻结整个 Host

**P0 · 安全与可用性**

**位置**：[web.ts](../packages/tools/web.ts#L63-L85)；入口在 [web.ts](../packages/tools/web.ts#L456-L460)。

**事实**：`htmlToText()` 用正则删除 `<script>`、`<style>`、`<a>` 等块。对未闭合的开始标签，惰性匹配会反复扫描到文本末尾。本机实测未闭合 `<script>`：

| 输入   | 耗时     |
| ------ | -------- |
| 100 KB | 171.7 ms |
| 500 KB | 4.14 s   |
| 1 MB   | 15.98 s  |

`web_fetch` 的 body 上限是 2 MB（[web.ts](../packages/tools/web.ts#L6)）。

**影响**：解析运行在 Host 事件循环里。一次恶意页面可以让所有会话的流式输出、审批和工具调用一起停顿；这属于远程内容触发的拒绝服务，不需要 Host 崩溃就能达到效果。

**建议**：改用线性扫描或成熟的有界 HTML parser；至少把 `script/style/...` 的剥离改成索引式扫描，限制标签数量，并在独立 worker 中解析不可信 HTML。补一个“2 MB 未闭合标签”回归测试，要求 Host 在数百毫秒内仍能响应。

### SEC-02｜instructions 在预算生效前被完整读入内存

**P0 · 稳定性与仓库安全**

**位置**：[instructions.ts](../packages/tools/instructions.ts#L126-L138)；`prefixBytes()` 在 [instructions.ts](../packages/tools/instructions.ts#L79)。

**事实**：代码先 `lstat`，随后直接 `readFileSync(absolute)`，再在 `prefixBytes()` 中按 32 KB / 64 KB 预算截断。一个仓库里的巨大 `AGENTS.md` / `CLAUDE.md` 会在每个 run、以及每次 scoped instruction 读取时被完整读入内存；预算只决定“输出多少”，不决定“读多少”。

**影响**：仓库内容可以来自克隆、下载或他人提交。一个几 GB 的 instructions 文件可能在预算执行前就触发 OOM，或让每次 `read_file` 都付出巨大 I/O。

**建议**：在 `readFileSync` 之前检查 `stat.size`；超过 `INSTRUCTION_FILE_BYTES` 时只读取预算大小的前缀，并标记 `truncated`/`dropped`。按 `(size, mtime)` 做缓存，避免每次 run 重复读。

### SEC-03｜会话数据库权限与静态加密缺失

**P0 · 数据保密**

**位置**：[sqlite.ts](../packages/storage/sqlite.ts#L175-L181)；[runtime-directory.ts](../packages/platform/runtime-directory.ts#L34-L39)。

**事实**：`SessionStore` 只对 `.yuantu` 目录调用 `ensureRuntimeDirectory(dirname)`，未传 mode；SQLite 的 `sessions.sqlite`、`-wal`、`-shm` 也没有显式 chmod。Unix/macOS 上目录通常按 umask 得到 0755，数据库通常 0644；内容包含完整 transcript、命令输出、工具输出，可能含密钥和内部路径。

**影响**：共享工作区、多用户主机或备份目录中，其他本地用户可以读取会话内容。项目对 spill 显式使用 0700/0600，对会话数据库却没有同等处理，保护级别不一致。

**建议**：runtime 目录显式 0700，数据库及 WAL/SHM 显式 0600，备份同样处理；启动时校验并收紧已有文件。Windows 使用 ACL，不依赖 mode。补一个 Unix/macOS 权限回归测试。

### SEC-04｜runtime 固定文件的符号链接没有被完整拦截

**P0 · 文件系统边界**

**位置**：[sqlite.ts](../packages/storage/sqlite.ts#L181)；[spill.ts](../packages/tools/spill.ts#L213-L225)；`runtime-directory.ts` 只检查目录。

**事实**：`ensureRuntimeDirectory()` 逐段检查目录并拒绝目录符号链接，但固定文件名不受保护。`new DatabaseSync(file)` 会跟随 `.yuantu/sessions.sqlite` 的符号链接；`spillResult()` 先 `statSync(file).size`，再用 `writeFileSync(..., { mode })` 写入，这是 `w` 语义，会跟随已存在的符号链接。

**影响**：如果仓库预置了 `.yuantu` 下的链接，或本地进程能在写入前替换文件，就可能把数据库/写入重定向到 workspace 外。它不一定能直接读取任意文件，但会破坏“所有 runtime 写入都在工作区”的边界。

**建议**：对固定 runtime 文件使用 `lstat` + `O_NOFOLLOW`（Windows 检查 reparse point），或写临时文件后 `rename`；打开后校验文件描述符的 `dev/ino`。`spillResult` 改为 `wx` 或 temp+rename，不能对已存在路径直接 `w`。

### SEC-05｜Windows 保留设备名可以绕过 workspace 写边界

**P0 · Windows 文件边界**

**位置**：[files.ts](../packages/tools/files.ts#L146-L193)。

**事实**：`Workspace.resolve()` 拦截了 URI、`:`、`..` 和符号链接，但没有拦截 Windows 保留设备名。本机验证：

```text
Workspace.resolve('NUL', true)  ->  <workspace>\NUL
writeFileSync(<workspace>\NUL)  ->  ok
```

`NUL`/`CON`/`COM1` 是设备，不是工作区文件；`lstat/realpath` 对它们返回 `ENOENT`，`allowNew` 分支因此把它们当作新文件。

**影响**：`write_file`、`apply_patch` 等写工具可以把操作重定向到设备，绕过“写入工作区”的语义；`CON`/`COM1` 还可能导致阻塞。它不直接读取任意文件，但属于 workspace 边界失效。

**建议**：在路径段检查中拒绝 `CON`、`PRN`、`AUX`、`NUL`、`COM1-9`、`LPT1-9`（忽略大小写，去掉尾部空格/点，考虑 `.txt` 等扩展名）；补 Windows 专用测试，覆盖 `NUL`、`CON.txt`、`COM1`。

---

## 4. 性能与容量

性能问题按“用户每轮都能感知”的程度排序。先给关键测量，再逐项分析。

| 测量项               | 结果             | 说明                                                     |
| -------------------- | ---------------- | -------------------------------------------------------- |
| `createTools()` 构建 | 50–116 ms        | 63 个工具 + Ajv 编译；冷启动 116 ms，热态 50–53 ms       |
| `tools.schema.all`   | 33,824 bytes     | 63 个工具；native 模式每次请求的 schema 体积             |
| 10k 消息数据库       | 13,115,392 bytes | messages 行 + search text 约 4,397,780 bytes，约 3× 放大 |
| 10k 消息冷读         | 121.8 ms         | fold 10k 条消息；缓存后 0.1 ms                           |
| 1 MB 畸形 HTML       | 15.98 s          | 未闭合 `<script>`；见 SEC-01                             |

### PERF-01｜每个 run 重建工具目录并重新编译全部 schema

**P1 · 启动/每轮延迟**

**位置**：[run-start.ts](../apps/agent-host/run-start.ts#L266)；[runtime.ts](../apps/shared/runtime.ts#L328)；[registry.ts](../packages/tools/registry.ts#L183)。

**事实**：每次 run 都 `createAgent` → `createTools` → `new ToolRegistry` → `new Ajv` → 对 63 个工具逐个 `compile`。本机 `createTools()` 构建时间冷启动 115.7 ms、热态 51–71 ms；这还没有算 provider、capacity、WorkspaceManager 等构造。

**影响**：用户每发一条消息都要重新付一次固定装配成本；会话越长、轮次越多，累计越明显。工具目录越大，成本越高。

**建议**：按 Host/session 缓存 base registry 和编译好的 validator；每个 turn 只复制 entries 并替换 run-scoped 工具。项目已有 `forRun()`（[registry.ts](../packages/tools/registry.ts#L430)），可以扩展成通用的 per-turn clone，而不是每轮重新注册全部工具。

### PERF-02｜限流器是 run 级，不是 Host/连接级

**P1 · 吞吐与 429 协调**

**位置**：[runtime.ts](../apps/shared/runtime.ts#L301)。

**事实**：`const gate = new AdaptiveConcurrency()` 在 `createAgent` 内创建；每个 run 都有自己的 gate。代码注释说“one rate gate for this runtime”，但两个并发会话的 429 退避互不协调。

**影响**：同一 endpoint 出现限流时，多个会话会各自试探、各自退避，端点看到的仍然是叠加后的突发流量；gate 的“全局限流”语义没有兑现。

**建议**：把 `AdaptiveConcurrency` 和 provider 提升到 Host/连接级，至少按 endpoint 共享；子 Agent 继续复用父 run 的 provider/gate。

### PERF-03｜会话打开是 8+ 次串行 RPC，且不可取消

**P2 · 会话切换延迟**

**位置**：[session-controller.ts](../packages/client/session-controller.ts#L535-L564)；[session-controller.ts](../packages/client/session-controller.ts#L425-L426)；[session-controller.ts](../packages/client/session-controller.ts#L644)。

**事实**：`read()` 顺序执行 `history`、`plan.get`、`subagents.list`、`todos.get`、`deliverables.get`、`goal.get`、`completion.current`、`run.queue.get`，最后再发一次 `session.events` 记录 cursor。`plan`/`subagents`/`todos`/`deliverables`/`goal`/`completion` 相互独立，却全部串行等待；`AgentHostClient.request()` 没有 `AbortSignal`，被切走的读请求仍继续占用 Host。

**影响**：切换会话、Host 重连时延迟叠加；用户快速切换会留下并行的旧读。

**建议**：增加 `session.bootstrap` 一次返回独立 view，或 `Promise.all` 这些只读请求；`history` 响应直接携带 `latestSeq`，省掉 `noteCursor`；给 request 增加 `AbortSignal`，generation 变化时取消旧读。

### PERF-04｜同步 SQLite 是 Host 的容量天花板

**P2 · 架构/吞吐**

**位置**：[sqlite.ts](../packages/storage/sqlite.ts#L181)。

**事实**：`new DatabaseSync(file)` 是同步 API；Host 是单线程。每次 `recordEvent`、messages 读、`PRAGMA data_version`、`session.search` 都会阻塞事件循环。缓存 fold 和 WAL 已经缓解了很多，但慢查询/慢解析仍会阻塞所有会话。

**影响**：这是架构约束而非单点 bug：随会话数、消息数、搜索复杂度增长，Host 的尾延迟会变差；SEC-01/02、CAP-03 都会放大它。

**建议**：中期考虑把 SQLite 放到 worker thread；短期先保证所有不可信二进制/HTML 解析不在 Host 主线程执行，并限制单次查询/解析的 CPU 预算。

### PERF-05｜大输出路径存在同步写和字符串 ring 复制

**P2 · 大输出性能**

**位置**：[spill.ts](../packages/tools/spill.ts#L82-L88)；[terminal.ts](../packages/tools/terminal.ts#L286)；[background.ts](../packages/tools/background.ts#L296)。

**事实**：spill 最多 8 MB 的 `writeFileSync`，随后 `trimSpills` 还同步 `readdir/stat` 50 个文件；terminal/background 每个 chunk 都执行 `(output + chunk).slice(-65536)`，会复制整个 ring。

**影响**：构建日志、测试输出、长终端会话会带来额外内存复制和事件循环阻塞。

**建议**：spill 改为异步/worker；terminal/background 使用分块 ring buffer，读取时再拼接；trim 放到可取消的后台任务。

### PERF-06｜标题搜索仍是无索引全表扫描

**P2 · 搜索延迟**

**位置**：[session-search.ts](../packages/storage/session-search.ts#L72)。

**事实**：消息搜索已经使用 FTS5，但标题仍是 `instr(lower(title), lower(?)) > 0`。会话数量大时，每次搜索框输入都会扫描 `sessions` 表。

**影响**：搜索体验会随会话数线性变差；消息 FTS 的优化被标题扫描抵消。

**建议**：建立 `title` FTS5 或前缀索引；至少把“标题包含”与“消息匹配”拆成两个可独立优化的查询。

### PERF-07｜高频 SQL 没有复用 prepared statement

**P2 · 数据库热路径**

**位置**：[session-event-journal.ts](../packages/storage/session-event-journal.ts#L564)；[session-event-journal.ts](../packages/storage/session-event-journal.ts#L494)。

**事实**：`recordEvent` 每次事件都 `db.prepare(...)`；`PRAGMA data_version` 也是每次重新 prepare。SQLite 的 prepare 会解析/编译 SQL，在高频事件下是纯额外成本。

**影响**：长会话、任务日志和统计事件会持续付出 SQL 编译成本；这也是 Host 主线程上的同步成本。

**建议**：在 `SessionStore`/journal 级别缓存常用 `StatementSync`，尤其是 `INSERT INTO session_events`、`MAX(seq)`、`data_version` 和 hydration 查询。

---

## 5. 能力、成本与可靠性

### CAP-01｜普通 run 没有总预算

**P1 · 成本与安全**

**位置**：[agent.ts](../packages/core/agent.ts#L672)；[run-request.ts](../packages/core/run-request.ts#L28-L30)。

**事实**：run loop 是 `for (let round = 0; ; round++)`，注释也明确写了“a run has no round cap”。当前只有单次模型请求超时、单次输出上限、单次工具调用超时和 goal 的 round/token 预算；普通用户请求可以无限轮工具调用，直到 Stop。

**影响**：对于无人值守 task 或 background wake，模型可以持续消耗 API 和时间；用户也可能无意中触发长时间 run。

**建议**：增加可配置的 `maxRunTokens`、`maxRunMs`、`maxToolCalls`/`maxRounds`，默认保守值并在 UI 显示当前消耗；与 goal budget 分开，不要把 goal 的预算当作普通 run 的默认值。

### CAP-02｜运行中的审批/提问无法在重连后恢复

**P1 · 交互可靠性**

**位置**：[session-controller.ts](../packages/client/session-controller.ts#L598-L601)；[session-controller.ts](../packages/client/session-controller.ts#L1153)。

**事实**：`read()` 重建会话时，只有当前客户端之前已经 `followed` 同一个 run，才会恢复 `approvals`/`questions`；否则设为空。`run.queue.get` 只返回 `running`/`items`/`runId`，没有 pending interactions；`session.get` 也没有。`onEvent()` 在 `state.running === false` 时会忽略后续事件。

**影响**：新的 carrier、窗口或 Host 重连在 run 中途接入时，能看到“运行中”，但审批/问题面板为空；审批会按超时预算变成拒绝/超时，用户无法及时介入。

**建议**：让 `run.queue.get` 或新的 `session.interactions` 返回当前 pending approvals/questions，`read()` 从该响应恢复；补一个“中途重连且存在 approval”的测试。

### CAP-03｜Office 解析在 Host 主线程，且 office_inspect 无权限

**P2 · 不可信输入/稳定性**

**位置**：[office/tools.ts](../packages/office/tools.ts#L76-L100)；[office/tools.ts](../packages/office/tools.ts#L316)。

**事实**：`office_inspect` 可以无审批读取最多 20 MB 的 DOCX/XLSX/PPTX，然后在本进程里交给 mammoth / SheetJS / PPTX reader。zip 有 48 MB 解压预算，但解析器的 CPU/内存行为没有进程隔离，也没有独立时间预算。

**影响**：工作区里的不可信文件可能让 Host 卡顿甚至 OOM；它不需要 write 权限，因此比写工具更容易被模型顺手触发。

**建议**：像附件读取那样把 Office 解析放进 worker（`apps/desktop/attachment-reader.ts` 已是 worker 模式），设置 CPU/内存/时间上限；`office_inspect` 应被视为不可信输入入口。

### CAP-04｜平台与发布边界存在能力/安全缺口

**P2 · 平台/发布**

**位置**：[runtime.ts](../apps/shared/runtime.ts#L88-L92)；[sandbox-mode.ts](../packages/tools/sandbox-mode.ts#L28-L33)；[main.ts](../apps/desktop/main.ts#L328)；[package.json](../package.json#L85-L94)；[electron-builder.config.cjs](../electron-builder.config.cjs#L99-L103)。

**事实**：Linux 上 `applySandboxDefaults()` 默认 `native`，但 native backend 在 Linux 抛错，CLI 必须显式 `YUANTU_SANDBOX=host`；macOS 关闭最后一个窗口直接退出；Playwright 是 devDependency，Host bundle 又 external，按当前 electron-builder 配置生产包可能不含 Playwright/Chromium，`browser_*` 只会返回 MISSING；Windows 安装包 `signExecutable: false`，手动升级只校验同目录 JSON 的 sha256。

**影响**：这些不是核心 Agent 逻辑错误，但会影响“装好就能用”的体验、发布可信度和浏览器能力。

**建议**：Linux CLI 在文档/启动时给出明确 fallback 提示；macOS 按平台保留窗口生命周期；在打包后验证 Playwright 是否存在，无法保证就条件化隐藏 `browser_*`；Windows 使用 Authenticode 并给升级 manifest 加签名验证。

---

## 6. 工程质量与架构债

### ENG-01｜Stop hook 在工具资源关闭之后才运行

**P2 · 扩展正确性**

**位置**：[run-finalization.ts](../packages/core/run-finalization.ts#L100-L110)。

**事实**：`tools.close()` 先关闭 MCP/LSP/browser/knowledge/search 等资源；如果 registry 自己拥有 hooks，还会调用 `hooks.close()`，可能释放 hook bridge 注册。之后才执行 `tools.extensions.stop()`。

**影响**：依赖这些资源的 stop hook 会看到已关闭的浏览器/MCP/LSP，或在 CLI/embedded 场景下丢失 hook bridge；注释说 stop hook 可以“touch source files”，与实现顺序不一致。

**建议**：先执行 `extensions.stop`，再关闭工具资源；补一个 stop hook 仍能正常执行/写文件的测试。

### ENG-02｜core 与具体 SessionStore 耦合，SessionStore 接口过宽

**P2 · 架构演进**

**位置**：[agent.ts](../packages/core/agent.ts)；[session-store-parts.ts](../packages/storage/session-store-parts.ts#L28-L46)。

**事实**：`packages/core` 的 run 模块直接引用 `storage/sqlite.ts` 的具体类型；只有部分接口使用 `Pick`。`SessionStore` 本身是 800+ 行、覆盖读/写/run/task/workspace 的宽接口，`SessionStoreFacade` 也已聚合 19 个跨域方法，职责边界不够窄。

**影响**：kernel 无法脱离 SQLite；测试替身和存储替换成本高；一个 store 改动会波及大量 run 模块。

**建议**：把 Agent 所需的最小能力收敛为端口（`RunStore`/`HistoryReader`/`EventWriter`），不要让 core 认识 `SessionStore` 的全部方法；按读写/task/workspace 拆分 facade。

### ENG-03｜事件日志/写穿表/FTS/checkpoint 造成约 3 倍存储放大

**P2 · 容量与迁移**

**位置**：benchmark 10k 消息样本；[events.ts](../packages/storage/events.ts)、[session-blobs.ts](../packages/storage/session-blobs.ts)、[session-checkpoints.ts](../packages/storage/session-checkpoints.ts)。

**事实**：10k 消息样本中 messages 行 + search text 约 4.4 MB，整个数据库约 13.1 MB。事件日志、messages 写穿表、FTS、projection checkpoint 同时存在；设计上这是为了可重放/可恢复，但长期会话会明显膨胀。

**影响**：备份、迁移、WAL 和磁盘占用都会随会话增长；会话库越大，备份和恢复越慢。

**建议**：评估把 messages 表退化为只读投影/视图，或对 event payload 做保留策略；至少给会话库大小和清理策略显式上限。

### ENG-04｜缺少 lint，测试门禁对负载较敏感，缺少解析器 fuzz

**P2 · 工程治理**

**位置**：[package.json](../package.json#L30-L68)；`tests/`；[run-tests.mjs](../scripts/run-tests.mjs)。

**事实**：没有 ESLint/Biome；tsc 能查未使用变量，但查不了 `no-floating-promises`、`no-misused-promises` 和过宽的 `any`。测试文件约 280 个、近 10 万行，覆盖很广，但完整 `npm test` 在本机 8 路并发时出现了 Host startup timeout；默认 fail-fast 还会让后续文件不执行。没有看到针对 HTML/Office/JSONL/SSE 的 fuzz 或 property test。

**影响**：异步资源泄漏、遗漏的 `await` 和解析器边界回归不容易在类型检查阶段暴露；高并发下测试结果可能掩盖真实问题。

**建议**：加 typescript-eslint 的 `no-floating-promises`/`no-misused-promises`；CI 强制 `FOUNDRY_TEST_CONTINUE_ON_FAILURE=1`；对 HTML、Office、SSE 加 fuzz/畸形输入测试。

### DEP-01｜生产依赖审计仍有待跟踪项

**P2 · 供应链**

**位置**：[check-audit.mjs](../scripts/check-audit.mjs)；`npm audit --omit=dev`。

**事实**：audit 报告 4 个生产依赖问题：2 个 high（`pptxgenjs` → `image-size`），项目在 `check-audit` 中接受，理由是 PPTX 输出不嵌入图片；2 个 moderate（MCP SDK 带来的 `hono`、`express-rate-limit` → `ip-address`），`audit:check` 只拦 high/critical，所以不会失败。

**影响**：当前风险取决于 MCP/OAuth 是否启用、PPTX 是否处理图片；不是立即阻断项，但依赖债会累积。

**建议**：定期跟进 `hono`/`ip-address`；`image-size` 的接受理由要随上游修复移除；如果未来 PPTX 支持图片，需要重新评估该豁免。

---

## 7. 验证记录

验证环境：Windows，16 逻辑核，16 GB 内存，Node 24.19.0。性能数字是本机测量，不是 CI 契约；完整测试部分受到并行 benchmark 干扰，见 7.3。

### 7.1 静态与工程门禁

| 命令                           | 结果 | 备注                              |
| ------------------------------ | ---- | --------------------------------- |
| `npm run typecheck`            | 通过 | strict + noUncheckedIndexedAccess |
| `npm run cycles:check`         | 通过 | 459 files / 1137 edges / 0 cycles |
| `npm run layers:check`         | 通过 | 18 packages / 11 layers           |
| `npm run test:isolation:check` | 通过 | 0 violations                      |
| `npm run format:check`         | 通过 | Prettier                          |
| `npm run i18n:check`           | 通过 | i18n 一致性                       |
| `npm run audit:check`          | 通过 | 2 个 accepted advisories          |
| `npm run bench -- --check`     | 通过 | 15 条规则                         |

### 7.2 定向测试

| 测试                           | 结果         | 运行条件              |
| ------------------------------ | ------------ | --------------------- |
| `tests/client.test.ts`         | 46 / 46 通过 | `YUANTU_SANDBOX=host` |
| `tests/host-workflows.test.ts` | 18 / 18 通过 | `YUANTU_SANDBOX=host` |

### 7.3 完整 npm test 的说明

完整 `npm test` 是在同时跑 benchmark 的情况下执行的：8 路并发下出现 5 个失败，包括 Host `host.info` 10 秒超时、`coding-evaluation` 输入哈希变化等，最终只 settle 了 9/283 个文件。这个结果不能直接判定为产品回归，但说明默认启动超时和测试并发度对机器负载比较敏感。发版前应在无 benchmark 干扰的机器上，用 CI 模式（`FOUNDRY_TEST_CONTINUE_ON_FAILURE=1`）完整复跑。

### 7.4 依赖审计

`npm audit --omit=dev` 返回 4 个生产依赖问题：2 个 high（`image-size` via `pptxgenjs`）和 2 个 moderate（`hono`、`ip-address`）。项目 `audit:check` 通过，并对 `image-size` 给出“PPTX 输出不嵌入图片”的接受理由；moderate 不进入 gate。详见 DEP-01。

> **结论口径**
>
> 当前可以确认：类型、分层、隔离、格式、i18n、benchmark 门禁通过；定向 client/host-workflows 测试通过。当前不能确认：完整套件在负载下全绿，以及所有平台/打包路径都可用。

---

## 8. 修复路线图

| 阶段              | 任务                                                                                                | 验收标准                                                                                                                |
| ----------------- | --------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Phase 1<br>0–2 天 | SEC-01 HTML parser；SEC-02 instructions size cap；SEC-03 权限；SEC-05 设备名。                      | 2 MB 畸形 HTML 不阻塞 Host；巨大 instructions 不会全量读；DB 权限 0700/0600；NUL/CON 被拒绝。                           |
| Phase 2<br>3–5 天 | PERF-01 工具目录缓存；PERF-02 Host 级 gate；CAP-01 run 总预算；CAP-02 pending interactions 恢复。   | 第二个 turn 不再重新编译 63 个 schema；并发会话共享 429 退避；run 可设置 token/time 上限；重连能看到 pending approval。 |
| Phase 3<br>1–2 周 | PERF-03 session bootstrap/abort；CAP-03 Office worker；PERF-06 标题 FTS；PERF-07 statement cache。  | 会话切换请求可取消且并行；Office inspect 在 worker 内；标题搜索走索引；高频 SQL 复用 statement。                        |
| Phase 4<br>持续   | ENG-01 stop hook 顺序；ENG-02 core/store 解耦；ENG-03 存储保留策略；ENG-04 lint/fuzz；DEP-01 依赖。 | stop hook 在资源关闭前执行；core 只依赖端口；会话库有上限；lint 与 fuzz 进入 CI；依赖豁免有到期复核。                   |

### 8.1 需要产品决策的事项

- 普通 run 的默认预算：多长算“太长”、多少 token 算“超支”？建议默认值与 goal 预算分开。
- Windows 安装包是否启用 Authenticode；手动升级是否要求签名 manifest，而不只是同目录 sha256。
- 桌面发布包是否正式包含 Playwright/Chromium；如果不包含，是否隐藏 `browser_*` 工具而不是让模型调用后得到 MISSING。
- 会话库保留策略：永久保留、按大小清理，还是把旧会话归档到独立数据库。
- Linux CLI 的默认 sandbox fallback：保持 fail-closed 并明确提示，还是允许 host 并弹出确认。

### 8.2 第一批验收用例

- 构造 2 MB 未闭合 `<script>` 页面，`web_fetch` 在 1 秒内返回错误或完成，Host 仍能响应其他请求。
- 构造 2 GB `AGENTS.md`，启动 run 不 OOM；提示文件被截断。
- Unix/macOS 新建 `.yantu`，断言目录 0700、DB/WAL 0600。
- Windows 调用 `write_file('NUL')` / `write_file('CON.txt')` 必须被拒绝。
- 工具目录第二次 run 的构建时间显著下降，且没有 Ajv compile 计数增长。
- run 中途重连，pending approval 仍可见并可响应。

---

## 附录 A：问题索引

| ID      | 优先级 | 类别        | 问题                        | 位置                                          |
| ------- | ------ | ----------- | --------------------------- | --------------------------------------------- |
| SEC-01  | P0     | 安全/可用性 | HTML 解析二次复杂度         | `web.ts`                                      |
| SEC-02  | P0     | 稳定性      | instructions 全量读取       | `instructions.ts`                             |
| SEC-03  | P0     | 数据保密    | DB 权限/明文                | `sqlite.ts` / `runtime-directory.ts`          |
| SEC-04  | P0     | 文件边界    | runtime 符号链接            | `sqlite.ts` / `spill.ts`                      |
| SEC-05  | P0     | Windows     | 保留设备名                  | `files.ts`                                    |
| PERF-01 | P1     | 性能        | 每轮重建工具目录            | `run-start.ts` / `runtime.ts` / `registry.ts` |
| PERF-02 | P1     | 吞吐        | run 级限流器                | `runtime.ts`                                  |
| CAP-01  | P1     | 成本        | 普通 run 无总预算           | `agent.ts` / `run-request.ts`                 |
| CAP-02  | P1     | 交互        | pending interactions 不恢复 | `session-controller.ts`                       |
| PERF-03 | P2     | 延迟        | 会话读 8+ 串行 RPC          | `session-controller.ts`                       |
| PERF-04 | P2     | 架构        | 同步 SQLite 阻塞 Host       | `sqlite.ts`                                   |
| PERF-05 | P2     | 性能        | spill/terminal 同步写       | `spill.ts` / `terminal.ts` / `background.ts`  |
| PERF-06 | P2     | 搜索        | 标题无索引                  | `session-search.ts`                           |
| PERF-07 | P2     | 数据库      | 未复用 prepared statement   | `session-event-journal.ts`                    |
| CAP-03  | P2     | 稳定性      | Office 解析在 Host          | `office/tools.ts`                             |
| CAP-04  | P2     | 平台/发布   | Linux/macOS/Playwright/签名 | `runtime.ts` / `main.ts` / `package.json`     |
| ENG-01  | P2     | 扩展        | stop hook 顺序              | `run-finalization.ts`                         |
| ENG-02  | P2     | 架构        | core/store 耦合             | `agent.ts` / `session-store-parts.ts`         |
| ENG-03  | P2     | 容量        | 存储放大                    | storage schema                                |
| ENG-04  | P2     | 治理        | lint/测试/fuzz              | `package.json` / `tests`                      |
| DEP-01  | P2     | 供应链      | 依赖审计待跟踪              | `check-audit.mjs`                             |

---

## 附录 B：关键测量与复现命令

以下命令用于复核本报告中的关键数字。时间数字受机器、磁盘和负载影响，不应作为 CI 阈值直接使用。

### B.1 工具目录构建

```bash
node --input-type=module -e "
  import { createTools } from './packages/catalog/index.ts';
  import { mkdtemp, rm } from 'node:fs/promises';
  import { tmpdir } from 'node:os'; import path from 'node:path';
  const root = await mkdtemp(path.join(tmpdir(), 'yuan-ts-'));
  for (let i=0;i<4;i++) {
    const a=performance.now(); const r=createTools(root, undefined, 'standalone');
    const b=performance.now(); await r.close();
    console.log(i, (b-a).toFixed(1)+'ms');
  }
  await rm(root,{recursive:true,force:true});
"
```

### B.2 畸形 HTML

```bash
node --input-type=module -e "
  import { htmlToText } from './packages/tools/web.ts';
  for (const n of [100000,500000,1000000]) {
    const html='<script>'.repeat(Math.floor(n/8));
    const t=performance.now(); htmlToText(html);
    console.log(n,(performance.now()-t).toFixed(1)+'ms');
  }
"
```

### B.3 Windows 保留设备名

```bash
node --input-type=module -e "
  import { Workspace } from './packages/tools/files.ts';
  import { mkdtemp, rm } from 'node:fs/promises';
  import { tmpdir } from 'node:os'; import path from 'node:path';
  const root=await mkdtemp(path.join(tmpdir(),'yt-dev-'));
  const w=new Workspace(root);
  for (const n of ['NUL','CON','COM1']) console.log(n, await w.resolve(n,true));
  await rm(root,{recursive:true,force:true});
"
```

### B.4 常用门禁

```bash
npm run typecheck
npm run cycles:check
npm run layers:check
npm run test:isolation:check
npm run format:check
npm run i18n:check
npm run audit:check
npm run bench -- --check
```

---

## 附录 C：修复状态（截至 2026-10-23）

以下状态按当前工作树核对，对应提交 `fd60572`、`33e2ad2`、`ed1971b`、`d7d4f60`、`d95d61a`、`a5587a3`、`506a702` 及本轮未提交改动。

| ID      | 状态       | 说明                                                                                                                                                                |
| ------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SEC-01  | 已修复     | `htmlToText` 单遍线性扫描；畸形输入随机测试在 `tests/malformed-input.test.ts`。                                                                                     |
| SEC-02  | 已修复     | 只读预算内前缀；未做 `(size, mtime)` 缓存，OOM 风险已消除。                                                                                                         |
| SEC-03  | 部分修复   | POSIX 已 0700/0600。Windows 未处理：非系统盘工作区的 `.yuantu`、`sessions.sqlite` 继承盘根的 `Authenticated Users:(M)`，本机其他用户可读。静态加密未做。            |
| SEC-04  | 已修复     | 会话库及 `-wal/-shm/-journal` 拒绝符号链接；spill 改为临时文件加 rename。                                                                                           |
| SEC-05  | 已修复     | 拒绝 Windows 保留设备名。                                                                                                                                           |
| PERF-01 | 已修复     | Ajv 校验器按内容复用，`createTools` 约 170 ms → 14 ms；registry 本身仍每轮新建。                                                                                    |
| PERF-02 | 已修复     | 限流器按协议、地址和 key 进程内共享。                                                                                                                               |
| PERF-03 | 已修复     | 会话视图并行读取，新读取取消旧读取，`run.queue.get` 带 `latestSeq`。                                                                                                |
| PERF-04 | 未修复     | 架构项；先靠事件循环监控（`f2b5832`）观测，确认 SQLite 是瓶颈再移到 worker。                                                                                        |
| PERF-05 | 已修复     | terminal/background 改用分块 `OutputRing`（`packages/tools/output-ring.ts`）；spill 的目录修剪改为后台异步、按目录串行。spill 写入本身仍同步。                      |
| PERF-06 | 评估后不改 | 实测 trigram 索引让常见词查询从 0.05 ms 变成 62 ms，保持 `instr` 扫描。                                                                                             |
| PERF-07 | 已修复     | 事件日志高频 SQL 按连接缓存 statement。                                                                                                                             |
| CAP-01  | 已修复     | 普通 run 有总预算（2 小时、2000 万 token；轮次默认不限）。                                                                                                          |
| CAP-02  | 已修复     | `run.queue.get` 返回待处理审批和提问，重连后恢复。                                                                                                                  |
| CAP-03  | 已修复     | `office_inspect` 在 worker 中解析（30 秒、512 MB 堆、可取消）；补了损坏包随机测试。                                                                                 |
| CAP-04  | 部分修复   | macOS 关窗改为隐藏、Dock 图标恢复；Linux CLI 启动提示与报错给出 `YUANTU_SANDBOX=host`。Playwright 打包与 Windows 签名待产品决策（§8.1）。                           |
| ENG-01  | 已修复     | stop hook 先于 `tools.close()`。                                                                                                                                    |
| ENG-02  | 未修复     | core 仍直接引用 `storage/sqlite`；建议随相关模块改动逐步收窄为端口。                                                                                                |
| ENG-03  | 部分修复   | 增量 auto_vacuum 回收删除空间；存储放大和保留策略待产品决策。                                                                                                       |
| ENG-04  | 已修复     | `npm run lint`（typescript-eslint：`no-floating-promises`、`no-misused-promises`、`await-thenable`）进入 `npm run check`；HTML/SSE/分帧/Office 有随机畸形输入测试。 |
| DEP-01  | 部分修复   | hono、ip-address 已升级；`image-size` 两个 high 仍为豁免，`check-audit.mjs` 加了复核日期（2027-01-31），到期 gate 失败。                                            |

lint 首次接入时发现 `tests/network.test.ts` 中 4 处 `assert.rejects` 未 await，这些断言此前没有真正生效，已修正。
