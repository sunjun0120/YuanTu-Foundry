# B1、B2、B3：22 题小集复测

批次 swe-b123-small22-20261025-v1，运行时 cf7808d2d2fb4c97299de88ebab606cbaf6b2bce，模型 DeepSeek-V4.1-Flash-1017。每题一次，输出额度 8192，调查阈值 240 秒、提醒 120 秒，零字节重试 0。

| 指标 | 历史同题基线 | 本次 22 题 |
| --- | ---: | ---: |
| 空补丁 | 12 | 13 |
| 官方 resolved | 7 | 待验收 |
| 请求 | 457 | 405 |
| inputTokens | 9,965,009 | 7,310,824 |
| outputTokens | 790,392 | 683,893 |
| cachedInputTokens | 9,239,040 | 6,304,640 |
| 生成耗时（分钟） | 130.4 | 114.6 |

原空补丁变为有补丁：django__django-11149、django__django-15561。这项统计只表示生成了修改；官方解决题以验收为准。
原空补丁获官方 resolved：待验收。

## 原有 7 道 resolved 的回退检查

| 题目 | 本次官方判定 | 补丁字节 |
| --- | --- | ---: |
| django__django-12419 | pending | 2083 |
| django__django-14771 | pending | 1423 |
| django__django-17084 | pending | 979 |
| sympy__sympy-13551 | pending | 0 |
| sympy__sympy-13798 | pending | 2255 |
| sympy__sympy-23950 | pending | 0 |
| sympy__sympy-24562 | pending | 2369 |

## 机制与逐题成本

本次触及 length 的样本 14、请求 14；动手回合样本 5；产品记录振荡写入命中 0、注入振荡提示 0。逐次提示位置、写入计数、动手回合读取及结局见 mechanism-metrics.json。

| 题目 | 历史→本次补丁字节 | 历史→本次请求 | 历史→本次输入 token | length | 振荡命中/提示 | 本次官方 |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| astropy__astropy-14598 | 0→0 | 10→6 | 132371→76002 | 1 | 0/0 | pending |
| django__django-10999 | 497→491 | 8→10 | 87244→104454 | 0 | 0/0 | pending |
| django__django-11149 | 0→3915 | 12→30 | 119812→610605 | 0 | 0/0 | pending |
| django__django-11885 | 0→0 | 6→7 | 60236→98743 | 1 | 0/0 | pending |
| django__django-12419 | 2879→2083 | 58→22 | 1795947→385063 | 0 | 0/0 | pending |
| django__django-14771 | 950→1423 | 17→71 | 186408→1878445 | 0 | 0/0 | pending |
| django__django-15561 | 0→1950 | 11→30 | 139857→546534 | 0 | 0/0 | pending |
| django__django-15957 | 0→0 | 7→5 | 98754→47969 | 1 | 0/0 | pending |
| django__django-16950 | 0→0 | 8→1 | 76277→6688 | 1 | 0/0 | pending |
| django__django-17084 | 1863→979 | 22→28 | 347310→505806 | 0 | 0/0 | pending |
| matplotlib__matplotlib-24627 | 0→0 | 11→19 | 139163→258956 | 1 | 0/0 | pending |
| matplotlib__matplotlib-24870 | 0→0 | 9→10 | 116029→105332 | 1 | 0/0 | pending |
| pydata__xarray-7229 | 0→0 | 10→12 | 124737→187055 | 1 | 0/0 | pending |
| scikit-learn__scikit-learn-13124 | 0→0 | 9→7 | 145732→96149 | 1 | 0/0 | pending |
| sphinx-doc__sphinx-10449 | 3046→0 | 66→11 | 1914931→157160 | 1 | 0/0 | pending |
| sphinx-doc__sphinx-10614 | 0→0 | 11→13 | 155754→251966 | 1 | 0/0 | pending |
| sphinx-doc__sphinx-10673 | 0→0 | 11→16 | 159480→286285 | 1 | 0/0 | pending |
| sympy__sympy-13551 | 1237→0 | 12→9 | 187087→107944 | 1 | 0/0 | pending |
| sympy__sympy-13798 | 2282→2255 | 67→19 | 1955522→273079 | 1 | 0/0 | pending |
| sympy__sympy-20916 | 1027→608 | 19→28 | 312822→584090 | 0 | 0/0 | pending |
| sympy__sympy-23950 | 1701→0 | 61→18 | 1579601→195733 | 1 | 0/0 | pending |
| sympy__sympy-24562 | 683→2369 | 12→33 | 129935→546766 | 0 | 0/0 | pending |

## 解释边界

- 使用历史同题基线，未增加新的对照组或重复尝试。当前运行时还包含 D1、B5、B6 等修复；完整工装、依赖和配置差异记录在 configuration-differences.json。变化不能单独归因于 B1/B2/B3，不做严格配对检验。
- 22 题只用于决定是否继续五十题，不与原五十题结果混算。官方验收只在一次性 GitHub-hosted Linux runner 执行。生成阶段不运行被测仓库代码。
- usage 完整性：历史 false，本次 true。未知不计作已知零；金额单价未提供，只报告已知 token。费用应按未缓存输入、缓存输入和输出各自单价计算。观察后取消阈值不是硬货币上限。
- 原始补丁、生成状态与错误均保留。修改测试文件和官方环境错误单列，不能以有补丁代替官方 resolved。
