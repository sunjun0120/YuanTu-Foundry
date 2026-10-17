# 问题清单与缺陷分析（2026-10-17）

- 检查对象：`E:\agent-desktop\YuanTu-Foundry`，`HEAD` = `3c2e26b`（检查开始时工作树干净）
- 检查方式：逐项运行聚合门禁（`npm run check` 的全部阶段 + `bench:check`、`check:windows-sandbox`、`smoke:desktop`），再对失败项做最小复现、代码定位与对照实验
- 机器：Windows 11 家庭中文版 10.0.26300 / Ryzen 9 4900HS（8C16T）/ 15.4 GB / Node v24.19.0
- 相关文档：《架构与能力分析》《全量测试耗时统计》与本文件同日产生

**结论：代码质量门禁基本全绿（docs/references/cycles/i18n/typecheck/隔离检查/bench/Windows 沙箱验收均通过），但发行级门禁 `smoke:desktop` 是红的（两个套件共 5 个 UI 断言失败、4 类问题），另有一个会导致偶发失败的真实进程终止缺陷。** 下面按严重度给出 11 条问题，每条都附证据、影响与修复建议。

---

## 1. 门禁结果总表

| #   | 门禁                    | 结果              | 耗时        | 证据                                                                     |
| --- | ----------------------- | ----------------- | ----------- | ------------------------------------------------------------------------ |
| 1   | `format:check`          | ✅ 通过（复跑）   | 15.5 s      | 首次失败仅因本次新增报告未格式化，`prettier --write docs/*.md` 后通过    |
| 2   | `docs:check`            | ✅ 通过           | 1.8 s       | README 数字与代码一致（67 工具 / 58 方法 / 249 测试文件等）              |
| 3   | `references:check`      | ✅ 通过           | 0.7 s       | 本次新增三份 docs 后再次通过                                             |
| 4   | `cycles:check`          | ✅ 通过           | 1.8 s       | 349 文件、0 个文件级值导入环                                             |
| 5   | `i18n:check`            | ✅ 通过           | 0.8 s       | 主进程人读模块无中文漏网                                                 |
| 6   | `typecheck`             | ✅ 通过           | 11.1 s      | `tsc --noEmit`                                                           |
| 7   | `test:isolation:check`  | ✅ 通过           | 2.1 s       | 测试入口隔离规则                                                         |
| 8   | `npm test`（全量）      | ✅ 通过（第二次） | **717.0 s** | 2,629 用例 / 0 失败 / 113 跳过；第一次运行在 109/249 处失败，见 D-2、D-3 |
| 9   | `build`                 | ✅ 通过           | 10.2 s      | tsc + esbuild + 资产拷贝                                                 |
| 10  | `smoke:client`          | ✅ 通过           | 5.6 s       | 编译产物冒烟                                                             |
| 11  | `bench:check`           | ✅ 通过           | 9.1 s       | 确定性基准                                                               |
| 12  | `check:windows-sandbox` | ✅ 通过           | 216.3 s     | 54 项真机 Windows 沙箱验收全绿，产出验收报告                             |
| 13  | **`smoke:desktop`**     | ❌ **失败**       | 44.4 s      | 5 个 UI 断言失败（4 类），且只跑了 1/8 个套件，见 D-1                    |

> 进程退出码：除第 13 项外全部为 0。`smoke:desktop` 失败使 `npm run check:release` 无法通过。

---

## 2. 缺陷清单

严重度定义：**P1** = 发行/验收门禁红或数据可信度受损；**P2** = 稳定性或可维护性实质受损；**P3** = 文档、卫生与局部不一致。

### D-1（P1）桌面冒烟门禁红：5 个 UI 断言失败（4 类），失败后其余 7 个套件不再执行

**证据**

1. `npm run smoke:desktop` 退出码 1，耗时 44.4 s。运行器把 8 个套件排进串行池（都带 `@test-serial desktop-ui`），第一个文件 `tests/agent.smoke.mjs` 失败后，其余 7 个文件一个都没跑（`.scratch/analysis/gates/smoke-desktop.log` 末尾：`Incomplete run: 1/8 files settled`）。
2. `tests/agent.smoke.mjs`：首次 7 个用例中 2 个失败—
   - `:295` `#jump-to-latest` 期望不可见，实际可见（**只失败一次**，单独复跑通过 → 时序敏感）；
   - `:582` 权限预设 `guarded` 的 `aria-checked` 为 `false`（**两次运行都失败**）。
