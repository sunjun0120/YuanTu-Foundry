# 五十题复测：运行时 cd44c31（2026-10-29）

批次 `swe-full-20261029-v1`，运行时 `cd44c314fa92896952deabe1cfe70b6cfa1f8dc4`（本次 HEAD），模型 `DeepSeek-V4.1-Flash-1017`，OpenAI 协议，no-commands，每题一次。50 题全部尝试，无一重试。

配置：`maxOutputTokens=16384`、`requestTimeoutMs=600000`、`streamIdleTimeoutMs=60000`、`responseHeadersTimeoutMs=120000`、`zeroByteRetries=1`、`instanceTimeoutMs=1200000`、`investigationMs=240000`、`promptCache=auto`、`maxObservedRequestsPerSample=100`、`maxKnownTokensPerSample=2000000`。

**本文件只有生成侧结果。40 题直接生成补丁，4 题因观察阈值被中止但已收集到补丁，合计 44 题有补丁；6 题空补丁。官方判定尚未执行——resolved/unresolved 必须由 `swe-bench-eval` 工作流给出，未跑之前不能报告通过率。**

## 生成结果

| 指标 | 本次（cd44c31） | 10-25（91fa342） |
| --- | ---: | ---: |
| 计划 / 尝试 | 50 / 50 | 50 / 50 |
| 有补丁 | **44** | 39 |
| 空补丁 | **6** | 11 |
| 观察预算中止但保留补丁 | 4 | 0 |
| 请求 | 1,528 | 1,102 |
| 输入 token | 29,917,744 | 17,488,284 |
| 输出 token | 2,246,930 | 1,487,179 |
| 缓存输入 token | 26,431,744 | 15,149,056 |
| 单题耗时中位数 | 264 秒 | 324 秒 |
| 轮数中位数 | 25 | 21 |
| 单题输入中位数 | 400,717 | 296,265 |
| 单题输出中位数 | 30,908 | 24,218 |
| 逐题耗时之和 | 4.78 小时 | 4.91 小时 |
| 修改测试文件 | 3 | 6 |

- 空补丁从 11 降到 6，但总 token 明显上升：输入 1.71 倍、输出 1.51 倍。补丁多出来的部分来自更长的探索，不是更省的路径。
- 4 个 `invalid` 样本是**观察阈值中止**：3 个触发 200 万已知 token 上限，1 个触发 20 分钟单题上限。中止前已改文件，补丁按工装规则照常收集。

## 空补丁原因（6 例）

| 实例 | 原因 | 请求 | 耗时 |
| --- | --- | ---: | ---: |
| `astropy__astropy-14598` | 输出额度耗尽：16384 token 全是推理，0 可见字符 | 18 | 329s |
| `matplotlib__matplotlib-24627` | 输出额度耗尽：15847 推理 token，工具参数只写到一半 | 18 | 386s |
| `django__django-11885` | DSML 调用与原生调用/禁用工具冲突，直接报错 | 18 | 466s |
| `django__django-16950` | 同上 | 18 | 482s |
| `matplotlib__matplotlib-24870` | 正常结束（completed），全程没有改文件 | 24 | 328s |
| `sphinx-doc__sphinx-10673` | 正常结束（completed），全程没有改文件 | 20 | 454s |

与 10-25 的差异：那一批 7 例是“DSML 文本被静默当最终回答”，本轮代码已有 DSML 解析，冲突时明确报错（`DSML calls conflict with native calls or disabled tools`），不再静默产出空补丁。**明确报错比静默丢弃诚实，但这 2 题依然没有解决。**

## 修改测试文件的样本（3 例）

`pytest-dev__pytest-5809`、`sympy__sympy-13551`、`sympy__sympy-23950`。按工装约定不因修改测试文件剔除样本，单独列出供审查；官方判定仍以验收器为准。

## 解释边界

- 本批一次、50 题、无重复采样；与 10-25 不是严格配对：运行时、模型网关等待时长、`streamIdleTimeoutMs`（30s→60s）、`zeroByteRetries`（0→1）都变了，配置差异进入 `configHash`（`c964ba69…` 对 `7ab04323…`）。
- 没有官方判定之前，“44 题有补丁”不等于“44 题通过”。补丁是否正确只能由官方验收器判定。
- 本机 no-commands，不能与可执行代码的排行榜成绩直接比较。

## 复现

- 配置：`.scratch/swe-bench/swe-full-20261029-control/manifest.json`
- 生成：`.scratch/swe-bench/swe-full-20261029-v1/`（`results.jsonl`、`predictions.jsonl`、`evidence/`、`work/`）
- 官方验收：`node benchmarks/swe-bench/evaluate.mjs`（仅 GitHub-hosted Linux runner），随后 `ingest.mjs` / `report.mjs`
