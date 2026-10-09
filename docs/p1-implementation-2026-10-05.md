---
description: 'P1 顺序实施记录：每项的接线、验证、决策与仍需验证的边界。'
kind: 'implementation-record'
---

# P1 实施记录

依据 [开发建议](development-recommendations-2026-10-05.md)，按 DEV-01 → DEV-09 实施，每项验证后独立提交。复用当前 checkout，在 `codex/p1-reliability` 分支工作。用户已授权持续实施全部 P1 和逐项提交。

## DEV-01：会话数据库备份与恢复

实现范围：所有入口共用的 `SessionStore` 在旧 schema 的任何 DDL 前，使用 SQLite `VACUUM INTO` 创建包含已提交 WAL 的一致性快照。新空库和当前 schema 的正常打开不备份。快照独立执行完整性、外键、应用身份和版本检查，附 SHA-256 清单；检查与恢复会验证已有清单。迁移备份失败、空间/容量不足或保留清理失败时拒绝迁移，关闭连接并释放登记。

自动/手动备份默认最多 5 个、合计 512 MiB；单个快照超过容量则拒绝。按源数据库串行生成和清理；只删除带本程序清单的备份，不删除未知文件。恢复前保全的原库不属于自动备份保留范围，维护者确认后自行归档或删除。

维护入口不需要模型凭证，也不暴露给模型工具或 Host RPC：

```powershell
npm.cmd run dev -- db-backup --db 'E:\project\.yuantu\sessions.sqlite' --json
npm.cmd run dev -- db-verify 'E:\backup\snapshot.sqlite' --json
# 关闭使用目标库的全部 Host/CLI，并关闭第三方 SQLite 连接后：
npm.cmd run dev -- db-restore 'E:\backup\snapshot.sqlite' --db 'E:\project\.yuantu\sessions.sqlite' --json
# 仅当恢复中断、存在 pending journal 时回滚到恢复前原始文件：
npm.cmd run dev -- db-recover --db 'E:\project\.yuantu\sessions.sqlite' --json
```

恢复先验证候选并重新取一致性快照，再逐字节保全当前主文件、WAL 和 SHM，包括损坏或较新版本的原库。保全文件同步落盘并校验；恢复阶段写入旁路 journal，替换后重新检查。中断 journal 会阻止所有正常入口打开，`db-recover` 校验保全文件后回滚，并保留失败替换的证据。

并发约束：每个 `SessionStore` 按数据库真实路径登记 PID；维护替换与登记共用排他门。活跃 Host/CLI 阻止替换；死进程登记可清理。不能探知第三方数据库工具是否持有文件，维护者必须关闭它们。PID 被复用时保守拒绝恢复。旧进程退出前无法通过登记保护约束未升级的旧程序，升级维护同样要求先停旧版。

锁决策：不自动抢占遗留 maintenance-lock，避免两个恢复者误删新所有者的锁。关闭全部使用者、确认锁记录的 PID 已退出后，维护者可删除旁路 `.maintenance-lock`（或 `.backup.maintenance-lock`），然后运行恢复命令；不要删除数据库或 WAL。此决策牺牲崩溃后的自动重新打开，以保持维护排他性。

验证：专项覆盖活跃 WAL 快照、备份失败原库不变、离线恢复/跨进程活跃占用拒绝、损坏/未来版本/校验和拒绝、旧无 marker 的 FTS 库迁移、数量/容量保留、附件引用/审批/任务/模型回放完整保留及恢复中断回滚。使用隔离临时数据，不修改真实用户会话。

本批实际验证：恢复专项 12/12；与 session/storage/attachment-addressing 合跑 33/33；全量回归 1318 个（1310 pass、8 skip、0 fail，包含后续安装路径的 2 个测试）；typecheck、build、docs:check、references:check、i18n:check 通过；编译客户端 smoke 2/2、Web smoke 2/2。独立审查发现的 FTS 兼容、清单校验、锁抢占和保留竞争已修复。全量测试第一次的初始化竞争已通过原有四进程迁移测试复验；依赖更新期间的短暂缺模块失败已在稳定依赖下全量消除。

剩余边界：附件的数据库 blob/引用和文件路径原样保留，不复制工作区外的物理文件；尚未在真实磁盘满、断电或第三方持有文件环境验收。容量不足通过确定性容量限制覆盖；写盘失败通过不可创建备份目录覆盖。备份和回滚是同步维护动作，大库会阻塞打开过程。

## DEV-02：Windows 安装包与安装验证

