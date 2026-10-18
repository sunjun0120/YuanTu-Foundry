# 架构与性能复核（2026-10-18）

- 复核对象：`E:\agent-desktop\YuanTu-Foundry`，`HEAD` = `da82953`，工作树**非干净**（66 项改动/未跟踪：Office 创建改纯 JS、`apps/desktop/main.ts` 拆分、`packages/formats` 下沉、carrier 后台轮询改动）。复核期间另一会话仍在编辑，本文所有 `file:line` 于 2026-10-18 10:00 左右核对过一次。
- 方法：三路并行只读审查（桌面/Electron、存储与 Host、内核循环）+ 本人实测（启动耗时、CPU profile、模块导入成本、存储热路径微基准、打包体积、`npm audit`、门禁复跑）。凡标「实测」的数字都是本机（Ryzen 9 4900HS / 16 GB / Windows 11 / Node v24.19.0）当场测得，只用于量级判断。
- 与既有文档的关系：《架构与能力分析》《问题清单》记录的是 10-17 的状态。本文不重复其已修复项（D-2 进程终止误判、D-7 编码、D-1 的命令面板整表重建等已修），只记录**当前树**仍成立的问题，并补上此前未覆盖的性能画像。

---

## 1. 结论摘要

| #   | 结论                                                                                                                                   | 级别 | 证据/实测                                                                    |
| --- | -------------------------------------------------------------------------------------------------------------------------------------- | ---- | ---------------------------------------------------------------------------- |
| 1   | **Host 启动 ~1.2–2.0 s，其中 ~74% 花在模块解析 I/O，而不是业务逻辑**；打成单文件后降到 ~0.46 s                                         | P1   | §3.1、P1-1                                                                   |
| 2   | **每条走完整 `dispatch` 的命令触发一次全量 `refresh()` + 两份全量快照**（审计日志最多 10 页 RPC、任务 1+2N、≥10 次 `structuredClone`） | P1   | `packages/carrier/service.ts:1401`、`:1402`、`:1408`、`:719-740`             |
| 3   | **每轮对整段对话做一次未缓存的 JSON 全量序列化**（实测 1.9 MB → 4.4 ms/轮），压缩候选扫描再乘一次                                      | P1   | `packages/protocol/images.ts:99`、`packages/core/context.ts:174`、`:642-659` |
| 4   | **事件日志缓存每次 append 都复制整条事件数组**（实测 20k 事件时 0.32 ms/次，随会话长度线性上升）                                       | P2   | `packages/storage/session-event-journal.ts:561-579`                          |
| 5   | **worktree 隔离把整棵工作树读进内存并 base64 驻留**，且命中已发布快照也要先读全树；每个子代理再整树落盘一遍                            | P1   | `packages/workspaces/snapshot.ts:361-375`、`:201-207`                        |
| 6   | **后台唤醒的 microtask 没有任何异常兜底，全仓也没有 `uncaughtException` 处理器**：一次数据库错误即终止 Host，丢掉所有在跑的 run        | P1   | `apps/agent-host/background-wake.ts:66-116`                                  |
| 7   | **依赖漏洞 6 个（3 高）**，其中 MCP SDK 的 OAuth 凭证可被服务器指定的授权服务器骗走，与本项目的远程 MCP 用法直接相关                   | P1   | `npm audit --omit=dev`                                                       |
| 8   | 打包产物 204 MB 中 **36.5 MB 是从未使用的 `@napi-rs/canvas` Windows 二进制**，另有 3.1 MB 死依赖 `@agentclientprotocol/sdk`            | P2   | §3.5                                                                         |

架构本身是健康的：18 个包 / 11 层、383 个文件 / 956 条值导入边 / **0 环**、4 个入口 / 2 层、595 条受门禁约束的导入全部单向；IPC 鉴权、CSP、`contextIsolation`、markdown 注入面都查过，没有发现越权路径。问题集中在**启动成本、跨进程快照协议、以及"每次都要重算"的缓存旁路**这三类。

---

## 2. 架构画像

### 2.1 形态

单 npm 包（`yuantu-agent` 0.1.0，私有），22 个逻辑子目录（`packages/*`、`apps/*`）共 383 个 TS 文件（`cycles:check` 口径）/ 4.08 MB，测试 291 个文件。运行时用 Node 24 的类型擦除直接跑 `.ts`（`"host": "node apps/agent-host/main.ts"`），`npm run build` 只产出 `dist/` 的分发形态。Electron 43 桌面壳 + 子进程 Host + JSONL（stdio 或回环 TCP）通信，SQLite（`node:sqlite` 的 `DatabaseSync`，同步 API）做会话日志与投影，工具面 67 个、9 阶段管线。

### 2.2 分层（`npm run layers:check` 当前输出）

