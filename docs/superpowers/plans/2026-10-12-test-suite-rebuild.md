# YuanTu-Foundry 测试体系重构执行计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. 如明确选择代理执行，可使用 superpowers:subagent-driven-development。步骤使用复选框记录进度；执行者必须遵守所在环境的权限与代理规则。

**Goal:** 按项目能力重建清晰、可维护、分层执行的测试体系，减少无效重复和反馈时间，同时保留关键行为、历史缺陷与平台验收保障。

**Architecture:** 先建立当前工作树的验证基线和能力映射，再按能力逐批保留、合并或重写测试。新旧测试并行通过、删除条件满足后，才移除对应旧用例。第一轮保持现有测试发现规则和公开接口。

**Tech Stack:** Node.js >= 24、ESM、TypeScript、node:test、Prettier、Playwright/Electron、SQLite；平台沙箱还涉及 Windows Rust helper 和 macOS Seatbelt。

**Spec:** 本文“需求与范围”及“全局约束”是执行依据，来自本次讨论的测试重构建议。用户本次要求交付执行文档；本文不表示测试重构已经执行，也不自动授权提交、推送或修改产品行为。

## 需求与范围

- 将测试组织方式从历史文件堆积调整为能力、风险和执行层级可追溯的体系。
- 删除依据是能力已移除、断言确实重复或已被有效替代，不设置文件数、用例数的下降配额。
- 测试预期来自产品要求、公开契约和已确认的历史缺陷，不能仅复制当前实现的返回值。
- 本次重构原则上只修改测试、测试辅助代码、验证脚本和相关文档。发现产品缺陷时先记录、复现，另开修复项；不得通过放宽断言让它通过。
- 不顺带重构产品模块、替换测试框架、删除文档历史或调整产品支持范围。

## 全局约束

1. 项目根目录是 `E:\agent-desktop\YuanTu-Foundry`，不是 README 示例中的 agent-test。执行前检查根目录、HEAD 和本地指令。
2. 禁止一次性删除 tests 目录或全部测试。关键用例只能在逐项替代并验证后删除。
3. 工作区已有大量修改和未跟踪文件。不得运行整树 reset、restore、clean、stash 或全量格式化，也不得覆盖其他任务的内容。
4. 保持 Node.js >= 24，第一轮不新增依赖，不修改公开 API、默认权限、沙箱策略或数据库兼容范围。
5. 第一轮继续把自动发现的行为测试放在 `tests` 顶层，文件名以 `.test.ts` 结尾；目录分类先用清单表达。
6. 不降低 coverage 门槛：lines=90、branches=75、functions=85；不通过排除核心模块、改 skip 或改报告器隐藏失败。
7. 普通测试使用本地假模型、临时数据库和临时工作区，不要求真实模型密钥。真实 OS、浏览器、Office 和联网验收单独记录环境要求。
8. 禁止静默退回宿主执行以冒充沙箱验证。跨平台 skip 不能作为该平台通过证据。
9. 权限、拒绝审批、数据恢复、取消、资源清理等独有断言必须保留；“同一模块”不等于“相同覆盖”。
10. 每批只修改清单声明的文件。提交仅在用户或已有会话授权时进行，且只暂存本批变更；混有其他修改的文件不得整文件暂存。

## 审查重点

| 条件                                             | 必须证明的行为                                       | 所属任务     |
| ------------------------------------------------ | ---------------------------------------------------- | ------------ |
| 顶层测试被迁入子目录或只用显式路径运行           | 默认 npm test、选择器、coverage 和 CI 仍执行对应测试 | 任务 2、6    |
| 拒绝审批、只读模式、策略切换或恢复后的旧权限     | 不产生未经批准的文件、命令或外部调用                 | 任务 4       |
| WAL 已提交、恢复中断、迁移失败、未来 schema      | 数据不丢失，拒绝不安全打开或替换，恢复路径可用       | 任务 4       |
| 分片流、启动写入失败、取消和提前结果             | 数据不丢，终态一致，监听器和子进程完成清理           | 任务 4、5    |
| 假计时器、共享环境变量、并行子进程、真实 OS 缺失 | 不产生顺序依赖；清理完毕；缺失验收明确标记           | 任务 3、5、7 |

