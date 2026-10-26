# 第四轮真实桌面：真实模型验收与代码检查

> 日期：2026-10-26。仓库：`E:\agent-desktop\YuanTu-Foundry`，HEAD `b87583a`，工作区另有未提交修改。
> 方式：Playwright 驱动真实 Electron 主进程、IPC、Host 子进程和渲染层；模型连接来自本机 `safeStorage` 解密的真实设置，复制到独立 profile 后由真实桌面使用。未调用脚本化模型替代本轮的主路径。
> 隔离：每个套件独立 `--user-data-dir`、`YUANTU_STATE_DIR`、工作区；真实 `%APPDATA%\YuanTu Agent` 只读复制，不写入。测试宿主设 `YUANTU_SANDBOX=host`（不做原生 OS 隔离）和 `YUANTU_SESSION_TITLES=false`（避免额外的标题模型调用），因此证据里的会话标题是提示词原文。
> 模型：`deepseek-flash`（主路径）、`Kimi-K3`（模型切换对照）。
> 产物：`.scratch/desktop-real-models-round4/results/*.json`、`evidence/*.png`、`*.log`。

## 1. 范围与方法

本轮在最新构建（`dist/desktop/main.cjs`）上启动真实客户端桌面，使用真实模型完成对话、模型识别、模型切换、文件工具、浏览器工具、任务草稿与任务执行、重启恢复；同时运行仓库检查和完整测试。

与前三轮的区别：

- 优先验证当前未提交的“当前模型上下文”功能，而不是只看固定回归；
- 任务路径由真实模型自行规划验收条件，暴露了单元测试没有覆盖的副作用账本问题；
- 浏览器工具按产品默认权限走审批卡，不再用 `unconfined` 绕过审批。

## 2. 结果总览

| 检查                                                 | 结果               | 证据                                                                                                                        |
| ---------------------------------------------------- | ------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| 真实桌面启动与基础对话                               | 通过               | `results/launch.json`：`completed`，回答“你好”                                                                              |
| 当前模型上下文可见                                   | 通过               | `results/model-context.json`：快照含 `{"model":"deepseek-flash","protocol":"openai"}`，模型回答 `deepseek-flash`            |
| 模型切换与 last-wins                                 | 通过               | `results/model-switch.json`：deepseek-flash → Kimi-K3 → deepseek-flash，回答依次正确，快照 1→2→3 条                         |
| 文件写入与读回                                       | 通过               | `results/tools.json`：`round4-tool.txt` 落盘，内容与标记一致，`read_file` 读回一致                                          |
| 重启恢复                                             | 通过               | `results/resume.json`：10 条消息、2 条工具结果、1 条模型快照恢复；回答 `round4-tool.txt`；未重复追加模型快照                |
| 浏览器工具（真实模型 + 审批卡）                      | 通过               | `results/browser2.json`：标题 `ROUND4-BROWSER-OK`、PNG 签名 `89504e47`、工具结果正常关闭                                    |
| `/task` 草稿                                         | 通过               | `results/task-poll.json`：标题不再带 `Goal:`，面板在模型规划结束前出现，任务 `pending`                                      |
| 任务执行（修复前）                                   | 失败，已修         | `results/task-run.json`：全部步骤完成、验收通过，仍被记为 `needs_review`：“Task side effect outcome unknown…”               |
| 任务重试（修复后）                                   | 通过               | `results/task-retry.json`：`completed`，两项验收均通过，`notes.md` 内容正确                                                 |
| 新任务（修复后）                                     | 通过/需人工确认    | `results/task2.json`：副作用账本全部 `completed`；任务因模型自行加入的人工验收项和不可执行检查停在 `needs_review`（见 4.3） |
| 会话菜单与重命名                                     | 通过               | `results/rename.json`：重命名生效；菜单仅“重命名/删除”                                                                      |
| 格式/文档/引用/依赖环/分层/国际化/类型/Lint/隔离检查 | 通过               | `check-final.log`                                                                                                           |
| 完整行为测试                                         | 通过               | 最终 `npm run check`：并行 3,139 项、串行 28 项，0 失败（跳过 41 项）；首次并发抖动见第 6 节                                |
| 编译客户端 smoke                                     | 通过               | `smoke:client` 3/3                                                                                                          |
| 桌面 smoke                                           | 通过（修正测试后） | `smoke:desktop` 67 通过、0 失败、3 跳过；首轮因隐藏设置入口让语言测试点击不可见按钮而失败，已把语言测试改为只遍历可见设置区 |

