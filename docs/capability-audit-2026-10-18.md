# 项目能力缺陷与优化清单（2026-10-18）

更新：第 1—8 节保留首轮审查的发现与证据。随后使用真实模型复核了新出现的修复，并新增 CAP-09 和任务执行优化项；最新状态见第 9 节及[真实模型复核报告](validation-capability-live-2026-10-18.md)，不要继续将首轮“未修复”视为当前状态。

## 1. 范围、基线与证据口径

本文第 1—8 节整理首轮能力审查发现的 **8 项产品缺陷、1 项测试契约回归和 3 项主要优化建议**，补充对应的触发条件、证据、修复方向、验收条件及验证边界，供修复与交接使用。真实模型复核新增事项另列于第 9 节。

- 仓库：`E:\agent-desktop\YuanTu-Foundry`。
- 基线提交：`da82953a9efc3625e64fff36e7b204f4e67c057a`；实际审查对象包含大量未提交改动，不能把结论归属于这个提交的纯净版本。
- 日期：2026-10-18，Asia/Shanghai。
- 审查方式：当前源码调用链核查、现有定向测试、内存 mock、临时 SQLite 故障注入及临时 Git 仓库复现。
- 本轮只整理文档，没有实施下列产品修复。此前轻量复现夹具已清理；本文描述复现步骤和观察值，不声称仓库保留了这些独立探针脚本。
- 整理期间工作树仍有并行改动。本文重新核对关键路径，并把新出现的优化实现单独标注；没有重新执行全部行为测试。

相关报告：

- [架构与性能问题汇总](architecture-performance-issues-2026-10-18.md)：保留此前架构、性能审查及原始 34 项问题的状态对照。
- [架构与性能原始复核](review-2026-10-18-architecture-performance.md)：历史测量及原始问题编号。
- [早期修复状态](review-2026-10-18-fix-status.md)：包含多个时间点，部分结论已被后续改动更新。
- [项目架构说明](architecture-2026-10-17.md)：架构背景。

本报告与上述报告存在重叠，例如恢复事务、快照成本、桌面刷新。执行修复时按代码根因合并工作项，避免重复实施；历史报告中的“未修复”不能直接作为当前状态。

| 证据状态         | 本文含义                                                                   |
| ---------------- | -------------------------------------------------------------------------- |
| 已复现：mock     | 调用真实函数并注入受控依赖，确认分支行为；不代表真实服务端或桌面端到端验收 |
| 已复现：故障注入 | 在临时数据库等夹具注入失败，确认异常处理结果；不声称生产自然发生过         |
| 已复现：临时仓库 | 使用临时文件和仓库安排确定性并发编辑，确认实际快照结果                     |
| 源码确认         | 调用链和数据处理方式已核查，尚无对应端到端或性能测量                       |
| 已有实现、待验收 | 整理时发现并行代码已加入改进；本聊天尚未验证该实现的完整效果               |
| 待验证边界       | 当前能力需要额外环境或真实场景验证，不按已确认缺陷计数                     |

P1 表示可能破坏工作区隔离、应优先修复；P2 表示有条件触发的正确性问题。测试回归与性能建议分别管理，不与产品缺陷数量混算。

## 2. 能力概览

| 能力域           | 当前源码能力                                                        | 本次主要结论                                                          |
| ---------------- | ------------------------------------------------------------------- | --------------------------------------------------------------------- |
| 模型与上下文     | Anthropic、OpenAI Chat、Responses，流式解析、用量、上下文预算与压缩 | 未发现足以列入本次清单的新协议缺陷；未连接真实模型端点验收            |
| 文件与命令工具   | 文件读写、精确编辑、补丁、撤销、后台命令和终端                      | 主链路具备；Windows 命令清理的 5 个沙箱失败用例在正常权限下复跑通过   |
| 权限与沙箱       | 会话策略、审批、派发前活策略复核、文件和网络约束                    | 旧权限串会话问题已在当前源码修复；host 模式仍按设计不构成操作系统隔离 |
| 会话存储与恢复   | SQLite 事件日志、投影、租约、中断恢复及显式恢复入口                 | CAP-02：恢复异常可能提交部分状态                                      |
| 子代理与工作区   | 委派、驻留、冷恢复、消息、隔离快照和结果导出                        | CAP-01、CAP-03、CAP-04：恢复隔离、快照一致性和跨轮进度存在问题        |
| 任务、目标与计划 | 持久任务、步骤检查点、验收、计划审批和续跑                          | 相关机制已有实现；本次没有真实模型复杂任务成功率或长时间无人值守验收  |
| 搜索与知识       | 分页、全文扫描、覆盖状态、符号索引、Markdown 记忆、FTS5/bm25        | CAP-05、CAP-07：降级覆盖信息和知识新鲜度存在误导风险                  |
| MCP、LSP 与资源  | MCP 工具/资源/提示/OAuth，语言服务和编辑诊断，项目及内置 Skills     | CAP-06、CAP-08；内置技能公告还引发 REG-01 测试契约回归                |
| Office           | DOCX/PPTX 纯 JS 创建编辑，XLSX 处理，HTML 预览与外部 PDF 转换       | 已接通；内容、真实版式、字体及公式重算需要分别验收                    |
| 桌面与 CLI       | Electron 主进程、preload、Carrier、CLI 与维护命令                   | CLI 当前启用；MCP 管理页与备份页停用是产品范围设置，不作为缺陷        |

