# 真实编程任务评测工装（`project-seeded-v1`）

本目录提供真实编程任务评测工装：用固定运行时、固定任务源码、固定提示词和独立验收器，在隔离工作副本里衡量被测运行时在**真实模型**下的完成质量。使用方式与边界以本文件及现存源码为准。

**默认不调用任何模型。** 离线工装测试在顶层 [tests/coding-evaluation.test.ts](../../tests/coding-evaluation.test.ts)，按默认测试发现规则纳入 `npm test` 与 `check`；真实模型评测必须通过下述 live 入口显式启动。

工装位于 `benchmarks/coding-evaluation/`，执行命令见本文件第 4 节；历史计划与进度文档已删除，不再作为执行入口或状态依据。批次结果以对应输出目录中的 `results.jsonl`、`batch.json` 与报告为准。

## 1. 这是什么，以及它不是什么

固定被测运行时（frozen runtime）、固定任务源码（frozen corpus）、固定提示词与固定外部验收器，在独立工作副本中启动项目现有 Agent Host，由工作区之外的可信验收程序检查结果。

**是**：内部任务集 `project-seeded-v1`——10 个题目（E01–E08 编程与代码调查，E09–E10 操作场景）全部由本项目自身源码派生。

**不是**（以下四条都不允许从本工装的任何输出里推断）：

| 不能声称           | 原因                                                                                     |
| ------------------ | ---------------------------------------------------------------------------------------- |
| 公开基准成绩       | 任务集内部自建，没有外部对照总体，没有公开题面与排名口径                                 |
| 真实用户工单成功率 | 题目由评测作者设计，存在熟悉任务的偏差；不是用户工单抽样                                 |
| 安全隔离认证       | 首轮 `sandbox=host`，Host 不提供操作系统隔离；外置评分器只减少误修改，不能对抗恶意 shell |
| 平台整体能力结论   | 样本量小（单版本正式批次最多 30 个样本），只作内部基线，不具统计显著性                   |

另外三条必须始终分开陈述的结论：**「工装完成」**、**「真实任务通过」**、**「平台隔离验收通过」**。它们互不蕴含。

## 2. 离线 / 真实的硬边界

|                  | 离线                                                                                                                                                                                                                  | 真实（live）                                                                                                                                                                                                                                         |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 入口             | `tests/coding-evaluation.test.ts`（`node:test`）                                                                                                                                                                      | `run.mjs`，且必须显式 `--live`                                                                                                                                                                                                                       |
| 是否发出模型请求 | **永远不发出**。真实 Host 桥接用例只连 `http://127.0.0.1:<port>` 的环回 fixture 服务器，并要求 `model='coding-evaluation-fixture'`、`endpointUrl` 为 `http:` + 数字环回地址、注入 key 为 `coding-evaluation-fake-key` | 会发出，且计入真实费用                                                                                                                                                                                                                               |
| 授权前提         | 无                                                                                                                                                                                                                    | `approvedLiveBudget.authorized=true` 且 `maxAttempts>=1`；`model`/`protocol`/`endpointId`/`endpointUrl` 齐全；`reasoning==='off'`；`approvalMode==='fixed-policy'`；`maxCurrency===null`。缺任何一项都在**创建目录、读凭据、构造 provider 之前**抛错 |
| 失败方式         | 断言失败                                                                                                                                                                                                              | `requireLiveAuthorization()` 抛错，进程退出码 2                                                                                                                                                                                                      |

要点：

- `tests/coding-evaluation.test.ts` 是唯一被授权在默认测试套件里跑的评测入口，必须保持离线。不要往里加任何真实请求。
- `runHostSample()` 对「离线探针」与「真实调用」是两条分支：`offlineProbe:true` 只允许环回 fixture 身份；否则要求环境里有 `YUANTU_API_KEY`，没有凭据时**不做凭据存储回退**，直接抛「Explicit YUANTU_API_KEY credential is required」。离线探针分支同时承担计划要求的「固定运行时假端点自检」：它必须先用 `http://127.0.0.1:<port>` 与假身份跑通启动、一轮对话和取消，才允许对同一份冻结 runtime 发起真实调用。
- 数量阈值（`maxObservedRequestsPerSample`、`maxKnownTokensPerSample`）是**观察后取消阈值**：只在事件到达后触发 `AbortController`。取消前已发生的请求可能已经计费，在途的子代理请求也可能尚未上报。需要硬货币上限时必须依赖供应商/网关的额度控制；本工装不假装能做到。

