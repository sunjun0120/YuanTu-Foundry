# 五十题复测：16384 输出额度（2026-10-25）

批次 `swe-full-20261025-v1`，运行时 `91fa342347c550ce2e0033e13a6d259a2dd9cd8f`，模型 DeepSeek-V4.1-Flash-1017，no-commands，每题一次。本批只改变两项额度：`maxOutputTokens` 8192→16384，`requestTimeoutMs` 120000→600000；其余与 22 题批次一致（`streamIdleTimeoutMs=30000`、`instanceTimeoutMs=1200000`、`investigationMs=240000`、`zeroByteRetries=0`、`promptCache=auto`）。

**结果**：官方 **36/50 resolved（72.0%）**，3 unresolved，11 error；11 个 error 全部是空补丁，其中 7 个是 DSML 工具调用文本泄漏、4 个是连接空闲超时。

## 生成结果

| 指标 | 本次 | 10-24 五十题（新版 ec08343） |
| --- | ---: | ---: |
| 计划 / 尝试 | 50 / 50 | 50 / 50 |
| 有补丁 | **39** | 29 |
| 空补丁 | **11** | 21 |
| `length` 截断样本 | **0** | 9 |
| 连接空闲超时样本 | 7（3 个已有补丁） | 2 |
| 请求 | 1,102 | 779 |
| 输入 token | 17,488,284 | 11,662,849 |
| 输出 token | 1,487,179 | 896,874 |
| 缓存输入 token | 15,149,056 | 10,604,032 |
| 墙钟 | 4.91 小时 | 约 2.7 小时（中位数推算） |
| 轮数中位数 | 21 | 13 |
| 单题耗时中位数 | 324 秒 | 162.6 秒 |
| 单题输入中位数 | 296,265 | 162,101 |
| 单题输出中位数 | 24,218 | 15,231 |
| 修改测试文件 | 6 | 1 |

- 本次比 10-24 新版多 10 个补丁，代价是输入约 1.5 倍、输出约 1.66 倍、墙钟约 1.8 倍。
- 空补丁仍占请求的 14%、输入的 13%、输出的 24%、墙钟的 19%。

## 空补丁原因

11 个空补丁全部有明确原因，且**没有一个是输出截断**：

| 实例 | 原因 | 请求 | 墙钟 | 说明 |
| --- | --- | ---: | ---: | --- |
| astropy__astropy-14598 | DSML 文本 | 19 | 417s | 末轮把 `read_file` 写成 DSML 文本，无 tool_calls |
| django__django-11885 | DSML 文本 | 16 | 513s | 末轮把 `read_file` 写成 DSML 文本 |
| django__django-15957 | DSML 文本 | 18 | 448s | 末轮把 `read_file` 写成 DSML 文本 |
| matplotlib__matplotlib-24627 | DSML 文本 | 21 | 462s | 末轮把 `edit_file` 写成 DSML 文本 |
| pydata__xarray-7229 | DSML 文本 | 22 | 482s | 末轮把 `read_file` 写成 DSML 文本 |
| sphinx-doc__sphinx-10614 | DSML 文本 | 23 | 299s | 末轮把 `read_file` 写成 DSML 文本 |
| sphinx-doc__sphinx-10673 | DSML 文本 | 17 | 455s | 末轮把 `read_file` 写成 DSML 文本 |
| matplotlib__matplotlib-24870 | 连接空闲 | 3 | 61s | 30 秒无数据，`Model connection idle timeout` |
| matplotlib__matplotlib-25122 | 连接空闲 | 2 | 38s | 同上 |
| pylint-dev__pylint-4604 | 连接空闲 | 10 | 141s | 同上 |
| sympy__sympy-18199 | 连接空闲 | 4 | 45s | 同上 |

### DSML 工具调用文本泄漏（7 例）

7 个空补丁的最后一轮 `finishReason=stop`、`toolCalls=[]`，assistant 文本以 `<｜｜DSML｜｜ calls>` / `<｜｜DSML｜｜ invoke name="…">` / `<｜｜DSML｜｜ parameter …>` 形式包含一次完整的工具调用（`read_file` 或 `edit_file`），但没有进入工具执行链。检查结果：

- 7/7 的末尾 assistant 都不含任何 `toolCalls`，也不含 `length` 截断；运行以 `completed` 结束，工具当时仍然可用。
- 7/7 没有触发 `investigation-conclude`，不是旧的“收尾撤工具”路径。
- 产品代码没有 DSML 解析器（`packages/` 内无 `DSML` 命中），因此这类文本只会被当成最终回答，编辑永远不会发生。
- 8k 时同一批样本表现为 `output-limit`，是因为推理先被截断；16k 让模型走到“发起工具调用”那一步，但网关/模型把原生 DSML 调用留在了 content 里。**提高输出额度不能修复这 7 例**。

可能方向（都需单独验证，不应直接自动执行文本里的调用）：网关把 DSML 转成 OpenAI `tool_calls`；或产品在严格校验工具名/参数 schema 后做 DSML 回退解析；或对该路由做 `YUANTU_DEEPSEEK_COMPAT=on` 的历史格式 A/B。未经 schema 校验直接执行 DSML 文本会引入注入与错误调用风险，不建议作为默认行为。

