import asyncio
import os
import sys
from yuantu_agent import AgentHostClient, HostError


async def main():
    node, host, workspace = sys.argv[1:]
    try:
        AgentHostClient(node_path="relative", host_path=host, workspace=workspace)
        raise AssertionError("relative executable accepted")
    except ValueError:
        pass
    texts = []
    async with AgentHostClient(node_path=node, host_path=host, workspace=workspace) as client:
        session = await client.request("session.create", {})
        async def observe():
            async for event in client.events():
                if event["type"] == "message.delta":
                    texts.append(event["data"]["text"])
                if event["type"] == "approval.required":
                    await client.request("approval.respond", {"approvalId": event["data"]["approvalId"], "allow": True})
        observer = asyncio.create_task(observe())
        result = await client.run(session["id"], "创建中文.txt")
        assert result["status"] == "completed", result
        assert texts == ["写入", "完成"], texts
        page = await client.request("session.events", {"sessionId": session["id"], "limit": 1})
        assert page["more"] and page["nextSeq"] > 0, page
        try:
            await client.request("host.info", {"protocolVersions": [2]})
            raise AssertionError("unsupported protocol accepted")
        except HostError as error:
            assert error.code == "UNSUPPORTED_PROTOCOL"
        observer.cancel()
        try:
            await observer
        except asyncio.CancelledError:
            pass
        pid = client.pid
    try:
        os.kill(pid, 0)
        raise AssertionError("Host left alive")
    except (ProcessLookupError, OSError):
        pass
    async with AgentHostClient(node_path=node, host_path=host, workspace=workspace) as client:
        history = await client.request("session.get", {"sessionId": session["id"]})
        assert history["messages"][-1]["content"] == "完成"
        pending = asyncio.create_task(client.run(session["id"], "等待"))
        async for event in client.events():
            if event["type"] == "run.started":
                await client.cancel(session["id"])
                break
        assert (await pending)["status"] == "cancelled"
    print("PYTHON_SDK_OK")


asyncio.run(main())
