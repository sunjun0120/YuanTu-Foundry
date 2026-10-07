import asyncio
import os
from pathlib import Path
import sys
import tempfile
import unittest
from yuantu_agent import AgentHostClient, HostError

SCRIPT = '''
import json, os, sys
for line in sys.stdin.buffer:
    request = json.loads(line)
    if request["method"] == "host.info":
        packet = {"id": request["id"], "result": {"protocolVersion": 2 if os.environ.get("MODE") == "version" else 1, "runtime": "yuantu", "workspace": os.getcwd(), "capabilities": []}}
    elif os.environ.get("MODE") in ("cancel-timeout", "cancel-failure") and request["method"] == "run.start":
        print(json.dumps({"event": {"type": "run.started", "sessionId": "session", "runId": "run", "data": {}}}), flush=True)
        continue
    elif os.environ.get("MODE") == "cancel-timeout" and request["method"] == "run.cancel":
        packet = {"id": request["id"], "result": {"cancelled": True}}
    elif os.environ.get("MODE") == "encoding":
        sys.stdout.buffer.write(b"\\xff\\n"); sys.stdout.buffer.flush(); continue
    elif os.environ.get("MODE") == "timeout":
        continue
    else:
        packet = {"id": request["id"], "error": {"message": "secret-fixture denied", "code": "DENIED"}}
    print(json.dumps(packet), flush=True)
'''


class SDKTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="yuantu-python-unit-")
        self.root = Path(self.temp.name)
        self.host = self.root / "host.py"
        self.host.write_text(SCRIPT, encoding="utf-8")

    async def asyncTearDown(self):
        self.temp.cleanup()

    def client(self, mode):
        return AgentHostClient(node_path=sys.executable, host_path=self.host, workspace=self.root, request_timeout=.1, env={"MODE": mode, "API_KEY": "secret-fixture"})

    async def test_version_failure_stops_host(self):
        client = self.client("version")
        with self.assertRaises(HostError) as raised:
            await client.start()
        self.assertEqual(raised.exception.code, "UNSUPPORTED_PROTOCOL")
        self.assertIsNone(client.pid)

    async def test_encoding_failure_and_close(self):
        async with self.client("encoding") as client:
            with self.assertRaises(HostError) as raised:
                await client.request("session.create", {})
            self.assertEqual(raised.exception.code, "INVALID_FRAME")
            self.assertTrue(raised.exception.outcome_unknown)

    async def test_timeout_is_unknown_without_replay(self):
        async with self.client("timeout") as client:
            with self.assertRaises(HostError) as raised:
                await client.request("session.create", {})
            self.assertEqual(raised.exception.code, "REQUEST_TIMEOUT")
            self.assertEqual(raised.exception.method, "session.create")
            self.assertTrue(raised.exception.outcome_unknown)
            self.assertEqual(len(client._pending), 0)

    async def test_error_retains_code_and_redacts_secret(self):
        async with self.client("error") as client:
            with self.assertRaises(HostError) as raised:
                await client.request("session.create", {})
            self.assertEqual(raised.exception.code, "DENIED")
            self.assertNotIn("secret-fixture", str(raised.exception))

    async def check_cancel_failure(self, mode, code):
        async with self.client(mode) as client:
            client.shutdown_timeout = .05
            pending = asyncio.create_task(client.run("session", "wait"))
            async for event in client.events():
                if event["type"] == "run.started":
                    break
            pending.cancel()
            with self.assertRaises(HostError) as raised:
                await pending
            self.assertEqual(raised.exception.code, code)
            self.assertEqual(raised.exception.method, "run.start")
            self.assertTrue(raised.exception.outcome_unknown)
            self.assertEqual(len(client._pending), 0)

    async def test_cancel_terminal_timeout_is_unknown(self):
        await self.check_cancel_failure("cancel-timeout", "CANCEL_TIMEOUT")

    async def test_cancel_rpc_failure_is_unknown(self):
        await self.check_cancel_failure("cancel-failure", "CANCEL_FAILED")


if __name__ == "__main__":
    unittest.main()
