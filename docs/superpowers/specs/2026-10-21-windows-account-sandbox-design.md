# Windows 沙箱账户后端（windows-account）设计

日期：2026-10-21
状态：待审阅

## 1. 背景与目标

现有 `windows` 后端从桌面用户自己的令牌派生 `WRITE_RESTRICTED` + Low 完整性令牌（`packages/tools/sandbox-windows.ts`）。沙箱内命令再派生子进程时被拒（`spawn EPERM`），`node --test`、vitest、jest 等会 fork 的测试运行器全部失败；同时读和网络都不受限。

参考 Codex 的 `elevated` 模式，新增 `windows-account` 后端：**专用的低权限本地账户 + 一次性管理员初始化 + 常驻命令执行器**。

成功标准：

1. 在 `windows-account` 下，`npm test`（node --test）、vitest、jest、`git`、`npm install`（联网账户）能正常派生子进程并流式输出。
2. 写：只能写当前工作区和本命令的 scratch 目录；另一个工作区、桌面用户目录不可写；`.git` 等保留路径按现有规则保护。
3. 读：桌面用户目录默认不可读，只有显式白名单（工具链目录等）可读；`.ssh`、`.aws`、`.gnupg`、浏览器配置永不进白名单。
4. 网络：离线账户的任意子程序 IPv4/IPv6 TCP/UDP/回环全部被拒；联网账户不受限。
5. 进程树：取消、超时、agent-host 退出后，没有存活的沙箱进程。
6. 日常使用不弹 UAC；只有初始化（和修复、卸载）需要管理员一次。

非目标：交互式终端（ConPTY）仍走现有路径；AppContainer 原型保持不动；不做 SYSTEM 服务。

## 2. 模式选择

- 新增模式 `windows-account`（加入 `SANDBOX_MODES`），可显式选择。
- `native` 在 Windows 上动态解析：账户后端**就绪**（见 §6.3）→ `windows-account`；否则 → `windows`（受限令牌），并在会话中给出一次性提示“沙箱账户未初始化，当前隔离较弱，子进程可能被拒”，附“初始化”入口。
- 显式选择 `windows-account` 但未就绪：fail closed，拒绝执行并说明原因，不回退。
- `windows` 模式保持现状（如实标注为弱边界），对应 Codex 的 `unelevated`。

## 3. 架构

```
agent-host (桌面用户, Medium)
  ├─ spawn yuantu-sandbox.exe broker --account offline|online      (桌面用户, 常驻, 按需启动)
  │     └─ CreateProcessWithLogonW(YuanTuSandboxOffline|Online, LOGON_WITH_PROFILE)
  │           → yuantu-sandbox.exe runner                          (沙箱账户, Medium, 私有桌面)
  │                 └─ 每条命令: 受限令牌 → CreateProcessAsUserW，在本命令的 Job 内创建
  └─ 每条命令 spawn yuantu-sandbox.exe exec                        (桌面用户, = SandboxPlan.executable)
        └─ 连 broker → 双向校验 → 交出 stdio 句柄 → 等待退出码 → 以同一退出码退出
```

### 3.1 原生二进制

在现有 crate `packages/tools/windows-sandbox/appcontainer` 中新增第二个 bin `yuantu-sandbox`。`maintenance.rs`（固定操作 UAC 入口、安装位置校验）和 `network.rs`（WFP）移到 crate 的 `lib.rs` 供两个 bin 共用。子命令：

