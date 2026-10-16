# 默认并行与测试工程隔离实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans。用户明确选择本会话直接实施，按任务执行，不在任务之间重复请求确认；最终进行一次独立整批审查。

**Goal:** 以每文件工程隔离替代 SHA-256 人工并行准入，默认并行并保留少量共享机器资源串行标签。

**Architecture:** 父运行器为每文件分配独立环境、临时目录和 Node 测试进程，使用统一引导探针、静态规则和生命周期验证。并行池结束后运行真实共享机器资源组，沿用报告器和逐文件报告完整性规则。

**Tech Stack:** Node.js 24、TypeScript、node:test、现有 AST 与 reporter，无新依赖。

**Spec:** [已批准设计](../specs/2026-10-16-isolated-test-scheduling-design.md)。

**接续状态（2026-10-16）：** Task 1–6 的代码已接续实现，静态审查问题已修复；最终代码尚未运行完整验证。用户要求“先完成代码，暂缓测试”，下次从本文末尾的待验证清单恢复，不重做已完成实现。Task 7 未执行。

## Global Constraints

- 基线 c26b7bc；复用当前 checkout，不 stage/commit/reset/clean，不覆盖其他任务改动。
- 每文件独立 tmp/home/state/cache/artifacts；普通 worker 只可写自己的根，仓库 cwd 只读；进程 cwd 不允许由测试改变。
- 监听 loopback:0；禁止先探测再释放端口；串行标签不全面关闭隔离检查。
- 默认并发 min(4, availableParallelism)，显式参数可覆盖；强制串行仍使用相同隔离契约。
- 使用 RED/GREEN 定向验证，隔离违规全部收口后才进行串行/并行完整验收，不新增 skip 或自动重试掩盖失败。
- 不改变真实 Windows 原生安全控制目录和 guest 的生产环境白名单。

## Review Focus

- ESM/named imports、sync/callback/promises/句柄，以及捕获异常后退出 0：违规仍必须失败。
- junction/symlink 与兄弟 worker 路径：目标实际归属必须检查，不能只做字符串前缀。
- SQLite 与经过环境过滤的子进程：路径归属和探针覆盖不能混淆。
- 嵌套 runner、过滤后 0 case、测试导入前崩溃：报告完整性与隔离目录应保持正确。
- 并发取消、孤儿进程、跨 runner 机器资源租约：不得误删他人的锁或误杀无归属进程。

## Task 1: 普通用户状态根

Files: 新增 `packages/platform/user-state.ts`；修改 providers/credentials、mcp/oauth、knowledge/memory、knowledge/store、protocol/settings；测试 `tests/user-state.test.ts` 及已有路径/设置测试。

Interfaces: `userStateDirectory(env?: NodeJS.ProcessEnv): string`；`YUANTU_STATE_DIR` 绝对路径，未指定使用原 home/.yuantu；已有单项覆盖优先。

- [ ] 写路径默认值、统一覆盖、单项优先、相对路径拒绝回归，运行观察 RED。
- [ ] 实现低层路径模块及四处接线，登记设置与生成事实；不改 native Windows 路径。
- [ ] 运行 user-state、credentials、oauth、memory/knowledge、settings 定向测试，读取输出确认 GREEN。

## Task 2: 资源标签与隔离 lint

Files: 重写 `scripts/test-execution-policy.ts` 的准入部分；新增 `scripts/test-isolation-lint.ts` 与入口；更新 policy 测试，新增 lint fixtures。

Interfaces: `partitionTests(files,{root}) -> {parallel,serial,reasons,resources}`；`serialResources(source,file)` 解析 `@test-serial resource: reason`；`lintTestIsolation(root,files)` 返回带文件/行/规则的违规。

- [ ] 新文件默认并行、声明资源串行、非法资源/原因/重复报错测试 RED。
- [ ] 实现资源枚举与源文件头标签，保留 discovery 与 normalizeRepoPath。
- [ ] AST 检查 chdir、真实绑定固定端口、仓库写出模式与状态路径；包含别名和同名非网络 bind 防误报测试。
- [ ] 运行策略/lint 定向验证，检查规则本身能识别故意违规样例。

## Task 3: 每文件环境与引导探针

Files: 新增 `scripts/test-isolation/{environment,bootstrap,filesystem,network,processes}.mjs`；新增 `tests/test-isolation.test.ts` 与临时生成的 worker fixtures。

Interfaces: `createIsolation(parentRoot,file,resources)` 产出私有根、子环境及引导配置；bootstrap 在测试模块前启用检查；违规写入私有记录，由父进程验收，不能由测试吞掉。