## 3. 已确认并修复的问题

### 3.1 P1：失败的 `run_command` 把任务副作用永久留成“未知”

**现象。** 真实模型执行 `/task 在 notes.md 末尾追加一行 …` 后：

- `notes.md` 已写出，内容正确；
- 三个步骤都 `completed`，两项验收都通过；
- 任务和运行仍被标为 `needs_review`，错误为
  `Task side effect outcome unknown; inspect state before retrying.`；
- 数据库里第一次 `run_command`（探测不存在的 notes.md，退出码 1）的 `task_effects` 行一直是 `pending`。

**根因。** `packages/core/run-tools.ts` 只在 `!result.isError` 时结算任务副作用。命令退出码非零是 `isError: true`，但结果同时带有 `commandExecuted: true`，说明命令确实运行并返回了退出码，副作用结果并不未知。该 `pending` 行随后被任务收尾判定为“结果未知”，覆盖了已经通过的验收。

**修复。** 副作用在“命令已执行并返回”时结算，即使退出码非零：

- 直接调用与 `run_code` 内层调用都使用
  `!result.isError || result.commandExecuted === true`；
- 外部工具的错误结果仍保持 `pending`，因为错误可能发生在请求已发出之后；
- 新增回归 `tests/task-resume.test.ts:247`，用真实 `run_command`（`process.exit(1)`）加一条已满足的验收，断言任务可以 `completed` 且不留下未知副作用。

**复验。** 真实桌面重试原任务后 `completed`；新建任务的所有 `task_effects` 行均 `completed`。

## 4. 仍需确认或未闭合的问题

### 4.1 P2（已确认的回归，产品意图待定）：会话归档与工作区维护入口被隐藏

工作区未提交的 `apps/desktop/index.html` 把 `#workspace-maintenance-settings` 设为 `hidden`，`apps/desktop/session-management.ts` 又移除了会话菜单的“归档”。两者合起来使：

- 无法再从界面归档会话；
- 已有归档会话无法从“归档管理/工作区维护”页面恢复；
- `renderer-archived-sessions.ts`、`renderer-workspace-maintenance.ts` 与对应 HTML 仍保留，但没有可达入口。

该改动还直接打破了既有桌面 smoke：`tests/desktop-language.smoke.mjs` 在枚举设置侧栏时点击了第三个按钮（现在是隐藏的 `#workspace-maintenance-settings`），`npm run smoke:desktop` 因此失败（`element is not visible`，5/15 文件后停止）。本轮已把该测试改为只遍历可见设置区（隐藏区已有自己的 smoke），但这只修复测试与当前 UI 的一致性，不代表归档入口应当消失。

这可能是刻意的产品收敛（`tests/workspace-maintenance.smoke.mjs` 也已改成“入口隐藏”并程序化打开页面），但计划与文档没有说明。若并非有意，应恢复入口；若有意，应删除或明确标注这块保留代码，避免用户已有的归档会话变成不可达数据。

### 4.2 P3：审批超时的文案把“没人回答”说成“没有审批端”

浏览器工具第一次测试时没有点审批卡，120 秒后工具返回：

> Permission was not granted: no approval responder is available. Nothing was executed; do not retry without new authorization.

审批卡实际已出现在真实桌面中，只是没有被点击。`createRunApprover` 的定时器把超时记成 `unavailable`，于是模型被告知“没有审批端”。建议区分“客户端未响应/超时”和“宿主没有审批端”，至少让文案说明是等待超时。

### 4.3 观察：模型生成的验收条件可能是环境不可执行的

新任务的 `/task` 草稿由真实模型规划，其中一项命令验收使用 `command: "Get-Content"`，收尾执行时报 `spawn Get-Content ENOENT` 并归为 `environment-error`；另一项是模型自行加入的人工验收。任务因此停在 `needs_review`，但这不是任务副作用账本的问题（所有副作用已结算），也不是代码失败。任务草稿可编辑，用户可以修正；如果需要更稳的产品行为，应在草稿阶段校验/提示这类 Windows cmdlet 命令。

## 5. 真实桌面回归细节

- **模型上下文**：真实请求的消息中有且仅有一条
  `<runtime-context source="model">` 快照；切换模型后老快照保留、新快照追加，模型按最新一条回答；重启恢复后没有重复追加。
