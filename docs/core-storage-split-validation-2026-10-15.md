# Core / storage 拆分与验证（2026-10-15）

本轮接续另一个 agent 停止后的工作树，修改两个原入口、一处回归测试的拦截位置，并新增职责模块。已有未提交修复作为基线保留；本轮不提交 Git。

## 结果

| 入口                       |  搬迁前 |  搬迁后 | 职责                                         |
| -------------------------- | ------: | ------: | -------------------------------------------- |
| packages/core/agent.ts     | 2694 行 | 1480 行 | 会话收件箱、运行装配、轮次推进及策略切换     |
| packages/storage/sqlite.ts | 2446 行 | 1134 行 | 单连接初始化、子组件装配、兼容入口和投影读取 |

行数按 text.split('\n').length 统计，包含注释与末尾空行。

Core 新增 agent-options.ts、run-task.ts、run-request.ts、run-finalization.ts 和 run-delegation.ts，分别管理公开选项/输入类型、Task 生命周期、单轮模型请求/流式持久化/有界恢复、退出清理与结果发布、子代理 provider/report 装配。AgentOptions 继续从 agent.ts 导出。

Storage 新增 session-task-definitions.ts、session-completion.ts、session-context.ts、session-runs.ts 和 session-event-journal.ts。SessionStore 的公开方法与导出路径保留。所有组件共用一条 DatabaseSync 连接；事务深度、缓冲消息、待提交事件、缓存和观察者均属于唯一的 SessionEventJournal。最终完成判定、绑定目标与 run.finished 仍在同一事务内提交，提交后发布通知。

## 验证

- 修改前普通本地基线：123/123 通过。受限执行环境先前的本地端点连接和 SQLite 备份重命名失败单独记录，不据此修改产品逻辑。
- 首轮存储搬迁：123/123 通过。
- 首轮 Agent 搬迁：162 项，159 通过、3 跳过、0 失败。
- 统一日志组件：74/74 通过（8 个实际文件），覆盖缓冲消息顺序、观察者回滚/异常/变异隔离、投影、租约与流恢复。局部命令误写了不存在的 transcript-cache.test.ts，Node 忽略该路径；实际的 log-cache.test.ts 已在全量测试中 7/7 通过，单独核对其文件汇总。
- 53 个存储方法体与搬迁前快照比较一致；仅归一化接口访问及格式。
- 公开类型兼容性：Agent 方法、AgentOptions 与 SessionStore 方法双向赋值检查通过。
- 类型检查、完整构建、格式、文档事实、引用、i18n、静态导入循环门禁通过；静态图 334 文件、828 值边、0 环。
- 独立只读审查未发现本轮可行动问题；审查对比执行前源码快照，而非含其他修复的 HEAD 差异。
- 首次完整串行 npm test：228 文件、2,427 项，2,312 通过、1 失败、114 跳过，退出码 1；测试耗时 1491.86 秒，运行器墙钟 1491.93 秒。唯一失败是 storage-audit-repairs.test.ts 的并发缓存回归仍在拦截已搬走的 SessionStore.readEvents，报 TypeError: Cannot read properties of undefined (reading 'bind')。单独复现相同失败后，把拦截点迁到实际持有该方法的 journal，并保留真实第二连接提交和原内容断言，增加 injected === true 防止空跑。独立复核确认注入窗口与保护不变。
- 测试适配后，storage-audit-repairs / log-cache / append-batch / background-deliveries / projection-checkpoint / session-log 六个文件共 52 项：51 通过、1 跳过、0 失败；退出码 0。该定向回归不改写首次全量的失败记录，本轮没有再次完整重跑。
- 最终类型检查、门禁与编译客户端冒烟通过；客户端 3/3。
- 核对 650 个源码、脚本与测试文件哈希：全量测试后仅有上述测试适配变化，产品源码没有再改动；原有其他未提交文件哈希均未变化。

## 复验

```powershell
npm.cmd run typecheck
npm.cmd run cycles:check
npm.cmd run i18n:check
npm.cmd run build
npm.cmd test -- --schedule=serial
npm.cmd run smoke:client
```

本轮复用现有行为回归，未新增只检查文件布局或转发实现的测试。局部回归和静态审查不替代全量结果；跳过项不视为能力验收。

修正后的定向复验命令：

```powershell
npm.cmd test -- tests/storage-audit-repairs.test.ts tests/log-cache.test.ts tests/append-batch.test.ts tests/background-deliveries.test.ts tests/projection-checkpoint.test.ts tests/session-log.test.ts
```

验证完成后清理本轮临时源码快照、检查脚本及原始运行日志，保留本记录和实施计划。构建输出保留在项目正常构建目录。
