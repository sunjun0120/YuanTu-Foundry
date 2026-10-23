# Windows 沙箱账户后端（windows-account）设计

日期：2026-10-21（2026-10-22 按 Codex elevated 沙箱调整签名、初始化与就绪判定）
状态：已实现，真实账户验收见交接文档

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

非目标：交互式终端（ConPTY）仍走现有路径；不做 SYSTEM 服务。AppContainer 原型已于 2026-10-22 删除（与 Codex 一致，不用 AppContainer：开发工具链兼容性差，且账户后端已覆盖其隔离目标）。

## 2. 模式选择

- 新增模式 `windows-account`（加入 `SANDBOX_MODES`），可显式选择。
- `native` 在 Windows 上**始终**解析为 `windows-account`。未就绪时拒绝执行，错误说明缺少初始化或标记版本过旧，并提示去设置页初始化/修复；不会自动切到 `windows`。
- 如果管理员初始化无法完成（UAC 被拒、策略不允许建本地账户或改防火墙等），隔离命令停止执行并提示修复初始化。应用不再引导用户选择旧的 `windows` 后端；已有应用启动环境和桌面设置请求中的 `windows` 迁到 `native`。
- 显式选择 `windows-account` 但未就绪时行为相同：fail closed，不回退。
- 底层 `windows` provider 保留用于显式兼容性检查（如实标注为弱边界），对应 Codex 的 `unelevated`；应用默认值和主流程 CI 不再选择它。

## 3. 架构

```
agent-host (桌面用户, Medium)
  ├─ spawn yuantu-sandbox.exe broker --account offline|online      (桌面用户, 常驻, 按需启动)
  │     └─ CreateProcessWithLogonW(YuanTuSandboxOffline|Online, LOGON_WITH_PROFILE)
  │           → yuantu-sandbox.exe runner                          (沙箱账户, Medium；命令在私有桌面上)
  │                 └─ 每条命令: 受限令牌 → CreateProcessAsUserW，在本命令的 Job 内创建
  └─ 每条命令 spawn yuantu-sandbox.exe exec                        (桌面用户, = SandboxPlan.executable)
        └─ 连 broker → 双向校验 → 交出 stdio 句柄 → 等待退出码 → 以同一退出码退出
```

### 3.1 原生二进制

crate `packages/tools/windows-sandbox/native`（原 `appcontainer`，删除 AppContainer 启动器后改名）只产出 bin `yuantu-sandbox`。`wfp.rs`（WFP 引擎、事务与安全描述符校验）和 `account/`（账户、凭据、过滤、授权、就绪判定）在 crate 的 `lib.rs` 中。子命令：

| 子命令                    | 身份             | 作用                                                                   |
| ------------------------- | ---------------- | ---------------------------------------------------------------------- |
| `account-setup`           | 桌面用户         | 生成密码；已提权则同进程建户，否则 UAC 调 `account-initialize`         |
| `account-initialize`      | 管理员（仅交接） | 只接受交接管道传来的密码，执行 §4.1 的固定操作                         |
| `account-status`          | 桌面用户         | 读初始化标记与 DPAPI 凭据（JSON，version 1）                           |
| `account-status --verify` | 桌面用户         | 实时检查账户、凭据、WFP、seclogon、读根目录，供诊断和日志              |
| `account-uninstall`       | 桌面用户         | 持锁后删标记、撤用户授权、删除账户并清理凭据；未提权时通过交接管道协调 |
| `account-remove`          | 管理员（仅 UAC） | 删除账户、profile、WFP 规则                                            |
| `read-refresh --env FILE` | 桌面用户         | 按 FILE 里的环境自动授权工具链根目录（§5.2）；不提权                   |
| `broker`                  | 桌面用户         | 常驻；拉起并管理 runner；服务 exec                                     |
| `runner`                  | 沙箱账户         | 常驻；按请求创建受限进程                                               |
| `exec`                    | 桌面用户         | 每条命令一个；agent-host 的 spawn 目标                                 |

### 3.2 broker