| 子命令               | 身份           | 作用                                                           |
| -------------------- | -------------- | -------------------------------------------------------------- |
| `account-preflight`  | 桌面用户       | 校验发布签名与安装位置，不改系统                               |
| `account-setup`      | 桌面用户 → UAC | 生成密码、建立交接管道、以固定操作 `account-initialize` 提权   |
| `account-initialize` | 管理员         | 只接受交接管道传来的密码，执行 §4.1 的固定操作                 |
| `account-status`     | 桌面用户       | 输出账户、凭据、WFP、seclogon、读白名单状态（JSON，version 1） |
| `account-uninstall`  | 桌面用户 → UAC | 删除账户、profile、WFP 规则、读白名单 ACE、凭据                |
| `broker`             | 桌面用户       | 常驻；拉起并管理 runner；服务 exec                             |
| `runner`             | 沙箱账户       | 常驻；按请求创建受限进程                                       |
| `exec`               | 桌面用户       | 每条命令一个；agent-host 的 spawn 目标                         |

### 3.2 broker

- 由 agent-host 在首次需要某账户时 spawn（每个 agent-host 进程、每个账户各一个），stdin 保持连接；stdin 关闭即视为宿主退出。
- 启动顺序：
  1. 创建 runner 控制管道 `\\.\pipe\yuantu-sbx-<随机128位>`，`FILE_FLAG_FIRST_PIPE_INSTANCE`，`nMaxInstances=1`，DACL 只允许该沙箱账户 SID 连接、只允许桌面用户创建实例。
  2. 从 DPAPI（CurrentUser）解密该账户密码，`CreateProcessWithLogonW(LOGON_WITH_PROFILE)` 拉起 `runner --control <管道名>`，`lpDesktop` 指向私有桌面（见 §3.3），拿到 runner 进程完整句柄后立即清零内存中的密码。
  3. 接受连接后校验：`GetNamedPipeClientProcessId` 等于 runner PID，`ImpersonateNamedPipeClient` 得到的用户 SID 等于该沙箱账户 SID，且令牌不是受限令牌。任一不符则杀掉 runner、报错退出。
  4. 创建 exec 服务管道 `\\.\pipe\yuantu-sbx-broker-<桌面用户SID哈希>-<agent-host PID>-<account>`，`FIRST_PIPE_INSTANCE`，DACL 只允许桌面用户 SID。管道名通过 stdout 一行 JSON 报告给 agent-host，agent-host 再经 SandboxPlan 参数传给 exec。
- 校验 exec：客户端令牌用户 SID == 桌面用户 SID，非受限令牌、完整性 ≥ Medium（沙箱子进程是沙箱账户且是受限令牌，连不上也冒充不了）。
- 句柄交接：broker `OpenProcess(PROCESS_DUP_HANDLE)` 打开 exec（同用户），把 exec 报告的三个 std 句柄复制进 broker，再用 runner 的进程句柄复制进 runner，把 runner 端句柄值随请求一起发给 runner。
- runner 退出（崩溃）时：所有进行中的 exec 收到 `runner-lost` 错误，broker 随后以退出码 3 退出；宿主（2c 的 broker 管理）在下一条命令时重新启动 broker 与 runner。
- 宿主退出（stdin EOF）：`TerminateProcess(runner)`，runner 的 Job（kill-on-close）带走全部后代。

### 3.3 runner

- 启动后把自身进程对象 DACL 设为只允许 SYSTEM 和桌面用户（经 broker 传入的 SID），使沙箱子进程无法打开 runner 读内存或注入。
- 私有桌面：broker 创建 `CreateDesktopW("yuantu-sbx-<account>")`，DACL 授予该账户 logon SID；runner 和子进程都在其中，看不到也操作不了用户桌面窗口。
- 每条命令：
  1. 以 runner 自身令牌 `CreateRestrictedToken(DISABLE_MAX_PRIVILEGE | LUA_TOKEN | WRITE_RESTRICTED)`，**不降 Low 完整性级别**。限制 SID（顺序同 Codex `token.rs`）= {工作区能力 SID（仅读写模式）, 本命令 scratch 能力 SID, **令牌用户 SID（沙箱账户）**, logon SID, Everyone}。默认 DACL 替换为 `D:(A;;GA;;;<logon SID>)(A;;RC;;;OW)`（Codex 做法：同一账户的不同 runner/命令之间互不能打开对方的进程、线程与 IPC），并启用 `SeChangeNotifyPrivilege`。
  2. `CreateJobObjectW`（kill-on-close、禁止 breakaway），通过 `PROC_THREAD_ATTRIBUTE_JOB_LIST` 在 Job 内创建；`PROC_THREAD_ATTRIBUTE_HANDLE_LIST` 只继承三个 std 句柄。
  3. `CreateProcessAsUserW`（受限的自身令牌无需特权）。
  4. 子进程退出后终止 Job 内剩余后代，等活动进程数归零，再把退出码回复给 broker。