`18 packages in 11 layers, 4 apps in 2 layers, 595 ordered imports`；`check-import-cycles` 报 `383 files, 956 value edges, 0 cycles`。层次从 `formats` → `protocol`/`platform` → `providers`/`search`/`storage` → `maintenance`/`workspaces` → `tools` → `lsp`/`office`/`resources` → `knowledge`/`mcp` → `catalog` → `core` → `client` → `carrier`，入口 `apps/shared` 在下，其余三个入口同层互不引用。这条门禁是**真实有效**的：本次工作树把 7 个模块从 `protocol` 下沉到新包 `formats`，改动了 `LAYERS`/`APP_LAYERS` 才通过，说明逆向引用确实会被挡住。

### 2.3 结构上的三个固有代价

1. **单包 + 相对路径跨包导入**。所有跨包引用都写成 `../../packages/tools/registry.ts` 这种形式（595 条受门禁约束的边）。没有 per-package `package.json`，因此无法独立版本化、无法按包裁剪安装、把某个包搬进独立进程时要逐个改导入行。门禁能保证方向，保证不了边界可移动。
2. **双运行形态**（源码 `.ts` 直跑 / `dist` 编译产物）。代价是每个"按文件路径 spawn 的子程序"都要判断扩展名（`packages/tools/background.ts:225`、`packages/tools/run-code.ts:64`、`packages/tools/file-search.ts:234`、`packages/tools/code-process.ts:98-102`），以及 `__dirname` 在 CJS bundle 里存在、在 ESM 里不存在（`packages/tools/sandbox-windows.ts:536-539`）。这条分叉正是 Host 难以直接打包的原因之一。
3. **同步 SQLite + 单进程单线程**。所有 DB 读写都阻塞 Host 的事件循环，而 Host 同时负责流式转发、子进程管理、调度器。桌面单用户够用，但它把"任何一次全表扫描/全量复制"都变成用户可感知的卡顿——本文多数性能问题都落在这条约束上。

### 2.4 恢复与一致性语义（做得好，值得保留）

事件日志是唯一真源，`seq` 同时是持久游标与客户端游标；租约用 `process.kill(pid,0)` + 启动时间判活；崩溃收敛分五步（run/task/child run/stream/task resumable）在 Host 启动时执行；投影检查点失败静默、版本不符全量折叠；迁移前自动一致性备份。这套语义在本次复核中没有发现方向性错误，问题只在**执行成本**（§3.4 的启动收敛）与个别边界（P2-11 的共享事务）。

---

## 3. 性能画像（实测）

### 3.1 启动：最大的单点固定成本

| 形态                                       | 实测耗时                     | 说明                                   |
| ------------------------------------------ | ---------------------------- | -------------------------------------- |
| `node apps/agent-host/main.ts --help`      | 1951 / 2065 / 2209 / 2468 ms | 源码直跑（开发、测试、CLI 同款路径）   |
| `node dist/apps/agent-host/main.js --help` | 1598 / 1640 / 6678 ms        | 编译产物；首次 6.7 s 是冷文件缓存      |
| 打包后 `runtime\node.exe …main.js --help`  | 1147 / 1229 / 12768 ms       | 首次 12.8 s（安装后首启的杀软扫描）    |
| **esbuild 单文件 bundle**（实验）          | **457 / 470 / 633 ms**       | 5.66 MB，`--banner` + 资产同目录即可跑 |

`--cpu-prof` 归因（dist 启动，总计 1490 ms）：`internalModuleStat` 315 ms（21.1%）、`esm/utils` 181 ms（12.1%）、`cjs/loader` 129 ms（8.7%）、`lstat` 116 ms（7.8%）、`readFileUtf8` 61 ms、`package_json_reader` 47 ms —— **模块解析/文件元数据约占 74%**，应用代码本身只占很小一部分。

模块级导入成本（子进程，含 ~98 ms 的 Node 基线）：`protocol` 177 ms、`core/agent` 713 ms、`catalog` **1352 ms**、`apps/shared/runtime.ts` 1381 ms。其中 `packages/office/tools.ts` 单独 749 ms（静态引入 `jszip`、`mammoth`、`xlsx`、`docx`、`pptxgenjs`），`mammoth` 383 ms、`pptxgenjs` 212 ms、`pdfjs-dist/legacy` 256 ms。

**这意味着**：应用启动、切换模型连接（`apps/desktop/main.ts:540` 新建 service 并重启 Host）、Host 崩溃恢复（`packages/carrier/service.ts` 的 `recoverHost`）、升级——每一次都要付 1.2–2.0 s，且与用户实际是否用 Office 无关。

打包实验还暴露了两个具体障碍（也是修复清单）：

- `packages/tools/sandbox-windows.ts:541` 在**模块加载期**就 `readFileSync(acl.ps1)` 并 gzip——bundle 后路径失效，说明这里应改成惰性 getter。
- `mammoth` 是 CJS，内部 `require('fs')`，ESM bundle 需要 `createRequire` banner 才能跑。

### 3.2 每轮（一次模型请求）的固定开销

