# 全量测试报告（2026-10-17，realm 隔离加固工作树）

- 检查对象：`E:\agent-desktop\YuanTu-Foundry`，`HEAD` = `3c2e26b`（工作树 61 个文件已修改 + 16 个新路径：9 个新源码、7 个新测试、`docs/`）
- 机器：AMD Ryzen 9 4900HS（8 物理核 / 16 逻辑核）/ 15.4 GB / Windows 11 家庭中文版 10.0.26300 / Node v24.19.0 / npm 11.17.0
- 全量命令：`node scripts/run-tests.mjs --timings=.scratch/full-test/timings.ndjson`，并设 `FOUNDRY_TEST_CONTINUE_ON_FAILURE=1`（CI 语义：一个文件失败不阻断其余文件；`npm test` 默认在第一个失败文件处停下）
- 证据目录：`.scratch/full-test/`（13 份门禁日志、`tests.log`、`timings.ndjson` 与同名 `.meta.json`、汇总脚本产出的 `summary.json`）

**结论：13 道门禁 12 绿 1 红。红的只有全量测试：2,683 个用例中 9 个失败，全部集中在 3 个文件，且 9 个失败是同一个原因——realm 隔离加固把「逃逸」从「可成功但落在受限进程」改成「直接拒绝」，而这 3 个文件仍在断言加固之前的旧语义。**

---

## 1. 结论摘要

| 指标                       | 实测值                                               |
| -------------------------- | ---------------------------------------------------- |
| 门禁                       | **12 / 13 通过**（唯一红：全量测试）                 |
| 测试文件                   | **256**（并行池 244 / 串行池 12）                    |
| 测试用例                   | **2,683**                                            |
| 通过 / 失败 / 跳过         | **2,561 / 9 / 113**（跳过率 4.2%）                   |
| 全量墙钟                   | **723,215.9 ms ≈ 12 分 3 秒**                        |
| 失败根因                   | 1 个：realm 隔离后 `Function` 构造被禁，旧测试未同步 |
| 与上次全量（同日早先一笔） | +7 个测试文件 / +54 个用例 / 墙钟 +6.2 s             |

一句话：**代码门禁全绿、桌面冒烟从红转绿，唯一红的是 9 个没跟着加固一起改的旧安全测试；它们失败恰恰证明加固生效，而不是产品回归。**

---

## 2. 门禁结果总表

| #   | 门禁             | 命令                            | 结果                | 耗时        |
| --- | ---------------- | ------------------------------- | ------------------- | ----------- |
| 1   | 格式             | `npm run format:check`          | ✅ 通过             | 45.4 s      |
| 2   | 文档事实         | `npm run docs:check`            | ✅ 通过             | 1.8 s       |
| 3   | 文档引用         | `npm run references:check`      | ✅ 通过             | 0.7 s       |
| 4   | 导入环           | `npm run cycles:check`          | ✅ 通过             | 1.8 s       |
| 5   | 中文漏网         | `npm run i18n:check`            | ✅ 通过             | 0.8 s       |
| 6   | 测试隔离         | `npm run test:isolation:check`  | ✅ 通过             | 2.0 s       |
| 7   | 类型             | `npm run typecheck`             | ✅ 通过             | 3.9 s       |
| 8   | **全量测试**     | `node scripts/run-tests.mjs`    | ❌ **9 失败**       | **723.2 s** |
| 9   | 构建             | `npm run build`                 | ✅ 通过             | 10.0 s      |
| 10  | 编译产物冒烟     | `npm run smoke:client`          | ✅ 3/3              | 5.7 s       |
| 11  | 确定性基准       | `npm run bench:check`           | ✅ 13 条规则        | 9.1 s       |
| 12  | Windows 沙箱验收 | `npm run check:windows-sandbox` | ✅ 54/54            | 207.1 s     |
| 13  | 桌面冒烟         | `npm run smoke:desktop`         | ✅ 55 通过 / 1 跳过 | 323.2 s     |

纯串行跑完这一套约 **22 分 15 秒**（各门禁耗时之和，不含 npm 进程启动的少量重叠）。第 8、12、13 项耗时取自各日志的 `phaseWall`；其余为 `Measure-Command` 实测。

---

## 3. 全量测试的数据

