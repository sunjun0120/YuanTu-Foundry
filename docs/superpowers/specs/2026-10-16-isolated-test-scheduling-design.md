# 默认并行与测试工程隔离设计

状态：用户已批准（工程隔离，在本会话直接实施）。

## 目标与边界

用户要求取消人工 SHA-256 并行白名单，改为默认并行、每文件独立临时目录与状态目录、随机监听端口，禁止测试修改 cwd 和写入临时目录之外的路径。只有真实共享机器资源使用串行标签。

用户已明确选择工程隔离：防止可信测试意外互相污染，以独立进程、路径归属、静态规则、运行时探针与生命周期检查实施；本设计不引入容器、独立系统账户，也不宣称可以约束任意恶意代码。

## 当前证据

- 基线提交 c26b7bc，设计开始时工作区干净。
- `npm test` 默认串行；当前分组预览为 4 个并行、232 个串行，白名单 16 条中 12 条已失配。
- 最近完整串行基线：236 文件，2534 项，2420 通过、0 失败、114 跳过，墙钟 1942.1 秒。
- `sandbox-windows.test.ts` 单文件 277.0 秒，`coding-evaluation.test.ts` 159.2 秒；串行机器资源仍决定并行后的耗时下限。
- 普通状态分散在 providers credentials、MCP OAuth、knowledge memory/store；部分已有独立环境变量，缺少统一根目录。
- Windows 原生后端通过 `os.userInfo().homedir` 使用真实固定控制目录，目录本身属于安全边界，不能为加速测试而任意重定向。
- `tests/macos-packaging.test.ts` 存在 `process.chdir`；编码评测夹具写仓库 `.scratch`；桌面截图存在固定 artifacts 输出。这些需要迁移，不能靠串行标签掩盖。
- `session-lease.test.ts` 已使用独立临时 SQLite 文件，应能并行。真实 PTY 出现在 terminal 测试中，应把真实部分与 fake/provider 测试分离。

## 方案选择

采用父运行器调度每文件独立的 Node 测试进程，每个进程有自己的环境和临时根。保留现有 Node test runner、报告器与逐文件完整性校验。

仅把现有 `--test-concurrency` 调大无法提供每文件环境与目录归属；操作系统强隔离超出用户选定范围。测试环境与探针以工程约束为目的，能力声明与覆盖范围写入报告。

## 必须保持的规则

1. 新测试文件默认进入隔离并行组，不需要白名单或依赖哈希准入。
2. 每文件根目录由父进程使用 `mkdtemp` 创建；run/file 身份、临时目录、状态、日志和产物均唯一。
3. worker 的 cwd 保持仓库根，供源码与只读夹具查找；所有写入工作区由测试在自己的临时目录下创建。禁止测试进程调用 `process.chdir`，需要其他 cwd 的场景显式启动子进程。
4. 不能仅限制到系统总 tmp：普通 worker 只可写自己的文件临时根，不能写兄弟 worker、父运行器元数据或仓库路径。路径检查包括符号链接和 junction 的实际归属。
5. 测试监听使用 loopback 与 `port: 0`，读取绑定后的实际端口；不得先探测空闲端口再关闭后复用。用于参数校验的固定端口字符串不等于真实监听。
6. 探针违规使该文件及整次运行失败，不自动降级串行、不重试掩盖失败、不通过新增 skip 绕过。
7. 并行池完全结束并确认进程清理后，再独占运行串行组；串行组不得与本次并行池重叠。
8. 应用隔离的 `--schedule=serial` 仍保留，作为调试、等价性和耗时比较基线。

## 文件环境与普通状态

父运行器为每文件构造环境副本，在文件执行前创建 tmp、home、state、cache、artifacts 目录。控制进程自身环境不变。