- 由 agent-host 在首次需要某账户时 spawn（每个 agent-host 进程、每个账户各一个），stdin 保持连接；stdin 关闭即视为宿主退出。
- 启动顺序：
  1. 创建 runner 控制管道 `\\.\pipe\yuantu-sbx-<随机128位>`，`FILE_FLAG_FIRST_PIPE_INSTANCE`，`nMaxInstances=1`，DACL 只允许该沙箱账户 SID 连接、只允许桌面用户创建实例。
  2. 从 DPAPI（CurrentUser）解密该账户密码，`CreateProcessWithLogonW(LOGON_WITH_PROFILE)` 拉起 `runner --control <管道名>`，`lpDesktop` 为空（runner 自身留在当前桌面；命令所在的私有桌面见 §3.3），拿到 runner 进程完整句柄后立即清零内存中的密码。
  3. 接受连接后校验：`GetNamedPipeClientProcessId` 等于 runner PID，`ImpersonateNamedPipeClient` 得到的用户 SID 等于该沙箱账户 SID，且令牌不是受限令牌。任一不符则杀掉 runner、报错退出。
  4. 创建 exec 服务管道 `\\.\pipe\yuantu-sbx-broker-<桌面用户SID哈希>-<agent-host PID>-<account>`，`FIRST_PIPE_INSTANCE`，DACL 只允许桌面用户 SID。管道名通过 stdout 一行 JSON 报告给 agent-host，agent-host 再经 SandboxPlan 参数传给 exec。
- 校验 exec：客户端令牌用户 SID == 桌面用户 SID，非受限令牌、完整性 ≥ Medium（沙箱子进程是沙箱账户且是受限令牌，连不上也冒充不了）。
- 句柄交接：broker `OpenProcess(PROCESS_DUP_HANDLE)` 打开 exec（同用户），把 exec 报告的三个 std 句柄复制进 broker，再用 runner 的进程句柄复制进 runner，把 runner 端句柄值随请求一起发给 runner。
- runner 退出（崩溃）时：所有进行中的 exec 收到 `runner-lost` 错误，broker 随后以退出码 3 退出；宿主（2c 的 broker 管理）在下一条命令时重新启动 broker 与 runner。
- 宿主退出（stdin EOF）：`TerminateProcess(runner)`，runner 的 Job（kill-on-close）带走全部后代。

### 3.3 runner

- 启动后把自身进程对象 DACL 设为只允许 SYSTEM 和桌面用户（经 broker 传入的 SID），使沙箱子进程无法打开 runner 读内存或注入。
- **私有桌面**：`CreateProcessWithLogonW` 启动的 runner 与调用者共享 logon SID，命令的受限令牌把它列为限制 SID，而用户桌面（`Default`）授予的正是这个 logon SID；在同一桌面上，沙箱命令可以枚举窗口、发消息、装钩子、合成输入（包括审批界面）。因此 broker 启动时 `CreateDesktopW` 创建 `YuanTuSandboxDesktop-<32 位十六进制>`，DACL 只给桌面用户的**用户 SID**完全访问（不用 logon SID，它与沙箱共享），给沙箱账户（`--dev` 时为当前用户）去掉 `WRITE_DAC`/`WRITE_OWNER`/`DELETE` 的参与访问；broker 持有句柄到退出。runner 参数 `--desktop NAME`，启动时 `OpenDesktopW` 校验存在（不回退 `Default`），每条命令 `lpDesktop = Winsta0\NAME`。runner 自身留在 `Default`：显式指定桌面时 `CreateProcessWithLogonW` 不再代为授予窗口站权限。参照 Codex `desktop.rs`。
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

