# YuanTu Agent 架构与能力评估（2026-10-14）

> 原审计与本次事实复核均在 2026-10-14 进行，`HEAD` 为 `27bb603`；当前工作树还包含未提交的可靠性修复及测试改动，不能把它等同于该提交的内容。
> 本文分别记录原审计日志、本次源码核对、本次复现和上一轮真实模型验证。历史行号仅供定位，以当前源码中的函数名为准；复核命令见 §10，原始裁决见 §9。

## 1. 摘要

当前证据支持以下结论：

1. **静态检查与构建通过，全量测试尚不能宣称全绿。** 原审计日志记录 2363 项：2248 通过、5 失败、110 跳过。上一轮修复后的关联回归为 359 项：357 通过、2 跳过、0 失败；这不是新的全量结果。本次重跑原失败项所在的四个文件，22 项中 18 通过、4 失败，macOS 打包测试的夹具问题已修复（§4）。
2. **本机工作区的完整性标签与脚本授权限制仍然存在。** 本次核实了根目录、Office 脚本、esbuild 和解包应用的 Low 标签，并重现临时目录写入拒绝及 Office/安装校验脚本授权错误。该证据不能替代 Office COM、安装后应用或其他机器上的验收，也不能据此默认改动外部管理的安全标签（§5）。
3. **原审计记录了 34 条跟踪项，而非本次逐项独立复现的 34 个代码缺陷。** 原严重度分布为 2 high、13 medium、19 low；其中包含条件风险、门禁缺口、有意设计边界及同一根因的不同表现。7 条 `R1-` 项缺少独立裁决文件，不能与有归档证据的条目混用同一确认级别。原撤销项中的异步观察记录问题还需保留限定结论（§6.5）。
4. **上一轮的完成状态与检索修复已有单独验证。** DeepSeek-V4.1-Flash 的 7 个合成场景通过，覆盖完成摘要持久化、停止钩子、外部文件改写、符号分页和不完整覆盖；并不证明本文其他跟踪项已修复，也不等同于 Electron 界面的真实模型端到端验收（§6.6）。

架构实测发现 **13 对包含类型导入的跨包双向引用**；排除纯类型导入后，顶层静态值导入的双向包对为 **8 对**。包级双向引用不等于文件级运行时循环，`protocol/rpc.ts` 的反向引用本身均为类型引用（§3.2）。

## 2. 审计方法与可复现性

| 手段                                                                 | 结果                                                                    |
| -------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| 静态门禁 `format:check`/`docs:check`/`references:check`/`i18n:check` | 上一轮修复后通过，本次文档修改后再核对                                  |
| `npm run typecheck`                                                  | 通过                                                                    |
| `npm run build`                                                      | 通过                                                                    |
| 原全量行为测试 `npm test`                                            | 2363 项：2248 通过 / 5 失败 / 110 跳过，耗时 1467.86 秒；日志仍在       |
| 上一轮关联回归 / 真实模型场景                                        | 357 通过、2 跳过、0 失败 / 7 场景通过                                   |
| 本次重跑原失败项所在四个文件                                         | 22 项：18 通过、4 失败，无跳过                                          |
| 本次源码规模与静态导入统计                                           | 318 个 `.ts/.mts`、88,703 行；含类型的双向包对 13，静态值导入双向包对 8 |
| 原分工审计归档                                                       | 7 份子系统报告、29 份裁决；代理数量无法由这些文件独立核实               |

归档中的裁决确实记录了反证、守卫检查和严重度调整；它们是可复核的原审计材料，不是当前状态的自动证明。本次根据源码及复现结果修正主文档，保留原报告，不改写其历史内容。原裁决的主要结果包括：

- 原裁决撤销了 3 项指控（§6.5）；其中 2 项反证清楚，异步观察记录项需保留不确定性；
- 多项发现的**归因被纠正**（结论对、机制错），例如"自截断输出不落盘"的真实缺陷在 `git.ts` 而不是
  被指控的 `registry.ts`（§6.2）；
- 多项严重度被下调，具体以对应裁决记录为准。

**证据局限**：7 条 `R1-` 项没有对应的原始报告和独立裁决文件。原作者称原因是工具输出截断，本次无法从归档独立证明该原因或补回丢失的复现输出。这些条目保留为原审计跟踪项，其本机复现与严重度描述应按来源理解，不能当成本次已重现的结论。其余报告与裁决文件见 §9。

## 3. 能力与架构再分析（实测）

### 3.1 规模

按当前工作树统计 `packages/` 与 `apps/` 下的 `.ts`/`.mts`；行数按 `text.split('\n').length` 计算，包含末尾空行，不含 `node_modules`、测试及构建产物：

| 区域                 | 文件 |   行数 | 区域                   | 文件 |  行数 |
| -------------------- | ---: | -----: | ---------------------- | ---: | ----: |
| `packages/core`      |   55 | 17,120 | `packages/storage`     |   17 | 9,270 |
| `packages/tools`     |   54 | 14,349 | `packages/protocol`    |   32 | 6,042 |
| `apps/desktop`       |   59 | 13,614 | `apps/agent-host`      |   23 | 3,636 |
| `packages/search`    |   10 |  3,436 | `packages/workspaces`  |    5 | 3,315 |
| `packages/client`    |    7 |  2,588 | `packages/lsp`         |    5 | 2,503 |
| `packages/providers` |   14 |  2,365 | `packages/carrier`     |    4 | 1,897 |
| `packages/mcp`       |    4 |  1,866 | `apps/cli`             |    1 | 1,265 |
| `apps/web`           |    5 |  1,118 | `packages/resources`   |    6 | 1,013 |
| `packages/office`    |    5 |    967 | `apps/shared`          |    4 |   857 |
| `packages/knowledge` |    4 |    720 | `packages/maintenance` |    1 |   355 |
| `packages/sdk`       |    2 |    299 | `apps/agent-acp`       |    1 |   108 |

合计 **318 个文件、88,703 行**；另有 **224 个顶层行为测试文件**。`scripts/` 顶层的 `.mjs`、`.ts`、`.ps1` 文件共 **41 个**；该数字按后缀计数，不表示所有文件都是门禁。

### 3.2 静态导入与跨包双向引用

使用 TypeScript AST 解析顶层相对路径 `import` 声明；每个源文件对每个外部包计一次，含类型导入，不计包内引用、动态 `import()`、`require()` 和 `export ... from`。该口径下 `packages/protocol` 被 **168 个文件**引用，`packages/core` 为 42、`packages/tools` 为 41、`packages/storage` 为 30、`packages/carrier` 为 22。

按同一口径，共有 **13 对包含类型导入的跨包双向引用**：

| 环路对                 | 双向引用文件数 | 环路对                   | 双向引用文件数 |
| ---------------------- | -------------- | ------------------------ | -------------- |
| `core` ↔ `protocol`    | 44 / 1         | `protocol` ↔ `tools`     | 1 / 34         |
| `core` ↔ `storage`     | 17 / 6         | `core` ↔ `workspaces`    | 5 / 4          |
| `core` ↔ `tools`       | 10 / 3         | `protocol` ↔ `resources` | 1 / 3          |
| `storage` ↔ `tools`    | 1 / 2          | `resources` ↔ `tools`    | 2 / 2          |
| `knowledge` ↔ `tools`  | 1 / 1          | `lsp` ↔ `tools`          | 4 / 1          |
| `mcp` ↔ `tools`        | 1 / 1          | `office` ↔ `tools`       | 2 / 1          |
| `tools` ↔ `workspaces` | 1 / 1          |                          |                |

排除 `import type` 及全部成员都是 `type` 的命名导入后，双向静态值导入包对为 **8 对**：`core↔storage`、`core↔tools`、`core↔workspaces`、`knowledge↔tools`、`lsp↔tools`、`mcp↔tools`、`office↔tools`、`resources↔tools`。包的两个方向可能连接不同文件，因此这些数字仍不能证明存在文件级 ESM 循环或循环初始化故障。

[packages/protocol/rpc.ts](../packages/protocol/rpc.ts) 对 core / resources / tools 的反向引用已经全部写成 **`import type`**，类型擦除后不形成运行时导入；原建议“把这里的运行时引用改成纯类型”没有适用对象。

已找到的明确包边界测试是 [tests/carrier.test.ts](../tests/carrier.test.ts)，它禁止 carrier 引用 Electron、应用壳与 DOM。原文所说的“例外清单必须匹配文件”属于 i18n 门禁，不能算作 carrier 导入边界测试的能力。本次检索未发现通用文件级循环依赖门禁；可进一步度量值导入的文件级强连通分量，再决定是否增加架构约束（§7.3）。

### 3.3 产品边界

[packages/protocol/product-scope.ts](../packages/protocol/product-scope.ts) 集中声明四个范围开关及入口断言；SDK 导出和 npm 入口还需核对 `package.json`：

```ts
export const PRODUCT_SCOPE = { mcpManagement: false, cli: false, web: false, acp: false } as const;
export function requireProductEntry(entry: 'cli' | 'web' | 'acp'): void;
```

即**当前交付面是 Windows/macOS 本地 Electron 客户端**；MCP 管理、CLI、Web、ACP 暂停但源码与测试
保留，对应入口在 `package.json` 的 `pausedEntrypoints` 中有记录。桌面内部的 Agent Host、客户端协议
与既有 MCP **工具调用**继续保留。对外 SDK 也通过 `package.json` 的空 `exports` 暂停；`pausedEntrypoints` 保存恢复信息，并非可用的公开入口。

### 3.4 核心能力（源码及原审计材料，不等同于逐功能实机验收）

**内核（`packages/core`）**

- `Agent` 拥有单次 `run()` 的轮次循环，默认不设固定轮次上限；存储禁止同一会话并发写运行。内核有 `step.started`/`step.finished` 配对及退出清理，相关测试覆盖正常、失败与取消；进程被强制终止后的未闭合状态由恢复逻辑处理，不能声称任何退出路径都即时闭合。
- 输入准先是持久的再是内存的：`enqueue` 先写 `input.queued` 再折叠；队列上限 16；同一会话的互斥由
  存储层的 `sessions.active_run` 活跃 owner pid 保证。
- 上下文每轮只构建一次，顺序固定：缩短旧工具结果 → 丢弃超长结果中段（纯内存、无 I/O）→ 压缩。压缩
  默认阈值为窗口的 0.8、请求自身输出预留之上再留 65,536 token、逐字保留消息预算的 16%、压缩重试 1 次、
  供应商溢出重试 1 次；**边界只落在完整 tool-call/result 组之后**，且"没缩小就拒绝压缩"。
- **重试只在步骤边界**：计数从持久日志读回（进程崩溃不重置额度），退避上限 30 秒，可重试失败码是闭表，
  无失败码的失败**从不重试**；服务端 cooldown 不被缩短，要求等待超过上限就直接放弃。
- 委派默认**关闭**：`enabled=false`、maxDepth=1、maxFanout=4、maxConcurrency=8、maxPerRun=8、超时
  600,000 ms；子代理不设轮次上限，改用 **10 分钟静默看门狗**；父运行 `finally` 里 `settle()` 中止未完成
  子代理并等待全部在飞 Promise。隔离用 git worktree：只读 `explore` 共享目录，可写 `general` 独占。
- 目标续跑有独立上限：`maxGoalRounds` 默认 256、上限 4096。`changeGoal` 接受 `blocked` 的条件是 `roundsStarted >= 3`，并未校验“同一阻断连续发生三轮”；原文把提示要求与代码条件混为一谈。
- 计划模式**由审批器强制**，不只是隐藏工具：只读运行中每个需要权限的调用都被拒绝**并记录为拒绝**；
  获批 `exit_plan_mode` 在下一个步骤边界翻转只读，并同时重建提示词、工具目录与审批器。

