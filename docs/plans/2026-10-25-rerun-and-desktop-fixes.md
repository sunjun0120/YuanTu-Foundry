# 五十题复测与真实桌面验收问题修复任务书

> 本文是一份可直接执行的任务书，交给下一个执行 agent。撰写日期：2026-10-25。仓库：`E:\agent-desktop\YuanTu-Foundry`，基线 `main@a8d3bca`。
> 语言约定：代码注释英文，文档与提交信息中文，沿用仓库现有风格。
> 输入材料：
>
> - 五十题复测（调查预算修复 `933e1d1` 之后、`a8d3bca` 冻结运行时）：批次 `.scratch/swe-bench/swe-budget-fix-main-20261024-v1/`，控制目录 `.scratch/swe-bench/budget-fix-main-20261024-control/`（含 `mechanism-metrics.json`、`progress.md`、`configuration-differences.json`）。
> - 真实桌面验收报告：`docs/2026-10-24-desktop-real-model-acceptance.md`，原始结果与日志在 `.scratch/desktop-real-acceptance/`。
> - 本次只读复核脚本：`node .scratch/swe-bench/rerun-diagnosis-2026-10-25/analyze.cjs`（只读既有证据，输出 `summary.json`，不联网、不调模型）。
> - 既有诊断：`.scratch/swe-bench/failure-attribution-2026-10-24/README.md`、`.scratch/swe-bench/output-limit-diagnosis-2026-10-24/README.md`。

## 0. 结论摘要

**官方验收已完成：本批 resolved 31/50（62%，Wilson 95% 48.2%–74.1%），上轮新版 `ec08343` 25/50、旧版 `a17ddbc` 26/50。** 区间大幅重叠；50 题里有 35 题至少在三轮中的某一轮被解决过，单次运行之间的波动很大。

**机制上能确认的只有一件事：本批没有再出现“调查到点后撤掉全部工具、以 completed 空答结束”的路径。** 其余变化，包括 resolved 从 25 到 31，都不能归因于 `933e1d1`：本批与上轮相比，工装哈希、依赖哈希都变了（`configuration-differences.json`，`strictPairing=false`），每题只跑一次，同一题在不同运行之间本来就有较大随机波动。因此下表中 resolved 增加、补丁增加、`length` 增加、token 增长都只是**观察到的差异**，不是修复效果。

本批暴露了两个**无论是否由此次修复引起都值得处理**的机制：

- **动手回合推理耗尽（8/14）**：这 8 例全部空补丁，其中 django-11149、scikit-learn-13124 在上轮是 resolved。另一方面，动手回合产生修改的 6 例里有 5 例 resolved，说明动手回合本身能产出有效补丁。成因“禁止读取诱发长推理”仍只是**假设**，B1 是验证它的低风险改动。
- **成功编辑之间来回撤销（4 例）**：官方结果里其中 **3 例 resolved**（django-12419、sympy-13798、sympy-23950），只有 sphinx-10449 unresolved。也就是说，振荡主要造成的是**成本与时长**问题（这 4 例合计约 724 万输入 token），不是正确性问题；强制收尾可能把正确答案截掉（见 B2）。

| 指标（单次尝试，50 题）        | 上轮新版 `ec08343` | 本轮 `a8d3bca` | 说明                                                                                             |
| ------------------------------ | -----------------: | -------------: | ------------------------------------------------------------------------------------------------ |
| 官方 resolved                  |                 25 |             31 | 本轮 unresolved 5（含 pylint-4604 `no_tests_collected`）、空补丁未判定 14、Docker 错误 0         |
| 有补丁                         |                 29 |             36 |                                                                                                  |
| 空补丁                         |                 21 |             14 | 12 例输出额度用尽、2 例连接空闲超时（13 个 `length` 样本中 django-10999 已有补丁）               |
| 调查到点后撤工具而空答         |                 13 |              0 | `933e1d1` 已消除该路径                                                                           |
| 进入动手回合（handoff）        |                  — |             14 | 6 例产生真实修改，8 例在动手回合里推理把 8192 输出额度烧光                                       |
| 触及输出额度（`length`）的样本 |                  9 |             13 | 8 例在动手回合，5 例在普通调查；其中 12 例空补丁、1 例已有补丁                                   |
| 生成记录 invalid               |                  2 |              3 | 2 例超已知 token 阈值、1 例 20 分钟超时，三者都出现过实际撤销；官方判定 2 resolved、1 unresolved |
| 请求总数 / 中位数              |           779 / 13 |      1141 / 17 |                                                                                                  |
| 已知输入 token                 |         11,662,849 |     21,634,468 | 输入最多的 8 个样本合计 11,417,571，占全批 2,163 万的 53%，均为长循环                            |
| 与上轮逐题对照                 |                  — |              — | 两轮都 resolved 22、两轮都未解决 16、仅本轮 resolved 9、仅上轮 resolved 3                        |

- 仅上轮 resolved 的 3 题本轮都是空补丁：django-11149、scikit-learn-13124（动手回合 `length`），seaborn-3187（连接空闲超时）。另有 django-16877 在旧版 `a17ddbc` resolved、本轮连接超时空补丁。
- 仅本轮 resolved 的 9 题：django-12419、django-13363、requests-1921、pytest-5631、sphinx-7910、sympy-13551、sympy-23950、sympy-24443、sympy-24562。其中 8 题上轮是空补丁，sympy-24562 上轮有补丁但 unresolved。
- sympy-23950 的补丁改了测试文件 `sympy/sets/tests/test_contains.py`，仍获 resolved；报告里应和上轮的 pytest-5809 一样单列，不剔除。
- 逐题对照只是描述，配置不同、单次尝试，不做严格配对或 McNemar；单题变化不能断言为改进或回退。

真实桌面验收主套件 42 项 39 通过、3 告警、0 失败；编码矩阵 4 项 3 通过、1 失败（GPT-6-Astra）。桌面侧需要处理的是：并行工具调用参数为空串时桌面照单执行空参数、未知环境变量让 Host 退出却不在首屏说明、运行中关窗后没有中断标记、只读/策略拒绝被写成“用户拒绝”、原生沙箱未初始化时没有单独提示“命令不可用”（“准备就绪”本身语义正确，见 2.5）。

### 0.1 任务清单与优先级

| 编号 | 优先级 | 范围                    | 一句话                                                                                    |
| ---- | ------ | ----------------------- | ----------------------------------------------------------------------------------------- |
| T0   | 前置   | 评测流程                | 官方验收已完成（31/50）；剩严格导入与单批报告，**不再 dispatch**                          |
| B1   | P0     | `packages/core`         | 动手回合允许定点读取，提示禁止凭记忆重建代码，无修改上限 2→3（验证假设的改动）            |
| B2   | P1     | `packages/core`         | 在写入边界检测整文件回退与局部反向 hunk；**只注入两级提示，不强制收尾**                   |
| D1   | P0     | `packages/providers`    | 识别“参数为空串”的工具调用，不执行；单独实现一次带 `parallel_tool_calls:false` 的降级重发 |
| B3   | P1     | `packages/core` + 设置  | **阻塞/待决策**：调查时间阈值改为可配置并调整默认值，数值由用户拍板                       |
| B4   | P1     | `benchmarks/swe-bench`  | 去掉 schema 中 `maxOutputTokens ≤ 8192` 的硬上限，输出额度改为显式配置项                  |
| B5   | P1     | provider + 评测配置     | 区分“响应头等待”和“流空闲”超时；评测对零字节失败允许 1 次独立重试                         |
| D2   | P1     | `apps/desktop`          | 未知/非法 `YUANTU_*` 在启动失败横幅与通用设置里直接说明                                   |
| D3   | P1     | storage + desktop       | 运行中关窗/崩溃后，会话里显示“上次运行已中断/已停止”                                      |
| D4   | P2     | `packages/tools`/`core` | 策略拒绝、只读拒绝、无人审批超时与“用户拒绝”使用不同错误文本和卡片文案                    |
| D5   | P2     | `apps/desktop`          | 原生预设且沙箱未初始化时，另加横幅/状态点“命令需管理员初始化”；不改 `runStatusText`       |
| B6   | P3     | `benchmarks/swe-bench`  | SWE 工作区是 linked worktree，元数据在外部 bare cache，触发 git 工具边界检查（34/50）     |
| D6   | P3     | core + desktop          | 计划面板内的等待提示可直接做；状态语义部分**阻塞/待决策**                                 |

T0 不阻塞代码修复。建议顺序：B1 → D1 → B2 → B5 → B4 → D2 → D3 → D4 → D5 → B6 → D6（面板部分）；B3、D6（状态语义）等用户决策后再做。每个编号一个独立提交。

**串行约束**：

- B1、B2、B3 都改 `packages/core/agent.ts` / `tool-progress.ts`，必须串行。
- D1、B5 都改 `packages/providers/openai.ts` / `packages/core/run-request.ts` / `packages/protocol/failure.ts`，必须串行；D1 先做。
- B3、B5 都改 `packages/protocol/settings.ts` 的 `ENVIRONMENT`，必须串行。
- D2、D3、D4、D5 都会改 `apps/desktop/i18n-*.ts`，同一时间只能有一个执行者在改。

### 0.2 分支与提交

- 当前在 `main`，工作区里还有未跟踪的验收报告 `docs/2026-10-24-desktop-real-model-acceptance.md`、`docs/assets/` 和本任务书，它们不属于修复提交。
- 修复从 `main` 新开分支，例如 `codex/rerun-desktop-fixes`；每个提交只 `git add` 本编号改动的文件，不用 `git add -A` / `git add .`。
- T0 已有自己的分支 `codex/swe-budget-fix-official-20261025`，官方结果只落在那里，不混入修复分支。
- 不 push、不开 PR、不合并，除非用户要求。

### 0.3 每个提交都要过的门禁

- `npm run check` 全绿，其中包括 `docs:check` 与 `i18n:check`。
- 新增或修改 `ENVIRONMENT` 中的名字（B3、B5）后，运行 `npm run docs:generate`，把重新生成的 README 设置表（目前“共 70 个名字”）一并提交；不要手改该段。
- 任何新增的界面文案（D1、D2、D3、D4、D5、D6）都要同时加中文与英文键，并有测试覆盖键存在；内核给模型看的文本保持英文。
- 测试只用私有测试根里合成的 fixture，不读取 `.scratch/`、验收库或批次证据；需要真实形状时，把形状抄成 fixture，不引用路径。