- 取消：broker 转发 `cancel{id}` → runner `TerminateJobObject`。

> **Spike 结论（2026-10-21，见 `docs/superpowers/plans/2026-10-21-windows-account-sandbox-phase1-spike.md`）**：`spawn EPERM` 的根因是 libuv 为子进程 stdio 创建命名管道时请求 `WRITE_DAC`，该所有者隐式权限在 `WRITE_RESTRICTED` 下也要过限制 SID 检查，而所有者（令牌用户 SID）不在限制列表中。把令牌用户 SID 加入限制列表后，fork、`stdio: 'pipe'`、`node --test` 全部正常。这在桌面用户令牌上等于取消写隔离，但在专用沙箱账户上是安全的——前提是**任何 ACE 都不直接授予沙箱账户 SID**（账户自己的 profile 除外），见 §5.1。
>
> 写隔离模型（同 Codex）：
>
> - 常规访问检查：沙箱账户都属于本地组 `YuanTuSandboxUsers`，工作区写 ACE 授予该组。
> - 限制 SID 检查：每个工作区一个能力 SID（`S-1-5-21-<4 个随机 u32>`，按规范化工作区路径持久化在 `.yuantu/sandbox-state/windows-account/cap-sids.json`），工作区再授予该能力 SID 写 ACE。
> - 工作区 A 的令牌只含 A 的能力 SID；工作区 B 的 ACE 只有组和 B 的能力 SID → A 写不了 B。**多个工作区可以并发**，无需租约或 ACL 切换；工作区授权在多条命令间保留，按现有日志机制在会话/工作区释放时恢复。
> - 只读模式：令牌不含工作区能力 SID，因此工作区不可写。

### 3.4 exec

- 参数：`exec --broker <管道名> --request <私有请求文件>`。请求文件位于命令的宿主私有控制目录（沿用现有 AppContainer 后端的做法），内容为 JSON：`{version:1, argv[], cwd, env{}, workspaceRoot, scratch, files:'read-write'|'read-only', timeoutMs?}`，上限 1 MiB，读后删除。
- 连接 broker 后校验服务端：`GetNamedPipeServerProcessId` → 打开进程令牌，用户 SID 必须等于自己的 SID，且镜像路径等于已安装的 `yuantu-sandbox.exe`。
- 发送请求 + 自己的 PID + 三个 std 句柄值；等待 `{started, pid}`、`{exit, code}` 或 `{error, kind, message}`。
- 以子进程退出码退出；broker 断开或出错时向 stderr 打印 `SANDBOX_LAUNCH_FAILED_PREFIX` 前缀的一行（复用 `sandbox-launch-failure.ts` 的识别）并以 `125` 退出。
- exec 被杀（宿主取消/超时）→ broker 检测到 exec 连接断开 → 转发 `cancel`。
- exec 自身放在 agent-host 已有的进程树控制中；`SandboxPlan.processTree = 'contained'`（真正的后代在 runner 的 Job 里，由取消链路保证）。

### 3.5 IPC 协议

