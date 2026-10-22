# Windows 沙箱加固 4：终端（ConPTY） 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `terminal_open` 在 `windows-account`（Windows 上的 `native`）下得到一个真正的终端：沙箱 shell 在 runner 创建的 ConPTY 里运行，输出、输入与窗口大小经 exec 往返于桌面侧的 node-pty。

**Architecture:** 请求增加可选的 `tty: { columns, rows }`。exec 在 TTY 模式下不再把自己的控制台句柄交给 broker（它们跨控制台/桌面不可用），而是自建两条匿名管道交出去，自己在控制台与管道之间双向转发字节；控制台若是真实控制台，则切到原始 + VT 模式并轮询窗口大小，变化时经 broker 发 `resize`。runner 对 TTY 请求 `CreatePseudoConsole`，以 `PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE` 启动命令，在 ConPTY 管道与 exec 的管道间转发，收到 `resize` 时 `ResizePseudoConsole`。TS 侧 `terminal.ts` 把列/行传给 `prepare`，`sandbox-account.ts` 写入请求。

**Tech Stack:** Rust（`windows-sys` `Win32_System_Console`）、TypeScript、`@lydell/node-pty`。

**Spec:** 设计 §3.3 / §3.5；参照 Codex `conpty/mod.rs`、`elevated/ipc_framed.rs`（`tty`、`Resize`）（`openai/codex@86e17e9`）。

## 现状（实验确认）

`main` 上 `terminal_open` 在 `windows-account` 下启动 `yuantu-sandbox.exe exec --broker …`，node-pty 给 exec 的是外层 ConPTY 的控制台句柄；broker 把它们复制进 runner 后，沙箱命令写出的内容全部丢失。本地 dev broker 实验：同一请求经管道输出 `hello-from-sandbox`，经 node-pty 输出为空、退出码 0。现有 `terminal-real.test.ts` 用 host 模式，未覆盖。

## Global Constraints

- 分支 `windows-sandbox-hardening`；提交前 `cargo test --locked`、`npm run typecheck`、`npm run format:check`、`npm run i18n:check`、`npm run docs:check`、相关 `node scripts/run-tests.mjs`。
- 协议版本仍为 1：`tty` 为可选字段（缺省即现行管道模式），`resize` 为新增消息；未知字段仍拒绝。
- 非 TTY 路径行为完全不变。
- 提交信息中文，末尾 `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`。

---

### Task 1：runner 侧 ConPTY

- [ ] 失败测试（`tests/sandbox_exec.rs`，dev broker，exec 的 stdio 为管道）：带 `tty: {columns: 100, rows: 30}` 的 `powershell -Command "[Console]::IsOutputRedirected"` 输出含 `False`；带 TTY 的 `cmd /c echo hi` 输出含 `hi`；不带 TTY 的同一 PowerShell 命令输出 `True`（回归）。
- [ ] `protocol::Request` 增加 `#[serde(default)] tty: Option<Size>`，`Size { columns: u16, rows: u16 }`，校验 1–1000。
- [ ] `spawn.rs`：TTY 时 `CreatePipe` ×2 + `CreatePseudoConsole`，属性表加 `PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE`，不设 `STARTF_USESTDHANDLES`；两个转发线程（exec stdin → ConPTY 输入、ConPTY 输出 → exec stdout）；进程退出后 `ClosePseudoConsole` 并排空输出。`Running` 持有 `HPCON` 供 resize。
- [ ] 通过并提交 `feat(windows-sandbox): runner 以 ConPTY 运行 TTY 请求`。

### Task 2：resize 与 exec 的控制台转发

- [ ] 协议：`ToBroker::Resize { columns, rows }`（exec → broker，同一连接，Spawn 之后）、`ToRunner::Resize { id, columns, rows }`；broker 按连接对应的 id 转发；runner `ResizePseudoConsole`。
- [ ] exec：TTY 请求时自建两条管道交给 broker；标准输入/输出若为控制台，保存原模式，输入改为去掉 `ENABLE_LINE_INPUT | ENABLE_ECHO_INPUT | ENABLE_PROCESSED_INPUT` 并加 `ENABLE_VIRTUAL_TERMINAL_INPUT`，输出加 `ENABLE_VIRTUAL_TERMINAL_PROCESSING | DISABLE_NEWLINE_AUTO_RETURN`，退出时恢复；每 250ms 读 `GetConsoleScreenBufferInfo` 窗口大小，变化即发 `Resize`。非控制台则只转发字节。
- [ ] 测试：协议往返与校验单测；dev broker 下 TTY 请求发 `Resize` 后 `powershell [Console]::WindowWidth` 反映新宽度。
- [ ] 提交 `feat(windows-sandbox): TTY 请求的窗口大小与 exec 控制台转发`。

### Task 3：TS 接入与端到端

- [ ] `terminal.ts` 把 `columns`/`rows` 传给 `environment.processes.prepare` 的新可选参数 `tty`；`sandbox-account.ts` 写入请求 `tty`；其他后端忽略。
- [ ] `terminal-real.test.ts` 增加（Windows、dev 后端可用时）：经 node-pty 打开沙箱终端，`echo` 的输出可见（复现上面的实验，修复前为空）。
- [ ] 真实账户：`tests/sandbox-account-native.test.ts` 增加离线账户终端输出可见。
- [ ] 文档：设计 §3.3 / §3.5 写明 TTY 数据路径与 resize；交接表更新。
- [ ] 推送、看真实账户 run；全绿后手动触发 `CI jobs=all`。