- 参数：`exec --broker <管道名> --request <私有请求文件>`。请求文件位于命令的宿主私有控制目录，内容为 JSON：`{version:1, argv[], cwd, env{}, workspaceRoot, scratch, files:'read-write'|'read-only', timeoutMs?}`，上限 1 MiB，读后删除。
- 连接 broker 后校验服务端：`GetNamedPipeServerProcessId` → 打开进程令牌，用户 SID 必须等于自己的 SID，且镜像路径等于已安装的 `yuantu-sandbox.exe`。
- 发送请求 + 自己的 PID + 三个 std 句柄值；等待 `{started, pid}`、`{exit, code}` 或 `{error, kind, message}`。
- 以子进程退出码退出；broker 断开或出错时向 stderr 打印 `SANDBOX_LAUNCH_FAILED_PREFIX` 前缀的一行（复用 `sandbox-launch-failure.ts` 的识别）并以 `125` 退出。
- exec 被杀（宿主取消/超时）→ broker 检测到 exec 连接断开 → 转发 `cancel`。
- exec 自身放在 agent-host 已有的进程树控制中；`SandboxPlan.processTree = 'contained'`（真正的后代在 runner 的 Job 里，由取消链路保证）。
- **终端（TTY）**：`terminal_open` 把 exec 放进 node-pty 的伪终端，请求带 `tty{columns, rows}`。exec 的控制台句柄不能交给 runner（命令在另一个控制台和桌面上，写入会全部丢失），所以 exec 若在控制台上，就自建两条管道交给 broker，把控制台切到原始 VT 输入/输出与 UTF-8，在控制台与管道间双向转发，以实际窗口大小为初始尺寸，并每 50ms 轮询窗口大小、变化时发 `resize`。runner 对 TTY 请求 `CreatePseudoConsole`，以 `PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE` 启动命令（标准句柄置无效、不继承句柄、不加 `CREATE_NO_WINDOW`），在 ConPTY 与 exec 的管道间转发；命令结束后 `ClosePseudoConsole` 并等输出排空再报告退出。ConPTY 的输入管道保持到控制台关闭：conhost 把输入管道断开当作关闭控制台，会以 `STATUS_CONTROL_C_EXIT` 结束命令。参照 Codex `conpty/mod.rs`。

### 3.5 IPC 协议

- 帧：4 字节小端长度 + UTF-8 JSON，单帧上限 1 MiB，未知字段拒绝（serde `deny_unknown_fields`），带 `version: 1`。
- exec ↔ broker：`spawn{request, execPid, stdin, stdout, stderr}`，之后可有任意个 `resize{size}` → `started{pid}` | `exit{code}` | `error{kind, message}`。TTY 时双方都用 `PeekNamedPipe` 轮询：同步管道上一个阻塞的读会挡住同一句柄上的写。
- broker ↔ runner：`spawn{id, request, stdin, stdout, stderr}`（句柄已是 runner 端值）、`cancel{id}`、`resize{id, size}` → `started{id, pid}`、`exit{id, code}`、`error{id, kind, message}`。
- `request.tty` 可选，缺省即管道模式；`size` 的列和行都在 1–1000。
- `error.kind` 取值固定：`invalid-request`、`launch-failed`、`runner-lost`、`not-ready`、`lease-conflict`，消息不包含环境变量或密码。

## 4. 初始化

### 4.1 管理员固定操作（`account-initialize` / 同进程提权路径）

只接受交接管道传入的两个密码（或已提权时由 `account-setup` 直接生成），不接受路径、命令或 SID 参数。

1. 创建或重设本地账户 `YuanTuSandboxOffline`、`YuanTuSandboxOnline`：随机 32 字节密码、密码永不过期、用户不能改密码；属于 `Users` 组和新建的本地组 `YuanTuSandboxUsers`（不存在则创建；组内只允许这两个账户）。
2. 登录权限：授予本地交互登录所需的权限（`CreateProcessWithLogonW` 使用交互登录类型）；`SeDenyRemoteInteractiveLogonRight`、`SeDenyNetworkLogonRight` 拒绝；在 `HKLM\...\Winlogon\SpecialAccounts\UserList` 中隐藏，不出现在登录界面。
3. WFP：用 `wfp.rs` 的 provider/sublayer/事务与安全描述符校验；过滤条件为 `FWPM_CONDITION_ALE_USER_ID`（离线账户 SID），覆盖 IPv4/IPv6 的 ALE connect、recv/accept、resource assignment（listen），包括回环。联网账户不加过滤。
4. Secondary Logon（seclogon）服务：若被禁用则设为手动启动。
5. 返回两个账户 SID，供非提权部分写入凭据和初始化标记。

