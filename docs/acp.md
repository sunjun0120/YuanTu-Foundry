# ACP 自动化适配器首批

使用固定的官方 `@agentclientprotocol/sdk` 1.7.0 稳定入口，协议版本为 ACP v1；未启用实验 v2。构建后执行：

```powershell
node dist/apps/agent-acp/main.js --workspace E:\project
```

仅 stdout 输出 JSON-RPC JSONL；诊断进入 stderr。Host 仍读取既有部署模型设置、权限和数据库。适配器连接关闭时等待 Host 收尾。

首批支持 initialize、session/new、session/load、session/prompt、session/cancel。文本和工具事件转为 session/update；载入按 Host 消息分页及超大单条分块重放显示转录，工具请求／结果保持配对。写审批转为 session/request_permission，只授予本次 allow-once；拒绝、未知 optionId、不可用客户端和已取消请求都不授权。取消在 Host 返回终态后才响应原 prompt。

一个适配器固定一个由启动参数指定的工作区；客户端 cwd 必须一致。文本以外提示、额外工作区、客户端传入的 MCP servers 显式拒绝；MCP 继续由 Host 已有配置提供。Host 问答请求按未回答处理。模式／模型切换、文件编辑器 UI、认证交互和客户端 terminal/fs 扩展未接入，也没有宣布这些能力。模型凭据由部署配置提供，authMethods 为空。

**范围限制**：ACP v1 的 [MCP stdio 要求](https://agentclientprotocol.com/protocol/v1/session-setup) 尚未完成；因此本批属于可运行的文本自动化适配器，不宣称完整 ACP v1 合规。后续必须接通客户端 MCP 配置及取消审批的更广泛客户端验收，才能扩大声明。版本／能力、输出与审批映射依据 [初始化](https://agentclientprotocol.com/protocol/v1/initialization)、[提示轮次](https://agentclientprotocol.com/protocol/v1/prompt-turn)、[工具审批](https://agentclientprotocol.com/protocol/v1/tool-calls) 官方契约。

实际验收使用官方 ACP 客户端连接独立适配器子进程和真实 Host；模型端用确定性 HTTP fixture。它验证建／载入、中文输出、工具审批文件效果、取消终态和 stdout 协议解析；不能替代编辑器 GUI 或真实模型验收。