- [ ] 两个同名数据库/文件/默认状态并发无交叉，真实 bind:0 端口不同的 fixture 测试 RED。
- [ ] 实现子环境副本、普通产品状态、缓存和 artifact 私有目录，不修改父环境。
- [ ] 实现 sync/callback/promises/句柄/流写入、两端路径、链接目标、chdir、网络监听约束；覆盖 SQLite 构造与目标路径检查。
- [ ] 验证普通子进程环境承接、被过滤 guest 的真实契约保留；明确覆盖范围，不扩产品 NODE_OPTIONS 白名单。
- [ ] 故意越界、捕获异常、SQLite sidecar、链接逃逸与残留进程测试逐项 RED/GREEN。

## Task 4: 隔离文件调度器

Files: 修改 `scripts/run-tests.mjs`；拆分新 `scripts/test-scheduler.mjs`、`scripts/test-report-merge.mjs`；更新 runner-shapes、timings 与新增 scheduler fixtures。

Interfaces: 单文件任务消费 Task 2 分组与 Task 3 隔离描述；返回 exitCode、report、duration、违规/清理状态。合并报告保留 file-summary/run-summary 并校验每个请求文件。

- [ ] 默认并发、串行模式同隔离、并行组与串行组不重叠、报告丢失/截断 fixture RED。
- [ ] 实现 bounded 文件池及每文件 Node test harness；父控制日志与测试写目录分开，嵌套 runner 的日志位于外层私有根。
- [ ] 实现失败与取消清理、权威违规结算、机器资源租约，所有权不明时拒绝而不强删。
- [ ] 保持过滤 0 case 合法、空文件/提前退出非法；单文件与跨文件 totals 元数据正确。
- [ ] runner-shapes、timings、scheduler、跨 runner 租约/取消定向测试 GREEN。

## Task 5: 迁移夹具与标签

Files: tests/macOS packaging、coding-evaluation、agent/desktop smoke artifacts、terminal；实际执行 native Windows 的测试文件；统一进程/HTTP fixture。

- [ ] 运行 lint 取得具体违规清单，不预先跳过失败。
- [ ] chdir 用例改为显式 cwd 子进程；编码评测 `.scratch` 和截图改为 worker 私有 tmp/artifacts。
- [ ] 拆出真实 PTY 测试；给真实 native/desktop/机器租约/OS keychain 用例添加资源标签，纯 fixture 租约与 fake 测试继续并行。
- [ ] 修复环境显式断言与路径覆盖回归，保持产品测试目标及原 skip 策略。
- [ ] lint 全库通过；运行所有被修改文件及冲突代表性组合，观察 GREEN。

## Task 6: 入口、文档与最终审查

Files: package.json、README、活跃架构说明、CI/coverage/changed 入口及门禁回归；移除 test-parallel-safe.json 的活跃依赖。

- [ ] 追踪全部实际引用后更新入口，增加 isolation 检查；备用入口不能绕过隔离。
- [ ] 更新 docs-facts 与使用说明，保留历史审计文字并修正失效链接。
- [ ] 类型/格式/文档/引用/i18n/循环/构建全部通过。
- [ ] 一次 fresh-context 整批只读审查；重要遗漏按 RED/GREEN 一并修复，再做完整验收。

## Task 7: 最终等价性与性能验收

- [ ] 冻结源码与文件集，保存分组计划、资源标签、skip 基线。
- [ ] 同一冻结源码先强制串行完整运行，再默认并行完整运行，记录原始 timings 与元数据。
- [ ] 逐文件与 case 结果等价，无新 skip、无自动重试、无目录/进程残留；输出实测阶段与整体墙钟。
- [ ] 核对源码哈希，更新验收与执行记录，清理本轮明确拥有的临时文件；不提交 Git。

## 执行记录

- 用户已批准设计并指定本会话直接执行。Ruling：计划只细化已批准设计；遵从用户直接实施指令持续执行，不再对常规实施步骤重复请求批准。
- Ruling：复用当前 clean checkout c26b7bc，不新建 worktree，不执行 Git 提交；不改变用户其他 checkouts 或机器用户配置。
- Pre-flight：Task 1 的状态根供 Task 3 注入；Task 2 的资源声明供 Task 4 调度及 Task 5 迁移；Task 3 的私有根与违规记录供 Task 4 结算。实现时以本文接口为准，局部调整记录原因。
- Task 1 complete：user-state 四项 RED 均正确复现；实现统一状态根与设置接线后，user-state/credentials/knowledge/settings 四文件 62/62 GREEN。native Windows 目录与工具 guest 环境白名单未修改。

