# 复核项修复状态（2026-10-18 10:45）

对照对象：[架构与性能复核](review-2026-10-18-architecture-performance.md)（下称「原报告」）。本文只回答一件事：原报告的 P1/P2/P3 各项，在**当前工作树**里哪些已修、哪些部分修、哪些没动。

- 复核时点：2026-10-18 10:20–10:45，`HEAD` 仍为 `da82953`，工作树 114 项改动/未跟踪（比 10:00 的 66 项又多了 CLI 拆分、存储拆分、`run-*` 拆分、`snapshot-patch.ts`、`check-audit.mjs` 等）。
- 方法：逐项读改动后的代码（`git diff` + 定向阅读），不采信「文件改过」本身；对环境可测的项重新测量；对触及门禁的改动跑定向测试。
- 门禁快照（10:40）：`docs:check` / `references:check` / `cycles:check`（405 文件、1000 条值边、0 环）/ `layers:check`（637 条导入）/ `i18n:check` / `test:isolation:check` / `audit:check` 全部通过；`npm run build` 11 s 通过。

---

## 0. 修复进展（2026-10-18 11:50 更新）

§1 的表是 10:45 的基线。11:00–11:50 落地了 5 项修复，门禁复跑全绿（`format` / `docs` / `references` / `cycles`（406 文件、1001 条值边、0 环）/ `layers` / `i18n` / `test:isolation` / `typecheck`）。