---

## 1. 五十题复测：逐项问题与证据

复核数字全部可用 `analyze.cjs` 重新得到。逐题明细见 `budget-fix-main-20261024-control/mechanism-metrics.json` 与 `rerun-diagnosis-2026-10-25/summary.json`。

### 1.1 动手回合把推理额度烧光（B1 的依据）

14 例进入动手回合，结局如下：

| 结局                                        | 数量 | 样本                                                                                                      | 官方判定                           |
| ------------------------------------------- | ---: | --------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| 动手回合产生项目修改                        |    6 | django-14771、django-17084、sympy-13551、sympy-20916、sympy-23950、sympy-24562                            | 5 resolved，sympy-20916 unresolved |
| 动手回合第一个请求即 `length`，空补丁       |    7 | django-11149、django-11885、django-16950、matplotlib-24627、xarray-7229、scikit-learn-13124、sphinx-10614 | 未判定；11149、13124 上轮 resolved |
| 先调用被禁止的读取被拒，第二个请求 `length` |    1 | sphinx-10673                                                                                              | 未判定                             |

已确认的事实（以 django-11149 为例，时间线可从 `evidence/django__django-11149/adapter.json` 的 `context.forecast`、`provider.request.finished`、`context.injected` 事件重建）：

1. 动手回合请求的工具 schema 只剩约 150 token（本批普通请求约 2,900–3,900），`cachedInputTokens=0`（工具列表变化使前缀缓存失效），`finishReason=length`、`outputTokens=8192`、可见字符 0。
2. django-11885 的推理内容显示，模型在动手回合里试图凭记忆重建上游源码（反复回忆 Django 各版本 `deletion.py` 的实现），而不是基于已读证据写最小修改。该样本只调查了 5 轮就到点。这是单例观察，其他 7 例没有逐一核对推理内容。
3. 另有 2 例（sphinx-10673、django-14771）在动手回合首先尝试 `read_file`，被注册表限制拒绝。`edit_file` 的描述写着 “Read before editing”（`packages/tools/files.ts:695`）。

**假设（未证实）**：动手回合不能读取原文，加上证据不足，会诱发长推理；在 8192 的评测输出上限下直接变成空补丁。对立的解释同样成立：这些题本身就难，普通调查里也有 5 例同样耗尽推理（见 1.4），动手回合只是恰好落在推理最重的那一步。B1 的改动风险低，可以用后续小集复测检验这个假设，但不要预设它一定减少空补丁。官方结果给了一个侧面支持：动手回合一旦真正写出修改，6 例里 5 例 resolved；损失集中在“写不出修改”的那 8 例。这不是网关问题，也不能靠执行残缺工具参数补救。

### 1.2 编辑—撤销振荡拉长运行（B2 的依据）

官方判定：django-12419、sympy-13798、sympy-23950 resolved，sphinx-10449 unresolved。振荡是成本与时长问题，最终补丁多数仍然正确。

| 样本                       | 请求 | 已知输入 token | `edit_file` 发起 / 完成且产生变更 | 尝试撤销（按发起） | 实际撤销（按完成且有变更） | 生成状态                        |
| -------------------------- | ---: | -------------: | --------------------------------: | -----------------: | -------------------------: | ------------------------------- |
| sphinx-doc\_\_sphinx-10449 |   66 |      1,914,931 |                           29 / 28 |                 13 |                         12 | invalid / observed-token-budget |
| sympy\_\_sympy-13798       |   67 |      1,955,522 |                           34 / 34 |                  3 |                          3 | invalid / observed-token-budget |
| sympy\_\_sympy-23950       |   61 |      1,579,601 |                           19 / 18 |                  3 |                          3 | invalid / instance-timeout      |
| django\_\_django-12419     |   58 |      1,795,947 |                           22 / 22 |                  8 |                          8 | generated（58 轮后才收尾）      |

“撤销”是诊断用的近似定义：同一路径上，一次编辑的 `old_text`/`new_text` 与此前某次编辑互换。“尝试撤销”按 `tool.started` 统计；“实际撤销”只统计有 `tool.finished`、非错误且带 `change` 的调用（sphinx-10449 有 1 次发起没有完成事件）。这个定义只覆盖 `edit_file`，产品实现见 B2，不得沿用。sphinx-10449 是三组 hunk 反复 A→B、B→A 循环。

机制：`ToolProgressGuard.observeInvestigation`（`packages/core/tool-progress.ts:98-108`）在任何项目修改后都把调查轮数和计时清零；`observeFailures` 只计“同调用同错误”。成功的编辑永远不算失败，所以“改—读—改回去”的循环没有任何守卫能看到。no-commands 设定下模型无法运行测试，更容易在两种方案之间摇摆。这同样是产品缺陷：桌面用户的长任务也会无限来回改同一段代码。

### 1.3 调查时间阈值过紧（B3 的依据）

- 14 次 handoff 全部由**时间分支**触发：发生在第 5–12 轮（远低于 20 轮），累计模型时间 124–191 秒。
- 未经 handoff、自然进入首次编辑的 30 个样本，首次编辑时的累计模型时间：中位数 70 秒（第 15、16 个值为 68、72），P90 为 100 秒（最近秩，第 27 个值；线性插值约 106 秒），最大 125 秒；轮数 2–11。`analyze.cjs` 会直接输出这些分位数。
- 也就是说，120 秒的门限正好落在“正常首次编辑时间”的尾部；DeepSeek-V4.1-Flash 单次请求常见 10–40 秒（大部分是推理），轮数还没多起来就到点了。
- `933e1d1` 的任务书明确要求“不改数值”，所以当时没动；现在有了数据，应单独决定。

### 1.4 输出额度 8192（B4 的依据）

13 个样本触及 `length`：8 例在动手回合（见 1.1），5 例在普通调查（astropy-14598、django-15561、django-15957、matplotlib-24870 为空补丁；django-10999 已有补丁）。13 例的运行错误文本逐例核对，全部是 `8192/8192 output tokens, 8192 reasoning tokens, 0 visible characters`，推理字符 25,761–36,086。既有诊断已确认：8192 是 `benchmarks/swe-bench/schema.ts:111` 写死的校验上限，不是模型或网关上限；产品默认 `DEFAULT_MAX_OUTPUT_TOKENS=256000`。

### 1.5 连接超时与流中断（B5 的依据）

- django-16877、seaborn-3187：`Model connection idle timeout`，无补丁；两题在之前某一版均为 resolved。
- sympy-24443：同类超时，但之前已有补丁；pydata-xarray-4075：`Model stream interrupted`，已有补丁。两者官方均 resolved：超时终止不等于失败，但超时发生在首次编辑前就直接丢题（16877、seaborn-3187）。
- 评测显式设置 `YUANTU_STREAM_IDLE_TIMEOUT_MS=30000`、`YUANTU_MAX_RETRIES=0`（`benchmarks/coding-evaluation/adapters.mjs:62`、`:68`）；`packages/providers/openai.ts:180` 把同一个值同时用作“等待响应头”的时限。推理模型首字节慢时，30 秒既不是流空闲也不是网络故障。

### 1.6 SWE 工作区 git 元数据缺失（B6 的依据）

34/50 样本至少一次收到 `Git tools need the repository metadata inside the workspace: ...`。工作区本身就是仓库根，也有 `.git`，但这个 `.git` 是一个文件：`gitdir: .../.scratch/swe-bench/repos/<repo>.git/worktrees/<id>`。也就是说，工作区是由 `benchmarks/swe-bench/repos.mjs:107` 的 `git worktree add --detach` 创建的 linked worktree，Git 元数据位于工作区外部的 bare cache，于是触发了产品 Git 工具“元数据必须在工作区内”的边界检查。这个检查本身是正确的安全语义。上一份任务书已记录为“另外的前置阻力”。

### 1.7 官方验收结果（T0 的依据）

run `40145508078` 于 2026-10-25 00:47 UTC 成功结束。artifact `swe-bench-40145508078-1`（id `12581164719`，960,993 字节，过期 2026-11-24）的 ZIP sha256 与声明摘要一致：`97aa42aff1030d232ef2c838e3f901199d5804e2eba4555585d31ada397b0184`。`evaluation-source.json` 的 `predictionsSha256`、`subsetHash`、`datasetRevision` 与绑定一致，50 个实例各有一份逐题汇总。

| 判定                 |                                                                   数量 |
| -------------------- | ---------------------------------------------------------------------: |
| resolved             |                                                                     31 |
| unresolved           | 5（django-10999、pylint-4604、sphinx-10449、sympy-18199、sympy-20916） |
| 空补丁未判定         |                                                                     14 |
| ambiguous            |                   1（pylint-4604，`no_tests_collected`，与前两轮相同） |
| infra / Docker error |                                                                      0 |

这只是下载核对后的读数，**尚未严格导入**；正式数字以 T0 导入后的报告为准。下载件暂存在会话 scratchpad，导入时应从 Actions 重新下载并核对同一摘要，不依赖该临时目录。

---

## 2. 桌面验收：逐项问题与证据

### 2.1 并行工具调用参数为空串（D1）

- 证据：`.scratch/desktop-real-acceptance/probe-wire-parallel.log`（UTF-16 编码）。同一端点、同一请求，DeepSeek-V4.1-Flash 四个并行调用的 `arguments` 拼接为完整 JSON；GPT-6-Astra 四个调用各只收到一个空串片段，`joined=""`。
- 探针只证明上游响应缺少参数。**`parallel_tool_calls: false` 能否让该网关返回完整参数，尚未验证**；网关也可能不认识这个字段，或者单调用时也间歇性缺参。
- 桌面行为：`packages/providers/openai.ts:369` 用 `JSON.parse(call.json || '{}')`，把空串静默当成 `{}`。随后有 required 字段的工具参数校验失败（`data must have required property 'path'`），无参数的 `list_files` 成功执行。模型重试 2–3 轮后放弃，运行以 `completed` 结束（编码矩阵 GPT 失败，86.5 秒）。
- 注意：无参数工具的正常形态是 `"{}"`（DeepSeek 对 `list_files` 返回的就是 `"{}"`），不是空串。所以“空串 + 该工具 schema 有 required 字段”是可以安全识别的协议异常。