## 3. 文件清单

| 文件                     | 负责什么                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `schema.ts`              | 全部共享类型（`SourceSpec`、`FrozenInputs`、`CaseWorkspace`、`CaseDefinition`、`PreparedCase`、`RecordedEvent`、`SessionRecord`、`SampleTiming`、`AdapterResult`、`VerificationResult`、`PlannedSample`、`EvaluationManifest`、`SampleInput`、`SampleMetrics`、`SampleResult`、`GradeInput`、`BatchSummary`、`BatchResult`），以及 `validateManifest(value)`、`requireLiveAuthorization(value)`。校验拒绝任何未登记顶层键（这就是凭据键进不来 manifest 的机制）、`repeats∈{1,3}`、`caseConcurrency===1`、`sandbox==='host'`、`toolMode==='deferred'`、`promptCache==='off'`、`maxOutputTokens<=8192`、10 个 case 超时齐全、`approvedLiveBudget` 子键集合精确匹配                                                                                                                                                                                                                                                          |
| `manifest.example.json`  | 不含凭据的固定配置示例。`model`/`protocol`/`endpointId`/`endpointUrl` 全为 `null`，`approvedLiveBudget.authorized=false`，两个来源的 `manifestSha256` 是占位全零。**示例本身不能当 live 配置**；真实批次另存配置，不要就地改这个文件                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `local/build-config.mjs` | 本地运行配置生成器：读当前工作树的 `captureSourceManifest`，把正确的 `manifestSha256`、模型身份、端点身份与预算授权写进 `.scratch/coding-evaluation-config*.json`。**不写密钥**。它被 `oracleFingerprint` 排除，改动它不影响批次可比性                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `materialize.mjs`        | 冻结与复制：`hash`、`inventory`（生产文件 allowlist：`apps/ packages/ tests/ scripts/` 加根级 `package.json`/`package-lock.json`/`tsconfig*.json`/`AGENTS.md`/`build/*.lock.json`；排除 `.git`、`node_modules`、`dist`、`.scratch`、`.yuantu`、凭据*数据*与 `.evaluation-dependencies.json`）、`captureSourceManifest`、`freezeSource`（commit 来源走 `git ls-tree` + `git show`；snapshot 来源要求清单哈希一致并在复制前后双向复核）、`freezeInputs`（额外记录 `runtimeSource`/`corpusSource` 原始目录，供依赖准备使用）、`assertFrozen`、`copyFiles`、`linkFiles`/`inventoryLinked`（硬链接副本 + 链接计数与大小校验，供评测器内部对照副本使用）、`newDirectory`、`materializeCase`。**注意**：凭据排除只匹配凭据数据（`credentials.json/.yaml/.txt`、`.env*`、`*.sqlite/.db/.pem/.key/.pfx/.p12`），不匹配源码模块——早期规则把 `packages/providers/credentials.ts` 一并排除，冻结出的 runtime 连 Host 都 import 不起来 |
| `dependencies.mjs`       | `copyLockedDependencies({sourceDirectory,targetDirectory,packages})`：从**本机已安装且已锁定**的依赖逐包复制出私有 `node_modules`，从不安装、不联网；校验 lockfile 哈希一致、拒绝链接目录与链接包、逐包核对 lock 版本与 `package.json` 版本、写 `.evaluation-dependencies.json` 回执。`preparePrivateDependencies({targetDirectory,sourceDirectory,verifyContent})`：已有合格回执就直接复用，否则从**已带回执**的安装按独立字节复制并逐文件校验哈希；拒绝共享硬链接，修改样本依赖不会污染可信安装。`executeBatch` 已接线：`frozen/runtime` 与每个任务副本各拿一份私有安装                                                                                                                                                                                                                                                                                                                                                 |
| `cases.mjs`              | 固定题库 E01–E10：`id/category/prompt/timeoutMs/allowedPaths/publicCheck/seed/oracle/reference/platformSkips`，加上 `getCase`、`exactReplace`、`prepareCase`、`casePreparationBlock`、`applyReference`、`CASE_IDS`。`exactReplace` 要求种子文本**恰好出现一次**，否则抛 `Seed/reference drift`。`applyReference` 覆盖全部 10 题（见 §7.1）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `oracle/behavior.mjs`    | 独立行为验收器，按 `argv[2]` 分派：E01/E05/E07 的字节上限、UTF-8 前缀、无 U+FFFD、保留数量与 mtime/code point 排序、格式函数拆分；E02 的 8 个 HTTP 状态映射；E03 的容量边界；E04 的交付重复与原子性；E06 的 `--prompt-file` 参数契约；E08 的调查报告对**冻结语料事实**逐条核对（路径/行号/片段/复现）；E10 = E06 + E05 的两套断言。E09 使用完整 E05 保留数量行为断言，另核对实际取消/重开场景证据。它不进任务工作副本                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `verify.mjs`             | `executeOracle`（子进程验收 + oracle 指纹防篡改 + E07 的结构/AST 检查）、`parseTestSummary`（空集、失败、取消、todo、超时、非零退出都判不通过；`# SKIP` 必须写明理由且理由在 `case.platformSkips[平台]` 里声明，裸 skip 或未声明理由一律不通过）、`verifyScope`（与冻结语料逐文件比哈希；只允许 `allowedPaths`、任务新增的 `tests/*.test.ts`、以及 E01/E04/E05 新增的 `packages/tools/spill-*.ts`）、`verifyCase`（在「冻结语料 + 本样本变更文件」的重建副本里跑 oracle，再跑可信旧回归）、`verifyScenario`（E09/E10 的场景证据契约）、`selfCheckCorpus`（离线三对照自检，写 `controls.json`）                                                                                                                                                                                                                                                                                                                            |
| `adapters.mjs`           | `runHostSample`（Agent Host 采样：本样本专属 DB、私有 HOME/TEMP、固定审批策略、请求与令牌观察阈值、取消证据、会话 lineage 记录、E10 的子代理计数、清理确认）、`controlledEnvironment`（只放行 `SystemRoot/WINDIR/ComSpec/PATH/PATHEXT/TEMP/TMP/TMPDIR/LANG` 加显式 `YUANTU_*`；`HOME`/`USERPROFILE`/`APPDATA`/`LOCALAPPDATA`/`TEMP` 全部重定向到证据目录下的 `private-home/`；`YUANTU_SUBAGENTS` 用产品真正解析的 `0`/`1`，E10 之外一律 `0`）、`redact`（注入密钥、`Bearer`、`sk-`、`api_key=` 形态替换）、`JsonlRunCollector`（跨 chunk 半行、重复终态、身份不匹配、非零退出、尾行残缺全部拒绝）、`approvalAllowed`（固定策略：只允许写本题 `allowedPaths` 或任务新增 `tests/*.test.ts`；命令只允许 `node --test <publicCheck 文件>`，E09 另允许精确的 `node evaluation-workload.cjs`；`background`/`workdir`/`cwd` 一律拒绝；其余全部拒绝）、`runCliSample`（**永久阻断**：`PRODUCT_SCOPE.cli=false`）                  |
| `metrics.mjs`            | `collectMetrics`（按 `(sessionId,runId,requestId)` 去重、冲突重放报错、按 `(sessionId,id,childRunId)` 结算去重并回滚父统计里已并入的子代理用量、缺失 usage 一律 `complete=false`）、`gradeSample`（`invalid` / `timeout` / `cancelled` / `passed` 的判定顺序；取消有证据时判 `cancelled` 而不是 `invalid`；E10 缺真实委派判 `delegation-missing`）、`aggregateResults`（重复/缺失/不可比输入直接抛错；`passed` 必须同时满足 `live && independentPass && cleanupConfirmed`；blocked/invalid 保留在分母）、`distribution`（median/min/max，不报 p95）                                                                                                                                                                                                                                                                                                                                                                       |
| `run.mjs`                | `parseArguments`（严格参数；未知、重复、`--live` 与 `--dry-run` 同现都拒绝）、`resolveManifest`（覆盖只能缩小：`maxLiveAttempts = min(原值, cases×repeats)`，`--cases` 不能扩展已授权题目）、`plannedSamples`（`sampleId = <caseId>-v1-<repeat>`）、`executeBatch`（冻结 → 私有依赖 → oracle 指纹 → 离线三对照自检 → 逐样本 → 写文件 → 重新生成报告 → 算退出码）、`blockedSample`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `report.mjs`             | `writeReport({input, manifest, outputDirectory})`：只读 `results.jsonl` + `manifest.resolved.json`，重新聚合出 `summary.json` 与 `report.md`。不触网、不读实时状态                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |

## 4. 命令

### 4.1 离线工装测试（始终离线）

```powershell
node scripts/run-tests.mjs tests/coding-evaluation.test.ts
```

用例集会真实启动一次 Agent Host（连本机环回 fixture 服务器），因此不是秒级用例。它包含 14 个用例，覆盖 manifest 拒绝、冻结/快照、依赖复制、JSONL 终态、指标去重、评分与聚合、取消与场景反例。

### 4.2 批次运行（默认 dry-run）

```powershell
# 1) 生成一份本地配置（示例不能直接用于 live；密钥不写进配置）
node benchmarks/coding-evaluation/local/build-config.mjs .scratch/coding-evaluation-config.json offline-v1 "https://<endpoint>/v1" "<model-id>"

# 2) --manifest、--out、--batch-id 三个都是必填
node benchmarks/coding-evaluation/run.mjs --manifest=.scratch/coding-evaluation-config.json --out=.scratch/coding-evaluation/offline-v1 --batch-id=offline-v1 --dry-run
```

支持的运行参数（`parseArguments` 逐字校验，其他一律拒绝）：

| 参数                | 形式       | 说明                                                                                         |
| ------------------- | ---------- | -------------------------------------------------------------------------------------------- |
| `--manifest=<file>` | 必填       | 不含凭据的配置                                                                               |
| `--out=<dir>`       | 必填       | 批次输出根；目录已存在即失败（`newDirectory` 用不带 `recursive` 的 `mkdir`），禁止覆盖旧批次 |
| `--batch-id=<id>`   | 必填       | 覆盖 manifest 的 `batchId`；`^[a-zA-Z0-9_-]{1,80}$`                                          |
| `--dry-run`         | 无值       | 与 `--live` 互斥；不写模式时行为等价于 dry-run                                               |
| `--live`            | 无值       | 唯一允许发出真实模型请求的开关，且仍受第 2 节的授权前提约束                                  |
| `--cases=E02,E03`   | 逗号分隔   | 只能取 manifest 已授权题目的子集，且不能重复                                                 |
| `--repeats=1`       | `1` 或 `3` | 覆盖 manifest 的重复次数                                                                     |

