# 修复调查预算在首次编辑前截断实现任务（交接给 Codex）

> 本文是一份可直接执行的任务书。执行者：Codex。撰写日期：2026-10-24。仓库：`E:\agent-desktop\YuanTu-Foundry`，基线 `main@45a1ff5`。
> 语言约定：代码注释英文，文档与提交信息中文，沿用仓库现有风格。
> 诊断依据：`.scratch/swe-bench/completed-empty-diagnosis-2026-10-24/`（你此前完成的只读诊断）。

## 0. 一句话目标

调查预算用完时，不再把工具全部撤掉，而是给模型一个“只能动手、不能再查”的回合：已有足够证据的实现请求可以直接落盘修改；纯问答和只读诊断的收敛行为保持不变。

## 1. 背景

SWE-bench 五十题基线（`benchmarks/swe-bench/runs/full-2026-10-24/`）中，旧版 20、新版 21 题为空补丁。其中 11 / 13 例 `completed` 空补丁全部是同一条路径：

1. `packages/core/agent.ts:448` 的 `investigate()` 对普通“请修改代码”请求在首次编辑前成立。
2. `packages/core/tool-progress.ts:120` 累计 `modelMs` 达到 120 秒（或 20 轮）返回 `investigation-conclude`。DeepSeek Flash 每次请求约 10–20 秒，6–14 次读取就到点。
3. `agent.ts:977` 置 `concludeQueries`，`:769` 下一请求 `tools=[]`，模型只能输出文本。12 例输出了 DSML 编辑文本，6 例 DSML 只读文本，6 例承认未修改。
4. 文本回答走 `run-verdict.ts:27` 的无合同分支，状态为 `completed`。

同题对照（新版 django-11149、django-17084）说明：模型在预算到点前后真正调用了 `edit_file`，守卫随即重置，后续正常读写。也就是说，问题不在模型不会改，而在预算把“该动手的那一轮”的工具拿走了。

这是产品缺陷，不是评测专用问题：桌面用户提出“修复 X”时同样会在首次编辑前被截断，并看到 `completed`。

## 2. 已定方案

### 2.1 行为

| 情况 | 现状 | 修复后 |
| --- | --- | --- |
| `investigation-conclude` 触发 | 下一请求 `tools=[]` | 下一请求进入**动手回合**：只提供并只允许执行带“工作区文件编辑”元数据的工具（见 2.2，预期为 `packages/tools/files.ts` 的 `edit_file`、`write_file`、`apply_patch`、`delete_file`、`move_file`、`batch_edit`）。不提供读取、搜索、命令、网络、浏览器、子代理工具 |
| 动手回合中产生项目修改（`projectChangedPaths` 非空） | — | 显式清除动手状态和无修改计数，恢复完整工具目录，任务继续。**不调用完整的 `progressGuard.reset()`**：守卫在有项目修改时已自行重置调查计时（`tool-progress.ts:98-108`），但跨编辑累计的重复失败记录（`failures`、`blocked`）必须保留，否则“编辑—同样失败—再编辑”的循环会失去约束 |
| 动手回合中模型只回答文本 | — | 与现状相同（纯问答仍为 `completed`），不改 `run-verdict.ts` |
| 动手回合中调用了工具但没有产生项目修改（编辑失败、写到 `.scratch/`、调用了被禁止的工具） | — | 无修改计数加 1。计数**跨轮保留**：后续轮次再次收到 `investigation-conclude` 时不重新开始计数。计数达到 2 时，下一请求退回 `tools=[]` 的结论回合，即现有行为 |
| 本轮工具目录里本来就没有写工具（只读运行、计划阶段、只读子代理） | `tools=[]` | 过滤结果为空，等同现状 |
| 重复查询触发的 `conclude`（`observeQueries` 等） | `tools=[]` | **不变**。只改 `investigation-conclude` |
| `investigation-warn` | 注入提示 | 不变 |

### 2.2 实现要点

- **状态。** 用一个枚举取代布尔值 `concludeQueries`：`'none' | 'act' | 'conclude'`，另加一个跨轮保留的无修改动手回合计数。现有对 `concludeQueries` 的每一处引用都要逐一判断属于哪种语义，不要漏。
- **状态转换（按此优先级判定）：**
  1. 普通 `conclude`（重复查询、重复失败、环境阻断）：直接进入 `'conclude'`，不经过动手回合；已处于 `'act'` 时同样直接进入。
  2. 处于 `'act'` 且本轮产生项目修改：回到 `'none'`，无修改计数清零。
  3. 处于 `'act'` 且本轮没有项目修改：计数加 1；达到 2 时进入 `'conclude'`，否则保持 `'act'`。本轮守卫再次返回 `investigation-conclude` 时不重置计数，也不重复注入提示。
  4. 处于 `'none'` 且守卫返回 `investigation-conclude`：进入 `'act'`。
  5. 清零点：`consume()`（用户追加消息）、`repair` 回合、`automatic-verification` 返回 `continue` 时，状态回到 `'none'`，计数清零，与这些位置现有的 `concludeQueries = false` 一致。
