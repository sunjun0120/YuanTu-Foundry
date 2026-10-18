# 能力缺陷修复记录（2026-10-18）

本文记录 [能力审查清单](capability-audit-2026-10-18.md) 中 CAP-01 至 CAP-09 及 REG-01 的实施结果。基线是当前未提交工作树，未创建 Git 提交；结论只代表本轮工作树。

## 1. 修复总表

| 编号   | 状态   | 修复要点                                                                                                            | 回归测试                                                                       |
| ------ | ------ | ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| CAP-01 | 已修复 | 冷恢复经 `WorkspaceManager.resolve()` 取回并校验 child binding，再传给 `childTurns`；无效/非 ready binding 拒绝恢复 | `tests/subagent-cold-binding.test.ts`                                          |
| CAP-02 | 已修复 | `reconcileInterruptedRuns` 与 `reconcileChildRuns` 改为每个会话/子代理独立事务；失败对象完整回滚                    | `tests/host-reconnect.test.ts` 新用例                                          |
| CAP-03 | 已修复 | `freezeSnapshot()` 在发布前用 `verifySnapshotStable()` 二次读取并比对路径、mode、sha256                             | `tests/workspace-snapshots.test.ts`                                            |
| CAP-04 | 已修复 | `createChildTurns` 暴露 `setEmit`；`ChildActivation` 在新 turn 前重绑当前父 run 的 emitter                          | `tests/subagent-run-binding.test.ts`                                           |
| CAP-05 | 已修复 | backend fallback 把 enumeration coverage 传入 `scanText`；环境准备失败也携带 inventory coverage                     | `tests/search-coverage.test.ts` 新用例                                         |
| CAP-06 | 已修复 | 空诊断分支先看 `settled`；未完成时只报告“尚未分析完成”                                                              | `tests/lsp.test.ts` 新用例                                                     |
| CAP-07 | 已修复 | 记录每个文档最近一次刷新失败；`recall_knowledge` 返回 `{results, freshness}`，覆盖零命中                            | `tests/knowledge.test.ts`                                                      |
| CAP-08 | 已修复 | 在 catalog load 开始前捕获 generation，加载结束写回该值，加载期间的通知会触发下一次重读                             | `tests/mcp.test.ts` 新用例                                                     |
| CAP-09 | 已修复 | 显式 `command` 覆盖时不再继承内置 `package` 绑定                                                                    | `tests/lsp.test.ts` 新用例                                                     |
| REG-01 | 已修复 | 测试统一用 `isRuntimeContext()` 区分机器上下文与人的输入；实际产品路径也修正了 fork 种子和“无可压缩 turn”判断       | `context-envelope`、`core`、`context`、`subagents*`、`hooks`、`session-log` 等 |

## 2. 关键实现说明

### CAP-01 隔离子代理冷恢复

- [run-residency.ts](../packages/core/run-residency.ts) 的 `ResidentToolOptions` 新增 `workspaceManager`；`resume()` 先 `resolve(childSessionId)`，拒绝非 `ready` 的 worktree binding，再 `validate()`，最后把 binding 传入 `childTurns`。
- [run-delegation.ts](../packages/core/run-delegation.ts) 把 `agent.workspaceManager` 接进消息工具。
- 首次委派创建的 activation 也带上 `setEmit`，与 CAP-04 的重绑共用同一条路径。

### CAP-02 恢复事务

- [session-runs.ts](../packages/storage/session-runs.ts) 的批处理不再包一个外层事务。每个会话的 `settleAbandonedRun` 各自 `port.transaction()`，失败对象回滚，其他对象继续。
- [session-tasks.ts](../packages/storage/session-tasks.ts) 的 `reconcileChildRuns` 把 child 收敛和 parent `subagent.interrupted` 通知放进同一个 per-child 事务。

### CAP-03 快照一致性

- [snapshot.ts](../packages/workspaces/snapshot.ts) 在 `collectStagedTree()` 后调用 `verifySnapshotStable()`；第二次 walk 读取路径集合和内容哈希，等长改写、增删/改名都会报 `WORKSPACE_SOURCE_CHANGED`。
- 同一文件把 format 3 blob 文件名从完整 64 字符 sha256 截为 32 字符前缀，避免 Windows 260 字符路径限制；读取仍兼容旧的完整 digest 文件名，并在读出后校验完整 sha256。

### CAP-04 常驻子代理进度