### 3.1 规模

| 项               | 值                                                                       |
| ---------------- | ------------------------------------------------------------------------ |
| 文件             | 256（244 并行 + 12 串行，按 `@test-serial` 资源声明分区）                |
| 用例             | 2,683（通过 2,561 / 失败 9 / 跳过 113 / 取消 0 / todo 0）                |
| 每文件平均用例   | 10.5                                                                     |
| 有耗时历史的文件 | 249（按历史墙钟降序派发，`order=duration`）                              |
| 新增测试文件     | 7 个，合计 28 个用例（7 个新文件之外另有 26 个新用例来自被改的既有测试） |

7 个新文件是：`approval-boundary`、`checkpoint-due`、`deferred-tools`、`desktop-hook-trust`、`process-tree`、`rate-gate`、`stream-checkpoint`（均为 `tests/*.test.ts`）。它们合计墙钟 16.2 s，所以用例增加 54 个、总墙钟只增加 6.2 s。

### 3.2 时间构成

```text
总墙钟 723.22 s
├─ 准备（参数解析、发现、分区、耗时历史）        0.26 s   (0.04%)
├─ 并行阶段 244 文件 × 8 槽                   369.96 s  (51.2%)
└─ 串行阶段 12 文件 × 1 槽                    352.26 s  (48.7%)
```

- **并行池几乎没有空转**：244 个文件的墙钟之和 2,957.9 s ÷（369.96 s × 8）= **99.94%**（长度降序派发把尾部空隙压到最小）。
- **串行池就是它自己**：12 个文件墙钟之和 352.25 s 与阶段墙钟 352.26 s 相等，说明串行阶段没有额外等待。
- **文件级固定开销**：3,310.2 s（全部文件墙钟之和）− 2,604.8 s（用例耗时之和）= **705.4 s**，平均 **2.76 s/文件**（Node 启动、私有 tmp/home/state 建立、隔离探针、报告写盘、进程树收敛、目录清理）。
- **相对串行的加速比**：3,310.2 s ÷ 723.2 s = **4.6×**。

### 3.3 分布

| 区间    | 文件数 | 占比  |
| ------- | ------ | ----- |
| < 1 s   | 31     | 12.1% |
| 1–2 s   | 27     | 10.5% |
| 2–5 s   | 63     | 24.6% |
| 5–10 s  | 59     | 23.0% |
| 10–20 s | 34     | 13.3% |
| 20–40 s | 25     | 9.8%  |
| ≥ 40 s  | 17     | 6.6%  |

分位数：p50 = **5.55 s**，p75 = 12.38 s，p90 = 29.45 s，p95 = 50.39 s，p99 = 120.97 s，最大 **214.17 s**。最慢的 10 个文件贡献 **33.6%** 的总工作量。

最慢的 10 个文件：

| 文件墙钟 | 用例数 | 用例耗时 | 文件开销 | 文件                                        |
| -------- | ------ | -------- | -------- | ------------------------------------------- |
| 214.2 s  | 22     | 213.3 s  | 0.9 s    | `tests/coding-evaluation.test.ts`           |
| 128.8 s  | 27     | 123.0 s  | 5.7 s    | `tests/sandbox-windows.test.ts`             |
| 121.0 s  | 16     | 115.6 s  | 5.4 s    | `tests/host-workflows.test.ts`              |
| 115.5 s  | 43     | 114.2 s  | 1.3 s    | `tests/client.test.ts`                      |
| 107.6 s  | 9      | 101.9 s  | 5.7 s    | `tests/workspace-orphans.test.ts`           |
| 103.8 s  | 16     | 98.3 s   | 5.4 s    | `tests/workspace-recovery.test.ts`          |
| 101.9 s  | 15     | 99.8 s   | 2.1 s    | `tests/workspace-apply.test.ts`             |
| 88.6 s   | 15     | 83.1 s   | 5.6 s    | `tests/host-workspaces.test.ts`             |
| 69.6 s   | 8      | 69.2 s   | 0.4 s    | `tests/sandbox-appcontainer-native.test.ts` |
| 59.9 s   | 12     | 58.8 s   | 1.1 s    | `tests/task-workflow.test.ts`               |

---

## 4. 9 个失败：清单与证据