### 2.2 未知 `YUANTU_*` 变量（D2）

- `apps/agent-host/cli.ts:47` 调用 `assertEnvironment()`，未知键直接抛错退出；桌面客户端只看到 `packages/client/host-client.ts:344` 的 `Agent Host exited (code=1, signal=null); requests were not replayed`。
- 原因文本只在 `apps/desktop/model-settings.ts:86-90` 的 `environmentError` 里，经 `:294` 显示在模型设置页。

### 2.3 运行中关窗无中断标记（D3）

- 查验 `.scratch/desktop-real-acceptance/workspaces/main/.yuantu/sessions.sqlite`，会话 `eb21798d-…`：`run.started`（seq 720）→ 一次 `provider.request.finished` → `step.finished reason=cancelled` → `run.finished status=cancelled`（seq 729），没有 assistant 消息。
- 也就是说，关窗走的是正常取消路径，记录本身是完整的；**缺的是渲染**：重开会话时 transcript 没有把“该运行以 cancelled 结束、无回答”画出来，`run.finished` 里也没有区分“用户点停止”和“应用退出”。
- 两条取消路径都是不带原因的 `controller.abort()`：用户停止在 `apps/agent-host/handlers/runs.ts:101`（`run.cancel`），Host 关闭在 `apps/agent-host/lifecycle.ts:32`。core 在 `packages/core/run-outcome.ts:56` 把“已中止”统一映射为 `cancelled`，`run-finalization.ts` 写 `run.finished`。
- 真正的崩溃（无 `run.finished`）由崩溃恢复写入 `run.interrupted`：写入在 `packages/storage/session-runs.ts:153`，运行区间折叠在 `packages/storage/projections.ts:538`，审计读取在 `packages/core/session-query.ts:509`。同样需要可见标记。

### 2.4 只读预设写成“用户拒绝”（D4）

- “仅可查看”预设是权限策略（`decide → 'deny'`），在 `apps/agent-host/approvals.ts:104-107` 记录 `source='policy'` 后返回 `false`。
- `packages/tools/registry.ts:643-657` 只认 `decisionReason === 'read-only'`（计划/只读运行），其余一律写 `Permission denied by user. ...`。`packages/core/run-interaction.ts:181` 的包装审批器只暴露了 `decisionReason`，没有把内层的 `decisionSource` 透传给注册表。`ApprovalDecisionSource` 已有 `'policy' | 'unavailable' | 'launch-options' | 'task-approval' | 'user'`（`packages/protocol/index.ts:285`）。

### 2.5 原生沙箱未初始化（D5）

- 受控预设下命令全部被 `The Windows sandbox accounts have not been initialized...` 拒绝（`packages/tools/sandbox-account.ts`）；弱沙箱回退被受限令牌写检查拒绝（失败安全，正确）。
- 问题只在提示层：界面的“准备就绪”（`apps/desktop/renderer-status.ts:42` 的 `idle → ui.ready`，`:58` 由 `input.ready` 决定）表示 Host/会话可用，不表示命令沙箱可用；聊天、读文件、文件编辑审批在沙箱未初始化时都能正常工作。所以不能把它改成“未就绪”，否则会误导用户以为聊天不可用。缺的是一个单独说明“命令不可用”的提示。

### 2.6 其他观察（D6）

- GPT 编码任务中，除无参数的 `list_files` 外，所有调用都因空参数失败，模型明确说未完成，状态仍为 `completed`。
- `/plan` 中规划器提问后等待 60 秒超时才自行提交计划，整场 172.7 秒。通用的“等待回答”运行状态（`apps/desktop/renderer-status.ts:57` 的 `ui.runStatus.awaitingAnswer`）和侧栏等待图标（`renderer-session-list.ts:169-181`）**已经实现**；缺口只在计划面板本身，面板内没有提示规划正在等待回答。

---

## 3. 修复方案

每个方案都列出：要改的位置、行为定义、测试、验收标准、不做的事。所有测试离线，不调用真实模型、不联网。先写测试并确认失败，再实现。

### T0 官方验收本轮预测（已完成；只剩导入与报告，不改代码）

**当前状态（2026-10-25 核对）**：官方验收已获用户授权（“进行官方验收”），2026-10-25 00:08:10 UTC 派发，00:47:46 UTC 成功结束（`evaluate` 作业 success），读数见 1.7。**不要再次 dispatch，也不要再征求是否触发**。绑定信息记录在 `.scratch/swe-bench/budget-fix-main-20261024-control/official-evaluation.json`（其中 `lastObservedStatus` 仍是 `in_progress`，导入时更新）：

| 项       | 值                                                                                   |
| -------- | ------------------------------------------------------------------------------------ |
| workflow | `swe-bench-eval.yml`，run `40145508078`，`completed / success`                       |
| artifact | `swe-bench-40145508078-1`，id `12581164719`，sha256 `97aa42af…0184`，2026-11-24 过期 |
| 分支     | `codex/swe-budget-fix-official-20261025`（本地与 origin 均存在）                     |
| 输入提交 | `57f8218bc5fb1c9a8da1c69782d4e3f7a0c0e555`                                           |
| 预测文件 | `benchmarks/swe-bench/runs/budget-fix-main-2026-10-25/predictions.jsonl`（该分支上） |
| 预测哈希 | `9d4f0a9ab73e387b83c9c81e333c8dc0700f2d97057641ae652d66be7280769c`                   |
| 评测器   | `swebench==5.0.2`，evaluatorRunId `budget-fix-main-20261025-40145508078-1`           |

执行者要做的只有：

1. 从 Actions 下载 artifact `12581164719`（在 2026-11-24 过期前完成），核对 ZIP sha256 等于声明摘要，严格导入 50 个计划实例；保留 3 个生成阶段 invalid 但有补丁样本的标记，以及 sympy-23950 修改测试文件的标记。导入结果应得到 31 resolved / 5 unresolved / 14 空补丁 / 0 error；若不一致，停下报告差异。
2. 在 `codex/swe-budget-fix-official-20261025` 分支的 `benchmarks/swe-bench/runs/budget-fix-main-2026-10-25/` 下生成单批报告；不合并到 main，不混入修复分支。
3. 与上轮只做**披露配置差异的并列对比**，不做严格配对、不跑 McNemar（`strictPairing=false`；不要绕过 `report.mjs` 的配置守卫）。
4. 报告中写明：本批与上轮配置不同、每题单次尝试，resolved 差异不归因于任何单个提交。
5. 更新 `official-evaluation.json` 的观察状态与 artifact 信息；隐私扫描沿用上轮做法后再提交到官方分支，不 push，除非用户要求。

### B1 动手回合：允许定点读取，禁止凭记忆重建

**位置**：`packages/core/agent.ts:462-475`（`setQueryPhase`）、`:990-1012`（动手回合状态机）；`packages/core/tool-progress.ts:198-200`（提示文本）；`packages/tools/files.ts:374`（`read_file` 定义）；`packages/protocol/tool-contract.ts:227`（`effect` 字段类型）。

**行为**：

| 项                 | 现状                                          | 修复后                                                                                                                                                                                                                                          |
| ------------------ | --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 动手回合工具       | 仅 `effect: 'workspace-file'` 的 6 个编辑工具 | 编辑工具 + `read_file`。给 `read_file` 增加一个新的内部元数据值（例如 `effect: 'workspace-read'`），`setQueryPhase('act')` 的 allow 列表取两类之和。不要放开 `search_files`、`list_files`、`run_code`、命令、网络、子代理                       |
| 无修改动手回合上限 | 2                                             | 3。只读取不修改的回合同样计入，所以上限仍是硬界：最多 3 个无修改回合后退回 `tools=[]` 结论回合                                                                                                                                                  |
| 提示文本           | “不能再读取或搜索……”                          | 英文，大意：调查额度已用完，搜索和其他调查工具不可用；只有在已收集的证据指向具体位置时才修改；**不要凭记忆重建代码**，需要精确原文时只用 `read_file` 读取要改的那几行（给出行号范围），然后立即编辑；证据不足就直接说明不确定之处，不要声称完成 |
| 读取范围           | —                                             | 动手回合里的 `read_file` 不额外限制路径（模型已读过哪些文件不好可靠追踪），靠回合上限约束；如果实现简单，可以限制单次读取行数，例如 ≤200 行，超出时返回明确错误而不是截断                                                                       |

**测试**（`tests/core.test.ts`，沿用 `933e1d1` 新增用例的 fixture 与 `performance.now` mock）：

1. 动手回合的 `request.tools` 恰好是编辑工具 + `read_file`；`search_files` 仍被注册表拒绝。
2. 动手回合第 1 轮 `read_file`、第 2 轮 `edit_file` 成功：恢复完整目录，修改落盘。
3. 动手回合连续 3 轮只读不改：第 4 个请求 `tools=[]`，运行结束，请求数有上界。
4. 原 `933e1d1` 用例中“越权调用被拒”改用 `search_files`；“恰好 2 个动手回合”的断言改为 3。`933e1d1` 在 `tests/core.test.ts` 新增了 9 个 `test(...)`（`git show 933e1d1 -- tests/core.test.ts` 可查），逐一检查，更新预期时在提交说明里列出改了哪些、为什么。
5. 提示文本快照：包含 “read_file”“do not reconstruct”之类的关键约束（按实际英文措辞断言）。

**验收**：`npm run check` 全绿；离线回归覆盖上述 5 点。真实效果只能由后续付费小集复测确认，本任务不声称“空补丁会减少”。

**不做**：不在动手回合恢复搜索；不自动续写被 `length` 截断的响应；不执行残缺工具参数；不改 `run-verdict.ts`。

### B2 编辑—撤销振荡守卫

**位置**：采集点在实际写入边界；判定在 `packages/core/tool-progress.ts`（`ToolProgressGuard`，新增状态与 `ToolProgress` 取值）；`packages/core/agent.ts` 处理新取值并注入提示。

**为什么不能事后读文件**：只在修改后读盘，拿不到首次修改前的原始状态；`FileChange`（`packages/protocol/index.ts:122`）也只有 `path/kind/patch/added/removed`，没有完整的修改前/后哈希。

