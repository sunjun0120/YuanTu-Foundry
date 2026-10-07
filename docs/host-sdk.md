# Host SDK v1

构建后使用 `import { AgentHostClient } from 'yuantu-agent/sdk'`；本仓库示例为 [host-sdk.mjs](../examples/host-sdk.mjs)。需要 Node 24+、已安装的 Host 和绝对工作区路径；不单独分发另一份运行时。

- 传输是 UTF-8 JSONL，单行请求 `{id, method, params}`，响应 `{id, result}` 或 `{id, error: {message, code?}}`。事件为 `{event}`，与请求响应交错，响应可乱序。请求上限 16 MB，默认接收帧上限 64 MB。
- `host.info` 可发送 `protocolVersions: [1]`；旧客户端省略时仍选择 1。未知协议拒绝，不猜测降级。新增结果字段和未知事件类型允许忽略，已知必需字段类型不允许改变。能力以 Host 返回的 `capabilities` 为准。
- `subscribe` 接收已知事件；`run` 订阅输出的同时等待最终结果。`approval.required` 用 `approval.respond` 显式回答，例子默认拒绝。`run` 的 AbortSignal 发出 `run.cancel` 后等待终态，不能把取消请求成功当成实际执行已停止。
- `session.get` 依 `nextOffset` 继续消息分页；超大单条消息依 `messageChunk.nextChunkOffset` 重组后才解释 JSON。`session.events` 依 `nextSeq` 和 `more` 继续；live `seq` 用于重新查询日志，不把事件重放当成副作用重放。
- 展示窗口可使用 `session.get({sessionId, view:'display', offset:0, tail:100})`，结果附实际起点 `offset` 与固定终点 `totalMessages`；后续页传 `endOffset:totalMessages`，更早窗口传 `offset:Math.max(0,offset-100), endOffset:offset`。`tail` 是展示专用正整数，不能同时设置消息/文本偏移；`endOffset` 是排他终点。原有未分页请求仍返回完整历史。`SessionController` 默认读取最近 100 条，`loadOlder()` 向前加载 100 条，快照 `historyStart` 表示剩余更早消息数；模型历史不受展示窗口限制。
- 请求超时抛 `HostRequestError`，`code: REQUEST_TIMEOUT`、`outcomeUnknown: true`；同步发送失败也保留未知结果。远端返回错误携带 `method` 和可选 code，旧 Host 无 code 时使用 HOST_REQUEST_FAILED。断线抛 `HostDisconnectedError`。错误文字经过现有凭证脱敏。
- SDK 不自动重放任何请求。spawned client 可显式重新 `start`；connected client 由调用方建立新 transport。恢复时查询历史、事件和文件效果，再决定是否发起新的操作。超时／断线并不证明修改未发生。
- `stop` 关闭输入并等待 Host 收尾；强制停止或异常退出会报告无法确认后代清理。应用必须在 finally 中等待 stop；主运行和压缩等长请求没有普通 RPC 的十秒期限。

兼容测试覆盖 legacy offer、共同版本、无共同版本、无效元数据、附加字段、远端错误、未知超时结果和同步传输失败；已有真实 Host 客户端测试覆盖流式输出、写审批、恢复及取消。
