# SWE-bench Verified 外部评测

本目录把 YuanTu Agent Host 的补丁交给官方 SWE-bench 验收器。冻结子集包含 50 题，另有 5 题冒烟集；no-commands 生成设定仅用于版本间对比，不是排行榜成绩。

数据准备、Host 生成工装、官方验收工作流与报告已完成。2026-10-24 经冒烟后单独授权，完成两版本各 50 题：旧版 `a17ddbc` 为 26/50 resolved（52%），新版 `ec08343` 为 25/50（50%），精确 McNemar p=1，没有检出配对差异。详见[全量报告及可复现记录](runs/full-2026-10-24/README.md)，其中单列空补丁、中断、记录恢复与修改测试文件的样本。两版五题冒烟均为 3/5（60%），见[冒烟记录](runs/smoke-2026-10-24/README.md)。本机不运行被测 Python 仓库的代码，不需要 Docker 或 WSL；全部官方验收均在临时 GitHub-hosted Linux runner 完成。

## 冻结的数据

题目来自 [SWE-bench Verified](https://huggingface.co/datasets/SWE-bench/SWE-bench_Verified)，`test` 划分；固定 Hub revision、种子、抽样规则、每题完整记录的 SHA-256 和冒烟题目列在 [subset-v1.json](subset-v1.json)。记录哈希覆盖所有原始字段；完整数据留在本地缓存，不交给被测 Agent。

按仓库比例使用最大余数法分配 50 个名额，每仓库至少 1 题；仓库内再按难度分层。输入先按题目 ID 排序，再使用固定种子的 mulberry32 洗牌。冒烟集只选两档较低难度，覆盖至少 3 个仓库。选样命令只创建新文件，不覆盖既有子集。

在临时 Python 虚拟环境安装 `datasets==5.1.0` 后运行：

```powershell
python benchmarks/swe-bench/fetch-dataset.py --revision 78f471bf655a3137b2e8a75af1501690ec009ec3 --out .scratch/swe-bench/dataset/78f471bf655a3137b2e8a75af1501690ec009ec3.jsonl
node benchmarks/swe-bench/select-subset.mjs .scratch/swe-bench/dataset/78f471bf655a3137b2e8a75af1501690ec009ec3.jsonl 78f471bf655a3137b2e8a75af1501690ec009ec3 .scratch/swe-bench/subset-reproduced.json
```

下载不需要模型凭据。缓存位于 `.scratch/swe-bench/`；可用 `HF_HOME` 将 Hugging Face 缓存也放在此目录。只对子进程设置下载代理，不改系统设置。

## 仓库副本

[repos.mjs](repos.mjs) 将公开仓库存为 `.scratch/swe-bench/repos/<owner>__<name>.git`，再按 `base_commit` 创建 detached worktree。缓存保留部分克隆的 promisor 配置，能够按需获取该提交的文件对象。副本创建后必须校验 HEAD 精确相等且工作区干净。`core.autocrlf=false`、`core.longpaths=true` 仅用于缓存及本次 Git 命令，不写全局配置。

工作副本与缓存共用 Git 对象；保留工作副本时也必须保留缓存。清理副本应使用对应缓存的 `git worktree remove <absolute-workspace>`，不要手工删除活跃 worktree 元数据。

## 离线验证

```powershell
node scripts/run-tests.mjs tests/swe-bench.test.ts
```

测试只使用内置假数据和本地临时 Git 仓库，不联网、不调用真实模型。完整检查使用 `npm run check`；它不等于真实模型评测、官方 Docker 验收或桌面发布验收。

## 生成批次

以 [manifest.example.json](manifest.example.json) 为模板，在本地副本填写获批模型、协议、端点、限制及子集哈希。凭据只来自 `YUANTU_API_KEY`，不写入 manifest。示例默认不授权真实请求。

后续批次示例将响应头等待设为 `responseHeadersTimeoutMs=120000`，流空闲设为 `streamIdleTimeoutMs=60000`，每轮允许一次零字节重发（`zeroByteRetries=1`），输出额度为 `16384`，请求总时限为 `600000`。响应头超时发生在收到 `Response` 之前，报 `Model response headers timeout`；流空闲超时发生在响应体开始读取后，报 `Model stream idle timeout`。10 月 25 日全量的 4 个超时空补丁属于前者，单独放宽流空闲时间不能解决。零字节重发仍可能产生费用，只适用于没有响应体字节和已解析事件的连接失败，并保留事件记录；它不重试题目，也不重发已有正文或推理字节的请求。旧 manifest 的缺省语义和冻结批次不变；这些显式设置进入配置身份，不能与旧配置当作同条件比较。

DeepSeek 的 OpenAI Chat 路由还兼容本轮声明工具对应的完整 DSML 调用块：只解析正文末尾未引用的调用，工具名和全部参数必须先通过当前声明的 JSON Schema，之后照常执行工具审批、路径限制及沙箱检查。普通示例、代码块和引用保留为文本；格式残缺、未知工具或参数不符会明确失败，不能冒充完成。`YUANTU_DEEPSEEK_COMPAT=off` 关闭该兼容；其他模型仅在显式设为 `on` 时启用。此修复不改变历史评估结果。

```powershell
node benchmarks/swe-bench/run.mjs --manifest=benchmarks/swe-bench/manifest.example.json --out=.scratch/swe-bench/new-dry-batch --batch-id=new-dry-batch --instances=smoke --dry-run
```

必填 `--manifest=`、`--out=`、`--batch-id=`；可选 `--instances=smoke` 或逗号分隔 ID、`--runtime=<完整提交 SHA>`、`--dry-run` 或 `--live`。未知、重复、空值参数及同时给出两种模式均拒绝。未指定模式等同 dry-run；实例覆盖只能缩小 manifest 授权的范围。路径相对于当前工作目录解析。

dry-run 会冻结指定提交的运行时、复制本机现有锁定依赖、物化各题并为每题写入 `blocked/offline-not-executed`，不启动 Host 或请求模型。准备成功退出 0，准备或工装异常退出 2。`blocked` 不是解题成功。

live 必须先获用户对模型、端点、冒烟预算、验收位置和缓存模式的确认，再将本地 manifest 的 `approvedLiveBudget.authorized` 设为 `true`，`maxAttempts` 至少覆盖本批次题数；每题只尝试一次，失败不重试。`maxObservedRequestsPerSample` 与 `maxKnownTokensPerSample` 都是观察后取消的阈值，不能充当硬费用上限。没有实测前不提供虚构成本；冒烟完成后按实测输入、输出和缓存 token 及用户单价估算两版本全量费用。

两个版本均禁用辅助模型会话标题（`YUANTU_SESSION_TITLES=0`，比较配置记录 `sessionTitles=false`），避免标题请求绕过解题运行的请求统计。其余环境由既有 `controlledEnvironment` 控制，`promptCache` 按 manifest 设置，沙箱固定 `host`，不改产品工具默认加载方式。每题使用私有 HOME/TEMP 和 SQLite；命令、终端、验证命令与外部访问统一拒绝，写文件仅放行工作副本内的文件编辑工具，拒绝 `.git`、运行期目录、越界和符号链接。

补丁包含新增、修改、删除和测试文件，排除 `.yuantu/` 等运行期目录。空补丁记 `empty-patch`，修改测试文件会标注。`generated` 仅表示生成了待验收补丁；官方验收后才能判定 resolved。

补丁须保留原始字节，普通源码里的 `password`、`secret` 赋值不能用日志正则替换。写出前检查显式模型凭据，命中即阻断；日志仍做通用脱敏，JSON 证据先脱敏字符串值再序列化，避免正则破坏结构引号。工装的 Git 子进程不继承模型凭据、HOME 或 Git 配置注入，屏蔽系统/全局 Git 配置并关闭 hooks、fsmonitor、外部 diff 和凭据助手，避免模型编辑 `.gitattributes` 后在补丁收集时触发宿主 clean filter。个人 Git 配置不会用于公共仓库缓存。

批次目录包含 `manifest.resolved.json`（端点 URL 置 null）、`frozen/inputs.json`、`results.jsonl`、官方格式的 `predictions.jsonl`、`batch.json`、`work/<id>/` 和 `evidence/<id>/`。证据包含权限策略与应答器源码哈希、补丁、事件、取消与清理确认。SQLite 与私有 HOME 只保留本地，不上传或随报告交付。输出目录不可复用；错误批次保留证据，用新 ID 运行。

比较身份同时绑定提示模板、全部生成工装及复用组件的源码、Node/平台/架构、子集和实际复制的依赖内容回执。批次 ID、输入文件所在路径、批准尝试次数和运行时版本不参与解题配置比较；其他生成设置必须一致。

## 官方验收与报告

只在手动触发的 [swe-bench-eval.yml](../../.github/workflows/swe-bench-eval.yml) 中执行官方 Docker 验收，不进入日常 CI。本地 [evaluate.mjs](evaluate.mjs) 入口会拒绝非 GitHub-hosted Linux 环境。

工作流输入 `predictions` 为仓库内预测文件路径；若设置 `artifact_run_id`，则它是该运行中的 artifact 名，内部须包含 `predictions.jsonl`。`run_id` 是名称前缀，实际附加 Actions run ID 和 attempt，防止官方按旧 run ID 复用历史判定。工作流不接收模型密钥，只验收既有补丁。

首次启用手动工作流需要文件位于默认分支，这是 [GitHub 的触发规则](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/trigger-a-workflow)。将工装发布到共享默认分支须先确认具体提交；仅在功能分支上写完工作流不代表已经可以触发官方验收。

固定官方 `swebench==5.0.2` 和下载库 `datasets==5.1.0`，按子集的固定 revision 下载数据并逐题核验记录哈希。该发行版实际 `swebench eval --help` 没有旧版 `--cache_level/--clean`；因此使用 `-j 1` 逐题验收，并在题目之间清理未使用镜像。镜像清理仅发生在本任务专用的临时 runner。runner 磁盘或 Docker 问题保留为 error，不能据此判模型失败。

5.0.2 的实际日志为 `logs/run_evaluation/<run_id>/<model>/<instance>/`，汇总文件名为 `<model>.<run_id>.json`，与当前部分在线文档不同。[evaluate.mjs](evaluate.mjs) 保留每题官方汇总原件，另合并 `results.json`，同时记录预测哈希、数据 revision、子集哈希、CLI 帮助哈希及全部原件哈希。上传的 artifact 只含官方验收目录，不含 Host 数据库或私有 HOME。

下载 artifact 后，将其根目录作为 `--evaluation`：

```powershell
node benchmarks/swe-bench/ingest.mjs --batch=.scratch/swe-bench/<batchId> --evaluation=.scratch/swe-bench/<batchId>/evaluation
node benchmarks/swe-bench/report.mjs --batch=.scratch/swe-bench/<batchId>
node benchmarks/swe-bench/report.mjs --batch=.scratch/swe-bench/<beforeBatch> --compare=.scratch/swe-bench/<afterBatch> --out=.scratch/swe-bench/<comparisonId>
```

导入核对预测、子集、revision、每题官方汇总原件哈希与分类；已判定题还须核对官方 `patch.diff` 与预测逐字节一致，空预测不能拥有 resolved/unresolved 判定。写入 `results.evaluated.jsonl`，保留原生成记录。报告可离线反复生成，全部计划题保留在分母，`resolved + unresolved` 单列为实际判定数，error 单列原因。

报告含 Wilson 95% 区间、轮数/token/耗时的中位数及最小/最大值、配对 2×2 表与精确 McNemar 检验。不同模型、缓存模式、子集或其他生成配置拒绝配对。n=50 下差异小于约 10 个百分点通常不显著；每版本仅一次，没有重复采样。

本机阶段是 no-commands，只用于两版本对比，不与排行榜直接比较。冒烟后以实际 token 更新 50 题 × 2 版本成本估算和观察阈值建议；没有单价则不编造金额。是否运行全量，以及后续容器内生成，分别需要确认。
