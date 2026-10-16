# YuanTu-Foundry 架构（2026-10-16 快照）

**快照时间：2026-10-16 09:52（+0800）** · HEAD `27bb603` · 工作树状态：**未提交**（写作期间 115 → 118 个文件已修改、34 → 38 个未跟踪，仍在变化）

> **时效性前提。** 快照期间工作树**仍有其他写入者**（本目录的 [问题清单](unfinished-issues-by-priority-2026-10-16.md) 于 09:48 被改写，`docs/` 下另有 09:44–09:48 的新记录）。本文档描述的是**结构**：分层、拓扑、数据流、接缝与边界——这些不会因为一次修复而改变。**状态**（哪条缺陷仍开、哪次回归是绿的）不在这里，见 [问题清单](unfinished-issues-by-priority-2026-10-16.md)。

## 0. 怎么读这份文档

| 你想知道                                       | 看哪里                                                                           |
| ---------------------------------------------- | -------------------------------------------------------------------------------- |
| 一次运行的完整数据流与装配点                   | 本文档 §4、§5，以及 [README 架构一节](../README.md#architecture)                 |
| 工具目录、事件类型、设置项等**逐项清单**       | [README](../README.md#tools)（数字由代码算出，见[生成事实](../README.md#facts)） |
| 当前仍开的缺陷、优先级与证据                   | [问题清单](unfinished-issues-by-priority-2026-10-16.md)                          |
| 已知边界（沙箱、Office、LSP、MCP、检索的边界） | [README 已知边界](../README.md#boundaries)                                       |

三条约定：

1. **能由代码算出的数字不在这里重写。** 工具数、schema 体积、事件类型数、Host 方法数、测试规模一律以 [README 生成事实块](../README.md#facts)为准（`npm.cmd run docs:check` 会在不一致时失败）。本文档只写它算不出的东西：结构、依赖、顺序与边界。
2. **测量值带时间。** 凡本文档自测的数字（行数、导入边、白名单命中），都注明测量时刻；工作树在动，隔一天重测会有出入。
3. **结构风险 ≠ 缺陷清单。** §12 只登记**结构性**问题（分层、体量、状态归属、双实现），逐条缺陷与优先级不重复登记。

## 1. 定位与三条主轴

YuanTu-Foundry 是一个独立实现的编程 Agent 内核，当前交付形态是 Windows/macOS Electron 桌面客户端：桌面自持一个长驻 Agent Host 子进程，Host 在进程内驱动内核。

三条主轴决定了这个系统的形状：

1. **单一真源。** 每个会话一个 SQLite 库，`session_events` 是权威记录；模型看到的 transcript、界面看到的会话状态、任务与目标状态，全部由日志 fold 得出。写穿表与检查点只是缓存，并且有**运行时**不变量盯着三者一致（[storage/invariants.ts](../packages/storage/invariants.ts#L31-L57)）。
2. **窄接缝。** 模型层是 `complete(request) → ModelResponse` 一个方法（[protocol/index.ts](../packages/protocol/index.ts#L232-L234)）；工具层是一个注册表加一条九阶段管线（[protocol/tool-pipeline.ts](../packages/protocol/tool-pipeline.ts#L2-L21)）；界面层是一套受校验的命令词表、一份快照与四条增量通道（[carrier/contract.ts](../packages/carrier/contract.ts#L49-L80)）；宿主是一张 58 方法的类型化 JSON-RPC 表（[protocol/rpc.ts](../packages/protocol/rpc.ts#L94)）。
3. **可验证的平台边界。** 沙箱是可注册后端（`host`/`windows`/`seatbelt`/`native`），每个后端必须先用功能探针**自证**可用才发执行计划；强制不了所声明的策略就拒绝执行，**绝不回退 host**（[tools/sandbox-mode.ts](../packages/tools/sandbox-mode.ts#L16-L22)）。

## 2. 实测规模

2026-10-16 09:45 前后实测（`packages/` 与 `apps/` 下的 `.ts`/`.mjs`，不含测试、`dist`、`node_modules` 与 Rust `target/`）：

| 维度           | 数值                                                 | 备注                                                                     |
| -------------- | ---------------------------------------------------- | ------------------------------------------------------------------------ |
| 源码           | 338 个文件 / 91,687 行                               | core 18.1k、tools 14.4k、desktop 14.3k、storage 9.8k、protocol 6.1k 领先 |
| 行为测试       | 233 个 `tests/*.test.ts` / 88,383 行（≈1:1 于源码）  | 另有 16 个冒烟文件 / 9,407 行与 4 个整轮快照场景                         |
| 巨型模块       | 21 个文件 ≥800 行，占全部源码行数 26%                | 最大 `packages/core/subagents.ts` 1810 行                                |
| 工具面         | 61 个（无终端管理器）/ 67 个（含 6 个 `terminal_*`） | 只读运行 32 / 34；6 个终端工具中 4 个声明 `command` 权限                 |
| 会话数据库     | schema v30，25 张表 + 1 个 FTS5 虚拟表               | [session-schema.ts](../packages/storage/session-schema.ts#L405-L431)     |
| 内置投影       | 10 个                                                | [projections.ts](../packages/storage/projections.ts#L672-L683)           |
| 导入环         | 338 文件 / 850 条值导入边 / **0 环**                 | 本次 `npm.cmd run cycles:check`；边数随工作树变化                        |
| 并行测试白名单 | 16 条记录，其中 10 条哈希仍匹配、**6 条已过期**      | 过期条目自动退回串行执行                                                 |

上表是**该时刻的一张快照**，不是约定：写作期间另有写入者工作，行为测试文件数在 09:50 已增至 234。凡能由代码算出的计数，实时值一律以 [生成事实块](../README.md#facts)为准（`docs:check` 负责它与之相符）。

## 3. 分层与真实依赖

### 3.1 包级依赖矩阵（实测 import 站点，值/类型分开计）

```text
packages/core       -> protocol 28v/62t  tools 11v/12t  storage  3v/26t  workspaces 3v/6t  resources 2v/1t  knowledge 1v
packages/tools      -> protocol 16v/38t  search  8v/2t  resources 5v/1t  core 3v  lsp 2v  office/knowledge/mcp 各 1v
packages/storage    -> protocol 17v/35t  core    8v/1t  tools 0v/2t
packages/protocol   -> core/resources/tools：**全部为 type-only**（值依赖 0）
packages/providers  -> protocol 14v/7t（无其他内部依赖）
packages/carrier    -> core 4v/1t  client 2v/2t  protocol 1v/6t  tools 1v/2t  providers 1v
packages/client     -> protocol 9v/10t  core 1v/2t  storage 0v/1t
packages/workspaces -> core 4v  protocol 2v/1t  tools 1v  storage 0v/2t
apps/agent-host     -> protocol 20v/14t  core 18v/7t  shared 14v/2t  tools 14v/2t  workspaces 5v  storage 1v/4t …
apps/desktop        -> protocol 13v/20t  carrier 3v/19t  core 6v/1t  tools 6v/1t  providers 2v/3t …
```

值得单独记下的两点：

- **`protocol` 只被类型依赖，自己也只做类型依赖。** 它是类型真源而不是依赖底层，代价是类型层已反向耦合 `core`/`resources`/`tools`/`storage`/`workspaces`（[rpc.ts](../packages/protocol/rpc.ts#L2-L7)），与它自己“`protocol` 与 `storage` 不能依赖 `core`”的注释相矛盾，也使该包无法独立发布。
- **`tools/index.ts` 是兄弟包组合根**，把 office、knowledge、resources、search、mcp、lsp 的工具装配进同一张表——有意的依赖倒置，重建爆炸半径也在这里。

### 3.2 “无环”的准确含义

`cycles:check` 报 0 环，但包级存在 **13 对互相引用，其中 7 对含值导入**（`core`↔`storage`、`core`↔`tools`、`core`↔`workspaces`、`tools`↔`knowledge`/`lsp`/`mcp`/`office`/`resources`）。两者同时为真，是因为互引落在**不同的文件对**上：`storage` 从 `core` 取的只是叶子工具（`redactSecrets`、`task-spec`/`task-trigger` 的规范化、`workspace-paths` 的路径判等），而 `core` 从 `storage` 取的是 `SessionStore`。

因此这个项目的实际分层规则是：**文件级无环 + 包级强耦合**。它的收益是值依赖图可拓扑排序、包可单独测试；代价是改一个 `core` 叶子工具会同时波及 storage/tools/workspaces 的编译与测试面。

## 4. 运行时拓扑

```text
helper node（scripts/start-desktop.mjs）
  └─ Electron 主进程（apps/desktop/main.ts）
        │  ←IPC / contextBridge(preload)→  渲染层（renderer*.ts，24 个模块注册进 slot registry）
        │  createService() → CarrierService（packages/carrier，无 DOM、无 Electron）
        │
        └─ spawn(真实 Node, apps/agent-host/main.js)  ⇄  JSONL over stdio  ⇄  AgentHostClient（packages/client）
                 │
                 ├─ packages/core 的 Agent 循环（请求模型 → 执行工具 → 事件落盘）
                 ├─ packages/{providers,tools,storage,workspaces,search,knowledge,lsp,mcp,office}
                 ├─ run_code / workflow 的 guest（独立 Node 进程 + Node 权限模型）
                 ├─ PTY 终端、后台命令 worker
                 └─ OS 沙箱子进程（Windows 受限令牌 / macOS Seatbelt）

可选第三态：Host 在字面量 IPv4 回环上监听，首帧 host.info 带 token 并以 timingSafeEqual 比较，一次只接受一个连接
Web 载体：apps/web 自建 Host，页面经自研 RFC6455 子集 WebSocket 连接，复用 desktop 的渲染层
```

四个必须记住的形态事实：

1. **桌面自持一个 Host**，用**真实 Node**（打包后是 `resources/runtime/node.exe`）而不是 Electron 进程再拉起一个界面（[host-transport.ts](../packages/client/host-transport.ts#L224-L237)、[install-paths.ts](../apps/desktop/install-paths.ts#L13-L37)）。
2. **`apps/web` 复用渲染层靠运行时全局赋值**，不是打包别名：页面先把浏览器桥赋给 `window.yuantu`，随后动态 import 桌面渲染层（[web/page.ts](../apps/web/page.ts#L19-L20)）；而该全局的类型契约反过来声明在渲染层里（[desktop/renderer.ts](../apps/desktop/renderer.ts#L32-L36)）。
3. **一个 Host = 一个工作区 = 一条 carrier 连接 = 一个活跃 run**，这是全系统的主要互斥不变量。
4. **载体不知道底下是什么。** `CarrierService` 只回答“界面该看到什么”，答案全部来自 Host 应答；渲染层不知道背后是 Electron IPC 还是 WebSocket。

## 5. 一次运行的数据流

### 5.1 装配与循环

唯一装配点是 `createAgent()`（[apps/shared/runtime.ts](../apps/shared/runtime.ts#L238-L388)）：读 provider 配置 → 建 provider → 解析容量（声明 → 随包目录 → 端点发现 → 应用默认）→ 建 `Agent` 并注入工具注册表、审批与提问回调、权限策略 getter、子代理开关与并发、工作区管理器与结果服务、全部预算参数。内核 `Agent.run()`（[core/agent.ts](../packages/core/agent.ts#L238)）随后按轮推进：

```text
载入 instructions / skills → 目标准入 → announceSnapshots（把变化的 outline、memory、skills、任务与完成契约写进对话）
   ↓ 每轮重读 permissionPolicy / executionPolicy：变了就重建 system prompt 与工具 schema
请求前 buildCatalog()：只读运行丢弃一切声明权限的工具，deny-all 规则再剪一次
   ↓
requestRunRound() → provider.complete()：重试只在 step 边界发生，且要求尚未向用户展示任何内容
   ↓ 溢出恢复：token 校准 → 预测 → 压缩（固定八节摘要）→ 重发一次
createToolBatch()：按 isConcurrencySafe 分组、有界并发、结果严格保持模型书写顺序
   ↓ 九阶段管线（见 §7.2）
落盘：事件 + 文件变更日志 + 效果日志 + 每轮 context envelope（prompt/工具哈希，去重）
   ↓
日志投影（10 个内置投影）→ 快照 + 四条增量通道 → 载体渲染
```

循环本身**不设轮数上限**（[core/agent.ts](../packages/core/agent.ts#L927)）：一次运行在模型不再请求工具、被取消、被端点拒绝或触到自身天花板（输出上限、窗口、工具墙钟）时结束。真正有轮数预算的是目标（`GOAL_DEFAULTS.maxGoalRounds`），它只数续跑轮，且该上限不可被工具改写。

### 5.2 六个定形的机制

| 机制               | 它保证什么                                                                                                               | 位置                                                                                             |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| 只读是一个标志     | 计划模式、只读子代理、桌面“仅可查看”共用同一个 `readOnly`；`exit_plan_mode` 是唯一在运行中翻转它的写入者，且只在人批准后 | [agent.ts:280](../packages/core/agent.ts#L280)、[:963](../packages/core/agent.ts#L963-L977)      |
| 缓存前缀稳定优先   | 变化的运行时状态写进**对话**而不是系统提示，并做快照等值判断，避免每轮打掉可缓存前缀                                     | [agent.ts](../packages/core/agent.ts#L697-L765)                                                  |
| 压缩是一个三数策略 | 0.8 阈值、64K headroom、保留尾部 16%，压缩重试一次、溢出重试一次；三级瘦身 `shrink` → `prune` → `spill` 落盘             | [compaction-policy.ts](../packages/core/compaction-policy.ts#L20-L40)                            |
| 失败有名字         | 12 个失败码 → `limited`（任务太大）/`failed`（出问题）；重试表是穷尽 `Record`，新增码必须表态                            | [failure.ts](../packages/protocol/failure.ts)、[retry.ts](../packages/protocol/retry.ts#L24-L37) |
| 委派有独立目录     | 一次委派冻结一个基线快照，写型子代理各得一个工作树，结果以树与收据导入父会话                                             | [protocol/workspaces.ts](../packages/protocol/workspaces.ts#L94-L133)                            |
| 完成靠证据而非散文 | 完成契约的步骤证据取自子会话的工具执行记录，不取模型自述；定义变化会被识别为漂移                                         | [completion-contract.ts](../packages/core/completion-contract.ts#L263-L316)                      |

## 6. 内核子系统

- **上下文预算。** 窗口 → 减去本次请求的输出预留 → 消息预算 → 再减 headroom → 阈值。压缩摘要固定八节（Objective、Decisions and constraints、Work completed、Current state、Open questions、Next steps、Uncertainty、Attachments），因为摘要是被反复合并的，自由散文每过一遍就会丢一点（[context.ts](../packages/core/context.ts#L33-L68)）。token 估计按路由校准（`calibration.ts`），并按部件观测。
- **委派与隔离。** 子代理默认只往下走一层，且不会比父运行活得更久；驻留子代理是显式选项，代价是每个常驻子代理自带语言服务器、后台命令与 MCP 连接。隔离工作区的状态机是封闭的（`preparing`→`ready`→`archiving`/`removing`→`archived`/`removed`），非法迁移由存储层拒绝而不是写入（[protocol/workspaces.ts](../packages/protocol/workspaces.ts#L61-L72)）。
- **任务、目标与计划。** 三者是同一套日志机制的不同投影：任务有尝试与步骤检查点，目标有轮数预算与“只能由人执行的动作”，计划有独立的提案/批准记录。计划阶段的工具集会随批准在**下一轮**重建，而不是在发起那一轮中途改变。

## 7. 工具与执行

### 7.1 目录与可见性

工具声明 = schema + 可选权限（`write`/`command`/`external`）+ 可选 `prepare`（产出审批描述与 diff）+ 可选并发安全声明。注册表的 `register`/`replace`/`remove`/`restrict` 都返回撤销句柄；`offers()` 同时决定“模型能否看见”与“调用能否执行”，因此隐藏只是礼貌，审批才是保证。只读运行、权限策略 deny-all、程序化调用（`run_code` 的目录）三者共用同一份过滤逻辑。

### 7.2 九阶段管线

```text
validate → pre-execute → guards → prepare → approval → execute → post-execute → finalize → result
```

顺序**逐调用校验**（[tools/pipeline.ts](../packages/tools/pipeline.ts#L73-L90)）：`execute` 之前必须有 `pre-execute` 与 `guards`；带权限的 `execute` 之前必须有 `approval`；`finalize` 之前必须有 `post-execute`。违反即抛出，先成为一个失败的**工具结果**，再作为 `tools.pipeline-stages` 不变量升级为失败的**运行**。

单调性是拆分的要点：`pre-execute` 与 `guards` **只能拒绝**——“扩展允许了它”这句话在这条管线里无法表达。审批通过后到真正执行前，还会重新读取一次生效策略；策略漂移则要求模型重新发起调用。

### 7.3 三层边界，不要混为一谈

| 层                | 它是什么                                                                            | 强制力与覆盖面                                                                                                          |
| ----------------- | ----------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Permission policy | `allow`/`ask`/`deny` 规则（按种类、工具名、参数），可判定“某工具永不可批”并据此隐藏 | 进程内，必须显式注入；声明式、可审查（[core/permissions.ts](../packages/core/permissions.ts#L51-L81)）                  |
| Execution policy  | `mode` + 文件效果 + 进程文件效果 + 网络效果                                         | 后端强制不了所声明的策略时**拒绝执行**，而不是降级（[protocol/execution.ts](../packages/protocol/execution.ts#L1-L20)） |
| OS 沙箱           | `host` / `windows` / `seatbelt`                                                     | 在已启用的后端里**只有 macOS Seatbelt 是内核级边界**；Windows 是部分写入边界（读与网络不设限）；`host` 无隔离           |

两个必须写下来的事实：

- **Windows 基础后端是部分写入边界。** 受限令牌加 Low 完整性限制的是**写**；读、网络，以及宿主预先授权给 Low/Everyone 的位置都在边界之外。严格只读与断网请求会被明确拒绝，而不是被假装满足。
- **AppContainer 增强后端在运行时不可达。** 沙箱注册表只登记 `host`/`windows`/`seatbelt`/`native`，模式解析器也不接受该名字（[sandbox.ts](../packages/tools/sandbox.ts#L152-L179)、[sandbox-mode.ts](../packages/tools/sandbox-mode.ts#L3)）；Rust 助手与 TS provider 仍在、仍被测试与打包脚本引用，就绪检查脚本还会显式上报它是否已成为公开模式。它因此是**两套 Windows 边界实现并存**：一套在跑，一套在等前置条件。

## 8. 模型协议层

三个内置协议在 `BUILTIN_PROTOCOLS` 单点声明，同一份常量同时喂给设置枚举与注册表，避免两处漂移（[protocol/index.ts](../packages/protocol/index.ts#L186-L195)）；宿主可注册第四种。差异都落在请求与响应的边缘，没有中间表示：

| 关注点   | Anthropic Messages                   | OpenAI Chat Completions            | OpenAI Responses                        |
| -------- | ------------------------------------ | ---------------------------------- | --------------------------------------- |
| 工具结果 | block 数组，图片可内嵌 `tool_result` | 只能纯文本，图片搬到后续 user 消息 | 原生支持 `input_image`                  |
| 连续性   | 回放整段消息                         | 回放整段消息                       | 靠 `providerState`（模型 + 端点双条件） |
| 推理强度 | 换算成 token 预算                    | 直接透传 level                     | 直接透传 level                          |
| 硬前提   | —                                    | 必须报用量，缺失即失败             | 必须回放加密推理项，否则失败            |

**重试不在适配器里**（[http.ts](../packages/providers/http.ts#L130-L138) 明写已移出）。它发生在 step 边界：按失败码判定可重试 → 从日志读回重试计数（进程崩溃不重置）→ 先记事件再等待 → 要求等待不超过 30 秒，且服务端的 `retry-after` 绝不被缩短。

容量解析四级并逐次说明来源：操作者声明 → 随包目录（只登记有证据、带核对日期的端点）→ 端点发现 → 应用默认；**未知的同端点兄弟模型不继承活跃模型的窗口**（[apps/shared/runtime.ts](../apps/shared/runtime.ts#L126-L178)）。

## 9. 存储与检索

- **日志与投影。** `session_events` 权威，`messages` 写穿，`messages_fts` 由触发器维护。检查点的版本是 **fold 源码的哈希**而不是全局整数，所以改了 fold 自动失效、忘记 bump 也不会错；任何可疑检查点一律整体回退到从 seq 0 重新折。
- **迁移与身份。** 版本走 `PRAGMA user_version`；**先备份再迁移，备份失败即中止**；读端拒绝更新版本的库，写端拒绝别人的库（身份靠 `application_marker` 行而非 `application_id`，因为驱动层的 pragma 不写文件头）。
- **所有权。** 会话租约与 run 行同事务写入；判活只看 pid，且**租约不随时间过期**——pid 复用会让会话一直被视为“正在运行”。
- **检索。** 符号索引是独立数据库 `.yuantu/search/`，与会话库分开；快速搜索用固定资产（入库锁文件记录 SHA-256，解析时拒绝符号链接、拒绝来自工作区的二进制），只服务“大小写敏感的字面量”查询，其余一律走内置流式扫描；扫描结果必须说明是否**完整**，零命中不等于不存在。
- **工作区隔离。** 冻结基线、按子任务分配目录、导入结果三步都先落盘再对外可见；结果导入被写成父会话自己的文件变更，因此撤销、统计与审计与父会话自己的编辑同路。

## 10. 界面层

| 层                 | 职责                                                                                | 备注                                                                                      |
| ------------------ | ----------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `packages/carrier` | 面向任何界面层的客户端状态机：命令词表、快照、四条增量通道（快照/正文/子代理/统计） | 包内不允许出现 Electron、DOM 或 `apps/` 引用，由测试从源码文本上钉住                      |
| `packages/client`  | 传输缝隙、JSONL 分帧、请求超时归口、会话状态机与重读                                | 重连不引入第二套投影：只做一次有界探测，发现落后就整体重读                                |
| `apps/agent-host`  | 长驻 RPC 服务端、调度器、审批策略、会话策略、后台唤醒                               | 方法表用 `Map` 而非对象字面量，避免原型链上的名字被当成方法                               |
| `apps/desktop`     | Electron 主进程、preload、渲染层与设置持久化                                        | 窗口 `contextIsolation` 开、`nodeIntegration` 关、沙箱开；所有 IPC 校验 sender 与来源框架 |
| `apps/web`         | 本机 Web 桥：静态页 + 单条 WebSocket + 一个 Host 子进程                             | 产品入口当前暂停，源码保留                                                                |

设置持久化的三档：模型密钥走系统钥匙串加密（后端不可用时拒绝写入，而不是降级为明文）、权限预设与界面设置各存一份 JSON、沙箱初始化状态单独记录。

## 11. 工程机制与门禁

这个项目把“文档不会腐烂”当成可执行的门禁，而不是纪律：

| 门禁                 | 它拒绝什么                                                                                                                 |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `docs:check`         | README 的生成事实块与设置表与代码不一致；任何活跃文档里出现**曾为真、现在不再为真**的说法                                  |
| `references:check`   | 文档、工作流与 npm 脚本里指向不存在的路径；Markdown 链接里的锚点在目标文件中不存在                                         |
| `i18n:check`         | 面向人的模块里出现未登记的中文；渲染层另有**真窗口 DOM 扫描**，切到英文后还能看见中文即失败                                |
| `cycles:check`       | 值导入成环                                                                                                                 |
| `typecheck` / `test` | 类型错误；行为回归与整轮快照                                                                                               |
| CI                   | ubuntu 跑契约、基准与覆盖率；windows 跑真实沙箱验收、Rust 助手回归与真窗口桌面冒烟；macos 跑 Seatbelt 内核探针与未签名打包 |

测试的组织方式也值得一提：默认串行；并行需要一份**逐输入哈希**审查过的白名单，源码一变条目自动失效退回串行。跳过必须写明环境原因，跳过不等于验收。

打包侧：应用自带一份固定的 Node 运行时与一份经过摘要校验的搜索二进制（都放在 `resources/` 下、由运行时按摘要核对后才执行），`asar` 关闭，打包前后各有布局与签名校验脚本。

## 12. 结构性风险

只登记**结构**问题；逐条缺陷与修复状态见 [问题清单](unfinished-issues-by-priority-2026-10-16.md)。

| #   | 结构性风险                                                                                 | 证据与影响                                                                                                                                                                             |
| --- | ------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S1  | **体量集中**：21 个文件 ≥800 行，占 26% 源码                                               | `subagents.ts` 1810、`session-controller.ts` 1567、`agent.ts` 1480、`carrier/service.ts` 1306、`desktop/main.ts` 1195。前四者是单类/单文件承担多职责；已有的 `run-*.ts` 拆分是现成范式 |
| S2  | **状态归属重叠**：“这个会话在哪个沙箱、什么权限”被桌面主进程、carrier 与客户端各持一份     | 沙箱与权限是**逐命令**生效的进程级事实，而会话级选择由调用方维护；两处不一致时的答案没有单一裁决者                                                                                     |
| S3  | **协议层类型反向耦合**：`protocol` 的 RPC 类型引用 core/resources/tools/storage/workspaces | 目前无运行时环，但 `core` 一旦引用 `rpc.ts` 即成真环；该包也无法独立发布                                                                                                               |
| S4  | **两套 Windows 边界实现并存**：AppContainer 不可达却与受限令牌后端争用同一把锁             | 崩溃后的人工恢复路径、打包脚本、就绪检查都在为它服务；读者容易把“已实现并测试”误读为“已启用”                                                                                           |
| S5  | **RPC 面没有参数模式**：58 个方法靠手写守卫，wire 与契约已出现自认的漂移                   | 类型只覆盖调用方，运行期只做结构检查；参数级回归必须逐个补                                                                                                                             |
| S6  | **测试并行化收益有限**：白名单 16 条，对全部 233+ 个测试文件，其中 6 条哈希已过期          | 并行组实际只覆盖很小一部分；审查成本使白名单难以扩张                                                                                                                                   |
| S7  | **工作树长期未提交**：HEAD 落后于整棵树的改动                                              | 任何失败都无法按提交二分定位，也无法回退——这既是流程问题，也让其它一切结论缺少基线                                                                                                     |

## 13. 复现命令

```powershell
npm.cmd run typecheck          # 类型
npm.cmd run cycles:check       # 值导入环
npm.cmd run docs:check         # README 生成事实与设置表
npm.cmd run references:check   # 文档路径与锚点
npm.cmd run i18n:check         # 面向人文案的语言门禁
npm.cmd test                   # 全量行为测试（串行，耗时长）
npm.cmd run test:partitioned -- --plan   # 只预览并行/串行分组，不执行
```

本文档写作时的可复现测量：包级依赖矩阵由一次遍历 `packages/`、`apps/` 下所有 `.ts`/`.mjs` 的相对 import 站点得出（区分 `import type`），脚本为一次性用途，未留在仓库里；行数与文件数按 `text.split('\n').length` 统计，含注释与末尾空行。

## 附录 A：包与规模（2026-10-16 实测）

| 单元                   | 文件 |  行数 | 职责一句话                                                 |
| ---------------------- | ---: | ----: | ---------------------------------------------------------- |
| `packages/core`        |   63 | 18109 | 内核：Agent 循环、上下文预算、子代理、任务/目标/计划、投影 |
| `packages/tools`       |   54 | 14430 | 工具目录与九阶段管线、沙箱后端、后台命令、终端、spill      |
| `apps/desktop`         |   64 | 14308 | Electron 主进程、preload、渲染层、设置与维护               |
| `packages/storage`     |   22 |  9834 | SQLite 会话日志、事件、投影检查点、租约、检索              |
| `packages/protocol`    |   33 |  6097 | 类型真源：消息/事件/RPC/设置表/失败码/限额                 |
| `apps/agent-host`      |   23 |  3921 | 长驻 Host：RPC 分发、调度器、审批与会话策略                |
| `packages/search`      |   10 |  3467 | 符号索引、快速搜索后端、内置扫描器                         |
| `packages/workspaces`  |    5 |  3332 | 冻结快照、隔离目录分配、结果导入                           |
| `packages/client`      |    7 |  2598 | 传输缝隙、JSONL RPC、会话状态机                            |
| `packages/lsp`         |    5 |  2518 | 语言服务器管理                                             |
| `packages/providers`   |   14 |  2394 | 三种模型协议适配、SSE、缓存、容量发现                      |
| `packages/carrier`     |    4 |  1930 | 载体契约与服务（命令词表 + 快照 + 四条增量通道）           |
| `packages/mcp`         |    4 |  1866 | MCP 客户端与 OAuth                                         |
| `apps/cli`             |    1 |  1286 | 一次性命令行（产品入口当前暂停）                           |
| `apps/web`             |    5 |  1121 | 本机 Web 桥（产品入口当前暂停）                            |
| `packages/office`      |    6 |  1113 | DOCX/XLSX/PPTX 读写与预览                                  |
| `packages/resources`   |    6 |  1015 | 项目指令、Skills、声明式扩展、外部钩子桥                   |
| `apps/shared`          |    4 |   857 | CLI 与 Host 共用的装配层（`createAgent` 所在）             |
| `packages/knowledge`   |    4 |   720 | markdown 记忆与文档索引                                    |
| `packages/maintenance` |    1 |   364 | 桌面升级                                                   |
| `packages/sdk`         |    2 |   299 | 对外 SDK（暂停）                                           |
| `apps/agent-acp`       |    1 |   108 | ACP 入口（暂停）                                           |

## 附录 B：本文档怎么维护

- **什么时候改**：分层、接缝、进程拓扑、数据流、边界含义发生变化时。一次缺陷修复、一次回归转绿**不需要**改这里。
- **不要抄进来的东西**：[README 生成事实块](../README.md#facts)里的计数（由 `docs:generate` 重写）、逐条缺陷（属于[问题清单](unfinished-issues-by-priority-2026-10-16.md)）、每日验证记录（属于本目录的日期记录）。
- **改完必须过的门禁**：`npm.cmd run format:check`、`npm.cmd run docs:check`、`npm.cmd run references:check`。文档里的每个路径与锚点都会被 `references:check` 解析；指向不存在文件的引用会让聚合门禁失败，这是有意设计。