3. 单独跑其余 7 个套件：45 通过 / 3 失败 / 1 跳过。失败集中在 `tests/desktop.smoke.mjs`：
   - `:972` `#permission-mode` 的值为 **`custom`**，期望 `guarded`（与 `agent.smoke.mjs:582` 同一个可观察事实：权限 chip 报的是「自定义」）；
   - `:1498` 清空后台任务后 `#open-background` 期望仍可见，实际不可见；
   - `:2196` 命令面板选项 `review` 点击超时：Playwright 反复看到 `element was detached from the DOM`，10 秒后放弃。
4. 对照实验：用**全新 profile + 本地假端点**启动同一份 `dist/desktop/main.cjs`，`window.yuantu.presets({type:'get'})` 返回
   `{"current":"guarded","sandbox":{"mode":"native"},"permission":"ask"}`，`#permission-mode` 的值也是 `guarded`。
   因此**默认值本身是正确的**；失败发生在「界面经过若干交互（主题、草稿、设置、语言切换）之后」。

**影响**

- `check:release` / 任何依赖真窗口冒烟的发布门禁在本机不可通过。
- 三块界面行为当前不可信：权限 chip 的状态、后台任务面板的可见性、命令面板的可点击性。
- 由于失败即停，另外 7 个 UI 套件（历史、工作流、知识库、设置、工作区、备份）在门禁里**从未被执行**，它们是否健康没有证据。

**复现**

```powershell
npm.cmd run build
node scripts/run-tests.mjs tests/agent.smoke.mjs
node scripts/run-tests.mjs --continue-on-failure tests/desktop.smoke.mjs
```

**分析（已定位部分 / 未定位部分）**

- 已定位：`:2196` 的原因是命令面板在每次状态更新时**整表重建**（`replaceChildren`），点击目标节点在「等待可点击」期间被替换，Playwright 永远等不到稳定节点。这对真人同样意味着快速点击可能点空。
- 未定位：`:972` 的 `custom`。干净启动探针证明默认是 `guarded`；要确定是「`presets get` 之后失败回退到 custom」还是「语言切换后重载期间视图尚未到达」，需要在 `renderer-permissions.ts` 的 `render()`/`apply()` 加一次性日志。**在没有定位前不应改断言**——把期望改成 `custom` 会把一个可能的真实回归固化下来。

**建议**

1. `renderer-permissions.ts`：`presets({type:'get'})` 失败时把错误显示出来（现在是静默 `custom`），并在视图到达前保持 `pending` 锁，而不是渲染成 `custom`。
2. `desktop.smoke.mjs:972`：等待一个明确的「预设视图已到达」信号（例如 `#permission-trigger[data-preset]` 存在），而不是只等 `#permission-mode` 不 disabled。
3. `:1498` 先确认产品语义：清空后台任务后按钮应当消失还是保留？两种都可以，但断言与实现必须只保留一种。
4. 命令面板改为差量更新，或在重建前保留节点身份。
5. CI 的冒烟入口改用 `--continue-on-failure`，让一次运行暴露全部 UI 失败（与 D-3 同源）。

---

### D-2（P1）Windows 进程树终止把「进程已经退出」误判为失败，并覆盖真正的失败原因

**证据**

- `packages/tools/process.ts:11-36`：Windows 分支执行 `taskkill /PID <pid> /T /F`，只在退出码为 0 时 resolve，否则 reject：
  `Process tree termination failed; descendant processes may still be running`。
- 实测：对一个**已经退出**的 PID 执行同样的 `taskkill`，退出码是 **128**，输出 `ERROR: The process "…" not found.`
- 全量测试第一次运行在 `tests/office-preview.test.ts:153` 失败：
  `Office preview cleanup failed: Error: Process tree termination failed; descendant processes may still be running`；
  单独重跑该文件 **9/9 通过**（5.88 s），在 8 并发下该文件耗时 9.06 s。
- `packages/office/preview.ts:180-187`：`stop()` 先用 `failure ??= reason` 记录主因（例如 `Office preview timed out`），随后 `killTree().catch()` 又**无条件** `failure = new Error('Office preview cleanup failed: …')`，因此清理阶段的误报会覆盖真正的超时原因。

**影响**

