# 调查预算修复后的五十题官方验收

官方 run 40145508078 已完成，结果为 **31/50 resolved（62%，Wilson 95% 48.2%–74.1%）**。另有 5 题 unresolved、14 题空补丁未判定、0 题 Docker/验收错误。通用报告将空补丁列入 error（含未判定），因此 report.md 的 14 不代表 14 个 Docker 错误。

冻结运行时 a8d3bca，每题一次；模型 DeepSeek-V4.1-Flash-1017，no-commands，promptCache auto，输出额度 8192。官方 swebench==5.0.2 仅在临时 GitHub-hosted Linux runner 验收既有补丁，本次导入没有新模型调用或 workflow dispatch。

artifact ZIP 已逐字节核对 SHA-256：97aa42aff1030d232ef2c838e3f901199d5804e2eba4555585d31ada397b0184。严格导入核对预测哈希、数据 revision、子集、50 份官方逐题汇总、被验收补丁字节和原件哈希；结果见 [单批报告](report.md)、[摘要](summary.json) 和 [验收绑定](official-evaluation.json)。

3 个生成阶段 invalid 且有补丁的样本继续保留原始标记：sphinx-doc__sphinx-10449 unresolved，sympy__sympy-13798 与 sympy__sympy-23950 resolved。sympy-23950 修改了 sympy/sets/tests/test_contains.py，单列披露，仍保留官方 resolved。全部计划题都留在分母。

| 运行时           | resolved | 比例 |
| ---------------- | -------: | ---: |
| 旧版 a17ddbc     |    26/50 |  52% |
| 上轮新版 ec08343 |    25/50 |  50% |
| 本轮 a8d3bca     |    31/50 |  62% |

这是披露配置差异的并列描述。与上轮相比，harnessHash 和 dependenciesHash 都变化，见 configuration-differences.json，strictPairing=false；每题仅单次尝试且置信区间重叠，不做严格配对或 McNemar，不将 resolved 差异归因于任何单一提交。

原始 results.jsonl、predictions.jsonl、manifest.resolved.json 保持原字节。完整 Host 事件、SQLite、私有 HOME 和模型密钥未发布。新增文件经 UTF-8/UTF-16LE 密钥原文及私有路径扫描，回执见 import-validation.json。
