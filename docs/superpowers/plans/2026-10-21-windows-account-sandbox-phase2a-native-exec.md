# Windows 沙箱账户后端 第二期 2a：原生执行链路 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 新增原生二进制 `yuantu-sandbox.exe` 的 `exec` / `broker` / `runner` 三个子命令，按 Codex 令牌配方在 Job 内创建命令进程，stdio 句柄直通，支持并发与取消。

**Architecture:** 同一 crate（`packages/tools/windows-sandbox/appcontainer`）新增 bin `src/bin/yuantu-sandbox/`。broker 由宿主启动，创建两条单向命名管道给 runner、一条双工管道给 exec；runner 收到 spawn 请求后用 `WRITE_RESTRICTED` 令牌在每命令 Job 内创建进程；broker 用 `DuplicateHandle` 把 exec 的 std 句柄直接复制进 runner。2a 中 broker 只实现 `--dev`（runner 以当前用户身份启动，仅 debug 构建可用）；`--account` 由 2b 实现。

**Tech Stack:** Rust 2024、windows-sys 0.61、serde/serde_json；集成测试用 `cargo test`（`CARGO_BIN_EXE_yuantu-sandbox`）与 Node（fixture 中的 fork 程序）。

**Spec:** `docs/superpowers/specs/2026-10-21-windows-account-sandbox-design.md`（§3.2–§3.5）

## Global Constraints

- 令牌：`DISABLE_MAX_PRIVILEGE | LUA_TOKEN | WRITE_RESTRICTED`；限制 SID 顺序 = 能力 SID…, 令牌用户 SID, logon SID, Everyone；默认 DACL = `D:(A;;GA;;;<logon>)(A;;RC;;;OW)`；启用 `SeChangeNotifyPrivilege`；不降 Low。
- 帧：4 字节小端长度 + UTF-8 JSON，单帧 ≤ 1 MiB，所有消息 `deny_unknown_fields`、`version: 1`。
- `error.kind` 只取：`invalid-request`、`launch-failed`、`runner-lost`、`not-ready`、`lease-conflict`；消息不含环境变量值。
- exec 失败时 stderr 打印以 `SANDBOX_LAUNCH_FAILED_PREFIX`（见 `packages/tools/sandbox-launch-failure.ts`）开头的一行，退出码 125。
- `--dev` 只在 `cfg(debug_assertions)` 下存在；release 构建传入即拒绝。
- 不改动现有 `yuantu-appcontainer` 二进制的行为。

## 文件结构

`packages/tools/windows-sandbox/appcontainer/src/bin/yuantu-sandbox/`：

| 文件 | 职责 |
|---|---|
| `main.rs` | 子命令分发 |
| `win.rs` | `Handle`、`wide`、`win`、SID 文本互转、当前进程令牌用户/ logon SID 读取 |
| `frame.rs` | 帧读写（泛型 `Read`/`Write`，纯逻辑，可单测） |
| `protocol.rs` | 消息类型、请求校验（能力 SID 格式、路径绝对、argv 非空、env 键合法） |
| `token.rs` | Codex 令牌配方 |
| `spawn.rs` | 命令行引号、环境块、在 Job 内创建、等待、取消、排空 Job |
| `pipe.rs` | 命名管道服务端（SDDL、FIRST_PIPE_INSTANCE）、客户端连接、对端身份校验 |
| `runner.rs` | runner 主循环 |
| `broker.rs` | broker 主循环（`--dev` 启动 runner） |
| `exec.rs` | exec 客户端 |

测试：`packages/tools/windows-sandbox/appcontainer/tests/sandbox_exec.rs`、fixture `tests/fixtures/fork.cjs`、`tests/fixtures/forks/a.test.cjs`、`b.test.cjs`。

## 接口（各任务共用）