**工具与沙箱（`packages/tools`）**

- 每次运行新建一个 `ToolRegistry`；每次调用走
  validate → pre-execute → guards → prepare → approval → execute → post-execute → finalize → result，
  且 `ToolPipelineInvariant` **在运行时**校验顺序，乱序/重复即失败。钩子与守卫**只能拒绝、不能授权**。
- 输出上限 24,000 字符，溢出落盘到 `.yuantu/spill/<session>/`（目录 0700、文件 0600、8 MB 上限、
  每会话保留 50 个），并提示模型用 `read_file` 翻页。
- 沙箱是**能力声明式**的：每个后端声明 processFiles/network/pathKind/links，`requireExecutionCapabilities`
  在后端无法兑现时**执行前拒绝**，而不是静默降级。`docker`/`sbx` 已作为移除项拒绝；非 win32/darwin
  上一律抛 "no host fallback is allowed"。
- Windows：编译的 C# 启动器走 `CreateProcessAsUser`（`DISABLE_MAX_PRIVILEGE|LUA_TOKEN|WRITE_RESTRICTED`、
  按工作区派生的 restricting SID、Low 完整性），命令以 base64 JSON 置于 PowerShell 引导里，
  **命令文本不会变成 PowerShell 源码**；子进程挂进无名 kill-on-close Job Object；ACL/标签改动有日志、
  跨进程独占租约与恢复。**读与网络明确不隔离**（自述 `workspace-write-partial`）。
- macOS：`sandbox-exec` + deny-default SBPL，工作区与私有 scratch 可写，`.git`/`.yuantu`/`.aws`/`.ssh`
  等写入被拒，`file-link` 被拒，网络默认拒绝；**探针证明每一项属性后才交回计划**；含硬链接或超过
  10 万条目的工作区直接拒绝而不是部分沙箱化。
- `run_code`/`workflow` 客体外进程执行，`--permission --allow-worker`、`--allow-fs-read` 收窄；脚本跑在
  vm 里，能力面**只有**注入的工具/钩子函数与受限 console；每次内部调用都重新进入本运行的
  `ToolRegistry.execute`，因此守卫、审批、策略与截止时间同样生效；调用后断连视为结果未知并**阻止自动续跑**。

**存储与投影（`packages/storage`）**

- SQLite 事件日志是唯一真源（schema v30），UI 全部由投影得出；租约、投影检查点、检索同层。
- 旧库迁移前强制快照；更新 schema 的库**拒绝打开**；维护命令复用离线校验与保全流程。

**宿主与载体**

- 长驻 Agent Host 提供 JSON-RPC（生成事实表列出 57 个方法），载体经 `packages/carrier` 的**一套受校验
  命令词表**驱动；`packages/carrier` 内不允许出现 Electron、DOM 或 `apps/` 引用（由测试从源码文本钉住）。
- `apps/web` 复用 `apps/desktop/renderer.ts`，只替换 `window.yuantu` 背后的桥——渲染层不知道底下是
  Electron IPC 还是 WebSocket。Web 桥有 loopback 限制与 24 字节随机 token（对照 §6.1 的 TCP carrier）。

### 3.5 已有工程机制及其边界

源码和现有测试支持以下工程机制；它们有助于约束行为，但不构成全部功能正确或已完成平台验收的证明：

- **会话持久状态由事件日志投影**，投影缓存失效后可重放；界面仍有预览、草稿及设置状态，不能一概称为“没有另存状态”；
- **用量数字只采信供应商上报值**，未上报的缓存写入字段保持 `undefined` 而不是 0；
- **压缩锁在每条退出路径上释放**，包括重试交接；
- **缺失的子代理结果从日志结算**，不从内存结算（`subagent.assigned`/`finished`/`interrupted` 减去
  `subagent.collected`），后台命令用同一套三段式记录；
- **工具管线顺序不变量在运行时校验**，而不只是注释约定；
- **不确定的清理结果上报为 `ToolCleanupError`**，而不是伪装成成功；
- **恢复时不只凭历史 PID 发送信号**，避免 PID 复用误伤；活动命令仍需要进程或进程组终止机制。

## 4. 健康度：原日志与当前验证分别记录

| 门禁                    | 结果      | 说明                                                                  |
| ----------------------- | --------- | --------------------------------------------------------------------- |
| `format:check`          | 通过      | Prettier                                                              |
| `docs:check`            | 通过      | 生成事实块与代码一致，禁用措辞未出现                                  |
| `references:check`      | 通过      | 文档/工作流/package.json 的路径与锚点可解析                           |
| `i18n:check`            | 通过      | 见 §6.2 的 i18n 缺陷——门禁通过但不完备                                |
| `typecheck`             | 通过      |                                                                       |
| `build`                 | 通过      | 含 program runner 与桌面构建                                          |
| 原全量 `test`           | 2248/2363 | 5 失败、110 跳过，1467.86 秒；非当前全量结果                          |
| 上一轮关联回归          | 357/359   | 0 失败、2 跳过                                                        |
| 上一轮最终新增回归      | 13/13     | 0 失败；完成状态及搜索边界                                            |
| 编译客户端冒烟          | 3/3       | 内部客户端协议与 Host，不是完整桌面交互验收                           |
| DeepSeek-V4.1-Flash     | 7/7 场景  | 隔离的合成测试，见 §6.6                                               |
| 本次原失败文件复测      | 19/23     | 0 失败、4 跳过；4 条跳过均写明 Low 标签原因，见 §6.7                  |
| 全量 `test:partitioned` | 见 §6.7   | **2325 项：2211 通过、0 失败、114 跳过**；并行阶段仅 78 项、约 1.4 秒 |

原全量日志位于 `.scratch/test-logs/1791972355206-17824-439c5ba2-67f3-4d6d-bb1a-3a87ed9ba2fe-serial.log`，其中的计数、失败名称与耗时本次已核实。原失败项及当前状态：

| #   | 测试                                                     | 归因                                                                            |
| --- | -------------------------------------------------------- | ------------------------------------------------------------------------------- |
| 1   | `tests/macos-packaging.test.ts`，Windows prepack 用例    | 依赖先前打包留下的未跟踪文件；已改为临时 fixture，本次该文件 8/8 通过           |
| 2   | `tests/native-sandbox-bundle.test.ts`，regex worker 用例 | 本次仍报 esbuild 写 `%TEMP%` 的 `Access is denied`；esbuild 文件 Low 标签已核实 |
| 3   | `tests/office.test.ts`，Word/PPT 流程                    | 本次仍在加载自动化脚本阶段报 `AuthorizationManager` / `UnauthorizedAccess`      |
| 4   | `tests/office.test.ts`，PPT 工具流程                     | 同上；XLSX 的纯 JS 创建、编辑和预览用例通过                                     |
| 5   | `tests/windows-install-safety.test.ts`                   | 本次仍在 dot-source 校验脚本时出现授权错误，未进入预期安装路径断言              |

上述失败不能证明那些产品功能在普通 Windows 或 CI 上必然失败，也不能证明未被这些用例覆盖的代码没有缺陷。#3/#4 另外暴露了 Office 脚本授权失败未分类为环境不可用、工具级测试缺少相应环境处理的健壮性缺口，见 `ENV-1`。本次还重跑了原作者保存的 `core-kernel-1` 最小复现：`usage.inputTokens=2030`、`statistics.inputTokens=4030`，断言失败；这一代码问题并不在上述原全量 5 个失败项中。该问题已在 §6.7 修复：新增回归在 4 个组合下要求 `result.usage`、`result.statistics` 与 `store.statistics` 三者一致并全部通过，同类差异不再出现；未重跑原作者那份最小复现脚本本身。

第 2 轮复测的 5 项状态更新为：**19 通过 / 0 失败 / 4 跳过**。4 条跳过都带显式环境原因（Windows 拒绝加载脚本、打包器无法写输出），不是“全部跳过”：XLSX 纯 JS 路径、macOS 打包夹具、模块 URL shim 等用例仍真实执行，见 §6.7。

## 5. 本机环境限制：Low 标签与 PowerShell 脚本授权

这是一项需要与产品缺陷分开的本机条件。当前权限拒绝和脚本授权错误已重现；改变标签后是否全部恢复，以及 Office COM 与真实安装是否可用，本次没有验证。

### 5.1 事实

```
icacls "E:\agent-desktop\YuanTu-Foundry"
  → Mandatory Label\Low Mandatory Level:(OI)(CI)(NW)
```

本次 `icacls` 核实了根目录上的 `(OI)(CI)(NW)` Low 标签，以及 Office 自动化脚本、esbuild 和 `dist/release/win-unpacked/YuanTu Agent.exe` 上继承的 Low 标签。“整棵树每个文件都是 Low”不能只由根目录推出，个别文件可能有显式或受保护的标签；本次没有递归枚举每个文件。

### 5.2 原作者报告的对照实验与本次证据范围