| 项                                                     | 实测                                 | 出处                                             |
| ------------------------------------------------------ | ------------------------------------ | ------------------------------------------------ |
| `contextMessageSize` 1.9 MB 对话                       | **4.42 ms**                          | `packages/protocol/images.ts:99`                 |
| `JSON.stringify(工具目录)`（本机装配 62 个 / 32.4 KB） | 0.10 ms                              | `packages/core/cache-key.ts:32` 等               |
| 压缩候选扫描（每个切点一次序列化 + 一次 forecast）     | 随切点数×批大小线性增长              | `packages/core/context.ts:642-659`               |
| 同步重读 memory + 全部技能文件                         | 1 次目录枚举 + ≤64 次 `readFileSync` | `packages/core/run-snapshots.ts:128-130`         |
| `contextSurface` 全表扫描（无 `type` 索引）            | 2 次 SQL/轮（溢出轮 5 次）           | `packages/storage/session-context.ts:54`、`:128` |

`contextMessageSize` 是其中最值钱的一条：默认 `maxContextChars = 10,000,000`，按本机实测线性外推约 23 ms/轮；而 `budget.ts:72-86` 已经有一套按消息对象缓存的 `messageSizes` WeakMap，只是这条旁路没用它。

### 3.3 每次事件/每个 token

| 项                                                    | 实测               | 说明                                                         |
| ----------------------------------------------------- | ------------------ | ------------------------------------------------------------ |
| `store.recordEvent()`（会话已有 600 事件 / 20k 事件） | 94 µs / **323 µs** | 每次复制整条缓存事件数组，O(N)                               |
| `store.lastSeq()`（每个 emit 帧，含 `message.delta`） | 6.5 µs             | 每次 `prepare(PRAGMA data_version)` + Map 重排（`:458-460`） |
| `store.events()`（缓存命中）                          | 6.2 µs             |                                                              |
| `structuredClone`（600 条消息的会话状态）             | **1.57 ms/次**     | carrier `publish` 每次至少 10 次 clone，其中一次是它         |
| `messages()` 冷折叠（600 消息 / 2400 事件）           | 26.3 ms            | 会话打开成本；热读 0.2 ms                                    |
| `store.snapshot(session)`                             | 9.1 ms             | 会话打开                                                     |

结论：**单 token 的存储开销可以忽略（6.5 µs），真正贵的是"每次状态变化都整份重建"**——carrier 的 `publish()`（`packages/carrier/service.ts:482-489`）按事件触发，每次 getter 里 9 个 `structuredClone` + `controller.snapshot`（`packages/client/session-controller.ts:123` 整段 `state` 再克隆一次），随后 Electron IPC 还要再序列化一次。一次工具调用 = `tool.started` + `tool.finished` 两次全量快照。

### 3.4 启动收敛与后台轮询

- Host 在握手之前串行执行 5 个 DB 收敛 pass + `workspaces.reconcile`（`apps/agent-host/services.ts:58-85`），后者对每个 worktree binding 串行跑 git 子进程。客户端握手超时下限 10 s（`packages/client/host-client.ts:264`），超时会 kill Host。本机 1 个会话的库实测 21.6 ms，但成本随 worktree 数量与 PowerShell 探测次数增长，极端情况下会踩到 10 s 线。
- 后台面板每秒 `background.list` + `background.state` + **每个 job 一次 `background.poll`**（`packages/carrier/service.ts:505-516`、`:566`），而 `durableBackground` 每次都对该会话整条日志做两遍全量折叠（`apps/agent-host/params.ts:59-64`、`packages/core/command-jobs.ts:52`），且返回的是历史全部已结算命令，没有上限。100 条历史命令 + 2 万事件 ≈ 每秒 400 万次事件访问，全部同步在 Host 单线程上，正好和流式输出抢 CPU。

### 3.5 打包体积

`dist/release/win-unpacked`：Electron 本体（`YuanTu Agent.exe` 227 MB 等）+ `resources/app` **115.5 MB**（其中 `node_modules` 107.3 MB）+ `resources/runtime` **88.7 MB**（独立 Node）。

| 包                               | 体积               | 判断                                                                                                             |
| -------------------------------- | ------------------ | ---------------------------------------------------------------------------------------------------------------- |
| `@napi-rs/canvas-win32-x64-msvc` | 36.5 MB            | **未被使用**：`pdfjs-dist` 只用 `getTextContent()` 抽文本（`apps/desktop/attachment-reader.ts:24-47`），从不渲染 |
| `pdfjs-dist`                     | 32.8 MB            | 只用到 `legacy/build/pdf.mjs`；`build/`（11.9 MB）与 `web/`（1.3 MB）可裁                                        |
| `xlsx` / `zod` / `highlight.js`  | 7.7 / 5.5 / 5.2 MB | `highlight.js` 与 `marked` 只被渲染层使用且已 bundle 进 `renderer.js`，可降为 devDependency                      |
| `@agentclientprotocol/sdk`       | 3.1 MB             | **0 处引用**（ACP 已移出主干），死依赖                                                                           |

