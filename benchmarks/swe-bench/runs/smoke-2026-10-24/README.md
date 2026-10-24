# 2026-10-24 五题冒烟结果

模型为 `DeepSeek-V4.1-Flash-1017`，两版本均使用 `promptCache=auto` 和 no-commands；每题一次样本尝试，没有重试。固定 50 题子集中的 5 道较低难度题用于冒烟，不代表排行榜水平。

| 指标                 | 旧版 a17ddbc | 新版 ec08343 |
| -------------------- | ------------ | ------------ |
| resolved / 计划题数  | 3 / 5（60%） | 3 / 5（60%） |
| 实际被官方判定       | 3            | 3            |
| 空补丁，未获官方判定 | 2            | 2            |
| Wilson 95%           | 23.1%–88.2%  | 23.1%–88.2%  |
| 轮数中位数           | 14           | 21           |
| 耗时中位数           | 163.3 秒     | 225.1 秒     |
| 已知输入 token       | 1124034      | 1809324      |
| 已知输出 token       | 43308        | 103757       |
| 其中缓存输入 token   | 982400       | 1675136      |
| usage 完整           | 否           | 否           |

两版均通过 Astropy、Django、scikit-learn，相同两题 Sphinx、SymPy 为空补丁。配对表为共同通过 3、仅旧版 0、仅新版 0、共同未通过 2；精确 McNemar p=1。冒烟没有观察到版本间差异，不能推出等效。

旧版 Sphinx 遇到模型空闲超时，新版 Sphinx 遇到 HTTP 429；新版 scikit-learn 在生成补丁后遇到 HTTP 429，该补丁仍被官方判为 resolved。两版 SymPy 均未实际写入修改。生成终止状态及原始 adapter 哈希保存在 [generation-terminal.json](generation-terminal.json)，不把上游故障直接归为模型能力差异。

官方验收为 `swebench==5.0.2`，两批 Actions 均成功：[旧版](https://github.com/sunjun0120/YuanTu-Foundry/actions/runs/40049388689)、[新版](https://github.com/sunjun0120/YuanTu-Foundry/actions/runs/40049393160)。[actions.json](actions.json) 记录原始 artifact ID、GitHub 声明的 ZIP 哈希及输入提交；artifact 保留至 2026-11-23，原件已下载保存在本地批次目录。

已保存各批次 manifest、生成结果、严格导入后的结果及原始预测，离线重生成报告：

```powershell
node benchmarks/swe-bench/report.mjs --batch=benchmarks/swe-bench/runs/smoke-2026-10-24/before --compare=benchmarks/swe-bench/runs/smoke-2026-10-24/after --out=.scratch/swe-bench/smoke-report-reproduced
```

原始报告在 `.scratch/swe-bench/smoke-comparison-2026-10-24/report.md`；[report-reproduction.json](report-reproduction.json) 记录两份单批报告和配对报告共 6 文件的逐字节重生成哈希。官方报告及补丁路径相对于各自 artifact 根目录。数据库、私有 HOME 和模型密钥不随本目录交付；[privacy-scan.json](privacy-scan.json) 记录本地证据密钥原文扫描未命中。

仅按冒烟均值外推 50 题 × 2 版本：已知输入约 2933 万 token（含缓存约 2658 万），输出约 147 万。单价单位为每百万 token 时，金额公式为 `2.758220 × 输入单价 + 26.575360 × 缓存单价 + 1.470650 × 输出单价`。未提供单价，不计算金额；usage 不完整且冒烟仅取较低难度，此外推不是费用上界。每题已知总 token 中位数的 3 倍分别为 618837 / 1081818，可作观察后取消阈值参考；本轮设置为 2000000。全量仍需单独批准。