- **模型切换**：切换通过设置页的模型选择完成，Host 被重启但会话保留；deepseek-flash、Kimi-K3 均真实返回。
- **文件工具**：`write_file` + `read_file` 均成功；自动验证因为没有可执行检查把运行标为 `needs_review`，这是预期行为，不是工具失败。
- **浏览器工具**：真实模型调用 `browser_open` → `browser_screenshot` → `browser_close`；审批卡点击“允许一次”后成功，页面标题和 7,985 字节 PNG 都写入工作区。第三轮报告的“构建里浏览器工具不可用”未复现。
- **任务**：`/task` 创建草稿后侧栏与任务面板立即出现，标题无 `Goal:`；点击“开始执行”后 Host、模型、步骤、验收、文件写入均为真实链路。

## 6. 仓库检查

- 最终 `npm run check` 退出码 0：格式、文档、引用、依赖环、分层、国际化、类型、Lint、测试隔离检查全部通过；并行 3,139 项（3,111 通过、0 失败、28 跳过），串行 28 项（15 通过、0 失败、13 跳过）；随后构建与 `smoke:client` 3/3 通过。
- 首次 `npm run check` 在 46/300 个文件后因 `tests/windows-shell.test.ts` 的“取消启动中的 PowerShell”用例失败而停止（该用例断言取消后延迟文件不应出现，实际出现 `late-1.txt`、`late-3.txt`、`late-6.txt`）。这是机器同时运行多个真实 Host/测试进程时的时序失败；单独复跑 `tests/windows-shell.test.ts` 为 7/7 通过，最终完整门禁也通过。
- 为排除单次并发抖动，另用 `FOUNDRY_TEST_CONTINUE_ON_FAILURE=1`、`--concurrency=6` 完整重跑：并行 3,139 项、串行 28 项，同样 0 失败。
- `npm run smoke:desktop` 67 通过、0 失败、3 跳过。
- 桌面 smoke 首轮失败在 `tests/desktop-language.smoke.mjs`：枚举设置侧栏时点击了隐藏的 `#workspace-maintenance-settings`。已把该测试改为只遍历可见设置区；重跑通过。`desktop-round3.smoke.mjs` 的浏览器用例本轮跳过（测试自身的 Chromium 可用性探测未找到浏览器），但真实模型浏览器工具的手动验收已通过，见第 5 节。
- 工作区中同时存在其他任务的未提交修改（计划批准卡等）；本轮完整测试是在当前 dirty 树上跑的，不代表某个已提交版本的发布门禁。

## 7. 复现

```powershell
# 构建
npm run build

# 准备隔离 profile（复制真实 model-settings.json/Local State 到 .scratch/.../profiles/main）
node .scratch/desktop-real-models-round4/probe-launch.mjs

node .scratch/desktop-real-models-round4/probe-model-context.mjs
node .scratch/desktop-real-models-round4/probe-switch.mjs
node .scratch/desktop-real-models-round4/probe-tools.mjs
node .scratch/desktop-real-models-round4/probe-resume.mjs
node .scratch/desktop-real-models-round4/probe-browser.mjs
node .scratch/desktop-real-models-round4/probe-task.mjs
node .scratch/desktop-real-models-round4/probe-task-retry.mjs
node .scratch/desktop-real-models-round4/probe-task2.mjs
```

- 结果：`.scratch/desktop-real-models-round4/results/*.json`
- 截图：`.scratch/desktop-real-models-round4/evidence/*.png`
- 日志：`.scratch/desktop-real-models-round4/*.log`

## 8. 未覆盖

- Windows 原生沙箱的真实隔离强度（本轮使用 `YUANTU_SANDBOX=host`，未初始化或修改真实沙箱账户；真实 Windows 账户验收仍应在 CI 执行）。
- 打包安装包（`dist/release/win-unpacked` 是旧构建）；本轮使用仓库构建的真实 Electron，不是安装器版本。
- 真实桌面上的上下文压缩、目标自动续跑、MCP/LSP/Office、子代理合入与撤销；这些在第三轮已覆盖，本轮未重做。
- macOS Seatbelt、Linux、多显示器、IME、无障碍。
- 工作区中并行修改（计划批准卡等）不在本报告结论范围内；完整测试的最终结果以实际重跑为准。