另外 `asar: false`（`electron-builder.config.cjs:7`）让上万个文件直接落盘，首启与杀软扫描成本都更高；本机冷启 12.8 s 就是这条链的结果。

---

## 4. 缺陷清单

级别定义：**P1** = 用户可感知的失败/卡顿或数据安全风险；**P2** = 稳定性、正确性或明确的可感知性能损失；**P3** = 可维护性与局部优化。

### P1-1 Host 启动 ~2 s，且当前无法直接打包（§3.1 数据）

- **证据**：上表；`packages/office/tools.ts:1-22` 静态引入全部 Office 依赖；`packages/catalog/index.ts:2` 直接引入 `officeTools`；`packages/tools/sandbox-windows.ts:541` 导入期读文件；`mammoth` 的 `require` 需要 banner。
- **影响**：每次启动/切换连接/崩溃恢复都要等 1–2 s；`npm run dev`、CLI 同样受影响。
- **建议**（按收益排序）：
  1. 用 esbuild 打包 Host（桌面已有同款工具链，`scripts/build-desktop.mjs`），`--banner:js` 注入 `createRequire`；实测 2.0 s → 0.46 s。
  2. `packages/office/tools.ts` 的 `render/replace/spreadsheet/document/presentation` 改为 `await import()`（execute 内部）；`acl.ps1` 改为惰性 getter。两项都让 bundle 更小、启动更快，且是打包的前置条件。
  3. 打包后 Host 可只保留原生模块（`@napi-rs/keyring`、`@lydell/node-pty`）为 external，`node_modules` 从 107 MB 降到个位数 MB。

### P1-2 每条命令一次全量 refresh + 两份全量快照

- **证据**：`packages/carrier/service.ts:1401` `await this.refresh();`、`:1402` `return this.snapshot;`、`:1408` `this.publish();`；`refresh()` 里 `refreshAudit` 最多 10 页 ×500 条（`:719-740`）、`refreshTasks` 为 `task.list` + 每个任务两次 RPC（`:616-628`）、`changes.list`、`refreshBackground()`；`snapshot` getter 9 个 `structuredClone`（`:433-456`）。
- **影响**：审批、回答提问、重命名这些"运行中也要用"的操作，每次都重读整份审计日志与全部任务历史，然后连续克隆两份完整会话（含 base64 图片）跨 IPC。会话越长、任务越多，停顿越明显。
- **建议**：按命令类型决定 refresh 范围（审批/提问只更新对应面板）；`audit` 用已有的 `afterSeq` 增量读；`snapshot` 只克隆变化的字段，或让渲染层按 `seq` 增量取。

### P1-3 每轮整段对话的未缓存 JSON 序列化

- **证据**：`packages/protocol/images.ts:99`（无缓存）、`packages/core/context.ts:174`（`system.length + JSON.stringify(tools).length + contextMessageSize(...)`）、`:642-659`（每个候选切点重复调用，且 `cuts.includes` 是线性查找）。
- **影响**：实测 1.9 MB → 4.42 ms/轮；压缩轮可放大数十倍（100 个切点 × 逐步变长的批）。这是"会话越长每轮越慢"的本地主因，与 prompt cache 无关。
- **建议**：复用 `packages/core/budget.ts:72-86` 的逐消息 WeakMap，把 `chars` 一起缓存后求和；压缩扫描改为增量累计、`cuts` 转 `Set`、只在候选确定后做一次 forecast。

### P1-4 worktree 隔离的内存与时间成本

- **证据**：`packages/workspaces/snapshot.ts:361-375` 每个文件 `readFile` 后 `toString('base64')` 存进 manifest；上限只有单文件 64 MB / 20 万文件（`:40-41`），**无总字节预算**；`:201-207` 先 `collectWorkingTree` 再 `readManifest` 短路，命中已发布快照也要读全树；`packages/workspaces/manager.ts:331-341` 每个子代理逐文件串行写一遍全树。
- **影响**：一次 worktree 委派的峰值内存 ≈ 树大小 × 2.3（Buffer + base64）+ manifest；100 MB 的仓库约 350 MB+，且 N 个子代理 = N 次全树落盘。这是"worktree 慢"的实际原因，不是 `git worktree add`。
- **建议**：去掉 base64 驻留（直接以源路径喂 git 或流式写 staging 并增量哈希）；加总字节预算；已发布快照的快路径改用 `git ls-files -s` + index 比对。

### P1-5 后台唤醒无异常兜底 → 一次 DB 错误杀掉 Host

