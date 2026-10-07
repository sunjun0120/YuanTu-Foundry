# DEV-17：路由声明与上下文首批

先核对既有 [真实模型配对结果](performance-optimization-2026-10-06.md)：目录输入用量降低不等于通用延迟下降，native/PTC 对照也未证明减少往返。因此本批先处理能复现的声明漂移，保持完整转录、工具配对和现有模型视图。

`YUANTU_SUPPORTS_VISION` 由 settings 声明为 boolean，接受 `0/1` 和 `false/true`；原 runtime 与桌面用字符串 `!== 'false'`，让 `0` 被当作支持图片。ProviderConfig 现在保留经过同一 settings parser 的显式声明，runtime 使用该声明，桌面使用同一 parser；未声明时保持既有兼容默认，不能按协议名称推断某个远端模型实际支持图片。

`routeSupports` 原来通过名字包含 openai／anthropic 推断缓存能力；未知适配器 `not-openai`、`custom-anthropic-proxy` 也获得缓存字段。现在只有三个明确内置协议默认声明缓存能力；未知协议的 auto 回退 off。外部适配器仍可通过明确 promptCache 模式配置实际已知的能力。

| 同一确定性场景                              | 修改前                               | 修改后                               | 证据范围                                                   |
| ------------------------------------------- | ------------------------------------ | ------------------------------------ | ---------------------------------------------------------- |
| Host vision=0，发送同一 PNG 与 inspect 提示 | 图片被发送，fixture 模型完成一次请求 | 图片入口拒绝，模型请求 0，历史消息 0 | 真实 Host＋HTTP fixture，RED→GREEN；不计为真实模型延迟收益 |
| 未知 vendor-like 路由，auto cache           | 猜测支持 cache key／blocks           | 不发送自动缓存字段                   | 缓存决策回归；未测真实服务 cache 命中                      |
| 内置路由及明确缓存模式                      | 原有字段                             | 保持兼容                             | provider 请求编码及桌面配置 76/76                          |

现有上下文快照、冷恢复、压缩、工具配对和视觉历史限制继续独立回归。图片 offload／持久模型视图和阶段化工具目录仍需另外的同任务实验；本批没有删除历史或把估计计数称为精确 token。