入口开关见 [product-scope.ts](../packages/protocol/product-scope.ts)。当前 `cli: true`、`mcpManagement: false`、`backups: false`；Web、SDK、ACP 的退出不按功能断链计算。

## 3. 产品缺陷总表

| 编号   | 级别 | 问题                               | 证据                          | 修复验收重点                                       |
| ------ | ---- | ---------------------------------- | ----------------------------- | -------------------------------------------------- |
| CAP-01 | P1   | 隔离子代理冷恢复后使用父工作区工具 | 已复现：mock                  | 工具根、修改归属和结果导出必须使用原有子工作区绑定 |
| CAP-02 | P2   | 崩溃恢复失败后提交部分恢复         | 已复现：故障注入              | 失败对象完整回滚，其他对象继续恢复                 |
| CAP-03 | P2   | 快照可混入从未同时存在的文件版本   | 已复现：临时仓库              | 发布和复用前检测来源变化                           |
| CAP-04 | P2   | 常驻子代理跨轮进度携带旧 runId     | 已复现：mock                  | 当前轮收到文字、工具和统计进度                     |
| CAP-05 | P2   | 搜索降级丢失不完整枚举信息         | 已复现：mock                  | 原始 coverage 保留，不能误报完整                   |
| CAP-06 | P2   | LSP 未分析完成却报告无错误或警告   | 已复现：mock                  | 未完成状态不能作为诊断通过                         |
| CAP-07 | P2   | 知识源刷新失败仍无标记返回旧内容   | 已复现：临时文本和内存 SQLite | 命中及零命中均能说明来源新鲜度                     |
| CAP-08 | P2   | MCP 目录加载期间的更新通知被吞掉   | 已复现：mock                  | 加载中的通知保留版本差并触发后续重读               |

### CAP-01：隔离子代理冷恢复后使用父工作区工具

**位置与调用链：**

- [run-residency.ts](../packages/core/run-residency.ts)：`resume()` 在约第 143 行调用 `childTurns()`，未恢复、传入持久化工作区 `binding`。
- [runtime.ts](../apps/shared/runtime.ts)：约第 378 行，`childTools(binding)` 缺少绑定时使用父 `workspace` 创建工具。
- [run-child-turns.ts](../packages/core/run-child-turns.ts)：约第 326 行决定 `journalSessionId`，约第 362 行决定是否导出 worktree 结果。

**触发条件：** general 子代理已分配隔离 worktree；Host 重启或子代理因 TTL/LRU 等机制卸载；父代理通过 `send_message` 再次要求该子代理修改文件。

**复现与影响：** 调用真实 `createResidentMessageTool → createChildTurns`，使用受控存储、工具工厂和 Agent 执行替身，得到：

```json
{
  "receivedBinding": null,
  "factoryRoot": "E:/project/original",
  "expectedFactoryRoot": "E:/worktrees/isolated-child",
  "journalOwner": "parent",
  "expectedJournalOwner": "child"
}
```

探针未执行实际文件修改，但已确认恢复后的工具根和修改记录归属错误。子代理上下文可能仍指向原隔离目录，实际文件和命令工具却作用于父目录，并跳过子工作区结果导出。

**建议：** 冷恢复先经 workspace manager 解析并校验该 child session 的原绑定，再传入 `childTurns`。绑定丢失、已删除或无效时明确拒绝执行，不能回退父目录。保留共享 explore 子代理的现有语义。

