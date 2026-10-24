# 接入 SWE-bench Verified，建立外部评测基线（交接给 Codex）

> 本文是一份可直接执行的任务书。执行者：Codex。撰写日期：2026-10-23。仓库：`E:\agent-desktop\YuanTu-Foundry`，基线提交 `main@ec08343`。
> 语言约定：代码注释、提交信息与文档沿用仓库现有风格（注释英文、文档与提交信息中文）。

## 0. 一句话目标

让 YuanTu Agent 在 **SWE-bench Verified 的固定子集**上产出补丁，交给 **官方 swebench 验收器**判定是否解决问题，得到可复现、可与其他 Agent 对照的通过率；并用同一套流程对比提示词与工具面改动前（`a17ddbc`）和改动后（`ec08343`）的效果。

## 1. 背景：为什么要做

- 项目现有评测只有 `benchmarks/coding-evaluation/` 的 `project-seeded-v1`：10 道题，全部由本项目源码派生，README 明确写了“不能当公开基准成绩”。目前没有任何能与其他 Agent 横向比较的数字。
- 本轮已经上线了几项会影响解题能力的改动：系统提示词分节重构（`packages/core/agent-notices.ts`）、首轮工具从 31 个降到 24 个（`packages/tools/deferred-tools.ts`）、配置开关收敛、Windows 命令改用 PowerShell。**这些改动目前没有任何外部数据说明是变好还是变差**，这是本任务最直接的用途。

## 2. 范围与非目标

**范围内**

1. 题目源：SWE-bench Verified（Hugging Face 数据集 `SWE-bench/SWE-bench_Verified`，`test` 划分，500 题，Python 仓库，人工核验过）。
2. 生成端：在隔离工作副本里驱动 YuanTu Agent Host 解题，收集 `git diff` 作为补丁，写出官方格式的 `predictions.jsonl`。
3. 验收端：官方 `swebench` 验收器（需要 Docker / Linux x86_64），在 GitHub Actions 或云端执行。
4. 报告：通过率（含置信区间）、两个运行时版本的配对对比、每题轮数 / token / 耗时。
5. 离线测试：不调用模型、不联网，纳入 `npm test`。

**非目标（不要做）**

- 不改动产品代码（`packages/`、`apps/`）来“刷分”。如果评测暴露出产品缺陷，记录在报告里，另开任务。
- 不在默认测试套件里发出任何真实模型请求或访问网络。
- 不在本机安装 Docker/WSL，也不修改系统设置。本机（Windows 11）**没有 Docker、没有 WSL**，只有 Python 3.13 与 git，验收必须在别处跑。
- 不接入 Terminal-Bench（同样依赖 Docker，留作后续）。
- 不把结果宣称为排行榜成绩（子集、无多次重复，见 §9）。

## 3. 已定决策与待用户确认的决策

### 3.1 已定（直接按此执行）

| 决策                           | 结论                                                                                                                                                                                                                                         | 理由                                                                                                                             |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| 基准                           | SWE-bench Verified                                                                                                                                                                                                                           | 业界最常用、人工核验、官方验收器开源                                                                                             |
| 子集                           | 50 题，按仓库比例分层、再按 `difficulty` 分层，固定随机种子抽样；另选其中 5 题作冒烟集                                                                                                                                                       | 50 题能在可承受成本内给出粗粒度结论；分层避免被 django 一个仓库主导                                                              |
| 子集冻结                       | 题目 id 列表 + 数据集 revision（HF commit sha）+ 每题记录的 sha256 提交进仓库                                                                                                                                                                | 保证以后可复现、可比较                                                                                                           |
| 提示词                         | 只给 `problem_statement`，**不给 `hints_text`**，不给 `test_patch`、`FAIL_TO_PASS`                                                                                                                                                           | 与排行榜主流设定一致                                                                                                             |
| 工作区来源                     | 克隆仓库到本地缓存，按 `base_commit` 检出独立副本                                                                                                                                                                                            | 与官方一致                                                                                                                       |
| 补丁收集                       | 对 `base_commit` 的 `git diff`（含新增文件），排除 `.yuantu/` 等运行期目录；改动测试文件**保留**但在报告中标注                                                                                                                               | 官方验收会在模型补丁之后再应用 `test_patch`                                                                                      |
| 运行时冻结                     | 复用 `benchmarks/coding-evaluation/materialize.mjs` 的 `freezeSource(spec, target)`（目前是模块内部函数，需要加 `export`；对外入口 `freezeInputs` 会同时冻结题库，不适用）冻结两个版本的运行时，依赖用 `dependencies.mjs` 从本机锁定安装复制 | `a17ddbc` 与 `ec08343` 的 `package.json`/`package-lock.json` **完全相同**（已核对），可共用依赖                                  |
| 生成端执行环境（阶段一）       | 本机 Windows，**不允许执行命令**（拒绝 `run_command`/`start_command`/`terminal_*`/`run_validation`），只允许读写工作区文件                                                                                                                   | 本机没有各仓库的 Python 依赖与隔离环境；在宿主上运行陌生仓库代码也不安全。该模式下的数字只用于**版本间对比**，不与排行榜直接比较 |
| 生成端执行环境（阶段三，可选） | 在该题的官方 Docker 镜像里运行 Agent Host，允许执行测试                                                                                                                                                                                      | 这才是与排行榜可比的设定                                                                                                         |
| 统计                           | 通过率给 Wilson 95% 区间；两版本对比给配对结果（双方都过 / 只 A 过 / 只 B 过 / 都不过）与精确 McNemar 检验 p 值                                                                                                                              | n=50 时差异小于约 10 个百分点通常不显著，必须如实说明                                                                            |