- 偶发测试失败：本次因此让 249 个文件的运行在 109 个处停止，多花约 12 分钟（见《全量测试耗时统计》第 9 节）。
- 用户可见的错误信息是「清理失败」而不是「预览超时」，排查方向被带偏。
- `terminal.ts`、`background.ts`、`pty-provider.ts` 都调用同一函数；`background`/`terminal` 各自吞掉错误并标记 `cleanupFailed`，但 `preview` 会把它变成一次失败。

**复现**

```powershell
node scripts/run-tests.mjs --concurrency=8 tests/office-preview.test.ts   # 负载下偶发
node scripts/run-tests.mjs tests/office-preview.test.ts                  # 单独跑通过
# taskkill 对已退出 PID 的退出码
$p = Start-Process cmd.exe -ArgumentList '/c exit 0' -PassThru -Wait
Start-Sleep -Milliseconds 200
taskkill.exe /PID $p.Id /T /F; $LASTEXITCODE   # 128
```

**建议**

1. `killTree`：把 `taskkill` 的 128（进程不存在）视为成功；只在其它非零码且进程仍存在时失败。若无法区分，可在失败前用 `process.kill(pid, 0)` 复核一次。
2. 5 秒超时分支同样要先复核进程是否存在，避免慢机器上把正常终止报成失败。
3. `preview.ts`：清理错误不得覆盖主因（改成 `failure ??= cleanupError` 或把清理错误附在 `cause` 上）。
4. 增加回归测试：对一个已经退出的子进程调用 `killTree`，必须 resolve。

---

### D-3（P2）默认「失败即停」：一次失败掩盖其余 140 个文件，且不写耗时历史

**证据**

- `scripts/test-scheduler.mjs:209-233`：`if (… || (failed && !continueOnFailure) || …) continue`，并且 worker 循环条件同样检查 `(!failed || continueOnFailure)`。任何一个文件失败后，调度器不再派发新文件，只等已在跑的文件收尾。
- 第一次全量运行：`109/249` 文件后停止，`complete: false`，退出码 1；`run-tests.mjs:225` 只在 `metadata.passed` 时写耗时历史，因此失败运行不会更新派发顺序。
- 本次 `--continue-on-failure` 的第二次运行：249/249 完成、0 失败、写出 249 条历史。

**影响**

- CI 一次只暴露**第一个**失败；其余失败要等修完再跑一轮才知道。
- 一次偶发就把 12 分钟的测量/验收作废（D-2 已经发生过一次）。
- 耗时历史无法积累，长文件优先派发的收益被推迟。

**建议**

- CI 的 `check` job 与 `smoke:release` 都改用 `--continue-on-failure`，并由报告里的 `failed`/`incomplete` 决定退出码（二者已经是两个字段）。
- 本地 `npm test` 保留「失败即停」作为快速反馈是合理的；但文档应写明两个入口的差异。

---

### D-4（P2）113 条跳过中有 95 条在报告里没有原因

**证据**

- 统计自 `.scratch/analysis/full2-timings.ndjson`：跳过 113 条，其中 **95 条** `skipReason` 为字符串 `"true"`（即调用 `t.skip()` 未传原因）。
- 其余 18 条有明确原因：macOS Seatbelt ×5、真实语言服务器 ×4、Office 脚本授权 ×2、AppContainer 探针 ×2、Chromium ×1、POSIX 进程组 ×1、POSIX 权限位 ×1、symlink ×1、esbuild 写入被拒 ×1。
- README 的自我描述是「部分测试会因平台或外部依赖缺失而**带原因自我跳过**」——95 条与这句话不一致。

**影响**

- 报告读者无法区分「产品暂停导致的设计性跳过」和「环境缺失导致的意外跳过」；后者可能掩盖真实回归。
- 与 D-5 叠加：暂停面的测试被静默跳过，看起来像绿灯。

**建议**

- 统一要求 `t.skip('<reason>')`；可在 `scripts/check-test-isolation.mjs` 里加一条静态规则：`tests/**` 中不允许无参 `skip()`（允许 `skip(reason)`）。
- 把「产品暂停」写成共享常量（例如 `PRODUCT_SCOPE.cli` 对应的一句固定文案），避免 95 处各写各的。

---

### D-5（P2）暂停的产品面留下死代码与仍可调用的 IPC

**证据**

