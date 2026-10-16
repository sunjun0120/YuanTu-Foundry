# 稳定范围修复与验收记录（2026-10-15）

本轮按稳定改动复核的建议修复四项 P2 边界问题，保留其他 agent 的未提交修改。`HEAD` 为 `27bb60398e9e1fe32f2beb5b8f33868b0ffd0bc1`，结果针对当前工作树，不等同于该提交。本轮没有调用真实模型；使用假模型核对用量与生命周期，并运行真实临时 Git、SQLite 和本地沙箱测试。此前 DeepSeek-V4.1-Flash 的七场景结果属于上一轮证据。

## 已修复的四项

| 问题                                                  | 最终行为                                                                                                                                                        | 可检查的回归                                                                                                                                                                         |
| ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Resident 后续轮次在取消等待后丢失用量与 finished 事件 | 结算绑定到轮次；父 Agent 在关闭工具、检查最终状态和保存统计前，取消并等待自己发起的后续轮次。纠正消息仅观察既有轮次，避免重复计费；提前拒绝的后台结算仍报告失败 | [subagent-usage.test.ts](../tests/subagent-usage.test.ts) 8/8：包含工具取消、父 Agent 取消、正常结束后台轮次、后台提前拒绝，以及正常等待/后台和纠正消息用量                          |
| 循环依赖门禁漏掉缩进/BOM 导入并误读注释               | 用 TypeScript AST 提取静态值导入与重导出，排除纯类型语句；扫描 `.ts/.mts/.cts/.tsx`，包含 CommonJS 的 `import = require()`                                      | [import-cycles.test.ts](../tests/import-cycles.test.ts) 7/7：缩进、BOM、注释、类型导入/重导出、值重导出、`.mts` 和 `.cts`                                                            |
| Git 达到捕获上限后，已捕获尾部无法落盘                | 五个读取工具以结构化 `truncated` 标志交付原始捕获；mutation 执行失败也保留该标志。spill 保存全部已捕获内容，并明确称为部分捕获                                  | [spill.test.ts](../tests/spill.test.ts) 的 1,000/3,000 行真实 diff；[git-write.test.ts](../tests/git-write.test.ts) 的失败 hook 输出 60,000 字节，保存 48,000 字节并确认没有生成提交 |
| Office 普通操作错误包含授权关键词时被误报为不可用     | 按 PowerShell 的安全类别与错误编号判断拒载；操作错误的脚本栈不作为拒载。普通替换文本出现三个授权关键词仍是操作失败                                              | [office.test.ts](../tests/office.test.ts) 的真实错误记录形状与 Word/PowerPoint 替换文本负例                                                                                          |

上述原始失败和 reviewer 追加的三个边界均先复现失败，再修复并复验。独立只读 reviewer 对最终补丁未发现新增、可复现的问题。

边界仍然明确：Git 捕获上限为 **48,000 字节**，未捕获的尾部无法恢复；本轮未改变成功 mutation 摘要的既有有界输出策略。循环门禁检查的是静态导入图，不证明动态导入、普通 `require()` 调用和运行时装配没有循环。

## 验证结果

- 重点回归 66 项：**63 通过、0 失败、3 跳过**。Git 组包含真实 Windows 沙箱读取，单独串行执行时通过；跳过为 POSIX 权限位检查与两项 Office 脚本加载限制。
- 类型、构建和编译客户端冒烟通过，客户端 **3/3**。
- 循环门禁：319 文件、792 条值边、0 环；排除 496 条类型导入与 11 个动态调用。
- 最终全量串行 `npm test`：**2,420 项，2,299 通过、8 失败、113 跳过**，退出码 1；测试耗时 1,763.64 秒，运行器墙钟 1,763.75 秒。**全量未通过**。
- 最终并行计划为 16 个并行、211 个串行文件，总计 227；`awaiting-review=0`。这只是资格计划，本轮全量实际按串行执行，没有重新登记白名单。
- 全测前后哈希核对：产品源码、脚本及测试没有变化；只有其他 agent 正在编辑的架构评估文档变化。本记录在全测结束后新增，避免覆盖该文档。