### 3.2 待用户确认（开始阶段二之前必须问）

| 事项         | 默认建议                                                           | 说明                                                                                                                         |
| ------------ | ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| 模型与端点   | 由用户指定 `model`/`protocol`/`endpointUrl`                        | 凭据只经环境变量 `YUANTU_API_KEY` 提供，不写入任何文件                                                                       |
| 预算上限     | 先批准冒烟集（5 题 × 2 版本），看实际 token 再批准全量             | 用 §8 的公式先给估算                                                                                                         |
| 验收在哪里跑 | **GitHub Actions `ubuntu-latest`**（`workflow_dispatch` 手动触发） | 备选：`sb-cli`（官方云端，需要注册与 API key）、Modal（需要账号）。GitHub runner 磁盘约 14GB 可用，需要逐题清理镜像，见 §6.3 |
| 提示缓存     | 本评测允许 `promptCache=auto`（两个版本相同设定）                  | 现有工装强制 `off` 是为了可比性；SWE-bench 每题几十轮，关缓存成本可能翻数倍。只要两版本同设定，对比仍成立                    |

## 4. 现状：可以复用什么

现有工装 `benchmarks/coding-evaluation/`（必读：`benchmarks/coding-evaluation/README.md`）已经解决了大部分“如何安全地跑真实模型”的问题，**复用它的组件，不要另起一套**：

| 组件                       | 位置                                                                                              | 复用方式                                                                                                                                                                                              |
| -------------------------- | ------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 运行时冻结、清单哈希、复核 | `materialize.mjs`：`freezeSource`（需导出）、`captureSourceManifest`、`assertFrozen`、`inventory` | 给 `freezeSource` 加 `export`（只此一处改动原工装，改后跑 `tests/coding-evaluation.test.ts` 确认不受影响），冻结 `a17ddbc` 与 `ec08343` 两个运行时                                                    |
| 私有依赖复制               | `dependencies.mjs`：`copyLockedDependencies`、`preparePrivateDependencies`                        | 直接调用；只复制运行时依赖，被测 Python 仓库不需要                                                                                                                                                    |
| 受控环境变量               | `adapters.mjs`：`controlledEnvironment`（只放行少量系统变量与显式 `YUANTU_*`，HOME/TEMP 重定向）  | 直接调用                                                                                                                                                                                              |
| JSONL 运行事件收集         | `adapters.mjs`：`JsonlRunCollector`                                                               | 直接调用                                                                                                                                                                                              |
| Host 采样                  | `adapters.mjs`：`runHostSample`                                                                   | **不能直接用**：它与 E01–E10 的 `caseDef`、`allowedPaths`、`publicCheck` 绑定。参考它的结构，在新模块里写一个 `runSweSample`，复用其中的会话 DB 隔离、固定审批策略、请求/令牌观察阈值、取消与清理确认 |
| 指标去重与聚合             | `metrics.mjs`：`collectMetrics`、`distribution`                                                   | 直接调用 token/轮数统计；评分逻辑新写（结果来自官方验收器）                                                                                                                                           |
| live 授权模式              | `schema.ts`：`requireLiveAuthorization`、`--live`/`--dry-run` 互斥、目录不可复用                  | 照搬模式，写新的 manifest 校验（不要往 `validateManifest` 里塞 SWE 字段，它要求“10 个 case 超时齐全”）                                                                                                |
| 离线 Host 自检             | `tests/coding-evaluation.test.ts` 第 700 行起：本机环回 fixture 服务器 + 假身份                   | 照搬到新测试，用假模型驱动一次“读文件 → 改文件 → 结束”，验证补丁收集链路                                                                                                                              |