- **证据**：`apps/agent-host/background-wake.ts:66-116` 的 `queueMicrotask` 全程没有 try/catch，内部会 `store.list()`（先 `flush()`，`packages/storage/session-search.ts:56`）、`reconcileBackground`（写事件）、`admitBackground`（`store.goal()`，会话被另一进程删除时抛 `Session not found`，`packages/storage/sqlite.ts:802`）；全仓 grep 无 `process.on('uncaughtException')`。
- **影响**：桌面 Host 与 CLI 共用一个库时，CLI 写锁超过 `busy_timeout`（5 s）、磁盘满、并发删会话，任一都会让 microtask 抛出未捕获异常，Node 默认终止进程——正在跑的 run、终端、后台命令全部丢失。
- **建议**：microtask 整体 try/catch 并写 stderr；`admitBackground` 的写入合并进一个可失败的事务；另加一个进程级兜底（记录 + 标记不健康，而不是静默退出）。

### P1-6 依赖漏洞（`npm audit --omit=dev`：6 条公告 / 3 high，根依赖 3 个）

| 依赖                                | 级别     | 问题                                                                       | 与本项目的关系                                      |
| ----------------------------------- | -------- | -------------------------------------------------------------------------- | --------------------------------------------------- |
| `@modelcontextprotocol/sdk` ≤1.30.1 | high     | OAuth 客户端会把凭证发往 MCP 服务器指定的授权服务器（GHSA-6qxp-vccf-f47h） | 远程 MCP + OAuth 2.1 是本项目在用的能力             |
| `image-size`（经 `pptxgenjs`）      | high     | JXL/HEIF/ICNS 解析器可被死循环拖垮（GHSA-5p2g-fcmc-qvqq）                  | 目前不向 PPT 嵌入图片，暴露面低；一旦支持图片即生效 |
| `sprintf-js`（经 `mammoth`）        | moderate | 无界精度说明符 DoS（GHSA-hp3w-g68c-fv3c）                                  | `mammoth` 解析的是用户提供的 DOCX，输入不可信       |

- **建议**：升级 MCP SDK（优先）；`npm audit fix` 可解决 MCP 项；`sprintf-js`/`image-size` 需等上游或改为固定 fork；同时把"`npm audit --omit=dev --audit-level=high`"挂进 `check`，否则下次同样漂移无人发现。

### P2-1 权限预设读取失败被显示成「自定义」

- **证据**：`apps/desktop/renderer-permissions.ts:64` `view?.current ?? CUSTOM_PRESET`；`read()` 失败只 `fail()`（弹窗），`view` 保持 `undefined`，`finally` 里 `translate()` 触发重绘即得「自定义」（`:372-385`）。
- **影响**：这是 10-17《问题清单》D-1 中「未定位」的 `custom` 症状的最可能成因。安全控件把"没读到"报成"用户自定义"，与真实执行策略不一致；切换半途失败（`apps/desktop/session-choices.ts:83-92` 先改沙箱再改审批策略）还会留下"显示旧值、实际新值"。
- **建议**：单独一个「未知/读取失败」态并禁用 chip；失败后重新 `presets({type:'get'})` 或回滚已生效的一半；切换顺序改为两段都成功才算成功。

### P2-2 事件日志缓存的 O(N) 复制

- **证据**：`packages/storage/session-event-journal.ts:561-579` 每次 append 都 `frozen([...entry.events, ...stored])` 与 `appendFoldedMessages([...entry.messages], …)`；`rememberLog`（`:436-451`）每次遍历全部缓存条目重算字节。
- **影响**：实测 600 事件时 94 µs/次，20k 事件时 **323 µs/次**。一次 run 约 300 个事件，长会话累计 O(N²)；叠加 `message.delta` 的 `lastSeq`（6.5 µs/帧）后，流式期间每个 token 都有可见的同步工作。
- **建议**：内部用可变数组（分块向量），只在交出去时冻结/拷贝；`rememberLog` 的字节总量改为增量维护；`lastSeq` 用内存高水位，只在 `data_version` 变化时校验，`PRAGMA` 语句缓存为字段。

### P2-3 `session_events` 缺 `type` 索引，热路径全扫

- **证据**：唯一索引是 `packages/storage/session-current-schema.ts:69` `(session_id,seq)`；而 `session-context.ts:54`、`:128`（每轮）、`session-tasks.ts:624`、`:637`（调度器每 tick，且在 `BEGIN IMMEDIATE` 内）、`session-runs.ts:156`、`session-completion.ts:42`、`:144`（每 run）都按 `type` 过滤。
- **影响**：2 万事件的会话，这些查询每次都要扫过该会话全部事件行；admission 的扫描还在写事务内，放大跨进程写锁占用。
- **建议**：加 `CREATE INDEX session_events_type ON session_events(session_id,type,seq)`；admission 判重改用 `tasks.current_delivery_id`。

### P2-4 后台面板 N+1 与每秒全量折叠

- **证据**：`packages/carrier/service.ts:505-516`（每 job 一次 poll）、`:566`（1 s 定时器）、`apps/agent-host/params.ts:59-64`（每次 `background.list`/`poll` 都 `store.events().filter().flatMap()` + `commandRecords()`，后者再遍历一遍整条日志）、返回集无上限。
- **影响**：见 §3.4；面板打开期间 Host 单线程被持续占用。
- **建议**：后台记录落表/投影检查点，按 job id 查；poll 用 seq 游标只读增量；`background.list` 只返回未结算项。