| #   | 文件:断言行                               | 用例                                                                               | 期望                                                         | 实际                                            |
| --- | ----------------------------------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------ | ----------------------------------------------- |
| 1   | `tests/program-process.test.ts:18`        | a VM escape runs in another process                                                | `isError === false`（逃逸成功，pid 属于别的进程）            | `isError === true` + codegen 错误               |
| 2   | `tests/program-process.test.ts:28`        | a VM escape cannot write through node:fs without a tool approval                   | 输出匹配 `/ERR_ACCESS_DENIED/`                               | 输出匹配不到，只有 codegen 错误                 |
| 3   | `tests/program-process.test.ts:56`        | a forged RPC cannot reach a tool outside the exposed catalog                       | 输出匹配 `/outside this run catalog/`                        | 伪造帧根本没发出，先被 codegen 拦下             |
| 4   | `tests/program-process.test.ts:87`        | program disconnect preserves known results and waits for an in-flight tool cleanup | 期望 reject `ToolCleanupError`                               | `Missing expected rejection`（程序没死成）      |
| 5   | `tests/program-process.test.ts:177`       | a raw output flood is stopped before it can become an unbounded Host log           | 输出匹配 `/RPC\|JSON/`                                       | 只有 codegen 错误                               |
| 6   | `tests/program-process.test.ts:269`       | a disconnected workflow waits for its child and refuses automatic continuation     | 期望 reject `ToolCleanupError`                               | `Missing expected rejection`                    |
| 7   | `tests/program-process.test.ts:290`       | a tool wrapper cannot replace the program workspace identity                       | `isError === false`（`process.cwd()` 即工作区）              | `isError === true` + codegen 错误               |
| 8   | `tests/program-process-native.test.ts:40` | a Windows program uses the selected backend and RPC writes still require approval  | `isError === false` + `permission.has('fs.write') === false` | `isError === true`，写入工具本身已成功一次      |
| 9   | `tests/host-program-process.test.ts:59`   | a real Host runs Windows PTC with durable receipts and no direct fs write grant    | 输出匹配 `/true:false/`                                      | 输出是 `run_code failed: …`，但两条回执都已落库 |

9 条的实际输出都是同一句话：

```text
run_code failed: Code generation from strings disallowed for this context

[tools] N call(s) before the failure:
  read_file({"path":"seed.txt"}) -> 1: seed (8ms)
  write_file({"path":"approved.txt","content":"approved"}) -> Created approved.txt (18ms)
```

`[tools]` 段是这次加固另一项改动的产物：失败时列出失败前已完成的工具调用。它在第 8、9 条里正好证明**工具链、审批与回执都正常**——坏的只是「用逃逸去观察进程」这个测试手段。

---

## 5. 根因：加固改了语义，测试没跟上

### 5.1 代码证据

`packages/tools/code-worker.ts` 现在这样建上下文（同文件还先移除了本 realm 的网络全局）：

```ts
const context = vm.createContext(vm.constants.DONT_CONTEXTIFY, {
  codeGeneration: { strings: false, wasm: false },
});
```

- **加固前**：注入的 `tools.*` / `console.*` 都是 worker realm 的函数，`console.log.constructor` 拿到的是 worker 的 `Function`，于是 `constructor('return process')` 能逃逸。旧测试正是靠这一点观察「逃逸后落在独立子进程、没有 fs 写权限、被 Node 权限模型限制」。
- **加固后**：`guestRuntime` 在上下文内部自建 `tools`、`console`、`Promise`、`Error`，跨界只传字符串、数字、布尔；`Function` 也是 guest realm 的，而该 realm 禁止字符串代码生成，所以 `constructor('return process')` 直接抛 `Code generation from strings disallowed for this context`。

`code-worker.ts` 的文件头注释同步改成了「No object of this realm is ever reachable from the program」——**这是设计目标，不是副作用**。

### 5.2 三条证据说明这是测试陈旧，不是产品回归