交付入口：`npm.cmd run package:windows` 生成 Windows x64 NSIS 安装器及 SHA-256/版本/schema 清单，产物位于 `dist/release`（2026-10-07 调整，原为 `artifacts/releases`），程序、安装器与卸载器使用 `build` 中的图标。`package:windows:dir` 生成解包目录。随安装器分发独立 Node 24 运行时、完整 Node 许可证、编译 Host、页面资源及生产依赖（包括 Windows x64 原生 PTY）；Host 使用普通 Node ABI。应用资源保持普通文件，以便独立 Node 读取。

安装版固定使用 `resources/runtime/node.exe`，不依赖开发 Node/npm 或环境中的 `YUANTU_NODE_PATH`。默认设置目录为 `%APPDATA%/YuanTu Agent`，默认工作区为该目录下的 `workspace`；可通过 `--workspace=绝对路径` 或原有工作区选择器使用其他目录。开发启动继续使用启动脚本提供的绝对 Node 路径。

安装器为当前用户安装，可选择路径，创建开始菜单入口；重装替换应用目录，卸载保留 profile 与用户工作区。隔离验证脚本只允许项目 `.scratch` 内的目录，拒绝 junction/symlink 和任何真实/未知位置的已有 YuanTu 安装，不以未知注册表记录推测可覆盖。

真实安装验证使用中文及空格路径，限制 PATH 不包含开发运行时，在隔离 profile/workspace 中连接本地模型 fixture，验证保存模型凭证、建会话、真实 PTY 输出及退出码、后台命令完成输出、子代理转录查看、冷重启会话恢复及界面设置。重装和卸载前后对 profile/workspace 所有文件逐个比较 SHA-256，覆盖设置、加密凭证、会话数据库和额外用户文件。手动/版本 tag 的 Windows CI 保留同一安装流程。

安装验证发现并修复两个现有问题：终端允许已存在的中文/空格可执行文件路径作为单一 argv 程序；Windows node-pty 自然退出遗漏输入管道和输出 Worker 清理，使 Host 无法退出。后者在适配层清理已结束 PTY 的资源，避免对已结束进程重新执行 PID kill。独立子进程回归先复现超时，修复后正常输出并自然退出，终端测试 15/15。

实际安装生命周期 smoke 1/1 通过（约 139 秒），包括重装与卸载逐文件数据校验；路径/安装安全测试 3/3，终端回归 15/15；完整回归 1321 个（1313 pass、8 skip、0 fail）。typecheck、安装构建与文档/引用/国际化检查通过；编译客户端 smoke 2/2、Web smoke 2/2，生产依赖 audit 为 0 个漏洞。

