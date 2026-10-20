# 提示缓存与 DeepSeek 历史兼容

提示缓存用于复用服务端已计算的输入前缀。缓存命中率是输入 token 的占比；会话累计比例不能替代逐请求数据，也不能保证成本或延迟必然下降。真实收益需要在同一模型、端点和任务下比较未命中输入、总输入、输出、费用与首字延迟。

## DeepSeek 兼容范围

`YUANTU_DEEPSEEK_COMPAT` 的默认行为是 `auto`：仅对 `api.deepseek.com` 上已知的 DeepSeek 模型启用原生思考历史回放。`deepseek-flash` / `deepseek-v4-flash` 还启用历史中的系统提示词更新；其他已知模型仍发送当前完整系统提示词。

对于经过验证的兼容网关，可显式设置 `YUANTU_DEEPSEEK_COMPAT=on`，声明其支持思考内容回传和历史系统提示更新。`off` 禁用这两项扩展。嵌入方也可在 `ProviderConfig.deepseekCompatibility` 设置同名取值。`on` 是兼容能力声明，不应给不支持这些扩展的端点使用。桌面 Host 会继承启动时的该环境设置；无需在现有连接中保存凭据以外的新信息。

Chat Completions 保留原生 `reasoning_content`；Messages 保留有序的 `thinking`、签名和工具块。只向生成这些内容的同一协议、规范化端点和实际模型回放。修改或中断的助手消息不复用原生状态，界面显示用的 `Message.reasoning` 也不作为可回放来源。Responses 原有的加密状态回放保持独立。

原生状态随助手消息保存在会话数据库，已有上下文预算算法也会计入该状态。旧会话没有原生状态时不会凭空重建已丢失的思考；Chat 兼容路径为这些助手消息发送空 `reasoning_content`，保留必要字段而不回传来源不明的显示文本，新回复开始积累可回放的状态。

当前启发式预算也会计入原生状态中的可见回答副本，切换路由后可能继续计入不再回放的状态，因此估算偏保守；校准后的预测和提供方实际返回的 `usage` 应分别看待。

## 系统提示词与工具变化

支持历史系统提示更新的路由会记录系列初始提示词，并只在提示词改变时记录完整的新版本。后续请求保留初始提示词和已有历史，在工具结果批次结束后追加新的系统消息。重开会话可从保留的原生状态重建这些位置，不依赖某个进程的内存。

初始快照已被压缩移除、模型或端点切换、助手历史被修改、工具声明变化或提示词被清空时，使用当前完整提示词重新开始系列。权限与工具执行仍以当前执行策略为准。工具声明按名称排列，schema 对象键采用确定顺序；部分加载不再同时改写 `load_tools` 的目录描述。新增、移除工具和压缩历史仍可能改变缓存前缀，不承诺无损复用。

旧工具结果一旦被缩短或裁剪，就通过 `context.tool-results.projected` 保存模型可见的稳定版本；压力下降、校准变化或会话重开不会恢复成全文，也不会反复裁切。原始消息保持完整，投影按原消息位置和内容哈希验证，历史被修改时不复用旧投影，已被压缩覆盖的记录从最新投影中移除。该事件影响模型上下文，未列为可忽略事件；旧版本读取新事件时会按既有未知事件规则拒绝。摘要仍从原始完整记录生成。

可写的自动验证运行会在第一次请求前声明 `completion_step` 和 `completion_scope`。`verify_work` 注册契约时不再新增工具声明；契约尚未创建或调用上下文为只读时，这两个工具返回明确拒绝，不记录进度或范围变化。规划获批后的工具开放仍遵循原有权限切换。

## 逐请求诊断

每次尝试都会产生持久事件和实时事件 `provider.request.finished`，包括失败、重试以及摘要请求。新增字段如下：

| 字段                   | 含义                                                                                                |
| ---------------------- | --------------------------------------------------------------------------------------------------- |
| `usage`                | 本次成功返回的输入、输出及提供方已报告的缓存读取/写入 token；没有返回用量时缺省                     |
| `cacheHitRatio`        | 已知缓存读取数除以输入总量；输入为零或读取量未知时缺省                                              |
| `cacheMissInputTokens` | 输入总量减去缓存读取量，包含缓存写入；读取量未知时缺省                                              |
| `fingerprint`          | 实际序列化后的路由、系统提示、工具、配置和消息历史摘要，以及消息数                                  |
| `prefixChanges`        | 相对之前同用途尝试观察到的 `initial`、`route`、`system`、`tools`、`configuration` 或 `history` 变化 |
| `historyChange`        | `initial` / `unchanged` / `append` / `rewritten`                                                    |

可通过会话事件日志或 `read_session_events` 查询这些记录。答案和摘要分别比较；每条完成记录通过最多两项的 `cacheBaselines` 保存两种用途的最新基线，独立摘要提供方和重建进程也不会丢失另一用途的基线。诊断只记录哈希和计数，不记录提示词、图片、思考内容或凭据；按消息计算的临时前缀哈希不落盘。移动 `cache_control` 断点不算内容变化。前缀变化是本地观察，实际命中只能由提供方返回的用量确认。

Chat Completions 优先读取 `prompt_tokens_details.cached_tokens`，兼容 `prompt_cache_hit_tokens`，仅有 `prompt_cache_miss_tokens` 时由输入总量推算；字段缺失保持未知，非法或超出总输入的计数会拒绝响应。

## 缓存开关

`YUANTU_PROMPT_CACHE` 继续控制应用发送的显式缓存字段。DeepSeek 原生兼容路径使用其自动缓存，不发送 OpenAI 的 `prompt_cache_key`；服务端自动缓存不能通过省略提示字段关闭。其他协议的 `auto` / `blocks` / `key-only` / `off` 规则不变。

参考：[DeepSeek 上下文缓存](https://api-docs.deepseek.com/zh-cn/guides/kv_cache/)、[思考模式](https://api-docs.deepseek.com/guides/thinking_mode/)、[历史系统消息支持](https://api-docs.deepseek.com/guides/tool_calls/)。本次实现以本地协议 fixture 和回归测试验证，未以真实 API 测量缓存收益。