**采集**：

- 写入边界已经有完整快照：带 `prepareGroup(change, files: FileSnapshot[])` 的文件工具（`packages/protocol/tool-contract.ts:92`）在写入前把每个文件的 `before`/`after` 字节（`FileSnapshot`，`packages/protocol/index.ts:134`）交给变更日志（`packages/storage/session-file-changes.ts:34`），撤销功能依赖的就是这份数据。先读这条链路，确认 `edit_file`、`write_file`、`apply_patch`、`batch_edit`、`delete_file`、`move_file` 都经过它；不经过的要列出来并补齐，或在执行记录中说明。
- 在这个边界上，趁 `before`/`after` 字节还在手里，对每个文件一次性算出守卫需要的全部摘要：整文件的 `sha256(before)`、`sha256(after)`（`null` 表示不存在），以及下面“局部反向 hunk”所需的每个 hunk 的 `(sha256(删除行块), sha256(新增行块))`。摘要作为内部字段附在工具结果上（例如 `result.fileStates: { path, before, after, hunks }[]`），只供守卫使用，不进入模型上下文、不进入 provider spec、不写入会话存储。守卫只拿到哈希，不保存文件内容。
- 删除：`after = null`；移动：源路径 `after = null`、目标路径 `before = null`；批量编辑：每个文件一条；创建：`before = null`。
- 只统计 `projectChangedPaths` 认定的项目文件（`.scratch/` 等不算）。

**判定（两个信号，任一命中即计一次“振荡写入”）**：

只看完整文件状态是不够的。用写入边界快照（每个样本 `session.sqlite` 的 `file_change_files.before_bytes/after_bytes`）回放，全文件判据下 sphinx-10449 的 28 次、sympy-13798 的 34 次成功写入，“回到旧状态”都是 **0** 次：模型在同一文件的多个位置交替改动，局部 hunk 来回切换，但整份文件的内容从未完全重复。所以需要两个信号：

1. **整文件回退**：守卫按路径维护“该文件出现过的内容哈希集合”。首次见到某路径时，把它的 `before` 哈希（包括 `null`）作为初始状态加入集合。每次成功写入后，如果 `after` 哈希已在集合里，且不等于本次的 `before`，即命中；然后把 `after` 加入集合。
2. **局部反向 hunk**：在写入边界用 `before`/`after` 文本计算行级 diff hunk（一次写入可能有多个 hunk；使用仓库现有的 diff 实现，先查 `packages/protocol/patch-display.ts` 等现有代码，不要自写 LCS）。每个 hunk 规范化为 `(path, sha256(删除的行块), sha256(新增的行块))`，只存哈希。若本次某个 hunk 的 `(path, 新增, 删除)` 等于此前某次写入中某个 hunk 的 `(path, 删除, 新增)`，即命中。行块比较前统一换行符（CRLF→LF），其余字节不做规范化。
3. 同一次写入命中多个 hunk 或两个信号都命中，只计 1 次。
4. 二进制文件或超过 1 MB 的文件只用信号 1。

**动作：只提示，不强制收尾。** 官方结果推翻了原先“第 3 次就 `conclude`”的设计：

| 样本         | 官方判定   | 按原阈值的收尾位置 | 收尾时的工作区是否等于最终提交的补丁状态 |
| ------------ | ---------- | ------------------ | ---------------------------------------- |
| django-12419 | resolved   | 第 11 / 22 次写入  | 否                                       |
| sympy-23950  | resolved   | 第 14 / 18 次写入  | 否                                       |
| sympy-13798  | resolved   | 第 33 / 34 次写入  | 否                                       |
| sphinx-10449 | unresolved | 第 15 / 28 次写入  | 否                                       |

（用写入快照回放：在收尾那一次写入后，各文件状态与最后一次写入后的状态逐文件比较。）也就是说，原阈值会在 3 个 resolved 样本得到最终补丁**之前**就把工具撤掉；收尾时的中间状态能否通过无法得知，但不能把已知能通过的结果换成未知结果。因此 B2 改为：

- 累计振荡写入达到 **2** 次：返回新的 `'edit-oscillation-warn'`，注入英文提示，大意：你在撤销自己之前的编辑；先确定一个方案，只保留一个版本，不要在两种实现之间来回切换。
- 达到 **4** 次：再注入一次更强的提示（例如 `'edit-oscillation-warn-final'`），大意：继续来回修改不会产生新证据；选定当前最有依据的版本，说明不确定之处，然后结束。
- **不返回 `'conclude'`，不撤工具。** 成本与时长继续由已有的运行预算兜底（产品侧 `RUN_DEFAULTS` 的 `maxRunMs` 2 小时、`maxRunTokens` 2,000 万，`maxRunRounds` 默认 0 即不限，`packages/protocol/settings.ts:188-190`；这比评测阈值宽得多，桌面上一个振荡运行最多可能烧到 2,000 万 token，这是接受“只提示”的代价，需在提交说明里写明；评测侧的已知 token 阈值和 20 分钟实例超时，sphinx-10449 / sympy-13798 / sympy-23950 正是被它们截住的，截住时的补丁仍会交给官方验收）。
- 每次命中写一条运行事件（例如 `edit.oscillation`，`{ runId, round, count, signal: 'full' | 'local' }`），登记到 `AGENT_EVENT_TYPES` / `SESSION_EVENT_TYPES`，供复测统计。
- 是否在提示之外再加硬上限，等小集复测看到“提示后是否收敛、对 resolved 有无影响”的数据再单独决定，不在 B2 里做。

优先级随之从 P0 降为 P1：它要解决的是成本与时长，不是正确性。

**回放结果**（`node .scratch/swe-bench/rerun-diagnosis-2026-10-25/oscillation-replay.cjs`；局部信号用“去掉公共首尾行后的单一变更块”近似 hunk，产品实现必须按真实多 hunk 计算，结果可能略有不同）：

| 样本                                     |  成功写入 | 整文件回退 | 局部反向 | 任一（计数） | 第一级 / 第二级提示（第几次写入后） | 官方判定   |
| ---------------------------------------- | --------: | ---------: | -------: | -----------: | ----------------------------------- | ---------- |
| sphinx-doc\_\_sphinx-10449               |        28 |          0 |       12 |           12 | 9 / 17                              | unresolved |
| django\_\_django-12419                   |        22 |          9 |        8 |           10 | 10 / 14                             | resolved   |
| sympy\_\_sympy-23950                     |        18 |          4 |        3 |            4 | 10 / 17                             | resolved   |
| sympy\_\_sympy-13798                     |        34 |          0 |        3 |            3 | 31 / 不触发                         | resolved   |
| astropy-14309、django-12276、pylint-4604 | 6 / 3 / 9 |         ≤1 |       ≤1 |            1 | 不触发                              | —          |

其余 43 个样本计数为 0。提示阈值 2 在本批只命中这 4 个样本，没有误报；sympy-13798 要到第 31 次写入才首次提示，说明它的主要成本是**在同一区域不断换写法、而不是改回去**，B2 对它作用有限。是否需要针对“同一区域无新证据的反复改写”另设守卫，留作后续单独评估，不并入 B2。

- **不复用 `reset()`。** 现有 `ToolProgressGuard.reset()`（`tool-progress.ts:73-80`）会清空全部运行态计数，而 `agent.ts` 里有 7 个调用点：

  | 行号 | 场景                                                                  | 是否清零振荡计数 |
  | ---- | --------------------------------------------------------------------- | ---------------- |
  | 482  | `consume()`：用户追加消息                                             | 是               |
  | 717  | `surface.refreshPolicies()` 检测到权限/执行策略变化                   | 是               |
  | 733  | `planning?.takeApproval()` 取得获批计划                               | 是               |
  | 915  | 自动验证注入提醒后 `continue`                                         | 否               |
  | 938  | `verdict.next === 'repair'` 修复回合                                  | 是               |
  | 981  | 本轮有注入上下文或目标变化                                            | 否               |
  | 986  | 调查 warn/conclude 分支里 `automaticVerification.hasProjectWork` 为真 | 否               |

  第 986 行意味着：A→B→A 之后只要再经过一次调查 warn/conclude，`reset()` 就会清空计数，与“成功编辑不清零”直接冲突；915、981 同理。所以振荡状态放在独立字段里，新增 `resetOscillation()`，只在表中标“是”的 4 处调用（与 `reset()` 并列调用）。`reset()` 本身**不碰**振荡状态。

- 成功编辑本身也不清零振荡状态，这正是它存在的意义。
- 不按工具参数（`old_text/new_text`）互换判断，只看写入边界上的实际内容（整文件哈希与 hunk 哈希）：`batch_edit`、`apply_patch`、`write_file` 都可能造成回退，参数互换覆盖不到。

**测试**（每个用例都写明写入序列和预期计数）：

1. `edit_file` 在同一文件上 A→B、B→A、A→B、B→A、A→B：计数依次为 0、1、2、3、4；第 3 次写入后注入第一级提示，第 5 次写入后注入第二级提示；每级提示只注入一次；**之后的请求仍带完整工具目录**，模型可以继续编辑，运行不会因 B2 进入结论回合。
   1a. **局部振荡、整文件从不重复**：文件有三处 X、Y、Z，初始 `X1 Y1 Z1`。依次写入：X1→X2（`X2 Y1 Z1`）、Y1→Y2（`X2 Y2 Z1`）、X2→X1（`X1 Y2 Z1`，局部命中）、Z1→Z2（`X1 Y2 Z2`）、X1→X2（`X2 Y2 Z2`，局部命中）、Y2→Y1（`X2 Y1 Z2`，局部命中）。连同初始状态共 7 个整文件状态互不相同，整文件信号始终未命中；断言计数依次为 0、0、1、1、2、3，第 5 次写入后注入第一级提示，第 6 次写入后不注入新提示（第二级在计数 4 才触发），工具目录不变。
   1b. 一次 `batch_edit` 同时含两个反向 hunk：只计 1 次。
   1c. CRLF 文件的反向 hunk 与 LF 文件同样识别。
   1d. **两个信号同时命中只计 1 次**：两处 X、Y，写入 X1→X2、Y1→Y2、Y2→Y1（整文件回到 `X2 Y1`，即第 1 次写入后的状态；局部也命中），断言这一次只计 1。