初始化与卸载都在机器级互斥锁 `Global\YuanTuSandboxSetup`（只允许 SYSTEM 与管理员打开，等待 30 秒）内执行。锁覆盖账户、组、WFP 以及桌面用户的标记、授权和凭据收尾；UAC 路径由提权进程持锁等待用户进程确认完成，见 §4.2。持有者崩溃视为释放。

卸载的提权部分按以下顺序，任何一步之前都不移除保护：

1. 禁用存在的沙箱账户（`UF_ACCOUNTDISABLE`），阻止新的登录；
2. 结束这两个账户的全部进程（快照后从进程令牌复核 SID，防 PID 复用），上限 10 秒；进程清空后给登录会话 3 秒宽限。仍存在的会话只记警告、不阻止卸载：我们没有任何组件在无进程时持有沙箱令牌（broker 只持有密码），这样的会话由系统服务（seclogon、卸载 `LOGON_WITH_PROFILE` 加载的配置文件的用户配置文件服务）持有，不运行代码，且账户已禁用、无法再登录。真实账户 run `39749426970` 观察到会话在所有进程结束后仍长时间存在。这一点有意不同于 Codex（它把残留会话视为阻塞）；
3. 删除离线账户的 WFP 过滤；
4. 删除账户、登录权限、隐藏项与组。

第 1–2 步失败时恢复账户原标志并返回错误，WFP 与账户保持原样。初始化遇到已存在但被禁用的账户（中断的卸载）会重新启用。参照 Codex `setup_mutex.rs`、`uninstall_windows/processes.rs`（不含它为 SYSTEM 清理服务保留的登录，残留会话处理见第 2 步）。

### 4.2 用户入口（`account-setup` / `account-uninstall`）

1. 生成两个密码。当前进程**已经提权**时，在修改标记前获取机器级初始化锁，持锁执行 §4.1 和 §4.2 的完整收尾；否则创建交接管道（`FIRST_PIPE_INSTANCE`，DACL：当前用户 + Administrators），用 `ShellExecuteExW(runas)` 以固定参数 `account-initialize --handoff <管道名>` 提权。提权进程获取同一把锁后发送 `locked`，桌面用户删除旧标记并回传 `proceed`，提权进程建户后发送 `applied`，桌面用户完成预建 profile、CurrentUser DPAPI 凭据保存、读取授权和就绪标记提交，再发送 `finished`。提权进程确认收到（`completed`）后才退出并释放锁；桌面用户收到确认后再关闭管道、等待其退出。密码只经管道传输，从不落盘、不进命令行；用户目录操作仍在桌面用户进程中完成。失败或管道断连会释放锁，失败不会被报告为成功。
2. 预建配置文件：用新密码以 `CreateProcessWithLogonW(LOGON_WITH_PROFILE)` 为每个账户运行一次 `cmd /c exit 0`（最多等 120 秒），让 Windows 现在就建好配置文件和注册表 hive。首次带配置文件的登录在繁忙机器上可能超过 Host 启动 broker 的 20 秒时限（真实账户验收中出现过首条离线命令超时）；失败只打印警告，不影响初始化。
3. 用 DPAPI（CurrentUser，附加熵为固定常量 + 账户 SID）加密密码，写入 `<账户派生 profile>/.yuantu/sandbox-state/windows-account/credentials.json`，ACL 只允许桌面用户与 SYSTEM，禁用继承。
4. 读根目录（§5.2）：初始化收尾时用当前进程环境执行一次 `read-refresh`；单个根失败只记 `skipped` 与警告，不让初始化失败。
5. 全部成功之后，原子写入 `setup_marker.json`（`SETUP_VERSION = 1`，含两个账户 SID、组 SID、离线过滤配置）。重新初始化获得锁后才删除旧标记；等待锁超时或 UAC 被取消时不修改已有状态。
6. 卸载使用相同的持锁范围：获取锁后，桌面用户先删除标记并撤销用户授权，再执行管理员账户删除，最后由桌面用户删除凭据。未提权时固定调用 `account-remove --handoff <管道名>`，沿用 `locked → proceed → applied → finished → completed` 交接，避免用户目录清理在锁外与另一轮初始化交错；已提权时同进程持锁完成所有步骤。

### 4.3 桌面端