产品侧的事实（写适配器时要知道）：

- 产品通过 Agent Host（JSONL RPC）驱动；CLI 被 `PRODUCT_SCOPE.cli=false` 暂停，**只能用 Host**。
- 测试隔离层会删除所有 `YUANTU_*` 变量再设置自己的（`scripts/test-isolation/environment.mjs`），离线测试里需要的变量要在那里或测试内显式设置。
- 首轮只发 24 个工具，其余经 `load_tools` 按需加载，这是产品默认行为，不要在评测里改。
- 评测工装要求 `sandbox=host`；阶段一用权限策略拒绝命令类工具来实现“无执行”，不要改沙箱。

## 5. 架构

新增目录 `benchmarks/swe-bench/`，与 `coding-evaluation/` 并列：

```text
benchmarks/swe-bench/
  README.md               # 中文说明：是什么/不是什么、命令、目录布局、诚实状态（风格对齐 coding-evaluation/README.md）
  subset-v1.json          # 冻结的子集：dataset、revision、seed、抽样规则、50 个 instance_id 与每题记录 sha256、smoke 5 题
  fetch-dataset.py        # 用固定 revision 下载数据集并导出 JSONL 到 .scratch（Python，仅此一处用 Python）
  select-subset.mjs       # 从导出的 JSONL 按 §3.1 规则抽样，生成 subset-v1.json（可重复执行得到相同结果）
  schema.ts               # SweManifest 类型与 validateSweManifest / requireSweLiveAuthorization
  manifest.example.json   # 不含凭据的示例
  repos.mjs               # 仓库缓存（bare clone）与按 base_commit 物化独立工作副本
  prompt.mjs              # 由 problem_statement 生成任务提示词（固定模板，模板文本参与 configHash）
  adapter.mjs             # runSweSample：驱动 Host、固定审批策略（阶段一拒绝命令）、收集补丁与指标
  run.mjs                 # 批次入口：--manifest --out --batch-id --dry-run|--live --instances --runtime
  predictions.mjs         # 写官方格式 predictions.jsonl
  ingest.mjs              # 读取官方验收输出（results.json + 每题 report.json），合并进本地结果
  report.mjs              # 生成 summary.json / report.md：通过率、Wilson 区间、配对对比、McNemar、token/轮数/耗时分布
.github/workflows/swe-bench-eval.yml   # 手动触发的验收工作流（见 §6.3）
tests/swe-bench.test.ts                # 离线测试（见 §7）
```

数据流：

```text
fetch-dataset.py ─► .scratch/swe-bench/dataset/<revision>.jsonl
select-subset.mjs ─► benchmarks/swe-bench/subset-v1.json（提交进仓库）
run.mjs（每个运行时版本一个批次）
  ├─ 冻结运行时（materialize + dependencies）
  ├─ 每题：repos.mjs 物化工作副本 ─► adapter.mjs 驱动 Host 解题 ─► git diff 收集补丁 + 指标
  └─ 写 results.jsonl、predictions.jsonl、batch.json
GitHub Actions（swe-bench-eval.yml）：官方 swebench 验收 predictions.jsonl ─► 上传 logs 与 results.json
ingest.mjs + report.mjs ─► summary.json / report.md（单版本或两版本配对对比）
```

批次输出目录 `.scratch/swe-bench/<batchId>/`（已被 `.gitignore` 的 `.scratch/` 覆盖）：

```text
manifest.resolved.json   # 非敏感参数 + 子集 + configHash（endpointUrl 置 null 后落盘）
results.jsonl            # 每题一行：instanceId、runtime、status、patch 统计、rounds、tokens、durationMs、failureClass
predictions.jsonl        # 官方格式：{"instance_id","model_name_or_path","model_patch"}
batch.json               # live 标志、请求数、运行时哈希、子集哈希、退出码
evidence/<instanceId>/   # session.sqlite、adapter.json、patch.diff、private-home/（本地敏感，不随报告交付）
work/<instanceId>/       # 工作副本（批次结束后可清理）
evaluation/              # 从 Actions 下载回来的官方验收输出
```

## 6. 分阶段任务

每个阶段结束都要：`npm run check` 通过、单独提交（提交信息中文，结尾带 `Co-Authored-By` 行如果你的环境要求）、在本文末尾“执行记录”追加一段结论。

### 阶段 0：环境与数据（不调用模型）