2. 对不同文件、内容持续前进的多次编辑，以及同一位置不断换成新写法（X1→X2→X3→X4）：计数始终为 0。
3. `apply_patch` 把文件改回原始内容：计 1 次（初始状态来自首次写入的 `before`，不是事后读盘）。
4. `write_file` 新建文件后 `delete_file` 删除，再 `write_file` 同内容重建：删除计 1 次（回到 `null`），重建计 1 次。
5. `move_file` A→B 再移回 A：两条路径各自按 `before/after` 计数，断言具体次数。
6. `batch_edit` 一次改两个文件，其中一个回到旧状态：只计 1 次。
7. 写入失败（`isError`）或无变更的调用：不计数，也不加入状态集合。
8. 用户追加消息、策略变化、计划获批、修复回合四种情况，各一例断言计数清零。
9. **编辑—调查—再编辑**：A→B→A（计数 1），之后若干轮只读调查，直到触发 `investigation-warn`；由于已有项目修改，走第 986 行的 `reset()` 分支。随后再 A→B（计数 2，注入第一级提示）、B→A（计数 3）、A→B（计数 4，注入第二级提示）。断言计数在调查分支前后连续，没有被清零。
10. 自动验证提醒（第 915 行）与注入上下文（第 981 行）之后计数同样保留，各一例。
11. 与 B1 联动：动手回合中的编辑同样计数并提示；B2 不改变动手回合自身的退出规则。
12. B2 的提示与已有的 `conclude`（重复查询、重复失败、环境阻断）互不覆盖：同一轮若已有 `conclude`，以 `conclude` 为准，B2 提示不再注入。
13. 每次命中写一条 `edit.oscillation` 事件，重载后可读出；事件类型登记齐全。

**验收**：

- 用合成文本构造一个与 sphinx-10449 同形状的序列（三处 hunk 轮流 A→B、B→A，整文件从不重复），不复制上游源码、不读取 `.scratch/`；断言整文件信号为 0，局部信号在第 2 次、第 4 次振荡写入后分别注入两级提示，且全程工具目录不变。
- 实现完成后，用 `oscillation-replay.cjs` 的同一组快照，以产品判定函数再跑一次（一次性脚本，不进测试），在执行记录中列出四个样本的实际计数与两级提示位置，与上表对照并解释差异。
- 真实效果（提示后是否收敛、成本是否下降、对 resolved 有无影响）只能由第 5 节的小集复测回答；本任务不声称降低成本。

**不做**：不限制编辑总次数；不因振荡撤工具或强制收尾；不按 prompt 判断任务类型；不在 SWE 工装里加特判。

### D1 并行工具调用参数为空串

**位置**：`packages/providers/openai.ts:364-373`（工具调用组装）、请求体组装 `:152-177`；`packages/protocol/failure.ts`（新失败码）、`packages/protocol/retry.ts`（`RETRYABLE` 表）；`packages/core/run-request.ts`（降级重发与 route 记忆）；`packages/protocol/events.ts:8`（`AGENT_EVENT_TYPES`）、`packages/storage/events.ts:28`（`SESSION_EVENT_TYPES`）；桌面提示文案在 `apps/desktop/i18n-*.ts`、`renderer-error-text.ts`。

**不能复用现有重试**：`run-request.ts:258-262` 的 `retryRequest` 要求失败码在 `RETRYABLE` 中为 true，且当前轮次重试次数低于 `maxModelRetries`；调用处 `run-request.ts:432` 另要求**尚未流出可见文本**（`!streamedText`）。已流出的推理不阻止重试：重试前用 `resetReasoning()`（`:177-181`，`:440` 调用）发出 `reset` 帧，撤回已展示的推理。（`:252-254` 的注释写着“extended to reasoning”，与代码不符，以代码为准。）评测设置了 `maxModelRetries=0`，用户也可能把它设为 0；而且重试只会原样重发，不会改请求体。新增一个失败码不会自动得到“改成串行再发一次”的行为，必须单独实现。

**行为**：

1. 识别（收窄，避免把模型漏参数当成网关丢参数）：流正常结束、工具调用已组装时，**同时满足**以下条件才视为协议异常：
   - 同一条 assistant 消息里至少有 **2** 个工具调用；
   - 这些调用中所有 `inputSchema.required` 非空的调用，累计参数都是**空串**（`call.json === ''`，即一个参数片段都没收到，或收到的全是空串；收到 `"{}"` 不算）；
   - 至少有 1 个这样的调用。
     满足时**不执行该轮任何调用**，抛出新失败码，例如 `tool-arguments-dropped`；在 `RETRYABLE` 中设为 `false`，避免被普通重试原样重发。
   - **单个调用缺参保持现状**：照常 `{}` 进入参数校验，把 schema 错误作为工具结果交给模型下一轮改正。模型自己漏写 `path` 是常见且可恢复的情况。
   - 多调用中只有部分缺参（例如 1 个空串、1 个参数完整）也保持现状：完整的执行，缺参的走校验错误。
   - 如果该 route 已被记为“已降级”，之后的请求已带 `parallel_tool_calls: false`，单调用缺参同样走现有校验路径。
2. 降级重发：新失败码在 `run-request.ts` 里单独处理，**不受 `maxModelRetries` 约束，也不计入其次数**，也不写 `llm.retry`（那会被 `store.retryCount` 计入普通重试，见 B5）。
   - 次数上限：每个模型请求最多降级 1 次，不发第三次。
   - **降级响应的成功条件单独定义**，不复用第 1 步的识别条件（第 1 步要求至少 2 个调用，而降级后的响应通常只有 1 个调用，会漏判）。降级请求的响应满足以下任一条即为降级失败：
     - 有任一工具调用的 `inputSchema.required` 非空且累计参数为空串（**单个调用也算**）；
     - 端点以 4xx 拒绝 `parallel_tool_calls` 字段，或返回其他失败。
       其余情况（参数完整的调用、纯文本回答、无 required 的空参数调用）为降级成功，按正常流程执行。
   - 降级失败时运行以 `failed` 结束，不执行降级响应里的任何调用，错误文本：“端点返回的工具调用缺少参数；已关闭并行调用重发一次，仍然缺少参数”（端点拒绝该字段时改为“端点不接受关闭并行调用的参数”），不泄露密钥。
   - 降级失败只针对这一次降级响应。之后若 route 已标为降级、正常请求里出现单个调用缺参，仍按第 1 步走现有 schema 校验，交给模型改正。
   - 已流出**可见文本**时（`streamedText` 非空）：与现有重试一致，**不降级、不重发**，运行以 `failed` 结束，不执行该轮调用。错误文本用单独的一条：“端点返回的工具调用缺少参数；已经输出了部分回答，因此没有重发”，**不能**写“已尝试关闭并行调用”。已展示的文本按现有截断路径保存，不重复展示。
   - 只流出了推理、没有可见文本时：与现有重试一致，先 `resetReasoning()` 撤回推理，再降级重发。
   - 降级请求只多带 `parallel_tool_calls: false`，其余与原请求逐字节一致（消息、工具、额度、缓存键）。
   - route 记忆的落点：`ProviderConfig`（`packages/providers/config.ts:4`）没有 `connectionId`，`createProvider` 只接收 config；`connectionId` 只存在于 `AgentOptions.modelInfo`。因此**记忆放在 core**，不放在 provider：在 `run-request.ts` 或其上层（Agent 实例生命周期内）维护一个以 `modelInfo` 的 `protocol + model + connectionId` 为键的集合；命中时，在发给 provider 的请求里设置新的请求选项 `parallelToolCalls: false`。provider 只负责把这个选项翻译成请求体字段 `parallel_tool_calls: false`，其他协议的 provider 忽略它。`modelInfo` 缺失时退化为 `protocol + model` 为键，并在代码注释里说明。不持久化，Host 重启后重新探测。
3. usage 与记录：usage 在流末尾才到，而识别发生在工具调用组装之后；provider 抛出 `tool-arguments-dropped` 时必须把已解析的 usage、`finishReason`、请求耗时带在失败对象上（例如 `RunFailure.details.usage`），否则 `run-request.ts` 拿不到它。被丢弃的首次请求照常写 `provider.request.finished`，保留其 usage，并标记 `discarded: 'tool-arguments-dropped'`（或等价字段）；降级请求另写一条，带 `degradedFrom` 指向首次请求的 `requestId`。运行统计里两次 usage 都要计入，因为两次都可能计费。
4. 展示：降级成功后写一条运行级事件（例如 `provider.degraded`，`{ runId, round, route, reason: 'tool-arguments-dropped', parallelToolCalls: false }`）。这是新事件类型，必须：
   - 登记到 `AGENT_EVENT_TYPES`（`packages/protocol/events.ts:8`，客户端 `host-client.ts:76` 据此过滤）与 `SESSION_EVENT_TYPES`（`packages/storage/events.ts:28`）；如需持久化，也按该文件的现有规则决定是否进入进程记录；
   - 有投影/读取路径，使重载会话后仍能找到它（参照 `llm.retry` 的读取方式）；
   - 桌面在该运行的状态区显示一次本地化提示：“该模型端点并行调用工具时丢失参数，已改为逐个调用”，中英文键齐全；
   - 不进入模型上下文。降级失败则只显示 `failed` 的错误文本。
5. 不改其他 provider；不全局关闭并行；不默认对任何 route 关闭并行。

**前置验证（需用户授权真实调用）**：实现前或实现后，用 `.scratch/desktop-real-acceptance/probe-wire-parallel.cjs` 加一个变体，对 GPT-6-Astra 发同一请求并带 `parallel_tool_calls: false`，确认网关是否接受该字段、参数是否完整。若网关不接受或仍缺参，降级路径保留（它会以明确错误结束），但验收预期改为“明确失败”，不再声称能修好该连接。

**测试**（`tests/providers*.test.ts`，用内存 fetch + 合成 SSE，参考 `.scratch/swe-bench/output-limit-diagnosis-2026-10-24/probe.mjs` 的做法）：