- `apps/desktop/daily-backups.ts:103` 的 `tick()` 在仓库内**只有测试调用**（`grep '\.tick\('` 结果中生产代码只有 Host 调度器自己的 `tick`）；`tests/daily-backups.test.ts` 仍用 9 个用例覆盖这条不可达路径。
- `apps/desktop/preload.ts:13` 仍向渲染层暴露 `backups`，`apps/desktop/main.ts:712` 仍注册 `yuantu:backups`（get/create/restore）；但界面已无备份入口（README 明确「不提供备份页面或每日备份调度」）。
- MCP 服务管理：`PRODUCT_SCOPE.mcpManagement = false`，`apps/desktop/renderer.ts:635` 因此不初始化 MCP 面板，`main.ts:843` 直接拒绝 IPC；但 `renderer-mcp.ts`（475 行）、`mcp-settings.ts` 与 10 个 MCP 设置用例仍在，运行时全部跳过。

**影响**

- 维护成本：读者需要判断哪些代码是活的；9 + 10 个用例永远不产生信号。
- 安全面：`yuantu:backups` 仍可从渲染层调用（虽然渲染层本身受 sender 校验保护，且没有 UI 入口）。
- 与 D-4 一起造成「覆盖率与用例数看起来很高，实际执行面更小」。

**建议**

- 暂停面统一处理：要么在 `preload` 层就按 `PRODUCT_SCOPE` 不暴露、在 `main` 层不注册，要么在 README 的「暂停入口」表里逐项列出保留原因与恢复条件。
- 对不可达的 `DailyBackups.tick` 与对应测试，标注 `// paused:` 或直接删除；保留时至少让测试文件头声明它覆盖的是保留面。

---

### D-6（P3）README 与代码的三处可验证漂移

| #   | README 说法                                                                                                       | 代码事实                                                                                                                                                                                                           |
| --- | ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | `README.md:762`：「默认并发 min(4, availableParallelism)，可显式覆盖」                                            | `scripts/run-tests.mjs:45`：`Math.min(8, availableParallelism())`，注释还解释了为什么从 4 提到 8                                                                                                                   |
| 2   | `README.md:556`：preload 暴露「一组 invoke 通道与**四条**订阅通道（整快照、助手流式文本、子代理增量、统计增量）」 | `apps/desktop/preload.ts` 实际有 **5 条**订阅：上述四条 + `subscribePresets`（权限预设）                                                                                                                           |
| 3   | `README.md:570`「设置页分通用、模型、**MCP** 三组」、`:378`「桌面设置只提供通用设置、模型设置与 **MCP 服务**」    | `PRODUCT_SCOPE.mcpManagement = false`；`apps/desktop/renderer.ts:635` 条件初始化，MCP 组当前**不渲染**；`main.ts:843` 直接返回「temporarily disabled」。README `:46` 自己也写了「MCP 服务管理…暂时停用」，前后矛盾 |

**影响**：文档是该项目的主要卖点之一（数字由门禁保证），这三处是门禁覆盖不到的自由文本，容易被当成事实引用。

**建议**：修正三处文案；把可机械核对的项（订阅通道数量、设置页分组）纳入 `docs:facts` 或 `references:check` 的断言范围。

---

### D-7（P3）三个测试文件里有 6 行注释是乱码（UTF-8 被按 GBK 解读后回写）

**证据**（按 `read` 工具的真实解码，非控制台显示问题；用 Node 逐字符复核过码点）

| 文件:行                                  | 内容片段                                                        |
| ---------------------------------------- | --------------------------------------------------------------- |
| `tests/database-maintenance.test.ts:300` | `搂7.2.8 鈥?the history budget…`                                |
| `tests/database-maintenance.test.ts:302` | `…the *upgrade* stop 鈥?the`                                    |
| `tests/database-maintenance.test.ts:350` | `// gone 鈥?so the caller either fails copying…`                |
| `tests/search-lifecycle.test.ts:5`       | `…two classic defects 鈥?closing it while…`                     |
| `tests/search-lifecycle.test.ts:181`     | `…coverage is not complete 鈥?and the cursor…`                  |
| `tests/subagents-fork.test.ts:5`         | `…when its first request is built 鈥?which is only observable…` |

**影响**：只影响注释可读性与仓库编码卫生，不影响执行；但它说明某次编辑曾经用非 UTF-8 编码回写过文件。

**建议**：用 UTF-8 重写这 6 行（把 `鈥?` 还原为 `—`、`搂` 还原为 `§`）；在 `format:check` 或独立脚本里禁止 U+FFFD 与常见 mojibake 序列。

---

### D-8（P3）5 处 `process.env.YUANTU_*` 绕过 `parseSetting()`

