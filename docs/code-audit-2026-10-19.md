# YuanTu-Foundry 代码审计报告

| 项       | 内容                                                       |
| -------- | ---------------------------------------------------------- |
| 报告日期 | 2026-10-19                                                 |
| 审计基线 | 提交 `1171114`（审计开始时工作区干净）                     |
| 审计范围 | `apps/`、`packages/`、`scripts/`、`tests/`、`benchmarks/`  |
| 审计方式 | 静态审阅、仓库门禁、确定性基准、针对性探针、全量行为测试   |
| 结论     | 架构成立；2 个 P1、10 个 P2、5 个 P3；无需重写内核或分层   |
| 文档状态 | 基于固定提交的审计记录；行号以该提交为准，后续改动可能漂移 |

> 审计期间工作区出现了未提交的多会话并发改动。本报告的产品结论以 `1171114` 为准，未提交改动只作为“进行中工作”提示，不纳入结论。
>
> 后续修复与复核见 [代码审计复核（2026-10-19 下午）](code-audit-2026-10-19-followup.md)。

---

## 1. 执行摘要

### 1.1 总体判断

项目已经具备一个可维护的编码 Agent 内核：分层由门禁强制、事件日志是唯一真源、工具管线与完成契约有实际实现、桌面 Electron 安全基线完整。请求热路径（工具 schema、消息落盘、transcript 折叠、快照发布、上下文预测）都有确定性基准钉住，本轮未发现新的正确性缺陷或资源泄漏。

剩余问题不在“循环与分层”，而在四类边界：

1. **功能死路**：两条已宣称的能力在特定输入下永远无法成功（P1）。
2. **回收与保留**：快照、结果、staging、租约没有完整的释放策略（P2）。
3. **跨回合资源生命周期**：LSP、浏览器、MCP 随 run 关闭，与终端/residency 的 Host 持有模型不一致（P2）。
4. **规模成本**：全工作区指纹、子代理整树导出、run-end 不变量、压缩边界搜索在大型仓库/长会话上会显著拖慢“结束”（P2）。

### 1.2 优先级定义

- **P1**：已确定会阻断一条已宣称的能力或升级路径，且没有正常的界面路径绕开；本轮不包含安全逃逸或数据损坏。
- **P2**：有明确触发条件的资源、规模、产品接入缺陷，或安全界面与实际执行状态不一致。
- **P3**：局部效率或可维护性问题，不改变能力结论。

### 1.3 问题计数

| 级别 | 数量 | 主题                                                                                 |
| ---- | ---- | ------------------------------------------------------------------------------------ |
| P1   | 2    | 完成契约检查、数据库迁移                                                             |
| P2   | 10   | 磁盘回收、子代理导出、租约、桌面验收入口、规模成本、资源生命周期、权限预设、取消语义 |
| P3   | 5    | 上下文装配重复、测量顺序、输出读取、工具目录扫描、审计数据                           |

---

## 2. 基线与方法

### 2.1 基线

审计开始时 `HEAD` 为 `1171114`，`git status` 干净。静态门禁、构建、基准与完成契约针对性用例都在该基线上执行；全量测试启动后工作区被并发修改，结果单独标注（见 2.2 与附录 A）。

### 2.2 进行中的改动

审计期间工作区出现未提交改动，主要包括：

- Agent Host 的多会话准入：`YUANTU_HOST_MAX_RUNS`（默认 2）、按会话的 `admissionRefusal`、调度器 `canRun(sessionId)`、按会话的不变量记录。
- 桌面端的多会话跟随：切换会话不再等待运行结束、`otherRuns`、按会话的 composer sending 状态。
- 移除桌面设置页的 Windows 增强隔离段；新增 `.claude/` 到 `.gitignore`。
- 同目录新增一份 Host 资源锁设计稿（状态为“尚未实现”）。

这些改动正好覆盖此前的“单 Host 单活动会话”限制，但不是本报告的审阅基线，也未经本轮验收。合入前至少需要验证：两个会话并发时的审批/取消归属、共享 rate gate 的公平性、终端与后台命令的归属、SQLite 单连接的写串行、`restoring` 全局屏障是否仍会阻塞无关会话、`manualOperation` 单槽位是否足够。

### 2.3 验证方式

- 静态门禁：`format:check`、`docs:check`、`references:check`、`cycles:check`、`layers:check`、`i18n:check`、`typecheck`、`test:isolation:check`。
- 构建：`npm run build`。
- 性能门禁：`npm run bench:check`（13 条确定性/比值规则）。
- 行为测试：针对性用例 + 全量测试（结果见附录 A）。
- 针对性探针：对 P1-1 构造合成工作区复现，输出见附录 B。

---

## 3. 问题总览