| 实验                                                                    | 结果                                      |
| ----------------------------------------------------------------------- | ----------------------------------------- |
| 同一段 `.ps1` 放在 `%TEMP%`、`E:\`、`E:\agent-desktop\`                 | 全部 PASS                                 |
| 同一段 `.ps1` 放在工作区内（含新建的空目录）                            | FAIL：`AuthorizationManager check failed` |
| 原作者称仅把实验目录改标为 medium                                       | 原作者记录 PASS；本次未改标签或重复此实验 |
| 原作者称仅把实验 `.ps1` 文件改标为 medium                               | 原作者记录 PASS；本次未重复               |
| 用 `-ExecutionPolicy Bypass`                                            | PASS                                      |
| 复制工作区的显式 ACE（含 `Deny Everyone`）到兄弟目录                    | PASS（**排除 ACL**）                      |
| 用 junction 指向工作区                                                  | FAIL（**排除路径字符串，指向目录身份**）  |
| 文件 owner / WDAC / AppLocker / SRP / ASR / ADS / `Get-ExecutionPolicy` | 均无异常（**逐项排除**）                  |

表中实验来自原作者陈述，没有对应的独立原始输出归档，不能一概标成本次“逐条验证”。本次确认 Low 标签存在，并重现 esbuild 写入拒绝和 PowerShell 授权错误。原作者的 medium/Bypass 对照若成立，支持标签与授权机制相互作用；仍不能因此声称“与执行策略无关”，或已经在本次排除了所有 DACL、WDAC、SRP、ASR 条件。

### 5.3 已观察的影响与条件性推断

| 危害                                                   | 证据                                                                                                                                                                                                          |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **本工作树内 Word/PPT 默认 PowerShell 自动化未能启动** | 两个 Office 用例在脚本授权阶段失败；§6.7 的 A/B 复现已证明 **COM 层可用**（create 端到端成功并生成可解析的 DOCX），edit/preview/签名/安装仍未验收；XLSX 纯 JS 路径通过。可选 LibreOffice 预览路径未在本次测试 |
| **Low 标记的可执行文件可能受写入限制**                 | esbuild 向普通临时目录写 worker 被拒；解包应用文件也有 Low 标签。本次未测应用运行令牌、未启动安装后的应用，不能把工作树内运行推断成所有安装产物都这样                                                         |
| **四个相关用例当前不再失败**                           | §4 表格 #2/#3/#4/#5 已按 §7.1.2 改为带显式环境原因的跳过：0 失败、4 跳过；原因是 Low 标签，不是产品缺陷，见 §6.7                                                                                              |

Windows 的机制依据是 [Microsoft 的 Mandatory Integrity Control 文档](https://learn.microsoft.com/en-us/windows/win32/secauthz/mandatory-integrity-control)：正常创建进程时，其完整性级别受用户令牌及可执行文件标签共同限制，Low 进程不能向更高完整性的对象写入。这支持 esbuild 失败的归因，但不等于已完成解包应用或安装后应用的实机验证；复制到其他目录、重建、安装或显式创建令牌也需要按实际条件检查。

### 5.4 来源与处理边界

ACL 中确有 `CodexSandboxUsers`、机器本地 SID 及 Deny ACE，说明存在外部沙箱管理痕迹；这不能证明具体是哪一个进程设置了 Low 标签、是否仍在管理它，或是否属于遗留配置。本项目自己的 Windows 沙箱实现也会调整标签并记录恢复日志，来源不能仅凭名称断言。

本次只读检查标签，没有修改 ACL、完整性标签或工作区租约。需要验收 Office 或安装包时，应先明确环境管理方，在经授权的独立测试工作区或 VM 复测；安全标签调整应由环境所有者制定范围与恢复方式。原文的“递归清掉 Low”及“临时提权即可解决”不作为通用修复建议。加载脚本成功也只证明脚本授权通过，不能代替 Office 创建、编辑、预览、签名或安装验收；§6.7 在未打标签目录中额外完成了 **create** 一步的端到端验证，其余步骤仍未验收。

## 6. 原审计跟踪项、候选风险与设计边界

以下保留原审计的 **34 条跟踪项**及其严重度：**2 high、13 medium、19 low**。这是归档分类，不是本次新增或逐项独立复现的缺陷数量；包含条件风险、健壮性与测试缺口、有意取舍，以及同一根因的不同表现。原裁决的 3 个撤销项另列于 §6.5；本次可靠性修复单列于 §6.6，不并入这 34 条。

ID 命名：带 `R1-` 前缀的条目来自**第一轮**审计（其原始报告因工具输出截断丢失，仅存汇总，见 §2 局限
说明），本次按缺少原始证据的跟踪项保留；其余 ID 与 §9 的裁决文件同名，可直接对照。`ENV-1` 的脚本授权错误和分类缺口已在本次重现。除另行标明的复现外，下表“裁决要点”均来自原归档。

| 严重度     | 项数 | ID 一览                                                                                                                                                                                                                                                                                                                                                         |
| ---------- | ---: | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **high**   |    2 | `R1-tools-credential-8dot3`、`hosts-assembly-1`                                                                                                                                                                                                                                                                                                                 |
| **medium** |   13 | `ENV-1`、`desktop-app-1`、`R1-core-1`、`core-kernel-1`、`R1-tools-toolcut-output-never-spilled`、`hosts-assembly-2`、`integrations-1`、`integrations-4`、`build-ci-tests-1`、`build-ci-tests-2`、`build-ci-tests-3`、`storage-protocol-carrier-1`、`storage-protocol-carrier-2`                                                                                 |
| **low**    |   19 | `R1-core-2`、`R1-core-3`、`R1-core-4`、`R1-core-5`、`core-kernel-2`、`core-kernel-3`、`desktop-app-2`、`desktop-app-3`、`hosts-assembly-3`、`hosts-assembly-4`、`hosts-assembly-5`、`hosts-assembly-6`、`integrations-2`、`integrations-3`、`integrations-5`、`storage-protocol-carrier-3`、`storage-protocol-carrier-4`、`tools-sandbox-2`、`build-ci-tests-4` |

### 6.1 high（2 项）

#### HIGH-1（`R1-tools-credential-8dot3`）Windows 8.3 短文件名绕过凭据保护

本次核对了 `Workspace.resolve` 和名称规则；缺少规范化后复查这一源码事实仍在。别名实际可用性取决于所在卷、目录和文件是否启用并生成 8.3 名称，本次未读取真实凭据、未复现本机别名读写。

- **位置**：[packages/tools/files.ts](../packages/tools/files.ts) 的 `Workspace.resolve`。
  [:143-148](../packages/tools/files.ts#L143-L148) 用「**调用方书写形式**」的路径分段做 `hidden()` 检查；
  [:167-168](../packages/tools/files.ts#L167-L168) 在 `realpath` 之后**只复查包含关系，不再复查名称规则**。
- **机制**：`CREDEN~1.JSO` 不匹配 [credential-paths.ts](../packages/tools/credential-paths.ts) 里的
  `/^credentials(?:\..*)?$/i`，但 `realpath` 会把它解析成 `credentials.json`。
- **影响**：`read_file('CREDEN~1.JSO')` 读出密钥；`edit_file('ENV~1.LOC', …)` 改写 `.env.local`。
  `read_file` 不声明权限，因此在只读/计划模式与 explore 子代理里**同样生效**——而那些场景里
  `run_command` 已被拒，这条名称规则是唯一屏障。8.3 别名对标准名可猜（大写 6 字符前缀 + `~1` + 扩展名），
  但别名是否存在、具体编号和名称不能保证，短名并非总能按该形式猜中。该问题应描述为**有 8.3 别名时的条件性绕过**。
- **修复**：在 `realpath` 之后把名称规则重新应用到**规范化的**工作区相对路径。仓库里已有
  [canonicalRelative()](../packages/tools/files.ts#L81-L84) 正是为此存在；对照
  [packages/search/inventory.ts](../packages/search/inventory.ts) 用的是磁盘真实名字，**枚举侧不受影响**。
- **原作者报告的裁决要点（无独立文件）**：称验证者在本机复现（`read_file('CREDEN~1.JSO')` 返回凭据内容、`credentials.json` 被拒；
  `edit_file('ENV~1.LOC')` 改写成功）；原判行号偏移约 20 行；枚举与搜索**不受影响**（搜索层对规范化相对
  路径重新应用了规则）；写路径仍会弹审批且预览携带规范名。严重度维持 high。

#### HIGH-2（`hosts-assembly-1`）TCP carrier 无认证，一条连接即可获得未沙箱化的命令执行

- **位置**：[apps/agent-host/carrier.ts](../apps/agent-host/carrier.ts) 的连接回调只判断
  「是否已有客户端连接」，**没有 token、没有 `remoteAddress` 白名单、没有 TLS**；`remoteAddress`
  只用于一行 stderr 日志。[apps/shared/args.ts](../apps/shared/args.ts) 的 `parseListen` 正则接受任意
  host 字符串（含 `0.0.0.0`）并直接交给 `server.listen`；全仓库没有任何地方把它限制在 loopback。
- **升级链**：`sandbox.set host`（[apps/agent-host/handlers/system.ts](../apps/agent-host/handlers/system.ts)
  在无活跃会话时**只**校验 `ctx.active.size`）＋ `permission.update` 可整份替换为 allow-all 策略 ＋
  `approval.respond` 由同一连接自答 → **未认证、自我批准、逃逸沙箱的命令执行**。
- **对照**：`apps/web/main.ts` 的非 loopback 请求返回 403、token 不符返回 401，硬绑 `127.0.0.1`，并用
  24 字节随机 token。同一仓库里已有做对的实现。
- **触发条件**：默认走 stdio，桌面端不传 `--listen`——属**可选启用**，但它是文档明确指引用作
  "对外服务"的路径，且 README 已知边界从未提及 carrier 的信任问题。
- **裁决要点**：所有被指控"无守卫"的环节逐条确认为真的无守卫；对同用户进程不构成权限跨越，真正尖锐的
  是多用户机器上其他本地用户访问 loopback 端口，以及显式 `--listen 0.0.0.0:PORT`。严重度维持 high。

### 6.2 medium（13 项）

| ID                                      | 标题与要点                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ENV-1`                                 | **Office 脚本授权失败未正确分类为环境不可用。** [automation.ts](../packages/office/automation.ts) 启动 PowerShell 时未指定执行策略，`isOfficeUnavailable()` 仅识别 COM 未注册错误。本次两个 Office 用例均在脚本授权阶段失败；第一个直接自动化用例只对 `OfficeUnavailableError` 自我跳过，PPT 工具级用例则直接断言成功。是否采用进程级执行策略参数需结合环境策略决定，缺少 `-ExecutionPolicy Bypass` 本身不等同于产品缺陷，强制 Bypass 也不是通用修复。                                                                                                                                |
| `desktop-app-1`                         | **面向人的文案双向漏出字典**：多数运行状态、两条拒绝路径与**所有导出的会话文件**在英文模式下仍是中文，而权限标签在中文模式下是英文——**两道 i18n 门禁都照样通过**。                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `R1-core-1`                             | **worktree 子会话的会话历史工具全部失效。** [packages/core/session-query.ts](../packages/core/session-query.ts) 用 `executionRoot` 与 session 行里存的**父工作区**比较，两者对隔离子代理永不相等；`read_session_events`/`search_session_events`/`trace_session` 全报"belongs to another workspace"，连读自己的会话也被拒。更糟的是 `search_sessions` **不报错**，返回静默错误的"无匹配"。隔离是可写子代理的**出厂默认**，属默认路径上的功能破损。                                                                                                                                     |
| `core-kernel-1`                         | **resident 子代理用量被重复计入，当前仍可复现。** 本次重跑原作者保存的最小复现，得到 `RunResult.usage.inputTokens=2030`、`statistics.inputTokens=4030`、两个相同 id 的 `subagent.finished`；会话统计也是 4030。原复现检查不相等时失败；脚本使用假模型，没有真实 token 花费。                                                                                                                                                                                                                                                                                                          |
| `R1-tools-toolcut-output-never-spilled` | **`git.ts` 先自截断，导致已捕获的尾部静默丢失。** [packages/tools/git.ts](../packages/tools/git.ts) 把 48,000 字符的捕获砍到约 24,000 并追加截断标记；[packages/tools/registry.ts](../packages/tools/registry.ts) 因结果以标记结尾而**跳过落盘**，于是 spill 回调拿到的只是模型已经看到的那些字符。**裁决纠正了原判归因**：marker 门是**有意**的（有注释与测试锁定），真正缺陷在 `git.ts` 预先截断——移除 marker 门救不回丢失的字符，只会多一个承诺"完整 N 字节"的冗余文件。                                                                                                           |
| `hosts-assembly-2`                      | **第二条 TCP 连接不读拒绝就关闭，会让 Host 因未捕获的 `ECONNRESET` 崩溃。**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `integrations-1`                        | **工作区声明的钩子无审批执行命令，且六类事件中有两类在只读/计划运行中也执行**，与 [packages/resources/hook-bridge.ts](../packages/resources/hook-bridge.ts) 自己的注释相矛盾（该文件另有四处事件明确判 `readOnly` 后返回，而 `SessionStart`/`SessionEnd` 没有，且这两类事件的上下文类型**根本不含** `readOnly`，桥无法检查类型没有的东西）。**裁决纠正**：沙箱确实经 `underSessionPolicy` 安装（原判机制错）；`SessionEnd` 一半是死的；"克隆仓库即可执行其命令"本身是**文档化的 Claude-Code 兼容设计**，`YUANTU_HOOK_BRIDGE=0` 可关。真正的问题是桥自称的第三道门对生命周期事件失效。 |
| `integrations-4`                        | **Office 解析器没有解压上限**，体积限制在不可信 OOXML 包**已被解压之后**才检查（zip 炸弹风险）。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `build-ci-tests-1`                      | **打包后的桌面永远用不上它自带的 ripgrep。** [packages/search/ripgrep-assets.ts](../packages/search/ripgrep-assets.ts) 的 `buildRoot()` 在编译产物里指向 `dist/build`，而 `build/search-assets.lock.json` **从不进包**，于是恒为 `null` → 永远回退内置 JS 扫描器，安装包同时多背约 5 MB 死重。验证者用真实编译产物复现两次，并通过手工注入 lock 反证"二进制本身没问题、只有 lock 找不到"。**之所以能通过所有门禁**：唯一触达真实资产的测试跑在源码布局下，那里查找是成功的。原报 high，因结果正确性不受影响降为 medium。                                                              |
| `build-ci-tests-2`                      | **一个"没跑任何测试"的测试文件仍被记为 1 个通过用例**，于是提前退出的文件与健康文件在所有门禁里无法区分，`npm run check` 与 Windows 验收都被架空。                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `build-ci-tests-3`                      | **`package:windows:protected` 结尾校验一个受保护构建根本不会产出的安装包名**，即该门禁在校验错误的对象。                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `storage-protocol-carrier-1`            | **需要迁移或桌面升级的数据库，其压缩后备份超过 512 MiB 时会被默认备份配额拒绝。** 配额检查发生在 `VACUUM INTO` 生成紧实副本之后，不能按实时数据库文件大小简单推断，也不能把空闲页误算成升级门槛。同版本库正常打开不要求该备份；只读检查及从较小旧备份恢复仍有路径。默认配额未与强制升级恢复副本分开，错误也没有被完整呈现给桌面用户。                                                                                                                                                                                                                                                 |
| `storage-protocol-carrier-2`            | **删除会话会永久遗留它的子代理 worktree**（绑定的会话引用被外键置空，而所有工作区清理 RPC 都以 session id 寻址），磁盘上留下无法寻址的目录。                                                                                                                                                                                                                                                                                                                                                                                                                                          |

