# 代码审计复核（2026-10-19 下午）

> 复核基线：`2f9127a`（`fix: 性能优化`）加当时未提交的工作区改动。
> 复核时工作区仍在被修改（14:55 仍有新的回收测试与相关实现写入），行号与文件内容可能继续漂移。
> 复核当时未运行全量测试；后续修复后的全量结果见第 7 节。

## 1. 结论

上一轮审计的绝大多数问题已经修复，且修复方向正确：完成契约的 baseline 覆盖了首次请求/计划，迁移备份改用空间准入，快照改为 Git 对象 + owner ref，子代理导出加了 stat/tree 缓存，工作区租约带 owner 启动时间，run-end 不变量改为增量，压缩边界改为二分，权限预设带回滚，手工验收可取消。

但仍有 **2 个 P1** 和 **3 个 P2** 需要处理：

1. **P1：baseline 的“生命周期”没有定义。** 任务重试和完成契约续跑会重新采集 `unchanged` 的基线，把上一次已经改过的文件当成新基线，从而把失败“洗成” verified。任务重试在桌面和 CLI 都可达。
2. **P1：运行时状态目录跟随预先存在的 `.yuantu` 链接。** 一个克隆仓库里的 `.yuantu` 符号链接/junction 可以把会话库、spill、索引和快照元数据写到工作区之外。
3. **P2：隔离会话的人工验收/撤销/启动对账仍以项目目录为根**，与 `executionRoot` 不一致（资源锁设计稿 4.2 已标注“待确认”）。
4. **P2：发布门禁未全绿。** `docs:check` 与 `format:check` 失败。
5. **P2（产品缺口）：桌面仍没有完成契约入口；LSP/浏览器/MCP 仍随 run 关闭。**

> 这些项已在第 7 节逐条处理：R1/R2 由工作区改动修复，R3/R4 与 P2-4/P2-8 在本轮关闭；保留项见第 7 节末尾。

## 2. 上轮问题状态

| 编号        | 状态     | 说明                                                                                                          |
| ----------- | -------- | ------------------------------------------------------------------------------------------------------------- |
| P1-1        | 已修复   | 首次显式合同/计划合同的 `forbidden-path/unchanged` 可执行；新增 `completion-baselines` 用例                   |
| P1-2        | 已修复   | 迁移备份使用 `RECOVERY_COPY_ADMISSION`，不再受 512 MiB 历史预算限制                                           |
| P2-1        | 基本修复 | 格式 4 快照存 Git 对象，owner ref + 启动回收 + staging 清扫 + `.git/info/exclude`；保留策略仍偏保守（见 4.3） |
| P2-2        | 已修复   | `TreeBlobCache` / `TreeIdCache`，未变文件只 stat，未变目录复用 tree id                                        |
| P2-3        | 已修复   | 租约记录 `owner_started_at`/token，新增 `workspace-lease-recover` 运维入口                                    |
| P2-4        | 已修复   | 桌面 composer 与计划面板新增“验收”入口：逐行命令、可选监测路径；向 `send`/`planExecute` 传 `verification`     |
| P2-5        | 改善     | 哈希并发 8、上限改为精确、2k 文件/64 MiB 提前通知；默认仍是整个工作区、两次指纹                               |
| P2-6        | 已修复   | 增量检查 + 全量回退，新增 `invariant-registry` 用例                                                           |
| P2-7        | 已修复   | `firstHolding` / `lastHolding` 二分，`boundary-search` 有线性对照测试                                         |
| P2-8        | 已修复   | LSP/浏览器/MCP 改为 session-scoped 资源池：空闲 TTL、浏览器上限、会话删除/Host 关闭时释放                     |
| P2-9        | 已修复   | 失败回滚 sandbox；回滚也失败时进入 unknown 并拒绝显示旧档位                                                   |
| P2-10       | 已修复   | 手工验收带 signal、30 分钟总时限，shutdown/Stop 会中止                                                        |
| P3-1 … P3-5 | 已修复   | 手工 compact 复用 `contextSeams`；shrink 先判标记；job_output 只取尾部；deferred 增量；audit 默认关闭         |

## 3. 新发现

### R1（P1）任务重试 / 合同续跑会重新采集 `unchanged` 基线