- `apps/desktop/sandbox-setup.ts` 提供账户后端的 status/verify/initialize/uninstall，以及读根目录的添加与移除；渲染层只显示三类状态：未初始化（一句说明 + 初始化按钮）、就绪（一行状态 + 卸载文字按钮，其下默认折叠的「高级：沙箱可读目录」，自动项只读、用户项逐项可移除、「添加目录…」）、损坏（问题列表 + 修复按钮，进入该状态时自动取一次 `--verify` 的诊断详情）。「添加目录…」由主进程弹系统目录选择框，取消则原样返回视图、不调用 helper。
- 开发版和正式版走同一流程：初始化/修复按钮触发一次 UAC；已经提权时直接执行，不再弹 UAC。没有超时（杀掉 UAC 父进程无法取消提权子进程）。
- 卸载后 `native` 会拒绝执行，直到重新初始化。

## 5. 文件访问

### 5.1 写

- **常驻授权（同 Codex，2c 修订）**：工作区首次使用时，由原生 `yuantu-sandbox grant` 给根目录加两条可继承 ACE：`YuanTuSandboxUsers` 组（Modify）、该工作区能力 SID（Modify），保留到卸载或 `ungrant`，记录在 `grants.json`。不做逐命令/逐会话的日志化恢复：只有持有该工作区能力 SID 的受限令牌（仅 runner 会造）能通过第二次访问检查，常驻 ACE 对其他进程无效。也因此不与旧后端共用 `acl.ps1` 的租约与日志。离线与联网账户同属该组，共用同一份授权。
- **不变量：除沙箱账户自己的 profile 外，任何路径都不出现直接授予沙箱账户 SID 的 ACE。** `account-status --verify` 检查工作区与读白名单中没有违反该不变量的 ACE。
- scratch：runner 在沙箱账户自己的 `%TEMP%` 下按命令创建、命令结束删除；该目录属于沙箱账户自己的 profile，无需能力 SID。
- 保留路径（`.git`、`.yuantu`、`.agents`、`.codex`、`.aws`、`.ssh`、`.gnupg`）中已存在者，对 `YuanTuSandboxUsers` 组加显式拒绝写入 ACE。
- 已知弱点（同 Codex）：限制列表含 Everyone，所以“Everyone 可写”的目录仍然可写。初始化与 `account-status --verify` 扫描工作区祖先、读白名单、`PATH` 目录中 Everyone 可写的位置并给出警告（对应 Codex `audit_everyone_writable`）。

### 5.2 读根目录

- **自动发现（2e 修订）**：每次准备新的沙箱命令时，由 TS 侧调用 `read-refresh --env FILE`（绝不提权）。同一环境的并发调用只共享正在执行的刷新；刷新成功或失败后都移除记录，后续命令重新检查，避免 A→B→A 切换时复用已经被 B 撤销的 A 授权。没有后台定时刷新，已运行的终端和后台进程不会因本机制自动重新检查凭据文件或 SSH 配置。原生侧按这次传入的环境发现根目录：
  - `PATH` 中位于桌面用户 profile 下的目录；
  - `CARGO_HOME`（默认 `%USERPROFILE%\.cargo`）→ 只取 `bin`（`.cargo` 内含 `credentials.toml`）；`RUSTUP_HOME`（默认 `%USERPROFILE%\.rustup`）；
  - `NVM_HOME`、`NVM_SYMLINK`；`%APPDATA%\npm`；`PNPM_HOME`（默认 `%LOCALAPPDATA%\pnpm`）；
  - `GOPATH`（默认 `%USERPROFILE%\go`）→ 只取 `bin`；`%USERPROFILE%\.bun\bin`、`%USERPROFILE%\.deno\bin`；
  - `%LOCALAPPDATA%\Programs` 下出现在 `PATH` 里的直接子目录（不整体授 `Programs`）；
  - scoop：`SCOOP`（默认 `%USERPROFILE%\scoop`）→ `shims` 与 `apps`。
    不在 profile 下、不存在、未通过拒绝清单者丢弃；一个根是另一个根的子目录时只保留父根，让一条 ACE 覆盖整棵树并保持幂等。