**证据**

- `packages/knowledge/store.ts:100`（`YUANTU_KNOWLEDGE_DB`）
- `packages/knowledge/memory.ts:40`（`YUANTU_MEMORY_DIR`）
- `packages/office/preview.ts:24`（`YUANTU_LIBREOFFICE_PATH`）
- `packages/tools/index.ts:103`（`YUANTU_LSP_AFTER_EDIT`）、`:112`（`YUANTU_SEARCH_RG`）

这些名字都在 `packages/protocol/settings.ts` 的 `ENVIRONMENT` 表里登记，但读取时没有走统一的 `parseSetting()`（类型/范围校验）。

**影响**：目前都是 string/开关类，风险低；但「新增一个设置」的路径不唯一，未来加范围校验时容易漏。

**建议**：统一改为 `parseSetting(process.env, 'NAME')`；`ENVIRONMENT` 表已经提供类型与描述。

---

### D-9（P3）`#%` 路径回归在本机被永久跳过

**证据**：`tests/native-sandbox-bundle.test.ts:74-110` 用 `mkdtemp(path.join(tmpdir(), 'yuantu-search #%-'))` 构造带 `#`、`%` 的路径，esbuild 写入被系统拒绝（`Access is denied`），测试据此 `t.skip()`。原因在文件注释里解释为「checkout 的完整性标签把 `node_modules` 标成 Low」。

**影响**：该回归验证的是「打包后的 worker 在含特殊字符的路径下能加载」，本机从未真正执行；跳过判定依赖错误文本，esbuild 换错误措辞就会从「跳过」变成「失败」（或反之）。

**建议**：在不受完整性标签影响的目录（或 CI）固定跑这一条；把跳过条件改成结构化探测（先试写临时文件），而不是匹配错误字符串。

---

### D-10（P3）`docs/` 被整目录清空，且没有门禁会提醒

**证据**：`HEAD` 提交 `3c2e26b`「fix: 修改文档」删除了 8 个文档、1,799 行（架构评估、缺陷清单、全量测试记录、两份计划）；`docs/` 现为空目录。`scripts/check-references.mjs` 的注释明确写「A clone may have no `docs/`… that is not a dangling reference」，因此删空不会触发任何门禁。

**影响**：架构决策与历史缺陷记录只能从 git 历史取回；新读者拿不到「为什么这样设计」。本次三份文档属于重建。

**建议**：在评审流程里把「删除 docs/ 下全部记录」视为需要说明的变更；或让 `docs:check` 至少要求 `docs/` 里存在一份「当前索引」。

---

### D-11（P3）命令面板在状态更新时整表重建，点击目标会被替换

**证据**：`tests/desktop.smoke.mjs:2196` 的点击日志显示目标节点 `#command-option-9` 被反复 `detached from the DOM`，直到 10 秒超时；渲染层按区块 key 做差量，但命令面板采用 `replaceChildren` 整体替换。

**影响**：真实用户在面板刷新瞬间点击可能落空；自动化测试无法稳定点击（与 D-1 的第三个失败同源）。

**建议**：命令列表按项 key 复用节点；或在打开/刷新期间保留已渲染节点直到下一次用户输入。

---

## 3. 风险与技术债（当前未造成失败，但值得排期）

