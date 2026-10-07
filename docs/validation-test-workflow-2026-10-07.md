# 测试工作流优化验证（2026-10-07）

本次修改增加开发选测入口、测试汇总输出及增量类型检查，保留原有完整检查、覆盖率门槛和桌面串行执行。用法见 [测试工作流](testing-workflow.md)。未引入跨运行的测试结果缓存。

## 已验证

- 新流程回归 8/8：成功日志保留、失败退出码和断言详情、跳过原因、名称过滤、传递导入和工作进程路径、未知/删除源码回退、共享冒烟辅助文件覆盖、Git 暂存/未暂存/删除/新文件与忽略规则。
- 针对性验证 5/5：共享冒烟辅助文件，以及原始 Node 脚本和汇总 wrapper 两种 manifest 的按文件验证、失败用例精确重跑、路径约束和审批行为。
- 类型检查、完整构建、生成事实和语言检查通过；本次修改文件的格式检查通过。
- 编译后客户端冒烟 4/4，Web 冒烟 2/2。客户端子进程清理在受限环境中失败，原始 Node 命令也复现；具备正常清理权限后同一用例及完整客户端冒烟通过。
- `check:changed` 真实执行选择完整检查，并在引用检查失败时返回 1、停止后续步骤；没有将门禁失败转为成功。
- 一次独立审查发现并修复了共享辅助文件漏掉桌面冒烟、wrapper 使 `run_validation` 定向能力识别失效两项问题；修复已复核。

完整行为测试共 147 个文件、1484 项：1476 通过、8 跳过、0 失败、0 取消，退出 0，耗时 778.32 s。先前受限环境中的运行因子进程清理无法完成而停止并清理；上述结果来自具备正常清理权限的完整重跑。8 项跳过对应四种真实语言服务器缺失/不可用、Chromium 已安装而无法覆盖缺失路径、未启用的 Docker/sbx 实机测试，以及 Windows 不适用的 POSIX 权限检查。

本次没有证明全量测试本身显著加速；主要收益来自减少日常验证范围、避免重复验证、增量类型检查及精简输出。

## 单次性能观察

| 对比                                        | 结果                              |
| ------------------------------------------- | --------------------------------- |
| 同一组 13 项测试，串行 / 并发 2             | 3.34 s / 2.95 s，均 13/13         |
| 同一组 13 项测试，完整 spec 日志 / 汇总输出 | 1995 / 217 字节，完整日志仍保留   |
| 全项目类型检查，无缓存 / 增量暖缓存         | 21.77 s / 4.73 s，均退出 0        |
| 单个测试文件改动的计划                      | 147 个文件中选中 1 个             |
| 纯 README 改动的计划                        | 选中 0 个行为测试，仍保留文档门禁 |

这些是本机单次观察；测量时其他测试和构建也在运行，不能视为稳定基准或 token 计费测量。并发收益有限，因此没有提高单测默认并发。

## 完整门禁的限制

引用检查发现三处在本次修改前已经存在的缺失文档链接：

- `docs/development-recommendations-2026-10-05.md` 指向已删除的 `capability-comparison-dsh-2026-10-05.md`。
- 同一文件指向已删除的 `architecture-capabilities-2026-10-05.md`。
- `docs/performance-optimization-2026-10-06.md` 指向缺失的 `live-model-performance-2026-10-06.md`。

保留用户原有文档删除和 build 目录，没有恢复缺失文件或绕过引用门禁。

桌面冒烟 42 项，39 通过、3 失败；原始 Node 入口复核这三项也全部失败：

- `desktop window completes chat, file approvals, cancel and history after restart`：聊天等待条件超时。
- `background entry stays hidden without jobs and popover closes on outside click`：后台入口可见性断言失败。
- `background jobs appear beside subagents with live status and a compact list`：后台任务列表/文案断言失败。

验证过程中 `apps/desktop/index.html`、`apps/desktop/layout.css`、`apps/desktop/renderer.ts`、`tests/agent.smoke.mjs`、`tests/desktop.smoke.mjs` 另有修改，不属于本次优化，已保留。桌面结果对应运行当时的测试和构建，不能作为后来界面改动的验收。随后又按当时工作区完成了一次类型检查和构建，之后的界面改动没有重新做桌面验收。

详细测试日志位于 `.scratch/test-logs/`，开发门禁日志位于 `.scratch/check-logs/`，运行入口会打印本次的绝对路径。
