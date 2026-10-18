# YuanTu Agent 架构与能力分析

- 记录日期：2026-10-17
- 分析对象：`E:\agent-desktop\YuanTu-Foundry`（`HEAD` = `3c2e26b`，工作树干净）
- 方法：全仓库文件级扫描（349 个 `.ts` 源文件、249 个行为测试文件）、对入口与关键模块的定向阅读、跨包导入关系自动提取、门禁脚本实测（详见《测试耗时统计》与《问题清单》两份文档）
- 说明：本文只描述**今天这棵树**的事实。数字凡能由代码算出者，均给出出处；与 README 生成事实块冲突时，以生成事实块为准。

---

## 1. 摘要

YuanTu Agent 是一个**自研的桌面编程 Agent 内核 + Electron 客户端**，不是某个开源 Agent 的封装：

- 内核（`packages/core`）自己实现「请求模型 → 执行工具 → 事件落盘」的循环，以及上下文预算、压缩、子代理、持久任务、目标续跑、计划模式。
- 模型协议（`packages/providers`）自己实现 Anthropic Messages、OpenAI Chat Completions、OpenAI Responses 三种适配器，含 SSE、重试边界、缓存键与用量统计。
- 会话存储（`packages/storage`）是 SQLite 事件日志 + 投影，`seq` 为全局游标，UI 的一切状态从日志重放/检查点得到，不另存一份状态。
- 工具面（`packages/tools` + 若干集成包）共 67 个工具，统一走 9 阶段执行管线与单调守卫（只能拒绝，不能授权）。
- 宿主（`apps/agent-host`）把内核包成 58 个 JSON-RPC 方法；载体层（`packages/carrier` + `packages/client`）是一套受校验的命令词表与客户端状态机；Electron 桌面（`apps/desktop`）是无框架、无状态库的渲染层。
- 当前产品形态**只交付桌面**（Windows/macOS）。CLI、Web、ACP、对外 SDK 与 MCP 服务管理被 `packages/protocol/product-scope.ts` 的开关暂停，源码与测试保留。

它最突出的工程特征不是功能数量，而是**「可验证性优先」**：README 的数字由脚本算出并门禁；工具管线在每次执行时校验阶段顺序；测试调度器为每个文件建私有机密目录/端口/临时状态并检查进程清理；文档引用路径有独立门禁。代价是仓库复杂度高、测试规模几乎与源码 1:1。

---

## 2. 项目定位与产品形态

| 维度      | 事实                                                                                              |
| --------- | ------------------------------------------------------------------------------------------------- |
| 名称/版本 | `yuantu-agent` 0.1.0，私有包（`package.json`）                                                    |
| 运行时    | Node.js ≥ 24（`engines`），ESM；TypeScript 由 Node 类型擦除直接运行，`npm run build` 只是分发形态 |
| 桌面壳    | Electron 43 + electron-builder 26，Windows NSIS / macOS dmg+zip                                   |
| 对外交付  | Windows/macOS 本地 Electron 客户端；模型端点由用户配置                                            |
| 暂停入口  | CLI、Web、ACP、SDK/ACP 公开入口、桌面 MCP 服务管理（`PRODUCT_SCOPE`）                             |
| 许可      | MIT（`LICENSE`）                                                                                  |

`PRODUCT_SCOPE` 是一个 7 行的常量表，被 CLI/Web/ACP 入口的 `requireProductEntry()` 与桌面的 MCP IPC/渲染层读取。它把「产品范围」变成一个可读的代码事实，而不是散落在文档里的约定；`package.json` 的 `pausedEntrypoints` 保存被摘掉的 npm 入口，恢复时两处必须同步（README 明确写了这条规则）。

---

## 3. 仓库结构与规模