## 当前仓库依据（2026-10-12，只读检查）

- tests 下发现 193 个 `.test.ts`、13 个 `.smoke.mjs`、38 个其他文件。这是文件分类，既不是用例数，也不是有效性或执行结果。
- `scripts/run-tests.mjs` 默认枚举 tests 顶层 `.test.ts`；默认文件并发为 1，支持显式路径、`--concurrency=N`、`--test-name-pattern=...` 等限定选项。
- `scripts/select-tests.ts` 和 `scripts/check-related.mjs` 的行为测试匹配规则同样限定顶层。前者对核心模块、验证脚本、配置等保守回退全量；后者仅提供开发反馈，不能替代验收。
- package.json 中 test:verbose、coverage 使用顶层 glob；`scripts/docs-facts.mjs` 也按顶层统计行为测试数。
- `check:full` 等于 check，含格式、文档、引用、i18n、类型、全部行为测试、构建、编译客户端/SDK 和 Web 冒烟；`check:release` 再加桌面冒烟。
- CI 另有 bench、coverage、Windows 原生回归和 macOS 原生验收。check:release 本身不等于所有平台 CI 验收。
- 本计划编写时没有执行产品测试。docs 下有既有删除，README 仍含文档索引引用；执行者必须测出当前门禁状态，不能假设初始全绿。

## 文件职责与交付物

下列新文件由执行者在任务 1、2 创建；目前只有本计划已交付。

| 文件                                                  | 职责                                                           |
| ----------------------------------------------------- | -------------------------------------------------------------- |
| docs/testing-rebuild-progress.md                      | 阶段状态、批次记录、命令结果、环境限制、交接点                 |
| docs/testing-capability-matrix.md                     | 能力要求、源码、断言、测试、执行层级与环境的映射               |
| docs/testing-rebuild-decisions.md                     | 每个旧用例的处置、删除理由和替代证据                           |
| .scratch/test-rebuild/baseline/                       | 本地初始状态、差异、未跟踪文件备份、运行日志与计时记录；不提交 |
| tests 顶层 `.test.ts`、现有 fixture/worker、snapshots | 按能力逐批重构；保留现有命名可减少引用改动                     |
| package.json、scripts、.github/workflows/ci.yml       | 仅在测试入口或分类确实需要变更时联动修改                       |

## 任务 1：保护工作树并建立基线

**读取：** 本地 AGENTS.md、package.json、当前 scripts 和 CI。**创建：** progress 文档、本地 baseline 目录。

**输入：** 接手时的整个当前工作树。**输出：** 可追溯的初始版本、保护记录和真实门禁结果，供后续所有批次对比。

- [ ] 检查 `git rev-parse --show-toplevel`、`git rev-parse HEAD`、`git status --short`，读取适用的根目录及测试目录指令。记录 Node/npm/OS 版本，不输出环境变量全集或凭据。
- [ ] 在 progress 中记录“基线时间、HEAD、原有修改、新增文件、本计划执行者、本轮范围”。任何已有修改都不是本执行者默认拥有的内容。
- [ ] 保存下面的本地记录；对将要修改的未跟踪文件另做原样备份并记录 SHA-256。Git diff 不包含未跟踪文件内容，不能单独当作完整备份。

```powershell
Set-Location -LiteralPath 'E:\agent-desktop\YuanTu-Foundry'
New-Item -ItemType Directory -Force -Path '.scratch/test-rebuild/baseline' | Out-Null
git rev-parse HEAD | Set-Content -Encoding utf8 '.scratch/test-rebuild/baseline/head.txt'
git status --porcelain=v1 | Set-Content -Encoding utf8 '.scratch/test-rebuild/baseline/status.txt'
git diff --binary --output=.scratch/test-rebuild/baseline/unstaged.patch
git diff --cached --binary --output=.scratch/test-rebuild/baseline/staged.patch
git ls-files --others --exclude-standard | Set-Content -Encoding utf8 '.scratch/test-rebuild/baseline/untracked.txt'
```

