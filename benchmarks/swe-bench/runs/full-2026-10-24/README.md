# 2026-10-24 五十题配对结果

旧版 `a17ddbc` 为 **26/50（52%）**，新版 `ec08343` 为 **25/50（50%）**。共同通过 19 题、仅旧版通过 7 题、仅新版通过 6 题、共同未通过 18 题；精确 McNemar **p=1**。本轮没有检出版本差异，不能据此断言等效或能力下降。

| 指标                  | 旧版 a17ddbc | 新版 ec08343 |
| --------------------- | ------------ | ------------ |
| resolved / 全部计划题 | 26 / 50      | 25 / 50      |
| unresolved            | 4            | 4            |
| 实际获官方判定        | 30           | 29           |
| 空补丁，未获官方判定  | 20           | 21           |
| 官方 Docker error     | 0            | 0            |
| Wilson 95%            | 38.5%–65.2%  | 36.6%–63.4%  |
| 生成记录异常          | 1            | 2            |
| 修改测试文件          | 1            | 1            |
| 观察到的请求数        | 731          | 779          |
| 轮数中位数            | 12           | 13           |
| 耗时中位数            | 156.6 秒     | 162.6 秒     |
| 已知输入 token        | 10943641     | 11662849     |
| 已知输出 token        | 744706       | 896874       |
| 其中缓存输入 token    | 10067456     | 10604032     |
| usage 完整            | 否           | 否           |

[逐题完整报告](report.generated.md)列出 50 题的判定、原件路径及哈希；[机器可读统计](summary.generated.json)包含分布、配对表和配置身份。error 保留在分母和未通过配对中，全部 20/21 项均为空补丁，没有另外的 Docker error。共有 27 个配对至少一边未获官方判定，配对检验也受这些未判定结果影响。

两版均使用 `DeepSeek-V4.1-Flash-1017`、OpenAI 协议、`promptCache=auto`、no-commands，每题一次样本尝试。用户在冒烟后单独批准 50 题 × 2 版本，实际共 100 次新尝试，无重试。[attempts.json](attempts.json)记录总数及续跑边界。每响应 `maxOutputTokens=8192`，每题 20 分钟、观察请求上限 100、已知总 token 阈值 2000000，均沿用冒烟配置；观察后取消不能构成硬费用上限。

固定数据 revision 为 `78f471bf655a3137b2e8a75af1501690ec009ec3`，子集和所有解题设置相同，配置哈希为 `09e6d3baba5cb5f4254e790acd9dc3b06e0d7048bc9ccbc3757e2a47709c6332`。生成在 Windows/Node 24.19.0 上串行执行，运行时分别固定为 `a17ddbc34d6f78835e2205cb63695c7686fcdc17` / `ec08343e147b46417ffe11d3249deb6b5a408184`，不随工装后续提交移动。

## 影响解读的已知情况

旧版有 8 题以模型连接空闲超时终止、6 题触及每响应输出限制；新版分别为 2 题、9 题。部分终止前已有补丁，仍交官方验收。这些终止状态与无命令模式下的 `needs_review` 分开保存在 [generation-terminal.json](generation-terminal.json)，不能直接当作模型能力结论。

两版 `django__django-11451` 的原始生成记录均为 `invalid/host-or-environment`：工装在完整 JSON 上运行通用脱敏正则，源码中的裸 `password=...` 使结构引号被吞掉。原始 `results.jsonl`、异常分类、补丁与官方判定保持原样；两份补丁均获官方 resolved。仅在 `results.evaluated.jsonl` 中补回经验证的轮数和用量，每条附带不可变恢复回执。恢复核对关闭的根会话、工作区、补丁、终态统计、请求数、源码指纹和 SQLite 哈希，无法证明的值继续未知。[recover-metrics.mjs](recover-metrics.mjs)及各批次的 `metrics-recovery.json` 保存算法与证据绑定。