- 帧：4 字节小端长度 + UTF-8 JSON，单帧上限 1 MiB，未知字段拒绝（serde `deny_unknown_fields`），带 `version: 1`。
- exec ↔ broker：`spawn{request, execPid, stdin, stdout, stderr}` → `started{pid}` | `exit{code}` | `error{kind, message}`。
- broker ↔ runner：`spawn{id, request, stdin, stdout, stderr}`（句柄已是 runner 端值）、`cancel{id}` → `started{id, pid}`、`exit{id, code}`、`error{id, kind, message}`。
- `error.kind` 取值固定：`invalid-request`、`launch-failed`、`runner-lost`、`not-ready`、`lease-conflict`，消息不包含环境变量或密码。

## 4. 初始化

### 4.1 管理员固定操作（`account-initialize`）

只接受交接管道传入的两个密码，不接受路径、命令或 SID 参数。全部操作写入事务日志（`HKLM` 下受保护的位置或 Program Files 安装目录旁的 SYSTEM 日志文件），失败时回滚本次创建的对象。

1. 创建或重设本地账户 `YuanTuSandboxOffline`、`YuanTuSandboxOnline`：随机 32 字节密码、密码永不过期、用户不能改密码；属于 `Users` 组和新建的本地组 `YuanTuSandboxUsers`（不存在则创建；组内只允许这两个账户）。
2. 登录权限：授予本地交互登录所需的权限（`CreateProcessWithLogonW` 使用交互登录类型）；`SeDenyRemoteInteractiveLogonRight`、`SeDenyNetworkLogonRight` 拒绝；在 `HKLM\...\Winlogon\SpecialAccounts\UserList` 中隐藏，不出现在登录界面。
3. WFP：复用 `network.rs` 的 provider/sublayer/事务与安全描述符校验；过滤条件从 AppContainer 包 SID 改为 `FWPM_CONDITION_ALE_USER_ID`（离线账户 SID），覆盖 IPv4/IPv6 的 ALE connect、recv/accept、resource assignment（listen），包括回环。联网账户不加过滤。
4. Secondary Logon（seclogon）服务：若被禁用则设为手动启动。
5. 返回两个账户 SID，供非提权部分写入状态文件。

### 4.2 非提权部分（`account-setup` 外层）

1. 生成两个密码，创建交接管道（`FIRST_PIPE_INSTANCE`，DACL：当前用户 + Administrators），`ShellExecuteExW(runas)` 以 `account-initialize --handoff <管道名>` 提权，管道发送密码，明文从不落盘、不进命令行。
2. 用 DPAPI（CurrentUser，附加熵为固定常量 + 账户 SID）加密密码，写入 `<账户派生 profile>/.yuantu/sandbox-state/windows-account/credentials.bin`，ACL 只允许桌面用户与 SYSTEM，禁用继承。路径沿用现有 README 所述的账户派生 profile 位置（不受 TEMP/USERPROFILE 覆盖与 MSIX 虚拟化影响）。
3. 读白名单（§5.2）授予并写日志。

### 4.3 桌面端

- `apps/desktop/sandbox-setup.ts` 增加账户后端的 status/initialize/uninstall（结构同现有 `WindowsSandboxSetup`），渲染层在沙箱设置面板显示：未初始化 / 就绪 / 损坏（附原因）/ 需要修复。
- 初始化按钮触发一次 UAC；没有超时（同现有约束：杀掉 UAC 父进程无法取消提权子进程）。

## 5. 文件访问

### 5.1 写