- **工具元数据。** 单靠 `permission: 'write'` 不够（`browser.ts`、`workspaces.ts` 也有写权限工具）。给工具定义加一个内部元数据字段，例如 `effect: 'workspace-file'`，只标在修改工作区文件的那几个工具上。**不要**在 core 里硬编码工具名列表。字段不进入发给模型的 spec。
- **过滤同时落实到展示层和执行层。** 已验证：即使工具不在 `request.tools` 里，模型直接调用时仍可能执行（deferred 工具允许直接调用）。动手回合要用现有的 `registry.restrict({ allow })`（`packages/tools/registry.ts:298`），allow 列表取带上述元数据的工具名。`offers()` 同时决定可见与可执行，所以这一处限制就能让 `requestSpecs` 和执行链一致。离开动手回合时调用返回的 disposer 解除限制；异常、取消、运行结束的路径也必须解除（放进 `finally`），不能遗留到下一个运行或子代理的注册表副本。普通阶段保留 deferred 工具可直接调用的现有行为。
- **被禁止的调用。** 动手回合里调用被限制的工具（例如 `read_file`），应得到注册表现有的“hidden/restricted”拒绝结果，不能执行。这一轮算无修改动手回合。同一轮里混合了允许和禁止的调用时，允许的照常执行，禁止的被拒；本轮是否算“有修改”只看 `projectChangedPaths`。
- **提示文本。** `toolProgressNotice('investigation-conclude')` 改成动手回合的语义，英文，大意如下：调查额度已用完，不能再读取或搜索；如果用户要求修改且已收集的证据足够，现在就用可用的文件编辑工具做出最小修改；否则直接用已收集的证据作答，说明不确定之处，不要声称未完成的工作已经完成。退回 `tools=[]` 的结论回合时，复用 `conclude` 的现有文本或保留原 `investigation-conclude` 文本。注意 i18n 门禁：内核文本保持英文。
- **审批与沙箱。** 不改审批策略、`sandbox`、权限模式。动手回合的编辑走与平时完全相同的审批流程。
- **不改数值。** 120 秒、20 轮、60 秒、12 轮这几个阈值保持不变。如果你认为需要改，单列理由，另开提交，不要和本修复混在一起。

### 2.3 不做的事

- 不按 prompt 文本判断“是不是实现请求”（关键词或分类器），太脆弱。动手回合对问答无害：模型直接回答即可。
- 不解析 DSML 文本，也不把它当工具调用执行。动手回合有正式工具后，这类文本应该自然减少，在复测中观察即可。
- 不改 `run-verdict.ts` 的 `completed` 判定，也不改 `tests/core.test.ts:36` 问答用例的预期状态。
- 不改 SWE-bench 工装、提示模板、manifest、子集，也不针对评测做任何特判。
- 不碰 `package.json` / `package-lock.json`：另一个 agent 正在处理依赖审计，工作区里它们的改动不属于你。提交时只 `git add` 你自己的文件。
- worktree 下 `git_log`/`git_status` 被拒，以及错误的查询参数，属于另外的前置阻力，本任务不处理，记录在执行记录里即可。

## 3. 测试（先写测试，看它失败，再实现）

放在 `tests/core.test.ts`，沿用该文件的 `fixture`、`reply` 写法。不调用真实模型，不联网。

**时钟。** Agent 的 `statistics.modelMs` 由 `packages/core/run-steps.ts:75` 的 `performance.now()` 累加，guard 单测里的假时钟（`:70`）不能直接用在 Agent 集成测试上。二选一，并在测试里写明：用 `t.mock.method(performance, 'now', …)` 让每个模型请求推进固定时长（例如每次 30 秒）；或者给 Agent / `RunSteps` 加一个仅供测试的时钟注入点。优先用 mock，不为测试改生产接口；mock 不可行时再加注入点，并说明原因。另一种办法是用 20 轮分支触发，不依赖时钟，但至少要有一个用例覆盖 120 秒时间分支，因为真实样本触发的就是它。