| 目录                   | 内容                                                                  | 规模（TS/JS 行数，不含 `node_modules`）                        |
| ---------------------- | --------------------------------------------------------------------- | -------------------------------------------------------------- |
| `packages/core`        | 内核：循环、预算、压缩、子代理、任务、目标、计划、投影辅助            | 65 文件 / 18,081 行                                            |
| `packages/tools`       | 工具目录、执行管线、注册表、沙箱、后台命令、终端、文件日志            | 56 文件 / 14,315 行（另有 Rust `windows-sandbox` 约 1,600 行） |
| `packages/storage`     | SQLite、事件日志、迁移、投影、检索、任务/工作区表                     | 22 文件 / 9,673 行                                             |
| `packages/protocol`    | 类型真源：消息/事件/RPC/设置/失败码/限额/图片                         | 34 文件 / 6,027 行                                             |
| `packages/search`      | 符号索引、ripgrep 后端、清单/游标                                     | 10 文件 / 3,301 行                                             |
| `packages/workspaces`  | Git worktree 隔离子代理、快照、结果导入                               | 5 文件 / 3,197 行                                              |
| `packages/client`      | Host 客户端：JSONL 传输、会话状态机                                   | 7 文件 / 2,622 行                                              |
| `packages/lsp`         | 语言服务器管理                                                        | 5 文件 / 2,452 行                                              |
| `packages/providers`   | 三种协议适配器、SSE、缓存、容量发现                                   | 14 文件 / 2,426 行                                             |
| `packages/carrier`     | 载体契约与服务（命令词表、快照、增量通道）                            | 4 文件 / 1,942 行                                              |
| `packages/mcp`         | MCP 客户端与 OAuth 2.1                                                | 4 文件 / 1,944 行                                              |
| `packages/office`      | DOCX/XLSX/PPTX 读写与预览                                             | 6 文件 / 1,180 行                                              |
| `packages/resources`   | 项目指令、Skills、扩展、外部钩子桥                                    | 6 文件 / 999 行                                                |
| `packages/knowledge`   | markdown 记忆 + 文档索引（FTS5）                                      | 4 文件 / 732 行                                                |
| `packages/maintenance` | 桌面升级/回滚事务                                                     | 1 文件 / 362 行                                                |
| packages/sdk           | ACP 适配与 SDK 导出（已移出主干，见分支 archive/web-sdk-acp）         | 2 文件 / 296 行                                                |
| `packages/platform`    | 用户状态目录、测试生命周期钩子                                        | 2 文件 / 21 行                                                 |
| `apps/desktop`         | 主进程、preload、渲染层、i18n、设置、面板                             | 70 文件 / 20,172 行                                            |
| `apps/agent-host`      | Host：RPC 分发、会话/运行/任务/工作区处理器、调度器                   | 24 文件 / 4,094 行                                             |
| `apps/shared`          | 装配层：`createAgent()`、参数、CLI 命令表、钩子                       | 4 文件 / 850 行                                                |
| `apps/cli`             | 单文件 CLI（暂停）                                                    | 1 文件 / 1,277 行                                              |
| apps/web               | 本机 Web 桥（已移出主干，见分支 archive/web-sdk-acp）                 | 9 文件 / 23,032 行（含构建产物）                               |
| apps/agent-acp         | ACP 入口（已移出主干，见分支 archive/web-sdk-acp）                    | 1 文件 / 102 行                                                |
| `tests`                | 行为测试 + 冒烟 + 快照 + 夹具                                         | 249 个 `.test.ts` / 88,331 行；16 个 `.smoke.mjs`              |
| `scripts`              | 构建、门禁、测试调度、覆盖率、打包                                    | 67 文件 / 约 0.3 MB                                            |
| `benchmarks`           | 性能基准、检索基准、编码评测                                          | 36 文件                                                        |
| sdk/python             | Host JSONL 的 Python 客户端（已移出主干，见分支 archive/web-sdk-acp） | 4 文件                                                         |
| `build`                | 图标、ripgrep 资产锁、Windows 运行时锁、受保护安装脚本                | 12 个已跟踪文件                                                |

源码（`apps`+`packages`，排除 `windows-sandbox`）共 **349 个 TS 文件 / 91,381 行**；测试 **249 个文件 / 88,331 行**——测试与源码行数比约 **0.97:1**。这解释了为什么本项目的质量论证主要落在测试与门禁上。

> 注：`packages/tools/windows-sandbox/appcontainer/target/` 下约 660 MB 的 Rust 构建缓存不在版本控制内（嵌套 `.gitignore`），但会占据工作树；`dist/`、`.scratch/`、`.yuantu/` 同样被忽略。

---

## 4. 运行时总体架构

### 4.1 分层与真实依赖

README 明确声明「包之间不是严格单向分层」，这与实测一致。用 TypeScript AST 按 `scripts/check-import-cycles.mjs` 的同一套规则统计（排除 `import type`）：

- 349 个文件、386 条同仓库值导入、85 组包间值导入边。
- **8 组包对互相导入**（值导入，不含纯类型）：
  `core ↔ tools`、`core ↔ workspaces`、`core ↔ storage`、`tools ↔ resources`、`tools ↔ mcp`、`tools ↔ office`、`tools ↔ knowledge`、`tools ↔ lsp`。
- 入度最高的三个包：`protocol`（150 条）、`core`（63 条）、`tools`（59 条）。
- 文件级值导入环为 **0**（`npm run cycles:check` 的判定口径），即包级耦合没有退化成模块初始化环。

因此更准确的描述是「**以 `protocol` 为类型/契约中心的星形 + 以 `core`↔`tools` 为轴的双向依赖**」，而不是分层栈。这样做的收益是内核可以直接调用工具注册表、工具又需要内核的事件/权限类型；代价是任何要抽出独立包（如把 tools 搬出进程）的动作都需要先拆这 8 组环。

### 4.2 一次运行的数据流

```text
载体（Electron 渲染层 / Web / 自建）
   │  CarrierCommand（受校验的命令词表）
   ▼
CarrierService ── AgentHostClient ── JSONL(stdin/stdout 或回环 TCP) ──► apps/agent-host
                                                                          │
                                                                          ▼
                                                                  packages/core Agent
                                                        循环：请求模型 → 执行工具 → 事件落盘
                                                            │          │          │
                                                      providers    tools     storage
                                                      (SSE/用量)   (管线)    (事件日志)
                                                            │          │          │
                                                            └──── 界面看到的一切 ← 日志投影
```