当前未在独立干净虚拟机执行，测试机器有开发依赖，但安装进程的 PATH、运行时和资源来源均受控；CI 工作流尚未远程运行。安装产物未签名，尚未发布，不把本次本机验证称为签名发行验收。PTY 兼容清理依赖当前 node-pty 的内部字段，升级依赖时必须保留自然退出子进程回归测试；上游问题见 [887](https://github.com/microsoft/node-pty/issues/887)、[947](https://github.com/microsoft/node-pty/issues/947)、[965](https://github.com/microsoft/node-pty/issues/965)。

## DEV-03：桌面手动升级与失败恢复

原生菜单的“应用 → 检查本地升级包”显示当前版本和 manual 渠道，选择安装器后校验同应用/渠道/Windows x64、三段版本递增、schema 上限及完整 SHA-256，再由用户确认。确认后的清单与暂存内容绑定；原文件或伴随清单被替换时拒绝升级。清单生成读取所选构建产物自身的版本、schema 和 Node 元数据。

运行策略：主任务、审批中的运行和设置/工作区切换必须先完成或取消，升级不抢占活跃主运行。确认后阻止新命令和设置写入、等待已开始的界面设置写盘、停止 Host，由既有关闭链路结束后台命令、子代理与终端。收尾失败拒绝安装。其他使用同一数据库的 Host/CLI 必须关闭；准备阶段通过 Store 登记拒绝活跃连接。无自动模型续跑。

维护 helper 与 Node 复制到 profile/upgrades 的独立目录运行，等待原桌面 PID 退出后才调用安装器。准备阶段拒绝应用目录与 profile 或整个工作区重叠，保存完整旧程序快照（逐文件 SHA-256）、相容数据库备份、设置和加密凭证快照。升级恢复备份独立保留，不受日常备份数量清理影响。

状态记录为 upgrade.json 和 upgrade.log：安装退出异常保留 install-failed；首次启动未在期限内确认 Host ready，保留 startup-failed；仅相符版本连接 Host 后确认 completed。下载不属于此首版范围：用户选择本地安装器，未完成下载或内容变化会在停止 Host 前因 hash 检查被拒绝。

离线回滚使用该升级目录中的维护运行时：

```powershell
& '<profile>\upgrades\<id>\maintenance-node.exe' `
  '<profile>\upgrades\<id>\upgrade-worker.cjs' rollback `
  '<profile>\upgrades\<id>\upgrade.json' --offline
```

必须先关闭新桌面及全部 Host/CLI。恢复检查软件与设置快照、旧 schema 上限，然后用 DEV-01 保全新版数据库，再恢复相容库。设置先暂存，按原子 rename 替换，原先不存在的设置恢复为缺失；新版设置和 OAuth 文件移至 failed-settings 保留。整体恢复持久门禁在 DB 与 profile 都恢复完成前拒绝普通 Store 打开；中断后重复同一离线命令继续。若数据库自身替换中断，应先用旧程序快照下的 CLI db-recover 处理数据库 journal，再继续整体回滚。完成后启动完整旧程序快照；追加 `--no-launch` 可只完成离线恢复供维护者检查。正式安装登记保持现状，恢复正式安装版本需要对应旧安装器。

独立审查的五项发现均以专项测试复现并修复：确认窗口换包、整个工作区 overlap、独立构建清单元数据、升级前缺失的设置、整体恢复中断门禁。专项 12/12；最终全量回归 1333 个（1325 pass、8 skip、0 fail），类型/构建/文档/引用/国际化检查通过，编译客户端和 Web smoke 各 2/2。审查修复后的真实 0.1.0→0.1.1 安装升级、Host 确认、加密模型设置和会话冷恢复通过；同一批新记录的旧程序拒绝未来 schema、离线恢复相容库、重新打开旧版和保留会话/凭证 smoke 1/1。验证用原版解包应用作为升级起点，新版经 NSIS 实际安装；不把它等同于独立干净机器验收。

回退 smoke 曾因自动启动后过早关闭而停在原生错误框，改用 `--no-launch` 完成恢复后显式启动和验证。早期另一份快照发生页面加载失败；最终新建的升级记录在同样的中文深层目录通过，未据此修改或宣称修复通用路径问题。测试旧版读取未来 schema 时，旧 Host 启动退出码为 1，关闭会显示 cleanup unconfirmed 的既有诊断；恢复后旧版正常启动和退出。

边界：未签名产物的 SHA-256 只验证完整性，可信来源仍由人确认；不自动下载、清理唯一恢复副本或修改 NSIS 的软件回滚登记。未做真实断电、磁盘满及独立虚拟机测试；不宣称关闭所有第三方 SQLite 使用者。升级需要额外空间保存完整旧程序和数据库，空间不足会拒绝准备。

## DEV-04：统一文件、进程与沙箱契约

`protocol/execution.ts` 分别声明文件工具效果、进程文件限制及网络限制；`localExecutionEnvironment` 提供不可变的真实工作区身份，文件 resolve/read/walk/write 和进程 prepare/start/stop/closed 共用路径解释。创建文件复用现有预览、审批与 journal；进程取消等待进程树及 backend 清理，取消准备会清理已创建资源。链接、路径穿越、外部 URI 和异平台绝对路径拒绝。

注册表在每次调用开始复制并冻结执行策略，通过异步上下文供既有命令、Git、验证、MCP/LSP/终端限制读取；嵌套工具和并发调用不会被全局默认值改变。后续运行中切换修复允许 Host 按 sessionId 更新 backend：等待审批或包装器的调用在实际执行前重新核对可信会话策略，已开始执行的工具保持快照；下一轮同步更新工具目录和环境说明。包装器不能替换执行策略。Carrier 恢复选中会话的策略。旧 `setSandboxMode` 仅保留为独立库调用的兼容默认，产品 Host 不再用它管理会话。

Windows 实测复现旧共享 S-1-5-12 授权允许跨工作区写入，改为真实根路径派生的独立限制 SID 和直接 ACL 授予；原生 SID_AND_ATTRIBUTES 使用正确布局，TokenDefaultDacl 加入新对象身份。系统 TokenGroups 提取 logon SID；Node 初始化还需要 Everyone 与登录会话的系统对象访问。专项覆盖真实 Node argv、内外写入、已授权工作区间隔离及 ambient ACL 写入。

Ruling: Windows backend 声明 `workspace-write-partial`，严格工作区写入／只读进程／禁网要求拒绝 — 系统对象身份是本机 Node 初始化的实测要求，不能隐瞒它们的 ambient ACL 效果 — 成本是带 Everyone 或 logon 写入 ACE 的工作区外位置仍可能可写，读取和网络也不受限制；这不是完整 OS 沙箱。Docker/sbx 保持只读工作区与禁网，host 声明无进程隔离。参考 [CreateRestrictedToken](https://learn.microsoft.com/en-us/windows/win32/api/securitybaseapi/nf-securitybaseapi-createrestrictedtoken)、[SetTokenInformation](https://learn.microsoft.com/en-us/windows/win32/api/securitybaseapi/nf-securitybaseapi-settokeninformation) 及 [DSH 的系统对象／默认 DACL 说明](https://github.com/whitelonng/dshcode/blob/master/packages/sandbox/sandbox-windows-acl/src/token.ts)。

验证：契约 8/8；Host 与 Windows 实测合跑首轮 21/21；相关命令／后台／Carrier 合跑 60/60；计划模式审批审计回归复现后，审计与契约 16/16。全量中两个 Docker 缺失断言适配新的可用性检查文案，仍独立验证宿主副作用未发生。子任务完成与协调器取消竞态以确定性测试 RED→GREEN 修复，已知报告保留，状态正确记录为 cancelled；相关回归 57 个（55 pass、2 skip）。最终全量 1345 个（1337 pass、8 skip、0 fail），类型、格式、构建、文档／引用／国际化及最终编译客户端/Web smoke 4/4 通过。首轮回归在审计失败后主动停止，第二轮 3 个失败均保留日志，不计为通过。

## DEV-05：独立进程 PTC 与 workflow

两类脚本共用 `code-process`：执行契约启动独立普通 Node，内部 Worker 保留 256MB V8 堆上限；Host 只处理有帧大小、总输出、队列和调用数量上限的 JSONL。工具名必须属于本次 catalog，调用编号为唯一正整数，参数必须为对象，结果与日志均检查类型及容量。内层调用继续经过原注册表、审批和公平并发规则；只读 catalog 不会获得隐藏写工具。

独立 Node 显式启用 Permission Model，没有 `fs.write`、child-process、native-addon 或 WASI 授权，Worker 再显式携带这些 flags。实际测试分别证明 VM 逃逸取得另一进程身份、普通 `node:fs` 直接写入被拒绝，以及经 RPC 的审批写入正常。取消／截止时间会等待程序和工具清理；有清理契约的工具可声明有界 grace，普通不合作工具的既有截止语义保持不变。

`program.call.settled` 保存每个内层调用的已知收据或未知结果。任务的每项副作用先记录 intent，成功结果的持久收据写入后再逐项确认 intent，修复之前多次内层写入只确认最后一项的接线缺口。程序在工具执行中失联会停止自动续跑，保留此前文件、子任务会话及已知收据，不自动重放。无法在清理窗口确认的效果保留 unknown；需检查当前状态后再决定恢复。

新增事件让数据库读取兼容版本升至 v24，旧 v23 程序不能误开含新语义的库。v23→v24 是读取兼容门禁，无数据改写；DEV-01 仍在迁移前创建一致性备份。构建清单同步携带新版 schema 上限。

Ruling: 首版程序 backend 支持 host 与 Windows，docker/sbx 明确拒绝 — 容器的可信 runner 资产与路径映射尚未接入，不能借独立进程之名回退宿主 — 成本是选择容器时须用 native 工具模式，PTC 配置会在模型请求前报告 unsupported。

Ruling: VM、Node Permission Model 和独立进程都不作为完整恶意代码沙箱 — [Node 24.19 官方权限文档](https://nodejs.org/download/release/v24.19.0/docs/api/permissions.html) 明确限制，进程直接效果仍取决于 DEV-04 声明的 OS 能力 — 成本是 host 没有 OS 隔离，Windows 仍有 ambient ACL、读取、网络及其他系统能力边界；针对普通 fs API 的测试不能证明所有恶意代码无法绕过。

验证：现有 PTC/workflow／超时／审批等首批 70/70；扩展专项 76 个中一处测试错误使用了不存在的 failureCode 字段，改读协议的 code 后单项通过；收据／迁移／恢复合跑 28/28；真实 Host Windows PTC 1/1；编译程序与客户端/Web 5/5。最终全量 1360 个（1352 pass、8 skip、0 fail），类型、格式、构建及文档／引用／国际化通过。首次完整回归发现工具描述变化导致三个快照漂移，逐项核对仅工具哈希、缓存键和 token 估计变化后更新；快照 4/4 与最终全量均通过。升级夹具的“未来 schema”改为当前版本加一，回退专项 12/12。之前中止或失败的运行不计为通过。

## DEV-06：受限终端与 LSP

真实 PTY 与 LSP server 通过同一个文件／进程 backend 使用工作区及执行策略。host 与 Windows 已接线，容器保持明确拒绝。LSP 的可信配置环境变量经执行契约传给实际 server，Windows 的私有 TEMP/TMP 保持由 backend 控制；文件诊断、跳转、rename 和 code action 仍复用原有路径检查、审批、文件复核及批量 journal。产品仍拒绝链接工作区，不因消费者接入放宽路径准入。

终端保留创建策略、输出及退出记录，真实 Windows ConPTY 验证 TTY、输入、Ctrl+C、内部写入与普通外部写入拒绝；关闭验证后代 PID 已退出且延迟副作用未发生。启动槽位覆盖并发准备，修复同时打开突破 8 个限制的竞态；关闭范围等待尚在启动的终端，防止关闭后出现迟到进程。单个终端收尾失败仍尝试其他终端；Host/CLI 也继续执行后台／驻留子代理及其余资源清理，再报告失败。

LSP 固定创建策略，直接客户端与工具查询均拒绝策略不一致；停止不受新策略影响。并发启动在读取配置前登记同一 Promise，关闭等待启动完成后收尾，失效客户端的清理确认后才允许替换。启动路径解析期间取消会在 backend 准备前拒绝；正常请求发送协议取消通知。启动握手失败、损坏帧与正常关闭均在真实 Windows 进程中核验 PID 退出，清理无法确认时报告 ToolCleanupError。

Ruling: 策略切换后允许观察和关闭旧终端／LSP，拒绝继续操控 — 持久进程不能被重新标成另一策略下的进程，关闭仍须可达 — 成本是继续工作前必须关闭并重启，REPL 的进程内状态不会迁移，但已记录输出保留。

验证：受限消费者、LSP、PTY、执行契约和 PTC 合跑 83 个（79 pass、4 skip）；随后启动中取消与单项收尾失败分别 RED→GREEN。最终全量 1373 个（1365 pass、8 skip、0 fail），类型、格式、构建及文档／引用／国际化通过；编译客户端与 Web smoke 5/5。工具描述快照差异已核对，仅描述哈希、缓存键及 token 估计变化，消息／调用／文件结果不变。收尾故障修复前中止的全量不计为通过。四种真实语言服务器因本机未安装或组件不可用仍跳过；Windows 接线以原生进程和协议 fixture 验收，不宣称这些未安装的服务器已通过。Windows 的部分 OS 限制沿用 DEV-04 决策，不宣称严格工作区隔离或禁网。

## DEV-07：后台完成投递与授权唤醒

命令与子代理完成统一折叠为 pending、admitted、processed；命令按 job ID，新增子代理记录按 child run ID 去重，旧记录使用事件序号。collection 只处理之前完成的结果，驻留子代理之后的结果形成新义务。Store 的观察回调只在事务 COMMIT 后触发，监听失败或修改其副本不影响事实。

默认通知，当前会话后台弹层可开启自动续跑、设置次数（1～20）和每次秒数（1～300）、暂停及明确重置预算。预算 epoch 和已用次数持久化；改变模式、暂停或重启不会补充。自动运行使用 automatic 授权，无额外标题请求、goal 续轮或交互等待，时限通过取消及现有清理链路执行。取消用户运行也暂停该会话的后续自动唤醒。Host 在 sessionStart 首次 await 前保留唯一主运行槽；内部入口的来源由函数参数传递，公共 JSON 字段不能伪造。

2026-10-07 界面调整：按用户要求，后台弹层改为只显示列表，移除上述独立控制区；Host 策略与预算契约保留。入口与聊天操作折叠的新行为见 [桌面展示记录](desktop-process-ui-2026-10-07.md)。

忙时最终 provider envelope 中的结果通知写入 foreground 接纳，实际 collection 再处理；空闲自动接纳在模型请求前写入，结束保存运行 verdict。cold Host 保留已接纳但无法确认的状态，不自动重放同一结果。后台命令行可从持久记录重建，清理已完成只隐藏显示，job_output 和保存尾部仍可读取；真实进程不会复活。自动运行由聊天控制器接收并显示，既有实时子会话导航及 runtime context 显示过滤不变。

Ruling: 自动预算采用接纳次数和单次墙钟时限，不新增累积 token 或模型步数字段 — 现有内核明确只拥有单请求上下文/输出限制，接入未实现的累计限制会制造假保证 — 成本是单次运行可能包含多个模型/工具轮次，其总 token 费用不由这个预算封顶；取消清理还需要已有的有限 grace。

Ruling: 取消、手动 kill、中断及清理无法确认的结果仅通知，正常完成和已知失败可自动检查一次 — 停止行为不能变成重新开工的授权，失联也不能推断副作用未发生 — 成本是这些结果需要人或下一次普通运行决定恢复。

Ruling: processed 的自动 reason 保存运行 verdict，不声明一定读过生产者输出 — 自动接纳只保证一次有界处理机会，真正 collection 有独立的 collected 原因 — 成本是未读输出仍会在后续普通模型轮次提示，但同一自动结果不会再次唤醒。

验证：投递、原生 Host、Carrier、既有命令及子代理结果收集相关回归 26/26；空闲控制器漏显示和子代理等待收据顺序分别复现后修复。最终全量 1382 个（1374 pass、8 skip、0 fail），类型、格式、构建、文档／引用／国际化通过，编译客户端及 Web smoke 5/5。schema v25 作为新投递词汇的读取兼容门禁，迁移前保留 DEV-01 备份。首轮受信任 hook fixture 放在工作区内被产品正常拒绝；改为独立 fixture 目录验证，不放宽准入。未使用真实外部模型，不宣称 OS 常驻服务或端到端 exactly-once。

## DEV-08：一次性、每周与时区

任务设置支持带 UTC 偏移的绝对 at、保存时固定锚点的 after，以及显式 IANA 时区的 weekly/daily。旧 interval、无时区 daily 和 event 保持原有行为；显式时区跳过不存在的墙钟时刻，重复时刻只选较早一次。跨主机 TZ、纽约与 Lord Howe 的整小时／半小时 DST、Apia 跳日有独立计算验证。

规则版本贯穿持久 task.due、事务 task.admitted 与完成回写。接纳时比较当前版本和目标时刻，两条数据库连接只能接纳一次；编辑、禁用或删除使未接纳的旧义务失效，旧运行不能覆盖新规则时刻或删除新审批。schema v26 阻止旧程序解释不了的新规则及投递词汇，沿用迁移前备份。

Ruling: 原样保存一次性规则不重置锚点或补充投递，周期／事件规则的明确保存仍重新设定 — 一次性不重复的规格与旧审批拒绝后重新设置的兼容行为同时保留 — 成本是重设同一一次性时刻须先禁用再启用，周期规则原样保存会改变规则版本。

Ruling: 接纳已提交但未留下可确认运行结果的规则保持 nextRunAt 空及未知诊断，不自动重放 — 数据库接纳与外部副作用不能组成一个事务；审批恢复和已完成步骤的已知恢复沿用原路径 — 成本是接纳后、启动前崩溃可能需要人检查并重新设置，不能保证端到端 exactly-once。

真实 Host 的一次性写任务先进入待审批，人工批准后按 recovery 恢复，只留下一个逻辑接纳；一次性无论成功或已知失败都不周期重试。桌面编辑覆盖每周纽约时间、延迟锚点原样保存和带偏移的绝对时刻预览。桌面验证发现 Carrier 提前制造 after 锚点，独立测试 RED→GREEN 修复后真实 Electron 4/4。核心／调度／存储／恢复相关测试 65/65，随后 Carrier 与日历回归 13/13；最终全量 1394 个（1386 pass、8 skip、0 fail），类型、格式、构建及文档／引用／国际化检查通过，编译客户端与 Web smoke 5/5。中止的早期全量不计为通过。

## DEV-09：Cron 与漏跑策略

任务设置支持五字段 `分 时 日 月 星期` Cron，必须保存显式 IANA 时区。数值、通配符、列表、范围与范围／通配符步长受限校验；星期 0 和 7 均为星期日。不支持名称、宏、秒字段、L/W/#/?、单值步长及混合通配列表。日和星期都不含通配符时匹配任一，否则同时匹配；参考 [Cronie 原始 crontab 手册](https://github.com/cronie-crond/cronie/blob/master/man/crontab.5)。保存时拒绝非法时区（包括固定偏移字符串）和无可达下一次的规则，界面显示 UTC 预览并保留表达式、时区与漏跑策略。

计算按日历日期筛选月份及日期，只为匹配日期复用偏移并检查分钟候选。向前／向后最多八年，覆盖公历世纪闰日的八年间隔；不存在的日期或表达式不会无界扫描，长期离线的最新一次计算不随离线年数增长。纽约和 Lord Howe DST、月末、2100 世纪闰年间隔及跨几十年计算已验证。

超过目标 60 秒的未接纳时刻按 skip 或 latest 处理。skip 原子推进到未来并写 task.skipped，不伪造模型请求、执行尝试或 lastRunAt，旧忙时投递据此清除；latest 仅接纳最新一个时刻，收据同时保留原始 dueAt 和实际 scheduledAt，不逐次补跑。interval/daily/weekly 可显式选择策略，未选择的旧规则保留原有行为。显式策略在完成时重新计算未来目标，长运行不形成即时重试循环。

持久 current_delivery_id 把审批／已知步骤恢复绑定到原逻辑收据；v26 迁移的已知恢复使用同版本的最后收据，普通 tick 不能据此复活未知运行。版本、目标时刻和当前状态仍在事务内比较；编辑、删除竞争、两条冷连接与接纳后无结果的恢复均有回归。schema v27 防止旧程序误读新规则及 task.skipped。

Ruling: Cron 重复墙钟时刻只执行较早一次，计算窗口限定八年并拒绝窗口内无目标的配置 — 延续 DEV-08 日历去重且以有限计算覆盖公历最长闰日间隔 — 成本是与某些 cron daemon 的重复小时双执行不同，窗口外或未来时区异常造成的目标不会自动承诺；不是完整 crontab 语法兼容。

Ruling: 漏跑策略保留 60 秒迟到容差，旧规则不强行改为 skip/latest，已知审批／检查点恢复不按漏跑跳过 — 既有调度器按一分钟区分漏跑，恢复已有工作与新周期义务不同 — 成本是延迟不超过一分钟仍可能执行，旧规则按原语义补一次；人选择 skip 仍不能撤销已经接纳的效果。

专项日历／任务／存储／Host 初次 75 个中一条旧测试仍期望 Cron 不受支持，改为真正未知类型后相关 77/77；额外迁移收据重复以测试 RED→GREEN 修复。真实冷 Host 1/1、真实 Electron 4/4 通过；桌面同时复现并修复原样打开 after 时预览漂移。受限工具环境下一条原生验收命令返回 needs_review，原生环境单项复验通过，失败日志保留且不计成功。最终全量 1406 个（1398 pass、8 skip、0 fail），类型、格式、构建及文档／引用／国际化通过；原生环境完整恢复回归 22/22，编译客户端与 Web smoke 5/5。没有系统级守护进程、关闭应用后的执行或端到端 exactly-once 保证。

## 整分支审查与最终修复

对 `1fc8178..910f0a4` 的一次独立整分支审查发现 4 项 Important，0 项 Critical，0 项 Minor；没有延期的小问题。四项均先通过确定性回归复现，再在同一修复批次处理：

- 冷启动自动运行早于 Carrier 的权限／沙箱恢复。Host 增加 `runtime.ready` 就绪屏障，Carrier 恢复策略并加载历史后才开启后台及定时执行。普通 SDK 在握手后自动发送就绪；直接 JSONL 客户端须显式发送空参数 `runtime.ready`。每会话持久保存自动续跑的权限和 backend；未选中会话不会继承当前选中会话的权限。原生两会话测试证明就绪前请求和预算消耗均为零，就绪后写工具目录分别受各自 deny/allow 规则约束。
- UI 接管的自动运行没有本地 AbortController，原“停止”未发送取消。控制器按运行中的 sessionId 调用 Host `run.cancel`；真实提供者连接被中断，运行 verdict 和投递完成记录持久化，自动策略暂停，后续完成结果保持 pending。
- 旧前台请求的历史刷新和 finally 覆盖新自动运行。状态、历史和清理均比较运行身份；历史和统计作为同一个读取结果返回。自动运行在旧历史等待期间启动或完成均有确定性回归，流式输出和最终转录保留。现有“完成快照立即再发”用例首次失败后修复，发布可再发快照前先释放旧请求。
- 正常 EOF 只等待 RPC，遗漏内部自动 dispatch。内部任务加入共同等待集合，取消展开、`run.finished` 和 `background.processed` 落盘后才关闭 Store。真实 socket EOF 验证 exit 0，stderr 无 database is not open，重新打开数据库能读到两类终态记录。

schema v28 是自动权限元数据的读取兼容门禁，避免旧程序忽略它而自动运行；迁移仍沿用 DEV-01 的事前备份。第一次最终全量 1413 个中有 1 项失败：版本号已更新，但迁移清单漏登记 v27→v28 门禁步；现有清单可达性回归单独复现后补登记。失败日志保留，不计为成功。

最终验证：Host／Carrier／客户端／权限及定时任务专项 64/64，迁移与生命周期修复后合跑 11/11；最终全量 1413 个（1405 pass、8 skip、0 fail，601.2 秒）。类型、构建、文档事实和国际化检查通过；真实 Electron 任务界面 4/4，编译客户端及 Web smoke 5/5。8 条跳过为四种真实语言服务器、实际 Docker/sbx 服务、Windows 上的 POSIX 权限位，以及 Chromium 已安装时不可验证的缺失浏览器分支；实际浏览器交互测试通过。

原工作区的格式及引用检查被两份新增、未跟踪的模型报告阻断（格式问题与一个不存在的 incident.md 引用）。保留原报告和图标不变，在仅含版本控制源码与本次变更的独立快照中执行完整格式和引用检查通过；不宣称原工作区这两项检查通过。全部最终修复纳入一个附加提交；无延期 Minor。

Final: Ruling: 保留 Windows 部分写隔离声明 — 原生 Node 系统对象访问依赖 ambient 身份，不能宣称严格隔离 — 成本是外部 ambient 写位置、读取和网络仍可能可达。
Final: Ruling: 独立程序及 Node Permission Model 不承诺抵御所有恶意代码 — 普通 API 权限测试不足以证明完整 OS 安全性 — 成本是 host 无 OS 隔离，Windows 仍有上述边界。
Final: Ruling: Docker/sbx 的 PTC、PTY 与 LSP 未接通时明确拒绝 — 缺少可信 runner 资产及路径映射，不能隐式回退 — 成本是这些模式须使用已支持的 native 工具。
Final: Ruling: 策略变化后旧 PTY/LSP 只可观察或关闭 — 已存在进程不能被重新归属 — 成本是继续操作须重启，REPL 内存状态不迁移，已保存输出保留。
Final: Ruling: 自动预算只约束接纳次数与单次墙钟 — 现有内核未实现跨次 token/步数预算 — 成本是累计模型费用不封顶，取消还需有界清理时间。
Final: Ruling: 停止、中断及未知清理结果仅通知 — 人的停止不是重新启动授权，未知副作用不能推断失败 — 成本是需要人工或普通运行决定恢复。
Final: Ruling: processed 记录处理机会和运行结果，不等同已收集输出 — 真正读取另有 collected 记录 — 成本是未读输出后续仍提示，但不会再自动唤醒。
Final: Ruling: 原样保存一次性规则不重置，周期／事件明确保存保留重设行为 — 同时维护不重复投递及旧审批兼容 — 成本是同一一次性目标须先禁用再启用，周期保存改变规则版本。
Final: Ruling: 崩溃后的未知接纳不自动重放 — 外部副作用不能与数据库接纳原子提交；正常关闭已经修复为等待终态 — 成本是接纳后启动前崩溃仍需人检查，不能保证端到端 exactly-once。
Final: Ruling: Cron 只支持受限五字段、重复时刻较早一次和八年计算窗口 — 有界计算覆盖公历最长闰日间隔并沿用日历去重 — 成本是与部分 daemon 行为不同，窗口外及完整 crontab 特性不受支持。
Final: Ruling: 保留 60 秒漏跑容差、旧规则行为及已知恢复豁免 — 调度迟到与已接纳工作恢复不同 — 成本是一分钟内仍可能执行，旧规则补一次，skip 不能撤销已接纳效果。
Final: Ruling: 未执行的外部验收保持“尚未验证” — 本机 fixture 和安装生命周期不能替代真实环境 — 成本是干净 VM、远程 CI、签名发行、真实断电／磁盘满、第三方占用、真实 Docker/sbx 服务、未安装语言服务器及真实外部模型效果仍需独立验收。
Final: Ruling: 缺少持久权限的旧自动 opt-in 只通知，直到受信任策略恢复、明确重设或普通运行捕获权限 — 冷启动默认值不能代表原授权 — 成本是旧版本的待处理结果可能需要一次明确恢复，不会自动消耗预算。