- **自动根的授予方式**：根对象上一条可继承的 `YuanTuSandboxUsers` 组 RX ACE（`OBJECT_INHERIT_ACE | CONTAINER_INHERIT_ACE`），授权后新建的工具文件自动可读，不做整树快照。放弃快照的理由：快照每次补授权都要重走整棵树（`.rustup`、nvm 易逼近 100,000 对象上限），无法做到每次启动自动 refresh；工具链目录基本不会长出凭据目录。
- **残余风险与兜底**：自动根下以后新建、且不在凭据清单里的敏感文件会继承可读。兜底是每次 refresh 对每个根做凭据定点检查（只 `exists()` 固定路径，不遍历）：`.cargo\credentials.toml`、`.cargo\credentials`、`.npmrc`、`.pypirc`、`.netrc`、`_netrc`、`.git-credentials`、`.docker\config.json`，以及根内出现的同名文件；命中则给该路径加一条不可继承的组显式拒绝读 ACE。加拒绝失败时撤销该根的可继承 ACE 并跳过整根，不留半可读的根。
- **SSH 配置引用的文件**：`~/.ssh/config` 及其 `Include` 中 `IdentityFile`、`CertificateFile`、`*KnownHostsFile`、`ControlPath`、`IdentityAgent`、`RevokedHostKeys` 指向的文件（如放在 `.ssh` 之外的私钥）所在的目录不成为可读根。比较前对根、profile 和依赖路径做真实路径规范化（解析存在路径的 `..` 和重解析别名），再统一大小写和分隔符；不存在的路径保留配置写法。按 Codex 的保守边界，同一 profile 一级子目录内的所有候选根都排除（例如 `~/Tools/keys/key` 同时排除 `~/Tools/bin`），profile 外的用户根仍按是否包含依赖判断。refresh 把命中的自动根视为未发现（已授予的随之撤销），用户路径直接拒绝。`.ssh` 本身已按名字拒绝。参照 Codex `ssh_config_dependencies.rs`、`path_normalization.rs` 与 `filter_ssh_config_dependency_roots`；`Include` 通配只支持最后一级。
- **用户手动添加的路径**仍走快照授权：验证并锁定整棵现有对象树，为每个对象增加不可继承的组 RX ACE，新增文件需重新授权；日志在修改前保存原 DACL、卷序列号、文件 ID 和创建时间；撤销按对象身份进行，保留其他主体的权限。日志 v2 用 `source: auto|user` 与 `mode: inherit|snapshot` 区分两种授权；读到 v1 日志时迁移为 `source=user, mode=snapshot`，下次写入变成 v2。
- **刷新语义**：新根授权并做凭据检查、已授权的自动根重跑凭据检查（捕获新出现的凭据文件）、本次未发现的 `auto` 根撤销；`%USERPROFILE%\.gitconfig` 是文件，存在时保留一条 `source=auto, mode=snapshot` 的快照授权，文件消失则撤销。单根失败只进 `skipped`，不中断 refresh，也不阻断命令执行——工作区读写不依赖它。
- **拒绝清单与不变式**：拒绝列表永远优先：`.ssh`、`.aws`、`.gnupg`、`.azure`、`.kube`、`.docker`、浏览器 profile 目录、`AppData\Roaming\Microsoft\Credentials`、`AppData\Local\Microsoft\Credentials`、DPAPI 目录、本产品的凭据目录、上面的凭据文件；profile 根本身永不授权；已经允许 `Users` / `Authenticated Users` / `Everyone` 读取的根直接跳过（系统目录因此不需要处理，也不加入发现列表）；除沙箱账户自己的 profile 外，所有读 ACE 的受托者都是 `YuanTuSandboxUsers` 组，不出现账户 SID 直授；`read-ungrant` 拒绝撤销 `source=auto` 的条目（返回 `Automatic read roots are managed by refresh`）。
- `account-status --verify` 的读授权审计按 `mode` 分派：`inherit` 只检查根对象上那条掩码精确为 `READ_EXECUTE`、带 OI|CI 的组 ACE、凭据拒绝 ACE 仍在、以及没有账户 SID 直授；`snapshot` 沿用逐对象检查。根目录已被卸载而消失时视为待刷新，不算损坏。
- 包缓存：沙箱账户使用自己 profile 下的缓存（npm/pnpm/pip/cargo 默认路径即落在沙箱账户 profile），环境变量中不传递指向桌面用户目录的缓存变量（`toolEnvironment` 增加过滤）。
- 位于桌面 profile 下的工作区/工具链，其祖先目录仅增加不可继承的 `FILE_TRAVERSE | FILE_READ_ATTRIBUTES`，使 Node 的 realpath/lstat 能解析完整路径；不授予列目录或读取文件内容。`traverse-grants.json` 独立记录这些授权及对象身份，卸载在撤销工作区/读取授权之后收回。