## 2026-10-16 接续记录

- 已接续原工作区，不执行 Git stage/commit/reset/clean；本轮开始前存在的历史文档删除保持原状。
- 用户最新指令：**“先完成代码，暂缓测试”**。收到指令后不再启动测试、构建或完整门禁；当时已经运行的回归自然结束。Task 7 完整串行/并行等价性和性能验收仍未执行，不得宣称优化已经验收完成。
- 已接入默认隔离并行：每文件进程与 tmp/home/state/cache/artifacts，默认并发 min(4, availableParallelism)，显式 serial 仍应用相同隔离。
- 资源标签替代 SHA 白名单；真实机器资源阶段使用跨运行器租约；旧白名单文件与活跃入口引用已移除。
- 探针涵盖文件/句柄/链接归属、loopback 动态端口、SQLite 文件输出、子进程 cwd 与登记；普通状态使用 YUANTU_STATE_DIR，产品 guest 环境过滤与 Windows 安全目录保持原合同。
- 已迁移打包 cwd、编码评测与维护临时目录、桌面截图、真实 PTY 文件分离、快照生成及回滚烟测夹具。
- 运行器分拆为调度、报告合并、资源租约模块；加入覆盖率集中合并和后续等价性比较脚本。覆盖率依赖 Node 24 内部原生 V8 合并 API，版本或证据不匹配时失败，不降低阈值。
- 暂缓前证据：起始 16 项基础定向回归通过；资源策略/lint 10 项通过；探针扩展版 13 项通过；隔离夹具代表集 81 项通过；编码评测及快照 25 项通过。以上为不同阶段且可能交叠的回归集，不相加作为最终验收数量。
- 暂缓后的 SQLite 表达式检查、最终调度/租约/覆盖率接线、报告与入口回归、额外截图/回滚迁移以及审查修复均待运行验证。
- 自动审批服务曾两次返回 503，相关集成测试命令未执行；随后用户主动选择暂缓测试。当前停测依据是用户最新指令。
- 一次独立静态审查提出：补入 Node 后代自登记清理、Windows 覆盖率协作取消、真实 PTY/native 资源调用检查、旧串行断言更新。修复与定向静态复核记录见后续执行记录；不以静态检查代替运行验证。

### 恢复测试后的验收顺序

1. 定向运行 user-state、test-execution-policy、test-resource-policy、test-isolation-lint、test-isolation、test-runner-shapes、test-workflow、test-scheduler、test-entrypoints 与 terminal-real，先处理所有失败，不增加 skip 或重试掩盖。
2. 执行全库隔离 lint、格式、类型、文档事实、引用、循环、i18n、构建及被修改的夹具回归。
3. 确认源码冻结后运行 `npm run test:serial -- --timings=artifacts/isolated-test-scheduling/serial.ndjson`。
4. 在相同源码、环境和测试文件集合下运行 `npm test -- --timings=artifacts/isolated-test-scheduling/parallel.ndjson`。
5. 使用 `node scripts/compare-test-runs.mjs artifacts/isolated-test-scheduling/serial.ndjson artifacts/isolated-test-scheduling/parallel.ndjson` 比较源码指纹、逐 case 状态/skip 原因、资源标签及清理状态；再记录实际墙钟与提速比。
6. 运行集中覆盖率入口及所需桌面/原生烟测，检查本次残留目录与进程。未取得这些证据前保持“代码已接续，验收待执行”。

### 最终静态审查结论

- 独立复核确认四项审查问题均已修复：后代自登记结算、Windows 协作取消、原生资源标签/PTY 生命周期检查、旧串行断言。
- 资源租约以完整候选文件原子发布，避免竞争者读到空 owner；只释放本进程持有的 token，不删除未知归属锁。
- 覆盖率采集目录不传播给测试 worker；每文件原始报告保持 V8 文件名并以禁止覆盖方式汇集。worker 产物在清理前复制到父运行器日志目录。
- 新增源码前后指纹及串行/并行逐 case 比较工具；源码变化、隔离违规、报告缺失或清理异常都不能作为通过的等价性证据。
- 本阶段结论仅为**代码接线与静态审查完成，运行验收待执行**。Windows ConPTY 异步 PID 登记、取消/后代清理、Node 24 原生覆盖率合并以及后续原生夹具拆分仍需实机验证。
- 最后核对已将真实 Git、restricted-consumers、AppContainer 用例拆到独立 native 文件，保留共享 fixture，普通/fake 用例继续并行；Windows Host 实际执行文件增加资源标签。CI 与平台验收脚本的显式文件集已同步，新拆分未运行测试。