全量的八条失败记录如下，不能直接称为八个独立代码缺陷：

| 文件                                                                      | 失败记录数 | 观测结果                                                              |
| ------------------------------------------------------------------------- | ---------: | --------------------------------------------------------------------- |
| [host-workflows.test.ts](../tests/host-workflows.test.ts)                 |          1 | 前台命令 15 秒内没有写出 PID 文件，尚未验证命令取消行为               |
| [native-git.test.ts](../tests/native-git.test.ts)                         |          1 | Windows 工作区 ACL 租约检查拒绝                                       |
| [sandbox-appcontainer.test.ts](../tests/sandbox-appcontainer.test.ts)     |          4 | 子进程、pipe、取消与清理用例均被 ACL 租约检查拒绝，未进入对应功能验证 |
| [sandbox-windows-assets.test.ts](../tests/sandbox-windows-assets.test.ts) |          1 | 清理资产用例被 ACL 租约检查拒绝                                       |
| [sandbox-windows.test.ts](../tests/sandbox-windows.test.ts)               |          1 | hardlink 用例收到 ACL 租约错误，未进入预期的 hardlink 拒绝路径        |

用户确认全测期间另有原生沙箱任务运行。一次只读锁快照中的 PID 26600 属于本轮 `sandbox-windows.test.ts`，该快照只能定位当时持有者，不能解释较早的冲突；不能把全部错误直接归因为外部任务，也不能根据锁错误文案排除其他原因。需要独占环境复测。没有删除租约锁或停止其他任务，也没有递归改变项目安全标签或强制绕过脚本授权。

Office COM、完整 LSP 服务端、真实 WFP 网络隔离、安装/签名与 macOS 行为的跳过或环境限制，不是这些能力的功能验收。本轮修复也不意味着原审计的 34 条历史跟踪项全部关闭。

## 下一步

1. 等其他原生沙箱任务结束，在独占环境复测上述五个文件。记录锁创建/释放、持有者和实际启动阶段；PID 超时若仍复现，再定位启动及取消路径。保留原失败日志，不用重跑通过覆盖它。
2. 修复 [i18n-gate.mjs](../scripts/i18n-gate.mjs) 的 `CORE_ALLOWED` P3 缺口：当前允许模式匹配一行的一部分后，追加未登记中文仍可能放行。应核对完整字面量，并覆盖追加中文、同一行新增中文与合法模型提示词三类夹具。
3. 其他 agent 完成修改后，再将本记录的关闭状态合并到主评估文档。仍需保留其条件性安全设计、任务草案语言和平台验收的独立边界。

```powershell
# 本轮重点回归；真实沙箱测试需要独占环境
node --test --test-reporter=spec --test-concurrency=1 tests/subagent-usage.test.ts tests/import-cycles.test.ts tests/git-write.test.ts tests/native-git.test.ts tests/spill.test.ts tests/office.test.ts

# 独占环境定位全量失败，串行运行
node --test --test-reporter=spec --test-name-pattern='Host cancellation after command effects' tests/host-workflows.test.ts
node --test --test-reporter=spec --test-concurrency=1 tests/native-git.test.ts tests/sandbox-appcontainer.test.ts tests/sandbox-windows-assets.test.ts tests/sandbox-windows.test.ts

# 全量重跑命令；本轮原始结果为失败，不标为通过
npm.cmd test -- --timings=artifacts/remaining-repairs-20261015/full-timings.ndjson
```

原始证据保存在 `artifacts/remaining-repairs-20261015/`：`focused-validation.json`、`full.log`、`full-timings.ndjson`、`full-summary.json` 及前后源码哈希与差异。运行器输出为 NDJSON，原命令的 `.json` 计时文件已按实际格式改名，原命令记录在汇总中。首次全测在复核追加修复时主动停止，其日志和哈希以 `aborted-*` 保留，仅用于诊断。中断留下的本轮隔离夹具已清理；本轮未提交 Git。