**验收条件：** 重启或卸载后继续隔离子代理，文件和命令根仍为子目录；修改记入 child；父目录不变；结果可导出；无效绑定拒绝恢复。

### CAP-02：崩溃恢复异常导致部分提交

**位置：** [session-runs.ts](../packages/storage/session-runs.ts) 的 `reconcileInterruptedRuns()`，约第 198 行为整批外层事务，第 223 行起逐会话捕获异常；`settleAbandonedRun()` 在记录最终中断事件前已经更新多个状态。[session-tasks.ts](../packages/storage/session-tasks.ts) 的子代理恢复存在相似结构。

**触发条件：** 恢复已经追加未知工具结果、更新 run、清除 active run 或 lease 后，后续某个写入语句失败；异常被逐对象 `catch` 吞掉，外层继续提交。

**故障注入复现：** 在临时 SQLite 对 `run.interrupted` 的插入设置 `RAISE(ABORT)`，观察结果：

```json
{
  "recovered": 0,
  "run": { "status": "interrupted" },
  "active": { "active_run": null },
  "tools": 1,
  "interruptedEvents": { "n": 0 }
}
```

这是语句失败路径的确定性验证，不是生产自然故障复现。影响是状态与日志不一致，且 run 已不再为 running，后续扫描可能不会补齐中断记录。把可失败读取前移只能缩小风险，不能保证后续写入成功。

**建议：** 每个恢复对象使用独立事务，或使用 savepoint；回滚范围同时覆盖 SQLite 写入及待发布事件、缓存状态。子代理恢复中的父会话通知也纳入同一对象的一致性边界。

**验收条件：** 在各写入边界注入失败，失败对象完整回滚；其他对象仍能恢复；修复故障后可再次恢复；重复执行不会重复追加未知工具结果或中断通知。

### CAP-03：工作区快照可形成混合基线

**位置：** [snapshot.ts](../packages/workspaces/snapshot.ts) 的 `freezeSnapshot()`，整理时约第 212 行只执行一次 `collectWorkingTree()`，随后构树和发布；`verifySnapshotStable()` 有定义但未接入冻结流程。

**触发条件：** 用户、构建工具或其他代理在收集工作树期间编辑多个关联文件。单文件长度校验不能识别相同长度的改写，也不能证明不同文件来自同一稳定版本。

**确定性复现：** 临时仓库初始 `a.txt=old,z.txt=old`；读完 a 后，夹具按顺序把 a 和 z 改为 new，再继续读取 z。函数成功返回 `{a:old,z:new}`，该组合从未在真实工作树共存。

**影响：** 子代理可能分析不一致的源码输入，产生错误结论或不可用改动；manifest 哈希自洽不等于来源稳定。

**建议：** 发布新快照以及复用已发布快照前，复核来源路径集合、模式和内容哈希；发现变化时拒绝或有界重试。两次采集可检测上述竞态，但不等同于对任意并发写入提供文件系统原子快照；若要承诺更强一致性，需要额外的协调或快照机制。

**验收条件：** 用两文件确定性并发编辑覆盖此问题；不一致来源必须被识别；检查新增、删除、改名及等长改写；既有快照复用不能绕过来源校验。

### CAP-04：常驻子代理跨父 run 的实时进度丢失

**位置与调用链：** [run-residency.ts](../packages/core/run-residency.ts) 约第 162 行优先复用旧 activation；[run-child-turns.ts](../packages/core/run-child-turns.ts) 约第 49 行捕获首次创建时的 `emit`，后续 turn 继续使用；[run-emit.ts](../packages/core/run-emit.ts) 标记原 runId；[session-controller.ts](../packages/client/session-controller.ts) 约第 1018 行过滤不属于当前 run 的事件。

**触发条件：** 第一轮委派完成，子代理仍驻留；第二轮父 run 通过 `send_message` 继续它。

**复现：** 使用真实 residency、turn builder、emitter 和 message tool，观察到同一次后续执行的 `subagent.delta` 属于 `parent-run-1`，`subagent.finished` 属于 `parent-run-2`。

**影响：** 后续执行的文字、工具、token/time 等实时进度被客户端过滤，最终结果仍能到达。

**建议与验收：** 每次 turn 绑定当前父 run 的事件接收器；保留子代理身份与转录。跨两轮执行时，当前轮收到实时进度与结束事件，旧轮不接收新进度，也不重复计量。

