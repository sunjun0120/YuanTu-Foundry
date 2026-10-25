# SWE-bench Verified 子集评测

批次：swe-full-20261025-v1。真实模型批次：是。

| 指标 | A |
| --- | --- |
| 计划题数 | 50 |
| resolved | 36 |
| unresolved | 3 |
| error（含未判定） | 11 |
| 待验收 | 0 |
| 实际判定 resolved + unresolved | 39 |
| 空补丁 | 11 |
| 修改测试文件 | 6 |
| 通过率（全部计划题为分母） | 72.0% |
| Wilson 95% 区间 | 58.3%–82.5% |

| 分布 | A 中位数 / 最小 / 最大 |
| --- | --- |
| rounds | 21 / 2 / 46 |
| inputTokens | 297399 / 6731 / 1035893 |
| outputTokens | 24438.5 / 127 / 94598 |
| cachedInputTokens | 242560 / 5504 / 981248 |
| durationMs | 325748.20935000014 / 37537.74190000072 / 836578.1090000011 |

## 逐题追溯

| instance | A 结论 | A 证据 |
| --- | --- | --- |
| astropy__astropy-14309 | resolved | `logs/run_evaluation/swe-full-20261025-40217096789-1/yuantu@91fa342+DeepSeek-V4.1-Flash-1017/astropy__astropy-14309/report.json`（sha256 3101b4a8e82798b1f70a56f7a9948bbb32db901d6ecccb2c870a03312bbef1bc） |
| astropy__astropy-14598 | error | empty-patch-not-graded |
| django__django-10880 | resolved | `logs/run_evaluation/swe-full-20261025-40217096789-1/yuantu@91fa342+DeepSeek-V4.1-Flash-1017/django__django-10880/report.json`（sha256 b1a463b27e9f59d0d2c75dc66ee8cd46b586f20a514cb35df6632189d7f9579d） |
| django__django-10999 | unresolved | `logs/run_evaluation/swe-full-20261025-40217096789-1/yuantu@91fa342+DeepSeek-V4.1-Flash-1017/django__django-10999/report.json`（sha256 1e2864412f0c0934ba87c520e08f58cea87bebe36f218e22a5dae2c8d6acb948） |
| django__django-11099 | resolved | `logs/run_evaluation/swe-full-20261025-40217096789-1/yuantu@91fa342+DeepSeek-V4.1-Flash-1017/django__django-11099/report.json`（sha256 783e252651c6cc7cc963c7673895cd27c265b2720927d04893f3de55773a4dd7） |
| django__django-11149 | resolved | `logs/run_evaluation/swe-full-20261025-40217096789-1/yuantu@91fa342+DeepSeek-V4.1-Flash-1017/django__django-11149/report.json`（sha256 4b3f5924489cbbce32ac087f62dbb2ee9d284decf99a7837b5fa8fe2076a928a） |
| django__django-11451 | resolved | `logs/run_evaluation/swe-full-20261025-40217096789-1/yuantu@91fa342+DeepSeek-V4.1-Flash-1017/django__django-11451/report.json`（sha256 0e2fa193e1ccbc4a4770958a15ae31bc763e624949783c1caad0f89607eaeb06） |
| django__django-11815 | resolved | `logs/run_evaluation/swe-full-20261025-40217096789-1/yuantu@91fa342+DeepSeek-V4.1-Flash-1017/django__django-11815/report.json`（sha256 092e5a11f2a57a45b83f66e83ab92b531e88777c267619a8736db26e6f2676cf） |
| django__django-11885 | error | empty-patch-not-graded |
| django__django-12155 | resolved | `logs/run_evaluation/swe-full-20261025-40217096789-1/yuantu@91fa342+DeepSeek-V4.1-Flash-1017/django__django-12155/report.json`（sha256 0b8fbc47afbfe6b4d02b88c342c150b808b4a32b497235a838ab2997476f585d） |
| django__django-12276 | resolved | `logs/run_evaluation/swe-full-20261025-40217096789-1/yuantu@91fa342+DeepSeek-V4.1-Flash-1017/django__django-12276/report.json`（sha256 d74486092cdaacc44812b30e7c2c00893fa57b34664832ef3a5d3a284a0223d9） |
| django__django-12419 | resolved | `logs/run_evaluation/swe-full-20261025-40217096789-1/yuantu@91fa342+DeepSeek-V4.1-Flash-1017/django__django-12419/report.json`（sha256 002db7b3bf143b84229831a7bc597013a48e5bf5408c88b4a91c68de73c90a4e） |
| django__django-13028 | resolved | `logs/run_evaluation/swe-full-20261025-40217096789-1/yuantu@91fa342+DeepSeek-V4.1-Flash-1017/django__django-13028/report.json`（sha256 3c3fbde0bbf87498064d4c34f1d993849c86bcdc9729cd67241ad0b3c5d28ba2） |
| django__django-13089 | resolved | `logs/run_evaluation/swe-full-20261025-40217096789-1/yuantu@91fa342+DeepSeek-V4.1-Flash-1017/django__django-13089/report.json`（sha256 cf1e4a7c63307c0412d4bb14a8b6e06516bb480b2787d3b6fe9bd0301024f4ba） |
| django__django-13343 | resolved | `logs/run_evaluation/swe-full-20261025-40217096789-1/yuantu@91fa342+DeepSeek-V4.1-Flash-1017/django__django-13343/report.json`（sha256 c58c63121846f2cbfa6608ebba7fe33e94a1a61f0bc5726b247aec199a0d41f8） |
| django__django-13363 | resolved | `logs/run_evaluation/swe-full-20261025-40217096789-1/yuantu@91fa342+DeepSeek-V4.1-Flash-1017/django__django-13363/report.json`（sha256 ec15d014998e89c2317ae5bb18bd57c4f5e163d997874a662f6888f2ddb6496d） |
| django__django-13964 | resolved | `logs/run_evaluation/swe-full-20261025-40217096789-1/yuantu@91fa342+DeepSeek-V4.1-Flash-1017/django__django-13964/report.json`（sha256 57dc1ce8b8d1516ce102fd2a9f06520c0749de7166a88c685678f1100dd2e5bc） |
| django__django-14559 | resolved | `logs/run_evaluation/swe-full-20261025-40217096789-1/yuantu@91fa342+DeepSeek-V4.1-Flash-1017/django__django-14559/report.json`（sha256 016f5e85d83e29e60287d8bce2e532ab2f63fce7d890b51187c001471965fe60） |
| django__django-14771 | unresolved | `logs/run_evaluation/swe-full-20261025-40217096789-1/yuantu@91fa342+DeepSeek-V4.1-Flash-1017/django__django-14771/report.json`（sha256 45cd91fc456494b14d4e6f7cae53c8afca640bc0ee4702cc7632f92bc321d7ac） |
| django__django-15561 | resolved | `logs/run_evaluation/swe-full-20261025-40217096789-1/yuantu@91fa342+DeepSeek-V4.1-Flash-1017/django__django-15561/report.json`（sha256 1df63f809aeeccaa31def86f2f713576feb65a2f3a0a25323bb00fab4734ad3e） |
| django__django-15957 | error | empty-patch-not-graded |
| django__django-16569 | resolved | `logs/run_evaluation/swe-full-20261025-40217096789-1/yuantu@91fa342+DeepSeek-V4.1-Flash-1017/django__django-16569/report.json`（sha256 163dbb048ba0a124817da0feddab7a30ff6175f2a2f32df23b1147807df322b1） |
| django__django-16877 | resolved | `logs/run_evaluation/swe-full-20261025-40217096789-1/yuantu@91fa342+DeepSeek-V4.1-Flash-1017/django__django-16877/report.json`（sha256 ba03e2791e314cb85c336d5a5a080fecbb3450a344f36751bfa7cb4c22b5ee79） |
| django__django-16950 | resolved | `logs/run_evaluation/swe-full-20261025-40217096789-1/yuantu@91fa342+DeepSeek-V4.1-Flash-1017/django__django-16950/report.json`（sha256 986cdaff6b3002173095e842232c909517699aa3ae2199c86e267f563a366e48） |
| django__django-17084 | resolved | `logs/run_evaluation/swe-full-20261025-40217096789-1/yuantu@91fa342+DeepSeek-V4.1-Flash-1017/django__django-17084/report.json`（sha256 d79f0f0a6b03d63c5249956ab76cc17849545c3de8458f4d61664c90de8963ea） |
| matplotlib__matplotlib-24627 | error | empty-patch-not-graded |
| matplotlib__matplotlib-24870 | error | empty-patch-not-graded |
| matplotlib__matplotlib-25122 | error | empty-patch-not-graded |
| mwaskom__seaborn-3187 | resolved | `logs/run_evaluation/swe-full-20261025-40217096789-1/yuantu@91fa342+DeepSeek-V4.1-Flash-1017/mwaskom__seaborn-3187/report.json`（sha256 15f9c7d66e708b7b53408efeae1047451de97e19ee02e71edd160bd9187fba32） |
| pallets__flask-5014 | resolved | `logs/run_evaluation/swe-full-20261025-40217096789-1/yuantu@91fa342+DeepSeek-V4.1-Flash-1017/pallets__flask-5014/report.json`（sha256 0a2ad8be764698b129e3371cbf63c3363c816b87a6d1404c42779f49afafce9a） |
| psf__requests-1921 | resolved | `logs/run_evaluation/swe-full-20261025-40217096789-1/yuantu@91fa342+DeepSeek-V4.1-Flash-1017/psf__requests-1921/report.json`（sha256 d0ca8a4cd36e3b1955f389e12d5206839620110214309fdd90e7fa6aa794831e） |
| pydata__xarray-4075 | resolved | `logs/run_evaluation/swe-full-20261025-40217096789-1/yuantu@91fa342+DeepSeek-V4.1-Flash-1017/pydata__xarray-4075/report.json`（sha256 2ca95ac41d9ed4956e03ccd47e88008a82d1b14b41f7f2edc1612adb75bae6ad） |
| pydata__xarray-7229 | error | empty-patch-not-graded |
| pylint-dev__pylint-4604 | error | empty-patch-not-graded |
| pytest-dev__pytest-5631 | resolved | `logs/run_evaluation/swe-full-20261025-40217096789-1/yuantu@91fa342+DeepSeek-V4.1-Flash-1017/pytest-dev__pytest-5631/report.json`（sha256 fa7d8c45af6a784ef6a63c2c386f30767fa8114134aa872e631e1bc6a4a9ebaa） |
| pytest-dev__pytest-5809 | resolved | `logs/run_evaluation/swe-full-20261025-40217096789-1/yuantu@91fa342+DeepSeek-V4.1-Flash-1017/pytest-dev__pytest-5809/report.json`（sha256 8cde956263e0800509ac85fc00303a71ea67631fd0fb7fe5f316fa1a7f760946） |
| scikit-learn__scikit-learn-13124 | resolved | `logs/run_evaluation/swe-full-20261025-40217096789-1/yuantu@91fa342+DeepSeek-V4.1-Flash-1017/scikit-learn__scikit-learn-13124/report.json`（sha256 fc9c689e7aa5233bf3d9e839c7f0149e2f3688dceb44100a92eca82cb2751134） |
| scikit-learn__scikit-learn-13328 | resolved | `logs/run_evaluation/swe-full-20261025-40217096789-1/yuantu@91fa342+DeepSeek-V4.1-Flash-1017/scikit-learn__scikit-learn-13328/report.json`（sha256 e30ec39b6fea2ec294e0adda21f6587642fb2003c7f6e889419d4f0f30364c95） |
| scikit-learn__scikit-learn-25931 | resolved | `logs/run_evaluation/swe-full-20261025-40217096789-1/yuantu@91fa342+DeepSeek-V4.1-Flash-1017/scikit-learn__scikit-learn-25931/report.json`（sha256 4859821ae48d154c7afdc710bb726e0272924a816789acc5d05669f5e9369742） |
| sphinx-doc__sphinx-10449 | resolved | `logs/run_evaluation/swe-full-20261025-40217096789-1/yuantu@91fa342+DeepSeek-V4.1-Flash-1017/sphinx-doc__sphinx-10449/report.json`（sha256 046dbbe2b4db2d4374638e8d5e1f809402073586869f73358231e1024f9a52d1） |
| sphinx-doc__sphinx-10614 | error | empty-patch-not-graded |
| sphinx-doc__sphinx-10673 | error | empty-patch-not-graded |
| sphinx-doc__sphinx-7910 | resolved | `logs/run_evaluation/swe-full-20261025-40217096789-1/yuantu@91fa342+DeepSeek-V4.1-Flash-1017/sphinx-doc__sphinx-7910/report.json`（sha256 b758c52bc5f7e6858850687f34fa425a8f5c3bd72373b5a5051f2d95576bfb34） |
| sympy__sympy-13551 | resolved | `logs/run_evaluation/swe-full-20261025-40217096789-1/yuantu@91fa342+DeepSeek-V4.1-Flash-1017/sympy__sympy-13551/report.json`（sha256 f6bfc75e012de54b098e130ddbda3615225ce10750390db96a91d2baed2a60a8） |
| sympy__sympy-13798 | resolved | `logs/run_evaluation/swe-full-20261025-40217096789-1/yuantu@91fa342+DeepSeek-V4.1-Flash-1017/sympy__sympy-13798/report.json`（sha256 e3817243c1b571d7d19c699f28755451594affd6853d6abecf25038912ee3ef0） |
| sympy__sympy-18199 | error | empty-patch-not-graded |
| sympy__sympy-20916 | unresolved | `logs/run_evaluation/swe-full-20261025-40217096789-1/yuantu@91fa342+DeepSeek-V4.1-Flash-1017/sympy__sympy-20916/report.json`（sha256 4fc1785299e03cbfa67463f40aed17f612ac31cf2a044b18b97362407190194c） |
| sympy__sympy-23950 | resolved | `logs/run_evaluation/swe-full-20261025-40217096789-1/yuantu@91fa342+DeepSeek-V4.1-Flash-1017/sympy__sympy-23950/report.json`（sha256 0cbaf7a63223e6f35fdbddeb7f36f2129f2d0b2bc70e71b8536117773d063feb） |
| sympy__sympy-24443 | resolved | `logs/run_evaluation/swe-full-20261025-40217096789-1/yuantu@91fa342+DeepSeek-V4.1-Flash-1017/sympy__sympy-24443/report.json`（sha256 ee7c2c3333d07f94a21a2c3ecf01af0f99412fb23de69a5c8c1a3afa1c368473） |
| sympy__sympy-24562 | resolved | `logs/run_evaluation/swe-full-20261025-40217096789-1/yuantu@91fa342+DeepSeek-V4.1-Flash-1017/sympy__sympy-24562/report.json`（sha256 5faba6a015869f9a191819c96913955280b9b2b967ddc21fb5100c40b13ada33） |

