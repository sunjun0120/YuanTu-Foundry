# 调查预算修复后的当前 main：50 题复测

生成批次 `swe-budget-fix-main-20261024-v1`，冻结运行时 `a8d3bca89feb34b25b21b88b814e333a1edd7fb7`。用户授权使用当前 main 的工装和依赖，每题一次、不重试；模型 DeepSeek-V4.1-Flash-1017，no-commands，promptCache auto，单次输出额度 8192。官方 Docker 验收尚待执行，本目录当前没有 resolved 结论。

50 题全部完成，36 份非空补丁、14 份空补丁。空补丁中 12 题为输出额度耗尽，2 题为模型连接空闲超时。生成端另有 3 题 invalid（2 题 observed-token-budget、1 题 instance-timeout），三题均有补丁；保留原始状态并提交全部 50 题验收，不能把这些无效生成状态隐去。官方判定数、生成有效性和全部计划题分母分别报告。

比较配置指纹为 `297690abe2ac17b3104c51220d106d89224b2fc5c5ce432e5e9a17121eb20721`。与上一批 `ec08343` 的差异包括工装和依赖指纹，详见 configuration-differences.json；不作严格配对检验，不把观测差异归因于单一修复。

preflight.json 绑定预测 SHA-256、50 个冻结数据记录、原始证据哈希及 UTF-8/UTF-16LE 密钥原文扫描回执。SQLite、私有 HOME、完整模型事件、数据集和模型密钥保留本机。所有补丁保留原始字节。

验收采用仓库既有 swe-bench-eval.yml，仅在临时 GitHub-hosted Linux runner 执行官方 swebench==5.0.2。模型不再调用，14 份空补丁也保留在总分母中。下载官方 artifact 后严格核对输入哈希、逐题汇总原件和实际验收补丁，随后生成单批报告。