### CAP-05：搜索降级丢失枚举覆盖信息

**位置：** [service.ts](../packages/search/service.ts) 约第 254 行的 backend fallback 未向 `scanText()` 传入原始 `inventory.coverage`；环境准备失败后的降级入口见 [search-backend.ts](../packages/tools/search-backend.ts)。

**触发条件：** 搜索后端已准备，但执行环境拒绝或准备失败，进入内置扫描；文件枚举此前已因 entry-limit、read-error 等原因不完整。

**复现：** 对真实 `WorkspaceSearchService.search()` 注入 `complete:false,reasons:['entry-limit'],entriesVisited:200000` 的 inventory，通过与环境拒绝一致的 backend fallback 执行，结果变为 `complete:true,reasons:[],entriesVisited:0`。未执行真实沙箱搜索程序。

**影响：** 部分扫描被当成完整扫描，尤其零命中时可能误导模型断言仓库没有相关内容。

**建议与验收：** fallback 合并原始枚举 coverage 和正文扫描 coverage；同时覆盖有命中、零命中、枚举截断、读错误及环境拒绝，确保任何未覆盖来源均不会变成完整扫描。

### CAP-06：LSP 未完成分析却显示无错误或警告

**位置：** [tools.ts](../packages/lsp/tools.ts) 约第 59 行，编辑后注解在空诊断分支输出 `no errors or warnings` 并继续，跳过 `settled` 检查。

**触发与复现：** 真实 `attachDiagnostics()` 接收 mock 客户端结果 `{diagnostics:[],settled:false}`，仍添加 `a.ts: no errors or warnings`，没有分析未完成提示。

**影响：** 服务器慢或尚未发布诊断时，工具给出错误的修改验收信号。本问题集中在编辑后注解，不等于所有独立诊断工具都存在同样问题。

**建议与验收：** 先检查完成状态。覆盖“空且未完成、空且完成、有诊断且未完成、有诊断且完成”四种情况；只有完成且无诊断时才能报告未发现错误或警告。

### CAP-07：知识源刷新失败后无标记返回旧内容

**位置：** [store.ts](../packages/knowledge/store.ts) 约第 358 行捕获刷新错误并保留原索引；[tools.ts](../packages/knowledge/tools.ts) 返回内容及来源但不返回新鲜度；[files.ts](../packages/resources/files.ts) 的 `resourceText()` 限制单文件不超过 32KiB。

**触发条件：** 已索引文档增大超过限制、临时不可读或变成非 UTF-8。保留旧索引有可用性价值，但不能不告知其刷新失败。

**复现：** 使用内存 SQLite 索引临时文档 `Deploy instruction: OLD_COMMAND`，再把源文件改为包含 `NEW_COMMAND` 的 33KiB 文档。搜索旧命令仍返回旧内容，搜索新命令为空，两种结果均无刷新失败标识。

**影响：** 可能继续向模型提供过时部署命令、决策或规则；零命中也可能只是来源没有更新成功。

**建议：** 返回 freshness、lastIndexedAt 和 refreshError 等明确信息；结果级元数据应覆盖没有命中的失败来源。是否扩大文档上限属于另外的容量设计，不应以放大上限替代过期提示。

**验收条件：** 超限、权限错误、文件删除、无效编码均有明确结果；暂时失败可保留旧内容但标为过期；来源恢复后能重新索引并清除错误状态。

### CAP-08：MCP 目录加载期间的更新通知被吞掉

**位置：** [tools.ts](../packages/mcp/tools.ts) 约第 495 行，在加载完成后执行 `loadedGeneration = this.generation`；约第 444 行据此判断是否跳过重载。

**触发条件：** 服务器在 `listTools()` 请求或分页尚未完成时发送 `notifications/tools/list_changed`。本次返回的目录可能仍是旧目录，却被标记为当前版本。

**复现：** 调用真实 `mcpTools()`，mock SDK Client 在第一次返回旧目录前触发通知。连续两次 `list_tools` 均返回 `old_tool`，底层 `listTools` 调用总数为 1；未连接真实 MCP 服务。

**影响：** 新工具可能持续不可见或报未知工具，直到后续通知或重连。源码注释表达了防止该竞态的意图，但当前赋值时机未保留版本差。