1. `fetch-dataset.py`：用 `datasets` 库按**固定 revision** 加载 `SWE-bench/SWE-bench_Verified` 的 `test` 划分，导出 JSONL。revision 取实现当天的 HF commit sha，写进 `subset-v1.json`。依赖用 `requirements` 注释写明版本，不要求项目整体引入 Python 工具链。
2. `select-subset.mjs`：确定性抽样（固定种子的伪随机，如 mulberry32；不要用 `Math.random`）。规则：按 `repo` 比例分配 50 个名额（每个仓库至少 1 题，按最大余数法取整），仓库内按 `difficulty` 分层抽取；冒烟集取 5 题，覆盖至少 3 个仓库且全部为 `<15 min fix` 或 `15 min - 1 hour`。
3. `subset-v1.json` 提交进仓库；`select-subset.mjs` 重复执行必须得到逐字节相同的文件（离线测试覆盖，用内置的小样本数据）。
4. `repos.mjs`：bare clone 缓存到 `.scratch/swe-bench/repos/<owner>__<name>.git`，按 `base_commit` 用 `git worktree add --detach` 或 `git archive` 物化到 `work/<instanceId>/`；物化后校验 `HEAD` 等于 `base_commit` 且工作区干净。Windows 上注意 `core.autocrlf=false`、`core.longpaths=true`（只对该缓存仓库设置，不改全局配置）。

**验收**：能在本机物化冒烟集 5 题的工作副本；离线测试通过。

### 阶段 1：生成端（离线完成，不调用真实模型）

1. `schema.ts` / `manifest.example.json`：字段至少包括 `batchId`、`runtime`（`{kind:'commit', revision}`）、`subset`（文件路径 + sha256）、`instances`（可选子集）、`model`、`protocol`、`endpointId`、`endpointUrl`、`maxContextTokens`、`maxOutputTokens`、`promptCache`（`off`/`auto`）、`executionMode`（阶段一固定 `no-commands`）、`instanceTimeoutMs`、`maxObservedRequestsPerSample`、`maxKnownTokensPerSample`、`approvedLiveBudget{authorized,maxAttempts}`。校验拒绝未登记键（防止凭据写进 manifest）。
2. `prompt.mjs`：固定模板。建议内容：说明工作区是 `<repo>` 在问题提出时的代码；任务是修改**非测试代码**使问题得到解决；不能运行命令（阶段一）；完成后简要说明改了什么。模板文本计入 `configHash`。
3. `adapter.mjs` 的 `runSweSample`：
   - 参考 `runHostSample`：本样本专属 `session.sqlite`、私有 HOME/TEMP、`controlledEnvironment`、`JsonlRunCollector`、观察阈值、取消与清理确认、`redact`。
   - 审批策略（阶段一）：写入只允许在工作副本内（拒绝 `.git/`）；**命令类工具一律拒绝**；外部访问（`web_fetch`/`web_search`/浏览器）拒绝。把策略和应答器源码哈希写进 `evidence/<id>/approval-policy.json`。
   - 运行结束后收集补丁：`git add -A -N` 后 `git diff <base_commit>`，排除 `.yuantu/`；记录改动文件数、是否改了测试文件、补丁字节数。空补丁记为 `failureClass=empty-patch`。
4. `run.mjs`：参数严格校验（未知/重复参数拒绝，`--live` 与 `--dry-run` 互斥，输出目录已存在即失败）。dry-run：冻结运行时、物化工作副本、为每题写 `blocked/offline-not-executed` 记录，不启动模型。live：要求 `requireSweLiveAuthorization` 通过且环境里有 `YUANTU_API_KEY`。**一次一个样本串行执行。**
5. `predictions.mjs`：`model_name_or_path` 用 `yuantu@<runtime 短哈希>+<model>`，保证两个版本的预测可区分。

**验收**：离线测试用环回 fixture 假模型跑通“物化 → Host 解题（假模型发出一次 `edit_file`）→ 收集补丁 → 写 predictions.jsonl”整条链路；dry-run 能对冒烟集完整执行并写出 `blocked` 记录。

### 阶段 2：验收端与报告（需要用户确认后才发真实请求）