### 连接空闲超时（4 例空补丁，另 3 例已有补丁）

7 个样本出现 `Model connection idle timeout`（30 秒无数据），其中 `django-11149`、`django-13363`、`django-15561` 在超时前已收集到补丁，仍计 generated；其余 4 个没有补丁。该失败与输出额度无关，属于网关/传输层；下一轮可把 `streamIdleTimeoutMs` 从 30 秒放宽到 60 秒，或对“无任何可见输出”的空闲断开做一次有界重试（需产品决策）。

## 官方验收

官方 `swe-bench-eval` 工作流成功（[run 40217096789](https://github.com/sunjun0120/YuanTu-Foundry/actions/runs/40217096789)），50 题全部导入，没有 Docker/环境错误：

| 指标 | 本次 | 10-24 五十题（新版 ec08343） |
| --- | ---: | ---: |
| resolved | **36 / 50（72.0%）** | 25 / 50（50.0%） |
| unresolved | 3 | 4 |
| error（全部为空补丁未判定） | 11 | 21 |
| 实际获官方判定 | 39 | 29 |
| Wilson 95% | 58.3%–82.5% | 36.6%–63.4% |
| 修改测试文件 | 6（全部 resolved） | 1 |

- 3 个 unresolved：`django__django-10999`、`django__django-14771`、`sympy__sympy-20916`。
- 11 个 error 全部是 `empty-patch-not-graded`，与前面的 7 个 DSML + 4 个空闲超时一一对应。
- 发布提交：`a780632`（分支 `codex/swe-full-20261025`）；预测 SHA-256：`da97e8c3e02152fd9ea7ed453b139b749ef01310b5eeda5013cbf73f4f806aa7`。
- 官方评估原件：`.scratch/swe-bench/swe-full-20261025-v1/evaluation-artifact/swe-bench-40217096789-1/`；导入后的逐题判定：`.scratch/swe-bench/swe-full-20261025-v1/results.evaluated.jsonl`。

### 与 10-24 五十题的同题对照（描述性）

同一 50 道题逐题配对：23 题两次都 resolved，13 题仅本次 resolved，2 题仅上次 resolved（`django__django-14771`、`matplotlib__matplotlib-25122`），12 题两次都未 resolved；精确 McNemar **p=0.0074**。

这个配对只能作为描述：两次运行的运行时（`ec08343`→`91fa342`）、输出额度（8192→16384）、请求超时（120s→600s）都不同，且本次多出的补丁中包含 6 个修改测试文件的样本。不能把 +11 resolved 单独归因于 B1/B2/B3 或输出额度。

本次新增 resolved 的 13 题：`django__django-12419`、`django__django-13363`、`django__django-15561`、`django__django-16877`、`django__django-16950`、`psf__requests-1921`、`pytest-dev__pytest-5631`、`sphinx-doc__sphinx-10449`、`sphinx-doc__sphinx-7910`、`sympy__sympy-13551`、`sympy__sympy-23950`、`sympy__sympy-24443`、`sympy__sympy-24562`。

## 修改测试文件的样本

6 个：`pydata__xarray-4075`、`pytest-dev__pytest-5809`、`sphinx-doc__sphinx-10449`、`sympy__sympy-13551`、`sympy__sympy-13798`、`sympy__sympy-23950`，官方判定全部 resolved。按工装约定不因修改测试文件移除样本，但单独列出供审查；官方判定仍以验收器为准。

## 解释边界

- 本批只跑一次、50 题，无重复采样；与 10-24 五十题不是严格配对：运行时从 `ec08343` 变为 `91fa342`（含 D1/B5/B6、B1/B2/B3 与桌面修复），额度与请求超时也不同。因此 36 vs 25、McNemar p=0.0074 只能描述相关性，不能归因于单一修复。
- 11 个 error 对应 11 个空补丁，全部为 `empty-patch-not-graded`，未发现额外的官方 Docker/环境错误。
- 本机 no-commands，只用于版本间比较，不能与可执行代码的排行榜成绩直接比较。
- 空补丁主要来自 DSML 文本泄漏与连接空闲，不是代码质量；不能把 resolved 变化单独归因于 B1/B2/B3。

## 复现

- 配置：`.scratch/swe-bench/swe-full-20261025-control/manifest.json`
- 生成：`.scratch/swe-bench/swe-full-20261025-v1/`（`results.jsonl`、`predictions.jsonl`、`evidence/`、`work/`）
- 分析：`.scratch/swe-bench/swe-full-20261025-control/generation-analysis.json`、`mechanism-metrics.json`
- 配置差异：`.scratch/swe-bench/swe-full-20261025-control/configuration-differences.json`
- 官方导入：`node benchmarks/swe-bench/ingest.mjs --batch=<batch> --evaluation=<artifact>`，随后 `node benchmarks/swe-bench/report.mjs --batch=<batch>`。
