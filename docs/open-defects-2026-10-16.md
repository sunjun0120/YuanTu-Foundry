> **恢复说明（2026-10-17）**：本文件原始版本于本轮扫描期间从工作树丢失，且未被 git 跟踪。这里的内容是从悬空对象中的 2026-10-16 07:47 快照恢复的早期修订；最终 2026-10-16 20:31 修订无法恢复。此后各轮的修复与裁决见 [`docs/rescan-2026-10-17.md`](./rescan-2026-10-17.md) 与 [`docs/fulltest-2026-10-17.md`](./fulltest-2026-10-17.md)。

# 未完成问题清单（按优先级）

**快照时间：2026-10-16 07:47（+0800）** · HEAD `27bb603` · 工作树状态：94 个文件已修改、27 个未跟踪、**未提交**

> **这份清单的时效性前提。** 汇总时检测到另一写入者**正在改动工作树**：`apps/agent-host/handlers/workspaces.ts` 写于 07:45:30，`tests/workspace-orphans.test.ts` 写于 07:46:55。因此本清单是**那一刻的快照**，其中 P0-1 明确处于收尾中。任何全量结论都必须等写入者停止、快照冻结之后重取。
>
> 本文档只做汇总与排序，**不修改任何产品代码、测试或他人的文件**。

## 0. 怎么读这份文档

**优先级判据**（不是照抄原审计的 high/medium/low，而是「现在该先做什么」）：

| 级别   | 含义                                                               |
| ------ | ------------------------------------------------------------------ |
| **P0** | 阻塞其它一切结论：正在进行的改动，或让「已验收」失去意义的前提缺失 |
| **P1** | 安全边界仍有缺口，或**默认路径**上用户/调用方可见的错误            |
| **P2** | 触发条件受限的缺陷、健壮性与维护缺口                               |
| **P3** | 有意的安全取舍、需要产品决策、以及流程与文档债                     |

**证据等级**（每条都标注，避免把推测当事实）：

| 等级  | 含义                                                     |
| ----- | -------------------------------------------------------- |
| **A** | 源码事实，且我本人或审计读过对应回归断言确实能判别该机制 |
| **B** | 静态审计给出的 `文件:行` 源码事实，未独立复跑验证        |
| **C** | 需要产品决策、环境条件或原始报告才能收敛                 |

**统计**：P0 3 项 · P1 4 项 · P2 9 项 · P3 6 项；原审计 34 条跟踪项中 **17 条已修、17 条仍开**（见附录 A）。

## 1. P0 — 阻塞验收

### P0-1 会话删除后的 workspace 绑定清理与恢复（进行中）

