# YuanTu Python SDK

Python 3.11+，运行时仅使用标准库。复用已安装的 Node 24+ 和编译 Host，不自动下载或捆绑模型运行时。构建包需要 setuptools；pip 的隔离构建负责安装它。

干净环境安装（PowerShell）：

```powershell
python -m venv .venv
.venv\Scripts\python -m pip install ./sdk/python
```

```python
import asyncio
from yuantu_agent import AgentHostClient

async def main():
    async with AgentHostClient(
        node_path=r"C:\Program Files\nodejs\node.exe",
        host_path=r"E:\agent\dist\apps\agent-host\main.js",
        workspace=r"E:\project",
    ) as client:
        session = await client.request("session.create", {})

        async def observe():
            async for event in client.events():
                if event["type"] == "message.delta":
                    print(event["data"].get("text", ""), end="", flush=True)
                if event["type"] == "approval.required":
                    await client.request("approval.respond", {
                        "approvalId": event["data"]["approvalId"], "allow": False,
                    })

        listener = asyncio.create_task(observe())
        try:
            result = await client.run(session["id"], "Describe this workspace")
            history = await client.request("session.get", {"sessionId": session["id"]})
        finally:
            listener.cancel()
            await asyncio.gather(listener, return_exceptions=True)

asyncio.run(main())
```

模型配置沿用 Host 环境变量和工作区设置；密钥在本机设置，勿写入示例。事件流必须由一个消费者与运行并行读取，以处理审批；队列默认上限 1024，满时明确失败，不能无限缓存。帧 UTF-8 严格解码，输入 16 MB、输出帧默认 64 MB。

取消用 `await client.cancel(session_id)`，再等待原 `run` 的终态。取消 Python run task 也会发送取消并等待收尾。Host v1 错误／分页／恢复语义见 [契约](../../docs/host-sdk.md)。`HostError` 保留 code、method 和 outcome_unknown；超时／断线不会自动重放。关闭异常明确报告清理未确认；正常退出使用 async with 或 finally 等待 close。应用被操作系统强杀时不保证能运行 Python finally。

SDK 保存收到的事件 seq 于 `client.cursors`；重连由应用显式重建 client，使用 `session.events` 查询缺失记录。完整历史继续存在 Host 数据库，Python 不维护另一份模型视图。
