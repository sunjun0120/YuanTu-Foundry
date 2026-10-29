# 2026-10-29 五十题官方验收：37/50 resolved

冻结运行时 `cd44c314fa92896952deabe1cfe70b6cfa1f8dc4`，模型 `DeepSeek-V4.1-Flash-1017`，OpenAI 协议，no-commands，每题一次、无重试。批次 `swe-full-20261029-v1`，`configHash c964ba69d63aee72ca5eaa43da48e4d5217609661560ce4029ee4bc54e71665b`。

**结果：官方 37/50 resolved（74.0%，Wilson 95% 60.4%–84.1%），7 unresolved，6 error（全部为空补丁未判定）。**

官方验收在临时 GitHub-hosted Linux runner 上用 `swebench==5.0.2` 执行，50 题全部导入，没有 Docker/环境错误：[run 40822038477](https://github.com/sunjun0120/YuanTu-Foundry/actions/runs/40822038477)。

## 生成

| 指标 | 数值 |
| --- | ---: |
| 计划 / 尝试 | 50 / 50 |
| 有补丁 | 44 |
| 空补丁 | 6 |
| 修改测试文件 | 3 |
| 请求 | 1,528 |
| 输入 / 输出 / 缓存输入 token | 29,917,744 / 2,246,930 / 26,431,744 |
| 单题耗时中位数 | 264 秒 |
| 轮数中位数 | 24.5 |
| 逐题耗时之和 | 4.78 小时 |

4 个样本在观察阈值中止（3 个触达 200 万已知 token、1 个触达 20 分钟单题上限），中止前已改文件，补丁照常收集并参与验收；它们分别为 `pydata__xarray-7229`（unresolved）、`sphinx-doc__sphinx-7910`（resolved）、`sympy__sympy-13798`（resolved）、`sympy__sympy-13551`（resolved）。

## 未通过明细

7 个 unresolved：`django__django-10999`、`psf__requests-1921`、`pydata__xarray-7229`、`pylint-dev__pylint-4604`、`sphinx-doc__sphinx-10614`、`sympy__sympy-18199`、`sympy__sympy-20916`。

6 个 error 全部是 `empty-patch-not-graded`，与生成侧空补丁一一对应：

| 实例 | 空补丁原因 |
| --- | --- |
| `astropy__astropy-14598` | 输出额度耗尽（16384 token 全为推理） |
| `matplotlib__matplotlib-24627` | 输出额度耗尽（15847 推理 token，工具参数截断） |
| `django__django-11885` | DSML 调用与原生调用冲突，明确报错 |
| `django__django-16950` | 同上 |
| `matplotlib__matplotlib-24870` | 正常结束，全程未改文件 |
| `sphinx-doc__sphinx-10673` | 正常结束，全程未改文件 |

3 个修改测试文件的样本（`pytest-dev__pytest-5809`、`sympy__sympy-13551`、`sympy__sympy-23950`）官方判定全部 resolved。按工装约定不剔除，单列供审查。

## 与 10-25 批次的同题对照（描述性）

同一 50 题逐题配对：34 题两次都 resolved，3 题仅本次 resolved，2 题仅上次 resolved，11 题两次都未 resolved；精确 McNemar **p=1**。

- 本次新增 resolved：`django__django-14771`、`django__django-15957`、`matplotlib__matplotlib-25122`。
- 本次丢失：`django__django-16950`（本轮 DSML 冲突报错）、`psf__requests-1921`。

这是**描述性对照，不是严格配对**：运行时（`91fa342`→`cd44c31`）、`streamIdleTimeoutMs`（30s→60s）和 `zeroByteRetries`（0→1）都变了，`configHash` 不同，`report.mjs` 因此拒绝生成配对统计。3 比 2 的差向、p=1，说明本轮与上一轮的通过率差异在噪声范围内，**不能归因于任何单个修复**。

## 边界

- no-commands 生成：Agent 不能运行被测项目的测试，只用于版本间对比，不能与可执行代码的排行榜 Agent 直接比较。
- 50 题一次样本，无重复采样；n=50 下小于约 10 个百分点的差异通常不显著。
- error 保留在总分母，单列为未判定，不能直接算作模型失败；空补丁同样未被官方判定。
- 费用：单价未提供，只报告 token，不推算金额。token 完整性标志为 `false`（观察阈值中止的样本 usage 不完整）。

## 证据

| 文件 | SHA-256 |
| --- | --- |
| `predictions.jsonl` | `714a0e1764189d1db3a7717941f39ee8c8848ea1915164a1522f1c30121a32eb` |
| `results.evaluated.jsonl` | `806c6603e0181bf80d5e1fed6feb2fdb8d4f47bea95e2ee2b4ce1c942e589693` |

- `report.md`：`report.mjs` 生成的逐题报告（每题官方 `report.json` 来源与哈希）。
- `summary.json`：机器可读统计。
- `generation-summary.json`：生成侧统计与空补丁逐条原因。
- `results.jsonl` / `batch.json` / `manifest.resolved.json`：原始生成记录与冻结配置。
- 官方评估原件、私有 HOME 与 SQLite 只保留在本地 `.scratch/swe-bench/swe-full-20261029-v1/`，不随报告发布。