## 边界与成本

- 生成模式为 no-commands，Agent 不能运行测试；数字只用于版本间对比，不与能执行代码的排行榜 Agent 直接比较。
- 固定 50 题子集（冒烟仅 5 题），每版本一次，没有重复采样，结论粒度粗。工装完成、真实任务结果、与排行榜可比是三件事，各自需要证据。
- 官方 error 表示未得到有效判定，保留在总分母，单独列出原因；不能直接归因为模型失败。空补丁也未被官方判定，并单列数量。
- 不同模型、promptCache、子集、提示模板或生成配置的结果拒绝比较。轮数来自已结束步骤，token 完整性以保存的 usage 标志为准；未知不当成已知零。
- 费用公式：单题费用 = 输入 token × 输入单价 + 输出 token × 输出单价，缓存部分按缓存单价；全量两版本费用 = 冒烟平均单题费用 × 50 × 2。单价未提供时只报告 token，不推算金额。
- A 已知 token 合计：输入 17488284、输出 1487179、缓存输入 15149056；完整：false。
- 请求数与 token 阈值是观察后取消，不是硬费用上限。完整性不明的 token 不能用来承诺费用上界。

观察阈值建议（每题已知输入与输出 token 中位数的 3 倍）：A 1001088；该建议不是费用硬上限。