dry-run **会**创建独立输入、准备私有依赖并完整执行三对照自检（原始/退化/参考），但不会启动任何真实模型任务；每个预定样本都会写入一条 `blocked`（`failureClass=offline-not-executed`）记录，`batch.json.requests` 为 0。

### 4.3 报告（可从保存记录重新生成）

```powershell
node benchmarks/coding-evaluation/report.mjs --input=.scratch/coding-evaluation/offline-v1/results.jsonl --manifest=.scratch/coding-evaluation/offline-v1/manifest.resolved.json
```

报告参数只有三个，全部 `--flag=value` 形式，未知或重复即报错：`--input=`（必填）、`--manifest=`（必填，用批次自己写出的 `manifest.resolved.json`，它含 `planned` 与 `configHash`）、`--out=`（可选，默认与 input 同目录）。

### 4.4 退出码

| 命令                  | 0                             | 1                                     | 2                                                      |
| --------------------- | ----------------------------- | ------------------------------------- | ------------------------------------------------------ |
| `run.mjs`（dry-run）  | 离线自检没有 `blocked` 控制项 | —                                     | 存在 `blocked` 控制项，或配置/准备/工装错误            |
| `run.mjs`（`--live`） | 批次完整且全部预定样本 passed | 批次完整但有 failed/timeout/cancelled | 批次不完整（有 blocked/invalid），或配置/准备/工装错误 |
| `report.mjs`          | 报告生成成功                  | —                                     | 参数或读取错误                                         |

`report.mjs` 退出码 0 **不代表产品通过**，只代表报告写出来了。

## 5. 批次目录布局（`.scratch/coding-evaluation/<batchId>/`）

以下名称全部取自 `run.mjs`、`adapters.mjs`、`verify.mjs`、`report.mjs` 的实际写入路径：