**建议与验收：** 加载开始时捕获 generation，以该值标记本次目录版本；加载期间通知使其落后，下一次请求重读。覆盖分页期间通知、并发目录请求及连续通知；不因通知立即无界重载。

## 4. 测试契约回归 REG-01

**状态：已复现；阻塞当前定向测试全部通过。**

[builtin-skills.ts](../packages/resources/builtin-skills.ts) 新增内置 `office-documents`；[skills.ts](../packages/resources/skills.ts) 在空工作区也发现该技能；[run-snapshots.ts](../packages/core/run-snapshots.ts) 把技能目录公告为 runtime-context 用户消息。

本轮剩余 7 个非环境失败来自：

- [context-envelope.test.ts](../tests/context-envelope.test.ts)：1 例，期望空技能目录，实际存在内置技能。
- [core.test.ts](../tests/core.test.ts)：6 例，消息数量、位置或用户消息序列的断言未区分 runtime-context 与人的输入。

这些失败不能直接解释为队列或模型身份功能已坏；首先需要统一内置技能公告与测试契约。

**建议：** 保留模型发现内置技能的产品意图，统一使用现有 runtime-context 识别规则区分机器上下文和人的输入，再更新受影响断言。按业务语义查找消息，避免固定数组位置。若决定改变公告行为，应作为明确的产品语义变更单独验收，不能只为测试变绿隐藏技能。

**验收条件：** 空工作区能发现并加载内置技能；上下文 envelope 如实记录实际技能目录；模型身份落在正确用户轮次；队列 FIFO、取消和 steer 断言只统计相应业务消息；全量行为测试重新运行。

## 5. 优化建议及整理时状态

### OPT-01：按命令影响范围刷新桌面数据

**原观察：** Carrier 每条命令尾部统一刷新会话列表、文件改动、审计、任务历史与后台状态；审批、回答问题或编辑队列也承担无关 RPC 成本。

**整理时更新：已有实现、待集成验收。** [service.ts](../packages/carrier/service.ts) 已新增 `RefreshScope`、`refreshScopeFor()` 和可选择范围的 `refresh(scope)`，命令尾部已使用该选择器。`approve`、`questionAnswer`、`enqueue`、`clearQueue`、`cancel` 使用缩小范围，其他命令保留完整刷新。[carrier.test.ts](../tests/carrier.test.ts) 已出现范围选择断言。本轮没有重新运行这些新增改动的完整测试。

**剩余工作：** 验证事件驱动的后续刷新足以更新任务、改动及后台面板；根据测量再细化其他命令。不要继续将“每条命令仍无条件全刷新”列为当前缺陷。

**验收：** 记录审批、提问答复、入队、取消前后的 RPC 数量和耗时；使用真实 Carrier/Host 验证最终视图一致、跨会话旧响应不覆盖新状态；不能只验证选择器返回值。

### OPT-02：缩小输入与流式文本的渲染范围

**状态：源码确认，未做当前树真实窗口帧率测量。**

- [renderer-commands.ts](../apps/desktop/renderer-commands.ts) 的 `onInput()` 更新命令面板后仍调用 `requestRender()`；[renderer.ts](../apps/desktop/renderer.ts) 将该回调指向整窗 `render()`。
- [renderer-live.ts](../apps/desktop/renderer-live.ts) 每 100ms 重新渲染当前预览正文，虽限制了最大预览长度，重复解析成本仍会随当前文本增长。
- [i18n.ts](../apps/desktop/i18n.ts) 的 MutationObserver 会扫描新增子树；中文下翻译函数早退不等于没有 DOM 遍历成本。

**建议：** 输入仅更新命令面板及依赖输入的状态；依据 section/revision 更新其他视图；缓存已经完成的 Markdown 块及代码高亮，避免重复解析不变前缀。翻译逻辑减少无须翻译的子树遍历，同时保留运行时语言切换。

**验收：** 固定短会话、长会话、长代码块回答三类夹具，比较按键延迟、长任务和每次渲染成本；验证 IME 输入、自动滚动、展开思考、语言切换、历史加载和停止后最终文本均正确。不把源码推断写成已经测得的掉帧结论。

### OPT-03：降低工作区快照内存与重复读取

**状态：部分缓解，剩余成本由源码确认。**

[snapshot.ts](../packages/workspaces/snapshot.ts) 已有 512MiB 总输入预算和分块 manifest 写入；不能继续使用旧报告“没有总预算”的结论。剩余成本包括所有文件 base64 常驻、识别已发布快照前先读取编码整树，以及读取已有 manifest 带来的额外驻留。本次没有重新测量峰值内存。