1. 4 个调用（3 个带 required、1 个 `list_files`），带 required 的参数片段均为空串 → 识别为协议异常，该轮无工具执行（包括 `list_files`）。
2. `list_files` 参数为 `"{}"` 与另一个有完整参数的调用 → 正常执行（防误报）。
3. 无 required 字段的工具收到空串 → 仍按 `{}` 执行（保留兼容）。
4. **单个** `read_file` 调用参数为空串 → 不识别为异常，走现有 schema 校验，模型收到 `data must have required property 'path'` 工具结果，下一轮可改正。
5. 2 个带 required 的调用，1 个空串、1 个完整 → 不识别为异常，完整的执行，空串的得到校验错误。
6. `maxModelRetries=0` 时降级仍发生且只发生 1 次；不写 `llm.retry`，`store.retryCount` 不变；降级请求只比原请求多 `parallel_tool_calls: false`；同 `modelInfo` route 的后续请求也带该字段，不同 `connectionId` 的 route 不带。
7. 降级请求的响应仍是多个空参数调用 → 运行 `failed`，不执行，不发第三次。
   7a. 降级请求的响应只有 **1 个** `read_file` 调用且参数为空串 → 判为降级失败，运行 `failed`，不执行该调用，最终状态不是 `completed`；错误文本是“已关闭并行调用重发一次，仍然缺少参数”。
   7b. 降级请求的响应是 1 个参数完整的调用 → 降级成功，正常执行，写 `provider.degraded`。
   7c. 降级成功后，同 route 的下一轮请求里模型单独漏写 `path` → 不判为降级失败，走现有 schema 校验，模型收到校验错误。
8. 端点拒绝该字段（合成 400）→ 运行 `failed`，错误文本为“端点不接受关闭并行调用的参数”，不泄露密钥。
9. 首次响应在工具调用前已流出可见文本 → 不降级，`failed`，错误文本是“已经输出了部分回答，因此没有重发”，不含“已尝试关闭并行调用”；已展示文本不重复。
   9a. 首次响应只流出推理、无可见文本 → 发出 `message.reasoning` 的 `reset` 帧后降级重发。
10. 两次请求的 usage 都计入运行统计；`provider.request.finished` 记录带丢弃标记与 `degradedFrom`。
11. `provider.degraded` 在 `AGENT_EVENT_TYPES` 与 `SESSION_EVENT_TYPES` 中登记（类型检查与现有“事件类型完备”测试能捕获遗漏），写入后重载可读出，桌面渲染提示文案（中英文键齐全）。

**验收**：离线测试通过。若前置验证已确认网关支持该字段，再在用户授权后用 `node .scratch/desktop-real-acceptance/run-coding.mjs` 只重跑 GPT-6-Astra 一项，期望通过；否则期望以明确的 `failed` 结束，而不是 `completed`。

**不做**：不猜测参数、不从文本中解析参数、不把空参数调用交给工具校验后再让模型重试。

### B3 调查时间阈值（需用户拍板）

**状态：阻塞，等用户决定数值。** 用户未答复前不要动手。

**位置**：`packages/core/tool-progress.ts:120-121`；新增设置项到 `packages/protocol/settings.ts`（`ENVIRONMENT`、`RUN_DEFAULTS`）；`benchmarks/swe-bench` 的配置身份需要包含该值；新增环境变量后运行 `npm run docs:generate` 更新 README 设置表。

**建议方案**（推荐 A）：

- A：时间阈值改为 warn 120 秒 / conclude 240 秒，轮数阈值 12 / 20 不变；新增 `YUANTU_INVESTIGATION_MS`（conclude 值，warn 取其一半），可通过环境与 RunDefaults 配置。依据：本轮自然首次编辑中位数 70 秒、P90 100 秒、最晚 125 秒，handoff 全部在 124–191 秒触发。
- B：只保留轮数阈值，去掉时间分支。风险是慢模型的问答会拖很久，桌面问答体验变差。

**测试**：阈值从配置读取；默认值断言；`933e1d1` 时间分支用例改为新默认值；非法值被 `environmentProblems` 报告。

**验收**：SWE manifest 显式记录该值并进入 `configHash`，否则复测结论不可比。

**不做**：不在 B1、B2 的提交里顺手改数值。

### B4 SWE 输出额度改为显式配置

**位置**：`benchmarks/swe-bench/schema.ts:111`；manifest 模板；`benchmarks/coding-evaluation/adapters.mjs:60`。

**行为**：删除 `maxOutputTokens > 8192` 的拒绝，只保留“正整数且小于 `maxContextTokens`”等合法性约束；已冻结批次的 manifest 不变。实验额度（例如 32768）由用户另行批准，作为新的配置身份。

**测试**：校验器接受 8192 / 16384 / 32768，拒绝 0、负数、≥ context；既有 SWE 离线回归 17/17 保持通过。

**不做**：不改产品默认 `DEFAULT_MAX_OUTPUT_TOKENS`；不在本任务中发起付费复测。

### B5 响应头等待超时与零字节重试

**位置**：`packages/providers/openai.ts:180`、`packages/providers/http.ts:139` 附近、`packages/protocol/settings.ts`（`ENVIRONMENT` 与 `RunDefaults` 新增两项）、`packages/core/run-request.ts`（零字节重发）、`packages/storage/session-runs.ts:488`（`retryCount`）、`benchmarks/coding-evaluation/adapters.mjs:62,68`。在 D1 之后做。

**行为**：

- 区分两个时限：**响应头等待**（从发出请求到 `fetch` 拿到 `Response`，新设置项例如 `responseHeadersTimeoutMs`）和**流空闲**（拿到响应后两次读到字节之间的间隔，保持 `streamIdleTimeoutMs`）。产品默认值让行为与现在一致，即新设置默认取 `streamIdleTimeoutMs`；评测另行配置。
- 定义“零字节失败”，三条同时满足：
  1. 没有收到响应头（`fetch` 未返回就超时或连接错误），**或者**收到 2xx 响应头但响应体读到的原始字节数为 0；
  2. 没有解析出任何 SSE 事件，包括推理片段、工具参数片段、usage；
  3. 失败码是 `timeout` 或 `transport`。
     收到非 2xx 状态码的不算（走现有 `http`/`rate-limit`/`server` 分类）。
- 实现：在 provider 的流读取层统计原始响应体字节数和已解析事件数，随失败一起带出（例如 `RunFailure.details.responseBytes`、`details.events`）。不能用“是否已有可见文本”代替；现有 `retryRequest` 的“未展示内容”条件比零字节宽，推理片段也会展示，但未展示不等于没收到字节。
- 评测配置：响应头等待 120 秒、流空闲 30 秒。新增设置 `YUANTU_ZERO_BYTE_RETRIES`（默认 0），评测设为 1：**只对零字节失败**重发 1 次。不能通过把 `YUANTU_MAX_RETRIES` 改成 1 来实现，否则 `rate-limit`、`server`、`empty-response` 以及已流出部分推理的 `transport` 失败都会被放行。现有 `maxModelRetries=0` 保持不变。
- 新设置登记：响应头等待（例如 `YUANTU_RESPONSE_HEADERS_TIMEOUT_MS`）与 `YUANTU_ZERO_BYTE_RETRIES` 都要登记到 `ENVIRONMENT`，带类型与取值校验（非负整数，后者上限建议 3），进入 `resolveRunLimits`；运行 `npm run docs:generate` 更新 README 设置表。
- 计数与普通重试分离：`store.retryCount`（`packages/storage/session-runs.ts:488`）**不是一张表**，而是统计 `session_events` 里 `type='llm.retry'` 的记录；普通重试在 `run-request.ts:282` 写这类事件。如果零字节重发也写 `llm.retry`，在产品 `maxModelRetries>0` 时会占用普通重试次数。因此：
  - 零字节重发写**独立的事件类型**，例如 `llm.zero-byte-retry`（`{ runId, round, attempt, firstRequestMs }`），登记到 `AGENT_EVENT_TYPES` / `SESSION_EVENT_TYPES`；新增独立计数方法（例如 `zeroByteRetryCount(runId, round, sessionId)`），与 `retryCount` 并列，同样跨进程可读回。
  - 不用 reason 字段过滤 `llm.retry` 的方案：那会改变现有 `retryCount` 的语义和既有记录的解释。
  - 先判零字节：零字节失败且零字节额度未用完 → 走零字节重发；额度用完后，才按现有 `retryRequest` 规则（`maxModelRetries`）决定是否普通重试。
- 结果记录与配置身份：评测 manifest 显式写入 `responseHeadersTimeoutMs`、`zeroByteRetries`，由工装传给对应环境变量，进入 `configHash`；`results.jsonl` 每行增加 `zeroByteRetries`（实际发生次数），不改既有字段。已冻结批次不受影响。
- 计费说明：零字节失败**不能保证服务端没有计费**（请求可能已被网关接收并开始生成）。报告与结果记录里按“可能已计费、usage 未知”处理，不要写成“无成本重试”。

**测试**：

1. 合成 fetch 60 秒才返回头：响应头等待 120 秒的配置不超时，旧配置（30 秒）超时。
2. 返回头后 31 秒无字节：按流空闲超时。
3. 未返回头就超时：判为零字节，评测配置下重发 1 次并写 `llm.zero-byte-retry`；第二次仍失败则不再重发。
   3a. 产品配置 `maxModelRetries=2`、`zeroByteRetries=1` 下发生 1 次零字节失败后又发生 1 次 `server` 失败：`retryCount` 为 0→1，普通重试额度仍剩 1 次，没有被零字节重发占用。
4. 已收到 1 个推理 SSE 事件后断流：不是零字节，不重发。
5. 返回 2xx 头、0 字节体后断流：判为零字节。
6. 503 无体：不是零字节，按现有 `server` 规则处理；评测的 `maxModelRetries=0` 下不重发。
7. 产品默认配置下零字节失败不额外重发（行为不变）。

### D2 环境变量问题前置显示

**位置**：`apps/desktop/main.ts`（启动 Host 之前）、`apps/desktop/model-settings.ts:86-90`、`apps/desktop/renderer-status.ts`、`renderer-general-settings.ts`、`i18n-workspace.ts:309`。

**行为**：