### 6.3 low（19 项）

| ID                           | 标题与要点                                                                                                                                                                                                                                                                                                               |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `R1-core-2`                  | **上下文窗口溢出被误报为 `output-limit`。** 溢出恢复额度耗尽时缺少"最后一个压缩问题"标记，于是落进无条件抛出的输出上限分支；同一事件以抛错形式到达时却走正确的失败码路径——两种形状互相矛盾且无测试覆盖。用量与恢复额度不受影响。                                                                                         |
| `R1-core-3`                  | **按 UTF-16 下标切分工具结果会劈开代理对。** [packages/core/shrink.ts](../packages/core/shrink.ts) 用 `.length` 做预算与切点，而同级的 [packages/core/prune.ts](../packages/core/prune.ts) 明确用码点切分并注释了原因。实际只影响星光面字符（纯 CJK 不受影响，已实测）。                                                 |
| `R1-core-4`                  | **内核产出的部分中文串无法被两种 i18n 机制翻译**（视觉能力关闭时的报错、目标草案文本）。修正：i18n 门禁不止扫 `apps/desktop`，也扫 `packages/carrier` 与 guest worker，只是**没有扫 `packages/core`**。                                                                                                                  |
| `R1-core-5`                  | **无时区的 daily 触发器可能报出规则未命名的时刻**（夏令时跳变日）。修正：伪造时刻在绝对时间上是"上次真实发生的 24 小时后"而非 1 小时后；影响面只是持久化标签，没有运行被丢弃或重复。                                                                                                                                     |
| `core-kernel-2`              | **resident 子代理的后续轮次花费永远到不了 `RunResult.usage`**（与 `core-kernel-1` 是同一个"折叠归属缺失"的两半）。                                                                                                                                                                                                       |
| `core-kernel-3`              | **摘要的校准观测用一个由权重自身构成的数字做归一化**，使校准因子偏向 1。                                                                                                                                                                                                                                                 |
| `desktop-app-2`              | **未保存的语言预览与主进程持久语言不同。** 预览后保存才同步主进程，这一分工有测试记录；残留影响主要是预览期间的原生对话框和带文件名前缀的附件错误。重启恢复已保存语言是预期持久化行为，不能单独算作缺陷。                                                                                                                |
| `desktop-app-3`              | **i18n 遍历器会改写应用并不拥有的文本**：与 UI 字符串相同的会话标题或工作区条目会被以另一个名字显示。                                                                                                                                                                                                                    |
| `hosts-assembly-3`           | **原始 RPC 的 `workspace.apply` 没有进入工具审批或执行策略检查，与代码中审批保证不一致。** 原裁决确认当前桌面词表、客户端及 SDK 没有调用它，触发依赖自行发送协议请求；不能描述成默认桌面流程的只读沙箱逃逸。                                                                                                             |
| `hosts-assembly-4`           | **JSONL 分帧两个方向都无上限**，字节持续缓冲。原报 medium，降为 low。                                                                                                                                                                                                                                                    |
| `hosts-assembly-5`           | **`session.get` 不带 `offset` 时返回整个 transcript。** 当前兼容分支没有字节上限；巨大响应可能超过客户端帧上限。桌面正常加载历史使用分页，风险应限定到不传分页参数的协议调用方，不能说所有桌面会话加载都会发生。                                                                                                         |
| `hosts-assembly-6`           | **手动压缩无法取消**：`run.cancel` 报 `cancelled:false`，而压缩仍在消耗。                                                                                                                                                                                                                                                |
| `integrations-2`             | **LSP `WorkspaceEdit` 预览读取目标文件时不做工作区与符号链接校验**，工作区内一个符号链接即可把工作区外的文件内容泄漏进审批记录。原报 medium，降为 low。                                                                                                                                                                  |
| `integrations-3`             | **显式模型目录探测跟随重定向，成功响应体没有字节上限。** 原裁决的跨源保留凭据只在 Anthropic `x-api-key` 路径复现，Bearer 头会被跨源剥离；已配置端点本来就接收该凭据。桌面调用方有 15 秒取消信号，限制总时长但不限制可读字节；不是无限等待或所有协议都会泄露凭据。                                                        |
| `integrations-5`             | **被内容过滤的响应被 chat 适配器报成干净的 `stop`**，而被 Responses 适配器报成长度截断——同一事件两种说法。                                                                                                                                                                                                               |
| `storage-protocol-carrier-3` | **重试计数器在唯一生产调用处不带会话作用域**，每次重试决策都扫描整个工作区事件日志。                                                                                                                                                                                                                                     |
| `storage-protocol-carrier-4` | **删除记录不立即缩小实时数据库，缺少显式压缩维护命令。** 空闲页会被后续写入复用，文件占用受历史峰值影响；现有备份与恢复会生成紧实副本，在满足备份配额时可间接回收空间。因此“没有任何路径还空间”不成立，此处保留的是维护功能和文档缺口。                                                                                  |
| `tools-sandbox-2`            | **macOS 已执行命令的私有临时目录有意保留，尚无可靠的有界回收路径。** `SeatbeltScratchRegistry.cleanup()` 在 `started` 后不删除，测试明确要求保留，因为脱离进程组的子孙无法确认清理。运行次数及写入决定占用，系统临时目录回收不能承诺固定发生在重启；属于安全取舍与回收缺口。按年龄或 Host 启动清扫可能误删并发活动目录。 |
| `build-ci-tests-4`           | **提交进仓库的基准运行配置钉住了某台开发机的绝对路径**、该机器代码树的清单哈希，以及一个预授权的实盘模型预算。                                                                                                                                                                                                           |

### 6.4 部分结论被纠正的条目

这些是原裁决保留、但调整了机制、归因或严重度的条目。上表还合入了本次复核的触发条件与限定；它们的保留不等于本次逐项重跑：

| 条目                                                                                               | 被纠正的部分                                                                                     |
| -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `R1-tools-toolcut-output-never-spilled`                                                            | **归因错**：缺陷在 `git.ts` 的预先截断，而不是被指控的 `registry.ts` marker 门（那是有意设计）。 |
| `integrations-1`                                                                                   | **机制错**：Hook 的沙箱确实经 `underSessionPolicy` 安装；`SessionEnd` 一半不可达。               |
| `core-kernel-1` / `core-kernel-2`                                                                  | 两者是同一个"折叠归属缺失"的两半，不是互相矛盾的两条独立缺陷。                                   |
| `storage-protocol-carrier-1`                                                                       | 严重度 high → medium。                                                                           |
| `build-ci-tests-1`                                                                                 | 严重度 high → medium；且影响面比原判**更广**（`dist` 布局的开发/CLI 运行同样失效）。             |
| `integrations-2` / `integrations-3` / `hosts-assembly-3` / `hosts-assembly-4` / `hosts-assembly-5` | 严重度 medium → low。                                                                            |
| `tools-sandbox-2`                                                                                  | 原建议的修复方式有风险（进程级清扫会误删并发 Host 的目录）。                                     |

### 6.5 原撤销项的本次复核