- [ ] 顺序运行以下基线命令；每条执行后记录退出码、汇总、耗时和日志。失败后可以继续采集独立检查，但不能开始删除测试。

```powershell
npm.cmd run check:changed -- --plan
npm.cmd run check:full
npm.cmd run coverage
npm.cmd run bench:check
npm.cmd run smoke:desktop
```

- [ ] 若 check:full 在早期门禁停止，记录“后续步骤未运行”，补跑 npm test、typecheck 和所需冒烟以获得独立结果。明确已有失败、缺依赖、权限/环境问题和此次引入的问题。
- [ ] 若权限沙箱或图形运行环境阻止检查，使用当前环境允许的正规执行路径；无法完成的检查保持 pending，不能通过删用例绕过。

**退出条件：** 初始改动可恢复、关键未跟踪内容已保护、基线结果可查。已有未解决失败时，只允许继续盘点和增加替代用例；相关能力的旧用例删除及最终完成状态保持阻塞。

## 任务 2：建立能力矩阵和旧用例处置清单

**读取：** README、公开协议与接口、全部测试及辅助文件。**创建：** capability matrix、decisions 文档。

**输入：** 任务 1 的基线。**输出：** 每个旧用例均有处理记录，每个产品能力均有测试映射或明确缺口。

- [ ] 用 `rg --files tests` 盘点行为测试、冒烟、fixture、worker、snapshot；用 `rg -n 'test\(|describe\(|it\(' tests` 辅助定位。动态生成、参数化和嵌套测试须读代码核对，搜索命中数不能当作用例数。
- [ ] 对照以下能力表补齐清单。这是检查起点，不能代替源码审查，也不能据此认定未列出的文件无用。

| 能力编号 | 能力与源码范围                                                                                                | 优先阅读的现有测试                                                                                                      |
| -------- | ------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| CAP-01   | 内核运行、事件与终态；packages/core、packages/protocol                                                        | core、invariants、step-boundary、retry、stream-recovery                                                                 |
| CAP-02   | 上下文、容量、裁剪与压缩；packages/core、packages/providers                                                   | context 系列、model-capacity、overflow-recovery、compaction-policy                                                      |
| CAP-03   | 持久化、迁移、备份恢复与投影；packages/storage                                                                | storage、schema-migrations、database-maintenance、session-log、projection-checkpoint                                    |
| CAP-04   | 权限、审批、执行策略与 OS 沙箱；packages/tools、apps/agent-host                                               | permissions、file-execution-policy、host-execution-policy、sandbox 系列、acceptance                                     |
| CAP-05   | 工具管线、文件、Git、搜索、网络、终端与后台作业；packages/tools                                               | tools-pipeline、files、git-write、tool-parallel、tool-timeout、terminal、background-lifecycle                           |
| CAP-06   | 模型协议、SSE、缓存、发现与凭据；packages/providers、packages/protocol                                        | providers、models-discovery、credentials、credential-paths、tool-images                                                 |
| CAP-07   | Host RPC、重连、客户端、Carrier 与 SDK；apps/agent-host、packages/client、packages/carrier、packages/sdk、sdk | host-requests、host-reconnect、host-lifecycle、client、carrier、host-sdk、python-sdk、compiled 冒烟                     |
| CAP-08   | 子代理、任务、目标、计划与调度；packages/core                                                                 | subagents、subagent-settlements、task-resume、tasks、goal、plan-concurrency、cron、calendar                             |
| CAP-09   | MCP、OAuth、LSP、资源、扩展、记忆与知识；packages/mcp、packages/lsp、packages/resources、packages/knowledge   | mcp、mcp-secret-cipher、lsp、resources、extension-contract、knowledge                                                   |
| CAP-10   | Office、附件与呈现；packages/office、packages/tools                                                           | office、office-preview、attachment-addressing、present                                                                  |
| CAP-11   | CLI、ACP、Electron 与 Web 交互；apps                                                                          | cli、acp、desktop、settings、desktop/web/history/workflows 冒烟                                                         |
| CAP-12   | 打包、安装、升级回滚、原生资源与性能；scripts、build、benchmarks                                              | desktop-installation、desktop-upgrade、windows-install-safety、macos-packaging、native-sandbox-bundle、performance 系列 |