| 编号  | 级别 | 问题                                                   | 触发条件                           |
| ----- | ---- | ------------------------------------------------------ | ---------------------------------- |
| P1-1  | P1   | 非 task 合同的 `forbidden-path/unchanged` 永远无法通过 | 普通请求或已批准计划声明该检查     |
| P1-2  | P1   | 会话库超过 512 MiB 时迁移备份失败，应用无法打开        | 旧 schema 且库文件大于默认备份预算 |
| P2-1  | P2   | 快照/结果/staging 只增不减，`.yuantu` 未自动 ignore    | 使用隔离子代理或长期使用           |
| P2-2  | P2   | 每个子代理回合结束都整树 hash + fast-import + diff     | worktree 子代理，仓库文件多        |
| P2-3  | P2   | 工作区操作租约只用 PID 判活                            | 崩溃残留租约 + PID 被复用          |
| P2-4  | P2   | 桌面无法创建或恢复完成契约                             | 桌面普通请求、`/plan` 执行         |
| P2-5  | P2   | task 验收默认全工作区串行指纹两次，文件上限 off-by-one | task 未显式声明 inputs，仓库较大   |
| P2-6  | P2   | run-end 不变量每次 run 全历史折叠并三次序列化          | 长会话、含图片、含子会话           |
| P2-7  | P2   | 压缩批次边界搜索近似 O(N²)，阻塞主循环                 | 长会话触发压缩                     |
| P2-8  | P2   | LSP/浏览器/MCP 随 run 关闭                             | 跨回合使用这些能力                 |
| P2-9  | P2   | 权限预设切换非原子，失败后界面回显旧档位               | 两步设置中第二步失败               |
| P2-10 | P2   | 手工 task 验收不可取消，Host 关闭会一直等              | 手动确认/验收运行期间停止或关闭    |
| P3-1  | P3   | 手工 `/compact` 与 run 的上下文装配漂移（缺 prune）    | 手动压缩                           |
| P3-2  | P3   | `shrink` 先 measure 再判已缩短标记                     | 长会话每轮                         |
| P3-3  | P3   | `job_output` 每次拼接完整子会话 transcript             | 轮询子代理输出                     |
| P3-4  | P3   | deferred 模式每轮遍历全部历史收集已加载工具            | 长会话、默认 deferred              |
| P3-5  | P3   | 桌面不消费 audit，却仍全量读取、克隆、序列化           | 长会话、带审计记录的会话           |

---

## 4. P1

### P1-1 非 task 合同的 `forbidden-path + unchanged` 永远无法通过