1. **同一语义已有新测试并全绿**：`tests/run-code.test.ts`（本次被修改）新增 8 条逃逸路线（工具函数、tools 对象、console 函数、console 对象、工具调用的 Promise、工具调用的 Error、`globalThis`、原型），断言 `/^blocked: (no constructor|Code generation from strings disallowed)/`，8 条全部通过。
2. **这 3 个失败文件不在本次改动里**：`git status` 中没有它们；同一批改动里 `program-runner.test.ts`、`run-code.test.ts`、`deferred-tools` 等都改过并全绿，说明是漏改而不是设计冲突。
3. **HEAD 上它们是绿的**：上一份同日全量记录（`3c2e26b` 时测得 2,629 用例 0 失败；该记录文件已随提交 `e3f524b` 删除，内容仍可从提交 `09cd7fa` 取回）；本次同一 `HEAD` 加未提交改动后才出现这 9 个失败，失败断言全部是「逃逸应当成功」。

### 5.3 未受影响的同类覆盖

`unavailable native program backend`、`program RPC rejects duplicate ids…`、`console truncation`、`native/ptc program records each task effect` 这 5 条同文件用例通过——它们不依赖逃逸。

---

## 6. 修复建议

### 6.1 六个只需改「观察手段」（低风险，断言强度不降）

| 用例                      | 改法                                                                                                                                                                                                                  |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| #1 `:18`、#8 native `:40` | 逃逸包进 `try/catch`，返回 `'blocked: ' + error.message`；断言 `isError === false` 且内容匹配 `/blocked: Code generation from strings disallowed/`。进程隔离由 `code-process.ts` 的启动方式和 `process-tree` 测试保证 |
| #2 `:28`                  | 同上取 `blocked`，并保留 `assert.rejects(readFile(destination), /ENOENT/)`——文件确实没落盘才是真正的安全属性                                                                                                          |
| #7 `:290`                 | 去掉 `process.cwd()`：`root` 与 `other` 各放一份同名不同内容的文件，程序用相对路径 `read_file`，断言读到 `root` 的副本。若此时读到 `other`，说明 hook 的作用域重写确实影响到了程序侧，要先判定那是不是预期            |
| #9 host `:59`             | 把 `p.permission.has('fs.write')` 换成 catch 里的 `'blocked'`，期望值由 `/true:false/` 改为 `/true:blocked/`；回执 `2 条 known`、`approved.txt` 内容的断言原样保留                                                    |

### 6.2 三个需要新测试缝隙（要选方向）

| 用例                     | 问题                                                   | 可选方案                                                                                                                                                                                                                                                                      |
| ------------------------ | ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| #3 forged RPC `:56`      | 程序已经拿不到 `worker_threads.parentPort`，无法伪造帧 | (a) 在 transport 层构造假 `ProgramProcess`（`connectCodeProcess` 是导出的），注入伪造 `call` 帧，断言 host 以 `outside this run catalog` 拒绝；(b) 保留端到端但只断言程序拿不到端口                                                                                           |
| #5 output flood `:177`   | 程序无法再直接写 `process.stdout`                      | 同 (a)：向假进程注入超过 `FRAME_BYTES` / `TOTAL_BYTES` 的帧，断言 `/Program RPC output limit exceeded/`。不建议直接删——它守的是帧上限，`console` 截断测试守的是另一条边界                                                                                                     |
| #4 `:87`、#6 `:269` 断连 | 程序无法再 `process.exit(88)` 自杀                     | (a) 给 fixture 加缝隙，把 `ProgramProcess` 交给测试并在工具调用在途时 `kill`，保住「进程猝死」这条路径；(b) 改用 abort `context.signal`，断言同样的 `ToolCleanupError` + `journal: unknown`，覆盖面变成「运行被取消」——两者共用 `run-code.ts` 的 `finish()`，但不再是同一场景 |

### 6.3 建议顺序

先改 6.1（6 个用例，纯断言层，不碰生产代码），确认 `tests/run-code.test.ts` 与 `program-process*` 一起绿；再就 6.2 的三条定方向——它们决定「进程猝死 / 伪造帧 / 输出洪水」这三条防线以后由哪一层来测。

---

## 7. 复现