| 原指控                                                 | 本次结论                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tools-sandbox-1`：`write_command` 不声明权限          | **撤销成立。** 当前工具实际声明 `permission: 'command'`，只读过滤、审批和独占分类均有入口；原主文档只说“归属挡住”没有指出最直接的反证。                                                                                                                                                                                                                                                                                                   |
| `build-ci-tests-5`：类型检查不检查门禁自身             | **撤销成立，但有窄缺口。** TypeScript 会追踪被测试导入的模块；本次编译程序列表包含两个门禁脚本和三份性能 benchmark。`benchmarks/coding-evaluation/schema.ts` 不在程序中，不能把这个单文件缺口扩大成门禁脚本全都不检查。                                                                                                                                                                                                                   |
| `tools-sandbox-3`：观察记录缺少 await 造成读后编辑误拒 | **生产流程误拒尚未重现，不能宣称绝对不可达。** 原裁决把线程池派发顺序当作完成顺序，反证不充分；工具组串行只等待返回的 Promise，不自动等待被丢弃的 Promise。当前 `record()` 和 `settle()` 调用 `remember()` 未 await。本次给 `settle({written:['already-removed.ts']})` 传入已不存在的临时路径，方法先返回，再出现未处理的 `ENOENT` 拒绝；这是错误隔离探针，不是生产读写竞态或 Host 崩溃复现。应保留为待验证风险，而非已确认默认流程缺陷。 |

### 6.6 已完成的可靠性修复与验证边界

以下是上一轮已实施的修复，与原 34 条跟踪项分开记录。当前源码和新增回归仍能对应这些变更：

| 修复                     | 当前实现及验证                                                                                                                                           |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 最终完成状态持久化       | `SessionStore.finishRun` 同一事务写最终 `completion.updated`、绑定目标的完成状态和运行结束；提交后发布 live 通知。回归覆盖事务失败回滚及数据库重开一致性 |
| 停止钩子后的文件变化     | 停止钩子结束后才计算最终指纹；不匹配时运行及绑定任务进入 `needs_review`，避免留下已完成任务                                                              |
| 外部文件修改后的符号更新 | `symbols()` 枚举并核对文件元数据，发现命令改写、新增、重命名、删除后刷新；旧版本游标被拒。大小和 mtime 都保持不变的改写仍需可选哈希核对                  |
| 符号分页                 | `repo_map` schema 接受 `cursor`；索引游标用版本内序号续页，避免同一行声明遗漏；LSP 游标绑定查询及返回结果快照，适配器不再先截成 200 个                   |
| 不完整覆盖披露           | 超过 8 MiB、读取失败、读取中变化和清单扫描截断会保留不完整标记；跳过的文件不保留旧符号，失败读取会重试，调用方可取消共享构建等待                         |

新增 [completion-finalization.test.ts](../tests/completion-finalization.test.ts) 4 项与 [search-consistency.test.ts](../tests/search-consistency.test.ts) 9 项，共 13 项通过；上一轮关联回归 359 项中 357 通过、2 跳过、0 失败。两个跳过分别是 Windows 符号链接创建需要权限、暂停的 CLI 启动测试。

真实模型为用户选定的 **DeepSeek-V4.1-Flash**（ISRC 端点），通过实际 Agent、工具执行、机器验收、事件投影与数据库重开验证以下 7 个合成场景：跨文件改名、最终摘要落盘、停止钩子改变输入、命令改变符号、205 个符号三页取回、超限文件的不完整覆盖、持久任务及停止钩子状态。场景名称按原报告为 `completion`、`stop-hook`、`external-write`、`symbol-pages`、`symbol-coverage`、`task-completion`、`stop-hook-task`，最新均通过；审查场景通过意味着正确进入 `needs_review`，不是任务成功完成。

本地记录为 `artifacts/live-reliability-20261014/report.json` 与 `summary.md`。最新七场景共 28 个模型请求，输入 71,254、输出 4,076 token；保留全部失败尝试后的已知累计为 68 个请求，输入 172,062、输出 11,364 token，另一次初始探针用量未知。早期失败包括测试脚本的权限字段、调用预算及过长任务标题错误，不能记为产品缺陷。测试仅发送隔离的合成内容，未发送用户项目源码或输出密钥。

这一验证不覆盖实际 Electron 界面的模型交互、真实 LSP 服务端的全面性、Office COM、签名安装或原表中其他缺陷。停止钩子改变受监测文件的任务顺序已修复，但任务完成行与稍后的运行最终落盘仍是两个提交；不能声称所有任务与运行终态都在一个原子事务中。

### 6.7 第 2 轮：按 §7 逐条修复的结果

本节记录依据本文档 §7 实施的改动。每条区分“本轮实测”与“仍未验证”；全部命令在当前工作区执行，未修改任何安全标签或 ACL。

**先修阻塞项。** 上一轮未完成的 resident 用量归属改动把 `activation.deliver(...)` 提到了 `const messageId` 之前，`npm run typecheck` 报 `TS2448`/`TS2454`，运行期 `send_message` 直接抛出。已恢复原调用顺序，typecheck 转绿；这是本轮其余验证的前提。

| 条目                              | 改动                                                                                                                                                       | 本轮实测                                                                                                                                                             |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| §7.2.10 前半，resident 用量归属   | [run-residency.ts](../packages/core/run-residency.ts) 把 `outcome.usage` 折进会话用量，`settle` 首次进入即返回（一次修正只观察一个回合）                   | 新增 [subagent-usage.test.ts](../tests/subagent-usage.test.ts)：`{wait:true}`/`{wait:false}` × 两场景 **4/4 通过**，1.1 秒，进程自行退出（无需 `--test-force-exit`） |
| §7.2.7，git 完整内容交给 registry | [git.ts](../packages/tools/git.ts) 的 `runGit` 不再预先 `bounded()`；`MAX_CAPTURE_BYTES` 不变                                                              | [spill.test.ts](../tests/spill.test.ts) 新增回归：32,000 字符 diff 落盘完整、含末行、不含截断标记；**13 通过 / 1 跳过 / 0 失败**                                     |
| §7.1.3，规范化名称检查            | 未改产品代码                                                                                                                                               | [credential-paths.test.ts](../tests/credential-paths.test.ts) 在本机**确实生成了 8.3 别名**，两条别名用例真实执行（459/422 毫秒），**7/7 通过**；未使用真实凭据      |
| §7.1.2，Office 授权诊断拆分       | [automation.ts](../packages/office/automation.ts) 新增 `isScriptAuthorizationFailure`，优先于 COM 判定，两种原因措辞分开                                   | [office.test.ts](../tests/office.test.ts) **9 通过 / 0 失败 / 2 跳过**，跳过原因写明“Windows 拒绝加载脚本”而非“未安装 Office”；XLSX 路径全部通过                     |
| §7.2.10 后半，丢弃 Promise        | [fs-observation.ts](../packages/tools/fs-observation.ts) 的 `record()`/`settle()` 补上 `await`                                                             | 先确认 RED（运行器原话：“would have caused the test to fail, but instead triggered an unhandledRejection event”），修复后 **16/16 通过**                             |
| §7.3.13，打包布局解析             | [ripgrep-assets.ts](../packages/search/ripgrep-assets.ts) 新增 `lockFiles()`；[copy-search-assets.mjs](../scripts/copy-search-assets.mjs) 把锁暂存到资产旁 | [search-ripgrep.test.ts](../tests/search-ripgrep.test.ts) 新增打包布局验收，**15/15 通过**                                                                           |
| §7.3.12，白名单可视性             | [run-tests.mjs](../scripts/run-tests.mjs) 的 `--plan` 增加 `Policy:` 行                                                                                    | `Policy: entries=16 parallelised=11 awaiting-review=5`；运行器自身 **27/27 通过**                                                                                    |

**§7.1.1 受控 A/B 复现（未修改任何标签）。** 在同一台机器的同一 shell 中，把脚本与二进制复制到未打标签的目录后重跑同一命令：

| 项目                                                        | 工作区内（Low 标签）                        | 未打标签目录（无标签，默认 Medium） |
| ----------------------------------------------------------- | ------------------------------------------- | ----------------------------------- |
| `packages/office/automation.ps1`                            | exit=1，`AuthorizationManager check failed` | exit=0，`{"ok":true}`               |
| `scripts/windows-install-safety.ps1`                        | exit=1，同上                                | exit=0，目标函数可用                |
| `node_modules/@esbuild/win32-x64/esbuild.exe`（写临时目录） | `Access is denied`                          | 指向副本后该文件 **3/3 通过**       |

由此得到本文此前没有的证据：**本机 Office COM 实际可用**。在未打标签目录中 `automation.ps1` 返回 `{"ok":true}` 并生成 13,584 字节的 `out.docx`（11 个 zip 条目，含 `word/document.xml`）。§5.3 只把“COM 层是否可用”列为未证明，现在可以证明它在脚本能被加载时可用，而且不止“加载脚本成功”：创建操作端到端完成。§5.4 的边界仍然成立——编辑、预览、签名与安装仍未验收。

四项环境失败的共同原因是 Low 完整性标签（脚本授权与二进制写权限），不是产品缺陷，且各自都有无需改动机器配置的复现。**未验证**：没有在 VM 或另一台机器复现，也没有递归修改标签或 ACL。

**§7.2.7 的边界照旧。** `MAX_CAPTURE_BYTES` 仍是 `MAX_TOOL_OUTPUT` 的两倍，超过 48,000 字符的输出仍在捕获阶段被截断，那部分无法靠移除截断标记恢复。本轮修的是“已捕获但被工具层丢弃”的那一段。

**§7.3.13 是一个真实缺陷，不只是缺测试。** `loadSearchAssetLock()` 原先只按模块相对路径找锁；编译布局下那是 `resources/app/dist/build/search-assets.lock.json`，而任何包都不包含该目录，暂存脚本也从不把锁放进 `resources/search-assets`。于是运行时在读到锁之前就返回 `null`，`assetDirectories()` 里 `process.resourcesPath` 那一支**在生产中不可达**：应用一直静默使用内置扫描器，同时随包携带了已验证的 ripgrep。修复后 `lockFiles()` 与 `assetDirectories()` 顺序一致，暂存脚本把锁复制到它描述的资产旁；新用例用真实暂存脚本搭建布局、把真实模块的副本放在 `app/dist/packages/search/`，断言包内不存在 `dist/build`、两个候选路径、以及仅凭 `process.resourcesPath` 解析出摘要一致的二进制。原实现下该查找读到的正是 `null`，这一点也写在用例里。

**§7.3.12：白名单门禁在正常工作，缺口是可见性。** 可复现诊断显示 16 条中 11 条哈希匹配、5 条过期，原因是 5 个被复核输入真的变了：`packages/search/cursor.ts`、`packages/search/service.ts`、`packages/storage/sqlite.ts`、`packages/tools/files.ts`、`packages/tools/fs-observation.ts`。**没有重新登记这些哈希**：登记等于声称做过一次并未进行的并行安全复核。`--plan` 现在额外打印 `Policy:` 行，使“条目数 ≠ 并行数”不再隐藏。

全量 `test:partitioned` 实测（`--parallel-concurrency` 默认 2）：第一次运行 2308 项中 3 项失败，即下述快照漂移（串行 1298.39 秒，墙钟 1301 秒）；重新录制快照后再次全量运行，结果为 2308 项：2194 通过、0 失败、114 跳过（串行 1289.47 秒，墙钟 1292.1 秒）。第 3 轮修复全部落地后再次全量运行，结果为 **2325 项：2211 通过、0 失败、114 跳过**（串行 1309.16 秒）；比第 2 轮多出的 17 项全部是新增回归（§7.2.9 的 10 项与 §7.3.14/§7.3.15 的 7 项），跳过数 114 未变，说明没有把既有跳过变成通过。并行阶段三次都是 78 项、0 失败、约 1.4 秒。并行只覆盖 11 个已复核文件，§7.3.12 所说“白名单数量不等于并行文件数”由此得到确证：16 条条目对 226 个测试文件，唯一真正并行的部分不到总时长的千分之二。这次运行同时是 §7.3.14 那条新规则的验收——它要求每个被请求的文件都写出 per-file 摘要，226 个文件在真实全量运行中没有一个是靠退出码蒙混过去的。

**快照漂移：3 项失败，已复核并重新录制。** 全量运行暴露 [turn-snapshot.test.ts](../tests/turn-snapshot.test.ts) 的 `plain-answer`、`read-then-edit`、`transient-failure-recovered` 三项失败，漂移点是 `requests[0].cacheKey`。`cacheKeyFor` 覆盖 route、系统提示与 `JSON.stringify(tools)`；逐字审查更新后的快照差异后确认：工具数仍是 68、系统提示摘要未变、工具目录 40,909 → 41,008 字节（+99），`tools` token 13,647 → 13,680。这与上一轮 `repo_map` 新增 `cursor` 属性并改写描述的预期后果完全一致，无行为变化，差异只有这些。

**仍未做，因此不作声称。** §7.2.4/§7.2.5/§7.2.6 需要认证方式与绑定范围的**决策**，本轮未改动；§7.2.9、§7.3.11、§7.3.14、§7.3.15 未改动。§7.2.8 本轮只做定位、未改代码：两处强制副本走的是同一个准入检查——[session-migrations.ts](../packages/storage/session-migrations.ts) 的迁移备份失败会直接阻断迁移，而 [desktop-upgrade.ts](../packages/maintenance/desktop-upgrade.ts) 的升级恢复副本处注释写着“不受例行迁移备份保留约束”，代码里的 `backupDatabase()` 却仍按默认 512 MiB 保留配额做准入。根因是 `BackupPolicy` 同时承担了“保留多少历史”和“这张必需的副本能否存在”两个不同问题，二者各有各的补救手段。拆开需要先定一个准入上限的数值策略并修订现有测试期望，属产品决策，未擅自改。白名单哈希未重新登记。未提交 Git。

### 6.8 第 3–4 轮：§7.2.9 边界回归、§7.3.11/§7.3.14 门禁，以及 §7.2.8/§7.3.12/§7.3.15 的修复

下面按完成的先后排列：先是第 3 轮的 Office/模型发现边界、依赖环门禁、运行器形状门禁与内核 i18n 覆盖，然后是第 4 轮的恢复副本准入拆分、白名单并行复核与内核文案承接。

§7.2.9 要求为 Office 解压、**显式**模型发现的重定向与响应字节、LSP 编辑预览路径补边界回归。三项都改动了实现，不只是加测试。

**Office 解压：界限从「解压之后」移到「解压之中」。** 原先四处体积检查都在 `async('string')` 把整个部件 inflate 进内存**之后**才比较 `.length`，其中 `ppt/presentation.xml`、`ppt/_rels/presentation.xml.rels`、`xl/workbook.xml`、`xl/_rels/workbook.xml.rels` 四个部件**完全没有上限**。新增 `packages/office/zip-entry.ts` 的 `readEntry()`，用 `nodeStream()` 边读边计，超限即 `destroy()` 使剩余部分不再解压；界限不取中央目录声明的未压缩大小，因为那个数字由包的作者写。

RED 证据（本机一次性脚本，非套件）：一个 **23,851 字节**的包（因此通过 20 MB 输入检查）内含 24,000,000 字符的 `ppt/presentation.xml`，旧调用 `async('string')` **返回完整字符串且不报错**；新代码抛 `PPTX presentation XML is too large`。`xl/workbook.xml` 同样 24,000,000 字符、同样不报错。范围再放大到一个 195,899 字节的包、成员 192 MiB：旧调用 **692 ms、堆 +388 MB**；新读取器 **83 ms、无堆增长**即拒绝——界限确实在解压期生效，而不是事后判断。

五条回归进入 [office.test.ts](../tests/office.test.ts)（含「同形状的小包仍能逐部件读出」，以防读取器改变返回值），该文件实测 16 项、14 通过、0 失败、2 跳过（原有环境跳过）。

**显式模型发现：两个约束原本只是注入给它的包装。** `discoverAutomaticCapacities` 通过自定义 `fetch` 给 `discoverModels` 装上 `redirect: 'error'` 与 1 MiB 上限，于是**自动**路径两样都有、也有测试；而 CLI 与桌面入口直接调用 `discoverModels`，两样都没有——成功响应走 `response.json()`，既无字节上限也无超时，一个回了 200 之后不停写的网关就能把「最不能挂住的代码」挂住。现在策略移进探测本身（`redirect: 'error'` + 流式计入 1 MiB，超限即取消），自动路径的包装随之删除，单点决策。三条回归进入 [models-discovery.test.ts](../tests/models-discovery.test.ts)：探测自身发出 `redirect: 'error'`；真实双服务器夹具下显式发现拒绝 307，且目标主机**收到 0 个请求**；64 KiB × 64 帧的成功响应体被拒绝并释放，而 1 MiB 以内的分帧响应仍正常解析。`models-discovery.test.ts` 与 `automatic-capacity.test.ts` 共 25 项全通过，自动路径原有 9 项在移除包装后仍全通过。

**LSP 编辑预览：词法检查答错了问题。** `prepareWorkspaceEdit` 用 `path.relative` 判断目标是否在工作区内——这回答的是**服务器发来的字符串**，而工作区内一个符号链接指向外部文件时该字符串合法，随后的 `readMutationBytes` 读到的正是外部文件，其内容进入审批预览。函数上方注释写的却是「每个目标都必须 resolve 到工作区内」。现在改调 `Workspace.resolve`（拒绝**所有**符号链接，含工作区内链接，并对规范化路径重新做包含检查），失败时保留原因。新回归在 [lsp.test.ts](../tests/lsp.test.ts) 里创建指向外部目录的链接，断言编辑被拒、审批记录为空、且外部文件内容**从未出现**；无法创建链接的环境显式跳过。撤掉该调用的对照运行确认此用例**失败**（工具未拒绝），即回归可判别。`tests/lsp.test.ts` 41 项、37 通过、0 失败、4 跳过。

本轮受影响套件实测 158 项、131 通过、0 失败、27 跳过（其余为既有环境跳过）；`format:check`、`docs:check`、`references:check`、`i18n:check`、`typecheck`、`build` 全绿。

**§7.3.11：先把数字量到文件级，门禁才按事实定。** 本文 §3.2 给出的是**包对**层面：8 对双向静态值导入包。该数字既不能证明文件级 ESM 环（包的两个方向可能连接不同文件），也指向错误的修法——其中大部分反向引用是编译期擦除的纯类型导入。逐文件解析后实测：**319 个文件、792 条文件级值导入边、0 个环**。同一次测量还区分出两类非值耦合：**496 条** `import type` 或成员全为 `type` 的命名导入被排除；83 处 `import(` 出现点全部可归类——`await import(...)` 是真动态导入（pdfjs、typescript、playwright、node-pty 等按需加载），其余是**类型位置**的 import 类型查询，例如 `completion.ts:65` 的 `import('./index.ts').Acceptance[]` 与 `rpc.ts` 中大量的 `import('./index.ts').Task`，编译期擦除。

第一版测量脚本把这些类型查询当成了运行时动态导入，于是报出 1 个环（`packages/protocol/completion.ts` ↔ `index.ts`）。那是**测量错误**，已更正而非保留：该语句是类型查询，不是运行时导入。更正后的数字是 0，与「`protocol/rpc.ts` 已使用纯类型反向引用、无需为消除运行时环而重复改写」完全一致。

因此新增门禁 `npm run cycles:check`（[check-import-cycles.mjs](../scripts/check-import-cycles.mjs)）并接入聚合 `npm run check`（`ci.yml` 正是调用它）。门禁按事实定为零：静态文件级值导入环必须为 0；`import type`、成员全为 `type` 的命名导入、类型位置的 `import()` 查询一律排除；动态 `import()` **不入门禁**，因为它是打破环的正当手段（在导入模块求值完成之后才解析），脚本改为把其数量打印出来，使排除是可见的而不是默认的。可判别性已验证：临时把 `completion.ts` 的类型导入改成值导入后，门禁退出 1 并指出环的两个成员；恢复后重新通过（319 文件、792 边、0 环）。

**§7.3.14：运行器改为区分四种形状，规则按实测而定。** [run-tests.mjs](../scripts/run-tests.mjs) 的 `verifyPhases` 原先只要求阶段报告里存在 `phase-summary` 与 `run-summary`，不检查每文件摘要，于是「文件跑完」「文件在首个测试前失败」「文件里根本没有测试」三种情况都只剩退出码可看。先用真实报告器实测每种形状产生什么记录，再据此定规则：

| 形状                           | `file-summary`                      | 计数          | 退出码 |
| ------------------------------ | ----------------------------------- | ------------- | ------ |
| 正常跑完                       | 有                                  | `tests=1`     | 0      |
| `--test-name-pattern` 匹配为零 | **有**                              | **`tests=0`** | 0      |
| 首个测试前失败                 | **无**                              | —             | 1      |
| 文件里没有测试                 | **无**，且该 `case` 状态为 `passed` | —             | 0      |

关键实测结论是第二行：**被过滤掉的文件仍然写出 per-file 摘要，只是 `tests: 0`**。因此正确规则是「摘要必须存在」，而不是「每文件至少一个测试」——后者会误伤开发者用来单查一个用例的过滤运行，正是本条原先警告的情形。第四行更隐蔽：node 把「没有测试的文件」本身当作一个 `passed` 用例，只看退出码会判绿；现在按 `case` 状态把「崩溃」与「文件为空」分开报出（`(failed before reporting)` 与 `(declares no tests)`），因为两者指向不同的下一步。零测试文件另外在 stdout 打印一行并说明当时是否有过滤标记，使该形状可见而不成为错误。

四种形状固化在新增的 [test-runner-shapes.test.ts](../tests/test-runner-shapes.test.ts)：都通过**真实** `scripts/run-tests.mjs` 以子进程运行临时夹具后断言，而不是复制运行器逻辑，4 项约 1.1 秒。可判别性来自文案本身——`declares no tests` 与新汇总行只在本次改动后存在。

**§7.3.15：内核的中文按消费者逐一验证，并纳入门禁。** 本条警告的是「不要把 `packages/core` 整体加进界面规则」，而不是「不要覆盖」。所以先量集合：**55 个模块里只有 10 处含汉字的字面量**（9 个字符串 + 1 个正则），逐一按消费者分类：

| 位置                        | 内容                                       | 消费者             | 判定                                                                                                                                                                  |
| --------------------------- | ------------------------------------------ | ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `session-title.ts:17,18,22` | 会话标题提示词（3 条）                     | 模型               | **正确**：第一条本身是双语的（要求标题跟随对话语言而非界面语言），第三条含注入防护                                                                                    |
| `task-spec.ts:184-188`      | 任务草案的默认步骤与验收（4 条）           | 用户，但是**内容** | 与标题同类：用户会编辑并拥有它，在渲染时改写它正是 `desktop-app-3` 的错。属内容，但目前无条件生成中文，英文界面下仍会看到                                             |
| `agent.ts:417,580`          | 视觉未启用时的报错（2 条）                 | 用户               | **未决**：按 carrier 的既有规则，这类代码应「返回与语言无关的错误码、英文兜底、由应用词典翻译」；桌面渲染进程已用自有文案拦下常见路径，内核兜底该说哪种语言是产品决策 |
| `session-title.ts:33`       | 剥掉模型输出里 `标题:`/`title:` 前缀的正则 | —                  | 匹配文本而非产出文本；门禁逐行扫描，所以正则也要像字符串一样登记                                                                                                      |

覆盖方式是 `CORE_ALLOWED`：**带理由的清单**，与既有 `EXCLUSIONS` 同一纪律——每条必须仍然匹配到东西，否则报「该条已不再覆盖任何东西」。这样门禁的作用不是「要求翻译内核」，而是「让新增的一条成为有意识的决定」，正是本条的要求。清单不扩宽模块的导入契约：`scripts/i18n-gate.d.mts` 是**手写的最小契约**（文件自己写明只声明测试用到的两个函数），所以测试按模块名断言而不导入清单本身。

三处过程修正必须记录。**（1）** 第一次测量只收集字符串字面量，漏掉了 `session-title.ts:33` 的正则，门禁逐行扫描抓到了它——这既说明门禁的粒度是源码文本，也说明「量集合」这一步本身可能漏。**（2）** 第一版回归用 `\uXXXX` 转义写夹具，而门禁扫的是源码文本、转义是 ASCII，于是规则根本没被触发；既有测试里同样的写法也让两条断言在空转（本轮新用例已改为真实汉字并注明原因）。**（3）** 我用 PowerShell 的 `Get-Content -Raw`/`Set-Content -Encoding utf8` 往返 `tests/i18n-gate.test.ts`，破坏了该文件编码（吃掉收尾引号、中文变乱码，prettier 因而解析失败）。该文件在 HEAD 是干净的，已 `git checkout` 恢复并用 edit 工具重做，`git diff` 现在只含新增行。**教训：本环境中含非 ASCII 的文件不要经 PowerShell 文本往返。**

验证：`tests/i18n-gate.test.ts` 11 项全通过（新增 3 项：未登记字符串被报出而已登记的不会、条目失配被报出、没有内核的树不被追问）；`npm run i18n:check` 通过，且可判别——临时在 `packages/core` 放入一条未登记中文会退出 1 并点名文件与行号。

**§7.2.8：必需副本的准入与保留预算分开，并修掉由此暴露的剪枝缺陷。** 根因是 `BackupPolicy` 一个数承担了两个问题。现在拆成两件事：`BackupPolicy` 只表示「保留多少历史」，新增 `BackupAdmission` 表示「这一份必需的副本能否存在」，其 `maxBytes` 可以是明确数值或 `null`；`null` 表示「这个卷现在能装多少就是多少」——这正是「作为退路的副本」应有的判据，因为该拦住它的是磁盘，而不是一个写在别的事情上的常量。`RECOVERY_COPY_ADMISSION` 就是 `null`，另留 `RECOVERY_COPY_RESERVE_BYTES`（256 MiB）以免副本自己把卷填满。[desktop-upgrade.ts](../packages/maintenance/desktop-upgrade.ts) 的调用改为显式传入它，那句「不受例行保留约束」的注释现在才是真的。

常规路径行为完全不变：`createDatabaseBackup` 的 `admission` 默认取 `retention.maxBytes`，所以迁移备份超限仍然阻断迁移，原有 `/capacity/i` 断言未改动。

拆开时暴露出一个**此前不可达的真实缺陷**：剪枝循环的字节那一支没有排除刚生成的那一份。过去准入与保留是同一个数，走到剪枝时新副本必然满足 `bytes <= maxBytes`，缺陷被掩盖；一旦准入改为按剩余空间、而副本大于历史预算，循环就会删掉刚生成的快照，然后返回一个文件已不存在的 `DatabaseBackup`——调用方要么去复制一个不存在的文件，要么以为还有退路。现在在判断前跳过 `entry.file === destination`，其体积仍计入预算。

诊断与恢复路径：拒绝时给出的不再是一个类别，而是数字与出路——预算拒绝报「需要多少字节、允许多少字节」，空间拒绝报「需要多少、扣掉保留后可用多少、目录在哪」，并写明没有这份副本就无法回退（见 [database-maintenance.ts](../packages/storage/database-maintenance.ts) 的 `assertCopyAdmitted`）。

三条回归进入 [database-maintenance.test.ts](../tests/database-maintenance.test.ts)：被常规预算拒绝的副本在调用方声明「必需」后被接纳且文件确实在盘上；**大于历史预算的副本不被该预算剪掉**（去掉守卫即失败，可判别）；`backupDatabase` 采纳调用方给的准入、默认仍是常规预算。该文件 18 项、15 通过、3 跳过（原有环境跳过），连同升级与迁移套件共 32 项、0 失败。限制：空间拒绝本身需要一块几乎写满的卷才能触发，本机无法构造，因此**未覆盖**，此处不作声称。

**§7.3.12：5 条失配白名单完成真实复核并重新登记。** 复核的是每条 `reason` 自己承诺的那句话，而不是重跑一遍测试：

- 5 个测试文件里有 4 个**只引入** `node:test` 与 `node:assert/strict`，物理上无法触达子进程、套接字或文件系统；`host-requests.test.ts` 全文读过，纯进程内，且它仅有的两处定时器等待断言的是「没有迟到的拒绝」，唤醒延迟不会致其失败。
- 6 个变更输入（含本轮改动的 `database-maintenance.ts`）**零顶层语句**，所以 import 它们不执行任何东西——这才是「纯单元测试的传递依赖」该问的问题。
- 其余通道逐一排除：无 `process.env` 赋值、无 `chdir`、无 `homedir()`/`.yuantu`、无固定端口、无固定临时名。
- 结构事实：node 以**独立子进程**运行每个测试文件，模块级状态因此不是通道，跨文件通道只剩外部资源，而每一项外部资源都不存在。

结论是原判仍成立，28 个哈希重新登记，每条 `reason` 追加了本次复核做了什么，而不是重述原句。诊断从 `Policy: entries=16 parallelised=11 awaiting-review=5` 变为 **`entries=16 parallelised=16 awaiting-review=0`**，并行阶段由 11 个文件扩到 16 个；新增的 5 个已实测在并行阶段（5 文件、并发 2）34/34 通过，策略自身的测试 36/36 通过。

**§7.3.15：内核面向人的中文改由词典承接（3 条），草案文案记为未决（4 条）。** 量出的集合是 10 处，逐条判定后发现**不需要新机制**：DOM 遍历器的中文→英文索引 `domText` 是从 `messages` **派生**的（`for (const pair of Object.values(messages)) domText.set(pair[0], pair[1])`），所以把内核消息按**原文**加进 `attach.*` 就能获得翻译能力，既不必发明错误码边界，也不必把内核改成英文——CLI 中文优先、进程里没有词典，内核保持中文才是对的。

因此新增三条 `attach.*`：两处 [agent.ts](../packages/core/agent.ts) 的视觉报错，以及 [renderer-attachments.ts](../apps/desktop/renderer-attachments.ts) **自己的**那条同义文案。最后一条是复核中发现的既有缺口：渲染模块被门禁豁免的理由是「遍历器会翻译它」，而遍历器只翻译**词典里已有的原文**，那条文案不在词典里，于是一直以中文出现在英文界面。

四条任务草案文案**未改**，因为机制上说不过去：`renderer-tasks.ts:219` 以 `input.value = value` 渲染步骤，而遍历器只处理文本节点与 `placeholder`/`aria-label`/`title`，不处理 `value`——给这四条加词典条目不会产生任何效果。它们要按界面语言**生成**，而内核并不知道该语言，属产品决策，记为未决而不是假装修好。

用源码原文作键还带来一个恰好需要的好处：只有应用自己、未被编辑过的默认文本会命中并被翻译；用户改过的草案文本与键不再相等，因此**不会**在渲染时被改写——这正是 `desktop-app-3` 要求的。

**一次失败的全量运行，以及它教会的东西（记录而非掩盖）。** 本轮验证期间，第 4 轮的一次全量运行报出 3 项失败（2300 项中）。逐项追查的结论是**与被改动的代码无关**：失败断言直接给出 `Windows workspace ACL is leased by another process or needs recovery: …\workspace-owner.lock`，而当时确实有另一个 `run-tests.mjs` 进程（`--timings=artifacts/remaining-repairs-20261015/full-timings.json`，09:30 启动）在同一台机器上运行。该租约由 `open(lockPath,'wx')` 独占创建、无陈旧检测，所以两个套件都会失败；这在 [sandbox-windows.test.ts:834](../tests/sandbox-windows.test.ts#L834) 早有记录。处置方式：不去终止那个运行（它属于使用者），而是等待并在租约空闲后单独复测，同时把「同一时间只跑一个套件」写成验收纪律（见 §7.1）。

**干净环境下的单套件全量结果：2308 项、2193 通过、1 失败、114 跳过**（串行 1699 秒；并行阶段 16 文件 / 112 项 / 0 失败 / 1.98 秒）。与租约争用那次的差别本身就是证据：**3 项失败降为 1 项**，其中 2 项确为争用所致。

剩下的那 1 项**未解决，且与 §7.2.8/§7.3.12/§7.3.15 的改动无关**：`tests/host-workflows.test.ts` 的「Host cancellation after command effects kills the command and retains uncertainty across reload」，报 `Error: the foreground command did not write pid.txt within 15s`（[process-pid-fixture.ts:35](../tests/process-pid-fixture.ts#L35)）。该测试在隔离运行下**稳定复现**（19.5 秒，本次运行的日志中租约错误为 **0** 处），因此不是抖动、不是并发、也不是沙箱租约：它等待的是工具路径 spawn 出来的 `node wait.cjs` 写出自己的 PID，而在窗口内该文件从未出现，运行也未进入终态。就本次改动而言不存在路径关联——我改的两个源模块中，[database-maintenance.ts](../packages/storage/database-maintenance.ts) 只在备份准入与剪枝上变化（普通调用的准入默认仍取 `retention.maxBytes`，原有 `/capacity/i` 断言未改；剪枝守卫只会少删一个文件），[i18n.ts](../apps/desktop/i18n.ts) 只增三条桌面词典条目，二者都无法使一个前台命令停止写出 PID 文件。

同一工作树里唯一的大块未提交源码改动正好落在会决定运行终态的区域：[agent.ts](../packages/core/agent.ts) 有 185 行改动（stop hook 与完成终结顺序的重排，含新增的 `snapshotCompletionInputs` 调用），并伴有新增的 `tests/completion-finalization.test.ts`（测试文件数由 226 增至 227、用例数由 2300 增至 2308 即来自此）。**这属于使用者未完成的进行中工作，本报告不将其归因于自己、也不替其收尾**；此处只如实记下「该失败存在、可复现、不是本轮改动引入、最可能的位置在完成终结流程」这一层级，不声称已定位根因。

**这些数字会动，因为树在同一时间被另一个人改。** 写这段时测得的行为测试文件数是 **228**（226 → 227 → 228），期间另一个工作流持续在写 `packages/storage/session-schema.ts`、`apps/desktop/renderer*.ts`、`turn-changes.ts` 等文件，连本节新增的三条词典条目所在的 `i18n.ts` 也在 10:29 被其改过一次（条目本身完好）。由此得到比「一次只跑一个套件」更强的一条：**一份可信的全量结论需要一个静默的树**——一个写入者。当唯一写入者是本人时，定向套件、门禁与构建足以支撑本条目的结论；跨工作流的全量数字则应等树静止后再取，并且不把重叠期间的失败算到任何一方头上。

## 7. 后续建议（与已修复项分开）

### 7.1 先建立可用且可归因的验收环境

1. 在环境所有者授权的独立工作区或 VM 复测 Office、regex worker 和安装校验；先核实标签、脚本授权与依赖，不默认递归修改当前工作区的安全标签。
2. Office 将脚本授权/启动拒绝与 COM 未安装分开诊断，明确测试的环境跳过规则；执行策略参数应按目标环境决策，不能把强制 Bypass 或“全部跳过”当作功能验收。
3. 对 `files.ts` 的规范化后名称检查补充人工凭据夹具，只有确实生成 8.3 别名时才声称完成别名回归；避免读取真实凭据验证安全边界。

**一次只能跑一个套件（本轮实测）。** Windows 的沙箱 ACL 租约是**机器级独占**的：`~/.yuantu/sandbox-state/windows/workspace-owner.lock` 由 `open(lockPath,'wx')` 独占创建，代码注释写明「One Host owns persistent ACL changes at a time」，且没有陈旧检测。因此**两个测试套件同时运行时，双方都会失败**，而失败面看起来与原因毫无关系——本轮实测是 `tests/native-git.test.ts` 的「real platform sandbox Git status preserves the repository index」与 `tests/host-workflows.test.ts` 的「Host cancellation after command effects…」，断言里直接出现 `Windows workspace ACL is leased by another process or needs recovery: …workspace-owner.lock`。仓库本身已记录过同一连锁反应（[sandbox-windows.test.ts:834](../tests/sandbox-windows.test.ts#L834) 记的触发原因是带中日韩字符的工作区其日志恢复失败，导致「unrelated suites began failing on a tree that had not changed」）。

由此得到一条验收纪律：**同一台机器上同一时间只跑一个套件**；与另一次运行重叠所得出的「N 项失败」不能作为关于代码树的证据。这一条同时解释了本轮一次全量运行出现 3 项失败的原因——它与本次改动无关，且这些测试在干净环境下（第 3 轮全量 2325 项、0 失败）是绿的。

### 7.2 条件性安全与可靠性问题

4. TCP carrier 在正式对外使用前需要认证、绑定范围决策和拒绝连接错误处理；默认桌面走 stdio，应保留这一触发条件。认证设计不靠一个连接上限代替，也不必未经评估直接复制另一桥的实现。
5. `workspace.apply` 的审批保证与实际 RPC 写路径不一致，应明确协议信任边界或接入实际检查；现有桌面没有调用该 RPC，不当作默认用户流程缺陷。
6. 生命周期 hook 的只读信息与门禁需一致；把原裁决指出的 `SessionStart` 路径和部分不可达的 `SessionEnd` 路径分开验证。
7. `git.ts` 应把捕获上限内的完整内容交给 registry，由既有 spill 机制保存；已经未捕获的输出无法靠移除截断标记恢复。
8. 将升级恢复副本的准入与常规备份保留配额分开，针对**紧实后的副本**超过 512 MiB 的情况提供诊断与恢复方案。
9. 对 Office 解压、显式模型发现的重定向及响应字节、LSP 编辑预览路径做对应边界回归；不要扩大成所有协议或所有默认桌面调用均可触发。
10. 修复仍可重现的 resident 子代理用量归属；异步文件观察的丢弃 Promise 需补错误隔离及受控调度测试，未证明生产故障前维持限定结论。

### 7.3 结构性与流程改进

11. 依赖治理先统计**文件级值导入**，区分类型耦合与运行时循环，再按实际问题增加门禁。`protocol/rpc.ts` 已使用纯类型反向引用，无需为消除运行时环而重复改写。
12. 原串行全量耗时约 24.5 分钟；当前白名单有 **16/224** 条，哈希仍匹配的只有 **11/224** 条。`npm test` 默认仍是串行，扩大白名单后还需显式使用 `test:partitioned` 并测量收益；不能把白名单数量直接等同于 CI 已经并行的文件数。
13. 核对打包布局中的 ripgrep lock 与二进制解析，增加编译/打包布局验收；不能因源码布局的资产测试通过就认定打包快路径可用。
14. 测试运行器应区分正常文件摘要、提前退出、合法过滤为零用例等形状；以每文件摘要与过滤标记验证，避免简单要求“每文件至少一个测试”误伤过滤运行。
15. i18n 按 shared service 与桌面翻译边界增加覆盖；原生对话框、附件错误、预览语言与用户文本应分别处理。代码中未被门禁扫描的字符串仍需按消费者验证，不等于都应翻译核心包。

**第 2 轮状态（详见 §6.7）**：§7.1.2、§7.1.3、§7.2.7、§7.2.10、§7.3.13 **已完成**，各有可复现验证；§7.1.1 **部分完成**（已完成无需改标签的 A/B 复现，未在 VM 或另一台机器复测）；§7.3.12 **部分完成**（诊断、可见性与测量已完成，白名单哈希未重新登记）。

**第 3 轮状态（详见 §6.8）**：§7.2.9 **已完成**，三项各有可判别的边界回归（Office 解压、显式模型发现的重定向与响应字节、LSP 编辑预览路径），前两项各自修掉一个真实缺陷而非仅补测试。§7.3.11 **已完成**：文件级实测为 0 个值导入环，门禁按该事实定为零并已接入 `npm run check`，可判别性经过对照验证。§7.3.14 **已完成**：四种文件形状按实测区分（正常 / 过滤为零 / 崩溃退出 / 文件无测试），规则是「摘要必须存在」而非「每文件至少一个测试」，并固化为 4 项回归。

**第 4 轮状态（详见 §6.8）**：§7.2.8 **已完成**——必需副本的准入与历史预算拆成两个概念，并顺带修掉一个此前不可达的剪枝缺陷（会删掉刚生成的快照）；常规迁移行为未变。§7.3.12 **已完成**——5 条失配条目按各自 `reason` 承诺的内容做了真实复核，28 个哈希重新登记，`awaiting-review` 由 5 归零，并行文件由 11 增至 16，且新增的 5 个已实测并发通过。§7.3.15 **部分完成**——内核面向人的 3 条中文改由桌面词典承接（复用派生索引，不新增机制），4 条任务草案文案因渲染在 `input.value` 上、遍历器不处理该位置而**记为未决**，需产品决策而非门禁能定。仍**未改动**的是 §7.2.4、§7.2.5、§7.2.6（需先做认证方式与协议信任边界决策）；§7.1.1 维持部分完成，需环境负责人授权的独立工作区。

## 8. 改动归属与工作树状态

原审计留下 [tests/macos-packaging.test.ts](../tests/macos-packaging.test.ts) 的未提交修复：Windows prepack 分支原先依赖未跟踪的 staged runtime，现在在临时目录中自建 runtime/manifest/license fixture，再调用 hook。本次该文件 8/8 通过。这个夹具问题可能在没有预先打包的 Windows/Linux checkout 出现；不能声称任何 CI 都必然缺少文件。

上一轮本会话修改了完成状态、存储、符号服务及 `repo_map`，新增两份回归测试并更新 README；§6.6 记录验证结果。开始本次文档复核时，上述代码、原审计的 macOS 测试改动及 `docs/` 均尚未提交。本次修改主评估文档，保留原审计/裁决作为历史材料，不修复其余产品问题，不改标签或 ACL，也未提交 Git。

第 2 轮（§6.7）另改了：`packages/core/run-residency.ts`、`packages/office/automation.ts`、`packages/search/ripgrep-assets.ts`、`packages/tools/fs-observation.ts`、`packages/tools/git.ts`、`scripts/copy-search-assets.mjs`、`scripts/run-tests.mjs`，以及测试 `tests/fs-observation.test.ts`、`tests/native-sandbox-bundle.test.ts`、`tests/office.test.ts`、`tests/search-ripgrep.test.ts`、`tests/spill.test.ts`、`tests/windows-install-safety.test.ts`，新增 `tests/subagent-usage.test.ts`。`tests/snapshots/*.json` 重新录制，差异已在 §6.7 逐字审查。`README.md` 由 `npm run docs:generate` 重写事实块。仍未提交 Git，除 `tests/snapshots/` 与上述文件外没有别的改动来源需要归因。

`27bb603` 的 Git 元数据记录作者名 `sunjun`、时间 2026-10-14 18:05:40 +0800。这只能证明提交元数据，不能证明实际操作人一定是用户而非代其提交的 agent。原全量测试没有冻结工作树内容的清单，不能据此断言测试全程只读取了该提交的字节，或保证并行工作从未发生内容变化。

## 9. 证据附录

原始审计与逐条裁决报告归档在 [docs/audit-2026-10-14/](audit-2026-10-14/)（36 份：7 份子系统审计 +
29 份逐条裁决）。本次保留这些文件原文；它们包含已被纠正或需限定的结论，当前结论以本文对应条目为准。

| 子系统                             | 审计报告                                                                                | 裁决文件数 |
| ---------------------------------- | --------------------------------------------------------------------------------------- | ---------: |
| 内核                               | [core-kernel.audit.md](audit-2026-10-14/core-kernel.audit.md)                           |          3 |
| 工具与沙箱                         | [tools-sandbox.audit.md](audit-2026-10-14/tools-sandbox.audit.md)                       |          3 |
| 存储/协议/载体                     | [storage-protocol-carrier.audit.md](audit-2026-10-14/storage-protocol-carrier.audit.md) |          4 |
| 桌面端                             | [desktop-app.audit.md](audit-2026-10-14/desktop-app.audit.md)                           |          3 |
| 宿主与装配                         | [hosts-assembly.audit.md](audit-2026-10-14/hosts-assembly.audit.md)                     |          6 |
| 集成（providers/MCP/LSP/Office/…） | [integrations.audit.md](audit-2026-10-14/integrations.audit.md)                         |          5 |
| 构建/CI/测试                       | [build-ci-tests.audit.md](audit-2026-10-14/build-ci-tests.audit.md)                     |          5 |

**已知缺口**：7 条 `R1-` 项缺少对应报告和独立裁决文件，原作者还提到未取回的汇总内容，但本次无法独立恢复。要补齐其证据，应逐条创建人工夹具，记录触发条件、原始输出与失败断言；不能仅以“另一个验证者确认过”代替可检查的证据。

## 10. 复现命令

```powershell
# 文档门禁（本次文档修改后实际执行）
npm.cmd run format:check
npm.cmd run docs:check
npm.cmd run references:check

# 源码门禁与构建（上一轮修复后已通过；需要刷新时再运行）
npm.cmd run i18n:check
npm.cmd run typecheck
npm.cmd run build

# 刷新全量行为测试（原串行全测约 24.5 分钟）；本轮用 test:partitioned 重跑并记入 §6.7
npm.cmd test

# 原失败文件当前复测：第 2 轮 23 项，19 通过、0 失败、4 跳过（跳过均写明环境原因）
node --test --test-reporter=spec --test-concurrency=1 tests/macos-packaging.test.ts tests/native-sandbox-bundle.test.ts tests/office.test.ts tests/windows-install-safety.test.ts

# 第 2 轮修复的回归（§6.7）：4 通过 / 16 通过 / 13 通过 1 跳过 / 15 通过 / 9 通过 2 跳过
node --test tests/subagent-usage.test.ts tests/fs-observation.test.ts tests/spill.test.ts tests/search-ripgrep.test.ts tests/office.test.ts
# 打包布局验收（§7.3.13）：真实暂存脚本搭建布局，真实模块副本仅凭 process.resourcesPath 解析
node --test --test-name-pattern='packaged layout' tests/search-ripgrep.test.ts
# 快照（§6.7）：录制后 4/4；重新录制前先逐字审查差异，不要直接接受
node --test tests/turn-snapshot.test.ts
npm.cmd run snapshot:update
# 全量并行调度实测（约 21.7 分钟；串行阶段 2308 项）
npm.cmd run test:partitioned

# 新增完成状态与检索回归：上一轮 13/13
node --test --test-reporter=spec --test-concurrency=1 tests/completion-finalization.test.ts tests/search-consistency.test.ts

# 当前并行资格；只打印计划，不执行测试、不刷新白名单哈希
node scripts/run-tests.mjs --schedule=partitioned --plan

# 白名单逐输入哈希核对（§6.7）：列出仍匹配与已过期的条目及变更输入，当前 matching=11 stale=5
node -e "const{readFile}=require('node:fs/promises');const{createHash}=require('node:crypto');(async()=>{const p=JSON.parse(await readFile('test-parallel-safe.json','utf8'));let ok=0,stale=0;for(const e of p.entries){const bad=[];for(const i of e.inputs){let a=null;try{a=createHash('sha256').update(await readFile(i.file)).digest('hex')}catch{}if(a!==i.sha256)bad.push(i.file)}if(bad.length){stale++;console.log('STALE '+e.file+' <- '+bad.join(', '))}else ok++}console.log('matching='+ok+' stale='+stale)})()"

# 实际类型检查范围，包含从测试导入的脚本
npx.cmd tsc --noEmit --listFiles | Select-String 'scripts[/\\]|benchmarks[/\\]'

# 只读环境标签检查；Low 标签本身不等于完整产品验收结论
icacls "E:\agent-desktop\YuanTu-Foundry"
icacls "E:\agent-desktop\YuanTu-Foundry\packages\office\automation.ps1"
icacls "E:\agent-desktop\YuanTu-Foundry\node_modules\@esbuild\win32-x64\esbuild.exe"

# 逐条裁决
Get-ChildItem docs\audit-2026-10-14\*.verdict.md
```

§3 的源码统计口径可用以下只读脚本复核。这里只计算顶层静态导入，不据此证明文件级运行时循环：

```powershell
@'
import ts from 'typescript';
import fs from 'node:fs/promises';
import path from 'node:path';
const root = process.cwd(), files = [], graphs = [new Map(), new Map()];
async function walk(dir) {
  for (const item of await fs.readdir(dir, {withFileTypes: true})) {
    const file = path.join(dir, item.name);
    if (item.isDirectory()) await walk(file);
    else if (/\.(ts|mts)$/.test(item.name)) files.push(file);
  }
}
await walk('packages'); await walk('apps');
const group = (file) => path.relative(root, path.resolve(file)).split(path.sep).slice(0, 2).join('/');
let lines = 0;
for (const file of files) {
  const text = await fs.readFile(file, 'utf8'), from = group(file), seen = new Map();
  lines += text.split('\n').length;
  const ast = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  for (const node of ast.statements) {
    if (!ts.isImportDeclaration(node) || !ts.isStringLiteral(node.moduleSpecifier)) continue;
    const name = node.moduleSpecifier.text;
    if (!name.startsWith('.')) continue;
    const to = group(path.resolve(path.dirname(file), name)), c = node.importClause;
    if (to === from || !/^(packages|apps)\//.test(to)) continue;
    const typeOnly = c && (c.isTypeOnly || (!c.name && c.namedBindings &&
      ts.isNamedImports(c.namedBindings) && c.namedBindings.elements.length > 0 &&
      c.namedBindings.elements.every((e) => e.isTypeOnly)));
    seen.set(to, (seen.get(to) ?? false) || !typeOnly);
  }
  for (const [to, value] of seen) {
    const key = from + '|' + to;
    graphs[0].set(key, (graphs[0].get(key) ?? 0) + 1);
    if (value) graphs[1].set(key, (graphs[1].get(key) ?? 0) + 1);
  }
}
const pairs = (g) => [...g.keys()].filter((key) => {
  const [a,b] = key.split('|');
  return a.startsWith('packages/') && b.startsWith('packages/') && a < b && g.has(b + '|' + a);
});
console.log({files: files.length, lines, pairsIncludingTypes: pairs(graphs[0]).length,
  pairsWithValueImports: pairs(graphs[1]).length});
'@ | node --input-type=module
```