### P2-5 渲染层：每按键整窗 render + i18n 全树遍历 + 100 ms 全量 markdown

- **证据**：`apps/desktop/renderer.ts:190` `requestRender: render`，`renderer-commands.ts:287-292` 每次 `onInput` 都调它；`render()` 内含 `JSON.stringify([session.approvals…])`（`renderer.ts:439`）、`findLastIndex` 两遍（`renderer-session-panels.ts:82-91`）、任务/改动 stringify；`apps/desktop/i18n.ts:1231-1290` 的 MutationObserver 对每个新增子树做 TreeWalker + `closest()` 全量扫描，而中文界面在 `translatedText`（`:1213-1214`）才早退，遍历本身照跑；`renderer-live.ts:96-127` 每 100 ms 对整段 live 文本重新 `marked.lexer` + 高亮。
- **影响**：长会话下每次按键都可能掉帧；transcript 每次重建（每个工具结果一次）都额外触发一轮 i18n 遍历与 markdown 重解析；100 KB 的回答整体是 O(n²)。
- **建议**：输入只更新命令面板（不触发整窗 render）；`render()` 里那几处 `JSON.stringify` 挂到 `messageRevision` 上缓存；i18n 在 zh-CN 入口直接不安装 observer；live 气泡块级缓存 + 节流 250–500 ms。

### P2-6 退出无超时

- **证据**：`apps/desktop/main.ts:193-214` `before-quit` 里 `event.preventDefault()` 后依次 `await waitForSandboxInitialization`、`backups.quiesce()`、`Promise.allSettled([service?.stop(), …])`，全部无上限；窗口 `close` 已被 `preventDefault`（`:320-325`）。
- **影响**：Host 不退或 `stop()` 永不 settle 时，窗口关不掉、无提示、进程常驻。
- **建议**：给 `stop()` 5 s 上限，超时强杀并继续退出，把状态显示出来。

### P2-7 升级失败后 `settingsAbort` 永久 abort

- **证据**：`apps/desktop/main.ts:68` 单例 `AbortController`；`apps/desktop/main-upgrade.ts:117` `ctx.settingsAbort.abort()`；失败分支 `:148-159` 只复原 `quitting/switching`，不重建 controller；`main.ts:519`、`:531` 用 `AbortSignal.any([settingsAbort.signal, …])`。
- **影响**：一次失败的升级之后，"测试连接"和"从端点读取模型"永远立即 `AbortError`，直到重启应用。
- **建议**：用可重建的 controller 工厂，或在失败分支换新的。

### P2-8 审批等待不在工具截止时间内

- **证据**：`packages/tools/registry.ts:640` `await context.approve(...)` 在 `runWithDeadline`（`:736`）之外；内核无审批超时，只有出厂 Host 补 120 s（`apps/agent-host/approvals.ts:142`）。
- **影响**：库形态下，宿主 `approve` 永不 settle（UI 断连、无人值守）时，该 step 永久挂起，工具 600 s 预算不覆盖，只有 Stop 能解。
- **建议**：审批等待 = 调用信号 + 可配置 `approvalTimeoutMs`，超时按"未批准"记错误结果。

### P2-9 run 结束不变式 3 次 stringify 全文

- **证据**：`packages/storage/invariants.ts:43-51` 对 `foldMessages`/`messages()`/`messagesFromTable()` 各 `JSON.stringify` 一次比较；`messagesFromTable` 逐行 `JSON.parse`（`session-event-journal.ts:157-160`）并逐图查 `attachment_blobs`；每个 run（含每个子会话）执行一次。
- **影响**：10 MB transcript ≈ 30 MB 字符串构建 + 10 MB 解析，阻塞 Host；子代理 fan-out 时成倍。
- **建议**：写入时存每消息摘要，比较 hash 序列；或降级为诊断开关。

### P2-10 会话删除的全库扫描

- **证据**：`packages/storage/session-lifecycle.ts:217-238` 对 `messages`/`session_events` 做 `instr(...,'"hash"')>0` 全表扫描 + 逐行 `JSON.parse`，在 `BEGIN IMMEDIATE` 内；仅当该会话有待删 blob 时执行。
- **影响**：删一个带图片的会话，成本 = 全库消息/事件表大小，期间持写锁；大库上可卡数秒。
- **建议**：建 `attachment_refs(hash, session_id)` 或 `ref_count` 递减。

### P2-11 崩溃恢复"按会话隔离"不成立

- **证据**：`packages/storage/session-runs.ts:184` 一个事务包住全部会话；`:209-217` 在事务**内部** try/catch 吞掉单会话异常；`settleAbandonedRun` 的写入顺序是"答复未决调用 → 3 个 UPDATE → 删 lease → 记事件"（`:111-126`），`transaction()` 无 SAVEPOINT（`session-event-journal.ts:700-724`）。
- **影响**：第 2 步之后任何语句失败，该会话会留下"调用已答复、run 仍 running、active_run 仍指向它"的半个状态，并随外层事务提交——正是注释声称不会出现的状态。
- **建议**：每会话 `SAVEPOINT`/`ROLLBACK TO`，或每会话独立事务。