- **常驻授权（同 Codex，2c 修订）**：工作区首次使用时，由原生 `yuantu-sandbox grant` 给根目录加两条可继承 ACE：`YuanTuSandboxUsers` 组（Modify）、该工作区能力 SID（Modify），保留到卸载或 `ungrant`，记录在 `grants.json`。不做逐命令/逐会话的日志化恢复：只有持有该工作区能力 SID 的受限令牌（仅 runner 会造）能通过第二次访问检查，常驻 ACE 对其他进程无效。也因此不与旧后端共用 `acl.ps1` 的租约与日志。离线与联网账户同属该组，共用同一份授权。
- **不变量：除沙箱账户自己的 profile 外，任何路径都不出现直接授予沙箱账户 SID 的 ACE。** `account-status` 检查工作区与读白名单中没有违反该不变量的 ACE。
- scratch：runner 在沙箱账户自己的 `%TEMP%` 下按命令创建、命令结束删除；该目录属于沙箱账户自己的 profile，无需能力 SID。
- 保留路径（`.git`、`.yuantu`、`.agents`、`.codex`、`.aws`、`.ssh`、`.gnupg`）中已存在者，对 `YuanTuSandboxUsers` 组加显式拒绝写入 ACE。
- 已知弱点（同 Codex）：限制列表含 Everyone，所以“Everyone 可写”的目录仍然可写。初始化与 `account-status` 扫描工作区祖先、读白名单、`PATH` 目录中 Everyone 可写的位置并给出警告（对应 Codex `audit_everyone_writable`）。

### 5.2 读白名单

- 默认条目：工作区（随租约授予）；桌面用户 `PATH` 中位于用户目录下的目录（如 `%APPDATA%\npm`、`%LOCALAPPDATA%\Programs\...`、nvm 当前版本目录）；`%USERPROFILE%\.gitconfig`（只读文件）。
- 用户可在设置中追加路径；拒绝列表永远优先：`.ssh`、`.aws`、`.gnupg`、`.azure`、`.kube`、`.docker`、浏览器 profile 目录、`AppData\Roaming\Microsoft\Credentials`、`AppData\Local\Microsoft\Credentials`、DPAPI 目录、本产品的凭据目录。
- 授予方式（2d 安全审查修订）：验证并锁定整棵现有对象树，为每个对象增加不可继承的组 RX ACE，形成读取快照；新增工具文件需要重新授权。不能给可变目录持续继承 RX，否则后来新建的 `.ssh` 等敏感目录会自动变为可读，与“拒绝列表永远优先”冲突。日志在修改前保存原 DACL、卷序列号、文件 ID 和创建时间；卸载或移除时按对象身份撤销，包含同卷移出和重命名对象，保留其他主体的权限。无法核实原对象或权限冲突时保留记录并报错。授予拒绝 reparse point、硬链接，单次上限沿用 100,000 对象；撤销只处理已记录身份，不跟随后来新增的危险对象。
- 包缓存：沙箱账户使用自己 profile 下的缓存（npm/pnpm/pip/cargo 默认路径即落在沙箱账户 profile），环境变量中不传递指向桌面用户目录的缓存变量（`toolEnvironment` 增加过滤）。
- 位于桌面 profile 下的工作区/工具链，其祖先目录仅增加不可继承的 `FILE_TRAVERSE | FILE_READ_ATTRIBUTES`，使 Node 的 realpath/lstat 能解析完整路径；不授予列目录或读取文件内容。`traverse-grants.json` 独立记录这些授权及对象身份，卸载在撤销工作区/读取授权之后收回。

## 6. TS 侧接入

### 6.1 新文件

- `packages/tools/sandbox-account.ts`：`windowsAccountSandboxProvider`（实现 `SandboxProvider`）。`prepare` 获得工作区租约与 ACL 授权、生成 scratch 与请求文件、确保 broker 已启动，返回 `SandboxPlan{executable: yuantu-sandbox.exe, args:['exec','--broker',name,'--request',file], processTree:'contained', backend:'windows-account', cleanupPath}`。
- `packages/tools/sandbox-account-broker.ts`：broker 进程管理（每账户一个、按需启动、退出时随 agent-host 结束、崩溃后下次请求重启、并发请求共享一次启动）。
- `packages/tools/sandbox-account-status.ts`：解析 `account-status` 输出，计算“就绪”。

### 6.2 修改