1. **实现路径落盘。** 启用 `autoVerify: true`。假模型连续 `read_file` 不同文件，直到累计 modelMs ≥ 120 秒。断言下一请求的 `request.tools` 非空，且只含带编辑元数据的工具。假模型在该回合调用 `edit_file`（参数 `path`、`old_text`、`new_text`）成功修改项目文件；再下一请求恢复完整工具目录，修改留在工作区。最终状态按现有自动验证规则判定，无验证合同时应为 `needs_review`。
2. **问答路径不变。** 同样到点后，假模型在动手回合只回答文本。断言 `status === 'completed'`，文本为该回答。
3. **动手回合有界、计数跨轮。** 到点后假模型每回合都调用 `edit_file`，但 `old_text` 不匹配，每次都失败。断言恰好 2 个动手回合，第三个请求 `tools=[]`，运行结束，请求总数有明确上界。期间守卫每轮都返回 `investigation-conclude`，计数也不能被重新开始。
4. **`.scratch` 写入不算修改。** 动手回合里 `write_file` 成功写入 `.scratch/` 下的文件，断言计入无修改动手回合。
5. **越权调用被拒。** 动手回合里假模型直接调用 `read_file`，断言没有执行，得到注册表的限制拒绝，计入无修改动手回合。
6. **混合调用。** 同一轮里同时调用 `read_file` 和成功的 `edit_file`：前者被拒，后者生效，本轮算有修改，状态回到 `'none'`。
7. **限制解除。** 动手回合结束（成功修改、退回结论、运行异常或取消）后，`registry.offers('read_file')` 恢复为 true，下一个运行不受影响。
8. **成功编辑后保留失败记录。** 构造“同一个调用、同样的失败输出”跨越一次动手回合的成功编辑反复出现，断言 `FAILURE_WARN` / `FAILURE_CONCLUDE` 计数没有被清掉，仍按原阈值触发。
9. **用户追加消息清零。** 动手回合中排队一条 follow-up 消息，断言 `consume()` 后状态回到 `'none'`、计数清零、限制解除。
10. **只读运行。** 只读或计划模式下到点后，下一请求 `tools=[]`，与现状一致。
11. **普通 `conclude` 优先。** 相同参数重复读取触发 `conclude` 后，下一请求仍是 `tools=[]`，不经过动手回合。已处于动手回合时触发普通 `conclude`，同样直接进入结论回合。
12. **既有用例。** `tests/core.test.ts:36`（scratch 探针）在动手回合里还会继续写 `.scratch/`，请求数会比现在多最多 2 次。把 `requests <= 21` 改成符合新上界的值，并在断言旁写明原因；其余预期不变。`:70` 的 guard 单测不变。

另外用你诊断时的离线复现思路（`offline-reproduction.json`）跑一次新代码：4 次不同的成功读取到点后，下一请求应提供写工具。

## 4. 验收

**范围边界。** 本修复解决的是“预算耗尽后无法调用编辑工具”，**不保证**消除所有 `completed` 空补丁：模型在动手回合直接输出文本时，按方案仍返回 `completed`（与纯问答同一路径）。SWE 工装照旧把空补丁记为 `failed/empty-patch`，评分不受影响。复测报告要单列“动手回合中只回答文本”的次数，不要把剩下的这类空补丁算作修复失败，也不要声称已经消除。

1. 以上新增测试先失败，后通过，并保存失败和通过时的输出。
2. `node scripts/run-tests.mjs tests/core.test.ts`、`tests/failure-codes.test.ts`、`tests/swe-bench.test.ts` 通过。
3. 完整 `npm run check` 通过，如实报告 passed / skipped / failed 数。已知的 `host-carrier` 清理竞态如果再出现，保留失败日志，按仓库已有方式复测，不要改清理规则。
4. 一次提交，信息形如 `fix(core): 调查额度用完时保留文件编辑工具`，正文写明行为变化和不做的事。只提交本任务改动的文件，不推送。
5. 在本文末尾“执行记录”追加：日期、提交哈希、改了什么、测试结果、遗留问题。

## 5. 真实复测（必须先问用户，未获批准不得发真实请求）

修复合入后，用户批准时按下面的方式复测：

- 冻结运行时为修复提交，模型、`promptCache=auto`、no-commands、子集、提示模板、`maxOutputTokens=8192` 以及各项阈值都与 `full-2026-10-24` 完全一致，比较配置哈希相同。
- 跑全部 50 题、每题一次，和 `ec08343` 批次配对，报告沿用 `report.mjs --compare`。不要只跑 24 例受影响的题：那样会夸大效果，也看不出回归。
- 动手前用 `full-2026-10-24` 新版的实际 token（输入 11662849、缓存 10604032、输出 896874）给出单批估算，交用户批准。
- 报告除通过率和 McNemar 外，单列以下几项：
  - 空补丁数及其终止原因分布，与基线 11 / 13 例对照。
  - 动手回合触发次数，其中落盘修改、只回答文本、两回合无修改后退回结论各多少次。
  - DSML 文本次数。
  - 输出达到 8192 上限的次数（这一类不在本修复范围内）。

## 6. 执行记录

（执行者在完成时追加。）