CLI 是另一条路：进程内直接 `createAgent()`，不经 `CarrierService`，并明确拒绝 `--listen`。桌面与 Web 共用同一份渲染层（当时的 Web 桥复用 `apps/desktop/renderer.ts`；Web 桥已移出主干），差别只在 `window.yuantu` 背后是 Electron IPC 还是 WebSocket——这是 `packages/carrier` 作为「接缝」的价值。

### 4.3 唯一装配点

`apps/shared/runtime.ts` 的 `createAgent()` 是内核唯一的装配点，顺序是：读 provider 配置 → 建 provider → 解析上下文容量（声明 → 目录 → `/models` 发现 → 应用默认）→ 构造 `Agent` 并注入工具注册表、子代理 provider 解析器、可委派模型、审批/提问回调、权限策略 getter、驻留与 `childTools`、全部预算参数 → 注册工具 → 装载外部钩子。

桌面、Host、CLI 与 Web 都走这一个函数，因此「同一份配置在四个入口给出同一个答案」是构造上的，而不是靠测试对齐的。

---

## 5. 核心子系统

### 5.1 内核循环

`packages/core/agent.ts`（1,507 行）保留 `Agent` 类与运行入口，但循环的每个阶段已经拆成独立模块，按职责命名：

| 模块                                                    | 职责                                      |
| ------------------------------------------------------- | ----------------------------------------- |
| `run-context.ts`                                        | 组装本轮上下文输入                        |
| `run-request.ts`                                        | 一次模型请求（重试边界、usage、失败分类） |
| `run-tools.ts`                                          | 工具批次、并发分类、结果回收              |
| `run-completion.ts`                                     | 完成契约、验收、最终摘要                  |
| `run-finalization.ts`                                   | 收尾：资源清理、文件指纹、事件落盘        |
| `run-delegation.ts` / `run-subagents.ts`                | 委派与子代理协调                          |
| `run-interaction.ts`                                    | 审批与提问等待                            |
| `run-emit.ts` / `run-prompt.ts`                         | 事件发射与提示词分段                      |
| `run-residency.ts`                                      | 驻留子代理的回合结算                      |
| `context.ts` / `shrink.ts` / `prune.ts` / `forecast.ts` | 预算前瞻、缩短、裁剪、压缩决策            |

循环的失败语义集中在 `packages/protocol/failure.ts`：12 个失败码，`context-window-exceeded`/`output-limit` 映射为 `limited`，其余为 `failed`；退出码 0/1/2/130 与状态一一对应。重试只在**步骤边界**、且**尚未向用户显示任何内容**时发生，计数从日志读回，因此进程崩溃不会重置额度。

### 5.2 模型协议层

`packages/protocol/index.ts` 的 `BUILTIN_PROTOCOLS` 是唯一声明处（同时喂给设置枚举与注册表）：

| 协议               | 密钥变量            | 端点拼接                           | 硬前提                                                |
| ------------------ | ------------------- | ---------------------------------- | ----------------------------------------------------- |
| `anthropic`        | `ANTHROPIC_API_KEY` | `/v1` 结尾追加 `/messages`         | `thinking` 预算 25/50/75%，≥1024 token                |
| `openai`           | `OPENAI_API_KEY`    | `/v1` 结尾追加 `/chat/completions` | 必须支持 `stream_options.include_usage`，缺用量即失败 |
| `openai-responses` | `OPENAI_API_KEY`    | `/v1` 结尾追加 `/responses`        | 必须返回加密推理项，否则失败                          |

共性设计：

- 统一 SSE 解析器，单帧上限 16 MB，必须看到终态事件；`redirect: 'error'`；base URL 必须 HTTPS（回环除外）。
- 提示缓存四种粒度（`auto`/`blocks`/`key-only`/`off`），键是「协议+模型+系统提示+工具定义」的 SHA-256，**正文与凭据不进键**。
- 容量解析四级：操作者声明 → 同端点容量表 → 内置目录 → 端点 `/models` 发现（3 秒、1 MiB、缓存 5 分钟）→ 应用默认 1,000,000 / 256,000 token。
- 用量自我校准：按 UTF-8 字节/3 估算，用真实 usage 校准（限幅 0.5–3），并按「协议+模型+连接」落盘。

### 5.3 工具系统与执行管线

工具面由 `createTools()`（`packages/catalog/index.ts`，210 行）注册；在空工作区下发 **67 个工具 / 36.6 KB schema**，只读运行 **34 个 / 18.2 KB**，`YUANTU_TOOL_MODE=ptc` 时折叠为 **1 个 `run_code` / 10.6 KB**（生成事实，`npm run docs:check` 核验）。

执行管线是 9 个有名字的阶段，且**在每次执行时**由 `packages/tools/pipeline.ts` 的 `ToolPipelineInvariant` 校验顺序与先决条件：

```text
validate → pre-execute → guards → prepare → approval → execute → post-execute → finalize → result
```

关键语义：