- 主进程在启动 Host 前，对 Host 实际会收到的环境调用 `environmentProblems`：`packages/carrier/service.ts:472` 以 `{ ...process.env, ...this.env }` 启动 Host，其中 `this.env` 来自 `apps/desktop/main.ts:199-204` 的 `createService`。只检查 `process.env` 会漏掉桌面自己注入的键，也可能把被覆盖的键误报。有问题时不再等 Host 退出，直接让启动失败横幅显示 `settings.environmentProblems` 的完整列表（键名 + 问题 + 可能的拼写建议），并给出“从启动环境中删除或更正这些变量后重启”的操作提示。
- 通用设置页同样显示该列表（目前只在模型设置页）。
- **保留严格语义**：未知键仍然拒绝启动（CLI 与 Host 的 `assertEnvironment` 不变）。是否改为桌面端“未知键告警并剔除”，属于产品决策，本任务不做，在执行记录中列为待定。

**测试**：主进程单测注入含 `YUANTU_TYPO=1` 的 env，断言横幅状态携带问题列表；中英文文案键齐全（`i18n:check`）；变量值不回显，只回显键名与问题描述。

### D3 中断/停止的可见标记

**位置**：

- 取消来源：`apps/agent-host/handlers/runs.ts:101`（`run.cancel`，用户停止）、`apps/agent-host/lifecycle.ts:32`（Host 关闭）、`apps/agent-host/handlers/background.ts:75`、`apps/agent-host/run-start.ts:121`（后台唤醒时间预算）；桌面关闭入口 `apps/desktop/main.ts:297-330`（`before-quit` → `service.stop()`）。
- core 传递：`packages/core/run-outcome.ts:56`（已中止 → `cancelled`）、`packages/core/run-finalization.ts`（写 `run.finished`）。
- 存储与读取：`packages/storage/session-runs.ts:153`（崩溃恢复写 `run.interrupted`）、`packages/storage/projections.ts:538`（运行区间折叠）、`packages/core/session-query.ts:509`（审计读取 `interrupted`）。
- 渲染：`apps/desktop/renderer-transcript.ts`、`renderer-messages.ts`、i18n 文件。

**行为**：

- 原因传递：上述 `controller.abort()` 改为 `controller.abort(reason)`，`reason` 用一个小的内部类型（例如 `new RunCancellation('user' | 'shutdown' | 'background-budget' | ...)`），保持 `AbortSignal` 现有语义。`run-outcome.ts` 从 `signal.reason` 读出原因，经 `run-finalization.ts` 写入 `run.finished.cancelReason`。读不到已知原因时**不写**该字段，不猜。
- 新记录：Host 因关闭而取消写 `'shutdown'`；用户点停止写 `'user'`。其他取消来源（steering、计划结束、子代理等）先读代码列出，各自给出明确取值，或者不写该字段。`cancelReason` 是 `run.finished` 的可选字段，旧读者忽略它。
- 旧记录或没有该字段的记录**不推断原因**：现有的 `cancelled` 可能来自关窗、用户停止或其他取消路径，只能显示通用文案。
- transcript 渲染：一个运行以 `cancelled` / `failed` / `limited` 结束、且该运行没有可见 assistant 文本时，在该轮用户消息后显示一条系统标记：
  - `cancelReason: 'shutdown'`：“运行在应用关闭时中断，未产生回答。”
  - `cancelReason: 'user'`：“已停止，未产生回答。”
  - `cancelled` 且没有 `cancelReason`（含全部旧记录）：“运行已中断或停止，未产生回答。”
  - 崩溃恢复写入的 `run.interrupted`：“运行因应用异常退出而中断。”
  - `failed` / `limited`：沿用现有错误文案。
- 标记只是渲染，不写入消息表、不进入模型上下文、不自动续跑。

**测试**：

1. Host 侧：调用 `run.cancel` 后 `run.finished.cancelReason === 'user'`；触发 Host 关闭路径后为 `'shutdown'`；未知原因的 abort 不写该字段。
2. 存储层投影覆盖 `shutdown`、`user`、无 `cancelReason`、`run.interrupted` 四种情况。“无 `cancelReason`”在私有测试根里**合成**一组同形状记录（`run.started` → 一次 `provider.request.finished` → `step.finished reason=cancelled` → `run.finished status=cancelled`，无 assistant 消息），不读取 `.scratch/` 下的验收库；断言显示通用文案而非“已停止”。
3. 渲染层单测或现有 DOM 测试断言标记文本与中英文 i18n 键；重载后标记仍在。

### D4 拒绝原因分流

**位置**：`packages/core/run-interaction.ts:181`、`packages/tools/registry.ts:643-657`、`packages/protocol/index.ts:285-296`；桌面工具卡片文案。

**行为**：

- `createRunInteraction` 的包装审批器透传内层 `decisionSource`（只读拒绝仍报 `read-only`）。
- 注册表按来源选择错误文本（英文，给模型看）：
  - `policy`：`Blocked by the session's permission policy (for example a read-only preset). No effect was executed. Tell the user which permission is needed instead of retrying.`
  - `unavailable`：沿用超时/无人可问的现有措辞。
  - `user`：保持 `Permission denied by user...`。
- 桌面工具卡片对 `policy` 显示“权限预设不允许”而非“已拒绝”。
- `approval.decided` 事件的 `reason` 已有来源，不改存储格式。

**测试**：三种来源各一例断言 `toolText`；桌面卡片文案中英文键齐全（`i18n:check`）。

### D5 沙箱就绪状态

**位置**：`apps/desktop/renderer-sandbox-setup.ts`、`sandbox-environment.ts`、`renderer-status.ts`、`packages/tools/sandbox-account.ts`。

**行为**：

- **不改 `runStatusText` 的语义**：“准备就绪”继续表示 Host/会话可用，聊天、读文件、文件编辑审批照常工作。
- 新增一个独立的提示（横幅或输入区旁的状态点，选与现有沙箱设置提示一致的形式）：**仅当**当前预设使用原生沙箱（仅可查看/请求批准/帮我批准）**且**原生沙箱账户未初始化时显示“命令需要管理员初始化沙箱”，点击进入现有的“设置 Windows 沙箱”流程。弱沙箱、host 后端、已初始化时不显示。
- 先检查现有“设置 Windows 沙箱”提示是否已覆盖这一点；如果已有提示只是不够醒目，改它而不是再加一个。
- 中英文文案键齐全。安装/首次启动文档补一段说明。不改沙箱本身、不改弱沙箱的失败安全行为。

**测试**：提示可见性的派生函数单测（原生+已初始化 / 原生+未初始化 / 弱沙箱 / host 后端四种，只有第二种显示）；断言此时 `runStatusText` 仍返回 `ui.ready`；i18n 键存在。

### B6 SWE 工作区 git 元数据

**位置**：只改评测物化，`benchmarks/swe-bench/repos.mjs:107` 附近（`git worktree add --detach`）。**不改产品 Git 工具的边界检查**：放宽“元数据必须在工作区内”会改变产品安全语义。

**根因**：工作区已经是仓库根，也有 `.git`，但它是 linked worktree 的指针文件，元数据在工作区外的 bare cache（`.scratch/swe-bench/repos/<repo>.git/worktrees/<id>`）。

**部分克隆约束**：缓存是 `git clone --bare --filter=blob:none`（`repos.mjs:91-98`）建立的**部分克隆**，带 promisor 配置（`remote.origin.promisor=true`、`remote.origin.partialclonefilter=blob:none`），只有被检出或曾被访问的 blob 在本地，其余由 Git 在需要时从远端按需获取。`repos.mjs:106` 的注释明确写着共享克隆会丢失按需取 blob 的能力，这正是当初选择 worktree 的原因。所以单纯复制现有对象或建立 alternates **不能保证**后续 `git_log -p`、`git_diff <旧提交>`、`git show` 等访问到历史 blob。

**行为**：让每个工作区拥有自己的、位于工作区内的 Git 元数据，**同时**明确缺失 blob 怎么处理。二选一，先读产品边界检查（报错文本 `Git tools need the repository metadata inside the workspace` 的来源）和 git 工具的执行方式（是否允许联网、是否设置 `GIT_NO_LAZY_FETCH` 等）再定，并在执行记录中写明依据：

- **方案 A：保留按需获取。** 在工作区内建立独立的部分克隆（例如 `git clone --no-checkout --filter=blob:none <cache>` 再 `checkout --detach <base_commit>`），并把该克隆的 promisor remote 设为能真正提供缺失 blob 的源：
  - 本地 bare cache 本身也缺 blob，作为 remote 时 upload-pack 不一定会代为向上游取；需要实测。若不行，把 promisor remote 直接指向原始上游 URL（与缓存相同的 `source`）。
  - 这意味着生成阶段模型调用 git 工具时可能触发网络请求。要确认产品 git 工具和评测沙箱是否允许，以及失败时的报错是否清晰；评测记录里要能看到发生过按需获取。
- **方案 B：补齐所需对象并关闭按需获取。** 物化时预先取齐评测会用到的对象（至少 `base_commit` 的完整树；若希望 `git_log -p` 等可用，再取齐 base 之前 N 个提交涉及的 blob，N 写入配置），然后去掉 promisor 配置，或设置 `GIT_NO_LAZY_FETCH=1`，让缺失对象**明确报错**而不是挂起或偷偷联网。工作区内必须有完整、自洽的对象库，不依赖 alternates 指向外部。

无论哪种方案：

- 不使用 `--shared`/`--reference`/alternates 指向工作区外的对象库，除非确认产品边界检查接受，并在执行记录中说明（这条与“元数据必须在工作区内”的语义相冲突，默认不用）。
- 补丁收集依赖 `base_commit` 树的 blob，物化完成时这些 blob 必须已在本地。

约束：

- 补丁收集结果不变：对现有冒烟/离线回归的固定输入，补丁字节与 SHA-256 一致。
- 物化时间与磁盘占用变化写入执行记录（完整复制对象可能显著变慢、变大）。
- 工作区内的 `.git` 不得出现在补丁里；清理逻辑同步更新。
- 这是工装变化，进入 `harnessHash`；之后的批次与本批不可严格配对。

**测试**（离线；用本地合成的上游仓库做 `--filter=blob:none` 部分克隆缓存，不访问 GitHub）：