- TMPDIR、TMP、TEMP 指向该文件的 tmp。
- 子环境 HOME、USERPROFILE、APPDATA、LOCALAPPDATA、XDG 状态/缓存目录指向该文件的 home；不赋值 PowerShell 的系统变量 `$HOME`。
- 新增产品设置 `YUANTU_STATE_DIR`，只接受绝对路径；未设置时普通用户状态继续使用原 `~/.yuantu`。
- credentials、MCP OAuth、memory、knowledge 共用该根；已有 `YUANTU_CREDENTIALS_FILE`、`YUANTU_MCP_OAUTH_DIR`、`YUANTU_MEMORY_DIR`、`YUANTU_KNOWLEDGE_DB` 显式配置继续优先。
- 测试引导元数据使用独立测试前缀，不混入未知 `YUANTU_*` 设置；单独清理继承的个人产品设置和真实 provider 凭据，fixture 自己提供合成配置。
- 不读取或复制真实用户凭据来初始化测试状态。OS keychain 测试用 fake；真正访问系统存储的用例需要相应串行资源标签。
- Windows 原生安全控制目录不跟随普通状态变量迁移；需要它的测试使用真实机器资源标签与既有恢复流程。

## lint 与运行时探针

新增集中规则，覆盖测试入口和本地 helper，不以文本关键字匹配替代 AST 导入/调用识别。

静态规则检查 `process.chdir` 及其常见别名、真实监听固定端口、直接构造用户全局状态、仓库相对写出，以及绕过统一测试进程 helper 的新模式。`.bind()` 可能是函数绑定，不能一律当 UDP 监听；规则需要识别来源。

运行时引导在测试模块导入前安装探针：

- 文件创建、覆盖、删除、重命名、复制、链接、流与文件句柄的写入目标检查；同步、callback、promises 和 ESM 导入方式均验证。
- 检查两端路径，阻止链接/junction 将写入导向兄弟 worker 或仓库；临时根之外的读取仍按用例需要允许。
- 网络服务实际 listen/bind 检查 loopback 与动态端口；已有继承句柄、Unix socket/named pipe 必须有独立路径和归属。
- `process.chdir` 立即失败；子进程 cwd 通过明确参数指定，并验证为允许的只读代码根或该 worker 的私有目录。
- 父运行器持有权威的违规记录，测试即使 catch 掉探针异常，最终也不能通过。

Node 内置 Permission Model 只能作为辅助。Node 24 文档明确指出，`node:sqlite` 等其他方式不由 `node:fs` 权限覆盖，worker 也不自动继承权限；不能把它记为完整隔离证据。

因此 SQLite 路径与存储夹具、应用子进程、外部命令和原生插件必须纳入专门的越界回归：验证默认状态与工作区路径属于当前 worker，验证子环境承接，验证数据库 sidecar 与备份也在私有根。不通过扩大产品 guest 的 `NODE_OPTIONS` 白名单强行注入测试逻辑；guest 的真实权限过滤测试保持真实，测试侧记录这一边界。

工程隔离的覆盖声明需要区分 Node 探针已观察的操作、通过 fixture 路径归属约束的外部进程，以及串行机器资源操作，不能把未观察的操作写成已被探针拦截。

## 子进程与清理

调度器拥有进程树生命周期。每文件完成不只看主测试进程退出：报告必须完整，已登记的 Host、fixture server、后台任务、终端和进程组必须结算。

普通 Node 应用子进程继承私有路径与测试配置。故意过滤环境的 guest、原生 helper 和 shell 通过测试 helper 的拥有者记录管理；运行器不能静默假定 preload 总会继承。嵌套运行器只继承外层允许的临时归属，创建自己的子根，不能写父仓库的 `.scratch`。

取消、异常退出和超时都要停止继续派发、终止本次拥有的进程树、等候退出、归还本次拥有的资源。清理失败必须非零退出；不得删除其他运行的锁，尤其不能删除既有 workspace-owner.lock。失败证据由父进程复制到本次日志目录，再删除私有工作目录。

## 串行资源标签

建议测试文件头使用 `// @test-serial <resource>: <reason>`，资源值必须来自小型枚举。未知资源、空原因与重复声明属于配置错误。

初始资源：windows-sandbox、machine-lease、real-pty、desktop-ui、os-credentials。真实外部 Office 如存在也需要独立资源；纯文件 DOCX/XLSX/PDF 检查不因此串行。

- windows-sandbox：实际修改共享 ACL、令牌、全局恢复日志或受信控制状态。
- machine-lease：确实针对机器共享对象的竞争；私有数据库/session/workspace 租约不贴该标签。
- real-pty：实际创建 PTY/控制台；纯 fake/provider 单元用例拆回普通文件。
- desktop-ui：实际 Electron/桌面窗口或全局 UI 操作；renderer 纯逻辑测试仍并行。
- os-credentials：真实系统凭据存储；fake 存储仍并行。