**位置**：[packages/core/agent.ts:206](../packages/core/agent.ts#L206)、[packages/core/run-task.ts:21-34](../packages/core/run-task.ts#L21-L34)、[packages/core/run-completion.ts:304](../packages/core/run-completion.ts#L304)、[packages/core/run-completion.ts:856](../packages/core/run-completion.ts#L856)、[apps/agent-host/handlers/tasks.ts:404](../apps/agent-host/handlers/tasks.ts#L404)、[apps/desktop/renderer-tasks.ts:315](../apps/desktop/renderer-tasks.ts#L315)。

每次 `Agent.run` 都执行 `captureTaskBaselines`（task）或 `captureBaselines`（显式/计划/续跑合同），没有“这份 baseline 属于定义还是属于本次尝试”的概念：

- task 路径：`loadRunTask` 读取了 `previousAttempt`，但 `startRunTask` 仍把**新采样**的 baselines 写进新 attempt；`task.retry` 直接重新 `run.start`。
- 合同路径：`resumeCompletionId` 恢复 definition、repair budget、affectedPaths，但 baselines 从未持久化；`captureBaselines` 在续跑时重新采样。

**复现（task retry，桌面/CLI 可达）**：

1. task 定义“keep.txt 不得改变”；第一次运行中模型修改 `keep.txt`。
2. 第一次运行结束：`needs_review`，`verification.passed=false`。
3. 点击“重试”（或 `task-retry`），模型不做任何修改。
4. 第二次运行结束：`completed`，`verification.passed=true`，检查详情为“Forbidden path is unchanged”。

实际输出：

```json
{
  "afterFirstRun": { "status": "needs_review", "verification": false },
  "afterRetry": { "status": "completed", "verification": true },
  "file": "changed",
  "retryChecks": [{ "id": "keep", "passed": true, "detail": "Forbidden path is unchanged" }]
}
```

**复现（合同续跑，Host RPC 可达）**：第一次显式合同运行把文件改掉 → `needs_review`；用同一 `contractId` 调用 `run.start { resumeCompletionId }`，不修改任何文件 → `verified`。

**影响**：`verified` 是给人看的信任信号。只要模型在失败的那次尝试里动过“禁止改变”的文件，重试/续跑就能把它变成通过；任务历史里第一次失败仍然在，但当前状态是 completed/verified。

**建议**：把 baseline 绑定到“定义纪元”，而不是“运行/尝试”：

- task：保存首次 run attempt（`definition_attempt_floor` 之后）的 baselines，重试复用；只有 `replaceTaskDefinition` 才重置。
- 显式/计划/续跑合同：把 baselines 持久化到合同记录（或单独事件），续跑时加载；没有记录时拒绝续跑带 `unchanged` 的合同，而不是重新采样。
- 补两条回归：重试后仍 `needs_review`；续跑后仍 `needs_review`。

### R2（P1）运行时状态目录跟随预先存在的 `.yuantu` 链接

**位置**：[apps/shared/runtime.ts:204-207](../apps/shared/runtime.ts#L204-L207)、[packages/storage/sqlite.ts:175](../packages/storage/sqlite.ts#L175)、[packages/tools/spill.ts:82](../packages/tools/spill.ts#L82)、[packages/search/store.ts:93](../packages/search/store.ts#L93)、[packages/workspaces/snapshot.ts:192](../packages/workspaces/snapshot.ts#L192)。

`sessionDatabasePath` 直接拼接 `<workspace>/.yuantu/sessions.sqlite`；`SessionStore` 只 `mkdirSync(dirname)` 后打开 SQLite；spill、搜索索引、快照元数据同样直接 `mkdirSync`。全程没有 `lstat`/`realpath` 校验 `.yuantu` 及其祖先是否为链接。

**复现（Windows junction）**：在临时工作区创建 `.yuantu` → 外部目录的 junction，然后打开 `SessionStore`：

```json
{ "outsideContains": ["sessions.sqlite", "sessions.sqlite.users"] }
```

在 macOS/Linux 上，一个 Git 仓库直接携带 `.yuantu` 符号链接即可复现（Windows 默认 `core.symlinks=false` 时链接会变普通文件，应用启动失败而不是越界写）。

**影响**：克隆/打开的仓库可以把会话数据库、spill（工具完整输出）、检索索引和快照元数据写到用户指定的任意可写目录；可能造成会话内容落到同步盘/共享目录、覆盖目标目录里同名的 SQLite 文件、或占用工作区之外的磁盘。文件工具明确拒绝链接，运行时自己的状态目录却没有同样的边界。

**建议**：在工作区打开时校验 `.yuantu` 的每一级祖先：`lstat` 拒绝符号链接/junction，`realpath` 后确认仍在工作区内；创建后再校验一次。所有状态子目录（sessions、spill、search、workspace-snapshots）复用同一个 `ensureRuntimeDirectory`。补一个 junction/符号链接的回归。

### R3（P2）隔离会话的人工验收/撤销/启动对账仍使用项目目录

**位置**：[apps/agent-host/handlers/tasks.ts:256](../apps/agent-host/handlers/tasks.ts#L256)、[apps/agent-host/handlers/tasks.ts:287](../apps/agent-host/handlers/tasks.ts#L287)、[apps/agent-host/handlers/sessions.ts:96-98](../apps/agent-host/handlers/sessions.ts#L96-L98)、[apps/agent-host/run-start.ts:155](../apps/agent-host/run-start.ts#L155)。

- `task.confirm` / `task.verify` 用 `ctx.workspace` 做 `fileClaims` 并传给 `verifyTaskAcceptance`；baseline 却是在 session 的 `executionRoot` 采集的。
- `changes.undo` 同样用 `ctx.workspace`。
- `run.start` 对账 `reconcilePendingFileChanges(..., ctx.workspace)`，而同文件第 109 行已经算出了 `executionRoot`。

`docs/host-resource-locks.md` 的 4.2 已经记录“撤销、验收、人工确认仍然作用于项目目录，是否改为会话执行目录待确认”。本轮复核确认行为未变。

**影响**：对带 worktree 绑定的会话（子代理或嵌套委派），人工验收会在项目目录执行命令、比对项目文件，而不是子会话的工作树；`task.create` 并不限制只能给父会话建任务，RPC/CLI 可以寻址任意会话。`changes.undo` 也有同样风险：`undoFileChange` 会接受两个 root，但实际读写的是传入的项目目录，可能冲突拒绝，也可能改到项目里的同名文件。

**建议**：先明确语义，再统一实现——要么这些宿主入口一律用 `executionRoot(ctx, sessionId)`，要么在 RPC 层拒绝绑定会话的验收/撤销；`run.start` 对账应与 `entry.root` 使用同一目录。补一个“带 worktree 绑定的会话验收/撤销”用例。

### R4（P2）发布门禁未全绿

当前工作区：

- `npm run docs:check` 失败：
  - `README.md` 的生成事实块与代码不一致；
  - `README.md` 的方法表漏掉 `HostMethods` 里的 `session.archive`。
- `npm run format:check` 失败：
  - `scripts/run-tests.mjs` 未格式化；
  - 未跟踪的 `output/playwright/user-experience-probe.mjs` 被 Prettier 扫到（本地探针产物，不是产品文件）。

其余静态门禁、构建、基准通过（见第 5 节）。`docs:generate` 与 `prettier --write scripts/run-tests.mjs` 可修复前两项；`output/` 应删除或加入 `.gitignore`/`.prettierignore`。

### R5（P3）若干一致性/运维问题

| 问题                                                                                                                                      | 位置                                                                                                                                                                                | 建议                                                                   |
| ----------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `task.propose` 与 `context.compact` 会调用模型，但不占 `maxActiveRuns` 槽位，`task.propose` 也不在 `manualOperations` 里（Stop 不能取消） | [tasks.ts:214](../apps/agent-host/handlers/tasks.ts#L214)、[compaction.ts:63](../apps/agent-host/handlers/compaction.ts#L63)、[docs/host-resource-locks.md](host-resource-locks.md) | 决定是否占用槽位；至少把 `task.propose` 注册为可按会话取消的手工操作   |
| 快照的释放只在 Host 启动时跑一次；运行中 remove/archive 后的元数据与 ref 要等下次启动才回收；Git 对象还要等 `gc`                          | [manager.ts:797](../packages/workspaces/manager.ts#L797)、[services.ts:99](../apps/agent-host/services.ts#L99)                                                                      | 在绑定删除/归档后排队一次 release；提供 `git gc --auto` 或文档说明     |
| `forbidden-path` 被改动被归类为 `invalid-definition`，UI 文案说“验收定义无法执行”，真实原因却是受保护文件被改                             | [acceptance.ts](../packages/core/acceptance.ts)、[completion.ts](../packages/core/completion.ts)、[i18n-workspace.ts](../apps/desktop/i18n-workspace.ts)                            | 增加独立 failure reason（如 `protected-path-changed`）或专门的 UI 文案 |
| `archivedSessions()` 调 `session.list { archived: true }` 不带 limit，归档会话很多时一次返回全部                                          | [service.ts:415](../packages/carrier/service.ts#L415)、[session-search.ts](../packages/storage/session-search.ts)                                                                   | 复用分页/上限，设置页按需加载                                          |
| `session.delete` 的 `withLocks` 没有 `operation`，Stop/shutdown 只能等它完成                                                              | [sessions.ts:138](../apps/agent-host/handlers/sessions.ts#L138)                                                                                                                     | 注册为可按会话取消的手工操作                                           |

## 4. 仍建议做的优化

### 4.1 跨回合资源池（上轮 P2-8）

LSP、浏览器、MCP 仍随每次 run 新建并在 run 结束关闭（[packages/catalog/index.ts:152](../packages/catalog/index.ts#L152)、[packages/catalog/index.ts:191-195](../packages/catalog/index.ts#L191-L195)、[packages/core/run-finalization.ts:101](../packages/core/run-finalization.ts#L101)）。跨回合 LSP 重构每回合重启服务器；浏览器每次都是无持久化 profile 的新 Chromium。建议由 Host 持有资源池 + idle TTL，至少给浏览器持久化 profile。

### 4.2 桌面完成契约入口（上轮 P2-4）

载体已经支持 `send.verification` / `planExecute.verification`，控制器也转发；桌面仍只发 prompt/images 与 planId。建议在输入区/计划面板提供验收条件编辑或 spec 导入，并支持 `resumeCompletionId`。

### 4.3 磁盘回收的“运行期”版本

格式 4 已经把快照字节放进 Git 对象，owner ref 和结果 ref 也有释放路径；但释放只发生在启动、会话删除、显式 purge。建议：

- remove/archive 完成后在后台排队一次 `releaseUnusedSnapshots`；
- 对已删除 ref 的对象执行 `git gc --auto`（或在维护命令里提供）；
- 为 `YUANTU_WORKSPACE_RETENTION_DAYS` 之外的默认保留策略写清楚“不自动删除”的边界。

### 4.4 大仓库导出/指纹

子代理导出已从“每回合整树读取”降为“未变文件只 stat”，但**首次**导出、每个进程的第一次、以及被 git gc 清掉缓存后的重试仍需整树读。建议补一个大仓库基准（10k/50k 文件，连续 3 个回合），并把首次导出做成可观测的进度事件。task 默认指纹仍是整个工作区两次，建议默认改为 Git 已跟踪文件，或至少提供“本次只监测这些路径”的桌面入口。

### 4.5 小项（已修复，见第 7 节）

- `InvariantRegistry` 的 `checked` map 不随会话删除清理；长寿命 Host 会积累小对象。
- `RunWatch` 的 `shown` 集合依赖 notification 的 `close`/`failed` 事件；Windows Action Center 不总是发 `close`，可加 LRU 上限。
- `SnapshotMirror.waiting` 在补丁丢失时会一直等待对应 base；可加超时或按版本上限清理。

## 5. 验证记录

| 检查                   | 结果                                                                                                                       |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `typecheck`            | 通过                                                                                                                       |
| `cycles:check`         | 通过（435 文件 / 1059 值边 / 0 环）                                                                                        |
| `layers:check`         | 通过（18 包 / 11 层 / 668 有序引用）                                                                                       |
| `references:check`     | 通过                                                                                                                       |
| `i18n:check`           | 通过                                                                                                                       |
| `test:isolation:check` | 0 violation                                                                                                                |
| `npm run build`        | 通过（Host bundle 5.92 MB，桌面构建完成）                                                                                  |
| `bench:check`          | 13/13 规则通过                                                                                                             |
| `docs:check`           | **失败**（事实块过期；缺 `session.archive`）                                                                               |
| `format:check`         | **失败**（`scripts/run-tests.mjs`、`output/playwright/...`）                                                               |
| 定向测试（第一批）     | 34/34 通过：completion-baselines、host-resource-locks、session-choices、runtime-exclude、invariant-registry、context-prune |
| 定向测试（第二批）     | 34/34 通过：host-multi-session、session-controller-multi、workspace-recovery、completion-finalization                      |
| 全量测试               | 未运行（按要求；当前工作区仍在修改，结果也不适合作为固定基线）                                                             |

## 6. 限制

- 复核期间工作区持续被修改（最新可见写入在 14:55），本报告是当时快照；合入前应再跑一次 `npm run check`（或至少 `docs:generate` + `format:check` + 定向测试）。
- 未执行桌面真窗口冒烟、macOS/Linux、安装包/签名/WFP 验收、真实模型评测。
- R1 的两个复现使用合成工作区和脚本化 provider，不调用外部模型；R2 的复现使用 Windows junction，macOS/Linux 的符号链接路径未实机执行，但机制相同。

## 7. 后续修复结果（2026-10-19 傍晚）

R1、R2 由工作区此前的改动修复；本轮复核确认：重试/续跑保持 `needs_review`，`.yuantu` junction 被 `ensureRuntimeDirectory` 拒绝。R3、R4、R5 的剩余项在本轮处理：

| 项目                     | 处理                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R3 隔离会话根目录        | `task.confirm` / `task.verify` / `changes.undo` / `run.start` 对账 / `context.compact` spill 统一使用 `executionRoot(ctx, sessionId)`，与 baseline 采集一致                                                                                                                                                                                                                                                                                         |
| R4 发布门禁              | `docs:generate` 更新 README 事实块并补 `session.archive`；Prettier 覆盖全部改动文件；`docs:check`、`format:check` 通过                                                                                                                                                                                                                                                                                                                              |
| R5 `task.propose` 可取消 | 注册为 manual operation，`Stop`/shutdown 可中止；模型请求同时受 120 秒请求超时约束                                                                                                                                                                                                                                                                                                                                                                  |
| R5 会话删除可取消        | `session.delete` 注册 operation，并在真正删除数据库前检查 abort；之前的资源关闭可被中断，不会留下半删除的会话                                                                                                                                                                                                                                                                                                                                       |
| R5 快照回收              | 启动回收之外，删除会话/归档/移除工作区后若本 Host 没有运行或手工操作，会以 host 独占锁再释放一次；发现 `.yuantu/hosts/` 还有其他活动 Host 时跳过，避免模型替换期间跨进程竞争。freeze/allocate 通过 `snapshotRelease` 与回收串行。`workspace-gc` 非 `--dry-run` 在 `.yuantu/hosts/maintenance.lock` 门内检查活动 Host、执行 `git gc --auto`；Host 启动也走同一道门，避免“检查通过后 Host 才开始”的竞态；owner ref 释放失败时把快照行写回，下一轮重试 |
| R5 并发额度              | `task.propose` / `context.compact` 占用 `ctx.modelSlots`，与运行共用 `maxActiveRuns`；`runSlotFree` / `admissionRefusal` 计入，结束后释放                                                                                                                                                                                                                                                                                                           |
| R5 失败原因              | `forbidden-path/unchanged` 使用独立 `protected-path-changed`，不再误报“定义无效”；桌面有对应说明                                                                                                                                                                                                                                                                                                                                                    |
| R5 归档列表上限          | `session.list { archived: true, limit: 500 }`，页面注明“最近 500 个”                                                                                                                                                                                                                                                                                                                                                                                |
| R5 小对象上限            | `InvariantRegistry.checked`（512）、`RunWatch.shown`（64）、`SnapshotMirror.waiting`（16 且清理过期 base）                                                                                                                                                                                                                                                                                                                                          |
| P2-4 桌面验收入口        | 已移除 composer 与计划面板的手动验收表单；普通桌面请求和批准计划改由 Agent 选择检查，复用后台验证及有界修复，结果区展示真实检查证据；详见 [自动验证](automatic-verification.md)                                                                                                                                                                                                                                                                     |
| UX 交付物/本地链接       | 交付物路径可预览、用默认应用打开、显示所在文件夹；Markdown 的工作区相对路径渲染为按钮，主进程 `realpath` + containment 校验后才调用 shell                                                                                                                                                                                                                                                                                                           |
| UX Windows 沙箱租约      | 设置 → 通用移除沙箱遗留锁维护面板及专用 IPC；底层权限恢复、恢复日志和 `sandbox-recover` 维护命令保留，live/unreadable 仍拒绝恢复；本次未增加自动恢复逻辑                                                                                                                                                                                                                                                                                            |

**验证（本轮实际执行）**：

| 检查                   | 结果                                                                                                                                                                                                               |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `typecheck`            | 通过                                                                                                                                                                                                               |
| `cycles:check`         | 通过                                                                                                                                                                                                               |
| `layers:check`         | 通过                                                                                                                                                                                                               |
| `references:check`     | 通过                                                                                                                                                                                                               |
| `i18n:check`           | 通过                                                                                                                                                                                                               |
| `test:isolation:check` | 通过                                                                                                                                                                                                               |
| `docs:check`           | 通过                                                                                                                                                                                                               |
| `format:check`         | 通过                                                                                                                                                                                                               |
| `npm run build`        | 通过（Host bundle 5.96 MB，桌面构建完成；`dist/packages/tools/automation.ps1` 已存在）                                                                                                                             |
| `bench:check`          | 13/13 规则通过（隔离运行；并发跑测试时曾因机器负载失败，非规则回归）                                                                                                                                               |
| `smoke:desktop`        | 7/7 通过；含模型替换、Host 恢复、权限只读与审批流程                                                                                                                                                                |
| 定向测试               | 95 通过 + 1 环境跳过（acceptance、completion、completion-baselines、tasks、task-workflow 含 proposal 取消、host-workflows 含删除取消）                                                                             |
| 定向测试               | 115 通过 + 14 环境跳过（desktop、lsp、mcp、run-notifications、desktop-i18n 等；缺少 LSP 可执行文件/MCP 管理范围关闭）                                                                                              |
| 新增/补充回归          | host-lock 4（含 maintenance gate）、workspace-file-path 2、markdown-links 3、workspace-reclaim 8（含 Host 拒绝、跨 Host 跳过、空闲回收）、session-archive 5（含 500 上限）、host-resource-locks 5（含 model slot） |
| 全量测试               | 通过：parallel 2846（2822 通过、24 跳过），serial 60（56 通过、4 跳过），0 失败；`FOUNDRY_TEST_CONTINUE_ON_FAILURE=1 node scripts/run-tests.mjs`                                                                   |

**仍保留的设计选择**：

- `task.propose` / `context.compact` 现在占用与运行相同的 `maxActiveRuns` 容量；锁冲突仍是立即拒绝，是否提供排队等待留作后续设计选择。
- task 默认指纹仍是整个工作区、两次指纹（P2-5），大仓库可用任务的 acceptance `inputs` 缩小监测范围；没有把默认改成 Git 跟踪文件，避免改变已有任务语义。
- 自动快照回收在启动时执行，并在空闲的删除/归档/移除后补一次；运行中的按需回收使用 `workspace-gc`，它先检查 `.yuantu/hosts/` 的 Host 标记、再执行 `git gc --auto`。回收通过 `snapshotRelease` 让新的 freeze/allocate 等待；owner ref 释放失败会把快照行写回以便下一轮重试。
- 桌面默认不读审计记录（P3-5），smoke 通过 `FOUNDRY_TEST_DESKTOP_AUDIT=1` 显式打开，避免测试依赖生产不加载的数据。
- UX 文档中的审批措辞、差异文件名转义、模型范围控制/token 用量属于产品与模型行为，未在本轮改动；Office 资源路径与 Windows 沙箱租约恢复已由工作区改动覆盖。

## 8. 后续修复（2026-10-20）

- **task / 自动验证的默认指纹范围**：`packages/core/completion-inputs.ts` 的隐式 `.` 范围在 Git 工作区内改为 Git 自己的视图——已跟踪文件加未忽略的未跟踪文件，`.gitignore` 排除的依赖树和构建产物不再读取；非 Git 目录回退到原文件系统遍历。派生目录排除、运行时数据库排除和显式 `inputs` 的语义不变。回归见 `tests/completion-inputs.test.ts` 的 Git 范围用例。
- **子代理导出可观测性**：新增实时事件 `subagent.workspace.progress`，在首次导出扫描时按 500 个路径节流上报 `processed/total`，桌面子代理卡片显示导出进度；`benchmarks/worktree-export.ts`（`npm run bench:export -- [files] [fileKiB] [rounds]`）覆盖 10k/50k 文件连续 3 回合的首次与后续导出成本。
- **保留策略边界**：新增 [工作区保留与清理边界](workspace-retention.md)，明确默认不自动删除、哪些动作会自动释放、`workspace-gc --dry-run` 该看哪几个字段，以及磁盘压力/升级/迁移前才判断清理的节奏。§4.3 的前两条（运行期释放、`git gc --auto`）已在第 7 节记录为完成；第三条以这份文档收口。