**建议：** 评估 manifest 只引用 Git blob、内容按需读取；增加已有快照复用路径，并与 CAP-03 来源稳定性校验一起设计，不能为快路径跳过变化检查。格式升级必须保留完整性验证与旧数据处理策略。

**验收：** 小仓库、多小文件、接近输入预算的工作树分别测量峰值 RSS、耗时、输出大小；覆盖重复冻结、取消、超限、旧格式读取、损坏对象以及临时文件清理。任何性能数字需说明机器负载、样本及测量方法。

## 6. 已有修复与待验证边界

### 6.1 不再沿用的旧结论

| 历史说法                                 | 本次核对结果                                                                                                        |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| 权限预设仍会串会话                       | 当前按 session 保存策略并筛选待审批对象；不列入本次缺陷                                                             |
| 没有显式会话恢复入口                     | 已有 `session.recover` RPC、存储与 CLI 路径                                                                         |
| 审批等待没有截止时间                     | 工具策略已有 `approvalMs`；仍需保留超时、取消和迟到答复的回归                                                       |
| 桌面退出完全没有超时                     | 已有 `quit-deadline.ts` 与退出步骤截止时间                                                                          |
| 快照没有总输入预算                       | 已有 512MiB 预算；CAP-03 与 OPT-03 仍成立                                                                           |
| 检索始终受旧的 1000 文件、256KB 规则限制 | 当前已有流式检索、分页和 coverage；本次问题是 CAP-05 特定降级分支                                                   |
| Office 创建编辑全部依赖 COM              | 当前 DOCX/PPTX 创建编辑为纯 JS；外部引擎主要用于 PDF 预览                                                           |
| CLI 当前停用                             | 当前开关为启用                                                                                                      |
| Host 尚无 bundle 构建                    | 整理时已出现并接入 `build-host-bundle.mjs`，桌面路径优先选择 bundle；本轮未验证其启动收益、打包资产或完整协议兼容性 |
| Carrier 每条命令都无条件全刷新           | 整理时已出现范围刷新实现，见 OPT-01                                                                                 |

Host bundle 入口见 [构建脚本](../scripts/build-host-bundle.mjs)、[安装路径选择](../apps/desktop/install-paths.ts) 和 [package.json](../package.json)。脚本中的性能说明来自该改动作者，本报告未独立复测，不将其数字作为本聊天测量结果。

### 6.2 独立验收项

以下是验证边界，不额外计入 8 项确认缺陷：

- 真实模型端点：三种协议的流式、重试、压缩、工具调用及用量统计，需要端到端验证。
- 桌面真窗口：本轮未验证全部交互、渲染性能、长会话和恢复后的用户流程。
- Windows/macOS 原生隔离、安装签名、公证及升级：定向测试或构建产物存在不等于目标平台生产验收。
- Office：HTML 预览是结构或数据预览；PDF 引擎、字体、真实版式、内容和 Excel 公式重算需分别验收。`verify_file_delivery` 的结构、大小和 SHA-256 不能证明语义正确。
- 任务、目标及复杂重构：已有验收机制不等于真实任务成功率达标；需独立任务集和长期运行测试。
- 跨 Host 合入及启动恢复竞争：存在需要继续调查的源码疑点，但本轮未完成端到端复现，不作为已确认问题。
- 依赖漏洞现状：本轮未重新获取在线漏洞报告，不复用旧数量宣称当前安全；发布时单独运行现有审计门禁。

## 7. 实际验证记录

### 7.1 前一轮静态检查

下列 7 项在本聊天前一轮实际运行并返回退出码 0：`typecheck`、`docs:check`、`references:check`、`cycles:check`、`layers:check`、`i18n:check`、`test:isolation:check`。其结果对应当时工作树，不代表整理期间并行新增代码已经全部复验。

### 7.2 定向行为测试

首次运行 ID：`1792296361280-18388-277e0244-5f0d-45ed-af09-51dc4ecf0051`。Node `v24.19.0`，13 个测试文件，并发 3，继续收集失败。