### P2-12 会话租约可能被永久锁死

- **证据**：`packages/platform/process-identity.ts:185-187`：`startedAt === null` 或 PowerShell 查询失败（`:51-53` 返回 null）都判为"存活"；`packages/storage/session-runs.ts:250-265`、`session-lifecycle.ts:46-49`、`session-runs.ts:349-356` 据此拒绝运行/改名/删除/压缩；全仓无强制释放入口。
- **影响**：崩溃 Host 的 pid 被复用给长命进程后，该会话永久不可操作，只能等那个无关进程退出或手改数据库。
- **建议**：提供显式 `session.forceRecover`（RPC/CLI）；或补心跳窗口，允许超时回收并留下审计记录。

### P2-13 打包体积与死代码（§3.5）

- **证据**：`@napi-rs/canvas-win32-x64-msvc` 36.5 MB（`pdfjs-dist` 的可选依赖，本项目只用文本抽取）；`@agentclientprotocol/sdk` 0 引用；`highlight.js`/`marked` 只进渲染层 bundle；`asar: false`。
- **建议**：electron-builder `files` 排除 `@napi-rs/canvas*`；移除 `@agentclientprotocol/sdk`；把只用于 bundle 的两个库降为 devDependency；评估开 `asar`（需同步沙箱/运行时路径解析）；用 `npm prune --omit=optional` 或显式 external 控制原生包。

### P3（择要）

| #     | 问题                                                                 | 证据                                                                                            | 建议                                                 |
| ----- | -------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| P3-1  | SSE 每帧重算剩余缓冲字节数（块内帧数平方级）                         | `packages/providers/sse.ts:93-98`、`:82`                                                        | 消费一帧时扣减，不再扫整个缓冲                       |
| P3-2  | 每轮重复算 cache key / envelope（3 次工具目录序列化 + 4 次 SHA-256） | `packages/core/agent.ts:1097`、`run-request.ts:371`、`envelope.ts:33-35`                        | 每轮算一次传下去                                     |
| P3-3  | 每轮同步读 memory 与技能文件                                         | `packages/core/run-snapshots.ts:128-130`、`knowledge/memory.ts:78`、`resources/skills.ts:11,16` | mtime/size 指纹缓存或异步 + 变更才公告               |
| P3-4  | run 结束客户端重拉整段历史（每 100 条一个串行 RPC）                  | `packages/client/session-controller.ts:278-279`、`:819`、`:954`                                 | 用 `afterSeq`/`nextOffset` 取增量                    |
| P3-5  | 每个 `subagent.finished` 读子会话全量日志再 `findLast`               | `packages/core/run-delegation.ts:171-182`                                                       | 直接用 `store.newestPayload(child,'run.finished')`   |
| P3-6  | residency `maxResident` 是软上限，`idleTtl` 无定时器                 | `packages/core/residency.ts:307-313`、`:402-413`                                                | 拒绝/等待 open，加 unref 周期 reap                   |
| P3-7  | `lineFramer` 每切一行重算剩余字节数                                  | `packages/client/host-transport.ts:70-73`                                                       | 按行扣减，先在 Buffer 上找 `\n`                      |
| P3-8  | socket 模式下 close 在在途应答写出前 destroy                         | `apps/agent-host/carrier.ts:198-209`、`lifecycle.ts:28-38`                                      | 先 `end()`，drain 后再 destroy                       |
| P3-9  | 任务恢复不清 `session_leases`                                        | `packages/storage/session-tasks.ts:828-835` vs `session-runs.ts:123-125`                        | 统一走 `settleAbandonedRun`                          |
| P3-10 | 多个 per-session Map 只增不删                                        | `apps/agent-host/state.ts:100-106`、`sqlite.ts:1160`、`client/host-client.ts:107`               | 容量上限/按需清理                                    |
| P3-11 | 窗口大小/位置不持久化（固定 1220×860）                               | `apps/desktop/main.ts:303-318`，全仓无 `getBounds/setBounds`                                    | 存 `ui-settings.json`                                |
| P3-12 | 导出默认路径可由 `suggestedName` 穿越工作区                          | `apps/desktop/main.ts:598-608`、`packages/carrier/contract.ts:412-418`                          | `path.resolve` 后校验父目录                          |
| P3-13 | 命令面板/工作区树整表重建                                            | `apps/desktop/renderer-commands.ts:228`、`renderer-workspace.ts:248-252`                        | 按 key 复用节点                                      |
| P3-14 | 设置页给渲染进程一条出网口（需要已被攻破才可利用）                   | `apps/desktop/main.ts:518-527`、`index.html:8` CSP `connect-src 'none'`                         | 主进程内置可配置域名白名单                           |
| P3-15 | OpenAI 兼容端点缺 `[DONE]` 时完整回答被判 transport 失败             | `packages/providers/openai.ts:324-327`、`sse.ts:101-104`                                        | `finish_reason` + `usage` 齐即可判完成；先加兼容用例 |