| #   | 风险                        | 证据/位置                                                                                                                       | 说明                                                                              |
| --- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| R-1 | 包级双向值导入 8 组         | `core↔tools`、`core↔workspaces`、`core↔storage`、`tools↔resources`、`tools↔mcp`、`tools↔office`、`tools↔knowledge`、`tools↔lsp` | 文件级无环（门禁 0），但包无法独立版本化/搬进程；未来做外置工具进程要先拆环       |
| R-2 | 巨型单文件                  | `core/subagents.ts` 1,804 行、`client/session-controller.ts` 1,560、`core/agent.ts` 1,507、`carrier/service.ts` 1,311           | 分支多、回归面大；已有模块化倾向但仍有集中点                                      |
| R-3 | 非 registry 依赖            | `package.json`：`xlsx` 来自 `https://cdn.sheetjs.com/...tgz`                                                                    | lockfile 有 integrity，但供应链来源与可用性依赖第三方 CDN                         |
| R-4 | 常规安装包未签名            | `electron-builder.config.cjs`：`asar: false`、`win.signExecutable: false`、NSIS 默认不签名                                      | 常规线适合内测；正式发行必须走 `package:windows:protected`（签名后核对运行时）    |
| R-5 | Windows 基础沙箱是部分边界  | `packages/tools/windows-sandbox/README.md` 与 README「已知边界」                                                                | 读与网络不受限；严格只读/断网请求会被拒绝而不是降级——表述诚实，但不能当强隔离     |
| R-6 | AppContainer 未启用且缺证据 | 2 条跳过：WFP 网络验收 `WFP error 2150760453`、容器内 stdio 兼容性未完成                                                        | 原型存在，不能作为隔离能力声明                                                    |
| R-7 | 覆盖率依赖 Node 24 内部 API | `scripts/test-coverage.mjs`、README 开发章节                                                                                    | 升级 Node 主版本前必须复核合并接口                                                |
| R-8 | 文件内用例强制串行          | `scripts/test-scheduler.mjs:94-96`：`--test-concurrency=1`                                                                      | 单文件内的慢用例无法并行；这是 `coding-evaluation` 196 s 无法被摊平的结构原因之一 |
| R-9 | 派发依赖耗时历史            | `.scratch/cache/test-durations-*.json`                                                                                          | 历史只在完整成功运行后更新（已是缓解），但一次错误的历史会自我强化数轮            |

---

## 4. 本次未验证的清单

这些不是失败，但在本次机器/环境下**没有执行**，不能计入「已验证」：

| 类别                                                       | 条数     | 原因                                         |
| ---------------------------------------------------------- | -------- | -------------------------------------------- |
| 暂停的产品面（CLI / Web / ACP / MCP 设置 / Python SDK 等） | 95       | `PRODUCT_SCOPE` 关闭，测试主动跳过           |
| macOS Seatbelt 内核隔离                                    | 5        | 需要 macOS                                   |
| 真实语言服务器（TS / Python / Go / Rust）                  | 4        | 本机未安装对应服务器                         |
| Office COM 创建与编辑                                      | 2        | 本机脚本授权策略拒绝加载自动化脚本           |
| AppContainer 网络与 stdio 验收                             | 2        | WFP 探针失败、容器内探针未完成               |
| 浏览器工具                                                 | 1        | 未安装 Playwright Chromium                   |
| `#%` 特殊路径打包回归                                      | 1        | esbuild 写入被系统拒绝                       |
| 桌面冒烟其余套件                                           | 7 个文件 | `smoke:desktop` 首文件失败即停（见 D-1/D-3） |
| 覆盖率门禁、打包/签名/安装                                 | —        | 本次未运行（耗时与外部依赖）                 |

---

## 5. 建议的修复顺序

1. **D-2（进程终止误判）**：改动小、收益直接，能立刻消掉一类偶发失败。
2. **D-1 + D-3（冒烟门禁 + 失败即停）**：先让 CI 用 `--continue-on-failure` 取得完整失败清单，再逐条修 UI；`custom` 那条在定位前不要改断言。
3. **D-6（文档漂移）**：三处文案，十分钟内可改完，且能避免后续误读。
4. **D-5 + D-4（暂停面清理 + 跳过原因）**：让「绿灯」重新等价于「这些能力被验证过」。
5. **D-7 / D-10 / D-8 / D-9**：编码卫生、文档留存、设置读取统一、特殊路径回归环境。
6. **R-1 / R-2**：作为中期重构项，不阻塞当前交付。

---

## 6. 证据文件索引

| 内容                           | 路径                                                                                                                 |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| 门禁逐项结果（含耗时、退出码） | `.scratch/analysis/gates.jsonl`                                                                                      |
| 各门禁原始输出                 | `.scratch/analysis/gates/*.log`                                                                                      |
| 桌面向导失败的完整日志         | `.scratch/analysis/gates/smoke-desktop.log`、`.scratch/analysis/agent-smoke.log`、`.scratch/analysis/smoke-rest.log` |
| Windows 沙箱验收输出           | `.scratch/analysis/gates/check-windows-sandbox.log`、`.scratch/windows-sandbox-acceptance/`                          |
| 全量测试逐用例耗时             | `.scratch/analysis/full2-timings.ndjson`（+ `.meta.json`）                                                           |
| 首次（失败）运行的数据         | `.scratch/analysis/full-timings.ndjson`（+ `.meta.json`）                                                            |
| 每文件耗时历史                 | `.scratch/cache/test-durations-win32-x64-node24.json`                                                                |