- **对应**：`storage-protocol-carrier-2`（原 medium）
- **现状**：存储层与协议已就绪，Host 入口**刚刚补上**，测试仍在写——属于「写着、还没验证」。
- **证据**：外键 `session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL`（[session-current-schema.ts:215](../packages/storage/session-current-schema.ts#L215)）；删会话只级联删行（[session-lifecycle.ts:121-141](../packages/storage/session-lifecycle.ts#L121-L141)）；新 handler [workspaces.ts:63-66](../apps/agent-host/handlers/workspaces.ts#L63-L66) 与 `manager.orphaned()`、`session-workspaces.ts:258-273` 的 `orphaned()` 配合；`tests/workspace-orphans.test.ts` 在写中。
- **证据等级**：B（源码事实）+ 该批改动**不在** 2026-10-15 全量快照内，文档自己也如此声明（`tcp-carrier-auth-validation-2026-10-15.md` 的「验证证据」末段）。
- **下一步**：等写入者停止后，对「删会话 → 绑定可寻址 → 清理/恢复」这条链做定向验证，再纳入全量。

### P0-2 冻结快照的全量验收缺失

- **现状**：2026-10-15 的全量是**绿的**，但它对应的是当天冻结的 679 文件快照；2026-10-16 的改动（`workspaces/manager.ts`、`protocol/rpc.ts`、`storage/session-workspaces.ts`、`storage/sqlite.ts`、`handlers/workspaces.ts`、新增 `tests/workspace-orphans.test.ts`）全部晚于它。
- **证据**：全量结果与哈希范围记录在 `tcp-carrier-auth-validation-2026-10-15.md` 的「验证证据」小节（229 文件 / 2464 项 / 2350 通过 / 0 失败 / 114 跳过 / exit 0）。
- **证据等级**：A（另一写入者的完整记录 + 我核对到后续文件的修改时间确实更晚）。
- **下一步**：唯一写入者停止 → 冻结（提交或哈希清单）→ `npm run check` + 全量 + `smoke:client` → 才可对外声称「全量通过」。

### P0-3 工作树未提交，归因基线缺失

- **现状**：`HEAD 27bb603`（2026-10-14），94 改 + 27 未跟踪。任何失败都无法判定属于哪一批改动，也无法回退。
- **证据**：`git log --oneline -3`、`git status --porcelain`（本快照实测）。
- **证据等级**：A。
- **下一步**：与 P0-2 一起处理：先提交（或至少产出全树哈希清单），再取验收结论。

## 2. P1 — 安全边界或默认路径仍有缺口

### P1-1 `SessionStart`/`SessionEnd` 生命周期 hook 没有只读门，且执行命令不经审批

- **对应**：`integrations-1`（原 medium）
- **现状**：另四类事件都有 `if (readOnly) return`，这两类没有；更关键的是它们的**上下文类型里根本没有 `readOnly` 字段**，桥无法检查类型没有的东西。hook 执行命令走 `prepareSandbox` + `spawn`，不产生审批。
- **证据**：[hook-bridge.ts:185-206](../packages/resources/hook-bridge.ts#L185-L206)（无条件执行）、[:112](../packages/resources/hook-bridge.ts#L112)/[:132](../packages/resources/hook-bridge.ts#L132)/[:151](../packages/resources/hook-bridge.ts#L151)/[:171](../packages/resources/hook-bridge.ts#L171)（其他四类的门）、[tool-hooks.ts:10-19](../packages/protocol/tool-hooks.ts#L10-L19)（类型无该字段）、[hook-bridge.ts:278-296](../packages/resources/hook-bridge.ts#L278-L296)（无审批执行）；关闭开关 `YUANTU_HOOK_BRIDGE=0` 仍在。
- **证据等级**：A（我自己复核过 `readOnly` 门与字段缺失）。
- **已知边界**：这是**文档化的 Claude-Code 兼容设计**，不是意外；沙箱确实经 `underSessionPolicy` 安装。要解决的是「桥自称的第三道门对生命周期事件失效」。
- **下一步**：产品决策——统一只读约束与信任边界（该写入者的队列第 3 项）。需要「计划模式会话 + 声明 SessionStart 钩子」的端到端回归。

### P1-2 `office_inspect` 的 DOCX/XLSX 解压仍无上限（残余 zip 炸弹面）

- **对应**：`integrations-4`（原 medium，**部分修复**）
- **现状**：编辑读取路径已改为解压中计数（`readEntry()`）；但 `office_inspect` 只检查 **20 MB 压缩输入**，随后把整份 bytes 交给 mammoth / SheetJS，两者都按部件一次性 inflate。
- **证据**：[tools.ts:33-46](../packages/office/tools.ts#L33-L46)（`readFile` → 20 MB 检查 → `mammoth.extractRawText` / `XLSX.read`）；已修部分 [zip-entry.ts:20-63](../packages/office/zip-entry.ts#L20-L63)、[read.ts:36-45](../packages/office/read.ts#L36-L45)、[spreadsheet.ts:36-45](../packages/office/spreadsheet.ts#L36-L45)；回归只覆盖已修的一半 [office.test.ts:588-653](../tests/office.test.ts#L588-L653)。
- **证据等级**：A（我本人复读了 `inspect()` 的实现）。
- **不确定点**：未实际构造 zip 炸弹（静态核对），第三方库内部是否有兜底未逐行确认。
- **下一步**：给 `inspect` 路径也加解压中界限（复用 `readEntry` 的读取器，或用声明尺寸做前置拒绝），并补 DOCX/XLSX 炸弹夹具。

### P1-3 面向人的文案双向漏出字典

- **对应**：`desktop-app-1`（原 medium）
- **现状**：英文模式下运行状态、导出文件与会话拒绝文案仍是中文；权限标签方向已修（中文模式下不再是英文）。
- **证据**：[renderer.ts:393-410](../apps/desktop/renderer.ts#L393-L410)（状态字面量不经 `t()`）、[renderer-commands.ts:142-153](../apps/desktop/renderer-commands.ts#L142-L153)（导出文件标题硬编码）、[renderer-attachments.ts:147-191](../apps/desktop/renderer-attachments.ts#L147-L191)（拒绝文案 + 文件名前缀使整串查表失效）；已修的一半 [renderer-permissions.ts:88-95](../apps/desktop/renderer-permissions.ts#L88-L95)。两道门禁为何放过：[i18n-gate.mjs:54-57](../scripts/i18n-gate.mjs#L54-L57) 整类豁免 `renderer*.ts`，DOM 扫描只走固定面板。
- **证据等级**：B（静态审计 + 我核对过豁免规则存在）。
- **下一步**：与 P1-4、P2-9 一起做「内容 vs 界面」边界决策（该写入者队列第 2 项）。

### P1-4 i18n 遍历器会改写应用并不拥有的文本

- **对应**：`desktop-app-3`（原 low，但用户可见）
- **现状**：遍历器把任何**与词典源文相等**的文本改写掉；会话标题、工作区条目名只要撞上 UI 文案（如 `工作区`、`刷新`）就会被显示成另一种语言。
- **证据**：[i18n.ts:1104-1131](../apps/desktop/i18n.ts#L1104-L1131)（查表改写，且 `会话 <hex>` 整串改写）、[renderer-session-list.ts:61](../apps/desktop/renderer-session-list.ts#L61)、[renderer-workspace.ts:229](../apps/desktop/renderer-workspace.ts#L229)；无对应回归。
- **证据等级**：B。
- **下一步**：同一决策：给「内容容器」加豁免，或保存可恢复的属性原文（写入者队列第 2 项的措辞）。

## 3. P2 — 受限触发的缺陷、健壮性与维护缺口

| #    | 问题（原 ID）                                                                                | 现状与证据                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | 等级 |
| ---- | -------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- |
| P2-1 | **stdio 入站无界缓冲**（`hosts-assembly-4`，**部分修复**）                                   | TCP 已加 16 MiB 有界分帧；默认 stdio 仍是 [carrier.ts:87](../apps/agent-host/carrier.ts#L87) 的无上限 readline，尺寸门在整行组装之后（[dispatch.ts:84](../apps/agent-host/dispatch.ts#L84)）。出站 `send()` 丢弃 `write()` 返回值、不等 drain                                                                                                                                                                                                                                                 | B    |
| P2-2 | **`session.get` 不带 `offset` 返回整份 transcript 且无字节上限**（`hosts-assembly-5`）       | [history.ts:22-36](../apps/agent-host/handlers/history.ts#L22-L36) 直接返回全部消息，15 MB 页界只在分页分支（[:95-130](../apps/agent-host/handlers/history.ts#L95-L130)）；且被 [history-window.test.ts:135-139](../tests/history-window.test.ts#L135-L139)、[large-response.test.ts:123-124](../tests/large-response.test.ts#L123-L124) 锁定为兼容行为                                                                                                                                       | B    |
| P2-3 | **上下文窗口溢出被误报为 `output-limit`**（`R1-core-2`）                                     | [run-request.ts:423-433](../packages/core/run-request.ts#L423-L433) 只在 `lastCompactionProblem` 有值时抛 `ContextLimitError`；额度耗尽分支（[:159-169](../packages/core/run-request.ts#L159-L169)）不赋值 → 落到 [:450-465](../packages/core/run-request.ts#L450-L465) → 最终 [:514-561](../packages/core/run-request.ts#L514-L561) 报 `output-limit`。缺「终态形状 + 额度耗尽」回归（[overflow-recovery.test.ts:196-306](../tests/overflow-recovery.test.ts#L196-L306) 只覆盖另外两种组合） | A    |
| P2-4 | **按 UTF-16 下标切分工具结果会劈开代理对**（`R1-core-3`）                                    | [shrink.ts:63-80](../packages/core/shrink.ts#L63-L80)、[:137](../packages/core/shrink.ts#L137) 仍用 `.length`/`slice`；同级 [prune.ts:60-68](../packages/core/prune.ts#L60-L68) 已按码点并注释原因。影响仅限星平面字符                                                                                                                                                                                                                                                                        | A    |
| P2-5 | **无时区 daily 触发器的 catch-up 标签可能报出规则未命名的时刻**（`R1-core-5`，**部分修复**） | 正向路径已修（[task-trigger.ts:178-202](../packages/core/task-trigger.ts#L178-L202) + [tasks.test.ts:58-91](../tests/tasks.test.ts#L58-L91)）；catch-up 分支 [:256-267](../packages/core/task-trigger.ts#L256-L267) 仍裸 `setHours` 无 `named` 校验，结果被 [scheduler.ts:244-249](../apps/agent-host/scheduler.ts#L244-L249) 持久化为 `scheduledAt`                                                                                                                                          | A    |
| P2-6 | **摘要校准用权重自身归一化**（`core-kernel-3`）——**有争议，需确认**                          | [context.ts:946](../packages/core/context.ts#L946) 两参观测 → [calibration.ts:178](../packages/core/calibration.ts#L178) 用 `weights` 归一化，[budget.ts:121-130](../packages/core/budget.ts#L121-L130) 把该参数当字节；但同处 [:173-177](../packages/core/calibration.ts#L173-L177) 的注释明确主张「调用方说不出分部件时的唯一诚实读法」就是整体按比例移动，所以这是**待确认的判定**、不宜直接当缺陷改；现有测试只覆盖等权重或无 parts 分支                                                  | A    |
| P2-7 | **被内容过滤的响应被 chat 适配器报成干净的 `stop`**（`integrations-5`）                      | [openai.ts:306-309](../packages/providers/openai.ts#L306-L309) `content_filter → 'stop'`；[responses.ts:260-263](../packages/providers/responses.ts#L260-L263) 一律 `'length'`，全仓不读 `incomplete_details.reason`；[providers.test.ts:765-773](../tests/providers.test.ts#L765-L773) 的夹具恰好是两种说法一致的那一支                                                                                                                                                                      | B    |
| P2-8 | **基准运行配置入库，含本机路径、清单哈希与实盘预算授权**（`build-ci-tests-4`）               | `benchmarks/coding-evaluation/local/` **13 个文件受版本控制**（`git ls-files` 实测），[.gitignore:1-15](../.gitignore#L1-L15) 无规则；[pilot-config.json:7](../benchmarks/coding-evaluation/local/pilot-config.json#L7)/[:46-52](../benchmarks/coding-evaluation/local/pilot-config.json#L46-L52) 等钉住 `E:\agent-desktop\YuanTu-Foundry`、该机清单哈希与 `authorized: true, maxAttempts: 2`                                                                                                 | A    |
| P2-9 | **4 条任务草案默认文案仍无条件中文**（`R1-core-4` 残余）                                     | [task-spec.ts:183-188](../packages/core/task-spec.ts#L183-L188) 无条件生成中文；渲染位置是 `input.value`（[renderer-tasks.ts:219](../apps/desktop/renderer-tasks.ts#L219)），遍历器不处理该位置，词典机制到不了 → 英文界面下仍是中文。**需产品决策**（内核不知道界面语言）                                                                                                                                                                                                                    | A    |

## 4. P3 — 有意取舍、产品决策与流程/文档债

| #    | 事项                                                              | 现状与证据                                                                                                                                                                                                                                                                                                                                                                 | 等级 |
| ---- | ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- |
| P3-1 | **没有显式压缩维护命令**（`storage-protocol-carrier-4`）          | 全仓 `VACUUM` 只有备份/恢复用的 `VACUUM main INTO ?`（[database-maintenance.ts:385](../packages/storage/database-maintenance.ts#L385)、[:591](../packages/storage/database-maintenance.ts#L591)），无裸 `VACUUM`/`auto_vacuum`，维护 CLI 无 `db-compact`（[apps/cli/main.ts:197-208](../apps/cli/main.ts#L197-L208)）。空闲页会被复用，且 backup→restore 可间接回收        | B    |
| P3-2 | **macOS 已执行命令的私有临时目录无有界回收**（`tools-sandbox-2`） | [seatbelt-scratch.ts:22-29](../packages/tools/seatbelt-scratch.ts#L22-L29) 已启动即不清理，唯一删除路径只服务未启动的计划；测试把「存活」断言为期望（[seatbelt-scratch.test.ts:25-39](../tests/seatbelt-scratch.test.ts#L25-L39)）。原判已否掉进程级清扫（会误删并发目录）→ **安全取舍**                                                                                   | B    |
| P3-3 | **未保存的语言预览与主进程持久语言不一致**（`desktop-app-2`）     | 预览即时改渲染进程（[renderer-general-settings.ts:107-112](../apps/desktop/renderer-general-settings.ts#L107-L112) → [i18n.ts:1151-1167](../apps/desktop/i18n.ts#L1151-L1167)），主进程语言保存后才同步（[main.ts:919-928](../apps/desktop/main.ts#L919-L928)）；分工本身有测试记录（[settings.test.ts:781-800](../tests/settings.test.ts#L781-L800)）→ **可争议，属决策** | B    |
| P3-4 | **主评估文档状态过期**                                            | [architecture-capability-assessment-2026-10-14.md](architecture-capability-assessment-2026-10-14.md) §6.1 仍写 HIGH-1「规范化后未复查名称规则」的源码事实仍在（实际已在 [files.ts:179-181](../packages/tools/files.ts#L179-L181) 复查），§6.2 仍把 HIGH-2 记为未认证（实际已修）；34 条的关闭状态也未重算。另有多份验证记录分散（本目录 4 份），缺单一索引                 | A    |
| P3-5 | **流程优化项**                                                    | 测试并行调度（白名单 16 条 vs 229 个测试文件）、大模块职责收敛（`sqlite.ts`、`agent.ts` 等）。属优化，不属缺陷                                                                                                                                                                                                                                                             | C    |
| P3-6 | **环境/平台验收缺口**（无法在本机完成）                           | Office COM 实际可用性受本机脚本授权限制、真实 WFP 网络隔离、签名安装/受保护安装与卸载、macOS 行为、原生托管 worktree。跳过项不等于功能验收                                                                                                                                                                                                                                 | C    |

## 5. 已修复（对照，避免重复投入）

| 原 ID                                   | 修复要点与证据                                                                                                                                                                                                                                                                                                                                                             |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `R1-tools-credential-8dot3`（high）     | `realpath` 之后把名称规则重新应用到**规范化**路径：[files.ts:179-181](../packages/tools/files.ts#L179-L181)、[:168-174](../packages/tools/files.ts#L168-L174)；回归造真实 8.3 别名 [credential-paths.test.ts:60-92](../tests/credential-paths.test.ts#L60-L92)（别名未生成的环境会自我跳过）                                                                               |
| `hosts-assembly-1`（high）              | 回环白名单 + `YUANTU_HOST_TOKEN` + `timingSafeEqual` + 首帧认证：[carrier.ts:26-36](../apps/agent-host/carrier.ts#L26-L36)、[:262-287](../apps/agent-host/carrier.ts#L262-L287)、[host-auth.ts](../packages/protocol/host-auth.ts)；回归 [host-carrier-auth.test.ts:65-96](../tests/host-carrier-auth.test.ts#L65-L96)；记录见 `tcp-carrier-auth-validation-2026-10-15.md` |
| `R1-core-1`                             | 历史工具按逻辑项目作用域装配：[agent.ts:309-345](../packages/core/agent.ts#L309-L345)；回归 [session-query.test.ts:620-678](../tests/session-query.test.ts#L620-L678)                                                                                                                                                                                                      |
| `core-kernel-1` / `core-kernel-2`       | resident 用量归属折叠（§7.2.10）；`tests/subagent-usage.test.ts` 本会话 8/8                                                                                                                                                                                                                                                                                                |
| `ENV-1`                                 | 脚本授权失败单独分类并优先于 COM 判定：[automation.ts:70-79](../packages/office/automation.ts#L70-L79)、[:167-177](../packages/office/automation.ts#L167-L177)；回归 [office.test.ts:45-91](../tests/office.test.ts#L45-L91)                                                                                                                                               |
| `R1-tools-toolcut-output-never-spilled` | `runGit` 不再预先截断（§7.2.7）；`tests/spill.test.ts`、`tests/git-write.test.ts` 本会话通过                                                                                                                                                                                                                                                                               |
| `hosts-assembly-2`                      | 每个连接先装 socket 错误处理 [carrier.ts:143](../apps/agent-host/carrier.ts#L143)；回归 [host-carrier-auth.test.ts:190-202](../tests/host-carrier-auth.test.ts#L190-L202)                                                                                                                                                                                                  |
| `hosts-assembly-3`                      | `workspace.apply` 走 `ToolRegistry` + 审批 + 执行策略：[workspaces.ts:86-149](../apps/agent-host/handlers/workspaces.ts#L86-L149)；回归 [host-workspaces.test.ts:108-190](../tests/host-workspaces.test.ts#L108-L190)                                                                                                                                                      |
| `hosts-assembly-6`                      | 手动压缩可取消：[compaction.ts:60-62](../apps/agent-host/handlers/compaction.ts#L60-L62)、[runs.ts:70-73](../apps/agent-host/handlers/runs.ts#L70-L73)；回归 [context.test.ts:1136-1209](../tests/context.test.ts#L1136-L1209)                                                                                                                                             |
| `integrations-2`                        | LSP 预览前 `Workspace.resolve`（拒绝所有符号链接）：[lsp/tools.ts:294-309](../packages/lsp/tools.ts#L294-L309)；回归 [lsp.test.ts:1071-1106](../tests/lsp.test.ts#L1071-L1106)                                                                                                                                                                                             |
| `integrations-3`                        | 重定向与 1 MiB 响应上限移进探测本身：[discovery.ts:202](../packages/providers/discovery.ts#L202)、[:210-233](../packages/providers/discovery.ts#L210-L233)、[:248-259](../packages/providers/discovery.ts#L248-L259)；回归 [models-discovery.test.ts:280-333](../tests/models-discovery.test.ts#L280-L333)                                                                 |
| `build-ci-tests-1`                      | 打包布局 lock 解析（§7.3.13）：[ripgrep-assets.ts](../packages/search/ripgrep-assets.ts) `lockFiles()` + [search-ripgrep.test.ts](../tests/search-ripgrep.test.ts)                                                                                                                                                                                                         |
| `build-ci-tests-2`                      | 运行器区分四种文件形状（§7.3.14）：[run-tests.mjs](../scripts/run-tests.mjs) `verifyPhases` + [test-runner-shapes.test.ts](../tests/test-runner-shapes.test.ts)                                                                                                                                                                                                            |
| `build-ci-tests-3`                      | 清单按 `--profile` 派生产物名：[write-release-manifest.mjs:21-30](../scripts/write-release-manifest.mjs#L21-L30)、[package.json:18](../package.json#L18)；回归 [desktop-upgrade.test.ts:275-320](../tests/desktop-upgrade.test.ts#L275-L320)                                                                                                                               |
| `storage-protocol-carrier-1`            | 恢复副本准入与保留预算拆分（§7.2.8）+ 剪枝守卫；[database-maintenance.test.ts](../tests/database-maintenance.test.ts)                                                                                                                                                                                                                                                      |
| `storage-protocol-carrier-3`            | 重试计数带会话作用域：[run-request.ts:230](../packages/core/run-request.ts#L230) → [session-runs.ts:357-365](../packages/storage/session-runs.ts#L357-L365)（无调用点回归）                                                                                                                                                                                                |
| i18n 门禁 P3（非 34 条）                | `CORE_ALLOWED` 由「整行子串命中」改为「删掉已登记文本后再看剩余」：[i18n-gate.mjs:230](../scripts/i18n-gate.mjs#L230)、[:293-327](../scripts/i18n-gate.mjs#L293-L327)；回归 [i18n-gate.test.ts:179-208](../tests/i18n-gate.test.ts#L179-L208)（2026-10-15 本会话修复，RED→GREEN 已验证）                                                                                   |

## 6. 建议执行顺序

1. **等写入者停止**，冻结快照（提交或哈希清单）→ 跑 `npm run check` + 全量 + `smoke:client`，解决 P0-2/P0-3。
2. 验证 P0-1 的清理/恢复链（它已在收尾，差一个定向验证）。
3. P1：先做 P1-2（纯技术、范围清晰），再做 P1-1/P1-3/P1-4/P2-9 的**内容 vs 界面边界决策**（同一根因，一起定比逐条修省事）。
4. P2 逐条；P2-3/P2-4/P2-5 是同一内核区域的三个小缺陷，可合并成一批做，并各自补可判别回归。
5. P3-4：把「已修复」状态与本文档索引合并进主评估文档，重算 34 条关闭数。
6. P3-6 的平台验收按可获得的独立环境分别排期。

## 附录 A：原审计 34 条跟踪项现状

| 严重度       | 已修                                                                                                                                                                                         | 仍开（本文档位置）                                                                                                                                                                                                                                                                                                                                       |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| high（2）    | `R1-tools-credential-8dot3`、`hosts-assembly-1`                                                                                                                                              | —                                                                                                                                                                                                                                                                                                                                                        |
| medium（13） | `ENV-1`、`R1-core-1`、`core-kernel-1`、`R1-tools-toolcut-output-never-spilled`、`hosts-assembly-2`、`build-ci-tests-1`、`build-ci-tests-2`、`build-ci-tests-3`、`storage-protocol-carrier-1` | `desktop-app-1`（P1-3）、`integrations-1`（P1-1）、`integrations-4`（P1-2，部分）、`storage-protocol-carrier-2`（P0-1）                                                                                                                                                                                                                                  |
| low（19）    | `core-kernel-2`、`hosts-assembly-3`、`hosts-assembly-6`、`integrations-2`、`integrations-3`、`storage-protocol-carrier-3`                                                                    | `R1-core-2`（P2-3）、`R1-core-3`（P2-4）、`R1-core-4`（P2-9）、`R1-core-5`（P2-5，部分）、`core-kernel-3`（P2-6）、`desktop-app-2`（P3-3）、`desktop-app-3`（P1-4）、`hosts-assembly-4`（P2-1，部分）、`hosts-assembly-5`（P2-2）、`integrations-5`（P2-7）、`storage-protocol-carrier-4`（P3-1）、`tools-sandbox-2`（P3-2）、`build-ci-tests-4`（P2-8） |

合计：**17 已修 / 17 仍开**。

## 附录 B：本清单的证据来源与局限

- **来源一：三组只读静态审计**（2026-10-16 07:40 前后，针对当时的工作树）——分别覆盖内核/桌面、宿主/载体/存储、工具/沙箱/构建/集成，均给出 `文件:行` 证据；三组都被要求**不运行任何测试套件**（本机 Windows 沙箱 ACL 租约是机器级独占的，并行跑套件会互相污染）。
- **来源二：另一写入者的验证记录**——`incremental-repairs-validation-2026-10-15.md`、`tcp-carrier-auth-validation-2026-10-15.md`、`core-storage-split-validation-2026-10-15.md`、`stable-repairs-validation-2026-10-15.md`。其「后续队列」与本清单的 P1/P3 一致。
- **来源三：本会话的直接核对**——`git log`/`git status`、`npm run typecheck`、`npm run cycles:check`（335 文件 / 837 边 / 0 环，按 10-15 记录；本会话早前为 321/797/0）、`npm run i18n:check`、`docs:check`、`references:check`，以及 2026-10-15 的定向回归 174 项（60 + 114，0 失败、8 项环境跳过）。另有 **8 条关键证据由我逐字复读原文确认**，行号与机制描述一致：`run-request.ts:423-433`、`shrink.ts:63-80`、`history.ts:22-36`、`calibration.ts:178`、`openai.ts:308-309`、`task-trigger.ts:261-264`、`seatbelt-scratch.ts:24`、`carrier.ts:87`。
- **局限**：
  1. 除标注「A」的条目外，判定来自**单次静态审计**，未独立复跑；尤其 P1-2 的 zip 炸弹未实际构造。
  2. 树**正在被改动**，07:45 之后仍有写入；P0-1 的状态可能已经推进。
  3. 转述自另一写入者文档的「已修」条目按其记录与源码核对，未逐条重跑其回归。
  4. 本文档不构成发布或平台验收结论；跳过项不含在此列。