1. `.github/workflows/swe-bench-eval.yml`：`workflow_dispatch`，输入为 predictions 文件（作为 artifact 名或仓库内路径）与 `run_id`。步骤：
   - 释放 runner 磁盘（删除不需要的预装工具链，参考常见的 free-disk-space 做法，但只用 shell 命令，不引入未审核的第三方 action）；
   - `pip install swebench==<固定版本>`（实现当天的最新稳定版，写死版本号）；
   - 用该版本实际支持的命令运行验收。**官方文档对命令有两种写法**：README 写 v5 的 `swebench eval verified -p <predictions> --run-id <id> -j <workers>`，评测指南写旧的 `python -m swebench.harness.run_evaluation --dataset_name ... --predictions_path ... --max_workers ... --run_id ...`。以固定版本 `--help` 的输出为准，并在 workflow 里注释说明；
   - 磁盘紧张时 `--max_workers 2`、`--cache_level` 选 `base` 或 `none`、`--clean True`（以 `--help` 为准）；
   - 上传 `logs/evaluation/<run_id>/` 与 `results.json` 作为 artifact。
   - **不要**在 `ci.yml` 的常规检查里调用它。
2. `ingest.mjs`：读取下载回来的验收输出，按 instance 合并“resolved / unresolved / error”。官方说明“resolved + unresolved 才是实际被判定的数量”，`error` 单独列出、保留在分母里并在报告中说明。
3. `report.mjs`：
   - 单批次：通过率、Wilson 95% 区间、空补丁数、改测试文件数、轮数/token/耗时的中位数与最值（沿用 `metrics.mjs` 的 `distribution`，不报 p95）。
   - 两批次配对：同一子集、同一模型、同一 `promptCache` 才允许比较（`configHash` 中除运行时外全部一致，否则拒绝）；输出 2×2 配对表与精确 McNemar p 值，并写明“n=50 下差异小于约 10 个百分点通常不显著”。
4. 冒烟：用户批准后，`ec08343` 与 `a17ddbc` 各跑冒烟集 5 题，走完验收与报告全链路，记录实际 token 用量，据此用 §8 的公式更新全量成本估算，交用户决定是否跑全量。
5. 全量：用户批准后各跑 50 题，产出最终对比报告。

**验收**：冒烟批次的 `report.md` 由保存的记录离线重新生成；报告里每个数字都能追溯到 `results.jsonl` 或官方 `report.json`。

### 阶段 3（可选，单独确认后再做）：容器内生成

在该题官方镜像（`swebench` 构建的实例镜像）里运行 Agent Host，允许执行测试命令，得到与排行榜可比的设定。需要：镜像内安装 Node 24、挂载冻结运行时、在 Linux runner 上执行生成。成本与复杂度显著更高，阶段二结论出来后再评估。

## 7. 离线测试要求（`tests/swe-bench.test.ts`）

全部离线、不联网、不调用模型，纳入 `npm test`；单文件运行时间控制在 60 秒内。

- manifest 校验：未登记键、缺字段、`--live` 无授权、输出目录已存在、`--live` 与 `--dry-run` 同现，全部被拒绝。
- 抽样确定性：用测试内置的 30 条假记录（多个 repo、多个 difficulty）跑 `select-subset`，两次结果逐字节相同，满足“每仓库至少 1 题”和冒烟集约束。
- 仓库物化：在临时目录用 `git init` 造一个小仓库和两个提交，物化到第一个提交，校验 `HEAD` 与干净状态；Windows 下长路径与换行设置只作用于该仓库。
- 补丁收集：新增文件、修改文件、删除文件、`.yuantu/` 下的文件被排除、空补丁判 `empty-patch`。
- 端到端：照搬 `tests/coding-evaluation.test.ts` 第 700 行的环回 fixture 写法，让假模型先 `read_file` 再 `edit_file`，验证 predictions.jsonl 一行、格式正确、补丁可被 `git apply --check` 接受；同时验证命令类工具调用被审批策略拒绝。
- ingest/report：用手写的假 `results.json` 与 `report.json` 验证 resolved/unresolved/error 的计数、Wilson 区间数值、配对表与 McNemar p 值（给出 2–3 组手算核对值）；配置不一致的两批次被拒绝比较。
- 隔离：遵守 `scripts/check-test-isolation.mjs` 的规则（临时目录用 `tests/temp-fixture.ts` 的 `tempRoot`）；需要的 `YUANTU_*` 变量在测试内显式设置。

## 8. 成本估算公式（阶段二前先算给用户）

```text
单题输入 token ≈ 平均轮数 × 平均每轮上下文 token
单题费用 ≈ 输入 token × 输入单价 + 输出 token × 输出单价（开缓存时输入部分按缓存命中价折算）
批次费用 ≈ 单题费用 × 题数 × 版本数
```

先用冒烟集的实测轮数与 token 代入，不要凭空给数字；单价以用户提供的模型定价为准。同时列出 `maxKnownTokensPerSample` 的取值建议（例如实测中位数的 3 倍），并提醒：该阈值是“观察后取消”，不是硬上限（见 `coding-evaluation/README.md` §2）。