## 6. TS 侧接入

### 6.1 新文件

- `packages/tools/sandbox-account.ts`：`windowsAccountSandboxProvider`（实现 `SandboxProvider`）。`prepare` 获得工作区租约与 ACL 授权、生成 scratch 与请求文件、确保 broker 已启动，返回 `SandboxPlan{executable: yuantu-sandbox.exe, args:['exec','--broker',name,'--request',file], processTree:'contained', backend:'windows-account', cleanupPath}`。
- `packages/tools/sandbox-account-broker.ts`：broker 进程管理（每账户一个、按需启动、退出时随 agent-host 结束、崩溃后下次请求重启、并发请求共享一次启动）。
- `packages/tools/sandbox-account-status.ts`：解析 `account-status` 输出，计算“就绪”。

### 6.2 修改

- `sandbox-mode.ts`：加入 `windows-account`；`nativeSandboxBackend` 在 Windows 上**始终**返回 `windows-account`，不再读取/缓存就绪状态，也不回退到 `windows`。
- `sandbox-account.ts`：未就绪时 `available()` 返回可操作错误（未初始化、标记版本、去设置页）；runner/broker 启动失败附加“去设置页修复或重新初始化”。每次 `prepare` 在拿到工作区授权之后、启动 broker 之前调用 `ensureReadRefresh(env)`：以 `PATH`、`CARGO_HOME`、`RUSTUP_HOME`、`NVM_HOME`、`NVM_SYMLINK`、`PNPM_HOME`、`GOPATH`、`SCOOP`、`APPDATA`、`LOCALAPPDATA`、`USERPROFILE` 的哈希合并进程内正在执行的相同刷新请求，结束后删除记录，不缓存完成结果；`refreshAccountBackend()` 与 `configureAccountBackend()` 清空该表，旧请求完成时不会删除后来创建的同键记录。refresh 失败只记日志，不阻断命令；原生侧撤销本次环境不再使用的自动根的规则不变。
- `sandbox.ts`：注册新 provider。
- 网络选择：请求 `network: deny`（或默认离线）→ 离线账户；允许网络 → 联网账户。
- `sandbox-launch-failure.ts`：`windows` 后端出现 EPERM 时用 `SANDBOX_CHILD_SPAWN_NOTE`，说明这是手动选择的弱后端，提示初始化账户并切回 native，而不是只建议完全访问；`windows-account` 后端出现 EPERM / `EACCES` / `Access is denied` 时用 `WINDOWS_ACCOUNT_ACCESS_NOTE`，说明账户只能读工作区与发现到的工具链根目录，并指出 设置 → 通用设置 → Windows 沙箱账户 → 高级：沙箱可读目录。
- `README.md`（windows-sandbox 目录）与 `ENHANCED-DESIGN.md`：更新为当前实现与边界。

### 6.3 就绪判定

`account-status` 的快速判定只读两样东西：

1. `setup_marker.json` 存在、`SETUP_VERSION` 一致，且账户/组/离线过滤字段形状有效；
2. `credentials.json` 能用当前用户的 DPAPI 解开，且其中的账户 SID 与标记一致。

满足即就绪；不再在每次查询时做 `LogonUserW`、WFP 审计或读根目录审计。`account-status --verify` 保留原来的实时检查（账户存在、组成员、凭据 SID、logon、WFP、seclogon、读根目录），并核对标记与实时账户 SID，供设置页诊断和日志使用。两种状态都附带 `readRoots: [{path, source}]`（来自日志），设置页用它渲染「高级：沙箱可读目录」。