```rust
// protocol.rs
pub const VERSION: u32 = 1;
#[derive(Serialize, Deserialize)] #[serde(deny_unknown_fields)]
pub struct Request {            // exec 请求文件内容
    pub version: u32,
    pub argv: Vec<String>,      // argv[0] 为绝对路径可执行文件
    pub cwd: String,            // 绝对路径
    pub env: BTreeMap<String, String>,
    pub capabilities: Vec<String>, // 0..=2 个 S-1-5-21-a-b-c-d
}
#[derive(Serialize, Deserialize)] #[serde(tag = "type", rename_all = "kebab-case", deny_unknown_fields)]
pub enum ToRunner { Spawn { id: u64, request: Request, stdin: u64, stdout: u64, stderr: u64 }, Cancel { id: u64 } }
#[derive(Serialize, Deserialize)] #[serde(tag = "type", rename_all = "kebab-case", deny_unknown_fields)]
pub enum FromRunner { Started { id: u64, pid: u32 }, Exit { id: u64, code: u32 }, Error { id: u64, kind: ErrorKind, message: String } }
#[derive(Serialize, Deserialize)] #[serde(tag = "type", rename_all = "kebab-case", deny_unknown_fields)]
pub enum ToBroker { Spawn { request: Request, stdin: u64, stdout: u64, stderr: u64 } }
#[derive(Serialize, Deserialize)] #[serde(tag = "type", rename_all = "kebab-case", deny_unknown_fields)]
pub enum FromBroker { Started { pid: u32 }, Exit { code: u32 }, Error { kind: ErrorKind, message: String } }
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq)] #[serde(rename_all = "kebab-case")]
pub enum ErrorKind { InvalidRequest, LaunchFailed, RunnerLost, NotReady, LeaseConflict }
pub fn validate(request: &Request) -> Result<()>;

// frame.rs
pub const MAX_FRAME: usize = 1 << 20;
pub fn write_frame<W: Write, T: Serialize>(w: &mut W, value: &T) -> io::Result<()>;
pub fn read_frame<R: Read, T: DeserializeOwned>(r: &mut R) -> io::Result<T>; // EOF -> ErrorKind::UnexpectedEof

// token.rs
pub unsafe fn restricted_token(capabilities: &[String]) -> Result<Handle>; // 基于当前进程令牌

// spawn.rs
pub fn command_line(argv: &[String]) -> String;
pub fn environment_block(env: &BTreeMap<String, String>) -> Result<Vec<u16>>;
pub struct Running { pub pid: u32, /* process, job */ }
pub unsafe fn start(token: &Handle, request: &Request, stdio: [HANDLE; 3]) -> Result<Running>;
impl Running { pub fn cancel(&self); pub fn wait(self) -> Result<u32>; /* wait 并排空 Job */ }

// pipe.rs
pub fn server(name: &str, sddl: &str, access: u32) -> Result<Handle>; // FIRST_PIPE_INSTANCE, 1 实例, 阻塞
pub fn accept(pipe: &Handle) -> Result<()>;
pub fn connect(name: &str, access: u32) -> Result<Handle>;
pub fn client_pid(pipe: &Handle) -> Result<u32>;
pub fn server_pid(pipe: &Handle) -> Result<u32>;
pub fn peer_disconnected(pipe: &Handle) -> bool; // PeekNamedPipe -> ERROR_BROKEN_PIPE
pub struct PipeIo(pub HANDLE); // impl Read + Write
```

## 进程与管道

- broker 启动：`yuantu-sandbox broker --dev`。
  1. 生成随机 128 位 hex `n`；创建 `\\.\pipe\yuantu-sbx-<n>-down`（broker→runner，OUTBOUND）与 `-up`（runner→broker，INBOUND），SDDL `D:P(A;;GA;;;<runner 账户 SID>)(A;;GA;;;<当前用户 SID>)`（dev 下两者相同）。
  2. 以 `CREATE_SUSPENDED | CREATE_NO_WINDOW` 用 `CreateProcessW` 启动自身 `runner --control <n>`，放入 broker 持有的 kill-on-close Job，再 Resume。
  3. 两条管道 `accept` 后，`client_pid` 必须等于 runner PID，否则 `TerminateProcess` 并退出 1。
  4. 创建 exec 管道 `\\.\pipe\yuantu-sbx-broker-<n>`（DUPLEX，SDDL `D:P(A;;GA;;;<当前用户 SID>)`，允许 `PIPE_UNLIMITED_INSTANCES`，每接受一个连接后再创建下一个实例；首个实例带 FIRST_PIPE_INSTANCE）。
  5. stdout 打印一行 `{"version":1,"pipe":"\\\\.\\pipe\\yuantu-sbx-broker-<n>"}` 并 flush。
  6. 一个线程阻塞读 stdin，EOF 时 `TerminateJobObject(runner job)` 并退出 0。