---

## 5. 已核实为「没有问题」的部分

这些是审查中专门查过、确认成立的设计，不应在后续改动中被当成冗余：

- **IPC 安全面**：10 个 `ipcMain.handle` 全部首行 `assertSender`（`main.ts:339/370/402/434/459/481/584`、`main-attachment.ts:16`、`main-mcp.ts:70`、`main-backups.ts:47`），无 `ipcMain.on`；`assertSender` 同时校验 sender、senderFrame 与 URL（`main.ts:72-80`）。
- **窗口硬化**：`contextIsolation/sandbox` 开、`nodeIntegration/webSecurity` 正；`setWindowOpenHandler` deny、`will-navigate` 拦截、权限请求双 handler；CSP 无 `unsafe-inline`/`eval`。
- **注入面**：9 处 `innerHTML` 全是常量；markdown 走 `marked.lexer` + 手写 DOM，html token 当文本、图片不加载，无 HTML 注入路径。
- **工具管线**：并发分类 fail-closed（`registry.ts:324-334`）、相邻分组（`tool-schedule.ts:21-34`）、结果按模型顺序落盘；输出上限 24 KB 与 spill 生效。
- **存储语义**：`PRAGMA data_version` 失效逻辑与 `catchUp` 一致；append/flush 顺序；迁移版本门与备份失败即中止；`beginRun` 占位与 `active_run` 判活。
- **门禁**：本轮复跑 `docs:check` / `references:check` / `cycles:check` / `layers:check` / `i18n:check` / `typecheck` / `test:isolation:check` 全部 exit 0；`format:check` 在复核早期通过（63.7 s）。`docs:check` 在 09:29 因 README 事实块未随代码更新而失败，10:00 已由另一会话修好——这本身说明当前工作树处于活跃编辑中。

## 6. 建议的修复顺序

1. **P1-5（后台唤醒兜底）+ P1-6（升级 MCP SDK）**：改动小，直接消除"进程被杀"和"凭证被骗"两类尾部风险。
2. **P1-1（打包 Host + 懒加载 Office）**：单项收益最大（启动 -75%、安装包 -100 MB 量级），但需要先做 `acl.ps1` 惰性化与 `createRequire` banner 两个前置。
3. **P1-2 + P2-5（快照协议与渲染触发）**：定义"哪些事件走增量通道"的规则，然后让 `publish` 只在真正需要整份状态时发生；这是长会话流畅度的关键。
4. **P1-3 + P2-2 + P2-3（每轮序列化、日志复制、type 索引）**：三处都小而独立，合起来把"每轮固定成本"和"每次追加成本"各降一个量级。
5. **P1-4（worktree 快照）**：影响大但改动面也大，建议排在桌面卡顿问题之后。
6. **P2-1（权限 chip 误导）+ P2-6/P2-7（退出/升级卡死）**：用户可感知的"控件说谎"和"关不掉"，优先级高于其字面级别。
7. 其余 P2/P3 按文件归属批量处理。

## 7. 本次未验证的部分

- **全量测试**：复核期间另一会话正在跑测试并持有机器锁，我的定向运行排队 15 分钟后主动终止，因此没有拿到"当前树 249 个测试文件"的通过证据。上一轮完整数据是 249 文件 / 2,629 用例 / 717 s（`.scratch/analysis/`）。建议在该会话收尾后跑一次 `npm run check` + `npm run smoke:desktop`。
- **桌面真窗口**：没有启动 Electron 窗口做交互验证，渲染层结论来自静态阅读与既有冒烟用例。
- **macOS / Linux**：本机只有 Windows，Seatbelt、签名、公证相关路径未验证。
- **真实模型端点**：没有连真实 provider 做流式/重试/压缩的端到端计时；§3 的每轮成本是组件级实测，不是端到端。

## 8. 证据索引

| 内容                        | 路径                                                               |
| --------------------------- | ------------------------------------------------------------------ |
| 门禁逐项结果                | `.scratch/review/gates/*.log`、`.scratch/review/gates.json`        |
| Host 启动耗时与 CPU profile | 本文 §3.1；profile 由 `node --cpu-prof` 生成（临时文件未入库）     |
| 存储热路径微基准            | `.scratch/review/bench-storage.ts`、`.scratch/review/bench-hot.ts` |
| 模块导入成本                | `.scratch/review/import-cost.mjs`                                  |
| 打包体积与依赖              | `dist/release/win-unpacked/resources/`、`npm audit --omit=dev`     |
| 上一轮全量测试              | `.scratch/analysis/full2-summary.json`、`full2-timings.ndjson`     |