```text
.scratch/coding-evaluation/<batchId>/
  manifest.resolved.json      # 非敏感参数 + planned 清单 + configHash；endpointUrl 置 null 后才落盘
  results.jsonl               # 每个预定样本一行，单 writer 顺序 append
  summary.json                # 由 report.mjs 从 results.jsonl 重新聚合
  report.md                   # 由 report.mjs 生成
  batch.json                  # live 标志、requests（离线恒为 0）、attempts、controlStatus、exitCode、frozen、oracleHash
  frozen/
    runtime/                  # 被测产品实现（生产文件 allowlist）+ 自己的私有 node_modules
    corpus/                   # 各题原始项目源码，与 runtime 分开冻结
    inputs.json               # 来源 spec（含原始目录）+ 两组文件清单（path/size/sha256）+ runtimeHash/corpusHash
  controls/
    controls.json             # 每题 {status, reason, controls[]}，live:false、requests:0
    <caseId>/<variant>/{workspace,oracle.json,scope.json,verification.json,regressions.json,validation/}
                              # variant ∈ original | degraded | reference
  evidence/<sampleId>/
    result.json               # 该样本的 SampleResult（单 writer，用 wx 标志，不覆盖已有终态）
    approval-policy.json      # 固定审批策略 + responderSourceHash + 允许路径/命令清单
    session.sqlite            # 本样本专属 DB（不碰用户真实 DB）
    private-home/             # HOME/USERPROFILE/APPDATA/LOCALAPPDATA/TEMP/TMP 的重定向目标
    adapter.json / adapter-error.txt / host-cleanup.json
    scope.json / oracle.json / verification.json / regressions.json
    validation/               # 「冻结语料 + 本样本变更文件」的重建副本，评分在这里跑
  work/<sampleId>/            # 唯一的可写项目副本；只含 frozen.corpusFiles + 私有 node_modules
```

任务副本里**不含**本工装、计划文档、参考补丁与隐藏断言。`frozen/runtime/` 与 `work/<sampleId>/` 各有一份**私有** `node_modules`（各自带 `.evaluation-dependencies.json` 回执），评测器内部的对照/验证副本从 `frozen/runtime` 按独立字节复制，验收后删除重建副本并保留完整日志，因此不会出现「祖先目录的 node_modules 悄悄供依赖」这种情况。

## 6. 操作规则（不可跳过）

1. **一次一个样本。** `caseConcurrency` 被 schema 固定为 1，没有并发开关；批次串行执行。新的原生/GUI 测试也不得与本批次并行占用同一账户资源。
2. **每次运行新建 `batchId`，输出目录不可复用。** 目录已存在时 `run.mjs` 直接失败；禁止覆盖或续写旧批次。
3. **失败样本不重跑。** 不为让批次变绿而补跑；工装本身出错要更正时新建批次，并保留原 `invalid` 记录。
4. **凭据只来自环境。** `YUANTU_API_KEY` 由进程环境提供，`controlledEnvironment` 只放行它一个凭据；manifest 校验拒绝任何未登记键，所以密钥写不进 manifest；日志、证据、报告与 SQLite 都不含密钥。不要把完整环境或 provider 请求正文贴进用户会话。
5. **必须记录模型身份与全部限制。** `model`、`protocol`、`endpointId`、`endpointUrl`（脱敏后）、`maxContextTokens`、`maxOutputTokens`（≤8192）、`reasoning`、`promptCache=off`、`toolMode=deferred`、`sandbox=host`、请求/流空闲/验证超时、`maxObservedRequestsPerSample`、`maxKnownTokensPerSample` 都要在 manifest 里给确定值。「无参数」不等于「环境默认值已知」。
6. **三个结论不许合并陈述。** 「工装完成」「真实任务通过」「平台隔离验收通过」各自需要各自的证据。
7. **证据目录里的 `session.sqlite` 与 `private-home/` 是本地敏感物。** 不要整库导出、不要随报告交付；需要长期保留时在本地限权。
8. **清理只针对本批次登记的绝对目录**：先解析路径并确认属于该 `batchId` 根，再删除；确认自有进程句柄结束、挂起 promise settled、DB/日志关闭后才清理。账户锁与 ACL journal 不属于普通临时目录，未确认前保留。

## 7. 当前诚实状态

### 7.1 离线三对照（`selfCheckCorpus`）

`selfCheckCorpus` 对每题跑三个**不同输入**，全部经 `verifyCase`（oracle + 范围 + 可信旧回归）判定，结果写进 `controls/controls.json`：