同一机器的多个运行器进入真实共享资源阶段前需取得机器资源租约，不能仅靠单个运行器里的队列互斥。优先沿用现有可信租约语义；所有权不明时报告并拒绝，不以年龄猜测失效后强删。

标签不是全面关闭探针的开关：私有文件与端口规则继续生效，只授予声明资源确实需要的机器路径/调用。非串行文件实际进入真实原生沙箱或 PTY 时应给出缺少资源标签的明确错误。

## 运行器与兼容性

- `npm test` 默认隔离并行池；并发初值为 `min(4, availableParallelism)`，至少 1，可显式配置。
- `test:serial` 使用同一隔离契约，仅将并发设为 1；不是回到未受约束的旧运行器。
- 保留 `--schedule=serial`；`--schedule=partitioned` 兼容为新的默认分组行为。旧并发参数进行明确映射或报错，不悄悄忽略。
- `--plan` 只打印分组、标签和原因，不启动测试、不创建私有目录。
- 命名/跳过过滤继续有效；显式外部 fixture 文件保留对嵌套运行器形状回归的支持。
- 逐文件使用原报告器或兼容事件记录；保留原始文件标识、case、file-summary、phase-summary、run-summary 的校验。
- 任一缺失、空文件伪成功、截断报告、worker 异常或探针违规都非零退出。过滤后 0 case 保持合法并明确标记。
- 元数据记录实际并发、各阶段墙钟、各文件耗时、资源标签、隔离版本、违规和清理状态。

## 预计改动位置

- scripts/run-tests.mjs：父调度、文件进程、阶段与汇总。
- scripts/test-execution-policy.ts：移除哈希准入，改为默认并行与显式资源声明。
- 新测试隔离环境、bootstrap、lint、生命周期模块，避免把运行器堆成新的大文件。
- 普通状态根模块及 credentials、MCP、knowledge、settings 的接线与回归。
- 夹具：编码评测 tmp、打包 cwd 子进程、桌面产物、测试进程 helper、真实 PTY 的文件拆分。
- README、架构中的当前使用说明、package scripts、CI/coverage/changed 检查入口统一接入；不让备用入口绕过隔离规则。
- 追踪 test-parallel-safe.json 的全部实际引用后，移除当前门禁引用与文件；历史审计文字保留为历史说明，修正活跃链接，运行引用门禁。

## 验收顺序

1. RED/GREEN：调度默认值、标签解析、未知标签、每文件独立 tmp/state、异常报告与嵌套 runner。
2. 故意违规的夹具：chdir、固定监听端口、兄弟根/仓库写入、符号链接/junction、句柄写入、SQLite 路径/sidecar、子进程漏配置与残留；确认即使捕获错误或退出 0 也失败。
3. 路径优先级与无环境变量时的产品兼容；不改变真实 Windows 安全目录/guest 环境过滤。
4. 两个 worker 使用相同文件名、相同数据库名、相同默认用户状态、同时监听 0 端口，确认互不污染；跨 runner 串行资源竞争与异常退出清理。
5. 全库隔离 lint、类型/格式/文档/引用/构建门禁；修复所有发现的隔离违规后才运行全量。
6. 同一冻结源码、同一测试集做强制串行与默认并行比较；逐文件和 case 结果等价，无新增跳过或自动重试。运行代表性并发冲突重复回归，确认没有残留进程和目录。

旧基线只能用于趋势参考。示意选择七个原生相关串行文件，其总耗时约 564.7 秒，其余文件合计约 1217.4 秒；四并发理想化估算约 14.5 分钟，尚未计其他串行资源、调度开销和资源争用，不是性能承诺。最终报告只使用实测墙钟。

## 参考

- [上一轮全量计时](../../../artifacts/six-followup-repairs-20261016/full-timings.ndjson)及[元数据](../../../artifacts/six-followup-repairs-20261016/full-timings.ndjson.meta.json)。
- [Node.js 24.19.0 Permission Model](https://nodejs.org/download/release/v24.19.0/docs/api/permissions.html)。
