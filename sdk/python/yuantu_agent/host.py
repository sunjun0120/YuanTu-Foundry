"""Host v1 automation client; no request replay or bundled runtime."""
import asyncio
import json
import math
import os
from pathlib import Path
import signal
import uuid

_LONG_REQUESTS = {"run.start", "task.propose", "task.retry", "task.verify", "task.confirm", "context.compact"}
_END = object()


class HostError(Exception):
    def __init__(self, message, *, code="HOST_REQUEST_FAILED", method=None, outcome_unknown=False):
        super().__init__(message)
        self.code = code
        self.method = method
        self.outcome_unknown = outcome_unknown


class AgentHostClient:
    def __init__(self, *, node_path, host_path, workspace, env=None, request_timeout=10, shutdown_timeout=10, max_frame_bytes=64_000_000, event_limit=1024):
        for name, value in (("node_path", node_path), ("host_path", host_path), ("workspace", workspace)):
            if not Path(value).is_absolute():
                raise ValueError(f"{name} must be absolute")
        for name, value in (("request_timeout", request_timeout), ("shutdown_timeout", shutdown_timeout)):
            if not isinstance(value, (int, float)) or not math.isfinite(value) or value <= 0:
                raise ValueError(f"Invalid {name}")
        if not isinstance(max_frame_bytes, int) or max_frame_bytes < 1 or not isinstance(event_limit, int) or event_limit < 1:
            raise ValueError("Invalid frame/event limit")
        self.node_path, self.host_path, self.workspace = str(node_path), str(host_path), str(workspace)
        self.env = {**os.environ, **(env or {})}
        self.request_timeout, self.shutdown_timeout = request_timeout, shutdown_timeout
        self.max_frame_bytes, self.event_limit = max_frame_bytes, event_limit
        self._process = None
        self._reader = self._diagnostics = None
        self._pending = {}
        self._events = asyncio.Queue(maxsize=event_limit)
        self._lock = asyncio.Lock()
        self._start_lock = asyncio.Lock()
        self._failure = None
        self._closing = False
        self.info = None
        self.cursors = {}
        self._stderr = b""

    @property
    def pid(self):
        return self._process.pid if self._process else None

    def _redact(self, message):
        for key, value in self.env.items():
            if value and len(value) >= 4 and any(word in key.upper() for word in ("KEY", "TOKEN", "SECRET", "PASSWORD")):
                message = message.replace(value, "[redacted]")
        return message

    async def start(self):
        async with self._start_lock:
            if self.info:
                return self.info
            if self._process:
                raise HostError("Host failed; close before restarting", code="DISCONNECTED", outcome_unknown=True)
            if not Path(self.host_path).is_file() or not Path(self.node_path).is_file() or not Path(self.workspace).is_dir():
                raise HostError("Node, Host or workspace path is missing", code="INVALID_PATH")
            self._closing, self._failure, self._stderr = False, None, b""
            self._events = asyncio.Queue(maxsize=self.event_limit)
            self._process = await asyncio.create_subprocess_exec(self.node_path, self.host_path, "--workspace", self.workspace, cwd=self.workspace, env=self.env, stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE, limit=self.max_frame_bytes + 1, **({"creationflags": 0x08000000} if os.name == "nt" else {"start_new_session": True}))
            self._reader = asyncio.create_task(self._read())
            self._diagnostics = asyncio.create_task(self._drain_diagnostics())
            try:
                info = await self._request("host.info", {"protocolVersions": [1]}, max(self.request_timeout, 10))
                if not isinstance(info, dict) or info.get("protocolVersion") != 1 or info.get("runtime") != "yuantu" or not isinstance(info.get("workspace"), str) or not Path(info["workspace"]).is_absolute() or not isinstance(info.get("capabilities"), list) or not all(isinstance(item, str) for item in info["capabilities"]):
                    raise HostError("Incompatible Host protocol", code="UNSUPPORTED_PROTOCOL")
                if "runtime.ready" in info["capabilities"]:
                    await self._request("runtime.ready", {}, self.request_timeout)
                self.info = info
                return info
            except BaseException:
                try:
                    await self.close()
                except HostError:
                    pass
                raise

    async def _drain_diagnostics(self):
        while chunk := await self._process.stderr.read(4096):
            self._stderr = (self._stderr + chunk)[-4096:]

    def _fail(self, error):
        self._failure = error
        for future in self._pending.values():
            if not future.done():
                future.set_exception(error)
        self._pending.clear()
        # Overflow/malformed framing is a terminal error, never a silent event drop.
        while not self._events.empty():
            self._events.get_nowait()
        self._events.put_nowait(_END)

    async def _read(self):
        try:
            while line := await self._process.stdout.readline():
                if len(line) > self.max_frame_bytes or not line.endswith(b"\n"):
                    raise HostError("Invalid or oversized Host frame", code="INVALID_FRAME", outcome_unknown=True)
                packet = json.loads(line.decode("utf-8", errors="strict"))
                if not isinstance(packet, dict):
                    raise ValueError("not an object")
                if "event" in packet:
                    event = packet["event"]
                    if not isinstance(event, dict) or not all(isinstance(event.get(key), str) for key in ("type", "sessionId", "runId")) or not isinstance(event.get("data"), dict):
                        raise ValueError("invalid event")
                    seq = event.get("seq")
                    if isinstance(seq, int) and not isinstance(seq, bool) and seq > 0:
                        self.cursors[event["sessionId"]] = max(self.cursors.get(event["sessionId"], 0), seq)
                    self._events.put_nowait(event)
                else:
                    request_id = packet.get("id")
                    if not isinstance(request_id, str):
                        raise ValueError("invalid response id")
                    future = self._pending.get(request_id)
                    if not future or future.done():
                        continue
                    if "error" in packet:
                        error = packet["error"]
                        if not isinstance(error, dict) or not isinstance(error.get("message"), str):
                            raise ValueError("invalid error")
                        future.set_exception(HostError(self._redact(error["message"]), code=error.get("code", "HOST_REQUEST_FAILED")))
                    elif "result" in packet:
                        future.set_result(packet["result"])
                    else:
                        raise ValueError("invalid response")
            if not self._closing:
                raise HostError("Host disconnected; requests were not replayed", code="DISCONNECTED", outcome_unknown=True)
            self._fail(HostError("Host closed", code="DISCONNECTED", outcome_unknown=True))
        except asyncio.CancelledError:
            raise
        except Exception as error:
            self._fail(error if isinstance(error, HostError) else HostError("Invalid Host JSONL, UTF-8 or event queue overflow", code="INVALID_FRAME", outcome_unknown=True))

    async def _request(self, method, params, timeout):
        if self._failure:
            raise self._failure
        if not self._process or self._process.returncode is not None:
            raise HostError("Host disconnected", code="DISCONNECTED", method=method, outcome_unknown=True)
        request_id = str(uuid.uuid4())
        line = (json.dumps({"id": request_id, "method": method, "params": params}, ensure_ascii=False, allow_nan=False) + "\n").encode("utf-8")
        if len(line) > 16_000_000:
            raise HostError("Host request exceeds 16 MB", code="REQUEST_TOO_LARGE", method=method)
        future = asyncio.get_running_loop().create_future()
        self._pending[request_id] = future
        async def exchange():
            async with self._lock:
                self._process.stdin.write(line)
                await self._process.stdin.drain()
            return await asyncio.shield(future)
        try:
            return await asyncio.wait_for(exchange(), timeout) if timeout else await exchange()
        except asyncio.TimeoutError as error:
            raise HostError("Request timed out; inspect state before retrying", code="REQUEST_TIMEOUT", method=method, outcome_unknown=True) from error
        except HostError as error:
            error.method = method
            raise
        except (BrokenPipeError, ConnectionError) as error:
            raise HostError("Host transport failed; outcome unknown", code="TRANSPORT_ERROR", method=method, outcome_unknown=True) from error
        finally:
            self._pending.pop(request_id, None)
            if not future.done():
                future.cancel()
            elif not future.cancelled():
                future.exception()

    async def request(self, method, params):
        if not self.info or self._closing:
            raise HostError("Host is not ready", code="NOT_READY", method=method)
        if not isinstance(method, str) or not isinstance(params, dict):
            raise ValueError("method must be text and params must be an object")
        return await self._request(method, params, 0 if method in _LONG_REQUESTS else self.request_timeout)

    async def run(self, session_id, prompt):
        pending = asyncio.create_task(self.request("run.start", {"sessionId": session_id, "prompt": prompt}))
        try:
            return await asyncio.shield(pending)
        except asyncio.CancelledError:
            try:
                await self.cancel(session_id)
                await asyncio.wait_for(pending, self.shutdown_timeout)
            except (Exception, asyncio.CancelledError) as error:
                pending.cancel()
                await asyncio.gather(pending, return_exceptions=True)
                raise HostError(
                    "Run cancellation could not be confirmed; inspect state before retrying",
                    code="CANCEL_TIMEOUT" if isinstance(error, asyncio.TimeoutError) else "CANCEL_FAILED",
                    method="run.start",
                    outcome_unknown=True,
                ) from error
            raise

    async def cancel(self, session_id):
        return await self.request("run.cancel", {"sessionId": session_id})

    async def events(self):
        """Single-consumer event stream. Run concurrently with requests/approval responses."""
        while True:
            if self._failure and self._events.empty():
                if self._closing:
                    return
                raise self._failure
            event = await self._events.get()
            if event is _END:
                if self._closing:
                    return
                raise self._failure
            yield event

    async def close(self):
        process = self._process
        if not process:
            return
        self._closing = True
        process.stdin.close()
        forced = False
        try:
            await asyncio.wait_for(process.wait(), self.shutdown_timeout)
        except asyncio.TimeoutError:
            forced = True
            if os.name == "nt":
                killer = await asyncio.create_subprocess_exec("taskkill.exe", "/PID", str(process.pid), "/T", "/F", stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.DEVNULL, creationflags=0x08000000)
                try:
                    await asyncio.wait_for(killer.wait(), 5)
                except asyncio.TimeoutError:
                    killer.kill()
                    await killer.wait()
                    process.kill()
            else:
                try:
                    os.killpg(process.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
            if process.returncode is None:
                process.kill()
            await asyncio.wait_for(process.wait(), 5)
        finally:
            for task in (self._reader, self._diagnostics):
                if task:
                    if not task.done():
                        task.cancel()
                    await asyncio.gather(task, return_exceptions=True)
            self._fail(HostError("Host closed", code="DISCONNECTED", outcome_unknown=True))
            self._process, self.info = None, None
        if forced or process.returncode != 0:
            raise HostError("Host exit was abnormal; descendant cleanup unconfirmed", code="SHUTDOWN_FAILED", outcome_unknown=True)

    async def __aenter__(self):
        await self.start()
        return self

    async def __aexit__(self, *_):
        await self.close()