- [ ] capability matrix 每行必须填写：能力编号、行为编号、要求来源、源码位置、场景/输入、预期可观察结果、风险等级、测试路径及名称、层级、环境要求、是否历史回归、状态。缺失覆盖写 gap，不得写“已验证”。
- [ ] decisions 每行填写：旧文件与测试名称、原断言要点、能力/行为编号、处置（保留/合并/重写/删除/待确认）、理由、替代文件与测试名称、验证命令/日志、审查状态。
- [ ] 删除整文件之前，该文件内动态和静态用例都必须有处置记录。仅名称相似、覆盖同一函数或源码结构断言较多，不足以证明可删除。
- [ ] 将层级标为：局部行为、模块集成、跨模块契约、UI 冒烟、真实平台验收、性能。层级由运行资源和验证目标确定，不只看文件扩展名。

**退出条件：** 所有旧用例可追溯；CAP-01 至 CAP-12 及审查新增能力均无“未盘点”；高风险 gap 有明确后续归属。

## 任务 3：完成一个低风险试点

**优先范围：** permissions 与其可独立运行的纯策略测试；保留原 tests/permissions.test.ts 路径。若盘点无重复可删，允许以保留结论结束试点，不人为制造改动。

**输入：** 任务 2 的矩阵和 decisions。**输出：** 一批完整替换证据，以及后续批次可复用的流程。

- [ ] 读取公开策略接口与 permissions 现有全部断言，锁定 deny/ask/allow 优先级、参数匹配及无效规则拒绝行为。
- [ ] 建立试点批次记录，列明可修改文件和每个待替代断言。优先提取重复 setup，禁止为了减少行数把独立场景合成无法定位失败的单个大测试。
- [ ] 写或调整替代测试，明确输入和独立预期；先运行原用例，再运行替代用例。对纯重构无需强行制造失败；新增缺陷回归必须证明能检测错误行为。
- [ ] 使用现有运行器，选择名称时明确正则；不得因 pattern 实际匹配 0 个用例而判定成功。

```powershell
node scripts/run-tests.mjs tests/permissions.test.ts
npm.cmd run typecheck
git diff --check
```

- [ ] 对照 decisions 逐条确认：替代测试仍检查相同风险、异常和副作用；通过一次受控反例证明关键断言有检测力。反例放在临时 fixture 或本批可安全恢复的改动中，不覆盖其他任务修改；不得恢复历史漏洞到共享工作树。
- [ ] 完成新旧并行验证后，仅删除有完整证据的重复部分；再次运行整个试点文件与实际相关测试，检查默认发现列表仍含它。
- [ ] 更新矩阵、删除前后对照和批次记录；若提交已授权，只暂存本批内容。

**退出条件：** 试点行为不变，关键断言可检测错误输入，基线无新失败，删除记录完整。没有通过则修正试点，不扩散到其他能力。

## 任务 4：逐批迁移高风险能力

**顺序：** CAP-03 持久化 → CAP-04 权限与沙箱 → CAP-01/02 内核、上下文和流 → CAP-05 工具与进程 → CAP-08 协作调度。

**输入：** 试点流程。**输出：** 各能力完成保留、合并或重写，独有回归无丢失。