| 文件                        | 用例    | 通过    | 失败   | 解释                                   |
| --------------------------- | ------- | ------- | ------ | -------------------------------------- |
| carrier.test.ts             | 16      | 16      | 0      | 对应当时 Carrier 实现                  |
| client.test.ts              | 44      | 44      | 0      | 客户端定向验证                         |
| context-envelope.test.ts    | 9       | 8       | 1      | REG-01                                 |
| core.test.ts                | 43      | 35      | 8      | REG-01 六例；命令终止环境失败两例      |
| desktop.test.ts             | 18      | 18      | 0      | 非完整真窗口验收                       |
| host-workflows.test.ts      | 17      | 14      | 3      | 命令清理环境失败三例                   |
| product-scope.test.ts       | 4       | 4       | 0      | 当前产品开关                           |
| quit-deadline.test.ts       | 3       | 3       | 0      | 退出截止时间                           |
| resources.test.ts           | 24      | 24      | 0      | 资源与技能                             |
| session-lease.test.ts       | 21      | 21      | 0      | 租约与显式恢复                         |
| storage-rules.test.ts       | 14      | 14      | 0      | 存储规则                               |
| tool-timeout.test.ts        | 13      | 13      | 0      | 工具及审批超时                         |
| workspace-snapshots.test.ts | 11      | 11      | 0      | 既有快照测试不覆盖 CAP-03 的确定性场景 |
| **合计**                    | **237** | **225** | **12** | 无跳过、取消或 todo；运行退出码 1      |

这 8 项新缺陷大多来自额外轻量探针，并非上述测试套件已经覆盖；现有相关测试通过不能否定探针所确认的分支问题。

正常 Windows 权限复跑 ID：`1792296778796-21300-fafee6cf-27b6-4673-ac2d-bb678a0a108e`，仅筛选首次失败的 5 个命令执行与清理用例，**5/5 通过，退出码 0**。据此将这 5 个首次失败归为本次执行环境限制，不列为产品停止逻辑缺陷。它们不能用来消除另外 7 个测试契约失败。

首次测试遗留的三个等待进程已交叉核对 PID、脚本名与创建时间后清理；本次测试私有临时根目录也已确认删除，没有清理其他会话的目录。

关键日志：

- 上下文目录失败：`.scratch/test-logs/1792296361280-18388-277e0244-5f0d-45ed-af09-51dc4ecf0051-parallel-context-envelope.test.ts-MCHtRe.log`。
- 内核失败详情：`.scratch/test-logs/1792296361280-18388-277e0244-5f0d-45ed-af09-51dc4ecf0051-parallel-core.test.ts-AgUFkm.log`。
- Host 首次命令清理失败：`.scratch/test-logs/1792296361280-18388-277e0244-5f0d-45ed-af09-51dc4ecf0051-parallel-host-workflows.test.ts-dOKjVT.log`。
- 正常权限内核复跑：`.scratch/test-logs/1792296778796-21300-fafee6cf-27b6-4673-ac2d-bb678a0a108e-parallel-core.test.ts-pKWpDF.log`。
- 正常权限 Host 复跑：`.scratch/test-logs/1792296778796-21300-fafee6cf-27b6-4673-ac2d-bb678a0a108e-parallel-host-workflows.test.ts-SnM45J.log`。

日志是本机证据，位于未纳入版本控制的 `.scratch/test-logs/`，新克隆未必包含，因此仅列证据路径而不建立仓库文档链接。需对外分享完整证据时应另行归档日志，不能将本地日志视为可重建的持久附件。

### 7.3 复跑入口

以下命令会对执行时的当前工作树运行测试，不会还原审查时的历史源码。

```powershell
$auditTests = @(
  'tests/core.test.ts',
  'tests/context-envelope.test.ts',
  'tests/resources.test.ts',
  'tests/carrier.test.ts',
  'tests/client.test.ts',
  'tests/tool-timeout.test.ts',
  'tests/session-lease.test.ts',
  'tests/workspace-snapshots.test.ts',
  'tests/host-workflows.test.ts',
  'tests/product-scope.test.ts',
  'tests/quit-deadline.test.ts',
  'tests/storage-rules.test.ts',
  'tests/desktop.test.ts'
)
node scripts/run-tests.mjs --continue-on-failure --concurrency=3 --test-timeout=45000 @auditTests
```

在具有正常命令终止权限的 Windows 环境复核 5 个环境失败用例：

```powershell
node scripts/run-tests.mjs --continue-on-failure --concurrency=1 '--test-name-pattern=unchanged program reads|programs deriving new results|Host cancellation after command effects|Host keeps background jobs across turns|Host deletes a session with managed commands' tests/core.test.ts tests/host-workflows.test.ts
```