```powershell
# 1) 全量（CI 语义：失败不中断，列出全部失败）
$env:FOUNDRY_TEST_CONTINUE_ON_FAILURE='1'
node scripts/run-tests.mjs --timings=.scratch/full-test/timings.ndjson

# 2) 只跑这 3 个失败文件
node scripts/run-tests.mjs --continue-on-failure tests/program-process.test.ts tests/program-process-native.test.ts tests/host-program-process.test.ts

# 3) 机制的最小复现：guest realm 禁止字符串代码生成
@'
import vm from 'node:vm';
const context = vm.createContext(vm.constants.DONT_CONTEXTIFY, {
  codeGeneration: { strings: false },
});
try {
  vm.runInContext('({}).constructor.constructor("return Date.now")()', context);
} catch (error) {
  console.log(error.message);
}
'@ | node --input-type=module
```

第 3 条输出 `Code generation from strings disallowed for this context`，即 9 个失败的同一句错误。

---

## 8. 本次运行中其它可观察事实

- **桌面冒烟从红转绿**：上一次审计（`docs/open-defects-2026-10-17.md` 的 D-1）记录 `smoke:desktop` 有 5 个 UI 断言失败且只跑了 1/8 个套件；本次 8 个套件全跑，56 用例 55 通过 / 1 跳过 / 0 失败。「权限 chip 显示 custom」「清空后台任务后按钮消失」「命令面板点击超时」三处都不再复现，说明 `renderer-permissions.ts`、`renderer-commands.ts` 的改动确实修掉了它。
- **Windows 沙箱验收 54/54**：13 个并行 + 41 个串行检查全绿（204.3 s），本次 `process.ts`、`code-process-entry.ts` 的改动没有破坏沙箱路径。
- **跳过数持平**：113 条（4.2%），与上次全量完全相同，说明新增测试没有靠 skip 换绿。
- **耗时口径**：本文的「墙钟」是调度器为每个文件 spawn `node --test` 子进程的完整时间（含启动、隔离、清理、进程收敛）；「用例耗时」是 Node 自己报告的单条 `test()` 时长。两者不能混用。
- **提速来源**：墙钟只比上次多 6.2 s，靠的是新增文件都很快（7 个文件合计 16.2 s）＋按历史耗时降序派发把并行池填充到 99.94%。

---

## 9. 后续：同日第二次全量测试（已转绿）

- 现场：同日 21:26，工作树已提交为 `b77b3ed`（`git status` 干净，`HEAD` 距本文测量的 `3c2e26b` 已有三个提交）
- 修法（与第 6 节的建议不同，选了「显式测试缝隙」）：`tests/program-process-fixture.ts` 增加 `{ escaped: true }` 选项，程序侧由 `exposeProcessForTests` 注入一个仅测试可见的 `escapedProcess`；同时新增用例「a program cannot reach the runner process through a host-realm constructor」钉住加固本身——三条 constructor 路线都必须 blocked，且默认不注入 `escapedProcess`。
- 结果：**13 道门禁全绿**

| 门禁                                                                                       | 结果                                          | 耗时                          |
| ------------------------------------------------------------------------------------------ | --------------------------------------------- | ----------------------------- |
| 全量测试                                                                                   | **257 文件 / 2,720 用例 / 0 失败 / 112 跳过** | **737.4 s**                   |
| `format:check`                                                                             | ✅                                            | 58.4 s                        |
| `docs:check` / `references:check` / `cycles:check` / `i18n:check` / `test:isolation:check` | ✅                                            | 1.8 / 0.7 / 1.8 / 0.8 / 2.1 s |
| `typecheck` / `build`                                                                      | ✅ / ✅                                       | 4.2 / 10.6 s                  |
| `smoke:client`                                                                             | ✅ 3/3                                        | 6.0 s                         |
| `bench:check`                                                                              | ✅ 13 条规则                                  | 9.3 s                         |
| `check:windows-sandbox`                                                                    | ✅ 54/54                                      | 211.6 s                       |
| `smoke:desktop`                                                                            | ✅ 56 用例 54 通过 / 2 跳过 / 0 失败          | 323.2 s                       |

- 与第一次的差异：多 1 个测试文件（`tests/session-delete-cleanup.test.ts`）、+37 个用例；`program-process.test.ts` 从 12 个用例增加到 14 个（新增的加固用例，加上原来的逃逸观察用例改用测试缝隙）。
- 本文第 4、5 节保留的是**第一次运行的现场记录**（`HEAD` = `3c2e26b` + 61 个已改文件 + 16 个新路径），不再代表当前 `HEAD`；结论以本节为准。
