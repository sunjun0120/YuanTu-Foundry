# 测试工作流

日常开发先运行 `npm run check:changed`，阶段验收运行 `npm run check:full`，发布前运行 `npm run check:release`。发布门禁包含真实 Electron 桌面冒烟，需要可用的图形桌面；安装包构建及安装验收仍单独执行。CI 继续使用现有 `check` 聚合和独立桌面任务。

## 按改动验证

`check:changed` 默认比较 HEAD 与当前工作区，包含暂存、未暂存、删除和未被忽略的新文件。提交后的分支验证需要显式传入基线，例如 `npm run check:changed -- --base main`；在干净工作区默认返回无改动，不能据此宣称完成全量验收。

脚本沿静态导入、再导出及代码中的字面量工作进程路径，查找传递依赖的行为测试。改动测试文件会运行该文件及其消费者；纯 README 或 docs Markdown 改动不运行行为测试，但仍执行相关格式、生成事实、路径引用和语言检查。涉及代码时也执行全项目类型检查。

应用入口、测试脚本、共享测试辅助文件和 core/protocol/storage/tools/client/carrier/sdk 共享关键模块具有隐式消费者，直接回退现有完整 `check`。配置、快照或其他资源、删除的源码、未识别文件、找不到测试的源码也回退完整检查。桌面代码或 tests 下非行为测试文件（辅助文件、夹具、快照、冒烟）的改动在完整检查后追加桌面冒烟，确保辅助文件的隐式消费者也被验证。静态依赖分析不能证明所有运行时加载关系，所以部分验证始终不代表全量通过。

预览不会运行测试或写入日志：

```powershell
npm.cmd run check:changed -- --plan
npm.cmd run check:changed -- --base main --plan
# --files 只允许用于预览；真正执行时必须读取完整 Git 改动。
npm.cmd run check:changed -- --plan --files tests/host-requests.test.ts
```

## 日志和失败

`npm test` 与冒烟入口只显示测试数量、通过/失败/跳过/取消数量、耗时、跳过原因和失败详情。完整 spec 输出写入被 Git 忽略的 `.scratch/test-logs/`，每次运行打印绝对日志路径；开发检查的门禁输出保存在 `.scratch/check-logs/`。失败仍返回非零退出码，门禁失败会停止后续步骤。日志保留用于排查，可在验收结束后自行清理。

```powershell
npm.cmd test -- tests/host-requests.test.ts
npm.cmd test -- --test-name-pattern="timeout" tests/host-requests.test.ts
npm.cmd run test:verbose
```

减少 token 主要依靠只把汇总和失败详情传入对话，而不是让模型读取整份成功日志。检查已通过且相关源码、测试、配置、依赖与运行环境未变化时，不重复执行；本次没有引入跨运行的测试结果缓存，避免将旧结果冒充本次验证。

## 并发和类型检查

行为测试与桌面冒烟默认仍串行，避免共享进程、端口和系统资源的测试因并发变得不稳定。可对已确认独立的测试文件显式使用并发：

```powershell
npm.cmd test -- --concurrency=2 tests/host-requests.test.ts tests/context-envelope.test.ts
```

先比较同一组文件串行与并发的耗时和结果，再扩大范围；并发不保证按倍数提速。编译后客户端冒烟保留文件间并行执行。

类型检查启用 TypeScript 增量缓存，位于 `.scratch/cache/typecheck.tsbuildinfo`；仍检查整个项目，缓存只复用编译分析。分发构建显式禁用增量，继续完整生成产物，避免部分输出被删除后误用缓存。没有调整覆盖率门槛、测试跳过条件或原有完整门禁。