- exec 连接的校验：`client_pid` → `OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_DUP_HANDLE)` → 令牌用户 SID == broker 用户 SID 且 `IsTokenRestricted == FALSE`；否则回 `error{invalid-request}` 并断开。
- 句柄交接：对 exec 传来的三个句柄值分别 `DuplicateHandle(exec 进程, h, runner 进程, &out, 0, FALSE, DUPLICATE_SAME_ACCESS)`，把 `out` 放进 `ToRunner::Spawn`。若 runner 回 Error，broker 用 `DuplicateHandle(runner, out, null, null, 0, 0, DUPLICATE_CLOSE_SOURCE)` 回收。
- broker 等待期间每 50 ms `peer_disconnected(exec)`，为真则发 `Cancel{id}`。
- runner：读 `-down` 帧；`Spawn` → 新线程：`restricted_token` → `start` → 回 `Started` → `wait` → 回 `Exit`；关闭收到的三个句柄（已由子进程继承）。`Cancel` → 对应 `Running::cancel`。写 `-up` 由 `Mutex` 串行。`-down` 读到 EOF → `TerminateJobObject` 所有命令并退出。
- runner 启动时把自身进程 DACL 设为 `D:P(A;;GA;;;SY)(A;;GA;;;<broker 传入的桌面用户 SID>)`（`--owner <sid>` 参数）。
- exec：`exec --broker <pipe> --request <file>`；读文件（≤1 MiB）后删除；`validate`；连接；`server_pid` → 打开进程令牌，用户 SID == 自己且镜像路径 == `current_exe()`；发 `ToBroker::Spawn`（句柄值为自己的 `GetStdHandle`）；读 `Started`、`Exit` 后 `exit(code)`。

---

### Task 1: crate 骨架、帧与协议

**Files:**
- Create: `src/bin/yuantu-sandbox/main.rs`、`win.rs`、`frame.rs`、`protocol.rs`
- Modify: `Cargo.toml`（windows-sys 增加 `Win32_System_Pipes`）

- [ ] Step 1：写 `frame.rs` 单测：往返一个 `FromRunner::Exit`；长度 > `MAX_FRAME` 的头读取返回 `InvalidData`；截断的帧返回 `UnexpectedEof`。
- [ ] Step 2：写 `protocol.rs` 单测：未知字段反序列化失败；`validate` 拒绝相对 cwd、空 argv、相对 argv[0]、env 键含 `=` 或为空、键/值含 NUL、能力 SID 不是 `S-1-5-21-\d+-\d+-\d+-\d+`、能力 SID 超过 2 个；接受合法请求。
- [ ] Step 3：`cargo test --manifest-path packages/tools/windows-sandbox/appcontainer/Cargo.toml --bin yuantu-sandbox`，确认失败（未实现）。
- [ ] Step 4：实现 `win.rs`、`frame.rs`、`protocol.rs`，`main.rs` 先只分发 `exec|broker|runner`，其余报 “Expected exec, broker, or runner”。
- [ ] Step 5：测试通过；`cargo build` 现有 bin 不受影响。
- [ ] Step 6：提交 `feat(windows-sandbox): yuantu-sandbox 协议与帧`。

### Task 2: 令牌与进程创建

**Files:**
- Create: `token.rs`、`spawn.rs`
- Test: 同文件内 `#[cfg(test)]`

- [ ] Step 1：单测 `command_line`：沿用 `src/main.rs` 中 `quote` 的用例（尾部反斜杠、内嵌引号）；`environment_block` 按键大小写不敏感排序、以双 NUL 结尾、拒绝含 `=` 的键。
- [ ] Step 2：单测 `restricted_token(&[cap])`：`IsTokenRestricted` 为真；`TokenRestrictedSids` 依次为 cap、当前用户、logon、Everyone；`TokenDefaultDacl` 仅两条 ACE（logon GA、OWNER RIGHTS RC）；`TokenIntegrityLevel` 与当前进程相同。
- [ ] Step 3：单测 `start` + `wait`：在 Job 中跑 `cmd.exe /c exit 7`（stdio 为三个新建匿名管道），返回 7；`cancel` 一个 `ping -n 30 127.0.0.1` 后 `wait` 在 5 秒内返回且 Job 活动进程为 0。
- [ ] Step 4：运行确认失败；实现。令牌部分按 Codex `token.rs` 的顺序与默认 DACL；`start` 复用 `src/main.rs` 中 `run` 的 Job/属性列表写法，把 `CreateProcessW` + AppContainer 属性换成 `CreateProcessAsUserW(token)`，属性列表只有 `HANDLE_LIST` 与 `JOB_LIST`，创建标志 `CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT | EXTENDED_STARTUPINFO_PRESENT | CREATE_NO_WINDOW`，创建后 `IsTokenRestricted(进程令牌)` 必须为真再 Resume。
- [ ] Step 5：测试通过；提交 `feat(windows-sandbox): Codex 受限令牌与 Job 内进程创建`。