| 项                    | 本轮状态   | 改动与证据                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| --------------------- | ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 测试挂起（§6 的问题） | **已修复** | 根因是内置技能让每会话首个 run 追加一条 runtime-context 用户消息，3 个按 user 条数断言的红测试因此失败；失败用例里 `httpFixture` 的 teardown 又先抛错，node 会跳过后续 teardown，Host 没被 `stop()`，worker 永不退出。见下「测试平台的修复」                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| P2-12 租约永久锁死    | **已修复** | `SessionRuns.recoverSession` + RPC `session.recover`（capability `session-recover-v1`）+ CLI `session-recover <id> --db <file>`；Host 拒绝恢复自己正在跑的会话；测试 `tests/session-lease.test.ts`（3 例）、`tests/host-workflows.test.ts`（1 例）、`tests/session.test.ts` 的归属清单                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| P2-8 审批无超时       | **已修复** | `ToolDeadlinePolicy.approvalMs`（默认 600 s，`0` 保持无限等待）；`ToolRegistry.approveWithinBudget` 同时用于首次审批与派发前复核；超时按「未批准」返回独立文案，迟到的答复/拒绝被丢弃而不是变成 unhandled rejection。测试 `tests/tool-timeout.test.ts`（2 例）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| P2-6 退出无超时       | **已修复** | 新增 `apps/desktop/quit-deadline.ts`（`QUIT_DEADLINE_MS = 15_000`，高于 Host 客户端自身 10 s 的强杀）；`before-quit` 的每一步都有上限并点名步骤，超时后仍继续退出。测试 `tests/quit-deadline.test.ts`（3 例）与 `tests/desktop-sandbox-probe.test.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| P1-6 依赖漏洞         | **已修复** | MCP SDK 已升到 1.32.1（原 high 消失）；`audit:check` 接进 CI 的 `check` job（本地 `check` 保持可离线）；2 条 image-size high 在 `scripts/check-audit.mjs` 登记豁免理由，条目失效会自报过期                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| P2-9 run-end 不变式   | **已修复** | `packages/storage/invariants.ts` 改为逐消息哈希比较（`digestHistory`），不再为三份视图各建一个整段 JSON 字符串；不一致时报告「first difference at message N」。测试 `tests/invariant-registry.test.ts` 增加定位断言，`tests/invariants.test.ts` 的 I7 对齐运行时快照公告                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| P1-4 worktree 快照    | **已修复** | `SNAPSHOT_FORMAT` 升到 3：manifest 只记 `path/mode/size/sha256`，字节以内容寻址存到 `<metadata>/files/<sha256>`，`readManifest` 不再把整棵树读进内存。冻结用 `collectStagedTree` 逐文件写 staging（峰值一个文件），id 确定后整目录 `rename` 到位；`buildTree` 直接拿这些文件喂 `hash-object --stdin-paths`，不再解码 base64、不再写第二份 staging；`snapshotFileBytes` 读取时校验 sha256（不匹配按 `WORKSPACE_INTEGRITY` 拒绝），工作树填充逐文件读取；format 1/2 的旧 manifest 仍可读（条目带 `blob` 即走旧路径）。另含 512 MiB 总字节预算（`WORKSPACE_TOO_LARGE`，读取前拒绝并点名文件）、`collectFileDigests`（分配校验与删除指纹不再驻留 base64）、manifest 分块流式写出。测试 `tests/workspace-snapshots.test.ts`（14/14，新增格式 3 形状与篡改检测）与全部 71 个 workspace 用例。**仍未做**：已发布快照的快路径（干净树直接复用同一 HEAD 的快照）需要与 CAP-03 的来源稳定性校验一起设计 |     |
| P1-2 剩余一半         | **已修复** | 审计改为从上次 seq 增量读取（`mergeAuditWindow`，窗口 5000），每条命令最多 10 页降为 1 页；新增 `refreshScopeFor`，把 run 中反复发生的 `approve` / `questionAnswer` / `enqueue` / `clearQueue` / `cancel` 从「refresh 全部 5 个面板」缩到只读 1 页审计（其余面板由 `approval.decided` / `question.answered` / `run.finished` / `task.step` 事件驱动），其他命令保持全量以免面板滞后。测试 `tests/carrier.test.ts`（17/17）                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| P1-1 Host 打包        | **已修复** | 新增 `scripts/build-host-bundle.mjs`：esbuild 把 Host 打成单文件 `dist/packages/tools/host.bundle.js`（5.68 MB），输出目录选在 tsc 的 worker 旁边，因此 `import.meta.url` 相对路径（background-worker / code-worker / code-process-entry / search-worker / windows-sandbox/acl.ps1 / seatbelt 的 `../../`）全部保持不变；构建内置 `host.info` 真实往返冒烟，失败即构建失败。`apps/desktop/install-paths.ts` 优先使用 bundle、保留 `dist/apps/agent-host/main.js` 作为 tsc-only 回退；`npm run build` 新增 `build-host-bundle` 步骤；`check-windows-package.mjs` 校验 bundle 存在且未被截断。实测 `--help` 启动 **1090–1335 ms → 279–293 ms**；真实客户端（host.info → session.create → resources.list → session.get → stop）0.6 s 全通                                                                                                                                                        |

**全量测试的既有红项（不是本轮改动引入）**：14 个文件、23 个用例失败，全部与「内置技能被公告为 runtime-context」有关——例如 `context-envelope` 期望空技能目录却收到 `builtin:office-documents`，`core`/`context`/`hooks`/`subagents` 系列按消息条数或位置断言。这个行为来自工作树里未完成的 `packages/resources/builtin-skills.ts`（09:26 起就红）。处理方式是一个产品决定：要么接受公告并成批更新这 14 个文件的期望（可用一个共享的「人输入消息」谓词），要么让内置技能不出现在公告目录里、只保留在 `resources.list` 与 `expandSkill`（一处 2 行改动，既有测试恢复绿色，但模型不会主动知道它们存在）。本轮先按「相关测试通过」收口，未替这个决定改语义。

**测试平台的修复**（顺带解决「挂起」这一类问题）：

- `scripts/test-scheduler.mjs` 新增**文件级看门狗**：`DEFAULT_FILE_TIMEOUT_MS`（15 分钟）或 `FOUNDRY_TEST_FILE_TIMEOUT_MS`，超时后结束进程树、把最后一条已报告用例写进失败信息；`scripts/run-tests.mjs` 按「该文件历史耗时的 10 倍、最低 2 分钟」给每个文件定额。
- worker 增加 `--test-force-exit`（覆盖率运行时除外，V8 需要正常退出刷盘）：测试跑完后残留句柄不再让文件永久挂起；泄漏的 Host 仍由隔离探针判为 `cleanup.clean === false`（`tests/test-isolation.test.ts` 已钉住该能力），所以是失败而不是静默通过。
- `tests/client.test.ts`、`tests/cli.test.ts` 改为只统计「人输入的 user 消息」（`isRuntimeContext` 过滤），并钉住内置技能出现在 `resources.list` 里；`tests/client.test.ts` 的图片断言改为按内容查找而不是按数组下标。
- 结果：`tests/test-scheduler.test.ts` 8/8（含一个真实挂起用例 2.2 s 内被看门狗判失败）、`tests/client.test.ts` 44/44 且 61 s 内退出。

---

## 1. 总表

| 原编号  | 问题                                           | 状态           | 一句话结论                                                                                                                            |
| ------- | ---------------------------------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| P1-1    | Host 启动 ~2 s、无法打包                       | **部分修复**   | 打包阻塞项 `acl.ps1` 已惰性化；Office 仍静态导入，仍无 Host bundle，启动仍 1.0–1.3 s                                                  |
| P1-2    | 每条命令全量 refresh + 两份全量快照            | **大部分修复** | 跨 IPC 改为按 section 差量、会话视图按 revision 复用、任务历史单次 RPC；仍保留每条命令一次全量 `refresh()` 与两份快照构建             |
| P1-3    | 每轮整段对话未缓存序列化                       | **已修复**     | 逐消息 WeakMap 缓存 + 工具目录只序列化一次 + 压缩候选改为遍历切点                                                                     |
| P1-4    | worktree 快照整树 base64 驻留                  | **未修复**     | `packages/workspaces/*` 未改动                                                                                                        |
| P1-5    | 后台唤醒无兜底、一次异常杀 Host                | **已修复**     | microtask 逐会话 try/catch + 进程级 `uncaughtException`/`unhandledRejection` 优雅关闭                                                 |
| P1-6    | 依赖漏洞 6 条（3 high）                        | **部分修复**   | MCP SDK 升到 1.32.1（该 high 消失）；新增 `audit:check`，但只挂在 `check:release`，且 2 条 image-size high 走豁免、3 条 moderate 不拦 |
| P2-1    | 权限 chip 读失败显示「自定义」                 | **已修复**     | 新增 `unreadable` 态（显示「权限未读取」）、点击重试、切换失败后回读                                                                  |
| P2-2    | 事件日志每次 append 复制整条数组               | **已修复**     | 缓存改为可变 `log` + 按读冻结；append 变 `push`                                                                                       |
| P2-3    | `session_events` 缺 `type` 索引                | **已修复**     | 新库与迁移路径都加了 `(session_id,type,seq)`                                                                                          |
| P2-4    | 后台面板 N+1 与每秒全量折叠                    | **部分修复**   | 游标已到末尾时不再逐 job poll、发布签名去重、仅 live 时轮询；Host 端每次 `background.list` 仍全量折叠                                 |
| P2-5    | 渲染层每按键整窗 render / i18n / live markdown | **部分修复**   | 发布快照改为按 section 局部重绘；每按键全窗 render、i18n 全树遍历、100 ms 全量 markdown 未改                                          |
| P2-6    | 退出无超时                                     | **未修复**     | `apps/desktop/main.ts:205-226` 仍是三个无上限 await                                                                                   |
| P2-7    | 升级失败后 `settingsAbort` 永久 abort          | **已修复**     | `renewSettingsAbort()`，失败分支调用                                                                                                  |
| P2-8    | 审批等待不在工具截止时间内                     | **未修复**     | `packages/tools/registry.ts` 未改动                                                                                                   |
| P2-9    | run 结束不变式 3 次 stringify 全文             | **未修复**     | `packages/storage/invariants.ts` 未改动                                                                                               |
| P2-10   | 删除会话全库扫描                               | **已修复**     | 改为按候选哈希 `instr` 分批命中行，不再解析全库带图行                                                                                 |
| P2-11   | 崩溃恢复共享事务里吞异常 → 半提交              | **未修复**     | `packages/storage/session-runs.ts` 未改动                                                                                             |
| P2-12   | 租约可能被 pid 复用永久锁死                    | **未修复**     | 仍无强制释放入口，`process-identity.ts` 未改                                                                                          |
| P2-13   | 打包体积与死代码                               | **部分修复**   | 依赖清单已无 `@agentclientprotocol/sdk`（原证据取自旧打包产物，见 §4）；`@napi-rs/canvas` 36.5 MB 仍在、`asar:false` 未变             |
| P3-1…15 | 15 项次要问题                                  | **全部未修**   | 逐项核对见 §3                                                                                                                         |

**计数**：P1 已修 2（P1-3、P1-5）、部分/大部分 3（P1-1、P1-2、P1-6）、未修 1（P1-4）；P2 已修 5（P2-1、P2-2、P2-3、P2-7、P2-10）、部分 3（P2-4、P2-5、P2-13）、未修 5（P2-6、P2-8、P2-9、P2-11、P2-12）；P3 已修 0。

---

## 2. 已修复项的改动要点（可复核）

### P1-3 每轮序列化

- `packages/protocol/images.ts:99-135`：`messageChars` 是 `WeakMap<object, number>`，逐消息缓存序列化长度；`contextMessageSize` 对数组改为求和（含 `[`、`]`、逗号的精确补偿）。
- `packages/core/context.ts:174-178`：`toolChars` 每次装配只算一次；`:641-647` 的候选批循环改为直接遍历 `cuts`（有序唯一），不再 `for index` + `includes`。
- 复测：同一批消息重复测量 4420 µs → **89.7 µs**（热路径；首次仍为一次全量序列化）。

### P1-5 Host 崩溃兜底

- `apps/agent-host/background-wake.ts:76-96`：`store.list` 与每会话的 `reconcileBackground`/`backgroundAuthority`/`admitBackground` 分别 try/catch，失败写 stderr 并跳过。
- `apps/agent-host/lifecycle.ts:56-70`：`uncaughtException` / `unhandledRejection` 不再让进程当场死亡，而是记录、置 `exitCode=1`、走正常 `shutdown()`（中止并结算在跑的 run）。

### P2-1 权限读数

- `apps/desktop/renderer-permissions.ts:58-67`（`unreadable`）、`:155-190`（文案、`dataset.preset='unknown'`、仍可点击）、`:314-317`（切换失败后 `void read()`）、`:403-412`（读失败丢弃旧 view）。

### P2-2 日志缓存

- `packages/storage/session-event-journal.ts:33-75`：`log`/`eventsView`/`folded`/`messagesView` 四件套；`appendToEntry` 原地 `push`；读时 `eventsOf` 冻结一份并复用；`catchUp` 也走同一条追加路径（`:445-455`）。

### P2-3 索引

- `packages/storage/session-current-schema.ts:70-73`（新库）与 `packages/storage/session-migrations.ts:175-177`（旧库 `IF NOT EXISTS`，有意不升版本号，注释说明为什么不升）。

### P2-7 设置中止

- `apps/desktop/main.ts:120-125` `renewSettingsAbort()`；`apps/desktop/main-upgrade.ts:159` 在失败分支重建。

### P2-10 删除清理

- `packages/storage/session-lifecycle.ts:217-244`：按候选地址批量拼 `instr(col,?)>0`（每批 200 个参数），只对命中行做 `JSON.parse` 复核。

### 顺带修好的结构性问题（原报告 §2 的架构风险）

- 巨型文件：`packages/core/agent.ts` 1408 → 940、`packages/storage/sqlite.ts` 1182 → 759（拆成 `session-store-parts.ts`、`session-projection-reads.ts`、`session-records.ts`、`session-workspace-apply.ts`）、`apps/cli/main.ts` 1294 → 77（拆成 6 个文件）；`packages/carrier/service.ts` 1425 → 1223（后台面板与子代理转录各自成类）。
- 新增能力面：`task.history` RPC（一次取全部任务历史，消灭 1+2N）、桌面端快照差量通道、内置技能。

---

## 3. 未修复项与剩余风险

### P1-4 worktree 快照（未动）

`packages/workspaces/snapshot.ts:361-375` 仍是 `readFile` → `toString('base64')` 进 manifest，`MAX_FILES`/`MAX_FILE_BYTES` 仍在，无总字节预算；`:201-207` 仍是先读全树再查已发布快照。这是当前**单项内存风险最高**的路径。

### P2-6 / P2-8 / P2-9 / P2-11 / P2-12（未动）

| 项    | 证据                                                                    |
| ----- | ----------------------------------------------------------------------- |
| P2-6  | `apps/desktop/main.ts:205-226`：`before-quit` 三连 await 无超时         |
| P2-8  | `packages/tools/registry.ts:640` 审批在 `runWithDeadline`（`:736`）之外 |
| P2-9  | `packages/storage/invariants.ts:43-51` 三份全量 `JSON.stringify`        |
| P2-11 | `packages/storage/session-runs.ts:182-221` 单事务 + 事务内吞异常        |
| P2-12 | `packages/platform/process-identity.ts:185-187`，且无 `forceRecover`    |

### P2-4 / P2-5 的剩余一半

- `apps/agent-host/params.ts:53-66` 的 `durableBackground` 每次调用都 `commandRecords(store, sessionId)` 全量折叠；`apps/agent-host/handlers/background.ts:24-28` 的 `background.list` 仍无条件调它。面板每秒的 RPC 少了（只在游标落后时 poll），但每次 `list`/`state` 仍是 O(日志)。
- `apps/desktop/renderer-commands.ts:287-292` 每按键仍 `actions.requestRender()`；`apps/desktop/i18n.ts:1278` 的 MutationObserver 与 `apps/desktop/renderer-live.ts:96-127` 的 100 ms 全量 markdown 未改。

### P2-13 打包

- `@napi-rs/canvas-win32-x64-msvc` 仍在 lock（`pdfjs-dist` 的可选依赖）且 `electron-builder.config.cjs` 未排除 → 仍会进安装包；`asar: false` 未变；`highlight.js`/`marked` 仍是生产依赖（只被渲染层 bundle 使用）。

### P3 全表

| #     | 状态 | 证据（仍是原样）                                                             |
| ----- | ---- | ---------------------------------------------------------------------------- |
| P3-1  | 未修 | `packages/providers/sse.ts:93-98`                                            |
| P3-2  | 未修 | `packages/core/run-request.ts:371` 与 `agent.ts` 各算一次 cache key          |
| P3-3  | 未修 | `packages/core/run-snapshots.ts:128-130` 每轮同步读 memory/skills            |
| P3-4  | 未修 | `packages/client/session-controller.ts:291`（`tail = max(100, 已有消息数)`） |
| P3-5  | 未修 | `packages/core/run-delegation.ts:182`                                        |
| P3-6  | 未修 | `packages/core/residency.ts:310`、`:402-413`                                 |
| P3-7  | 未修 | `packages/client/host-transport.ts:73`                                       |
| P3-8  | 未修 | `apps/agent-host/carrier.ts:206`（`lifecycle.ts` 只加了信号处理）            |
| P3-9  | 未修 | `packages/storage/session-tasks.ts:832`                                      |
| P3-10 | 未修 | `apps/agent-host/state.ts`、`packages/storage/sqlite.ts` 的 per-session Map  |
| P3-11 | 未修 | `apps/desktop/main.ts` 仍固定 1220×860，无 `getBounds/setBounds`             |
| P3-12 | 未修 | `apps/desktop/main.ts:613-619` 仍 `path.join(workspace, suggestedName)`      |
| P3-13 | 未修 | `apps/desktop/renderer-commands.ts:228`、`renderer-workspace.ts:250`         |
| P3-14 | 未修 | `apps/desktop/main.ts:524-546` 仍用渲染进程给的 URL 出网                     |
| P3-15 | 未修 | `packages/providers/openai.ts:324-327`                                       |

---

## 4. 对原报告的一处更正

原报告 P2-13 写「`@agentclientprotocol/sdk` 3.1 MB，0 处引用，死依赖」。核对当前依赖树：`package.json`、`package-lock.json`、`node_modules` 里都**没有**它——我当时的 3.1 MB 证据来自 `dist/release/win-unpacked` 里的**旧打包产物**，不是当前依赖声明。结论应改为：**依赖声明没有这个死包；需要清理的是 `@napi-rs/canvas` 36.5 MB（lock 里仍在）与 `asar:false` 的文件布局**。原报告的其它数字（`resources/app` 115.5 MB、`runtime` 88.7 MB、`node_modules` 107.3 MB）仍以那次打包产物为准，重新打包后需要复测。

---

## 5. 复测数据

| 指标                                     | 10:00 复核     | 现在（10:40）                   | 说明                                                         |
| ---------------------------------------- | -------------- | ------------------------------- | ------------------------------------------------------------ |
| Host 启动（源码 `--help`）               | 1951–2468 ms   | **1268–1282 ms**                | 含当时后台测试负载的影响，不能全归给本次改动                 |
| Host 启动（重新构建的 dist）             | 1598–1640 ms   | **1037–1070 ms**                | 同上                                                         |
| `office/tools.ts` 导入                   | 749 ms         | 587 ms                          | 仍是最重的单模块（静态引入 Office 全家桶）                   |
| `catalog/index.ts` 导入                  | 1352 ms        | 955 ms                          |                                                              |
| `contextMessageSize`（1.9 MB，重复测量） | 4420 µs        | **89.7 µs**                     | P1-3 的缓存生效；首次测量仍 ~4.4 ms                          |
| `npm audit --omit=dev`                   | 6 条（3 high） | **5 条（2 high / 3 moderate）** | high 只剩 image-size 的两条，已在 `check-audit.mjs` 登记豁免 |

> `store.recordEvent()` 在本轮复测里没有变快（323 → 372 µs，当时机器上有并发测试），但代码已从「每次复制整条数组」改为「原地 push、按读冻结」。这个改动在 20k 事件量级不会显著改变单次耗时（payload 序列化与 SQLite 写入才是大头），真正的收益要到事件数更大时才体现——原报告把它列为 P2 而不是 P1 是合适的。

---

## 6. 新发现：`tests/client.test.ts` 不收敛（P1，阻塞全量门禁）

这是本轮复核中唯一的新问题，且它会**让 `npm test` 挂住而不是失败**：

- 我跑的 9 个文件里 8 个全部通过（`schema-migrations` 11/11、`storage-rules` 14/14、`session-delete-cleanup` 6/6、`session` 10/10、`runtime-context` 13/13、`carrier` 15/15、`desktop` 18/18、`task-workflow` 12/12）。
- `tests/client.test.ts` 打印完全部 26 个用例（最后一条 `a session read while a run is live restores the run, its queue and its frames`，2309 ms）后**不再推进**：worker（`node --test … tests/client.test.ts`）与其 `apps/agent-host/main.ts` 子进程一直存活，NDJSON 没有 `run-summary` 行。
- 不是偶发：机器上另有两个独立运行（09:57、10:05 启动）同样卡在 `tests/client.test.ts`，各自留下 Host 子进程；`--test-timeout=0`（测试命令行使然）意味着没有单用例超时，会无限等。
- 影响：`npm test` / `npm run check` 在 CI 与本地都可能永久挂起；上一轮全量 717 s 的数据也失去可比性。
- 未定位到具体用例：所有用例都已报告通过，挂点在最后一个用例的 teardown（`setup()` 的 `client.stop()` + 清理）之后，或进程退出前的残留句柄。建议的定位顺序：给该文件加 `--test-timeout`（例如 120 s）让挂起变成可定位的失败；再对最后一个用例与 `host-client.stop()` 的等待路径做二分。

---

## 7. 建议的下一步

1. **先解 P1 门禁阻塞**：`tests/client.test.ts` 的挂起（§6）。在它修好前，任何「全绿」都无法被证明。
2. **补完 P1-2 的剩余一半**：`dispatch` 尾部对每条命令仍整份 `refresh()`（审计最多 10 页、`changes.list`、`tasks`）再返回快照；按命令类型裁剪 refresh 范围即可，收益集中在审批/提问这类运行中操作。
3. **P1-4 worktree 快照**：这是当前内存风险最高、且完全没动的 P1。
4. **P2-11 + P2-12**：两者都涉及「崩溃后会话可用性」，一个会产生半提交状态，一个会永久锁死会话；P2-12 补一个 `session.forceRecover` 入口即可大幅缓解。
5. **P2-6 / P2-8 / P2-9**：三个独立的「无上限等待/全量扫描」小口子。
6. **P1-6 收尾**：把 `audit:check` 挂进 `check`（或 CI 的 `check` job），并把 3 条 moderate 纳入登记或明确豁免理由。
7. P3 各项按文件归属批量处理；优先 P3-4/P3-5/P3-3（运行期可见成本）与 P3-11/P3-12（桌面体验/路径安全）。

## 8. 证据索引

| 内容             | 路径                                                                                                                                                                        |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 改动后的模块结构 | `packages/storage/session-store-parts.ts`、`packages/carrier/background-panel.ts`、`apps/desktop/snapshot-patch.ts`、`apps/cli/run.ts`                                      |
| 新增门禁         | `scripts/check-audit.mjs`、`package.json` 的 `audit:check` / `check:release`                                                                                                |
| 定向测试结果     | `.scratch/test-logs/` 下 10:22–10:27 的 `*-{schema-migrations,task-workflow,carrier,desktop,session,runtime-context,storage-rules,session-delete-cleanup}.test.ts-*.ndjson` |
| 挂起现场         | 同上目录的 `*-parallel-client.test.ts-*.ndjson`（无 `run-summary`）与对应 `.log`                                                                                            |
| 复测脚本         | `.scratch/review/bench-hot.ts`、`.scratch/review/import-cost.mjs`                                                                                                           |
| 门禁复跑         | `docs:check`、`references:check`、`cycles:check`、`layers:check`、`i18n:check`、`test:isolation:check`、`audit:check`、`npm run build`                                      |