## 9. 结论的诚实边界（报告里必须写明）

- 阶段一是“无执行环境”模式：Agent 不能运行测试，数字**只用于版本间对比**，不与排行榜上能执行代码的 Agent 直接比较。
- 子集 50 题、每版本 1 次，没有重复采样，结论粒度粗。
- 官方验收的 `error` 不是“模型失败”，要单独列出并说明原因。
- 不同模型、不同 `promptCache`、不同子集的结果不可比较。
- “工装完成”“真实任务结果”“与排行榜可比”是三件事，各自需要各自的证据，不合并陈述。

## 10. 仓库规则（必须遵守）

- 提交前 `npm run check` 必须通过（格式、文档事实、引用、分层、环路、i18n、类型、lint、测试、构建、冒烟）。新增文件先 `npx prettier --write`。
- **README.md 不链接、不以路径引用 `docs/` 下的任何文件，也不引用任何 git 分支。** `scripts/check-references.mjs` 会拒绝 README 指向 `docs/`。需要在 README 里提到本评测时，指向 `benchmarks/swe-bench/README.md`。
- 改了 `packages/protocol/settings.ts` 的 `ENVIRONMENT` 就要 `npm run docs:generate`（本任务原则上不需要新增设置项；评测参数放 manifest，不放环境变量）。
- 凭据只来自环境变量 `YUANTU_API_KEY`，不写进 manifest、日志、报告、提交；所有落盘内容经 `redact`。
- 本机是 Windows：用 Node 脚本或 Edit 修改文件，避免用 Python/shell heredoc 批量改源码（容易引入 CRLF 和反斜杠转义错误）。仓库文件统一 LF。
- 不安装 Docker/WSL，不改系统设置、全局 git 配置或执行策略。
- 测试套件默认用 cmd 执行命令（`YUANTU_TEST_WINDOWS_SHELL=cmd`，由测试隔离层设置）；这是有意为之，不要改。

## 11. 交付清单

- [x] 阶段 0：`fetch-dataset.py`、`select-subset.mjs`、`subset-v1.json`、`repos.mjs` + 离线测试
- [x] 阶段 1：`schema.ts`、`manifest.example.json`、`prompt.mjs`、`adapter.mjs`、`run.mjs`、`predictions.mjs` + 离线测试
- [x] 阶段 2 工装：`swe-bench-eval.yml`、`ingest.mjs`、`report.mjs` + 离线测试；`benchmarks/swe-bench/README.md`（真实验收另列）
- [x] 向用户确认 §3.2 四项，给出冒烟实测 token 外推（未提供单价，不虚构金额）
- [x] 冒烟批次（两个版本 × 5 题）报告
- [ ] 用户批准后：全量批次（两个版本 × 50 题）对比报告
- [x] 每个阶段一次提交，`npm run check` 通过

## 12. 执行记录

（执行者在每个阶段结束时追加：日期、提交哈希、做了什么、`npm run check` 结果、遗留问题。）

### 2026-10-23：阶段 0

- 固定 HF revision `78f471bf655a3137b2e8a75af1501690ec009ec3`，使用临时虚拟环境内的 `datasets==5.1.0` 导出 500 条原始记录；选出覆盖 12 个仓库的 50 题和覆盖 5 个仓库的 5 题冒烟集。完整数据重复抽样与提交文件逐字节一致。
- 5 题均已物化到各自 `base_commit`，HEAD 与干净状态校验通过；不执行被测仓库代码。发现共享 clone 丢失部分克隆的 promisor 配置，改用计划允许的 detached worktree，回归先失败后通过。
- 离线测试 2/2；`npm run check` 通过：完整测试 2968 passed、40 skipped、0 failed，构建与 compiled-client 冒烟通过。账户沙箱跳过不代表真实账户验收通过。README 自动事实块同步行为测试文件数量。
- 提交：`abd6277`（按用户要求变基至 `main@8729bc0` 后；原提交 `1c8cde0`）。
- 下载虚拟环境、HF 缓存及失败副本已清理；固定 JSONL、仓库缓存、5 个干净工作副本和检查日志保留在 `.scratch/swe-bench/` 及本任务日志中。未调用真实模型。阶段 1 待执行；真实请求仍等待 §3.2 的模型、预算、验收位置与缓存配置确认。

### 2026-10-23：阶段 1