| 变体        | 是什么                                                                         | 必须                                                         |
| ----------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------ |
| `original`  | 上游未改动源码（有种子题＝未植入缺陷的版本）                                   | 有种子题必须**通过**（源码对照）；无种子题必须**不通过**     |
| `degraded`  | 模型真正拿到的输入（有种子题＝已植缺陷；功能/重构/调查题＝需求尚未实现的源码） | 必须**不通过**，且失败必须来自真实断言而不是 oracle 加载失败 |
| `reference` | 工装作者自己的实现在 `degraded` 之上应用                                       | 必须**通过**                                                 |

三种结果都吻合才算 `full-controls-certified`——这也是 `run.mjs` live 分支要求的唯一状态；任何一项不吻合即 `blocked`，并带上三个变体的通过情况和具体 reason。

E01–E04 参考恢复精确种子；E05/E07/E08/E09 有行为参考，E09 与 E05 共用完整保留数量参考。E06/E10 的历史参数参考仍保留，但它们不能证明真实 CLI run/resume 可执行；冻结产品标记 `PRODUCT_SCOPE.cli=false` 时，这两题直接阻断，不调用模型、不启用产品。E09 的实际 workload 触发与两阶段 Host 重开在 `scenario.mjs`，离线契约对照只认证工装，不能当真实模型场景通过。

### 7.2 逐题状态

| 题目                         | 工装侧                                                                                | 产品侧事实                                                                                                          |
| ---------------------------- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| E01 中文/emoji 外溢超上限    | 有种子 + 参考 + 行为验收                                                              | 无阻断                                                                                                              |
| E02 403 归类为鉴权失败       | 有种子 + 参考 + 行为验收                                                              | 无阻断                                                                                                              |
| E03 小上下文自动输出预算     | 有种子 + 参考 + 行为验收                                                              | 无阻断                                                                                                              |
| E04 同一文件重复声明为交付物 | 有种子 + 参考 + 行为验收                                                              | 无阻断                                                                                                              |
| E05 外溢保留数量             | 无种子；参考实现加 `retentionLimit`                                                   | 无阻断                                                                                                              |
| E06 CLI `--prompt-file`      | 参考实现加参数与校验；行为验收只判参数契约                                            | **CLI 被 `PRODUCT_SCOPE.cli=false` 暂停**，真实 run/resume 无法执行；按产品前置条件 `blocked`，不以参数单测虚构成功 |
| E07 跨文件重构               | 参考实现拆出 `spill-format.ts`；AST + 无磁盘 I/O 检查                                 | 无阻断                                                                                                              |
| E08 大仓库搜索调查           | rubric 按**当前**冻结源码重写（9 条事实），参考报告由源码生成                         | 无阻断                                                                                                              |
| E09 取消后继续工作           | 受保护 workload、ready 后取消自有父子进程、同 DB/session 重开继续、完整 E05 oracle    | 需要实际场景证据；离线契约/假端点通过不表示真实模型通过                                                             |
| E10 两子代理集成             | 参考实现 = E05 + E06；适配器打开子代理并统计真实子会话；缺委派判 `delegation-missing` | 包含 CLI 需求，因此当前按 `PRODUCT_SCOPE.cli=false` 阻断                                                            |

E08 的 rubric 曾经判「漂移」并阻断该题：旧 rubric 的两条事实（搜索只在前 1000 个候选内、读取只给前 256000 字节）在当前源码里已不成立（搜索预算改为 200000 条目、文件读到 EOF）。现在 rubric 改写为 9 条**可在冻结语料中直接复核**的事实（每页 1000 个文件的列举上限、目录遍历 5000 条目 / 1000 文件预算、搜索 200000 条目预算、正则最多 10000 文件、`Workspace.read` 的 256000 字节前缀、匹配行 500 字符上限、知识库每工作区 64 篇文档、知识检索 20 条上限），`casePreparationBlock` 会在任何付费样本之前先确认这些锚点仍然存在。

### 7.3 只能描述机制、尚未取得运行结论的地方