- `pre-execute` 与 `guards` **只能拒绝**（单调），「扩展允许了它」在这条管线里无法表达；这正是守卫可以安全继承进被委派运行的原因。
- 工具体抛错变成 `isError` 结果但仍进入后续阶段；`aroundTool` 可以多次 `next()`（重试），但不调用 `next()` 会失败。
- `post-execute` 的 `block` 优先且不可被后续钩子解除；`finalize` 只能改内容，改不了失败标记与变更记录。
- 钩子分发有 5 个具名模式（`dispatchEmit`/`dispatchFirst`/`dispatchSerial`/`dispatchWaterfall`/`dispatchThreaded`），把「同样四个问题被四次偶然回答」收敛成一次具名回答。
- 阶段违规不只让本次工具调用失败，还会通过 `pipelineStagesInvariant` 升级为**整轮运行失败**。

工具来源是可组合的：基础目录 + 按宿主/工作区追加（子代理、工作区结果、会话查询、目标、计划、工作流、技能、持久任务、MCP、扩展）。因此「这次运行有哪些工具」取决于装配结果，发出去的 schema 才是事实。

### 5.4 权限、审批与沙箱

三层相互独立、不可互相替代：

1. **工具声明的权限**：读取/搜索不声明权限；写入、命令、外部访问逐项声明并逐次审批。无审批者或无法回答 = 拒绝；没有「永久允许」。
2. **权限策略文件**：`--permission-policy` / `YUANTU_PERMISSION_POLICY`，`deny` > `ask` > `allow`，按 kind/精确工具名/**完整参数对象**匹配（不是命令前缀白名单），且覆盖 `--allow-*`。
3. **命令沙箱**：`YUANTU_SANDBOX=native|windows|seatbelt|host`，文件与网络策略独立声明。Windows 用 Low 完整性受限令牌（**部分写入边界**，读与网络不受限）；macOS 用 Seatbelt；不支持的组合**拒绝执行**而不是回退宿主。

桌面把「沙箱 + 审批」捆成三档（仅可查看 / 工作区内修改 / 完全权限），档位属于会话，切换即时作用于尚未执行的调用；已启动的命令、后台进程、终端、LSP 保留创建时的执行环境。`host` 明确不是安全边界，README 与代码注释都反复声明这一点。

Windows 增强后端（AppContainer）有完整原型（Rust helper + ACL 脚本 + 打包/签名门禁），但**未作为公开模式启用**；`scripts/check-windows-appcontainer.mjs` 把它作为「就绪检查」而非能力声明。这是本项目最诚实的部分之一：没有把「能编译」说成「已隔离」。

### 5.5 会话存储、事件日志与投影

- 默认库：`<workspace>/.yuantu/sessions.sqlite`；WAL、`busy_timeout`、`foreign_keys=ON`；**比代码更新的 schema 拒绝打开**（当前 v30）。
- 当前 schema 有 **22 张表**：`sessions`、`messages`、`attachment_blobs`、`session_events`、`session_leases`、`runs`、`run_stream_checkpoints`、`file_changes`、`file_change_files`、`projection_checkpoints`、`tasks`、`plans`、`task_attempts`、`task_step_checkpoints`、`task_effects`、`task_approvals`、`workspace_bindings`、`workspace_operation_leases`、`workspace_snapshots`、`workspace_results`、`workspace_apply_receipts`、`application_marker`。
- 事件日志是**唯一真源**：`seq` 全局自增，既是持久游标也是客户端游标；持久事件类型 50 个（`SESSION_EVENT_TYPES`），实时事件 46 个（`AGENT_EVENT_TYPES`）。未知事件类型默认**拒绝**而不是跳过。
- 10 个内置投影（消息、统计、轮次计时、子代理、收件箱、待办、交付物、目标、步骤等）；检查点只是派生数据，写失败静默、版本不符则全量折叠。
- 会话租约是「当前有谁在写」的一行记录，用 `process.kill(pid,0)` 判活，**永不按时间过期**；压缩另有独立锁。
- 文件改动组在事前保存「之前的字节」，撤销冲突安全（已应用/已放弃/冲突三态），撤销本身也是一次运行。
- 迁移前自动做一致性备份；备份/校验/恢复/压缩通过 CLI 维护命令（`db-backup`/`db-verify`/`db-restore`/`db-recover`/`db-compact`）。

### 5.6 上下文预算与压缩

- 每轮请求前做**一次**前瞻：同时回答「需要多少输入」与「预算还剩多少」，同一个结果被三处共用（裁剪输出上限、是否缩短旧结果、是否提前压缩）。
- 估算按 UTF-8 字节/3 + 256 token 协议余量 + 每图 4096 token；**不是精确 tokenizer**，但用供应商 usage 自我校准，并按路由落盘。
- 旧工具结果按 token（不是字符）缩短，最新结果与「最后一次工具调用之后的结果」结构上永不缩短；完整输出落 `.yuantu/spill/<会话>/`，`read_file` 可读回。
- 历史摘要**活在对话里**（第一条 user 消息、`<compacted-summary>` 包裹），而不是挂在 system 末尾——因为提示缓存是逐字节前缀，摘要在 system 会让每次压缩作废整场缓存。摘要要求固定八段 markdown，空段写 `None.`，避免散文逐次丢段。
- 若「现在付得起摘要、发完这轮就付不起」，则提前压缩；手动压缩不受可负担性门禁。

### 5.7 多 Agent、持久任务、目标与计划

- **子代理**：`delegate_task` 让父运行把自成一体的工作交给独立会话；`explore` 角色只读（白名单在子代理自己的注册表上强制，不是「不展示」）；写入型子代理默认在 Git worktree 隔离目录工作，产物经父代理显式审批后合入（`workspace_results` / `workspace_result_apply`，digest + 逐文件字节复核，冲突则整体不写）。
- **驻留与追问**：子代理报告后可作为 `idle` 留在内存，用 `send_message` 追问；进程重启后仍能按父日志重建身份、用**它自己的转录**继续，并交还剩余额度。
- **结构化报告**：`submit_report` 必须给出结论/依据/未核实/阻碍，空报告被拒绝。
- **上限**：单次 4 个任务、并发 8、单次父运行 8 个、默认不再往下委派、无进展 600 秒看门狗（按「沉默」计时）。
- **持久任务**：带验收条件与触发器的实体，落在同一 SQLite（tasks/attempts/steps/effects/approvals 五组表），Host 调度器按到点或事件触发；事件级联有深度上限，调度器只在没有活动运行时动手。
- **目标续跑**：`runGoalRounds` 在运行结束后自动推进，轮数上限独立于目标自身预算；`edit`/`pause`/`resume` 只允许出现在带用户输入的回合（`HUMAN_ONLY_GOAL_ACTIONS`），续跑轮不能抬高自己的预算。
- **计划模式**：计划 → 人批准（核对计划哈希）→ 执行；停在计划阶段的会话在下次 `resume` 时仍是计划运行。

### 5.8 记忆、知识、技能、扩展与钩子

- **记忆**：markdown 是真源（工作区 `.yuantu/memory.md` + 用户级 `~/.yuantu/memory.md`），SQLite 不再写记忆。
- **知识库**：独立的 `~/.yuantu/knowledge.sqlite`（FTS5），只索引工作区内 UTF-8 文本/代码（30 种扩展名），每工作区最多 64 个文档；排序为标题命中 → bm25（标题列权重 4）→ 记忆优先 → 更新时间。
- **项目指令**：每次运行重新加载，按 `AGENTS.override.md` → `AGENTS.md` → `CLAUDE.md` 取第一个存在的，按根到目标合并、越近优先级越高；渲染预算 64 KB，**从最靠近目标的文件往外分配**，放不下的截断并点名。
- **Skills**：`.agents/skills/<name>/SKILL.md` 或 `.yuantu/skills/<name>/SKILL.md`（后者优先），每个 ≤32 KB、最多 64 个；技能指引不能改变运行时权限。
- **声明式扩展**：`.yuantu/extensions/*.json` 只声明命令，注册为 `ext_<name>`，不自动导入项目 JS。
- **外部钩子桥**：`.claude/settings.json` / `.yuantu/hooks.json` 被读成管线里的普通钩子；退出码 0 放行、2 拒绝、其他非零是「钩子坏了」只记录不否决；`permissionDecision: 'ask'` 映射为拒绝。JS 钩子必须由人显式指定模块路径，且解析后位于工作区内会被拒绝（防止克隆仓库即执行）。

### 5.9 集成能力

| 集成       | 实现位置                                | 当前边界                                                                                                                                               |
| ---------- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| LSP        | `packages/lsp`                          | 4 种内置语言服务器；先工作区本地包、再 `.bin`、再 PATH；推送式诊断；服务器不自动重启、无空闲回收；`WorkspaceEdit` 中的建/改名/删文件类资源操作整份拒绝 |
| MCP        | `packages/mcp`                          | stdio/http/sse + OAuth 2.1；HTTPS 或回环；无命令/域名白名单；stdio 传输要求 host 沙箱；工具目录只按服务器通知重读                                      |
| Office     | `packages/office`                       | DOCX/XLSX/PPTX；DOCX/PPTX 的 PDF 预览依赖本机 Office，可选 LibreOffice；拒绝旧格式                                                                     |
| 搜索       | `packages/search` + `tools/repo-map.ts` | 符号索引独立数据库（`.yuantu/search/`）；可选固定版本 ripgrep（按锁校验 SHA-256），不可用则回退内置流式扫描，不回退 host                               |
| 浏览器     | `packages/tools/browser.ts`             | 可选 Playwright/Chromium，未安装时明确报错并给安装命令                                                                                                 |
| 工作流     | `packages/core/workflow.ts`             | 独立 Node 进程运行编排脚本，工具 RPC 经 catalog 校验与原有审批                                                                                         |
| Python SDK | sdk/python（已移出主干）                | 标准库实现的 Host JSONL 客户端（240 行），便于非 Node 嵌入方                                                                                           |

### 5.10 载体层与桌面壳

- `packages/carrier/service.ts`（1,311 行）是「面向任何界面层的客户端状态机」：回答「界面该看到什么」，所有答案来自 Host；包内禁止出现 Electron/DOM/`apps/` 引用（由 `tests/carrier.test.ts` 从源码文本钉住）。
- `packages/client/session-controller.ts`（1,560 行）持有快照、增量通道与命令去重；`host-transport.ts` 是 JSONL 传输缝隙。
- `apps/desktop/main.ts`（1,195 行）负责窗口、单实例锁、设置存储、IPC 与 Host 子进程生命周期；`preload.ts` 只有 49 行，用 `contextBridge` 暴露 10 个 invoke 通道 + 5 个订阅通道（快照、消息增量、子代理增量、统计增量、权限预设）。
- 窗口 `contextIsolation: true`、`sandbox: true`、`nodeIntegration: false`；拒绝所有窗口打开、导航、权限请求；外链只走系统浏览器且只接受无凭据 http/https；每个 IPC handler 先 `assertSender` 校验 sender 是主框架且 URL 是受信任页面。
- 渲染层无框架、无状态库：一份 `CarrierSnapshot` + 增量，按区块 key 做差量，locale 进 key；对话区只画对话（机器写给模型的 `<runtime-context>` 快照不渲染为消息）。
- i18n：`apps/desktop/i18n.ts`（1,264 行）是中英唯一字典，主进程与渲染层共用；`i18n:check` 用静态规则扫描主进程模块，真窗口冒烟用 DOM 遍历验证渲染层。

### 5.11 Host JSON-RPC

`apps/agent-host` 把内核包成一组域化方法（生成事实：**58 个**）：

| 域        | 方法（概览）                                                                                       |
| --------- | -------------------------------------------------------------------------------------------------- |
| 控制面    | `host.info`、`runtime.ready`、`sandbox.set`、`permission.update`、`invariants.list`                |
| 会话      | `session.create/list/rename/delete/get/audit/events`                                               |
| 运行      | `run.start/cancel/enqueue`、`run.queue.get/clear`、`context.compact`                               |
| 审批/提问 | `approval.respond`、`question.respond`                                                             |
| 计划      | `plan.get/approve/reject`                                                                          |
| 任务      | `task.create/get/list/update/attempts/steps/approval.respond/trigger/propose/confirm/verify/retry` |
| 后台命令  | `background.list/state/policy/poll/stop/clear`                                                     |
| 资源/文件 | `resources.list`、`files.list/read`                                                                |
| 变更      | `changes.list/undo`                                                                                |
| 工作区    | `workspaces.get/orphaned`、`workspace.results/apply/archive/restore/remove`                        |
| 会话附属  | `todos.get`、`deliverables.get`、`completion.current`、`subagents.list`、`goal.get`                |

传输语义：报文只有四种形状（请求/成功/失败/事件）+ 无 id 的 error；请求 id 必须非空字符串且不得重复；帧上限 16 MiB，镜像/握手另有 4 KiB 与 5 秒上限；TCP 只允许 IPv4 回环且必须 `YUANTU_HOST_TOKEN`；**同一时刻只接受一个连接**。`apps/agent-host/dispatch.ts` 用 `Map` 而不是对象查表，避免 `constructor`/`toString` 命中 `Object.prototype` 而应答错误的东西——这是「按名字查表」在该层的一个真实陷阱。

---

## 6. 能力清单（可核验数字）

| 指标                        | 值                    | 出处                                             |
| --------------------------- | --------------------- | ------------------------------------------------ |
| 工具（空工作区，全部）      | 67 个 / 36.6 KB       | `createTools().specs()`                          |
| 工具（只读运行）            | 34 个 / 18.2 KB       | `specs({ readOnly: true })`                      |
| 工具（折叠为 `run_code`）   | 1 个 / 10.6 KB        | `YUANTU_TOOL_MODE=ptc`                           |
| `explore` 白名单条目        | 24                    | `EXPLORE_TOOLS`                                  |
| 会话 schema 版本            | v30                   | `packages/storage/session-schema.ts`             |
| 持久事件类型 / 实时事件类型 | 50 / 46               | `SESSION_EVENT_TYPES`、`AGENT_EVENT_TYPES`       |
| Host JSON-RPC 方法          | 58                    | `HostMethods`（`packages/protocol/rpc.ts`）      |
| CLI 任务型命令 / 维护命令   | 25（5 个需凭据）/ 4   | `apps/shared/cli-commands.ts`                    |
| 桌面冒烟套件                | 8                     | `package.json` 的 `smoke:desktop`                |
| 行为测试文件                | 249                   | `tests/*.test.ts`                                |
| 整轮快照场景                | 4                     | `tests/snapshots/*.json`                         |
| 注册的设置变量              | 67 个 `YUANTU_*` 名字 | `packages/protocol/settings.ts` 的 `ENVIRONMENT` |

能力面按领域归纳：

1. **代码理解与修改**：文件读写/搜索/仓库地图/符号索引/精确编辑（唯一匹配、写前观察、写后校验、诊断附注）。
2. **命令与终端**：前台命令（真实退出码）、受管后台命令、伪终端（REPL/调试器/interactive rebase）、验证命令发现与执行、作业控制面。
3. **版本控制**：只读 Git（status/diff/log/branches/worktrees）+ 受控写入（worktree 创建、stage、commit）；刻意不提供 push/amend/rebase/reset --hard。
4. **网络与浏览器**：搜索、抓取、无头浏览器交互与截图；内容一律视为不可信数据。
5. **语言服务**：启动/诊断/定义/引用/悬停/符号/重命名/代码操作，跨文件原子写入。
6. **Office 与交付**：DOCX/XLSX/PPTX 读写、预览、交付校验与 `present`。
7. **记忆与知识**：markdown 记忆 + FTS5 文档索引 + 技能。
8. **协作**：子代理委派/驻留/追问、工作区隔离与审批合入、持久任务、目标续跑、计划模式。
9. **扩展**：MCP、声明式扩展、外部钩子桥、`run_code`/workflow 程序化编排。

---

## 7. 构建、打包与发布

`npm run build` 的顺序本身就是一张依赖图：

```text
clean-paused-builds → tsc -p tsconfig.build.json → copy-sandbox-assets
  → build-program-runner → build-desktop
```

- `scripts/build-desktop.mjs` 用 esbuild 把主进程/preload/渲染层打成 CommonJS，配合 `commonjs-module-url.mjs` 解决 `import.meta.url` 在 CJS 中的等价物（有专门的回归测试）。
- 桌面包：electron-builder，`asar: false`（允许沙箱运行器与运行时直接落盘）、`extraResources` 放**固定 Node 运行时**与**已核验的 ripgrep 资产**；`beforePack`/`afterPack` 会校验运行时来源与包内容。
- Windows 有两条发行线：
  - 常规线 `package:windows`：构建 → 校验 → 打包 → 写发布清单。
  - 受保护线 `package:windows:protected`：强制代码签名、按机器安装、固定安装目录，并在签名后核对运行时与签名者；需要显式环境变量（`WINDOWS_SANDBOX_PROTECTED_RELEASE`、证书 SHA1、时间戳 URL、已签名候选运行时）。
- Windows 运行时来源由 `build/windows-runtime.lock.json` 固定，构建脚本区分 `diagnostic` 与 `production` profile；诊断候选不能作为正式发行依据。
- macOS：`prepare-macos-package` 校验架构一致性与依赖，`hardenedRuntime` + notarize，签名/公证材料来自环境。

发布链路的成熟度分层很清楚：**构建与包内容校验是自动的；签名、安装、真机隔离验收是人工门禁**，README 与脚本注释都这么写。

---

## 8. 测试与质量门禁

### 8.1 聚合入口

`npm run check` = `format:check → docs:check → references:check → cycles:check → i18n:check → typecheck → test:isolation:check → test → build → smoke:client`；`check:release` 再加 `smoke:desktop`。CI 的 `check` job 直接跑 `npm run check`，因此新增门禁必须挂到这个入口才有意义（README 与 `ci.yml` 注释都强调这一点）。

### 8.2 测试平台（本项目的特色）

- **每文件独进程**：`scripts/test-scheduler.mjs` 为每个测试文件 spawn 一个 `node --test --test-concurrency=1`，独立 tmp/home/state/cache/artifacts；cwd 保持仓库根且只读。
- **资源标签与串行组**：文件头 `// @test-serial <resource>: <reason>` 声明真实共享资源（windows-sandbox、machine-lease、real-pty、desktop-ui、os-credentials），串行组在并行池**完全结束后**独占执行；跨机器还有文件锁（`FOUNDRY_TEST_MACHINE_LOCK_ROOT`）。
- **度量而不是猜测**：自带 reporter 写 NDJSON（逐用例/逐文件/阶段汇总），运行器要求**终态记录**，报告缺失即失败；`--timings` 合并成一份可分析的产物。
- **耗时历史驱动派发**：成功且完整的全量运行把每文件耗时写 `.scratch/cache/test-durations-<os>-<arch>-node<major>.json`，下次按耗时降序派发；失败/取消/过滤运行不更新历史。
- **探针与清理**：Node 的 fs/net/SQLite 探针 + 子进程生命周期登记；进程未清理干净也算失败（`cleanup.clean === false`）。
- **隔离 lint**：`scripts/check-test-isolation.mjs` 静态检查测试入口与 helper 是否遵守私有目录/端口/`process.chdir` 规则。
- **覆盖率**：`npm run coverage` 保留每个 worker 的原始 V8 报告再合并，全套下限行 90% / 分支 75% / 函数 85%，依赖 Node 24 内部覆盖率 API。
- **确定性基准**：`npm run bench:check` 的阈值是结构量（schema 字节、发布次数、每消息记录数）或运行内比值，不用机器相关绝对耗时。
- **文档门禁**：`docs:check` 计算 README 数字与「曾经为真、现在不再为真」的说法；`references:check` 校验 README/`docs/`/workflows/`package.json` 里的仓库路径与锚点；`i18n:check` 校验主进程人读文案必须进字典。

### 8.3 规模与运行画像

- 249 个行为测试文件、16 个冒烟文件；默认并发 `min(8, availableParallelism())`，默认 `--schedule=partitioned`（并行池 + 串行池）。
- 本轮实测（8 并发，Ryzen 9 4900HS / 8C16T / 16 GB，Node 24.19.0）的完整数据、分布与瓶颈见《全量测试耗时统计》。

---

## 9. 依赖与耦合现状

- 运行时依赖只有 14 个（`@agentclientprotocol/sdk`、`@lydell/node-pty`、`@modelcontextprotocol/sdk`、`@napi-rs/keyring`、`ajv`、`diff`、`highlight.js`、`jszip`、`mammoth`、`marked`、`pdfjs-dist`、`typescript`、`xlsx`、`zod`）。`typescript` 进运行时依赖是因为 `packages/tools/repo-map.ts` 与测试选择器需要解析源码。
- `xlsx` 来自 `https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz`（lockfile 记录了完整性摘要），不是 npm registry；这是供应链上唯一非 registry 依赖。
- 包级存在 8 组双向值导入（见 4.1），文件级值导入环为 0；`npm run cycles:check` 把「文件级环」定为 0 并解释为什么不按包对判定（两个方向的边可能连的是不同文件，且多数是类型导入）。
- 端口/路径/协议契约集中在 `packages/protocol`，但 `process.env.YUANTU_*` 仍有 5 处直接读取（`packages/knowledge/store.ts`、`memory.ts`、`office/preview.ts`、`tools/index.ts` 两处），值都在 `ENVIRONMENT` 表里登记，只是没走 `parseSetting()`。这类旁路不会造成取值不一致，但会让「添加一个设置」的路径不唯一。

---

## 10. 架构评价

### 优势

1. **单一真源做得彻底**：协议类型、设置表、限额默认值、工具 schema、CLI 帮助、文档数字都由代码生成或校验，「文档与代码各说一个数字」被门禁挡住。
2. **可验证性优先**：管线不变量、运行时不变式、日志三表一致性检查、测试隔离探针、报告终态要求——这些机制的共同点是「不依赖某条测试路径被写到」。
3. **安全边界表述诚实**：host 不是沙箱、Windows 是部分写入边界、AppContainer 未启用、`verify_file_delivery` 只验结构——文档把这些写成已知边界而不是隐含假设。
4. **恢复语义完整**：事件日志 + 租约 + 检查点 + 迁移备份 + 撤销冲突三态，崩溃/中断/迁移都有明确收敛路径。
5. **载体可替换**：`CarrierService` 与渲染层解耦，Web 复用同一渲染层只换桥；Python SDK 证明 Host 协议可以被非 Node 客户端消费。

### 风险与代价

1. **复杂度集中在少数巨型文件**：`subagents.ts` 1,804 行、`session-controller.ts` 1,560 行、`agent.ts` 1,507 行、`carrier/service.ts` 1,311 行。它们各自有清晰职责，但单文件承载了过多分支，改动时的回归面大。
2. **测试成本高**：源码与测试近 1:1，全量套件在本机需要数分钟（见耗时文档），且单个偶发失败会让默认运行提前停止（`continueOnFailure=false`）。
3. **产品收窄留下的「半开」表面**：MCP 管理、CLI、Web、备份 UI 停了，但代码、IPC、测试仍在；`DailyBackups.tick()` 只有测试调用（见问题清单）。恢复成本低，但当下是维护负担。
4. **包级耦合**：8 组双向导入意味着这些包无法单独版本化/搬进程；若未来要做真正的外置工具进程，需要先拆环。
5. **平台验证不对称**：Windows 是主战场（沙箱、安装、桌面冒烟），macOS 有 CI job 但签名/公证仍需人工，Linux 只跑 host 契约。
6. **文档记录被清空**：`HEAD` 删除了全部 `docs/` 下的架构评估与缺陷记录（见问题清单），历史决策只能从 git 历史回收。

---

## 11. 关键文件索引

| 主题     | 入口文件                                                                                                 |
| -------- | -------------------------------------------------------------------------------------------------------- |
| 内核装配 | `apps/shared/runtime.ts`                                                                                 |
| 内核循环 | `packages/core/agent.ts`、`packages/core/run-request.ts`、`packages/core/run-tools.ts`                   |
| 工具目录 | `packages/catalog/index.ts`                                                                              |
| 执行管线 | `packages/tools/pipeline.ts`、`packages/tools/registry.ts`、`packages/tools/dispatch.ts`                 |
| 沙箱     | `packages/tools/sandbox.ts`、`sandbox-windows.ts`、`sandbox-seatbelt.ts`、`sandbox-appcontainer.ts`      |
| 存储     | `packages/storage/sqlite.ts`、`packages/storage/events.ts`、`packages/storage/session-current-schema.ts` |
| 协议     | `packages/protocol/index.ts`、`packages/protocol/rpc.ts`、`packages/protocol/settings.ts`                |
| Host     | `apps/agent-host/main.ts`、`apps/agent-host/dispatch.ts`                                                 |
| 载体     | `packages/carrier/service.ts`、`packages/client/session-controller.ts`                                   |
| 桌面     | `apps/desktop/main.ts`、`apps/desktop/preload.ts`、`apps/desktop/renderer.ts`                            |
| 测试平台 | `scripts/run-tests.mjs`、`scripts/test-scheduler.mjs`、`scripts/test-resource-policy.ts`                 |
| 文档门禁 | `scripts/docs-facts.mjs`、`scripts/check-references.mjs`、`scripts/i18n-gate.mjs`                        |
| 产品范围 | `packages/protocol/product-scope.ts`                                                                     |