- [ ] 每批覆盖一个可独立验收的行为主题，通常涉及 1–3 个测试文件；若同一关键行为跨越更多文件，完整审查后再划分。不要把整个能力域当成一次大规模删除。
- [ ] 存储批次必须保留：已提交 WAL 数据进入备份、迁移失败不破坏原库、未来 schema 拒绝、恢复中断阻止正常打开、锁竞争、投影/检查点一致性。读取 database-maintenance、schema-migrations、session-log、plan-concurrency 中对应断言。
- [ ] 权限批次必须保留：deny/ask 优先级、拒绝审批无副作用、只读约束、Host 恢复后的策略一致、路径边界、沙箱不可用时明确拒绝、进程/网络隔离的真实平台验证。
- [ ] 内核与工具批次必须保留：SSE/JSONL 分片、终态闭合、初始写入失败、取消、提前结果、清理失败、无 run.finished 后事件、并发互斥与许可释放。重点读取 program-handshake、invariants、tool-parallel 及资源清理测试。
- [ ] 协作批次必须保留：过期审批不能覆盖新决策、任务副作用先记账、结果不确定时暂停、重启恢复、不重复执行、子代理结果结算、取消和租约释放。
- [ ] 每批按任务 3 的“原用例 → 新用例 → 反例检查 → 删除 → 相关回归 → 清单更新”顺序执行。每个高风险主题完成后运行 check:full；所有新增 skip 都单独审查。
- [ ] 如新旧结果冲突，记录最小输入、要求来源和两种结果，保持旧测试，不自动采用当前实现作为预期。

**退出条件：** 所有高风险行为都有可运行用例；已删除用例的替代关系完整；没有本次引入的全量失败。未完成平台验收保持 pending。

## 任务 5：迁移其他能力并测量慢测试

**顺序：** CAP-06 → CAP-07 → CAP-09/10 → CAP-11/12。跨能力回归仍按风险保留。

- [ ] 同样逐批处理模型协议、Host/SDK、MCP/LSP、资源/Office、UI 和安装测试；不因需要外部依赖就删除覆盖。能用本地协议 fixture 验证的逻辑与必须真实环境验证的行为分别记录。
- [ ] 样式文本或源码结构断言逐条审查：保留架构禁依赖、危险入口禁止等明确约束；UI 用户行为优先通过现有冒烟验证，不能把“文本断言都不好”作为删除规则。
- [ ] 快照变化先解释行为，再更新快照；只有获确认的预期变化才运行 snapshot:update，并审查 snapshots 差异。测试组织重构不应无故改变产品输出快照。
- [ ] 统计慢文件时对同一工作树、环境、并发和命令至少测 3 次，记录中位耗时、范围、pass/fail/skip/cancelled/todo 与日志。新旧对比使用保护好的独立副本或已确认干净的版本，不能 reset 当前共享工作树。
- [ ] 优先减少重复构建/启动、共享安全 fixture、拆分真实平台验收。先验证无环境变量、端口、数据库、账户锁或进程资源竞争，再提高文件并发；当前 check:related 默认并发 4 也必须审查是否适合本批。
- [ ] 异步测试结束前取消并等待所有活动工作完成，再关数据库和删除临时目录；使用 finally/t.after 清理环境变量、监听器、计时器、服务器和子进程。

**退出条件：** 其他能力全部有处置结论；优化收益有可比数据，未测量则只报告组织改善；真实环境边界完整保留。

## 任务 6：核对执行入口、发现规则和引用

**可能修改：** package.json、run-tests、select-tests、check-related、docs-facts、CI；仅按必要性修改。**验证：** tests/test-workflow.test.ts、tests/i18n-gate.test.ts 及实际入口。

- [ ] 第一轮不新增测试子目录。对比能力矩阵中自动执行的行为测试与默认运行器枚举列表，逐项检查新增文件未漏跑、删除文件已退出、列表非空。
- [ ] 核对显式 CI 清单、package scripts、辅助文件导入、snapshot 更新入口及文档路径；孤立 fixture 只有证明无消费者后才删除。
- [ ] 不新增一个更宽松的聚合命令绕过原门禁。优先复用 check:related 做开发反馈、check:changed 做保守验证、check:full 做里程碑、check:release 做发布验证。
- [ ] 运行以下命令；--files 只允许预览，不能作为真实 check:changed 排除其他修改的手段。

```powershell
node scripts/run-tests.mjs tests/test-workflow.test.ts
npm.cmd run check:related -- --plan --list tests/permissions.test.ts
npm.cmd run check:changed -- --plan
npm.cmd run references:check
npm.cmd run docs:check
npm.cmd run i18n:check
git diff --check
```