新版在完成 34 题后，生成进程于第 35 题 `pytest-dev__pytest-5631` 中断。该题已观察到 6 次完成请求，未产生补丁；保留为 `invalid/process-interrupted`，不重试。随后仅执行从未开始的 15 题，使用从 `d0ab817` 提取且逐字节一致的原工装、原冻结运行时和私有依赖，比较配置指纹一致。原先 34 行逐字节不变；[continuation.json](after/continuation.json)、[开始记录](after/continuation-starts.jsonl)和[实际执行的包装器源码](continuation-runner.source.txt)绑定此次接续。中断题 token 与耗时未知，所以新版耗时和 token 分布各只有 49 个已知样本；轮数 6 仅是中断前观察值。

两版唯一修改测试文件的样本均为 `pytest-dev__pytest-5809`，均获官方 resolved；没有移除这些样本来提高或降低分数。两版 `pylint-dev__pylint-4604` 官方汇总均注明 `no_tests_collected`，均计 unresolved。

本机生成禁止执行命令和测试，只适用于这两个固定版本的对比，不能与可执行代码的排行榜设定直接比较。样本仅 50 题、每版本一次；上述环境中断、上游超时、输出限制、工装记录异常及大量空补丁限制了结论。

## 官方原件与离线重生成

官方 `swebench==5.0.2` 验收均成功：[旧版 Actions 40062518767](https://github.com/sunjun0120/YuanTu-Foundry/actions/runs/40062518767)、[新版 Actions 40075340034](https://github.com/sunjun0120/YuanTu-Foundry/actions/runs/40075340034)。GitHub-hosted `ubuntu-latest` 实际镜像为 Ubuntu 26.04，镜像版本 `20261012.163.1`；验收使用 Node 24.21.0 / Python 3.12.15。两个 artifact 的声明 ZIP 哈希与本地下载件一致，ID、输入提交、哈希及 2026-11-23 的过期时间见 [actions.json](actions.json)。

官方报告、逐题汇总与补丁原件保存在本地批次的 `evaluation/`，ZIP 保存在 `evaluation-artifact.zip`。导入已严格核对子集、revision、50 个实例、预测哈希、官方原件哈希、分类以及实际验收补丁；没有用生成端状态代替官方结论。

此目录包含各批次的原始/验收派生记录、manifest、预测、批次回执及恢复回执。无需模型密钥或网络，即可从保存记录重生成报告：

```powershell
node benchmarks/swe-bench/report.mjs --batch=benchmarks/swe-bench/runs/full-2026-10-24/before --compare=benchmarks/swe-bench/runs/full-2026-10-24/after --out=.scratch/swe-bench/full-report-reproduced
```

[report-reproduction.json](report-reproduction.json)记录两份单批报告及配对报告共 6 文件从交付记录重生成后逐字节一致的哈希。SQLite、私有 HOME 和模型密钥未上传；[privacy-scan.json](privacy-scan.json)记录对 510 个原始证据文件、597762170 字节进行 UTF-8/UTF-16LE 密钥原文扫描，命中 0。交付目录另经密钥扫描。

自动报告末尾的“冒烟平均单题费用 × 50 × 2”是事前估算模板。本轮两版已知输入合计 22606490 token（含缓存 20671488），输出 1641580；usage 不完整，中断题用量未计入。单价以每百万 token 为单位时，已知部分费用为 `1.935002 × 输入单价 + 20.671488 × 缓存单价 + 1.641580 × 输出单价`。未提供单价，不计算金额。全量已知每题总 token 中位数的 3 倍为 506199 / 541455，仅供以后选择观察阈值参考。

生成完成后，工装在 `f3a962b` 修复为先脱敏字符串值、再序列化 JSON；没有用修复版重跑本次样本。新增回归先失败后通过，SWE 离线回归 17/17；完整 `npm run check` 通过：2984 passed、40 skipped、0 failed，构建与客户端冒烟 3/3。此前 main CI 的 `audit:check` 因原有 body-parser / zod 公告失败，详见 actions 记录；本任务未升级依赖，不能将整体发布门禁称为通过。