运行时 provider 首次使用仍执行一次运行时探针（runner 内 `spawnSync` 子进程读写 stdio，离线账户再做一次连接被拒探针），结果缓存到进程结束；探针失败不等于状态文件损坏，错误会提示去设置里修复。

**已知代价**：账户被外部删除、WFP 过滤器丢失或 seclogon 被禁用后，标记仍可能让 `account-status` 报“就绪”，直到下一次命令失败；此时用 `--verify` 能看到真实原因。这是用启动速度换实时性所接受的取舍。

## 7. 错误处理

| 情况                                                     | 行为                                                                             |
| -------------------------------------------------------- | -------------------------------------------------------------------------------- |
| 未初始化 / 标记缺失 / 标记版本旧 / 损坏，模式为 `native` | 拒绝执行，说明缺少什么并提示去设置页初始化或修复；不自动切换后端                 |
| 同上，模式为 `windows-account`                           | 同上                                                                             |
| 初始化无法完成（UAC 被拒、策略不允许建账户或改防火墙）   | 设置页给出原因并提示修复；隔离命令停止，不回退旧后端                             |
| 凭据解密失败或 logon 失败（密码被外部改动）              | 标记“需要修复”，提示重新初始化（会重设密码）                                     |
| 标记仍有效但账户/WFP 被外部删除                          | 命令失败时提示去设置页修复或重新初始化；`account-status --verify` 给出真实问题码 |
| runner 启动失败（seclogon 停止、密码失效等）             | exec 输出 launch-failed 前缀行，退出 125；错误提示去设置页修复或重新初始化       |
| 卸载时沙箱账户仍有进程未在期限内退出                     | 卸载失败，恢复账户标志，WFP 与账户保留；提示稍后重试                             |
| runner 崩溃                                              | 进行中命令 `runner-lost`；下次请求重启 runner                                    |
| 工作区租约冲突                                           | 沿用现有提示（另一个 Host 持有租约等），在审批前检查                             |
| ACL 恢复冲突                                             | 沿用现有日志保留与 `sandbox-recover`                                             |
| 管道校验失败（疑似冒充）                                 | 拒绝，杀掉 runner，错误信息不含细节以外的数据                                    |

### 7.1 安全取舍

- **不校验 helper 签名**：helper 按“主程序旁的固定路径”定位和信任，找不到就报错；不再校验 Authenticode、签名者或受保护安装目录。能替换该目录里 helper 的人，可以借用户点一次 UAC 获得管理员权限——这是与 Codex 一致、但在本仓库中明确记录的取舍。
- **开发版与正式版同一流程**：不再有“只有签名正式版才能初始化”的限制；任何能运行 helper 的构建都可以请求 UAC。密码交换、DPAPI、卸载前先撤授权等边界保持不变。
- **标记文件判定就绪**：如 §6.3 所述，外部删除账户或 WFP 过滤器不会立刻被发现；运行时错误必须可操作，诊断用 `--verify`。
- **私有桌面只隔离 UI**：命令看不到、也操作不了用户桌面上的窗口；文件、网络、进程边界仍由令牌、ACL 和 WFP 负责。

## 8. 实施顺序与测试

1. **Spike（门槛）**：一个临时 Rust 测试程序，在手动创建的测试账户下用 `CreateProcessWithLogonW` 拉起，再按 §3.3 生成令牌启动 `node --test`（会 fork 的 fixture）与 vitest。记录结论，决定用主方案还是退路方案。spike 代码不保留。
2. 协议与 exec/broker/runner 骨架 + Rust 单元测试（帧编解码、未知字段拒绝、校验逻辑的纯函数部分）。
3. 初始化/卸载/状态 + WFP 用户 SID 过滤 + Rust 单元测试（无系统修改的部分）。
4. TS provider、broker 管理、模式解析 + `tests/` 下单元测试（mock `execute` / broker 进程，见 `tests/sandbox-account.test.ts`、`tests/windows-account-setup.test.ts`、`tests/sandbox-setup-renderer.test.ts`）。
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