### Task 3: 命名管道与身份校验

**Files:** Create `pipe.rs`

- [ ] Step 1：单测：`server` 同名第二次创建失败（FIRST_PIPE_INSTANCE）；`connect` 后 `client_pid` == 当前 PID、`server_pid` == 当前 PID；对端关闭后 `peer_disconnected` 为真；`PipeIo` 读写往返一帧。
- [ ] Step 2：确认失败；实现（`CreateNamedPipeW` + `ConvertStringSecurityDescriptorToSecurityDescriptorW`，`PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS`；`connect` 用 `CreateFileW` + `SECURITY_SQOS_PRESENT | SECURITY_IDENTIFICATION`）。
- [ ] Step 3：测试通过；提交 `feat(windows-sandbox): 命名管道与对端校验`。

### Task 4: runner、broker（--dev）、exec 与端到端测试

**Files:**
- Create: `runner.rs`、`broker.rs`、`exec.rs`
- Create: `tests/sandbox_exec.rs`、`tests/fixtures/fork.cjs`、`tests/fixtures/forks/a.test.cjs`、`tests/fixtures/forks/b.test.cjs`

测试辅助（`tests/sandbox_exec.rs`）：`start_broker()` 启动 `CARGO_BIN_EXE_yuantu-sandbox broker --dev`，读首行 JSON 得管道名，返回 `(Child, pipe)`；`exec(pipe, request) -> Output` 把请求写入临时文件后运行 `exec`。`node` 由 `where node` 定位，找不到则测试打印原因并跳过。

- [ ] Step 1：写端到端测试：
  1. `echo`：`cmd.exe /c echo hello` → stdout `hello`，退出 0。
  2. 退出码：`cmd.exe /c exit 9` → 9。
  3. stdin 直通：exec 的 stdin 写 `ping`，命令 `node -e "process.stdin.pipe(process.stdout)"` → stdout `ping`。
  4. fork：`node fork.cjs`（spawnSync 子 node，stdio pipe）→ `FORK-OK`。
  5. `node --test`（cwd = fixtures/forks）→ 退出 0，输出含 `pass 2`。
  6. 并发：两个 exec 同时跑 `node -e "setTimeout(()=>console.log(process.argv[1]),500)" A/B`，总耗时 < 1.5 s 且各自输出正确。
  7. 取消：exec 跑 `node -e "setInterval(()=>{},1000)"`，`Started` 后 300 ms 杀掉 exec 进程，1 秒内该 node PID 不再存在（`OpenProcess` 失败或已退出）。
  8. broker 退出：关闭 broker stdin，1 秒内 runner 及其命令进程全部退出。
  9. 校验：在受限令牌里运行的命令（`node -e` 用 `net.connect` 连 broker 管道并发送伪造 Spawn）得到连接失败或 `invalid-request`，不会产生新进程。
  10. 坏请求：argv[0] 相对路径 → exec 退出 125，stderr 以启动失败前缀开头。
- [ ] Step 2：运行确认失败；按“进程与管道”一节实现 runner/broker/exec。
- [ ] Step 3：`cargo test --manifest-path packages/tools/windows-sandbox/appcontainer/Cargo.toml` 全部通过；`cargo build --release` 下 `broker --dev` 被拒绝（加一个 release 下的单测或在 Step 1 第 11 项中用 `cfg!(debug_assertions)` 断言）。
- [ ] Step 4：`npm run build:windows-sandbox` 仍成功（不要求打包新二进制，2c 负责）。
- [ ] Step 5：提交 `feat(windows-sandbox): yuantu-sandbox exec/broker/runner 执行链路`。

## 不在 2a 范围

`--account`（`CreateProcessWithLogonW`、DPAPI、私有桌面）、初始化与 WFP（2b）；TS provider、ACL 授权与能力 SID 持久化、打包（2c）；界面（2d）。写隔离只能在真实沙箱账户下验证，放到 2b 验收。