1. **E03/E04 的离线三对照是否实际成立**：机制与参考实现都在，但结论以 `controls/controls.json` 为准。
2. **取消路径**：Host 对 `run.cancel` 的应答是释放运行槽并中止 `run.start`（客户端收到「请求被中止」的错误），**不解析出 `status=cancelled` 的 `RunResult`**。因此取消的证据是「取消请求被应答 + 运行槽释放 + 无遗留终态」，而不是一个结果对象；`gradeSample` 据此判 `cancelled`（不是 `invalid`），且取消在任何题目上都不算通过（计划只为 E09 的预定取消阶段付费）。
3. **平台跳过**：Windows 上冻结语料里有 1 条 POSIX 权限位用例声明 `# SKIP POSIX permission bits are not a Windows concept`，已在 `cases.mjs` 的 `platformSkips.win32` 登记。裸 `# SKIP` 或未登记理由仍然判不通过。
4. **E09 的预定取消**属于第一阶段。只有第二阶段正常完成、历史 hash 一致、长命令未重放、E05 验收与全部清理通过时才能判断场景通过；外部取消仍记为取消。

## 8. 已知缺口（操作者必读）

| #   | 缺口                    | 影响                                                                                                                               |
| --- | ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| 1   | CLI 产品前置不满足      | E06/E10 当前 `blocked`，保留在30样本分母；不会启用产品或假造30/30                                                                  |
| 2   | `runCliSample` 是永久桩 | CLI 暂停前保留历史参数参考，不声称真实 run/resume 已验收                                                                           |
| 3   | 外部取消已接入          | `executeBatch(...,{signal})` 与 CLI SIGINT/SIGTERM 使用同一取消源；取消后不再启动下一样本，全部预定样本都有终态                    |
| 4   | `reasoning` 未显式下发  | 产品的 reasoning 只在策略命名时上行，`reasoning:'off'` 与「不下发参数」一致；manifest 记录的是这一事实，没有对应的环境变量可以改写 |
| 5   | 缓存边界                | `promptCache=off` 只保证不发送缓存字段，不保证供应商冷缓存；实际缓存用量仍以 usage 为准                                            |

## 9. 卫生约定

- 凭据只经环境变量进入被适配进程，日志、结果与报告都经过 `redact`；假密钥回归会断言它不出现在结果里。
- 冻结运行时与任务副本的依赖一律从既有锁定安装复制，缺依赖或版本漂移是准备阻断，不静默安装。
- 任务工作副本不包含本工装、参考答案与评分器；公开检查的失败细节在批次结束前不回传给被测 agent。
- 冻结输入在复制前后逐个复核哈希与文件清单，变化即阻断；`assertFrozen` 在批次开始、每个样本评分前后都会重算。
- 取消不产生 `RunResult` 是**产品行为**（见 §7.3），工装据实记录而不伪造终态。

## 10. 相关位置

| 内容                 | 路径                                                               |
| -------------------- | ------------------------------------------------------------------ |
| 任务集定义           | [cases.mjs](cases.mjs)                                             |
| 外部验收器           | [verify.mjs](verify.mjs)                                           |
| 配置与 live 授权契约 | [schema.ts](schema.ts)                                             |
| 执行入口             | [run.mjs](run.mjs)                                                 |
| 结果聚合与报告       | [report.mjs](report.mjs)                                           |
| 离线工装测试         | [coding-evaluation.test.ts](../../tests/coding-evaluation.test.ts) |
| 产品面暂停清单       | [product-scope.ts](../../packages/protocol/product-scope.ts)       |

## 11. 2026-10-14 离线执行入口与比较边界

`node benchmarks/coding-evaluation/local/prepare-offline.mjs .scratch/coding-evaluation/<new-batch-id> <new-batch-id>` 先按允许清单复制当前源码到自有快照，复核原目录与副本 hash，再冻结并执行30样本离线三对照。依赖只从本机已有安装复制，lock 与冻结 lock 必须完全一致；不会安装、不启动真实模型。CLI 暂停题使 dry-run 如实退出2；检查 `controls/controls.json`、`results.jsonl` 与 `batch.json`，不能把退出2改写为全题通过。

假端点回执是 version 2，要求同一冻结 runtime 的正常完成和实际挂起请求取消两段证据，含取消应答、运行槽释放、终态settled、清理与脱敏；只有一个 `checksPassed:true` 布尔值不足以解锁 live。

E08 当前9事实 rubric 是用户上午修改后的新评分输入，与旧5事实 rubric 的 prompt/oracle/corpus hash 不同；保留题目ID不意味着两版可直接比较。只能把相同 rubric、prompt、语料和配置 hash 的记录放在同一个比较组。