- 完成严格 manifest/CLI、冻结运行时、私有依赖、Host 驱动、no-commands 权限、补丁与官方预测格式；原 coding-evaluation 工装仅导出 `freezeSource`。没有修改产品代码。
- 用户确认模型 `DeepSeek-V4.1-Flash-1017`，凭据仅经 `YUANTU_API_KEY`，不设金额上限；先运行两个版本各 5 题，沿用已确认的 OpenAI 协议。采用建议的 GitHub Actions 验收与 `promptCache=auto`；全量仍需冒烟后单独确认。端点只读 `/models` 核验返回 200 且存在指定模型，不落入报告。
- 两个冻结提交的最终 dry-run 各有 5 条 `blocked/offline-not-executed`、请求数 0、退出码 0；比较配置哈希相同，运行时哈希分别固定，依赖内容回执相同。
- 独立只读审查发现并修复补丁通用脱敏失真、宿主 Git clean filter 执行入口、官方证据绑定不足；另补全共享组件、平台/Node 和实际依赖内容哈希。补丁保留原字节，显式凭据命中即拒绝写出；日志继续脱敏。两个版本一致禁用辅助模型标题，防止其请求绕过解题统计。
- 生成端 9 项离线测试通过；与阶段 2 工装共同进行的最终 `npm run check` 通过：2982 passed、40 skipped、0 failed；构建和 compiled-client 冒烟 3/3 通过。完整 SWE 文件 16/16，通过时间约 37 秒。前两次完整检查的进程清理异常与既有收件箱竞态均保留失败日志，未将失败当通过。
- 收件箱用例原来只等子会话登记，没有等子代理进入预定挂起状态，导致测试更正偶尔走新 turn 路径。仅修复两处测试前提，断言和超时不变，独立提交 `babd45f`；15/15 回归通过。
- 本阶段实现提交 `637a1c9`。真实冒烟已获授权，验收报告尚待实际生成及官方 Docker 判定；当前无通过率结论。

### 2026-10-23：阶段 2 离线工装

- 固定官方 `swebench==5.0.2`，下载并核对官方 wheel SHA-256，使用临时最小 Python CLI 环境实际执行 `swebench eval --help`。该版没有旧 `cache_level/clean` 参数，日志为 `logs/run_evaluation`，汇总为 `<model>.<run_id>.json`，因此新增 Node 验收编排器逐题 `-j 1` 调用官方 CLI、逐题清理未使用镜像、保留各题官方汇总原件并合并 `results.json`。
- 手动工作流只在专用 GitHub-hosted Linux runner 上验收现成预测，不接收模型密钥，不进入日常 CI。数据源 revision 与每题记录哈希和生成端完全一致。首次手动触发要求工作流先位于默认分支；发布到共享 `main` 仍须取得用户对具体提交的批准。
- 导入绑定预测、子集、revision、逐题官方汇总原件/hash、报告分类及实际 `patch.diff`，拒绝空预测的 resolved/unresolved。报告保留 error 分母、Wilson 区间、配对表、精确 McNemar、指标分布与每题证据；配置不同拒绝比较，保存记录可逐字节重生成。
- 阶段 2 专属 7 项断言/子用例及生成端 9 项共 16/16 通过；完整门禁使用最终待提交代码树统一验证，`npm run check` 退出 0（2982 passed、40 skipped、0 failed，构建与客户端冒烟 3/3 通过）。分阶段提交仅改变 index/历史，未在两次提交之间改动已验证的实现。
- 工装提交 `476f611`，后按用户要求变基到新增桌面修复的 `main@874609e`，变基后为 `972a945`。模型冒烟先旧版 5 题，再新版 5 题，全部串行；未运行全量。官方 Docker 和真实通过率另见下方实际记录，不能用离线测试代替。
- 临时 Python 帮助环境与 wheel 解包目录已清理，保留实际 `--help`、失败/通过检查日志及批次证据。工装完成、真实解题结果和排行榜可比性分别报告。

### 2026-10-24：真实冒烟生成与官方验收启动