- [residency.ts](../packages/core/residency.ts) 的 `ChildActivation` 新增 `setEmit()`。
- [run-child-turns.ts](../packages/core/run-child-turns.ts) 把 emitter 放在可变闭包变量中，返回 `setEmit`。
- [run-residency.ts](../packages/core/run-residency.ts) 仅在真正启动新 turn 时调用 `activation.setEmit(options.emit)`；折入已有 turn 的 correction 不改变该 turn 的归属。

### CAP-05 搜索降级覆盖

- [search/service.ts](../packages/search/service.ts) 与 [tools/files.ts](../packages/tools/files.ts) 的 fallback 接收并合并 backend 传入的 coverage。
- [search-backend.ts](../packages/tools/search-backend.ts) 在无 binary / 环境准备失败时传 `input.inventory()`，而非空 coverage。
- [search/ripgrep.ts](../packages/search/ripgrep.ts) 的剩余文件 fallback 同样携带 inventory coverage。

### CAP-06 LSP 未完成分析

- [lsp/tools.ts](../packages/lsp/tools.ts) 的空诊断分支按 `diagnostics.settled` 输出：
  - settled：`no errors or warnings`
  - 未 settled：`no diagnostics yet (the language server has not finished analysing)`

### CAP-07 知识新鲜度

- [knowledge/store.ts](../packages/knowledge/store.ts) 新增 `KnowledgeFreshness`、`refreshFailures` 和 `freshness(root)`；刷新失败保留旧索引但记录 path/error/failedAt，成功或文件删除后清除。
- [knowledge/tools.ts](../packages/knowledge/tools.ts) 的 `recall_knowledge` 返回 `{ results, freshness }`，并更新工具描述。

### CAP-08 MCP generation

- [mcp/tools.ts](../packages/mcp/tools.ts) 的 `discover()` 在 load 前捕获 `generation`，`loadCatalog()` 结束时写回捕获值；加载期间的通知因此使 `loadedGeneration < generation`，下一次请求重读。

### CAP-09 LSP 显式命令

- [lsp/servers.ts](../packages/lsp/servers.ts) 合并 override 时：显式 `command` 且未显式 `package` 时不再继承内置 `package`。显式设置 `package` 仍可使用本地包入口。

### REG-01 机器上下文

- 受影响测试统一按 `isRuntimeContext()` 过滤，不把 skills 公告当成人输入。
- 产品路径的额外修正：
  - [run-subagents.ts](../packages/core/run-subagents.ts)：fork 种子不再包含运行时 skills 公告。
  - [context.ts](../packages/core/context.ts)：强制压缩要求历史里至少有一个 assistant/tool 消息；只有 prompt + 机器公告时不再尝试 summary。

## 3. 验证记录

- `npm run typecheck`：通过。
- 定向测试（直接运行测试文件，避免测试调度器依赖）：
  - `context-envelope` 9/9、`core` 43/43、`context` 44/44
  - `subagents` 42/42、`subagents-seams` 26/26、`subagents-fork` 11/11、`subagent-workspaces` 11/11
  - `host-reconnect` 8/8、`session-log` 8/8、`append-batch` 6/6、`hooks` 18/18
  - `workspace-snapshots` 15/15、`runtime-workspace-policy` 4/4
  - `knowledge` 27/27、`search-coverage` 18/18、`mcp` 34/34（10 项产品范围 skip）
  - `lsp` 40/40（4 项环境 skip）
  - `subagent-cold-binding` 2/2、`subagent-run-binding` 2/2、`turn-snapshot` 4/4
- 全量 `node scripts/run-tests.mjs --continue-on-failure --concurrency=6`：
  - parallel：2681 例，2656 pass，1 fail，24 skip
  - serial：58 例，54 pass，0 fail，4 skip
  - 唯一失败：`office.test.ts` 的 `.pdf` preview fallback，本机 Office automation 脚本在第 18 行报 null 表达式错误；该测试单独运行时通过，属于本机 Office 自动化环境问题，不是本轮改动。
- 快照：`npm run snapshot:update` 重新生成 `tests/snapshots/*.json`；`turn-snapshot` 4/4 通过。

## 4. 剩余边界

- 未创建 Git 提交；工作树仍包含此前并行改动。
- 未运行桌面真窗口、真实模型端到端、覆盖率、基准和打包发布流水线。
- `office` 全量运行失败依赖本机 Office 自动化环境，未修改 [office/automation.ps1](../packages/office/automation.ps1)。
- CAP-03 的二次 walk 增加了冻结成本；本轮没有重新测量大仓库峰值 RSS/耗时。format 3 的 blob 名变更保留了对旧完整 digest 文件名的读取兼容。
- OPT-01 至 OPT-03 仍按原文档保持“待验收/优化建议”，未在本轮实施。