1. 物化后，在工作区内调用产品 `git_status` / `git_log` 成功，不再出现边界检查报错。
2. 工作区 `.git` 是目录而不是指针文件；`git rev-parse --git-common-dir` 位于工作区内；没有指向工作区外的 `objects/info/alternates`。
3. 补丁哈希一致性：对固定输入，新物化方式收集到的补丁字节与 SHA-256 和旧方式一致。
4. 缺失 blob：在合成上游里构造一个只存在于旧提交、不在 `base_commit` 树中的文件版本。方案 A：在工作区内访问该 blob（例如 `git show <旧提交>:<路径>`）成功，并断言确实发生了按需获取。方案 B：同样访问会立即以明确错误失败（不挂起、不联网），且 base 树内所有 blob 都可离线读取。
5. 清理：物化目录删除后不留下指向缓存的 worktree 记录（`git worktree list` 在缓存里没有残留）。

### D6 计划面板等待提示与“工具基本全失败仍 completed”（需用户拍板）

- 计划面板（可直接做）：通用运行状态 `ui.runStatus.awaitingAnswer` 和侧栏等待图标已经实现，不要重做。只补计划面板（`apps/desktop/renderer-plan.ts`）内的提示：规划运行有未回答的问题时，面板内显示“规划正在等待你的回答”，并可跳到问题卡片。纯 UI，不改 60 秒超时，中英文键齐全。先确认验收场景里面板确实没有任何等待提示，再动手。
- 状态语义（**阻塞，等用户决定判据**）：GPT 编码任务的实际形态是“有 required 字段的调用全部失败，只有无参数工具成功”，所以“本轮所有工具都失败”这一判据不会命中它。是否以及如何改为 `needs_review`（例如“运行中有工具调用、且没有任何一次项目修改、且最后一轮工具全部失败”），会改变 `run-verdict.ts` 的既有设计和问答用例的预期（`tests/core.test.ts:595` 附近的 `Fix target.txt` 用例断言 `completed`，以及其后的普通问答用例），**先向用户确认判据**再动。
- 与 D1 的关系：若网关不支持 `parallel_tool_calls: false`，D1 之后这个样本会以 `failed` 结束；若支持，它可能直接通过。两种情况下这个样本都不再是 `completed` 的空转，D6 状态语义部分的必要性可能下降。

---

## 4. 全局约束

- 不改审批策略、沙箱、权限模式的安全语义；D4、D5 只改文案和状态展示。
- 不执行残缺工具参数，不解析 DSML 文本当工具调用，不自动扩大输出额度续写。
- 不修改已冻结批次的任何原始文件（`results.jsonl`、`predictions.jsonl`、evidence、manifest）。
- 不在产品代码里为 SWE-bench 加特判。
- 不碰与本任务无关的 `package.json` / `package-lock.json`。
- 每个编号一个提交；提交信息中文，说明行为变化与测试；按 0.3 的门禁全绿后再提交，只 `git add` 本编号的文件。
- 除已授权并在执行的 T0 外，任何真实模型调用、付费复测、新的 GitHub Actions 触发，都要先得到用户明确同意。
- 任何复测结论都只写“观察到的差异”，除非是固定其他条件、只改一个因素、样本量足够的对照，否则不归因于单个提交。

## 5. 修复后的复测建议（需用户授权）

修完 B1、B2（及用户选定的 B3、B4、B5 配置）后，建议先跑一个固定小集，而不是直接 50 题：

- 小集：本轮 14 个 handoff 样本 + 5 个普通调查 `length` 样本 + 4 个振荡样本；sympy-23950 同时属于 handoff 与振荡，去重后 22 题。按本轮官方读数，这 22 题里 resolved 7（django-12419、django-14771、django-17084、sympy-13551、sympy-13798、sympy-23950、sympy-24562）、unresolved 3（django-10999、sphinx-10449、sympy-20916）、空补丁 12；以 T0 导入结果为准。
- **回退检查**：除了看空补丁能否被救回，还要单列“本轮已 resolved 的小集样本在修复后是否仍 resolved”。B1 改变了动手回合，B2 改变了振荡样本的提示，都可能把现在能通过的题改坏；只看空补丁减少会掩盖这种回退。若条件允许，另加 5–10 个本轮 resolved、未触发任何机制的样本作为不受影响的对照。
- 每次只改变一个因素（先 B1+B2 的产品修复、配置不变；再单独改输出额度），分别统计：空补丁、`length` 次数、动手回合结局、振荡写入次数与提示位置、请求数与 token、官方 resolved（含回退检查）。
- 对照组用同一工装、同一依赖、修复前运行时，在同一时段跑同一小集；若条件允许，每题 2–3 次以估计单题波动。否则小集只能说明“机制是否触发”，不能说明“解题率是否提高”。
- 小集结论只用于决定是否再跑 50 题，不与 50 题结果混算。

## 6. 执行记录（执行者填写）

| 编号 | 提交      | 测试                                                                                                                                                                 | 偏离任务书之处与理由                                                                                                                                                                                          |
| ---- | --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T0   | 未做      | —                                                                                                                                                                    | 官方结果仍是 1.7 节的下载读数，尚未严格导入与生成单批报告；本轮没有 dispatch、没有触发新的 Actions（需要用户授权后才可执行）。                                                                                |
| B1   | `bcfdbbb` | 核心 66/66；`npm run check` 全绿，291 文件、3004 通过、40 跳过；构建与客户端冒烟 3/3                                                                                 | 格式检查临时排除原始评测证据及原有未跟踪文档，检查后恢复；首次八并发 SWE 取消确认抖动，独立 17/17 后四核全量通过。                                                                                            |
| D1   | `73ee799` | 新增 `tests/tool-arguments.test.ts` 18 例；`npm run check` 各阶段通过；全量测试 3017 通过、0 失败、40 跳过；build 与客户端冒烟 3/3                                   | 未做 GPT-6-Astra 的真实调用前置验证（需用户授权真实模型调用），因此不声称该连接已修好；网关是否接受 `parallel_tool_calls:false` 仍待实测。首次全量中 windows-shell 取消时序用例八并发抖动，独立复跑 7/7。     |
| B2   | `ddcf5c5` | 新增 `tests/edit-oscillation.test.ts` 15 例；四并发全量 3032 通过、0 失败、40 跳过；build 与客户端冒烟 3/3                                                           | 计划获批站点在只读计划阶段不可能产生编辑，改用原型方法调用计数断言“该站点确实清零”而非断言计数变化；修复回合站点需验收合同才能触发 repair，未做端到端，其清零由 `resetOscillation()` 单元用例与代码审查覆盖。 |
| B5   | `4b89dc9` | 新增 `tests/provider-timeouts.test.ts` 9 例；四并发全量 3041 通过、0 失败、40 跳过；build 与客户端冒烟 3/3                                                           | 字节与事件统计只接在 OpenAI 适配器（任务书位置即 `openai.ts`），其他 provider 不产生零字节信号；未改 `YUANTU_MAX_RETRIES` 语义。                                                                              |
| B4   | `5e79872` | `tests/swe-bench.test.ts` 18/18、`tests/coding-evaluation.test.ts` 25/25；format/docs/references/tsc/eslint 全绿                                                     | 只改评测物化与校验；该提交的全量与构建由随后 B3 的整轮门禁覆盖（同一工作树、B4 之后无回退）。                                                                                                                 |
| B3   | `5c3f3ae` | `tests/core.test.ts` 67/67、`tests/environment.test.ts` 10/10；四并发全量 3043 通过、0 失败、40 跳过；build 与客户端冒烟 3/3                                         | 按用户批准的方案 A 实现：默认 240 秒动手、120 秒提醒，轮数 12/20 不变；解析器只校验上限，`YUANTU_INVESTIGATION_MS` 的下限（1000）由 `ENVIRONMENT` 表负责，测试据此断言。                                      |
| D4   | `8814050` | `tests/tools-pipeline.test.ts` 35/35、`tests/desktop-copy.test.ts` 14/14、approval-boundary/run-code/core/host-workflows 共 124 项；format/docs/i18n/tsc/eslint 全绿 | 桌面没有独立的“已拒绝”卡片标签，实际呈现的是内核英文原文，因此在 `toolFailureNote` 增加 policy 提示；端到端全量由后续整轮门禁覆盖。                                                                           |
| D2   | 待实施    | —                                                                                                                                                                    | 未开始。入口：`apps/desktop/main.ts` 的 `createService`（实际下发的环境）与 `packages/carrier/errors.ts` 的错误码；需要新增“环境非法”横幅并把同一列表接到通用设置页。                                         |
| D3   | 待实施    | —                                                                                                                                                                    | 未开始。入口：`apps/agent-host/handlers/runs.ts`、`lifecycle.ts` 的 abort 原因、`packages/core/run-outcome.ts`、`run-finalization.ts` 的 `cancelReason`，以及 `renderer-transcript.ts` 的标记渲染。           |
| D5   | 待实施    | —                                                                                                                                                                    | 未开始。入口：`apps/desktop/renderer-sandbox-setup.ts`、`sandbox-environment.ts`、`renderer-status.ts`；不改 `runStatusText` 语义。                                                                           |
| B6   | 待实施    | —                                                                                                                                                                    | 未开始。入口：`benchmarks/swe-bench/repos.mjs` 的 `git worktree add --detach`；不改产品 Git 工具的边界检查。                                                                                                  |
| D6   | 待实施    | —                                                                                                                                                                    | 计划面板等待提示可直接做（`apps/desktop/renderer-plan.ts`）；状态语义部分仍按任务书阻塞，等用户确认判据。                                                                                                     |

**本轮执行顺序与门禁说明**：实际顺序为 D1 → B2 → B5 → B4 → B3 → D4（B5 先于 B4，因为两者都改 `benchmarks/coding-evaluation/adapters.mjs`）。B2、B5、B3 的提交前都跑完整 `npm run check`（测试阶段用 `--concurrency=4`：本机八并发下 `windows-shell` 取消时序与 `database-maintenance` 在线备份两个用例会抖动，两例独立复跑均通过，与改动无关）。B4、D4 改动面窄（评测校验、拒绝文案），提交前跑受影响的测试文件加 format/docs/references/i18n/tsc/eslint；两次改动都被随后 B3 的整轮门禁与一次性复跑覆盖。格式检查每次临时把本任务书加进 `.prettierignore`、检查后恢复（`git checkout -- .prettierignore`），最终随任务书一起格式化并提交。