## 8. 修复顺序与完成标准

1. **CAP-01 隔离恢复**：先恢复工作区边界，避免后续任务写入错误目录。
2. **CAP-02 恢复事务、CAP-03 快照一致性**：确保持久状态与任务输入可信。
3. **REG-01 测试契约**：统一上下文语义，恢复稳定回归基线；可与前述修复独立推进。
4. **CAP-04 至 CAP-08**：修复实时进度及检索、诊断、知识、MCP 的结果可信度。
5. **OPT-01 至 OPT-03**：先验收已出现的范围刷新，再以测量驱动渲染与快照优化。
6. **完整验收**：定向回归后运行全量行为、构建、客户端与桌面冒烟，并按发布范围单独执行覆盖率、基准及平台验收。

交接时，每项记录修复提交、修改文件、回归用例、执行命令、结果和剩余边界。复现消失时先定位是哪项并行改动修复，不重复实施旧建议。不以更新报告状态、增加函数或只通过单元测试作为完整验收。

本聊天尚未运行完整 `check`、`check:release`、桌面真窗口全套、覆盖率、基准及打包发布流水线。文档交付不代表上述 8 项缺陷、测试回归或优化工作已经完成。

## 9. 真实模型复核后的更新

已用当前连接 `DeepSeek-V4.1-Flash`，对冻结的 474 个源码与配置文件执行真实 Host、真实模型和工具场景。完整记录见[真实模型复核报告](validation-capability-live-2026-10-18.md)与[机器证据](validation-capability-live-2026-10-18.json)。

| 项目             | 最新可确认状态                                                                             |
| ---------------- | ------------------------------------------------------------------------------------------ |
| CAP-01、CAP-04   | 子代理热继续、重启后冷继续、目录隔离、修改归属及结果导出通过选定真实模型场景               |
| CAP-02           | 真实运行崩溃后结合数据库故障注入，恢复失败完整回滚，解除故障可再次收敛                     |
| CAP-03、CAP-05   | 源码已有修复；快照并发变化和搜索降级截断组合尚未重新实测                                   |
| CAP-06           | 真实 TypeScript 服务延迟诊断时明确报告未完成，最终查询才无诊断；空且未完成分支尚未强制覆盖 |
| CAP-07           | 旧知识命中和空查询均带过期标记，来源恢复后返回新知识且不再过期                             |
| CAP-08           | 真实 MCP stdio 进程在目录加载期间通知变化，触发第二次读取，新工具可调用                    |
| REG-01           | 真实 Office 技能加载使用通过；首轮 7 个单元回归本轮未整体复跑                              |
| OPT-01 至 OPT-03 | 本轮未做 GUI、Carrier RPC A/B 或快照峰值内存验收，不能由真实模型任务成功推断优化完成       |

### CAP-09：LSP 显式启动命令被继承 package 遮蔽

P2，已通过真实语言服务器启动失败及实际解析器复现。[servers.ts](../packages/lsp/servers.ts) 合并内置配置时继承 package，本地安装对应包后，解析器优先使用包入口，覆盖用户显式配置的 command，导致自定义包装器未执行。临时配置清空继承字段后可启动；这只是本轮测试绕过，不是产品修复。

建议显式 command 覆盖时清除未被显式指定的旧 package 绑定，保留默认 npm 入口的 Windows 兼容路径。应补覆盖前后安装本地包、绝对命令及包装器参数的回归。证据和验收细节见真实模型复核报告第 4 节。

### 新增真实任务优化项

- **LIVE-OPT-01：减少简单文件任务对 shell 的依赖。** 本次 7 字节文件任务用了 9 次请求，出现预期文件不存在和 Windows 命令语法失败；模型恢复后文件正确，但运行因未确认 effect 保持 needs_review，显式验收后才完成。
- **LIVE-OPT-02：明确显示待复核调用及验收状态。** 不能只展示模型“完成”的自然语言；需区分产物检查、运行状态与显式验收。该项本轮没有真窗口验证，不据此断言当前界面完全没有相关提示。

本轮保留了工装分页参数、布尔配置、缺依赖、LSP 配置覆盖及额外字节断言等失败记录，没有把最终成功整理成一次无介入全通过。完整验证限制、实际 token 用量及清理情况见真实模型复核报告。