**位置**：[packages/core/agent.ts:206](../packages/core/agent.ts#L206)、[packages/core/task-acceptance.ts:46-54](../packages/core/task-acceptance.ts#L46-L54)、[packages/core/task-acceptance.ts:99-112](../packages/core/task-acceptance.ts#L99-L112)、[packages/core/task-acceptance.ts:185](../packages/core/task-acceptance.ts#L185)。

**现象**：`normalizeCompletionSpec` 接受 `forbidden-path` 且 `expectation: 'unchanged'` 的检查，但 baseline 只在 task 路径采集：

```ts
const baselines: TaskBaselines = task ? await captureTaskBaselines(workspace, task) : {};
```

非 task 合同（普通请求或已批准计划）拿到空 baselines 后，`acceptanceSpecs` 会跳过该检查；随后 `specs.length !== declaredChecks.length` 被判成 `invalid-definition`。

**复现**：合成工作区中放置一个未修改的 `keep.txt`，用显式合同声明该文件 `unchanged`，以空 baselines 调用 `verifyCompletionAcceptance`，结果为：

```json
{ "passed": false, "reason": "invalid-definition", "checks": [] }
```

**影响**：普通请求或已批准计划只要声明“该文件不得改变”，每轮验收都进入 `needs_review`，既不能修复也不能完成；这是宣称能力与实际行为不一致，且会消耗模型工作与验收预算。

**建议**：在合同解析完成后、任何模型请求之前，按 `state.contractSpec.acceptance` 采集 baseline（把 `captureTaskBaselines` 泛化为 `captureAcceptanceBaselines`），合并进传给 `verifyCompletionAcceptance` 的 `baselines`；或在 admission 阶段对非 task 来源明确拒绝 `unchanged`，不要接受后再丢弃。

**验收标准**：新增两条回归——显式合同 + `unchanged`（文件未动 → passed；文件被停止钩子改动 → `needs_review`），以及已批准计划 + `unchanged` 的同等路径。

---

### P1-2 会话库超过 512 MiB 时迁移备份失败，应用无法打开

**位置**：[packages/storage/session-migrations.ts:79-93](../packages/storage/session-migrations.ts#L79-L93)、[packages/storage/database-maintenance.ts:39](../packages/storage/database-maintenance.ts#L39)、[packages/storage/database-maintenance.ts:352-356](../packages/storage/database-maintenance.ts#L352-L356)、[packages/storage/database-maintenance.ts:475-497](../packages/storage/database-maintenance.ts#L475-L497)。

**现象**：迁移前备份调用 `createDatabaseBackup` 时没有传 `admission`，默认值把“历史保留预算”当作“单次拷贝准入”：

```ts
admission: BackupAdmission = { maxBytes: retention.maxBytes };
```

`DEFAULT_BACKUP_POLICY.maxBytes` 为 512 MiB。超过即抛 `Snapshot exceeds backup capacity`，被包装成 `Migration stopped because its backup failed`，`SessionStore` 构造失败，Host/CLI 都无法打开该库。

对照：桌面升级路径显式使用按剩余空间判断的 `RECOVERY_COPY_ADMISSION`（[packages/maintenance/desktop-upgrade.ts:215](../packages/maintenance/desktop-upgrade.ts#L215)），说明“准入”和“保留”本应是两套语义。

**影响**：数据未损坏，但用户被锁在旧版本；释放磁盘空间无效，因为预算是常量而不是剩余空间。会话库包含图片 blob，长期使用可能达到该规模。

**建议**：迁移备份使用 `RECOVERY_COPY_ADMISSION`（保留 `RECOVERY_COPY_RESERVE_BYTES` 检查）。`createBackup` 已经明确“刚生成的快照永不删除”（[database-maintenance.ts:428-438](../packages/storage/database-maintenance.ts#L428-L438)），因此准入放宽不会导致必需备份被 pruning 删掉。补一条“库大于历史预算仍可迁移”的测试。

**临时绕行**：CLI 的 `db-compact --db <file>` 直接对原始 SQLite 执行 `VACUUM`，不触发迁移，可先把库压到阈值以下；但错误信息不会提示这条路径。

---

## 5. P2

### P2-1 快照、结果与 staging 只增不减，`.yuantu` 未自动 ignore

**位置**：[packages/workspaces/snapshot.ts:192](../packages/workspaces/snapshot.ts#L192)、[snapshot.ts:294-301](../packages/workspaces/snapshot.ts#L294-L301)、[snapshot.ts:562-567](../packages/workspaces/snapshot.ts#L562-L567)；[packages/workspaces/results.ts:298-309](../packages/workspaces/results.ts#L298-L309)；[packages/workspaces/manager.ts:695-697](../packages/workspaces/manager.ts#L695-L697)、[manager.ts:738-829](../packages/workspaces/manager.ts#L738-L829)；[packages/storage/session-lifecycle.ts:184-191](../packages/storage/session-lifecycle.ts#L184-L191)。

**现象**：

- 每个新的树状态把整棵树复制到 `<repo>/.yuantu/workspace-snapshots/<id>/files`；内容寻址只在单个快照内去重，不同树状态各存一份，单份上限 512 MiB。
- 结果 manifest 与 `refs/yuantu/results/*` 永久保留；删除会话只删 DB 行与未引用 blob，不删结果文件/ref。
- `remove` 只删 worktree，且还会新增一份删除前快照与 `workspace-removals/*.json`。
- `staging` 只靠 `finally` 清理，SIGKILL 后最多残留 512 MiB。
- 在 `packages/`、`apps/` 中未检索到删除快照目录或 `refs/yuantu/*` 的调用；也没有把 `.yuantu/` 写入用户仓库 `.git/info/exclude` 的代码。工作区数据库默认位于 `<workspace>/.yuantu/sessions.sqlite`（[apps/shared/runtime.ts:204-207](../apps/shared/runtime.ts#L204-L207)），因此用户仓库的 `git status --untracked-files=all` 会显示运行期数据库、检索索引与整份快照。

**影响**：长期使用表现为仓库内磁盘无界增长；Git ref 又阻止对象被回收。`.yuantu` 未 ignore 会让用户和模型看到运行期目录，存在误提交整份快照的风险（文件工具本身会排除 `.yuantu`，[packages/tools/files.ts:64](../packages/tools/files.ts#L64)，但 `git status` 不会）。

**建议**：按绑定/结果引用计数，最后一个引用消失时删 manifest、ref 与快照；启动时清理 owner 已死的 `.staging-*`；提供 `workspace gc --dry-run` 与仓库内字节预算；工作区首次打开时把 `.yuantu/` 写入 `.git/info/exclude`；为 worktree 增加可配置的保留期。

**验收标准**：删除会话后其快照/结果 ref 归零；崩溃后重启能回收 staging；`git status` 不再显示 `.yuantu`。

---

### P2-2 每个子代理回合结束都整树 hash + fast-import + diff

**位置**：[packages/core/run-child-turns.ts:368-373](../packages/core/run-child-turns.ts#L368-L373)、[packages/workspaces/results.ts:196-210](../packages/workspaces/results.ts#L196-L210)、[packages/workspaces/snapshot.ts:578-597](../packages/workspaces/snapshot.ts#L578-L597)。

**现象**：worktree 子代理每个回合结束都会 `export`：先 `collectTreeBlobs(整个 executionRoot)`（读取每个文件、算 blob、送入 fast-import），再 `writeTree`、`diffTrees`。即使这一回合只改了一个文件，也要读完整棵树；`diffTrees` 只是最后一步。

**影响**：在 200k 文件上限的仓库里，每个子回合都多一次全树 I/O + 哈希 + 导入；用户只看到“子代理结束很慢”，而导出失败被吞成诊断。

**建议**：复用上一次 `resultTree`，用子代理自己的文件改动日志或 `git diff-tree` 只导出变化路径；仅对变化 blob 做 hash/import；未变子树复用已有 tree id。导出失败仍保留诊断，但不要阻塞回合结果的发布。

**验收标准**：只改 1 个文件的回合，导出读取的文件数应为 O(变化)，而不是 O(仓库)；大仓库基准记录每回合导出耗时。

---

### P2-3 工作区操作租约只用 PID 判活

**位置**：[packages/storage/session-workspaces.ts:91-102](../packages/storage/session-workspaces.ts#L91-L102)、[session-workspaces.ts:104-119](../packages/storage/session-workspaces.ts#L104-L119)、[packages/storage/session-runs.ts:260-264](../packages/storage/session-runs.ts#L260-L264)、[packages/platform/process-identity.ts:179-187](../packages/platform/process-identity.ts#L179-L187)。

**现象**：`workspace_operation_leases` 只记录 `owner_pid`，判活仅 `process.kill(pid, 0)`；租约表没有 `owner_started_at`。run 租约已经为 PID 复用加了启动时间（[packages/storage/session-migrations.ts:431-443](../packages/storage/session-migrations.ts#L431-L443)），工作区租约没有。

**影响**：崩溃残留的租约一旦遇到 PID 被无关进程复用，`claimOperation` 永远抛 `WORKSPACE_BUSY`，该 worktree 的 archive/remove/restore 永久失败，并且 `beginRun` 会拒绝该会话开始任何运行。没有 `session.recover` 式的清理入口。

**建议**：租约改为 `(owner_pid, owner_started_at)`，复用 `processAlive(pid, startedAt)`；提供显式的“确认 owner 已死”清理命令，并记录操作者与时间。

**验收标准**：模拟 PID 复用（写入一个存活但不是原 owner 的 pid + 不匹配的启动时间），租约应判死并可回收；原 owner 存活时不得被抢占。

---

### P2-4 桌面无法创建或恢复完成契约

**位置**：[packages/carrier/contract.ts:114](../packages/carrier/contract.ts#L114)、[contract.ts:123](../packages/carrier/contract.ts#L123)、[apps/desktop/renderer-composer.ts](../apps/desktop/renderer-composer.ts)、[apps/desktop/renderer-plan.ts](../apps/desktop/renderer-plan.ts)。

**现象**：载体已经支持 `planExecute.verification` 与 `send.verification`，控制器也实现了转发（[packages/client/session-controller.ts:665](../packages/client/session-controller.ts#L665)）；但桌面输入区只发 `prompt/images`，执行计划只发 `planId`。CLI 有 `--completion-spec`（[apps/cli/run.ts:255](../apps/cli/run.ts#L255)），桌面没有对应入口。

**影响**：桌面普通聊天和 `/plan` 执行永远是未验证的 `completed`；transcript 的验收提示只能显示别处创建的契约。Task 路径仍可携带验收，不能说整个桌面没有验收能力，但“显式请求验收”的产品入口缺失。

**建议**：在输入区或计划执行面板提供验收条件编辑/导入，向 `send`、`planExecute` 传 `verification`，并支持 `resumeCompletionId` 的续跑入口；普通聊天保持轻量，界面上明确“本轮结束”与“任务已验收”的区别。

**验收标准**：桌面发起一个带检查的普通请求，能在界面上看到 `verified`/`needs_review`；刷新后仍能恢复同一契约。

---

### P2-5 task 验收默认全工作区串行指纹两次，文件上限 off-by-one

**位置**：[packages/core/run-completion.ts:531-535](../packages/core/run-completion.ts#L531-L535)、[run-completion.ts:579-591](../packages/core/run-completion.ts#L579-L591)、[run-completion.ts:623-633](../packages/core/run-completion.ts#L623-L633)、[packages/core/completion-inputs.ts:183-217](../packages/core/completion-inputs.ts#L183-L217)。

**现象**：没有显式 inputs 的 task 默认监测 `['.']`，每轮在 checks 前后各快照一次。`walk` 是串行的：每个文件 `lstat` → `open` → 循环 `read` → `stat` → `close`，没有有界并发。文件数判断使用 `state.files > MAX_FILES`，实际会接受 `MAX_FILES + 1` 个文件。

**影响**：中大型仓库的一次 task 收尾要顺序遍历、哈希整棵树两次，成本随文件数线性增长且不可并行；文件越多，运行结束越晚。上限 off-by-one 会让“最多 200000 文件”的承诺不准确。

**建议**：默认范围改为 Git 已跟踪文件（与快照同源），或把遍历做成有界并发；把判断改为 `>=`；在开始前给出“将要哈希 N 个文件/字节”的规模提示，超限时尽早失败而不是跑到最后。

**验收标准**：200k 文件的合成仓库上记录一次收尾耗时；`MAX_FILES + 1` 必须被拒绝；大文件/大量文件在开始阶段给出可解释的拒绝。

---

### P2-6 run-end 不变量每次 run 全历史折叠并三次序列化

**位置**：[packages/storage/invariants.ts:69-92](../packages/storage/invariants.ts#L69-L92)、[packages/core/run-finalization.ts:197](../packages/core/run-finalization.ts#L197)、[packages/core/run-finalization.ts:264-289](../packages/core/run-finalization.ts#L264-L289)、[packages/core/invariants.ts:103-119](../packages/core/invariants.ts#L103-L119)。

**现象**：默认注册的 `logTablesAgreeInvariant` 对 session 及每个 child 执行：

1. `events()`（读日志）
2. `foldMessages(events)`（折叠整段历史）
3. `messages()`（读 transcript）
4. `messagesFromTable()`（SQL 全表 + JSON 解析 + 图片 base64 还原）
5. `digestHistory` 三次（逐条 `JSON.stringify`）

检查是同步函数；`InvariantRegistry` 的超时只能 race Promise，无法抢占同步阻塞。

**影响**：每次 run 结束的成本与会话 + 全部子会话历史成正比；图片会让三次 stringify 的字节数放大。长会话每次结束在 Host 主线程阻塞数百毫秒到数秒。

**建议**：由 journal 在 append 时维护增量摘要，run-end 只比对增量/计数；或把该检查改为显式维护命令，并限制检查字节数、跳过图片负载。若保留同步实现，至少把它移出主线程或分批让出事件循环。

**验收标准**：10k 消息 + 图片的会话，run-end 检查耗时有上限；不改变“日志/transcript/表一致”的检出能力。

---

### P2-7 压缩批次边界搜索近似 O(N²)，阻塞主循环

**位置**：[packages/core/context.ts:651-674](../packages/core/context.ts#L651-L674)、[context.ts:541-558](../packages/core/context.ts#L541-L558)。

**现象**：每个候选 cut 都执行 `history.slice(covered, candidate)` + `summaryTranscript` + `fitsSummary`；transcript 随候选递增，而 forecast 每次重新序列化整段 transcript。fallback 路径同样对每个 cut 重新测量。批次内有 k 条消息、c 个候选时，成本近似 `O(c × k)`，单个批次可到 `O(k²)`。

**影响**：长会话触发压缩时，CPU 与序列化成本按候选数 × transcript 长度增长，期间阻塞 provider 流与事件处理；压缩越频繁、历史越长越明显。

**建议**：用前缀 token/字符累计和或二分选界；对增量 append 的 forecast 复用上一次结果；给压缩循环显式的让出点与总时限。

**验收标准**：50k 消息的会话压缩时，主线程单次阻塞不超过既定预算；选界结果与当前实现一致。

---

### P2-8 LSP、浏览器与 MCP 连接随每个 run 关闭

**位置**：[packages/catalog/index.ts:152](../packages/catalog/index.ts#L152)、[catalog/index.ts:195](../packages/catalog/index.ts#L195)、[packages/core/run-finalization.ts:101](../packages/core/run-finalization.ts#L101)、[packages/lsp/manager.ts:190-199](../packages/lsp/manager.ts#L190-L199)、[packages/tools/browser.ts:100](../packages/tools/browser.ts#L100)、[packages/mcp/tools.ts:782-789](../packages/mcp/tools.ts#L782-L789)。

**现象**：工具目录每次 run 新建 `LspManager`，registry 关闭时停掉语言服务器；run 结束统一 `tools.close()`。浏览器每次 run 新建无持久化 profile 的 Chromium，run 结束关闭。MCP 连接也随 registry 关闭（懒连接，代价在真正用过时支付）。

**影响**：跨回合的 LSP 重构每个用户回合都要重启服务器、丢掉项目图与诊断状态；浏览器登录态与标签在回合之间丢失，多回合网页流程只能在单次 run 内完成；MCP 每次重连要重新握手。README 只说明“没有空闲回收”，没有说明“run 结束即关闭”。

**建议**：像 terminal、residency 那样由 Host 持有资源池，按 key 复用并设置 idle TTL；至少为浏览器提供持久化 profile；把生命周期写入文档，并给用户一个“保留到会话结束/保留到关闭”的选项。

**验收标准**：连续两个回合使用同一语言服务器，第二个回合不重启进程；浏览器在第二个回合仍保留登录态；空闲超过 TTL 后资源被回收。

---

### P2-9 权限预设切换不是原子写，失败后界面回显旧档位

**位置**：[apps/desktop/session-choices.ts:79-94](../apps/desktop/session-choices.ts#L79-L94)、[session-choices.ts:141-155](../apps/desktop/session-choices.ts#L141-L155)、[apps/desktop/main.ts:465-495](../apps/desktop/main.ts#L465-L495)、[apps/desktop/contract.ts:60-68](../apps/desktop/contract.ts#L60-L68)。

**现象**：`apply` 先写 sandbox、再写 permission；一半失败只清缓存并抛出，没有补偿。`view()` 在 `live` 被清空后回退到该会话记忆的旧 choice；IPC 处理器也没有回读 Host 的实际策略。`contract.ts` 的注释声称“只有这个通道能在第二步失败时把第一步放回去”，实现并未做到。

**影响**：实际是“新 sandbox + 旧审批”，界面显示旧预设。两个维度都朝新值单调移动，因此不等于提权；但安全界面与实际执行不一致本身不可接受，尤其从 `guarded` 切到 `unconfined` 时 sandbox 已放开而审批仍显示旧档。

**建议**：失败时补偿回滚已成功的那一半；失败后从 Host 重读真实策略，chip 显示“未知/需要重试”而不是旧值；为“回滚也失败”的情况提供显式状态。

**验收标准**：注入 `permission.update` 失败，断言 sandbox 回到旧值，或界面显示 unknown 并禁止后续操作；不允许继续显示旧 preset。

---

### P2-10 手工 task 验收不可取消，Host 关闭会一直等

**位置**：[apps/agent-host/handlers/tasks.ts:227-233](../apps/agent-host/handlers/tasks.ts#L227-L233)、[tasks.ts:283-297](../apps/agent-host/handlers/tasks.ts#L283-L297)、[apps/agent-host/lifecycle.ts:30](../apps/agent-host/lifecycle.ts#L30)、[lifecycle.ts:151](../apps/agent-host/lifecycle.ts#L151)、[packages/core/acceptance.ts:22-34](../packages/core/acceptance.ts#L22-L34)、[acceptance.ts:605-630](../packages/core/acceptance.ts#L605-L630)。

**现象**：手工 confirm/verify 向 `verifyTaskAcceptance` 传 `undefined` signal；shutdown 只 abort `manualOperation`，而这条路径从未设置它，最后又等待全部 `ctx.tasks`。验收检查顺序执行，单 check 最长 300 s，最多 64 个。

**影响**：Stop 无法取消；关闭进程要等验收跑完（最坏可到数小时）。桌面强制退出会掩盖等待，但可能留下子进程。

**建议**：像 `context.compact` / `workspace.apply` 一样建立 `{sessionId, controller}` 并传入 signal；给整次验收加总时限；shutdown 对验收设置独立的截止时间并记录未完成的检查。

**验收标准**：Stop 后验收在 1 s 内取消；shutdown 在固定预算内完成，未完成的检查明确标记。

---

## 6. P3

| 编号 | 问题                                                                           | 位置                                                                                                                                                                                                         | 建议                                                     |
| ---- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------- |
| P3-1 | 手工 `/compact` 手写 `prepareContext` 入参，缺 `prune` seam，与 run 路径已漂移 | [compaction.ts:85-129](../apps/agent-host/handlers/compaction.ts#L85-L129)、[run-context.ts:176-184](../packages/core/run-context.ts#L176-L184)、[context.ts:589-593](../packages/core/context.ts#L589-L593) | 抽共享的上下文输入工厂，run 与手动压缩共用               |
| P3-2 | `worthShortening` 先 `measure` 再判 `SHRINK_MARK`，已缩短项仍付一次序列化      | [shrink.ts:53-54](../packages/core/shrink.ts#L53-L54)                                                                                                                                                        | 先判 marker 再 measure                                   |
| P3-3 | `job_output` 每次拼接完整子会话 transcript，只为取最后 3000 字符               | [subagent-jobs.ts:74-79](../packages/core/subagent-jobs.ts#L74-L79)、[subagent-jobs.ts:108-116](../packages/core/subagent-jobs.ts#L108-L116)                                                                 | 从后往前读最近窗口，或维护字符游标                       |
| P3-4 | deferred 模式每轮遍历全部历史消息收集已加载工具                                | [agent.ts:698](../packages/core/agent.ts#L698)、[run-surface.ts:88-97](../packages/core/run-surface.ts#L88-L97)、[run-catalog.ts:19-23](../packages/core/run-catalog.ts#L19-L23)                             | 按日志位置增量维护 loaded 集合                           |
| P3-5 | 桌面不消费 audit，但载体仍全量读取（500/页，窗口 5000）、每次发布克隆并序列化  | [service.ts:446](../packages/carrier/service.ts#L446)、[service.ts:637-656](../packages/carrier/service.ts#L637-L656)、[renderer.ts:661](../apps/desktop/renderer.ts#L661)                                   | 桌面快照移除 audit 或按需懒加载，未消费区不做克隆/序列化 |

---

## 7. 架构评估

### 7.1 成立的部分

- **分层可执行**：`layers:check` 检查 18 个包、11 层、662 条有序引用；`cycles:check` 检查 427 个文件、1031 条值引用边、0 环。类型引用也算在层规则内，`packages/tools` 与装配点 `packages/catalog` 的拆分是正确的。
- **事件日志是唯一真源**：消息行、事件、blob 在同一事务写入；transcript 是日志的折叠；检查点缩短冷启动；投影和 UI 都从日志来。`I8`（一行 + 一事件）有运行时检查和基准规则。
- **运行生命周期完整**：run 租约、崩溃恢复、输出检查点、取消、完成契约、修复预算、最终指纹、停止钩子与最终落盘顺序都有实现；`run-finalization` 的注释明确“先落盘、再发布”。
- **载体接缝干净**：`packages/carrier` 不出现 Electron/DOM；桌面通过 preload 白名单 IPC 调用，所有 handler 都有 `assertSender`；`contextIsolation`、`sandbox`、严格 CSP、外链白名单都正确。
- **测试与基准是工程资产**：确定性基准钉住 schema 字节、写入放大、缓存命中、快照发布次数；全量测试有隔离、耗时调度、跳过原因。这些让“性能没有退化”可验证，而不是靠感觉。

### 7.2 结构性债务

1. **资源生命周期按 run 划分**（P2-8）：实现简单、边界清楚，但与 terminal/residency 的 Host 持有模型不一致，跨回合体验与性能都受影响。建议统一为“Host 持有 + 引用计数 + idle TTL”。
2. **存储维护面缺少回收语义**（P2-1）：快照/结果有引用、有保留，但没有释放；迁移又把保留预算当准入（P1-2）。这是当前最需要补齐的一块。
3. **两处上下文装配**（P3-1）：run 与手动 compact 已经出现能力差异，属于会继续漂移的重复。
4. **多会话的新共享边界**：正在进行的多会话改动把并发单位从 Host 缩到会话，但 rate gate、终端、后台命令、SQLite 单连接、`restoring` 全局屏障、审批/取消归属仍是 Host 级状态。设计稿已经识别了锁范围问题，实现与验收需要同步推进。

---

## 8. 性能评估

### 8.1 热路径（有基准，表现良好）

| 指标                    | 结果            | 含义                             |
| ----------------------- | --------------- | -------------------------------- |
| 工具 schema（全量）     | 33,675 B / 63   | 每个请求携带的工具定义成本有界   |
| 单条消息 durable append | 0.479 ms        | 落盘成本可接受                   |
| 一轮 4 条消息（批量）   | 0.773 ms        | 批量提交确实更便宜（1.45×）      |
| 10k 消息冷读            | 45.2 ms         | 冷启动折叠成本                   |
| 10k 消息缓存读          | 0.1 ms          | 长会话每轮读历史几乎免费         |
| 重启后检查点折叠事件数  | 0               | 检查点生效，不从零折叠           |
| 61 个事件发布快照       | 4 次 / 1,496 KB | 进度事件走 delta，不触发全量快照 |
| 每条消息存储            | 440 B           | 存储成本有界，附件未塞进消息体   |

结论：请求热路径的性能设计是成立的，且由 `bench:check` 13 条规则固定。

### 8.2 边界成本（本轮主要风险）

| 场景              | 成本来源                                   | 量级               |
| ----------------- | ------------------------------------------ | ------------------ |
| 子代理每回合结束  | 整树读 + hash + fast-import + diff（P2-2） | O(仓库大小) / 回合 |
| task 收尾         | 全工作区串行指纹两次（P2-5）               | O(文件数) × 2      |
| 长会话 run 结束   | 全历史折叠 + 3× stringify（P2-6）          | O(历史字节) / run  |
| 长会话压缩        | 候选 cut × 递增 transcript（P2-7）         | 近似 O(k²) / 批次  |
| 跨回合 LSP/浏览器 | 进程重启 + 状态丢失（P2-8）                | 秒级 / 回合        |
| 删除会话          | 全表扫描 + blob 引用检查                   | O(数据库大小) / 次 |

这些不会拖慢每个 token，但会让大仓库/长会话的“结束”变得很慢；建议用 100k 文件、50k 消息、含图片的基准分别记录，而不是只看单机中位数。

---

## 9. 建议排期

| 批次 | 内容             | 理由                                                   | 规模 |
| ---- | ---------------- | ------------------------------------------------------ | ---- |
| 1    | P1-1、P1-2       | 小改动，直接恢复能力/解除升级死锁                      | S–M  |
| 2    | P2-1、P2-2       | 磁盘回收与子代理导出是当前最大的规模风险               | M–L  |
| 3    | P2-3、P2-10      | 租约身份与取消语义，防止永久 `WORKSPACE_BUSY` 和关不掉 | S–M  |
| 4    | P2-4、P2-8、P2-9 | 产品入口、跨回合资源、权限 UI 一致性                   | M–L  |
| 5    | P2-5、P2-6、P2-7 | 用规模化基准驱动，逐项降低“结束”成本                   | M    |
| 6    | P3-1 … P3-5      | 随手修或随相关模块重构一起做                           | S    |

多会话改动建议独立验收，不并入上述批次：先固定并发语义（审批/取消/资源归属），再谈锁拆分。

---

## 10. 未覆盖范围

- 桌面真窗口冒烟、macOS/Linux 原生后端、安装包/签名/公证、Windows AppContainer/WFP 实机验收。
- 真实模型评测与成本；本轮没有调用外部模型。
- 未提交的多会话改动与资源锁设计稿。
- 恶意代码对抗、模糊测试、长时间 soak；本文的“无泄漏”仅指静态审阅与现有测试覆盖范围。
- 行号以基线提交为准；后续重构后需要重新定位。

---

## 附录 A：验证结果

### A.1 静态门禁与构建

| 检查                   | 结果                                                                 |
| ---------------------- | -------------------------------------------------------------------- |
| `format:check`         | 通过                                                                 |
| `docs:check`           | 通过                                                                 |
| `references:check`     | 通过                                                                 |
| `cycles:check`         | 通过（427 文件 / 1031 值边 / 0 环；745 类型导入、19 动态导入未纳入） |
| `layers:check`         | 通过（18 包 / 11 层 / 4 入口 / 662 有序引用）                        |
| `i18n:check`           | 通过                                                                 |
| `typecheck`            | 通过                                                                 |
| `test:isolation:check` | 0 violation                                                          |
| `npm run build`        | 通过（Host bundle 5.88 MB，桌面构建完成）                            |
| `bench:check`          | 13/13 规则通过                                                       |

### A.2 行为测试

- 针对性：`completion-finalization` 7/7；`workspace-snapshots` 19/19、`workspace-manager` 12/12、`workspace-results` 8/8、`workspace-apply` 15/15、`runtime-workspace-policy` 6/6；完成契约组 63 通过 / 1 跳过。
- 全量（工作区已被并发修改，且同时有另一套全量测试在跑）：
  - 并行 2720 项：2692 通过、4 失败、24 跳过。
  - 串行 60 项：56 通过、4 跳过。
  - 4 个失败均为时间敏感用例：`client` / `coding-evaluation` / `host-workflows` 的 Host 握手超时，以及 `office-preview` 的“700 ms 转换 / 1000 ms 预算”在负载下超时。没有断言级产品失败。
  - 跳过项包括 Office 脚本授权、AppContainer/WFP 等既有平台边界；跳过不等于验收通过。

---

## 附录 B：P1-1 复现记录

合成工作区中放置未修改的 `keep.txt`，构造显式合同（非 task）：

```ts
const acceptance = [
  {
    description: 'keep.txt must not change',
    met: false,
    check: { id: 'c1', kind: 'forbidden-path', path: 'keep.txt', expectation: 'unchanged' },
  },
];
const result = await verifyCompletionAcceptance(root, acceptance, [], {}, signal);
```

输出：

```json
{
  "passed": false,
  "reason": "invalid-definition",
  "checks": [],
  "error": "Task acceptance contains a criterion that cannot be executed as written; review the definition."
}
```

对照：同一检查在 task 路径下（baseline 从 `task.acceptance` 采集）可以正常执行。这说明缺陷在“非 task 来源没有采集 baseline”，不是检查本身不可实现。