- 用户明确批准将已验证的四个提交合入并推送 `main`，继续官方验收。获取最新 `main@874609e` 后四个提交无冲突变基为 `79a3ca7`、`e3d8e31`、`04813d4`、`972a945`；两个被测运行时仍固定 `a17ddbc` / `ec08343`。
- 集成后首轮完整检查因 `host-carrier` 进程清理竞态提前结束（596 passed、1 skipped、0 断言失败，仅完成 30/291 文件），保留失败日志。原样独立复测 12/12 且清理正常；使用仓库已有的收集全部失败模式重跑完整门禁，退出 0：2983 passed、40 skipped、0 failed，全部 291 文件完成，构建及 compiled-client 冒烟 3/3 通过。未改清理规则、超时或产品代码。`main@972a945` 已快进合入并推送。
- 两批真实请求各恰好 5 次样本尝试，没有重试；旧版 74 次请求，新版 102 次请求，各生成 3 个非空补丁、2 个空补丁，均未修改测试文件。比较配置哈希一致，所有 Host 清理确认通过。生成完成不表示官方 resolved。
- 终止状态补充记录：旧版 Sphinx 遇到模型连接空闲超时；新版 Sphinx 遇到服务端 HTTP 429；新版 scikit-learn 在生成非空补丁后遇到 HTTP 429；两版 SymPy 都没有实际写入修改，旧版将 DSML 调用文本作为最终回答。保留原始结果，不重跑，不把上游失败归为已证明的模型能力差异。
- 已知 token 合计：旧版输入 1124034、输出 43308、缓存输入 982400；新版输入 1809324、输出 103757、缓存输入 1675136。两批 usage 均有不完整项，未知不视为零。
- 仅按冒烟均值外推 50 题 × 2 版本：已知输入约 29333580、输出 1470650、缓存输入 26575360；缓存包含在输入总数内。若单价单位为每百万 token，金额公式为 `2.758220 × 输入单价 + 26.575360 × 缓存输入单价 + 1.470650 × 输出单价`。用户未提供单价，不报金额。冒烟只覆盖较低难度且 usage 不完整，此外推不是预算上界。
- 每题已知输入与输出之和中位数的 3 倍：旧版 618837、新版 1081818 token，作为后续观察阈值参考；本轮使用 2000000，观察后取消不是硬费用上限。全量 50 × 2 仍等待冒烟验收后单独批准。
- 扫描两批 52 个本地证据文件（含 SQLite），实际模型密钥在 UTF-8 / UTF-16LE 中均未命中。数据库和私有 HOME 仅留本地；两份官方预测提交 `c80aea5` 至功能分支，未追加推送到 `main`。
- 官方验收全部成功：[旧版 Actions 40049388689](https://github.com/sunjun0120/YuanTu-Foundry/actions/runs/40049388689)、[新版 Actions 40049393160](https://github.com/sunjun0120/YuanTu-Foundry/actions/runs/40049393160)。验收仅读取既有补丁，使用 `ubuntu-latest`（实际镜像 ubuntu-26.04，版本 20261012.163.1）、`swebench==5.0.2` 和冻结数据。旧版 artifact `12542831699`，GitHub 声明 ZIP SHA-256 `d89513450ad47f1120c3d5bc4f3300a147e7b9dbf36243eac263a9bde7e7023a`；新版 artifact `12543181140`，声明 ZIP SHA-256 `8b50d12ddf85729c7861fe856246a7e0a1a4cba0b4bc56e8ac9731d55582d233`，保留至 2026-11-23。
- 两批导入均核对预测哈希、子集、原始官方汇总、逐题报告及实际验收补丁。两版本均 Astropy、Django、scikit-learn resolved；Sphinx、SymPy 为空补丁，未获官方 resolved/unresolved 判定。全部计划题为分母时各为 3/5（60%），实际判定各 3 题；报告的 error/未判定各 2 题均来自空补丁，没有另外的 Docker error。Wilson 95% 均为 23.1%–88.2%；配对表为共同通过 3、仅旧版 0、仅新版 0、共同未通过 2，精确 McNemar p=1。此冒烟没有观察到版本间配对差异，不能推出等效或排行榜水平。
- 本地报告位于 `.scratch/swe-bench/smoke-comparison-2026-10-24/report.md`，原始批次为 `swe-smoke-before-v1` / `swe-smoke-after-v1`。两份单批报告与配对报告的 `summary.json`、`report.md` 共 6 文件从保存记录重新生成后逐字节一致，哈希回执保存在配对目录的 `report-reproduction.json`；另保存生成终止状态与隐私扫描回执。
- 推送后的 [main 自动 CI 40049341950](https://github.com/sunjun0120/YuanTu-Foundry/actions/runs/40049341950) 的 `npm run check` 通过（Linux 测试 2946 passed、77 skipped、0 failed，客户端冒烟 3/3）；后续 `audit:check` 因现有 body-parser / zod 的 high 条目失败，分别为 `GHSA-27r3-jxmh-p828` / `GHSA-mrhx-c7xc-m3w5`。已核对本次四提交未改 `package.json` 或 lockfile；不能把整体 CI 报成通过，也未在此评测任务中扩大到依赖升级。