- [ ] 测试数量变化时运行 docs:generate 并审查生成块，不能手改统计数字。若发现原有文档删除导致失败，记录原有问题并按授权范围修复引用，不擅自恢复被用户删除的文档。
- [ ] 若未来另行决定迁入子目录，必须另设批次，同时修改默认发现、两个选择器、coverage/test:verbose、docs-facts 和引用；新增“嵌套测试被默认执行、选择器能选到、覆盖率包含它”的回归。未完成前不得搬迁。

**退出条件：** 无此次新增的漏跑、悬空引用或门禁降级；已有门禁问题未解决时最终验收保持 pending。

## 任务 7：最终验收

- [ ] 审查矩阵、decisions 和 git diff：每个删除都可追溯；产品代码无越界修改；覆盖率门槛、平台 job 和失败退出码仍在；不得有新增 todo/cancelled 或未解释 skip。
- [ ] 在最终内容上运行 check:full、coverage、bench:check、check:release，记录实际结果。check:release 会重复 check；相同内容下可以将其作为最终全量记录，但不能漏掉 coverage/bench。
- [ ] 按 CI 现有命令分别完成 Windows helper 与原生测试、macOS 原生测试和打包检查。无对应环境时交给具备环境的执行者，记录具体待跑命令和版本要求，不声称全平台完成。
- [ ] Windows helper 验证包括 `npm.cmd run build:windows-sandbox` 和 `cargo test --locked --manifest-path packages/tools/windows-sandbox/appcontainer/Cargo.toml`；macOS 使用 `node scripts/check-macos-sandbox.mjs` 和当前 CI 的原生回归清单。执行前重新读取 CI，避免使用过时文件名。
- [ ] 对比任务 1 基线，报告文件数、用例数、各类执行时间及覆盖率；分开写已测量改善、组织变化、遗留失败和未完成环境验收。
- [ ] 获授权的提交每批只包含对应文件/片段，先检查 staged diff；无需授权的本地重构结果可以保持未提交并提供交接。
- [ ] 清理本批新建的临时 fixture 和进程；保留验收日志及工作树保护备份至结果接收，不删除既有 .scratch 内容。

**完成条件：** 全部能力和旧用例完成审查；高风险独有断言保留或有效替代；默认入口不漏跑；要求的门禁在最终内容上有证据。平台检查未完成时，只能报告“本地重构完成，平台验收待完成”，不能把整个任务标为完成。

## 每批记录模板

将此模板复制到 progress；decisions 和矩阵保持同步。

```text
批次编号 / 能力与行为编号：
执行者 / 开始与结束时间 / HEAD：
本批拥有的文件与原有改动保护方式：
旧用例及原断言：
处置理由 / 替代文件与测试名称：
新旧并行验证 / 关键反例验证：
删除后相关验证 / 全量门禁：
命令、退出码、pass/fail/skip/cancelled/todo、耗时、日志路径：
覆盖率与发现列表变化：
产品缺陷 / 环境限制 / 与初始基线差异：
审查结论 / 提交（仅已授权时填写）：
状态：pending | in_progress | verified | blocked
下一批及尚未满足的前置条件：
```

## 接手提示与暂停条件

接手 agent 从任务 1 开始；若已有 progress，先核对其 HEAD、当前 diff 和日志，再从第一个未完成任务继续。不得仅凭上一 agent 的完成消息跳过验证。

以下情况暂停相关删除批次，并继续无依赖的盘点或验证：原有内容未保护；行为要求不清且新旧测试冲突；新测试匹配数为零；出现数据丢失、权限放宽或资源泄漏；关键检查无法完成；覆盖率下降未解释；其他 agent 同时修改本批文件。记录已复现事实、影响、下一步和所需信息，不猜测通过。

建议交接指令：

> 阅读本计划和当前 testing-rebuild-progress、testing-capability-matrix、testing-rebuild-decisions（若已创建），核对工作区与基线。从第一个未完成任务继续，逐批替换并验证；禁止清空 tests。保持产品行为、公开 API、覆盖率门槛及平台验收要求。每批记录证据和保护原有改动；提交只按会话授权执行。用户要求本轮仅写文档时，不开始执行重构。