- `sandbox-mode.ts`：加入 `windows-account`；`nativeSandboxBackend` 在 Windows 上返回由就绪状态决定的后端（结果按进程缓存，初始化/卸载后失效）。
- `sandbox.ts`：注册新 provider。
- 网络选择：请求 `network: deny`（或默认离线）→ 离线账户；允许网络 → 联网账户。
- `sandbox-launch-failure.ts` 的 `SANDBOX_CHILD_SPAWN_NOTE`：`windows` 后端出现 EPERM 时，提示改为“初始化沙箱账户”而非只建议完全访问。
- `README.md`（windows-sandbox 目录）与 `ENHANCED-DESIGN.md`：更新为当前实现与边界。

### 6.3 就绪判定

`account-status` 全部满足才算就绪：发布签名与安装位置校验通过；两账户存在且 SID 与状态文件一致；凭据文件可解密且能完成一次 logon（status 中做一次 `LogonUserW` 交互验证后立即关闭令牌）；WFP 过滤器与安装 schema 一致；seclogon 未禁用。另外 provider 首次使用时执行一次运行时探针（runner 内 `spawnSync` 子进程读写 stdio，复用 `APPCONTAINER_CHILD_STDIO_PROBE` 的形式；离线账户再做一次连接被拒探针），结果缓存到进程结束。

## 7. 错误处理

| 情况                                        | 行为                                                                   |
| ------------------------------------------- | ---------------------------------------------------------------------- |
| 未初始化 / 损坏，模式为 `native`            | 回退 `windows`，会话提示一次，附初始化入口                             |
| 未初始化 / 损坏，模式为 `windows-account`   | 拒绝执行，说明缺少哪一项                                               |
| 凭据解密失败或 logon 失败（密码被外部改动） | 标记“需要修复”，提示重新初始化（会重设密码）                           |
| runner 启动失败（seclogon 停止等）          | exec 输出 launch-failed 前缀行，退出 125；验收归为 `environment-error` |
| runner 崩溃                                 | 进行中命令 `runner-lost`；下次请求重启 runner                          |
| 工作区租约冲突                              | 沿用现有提示（另一个 Host 持有租约等），在审批前检查                   |
| ACL 恢复冲突                                | 沿用现有日志保留与 `sandbox-recover`                                   |
| 管道校验失败（疑似冒充）                    | 拒绝，杀掉 runner，错误信息不含细节以外的数据                          |

## 8. 实施顺序与测试

1. **Spike（门槛）**：一个临时 Rust 测试程序，在手动创建的测试账户下用 `CreateProcessWithLogonW` 拉起，再按 §3.3 生成令牌启动 `node --test`（会 fork 的 fixture）与 vitest。记录结论，决定用主方案还是退路方案。spike 代码不保留。
2. 协议与 exec/broker/runner 骨架 + Rust 单元测试（帧编解码、未知字段拒绝、校验逻辑的纯函数部分）。
3. 初始化/卸载/状态 + WFP 用户 SID 过滤 + Rust 单元测试（无系统修改的部分）。
4. TS provider、broker 管理、模式解析 + `tests/` 下单元测试（mock `execute` / broker 进程，同现有 `sandbox-windows.test.ts`、`windows-sandbox-setup.test.ts` 风格）。
5. 原生集成测试（仅在已初始化的 Windows 机器上运行，未就绪时跳过并说明）：`tests/sandbox-account-native.test.ts` 覆盖
   - `node --test` fork、vitest fork、stdin/stdout/stderr 流式；
   - 工作区可写，另一工作区、桌面用户目录、保留路径不可写；
   - 用户目录不可读、白名单可读、拒绝列表不可读；
   - 离线账户 IPv4/IPv6 TCP/UDP/回环被拒，联网账户可连；
   - 取消、超时、杀 agent-host 后无存活进程；
   - runner 崩溃后自动恢复。
6. 桌面端初始化 UI 与 smoke 测试。
7. 文档更新。

管理员初始化本身需要在用户确认后、最好在可丢弃的 VM 中执行；自动化测试不执行提权操作。
