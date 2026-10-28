# 真实桌面第三轮：补齐第二轮未覆盖面的验收

> 2026-10-26 已完成代码复核与后续修复。任务标题、面板发布延迟、浏览器错误误报及 SID 注册表并发缺陷已确认；“浏览器打包不可用”和“历史 EPERM 必然由并发 Host 引起”不能据原始错误确定。以下保留原轮次的观察与覆盖范围。

> 日期：2026-10-25/26。仓库：`E:\agent-desktop\YuanTu-Foundry`，HEAD `a4a92a3`。
> 方式：Playwright 驱动真实 Electron 主进程、IPC、Host 子进程和渲染层；真实模型来自本机 `safeStorage` 解密的连接（当前 5 条，Claude-Opus-5.5 已从真实设置中移除）。故障注入在真实 provider 前加本地代理；精确到参数的安全边界另用脚本化 OpenAI 兼容端点（真实桌面、Host、工具与沙箱，只有模型输出是脚本），文中逐项标注。
> 隔离：复制 `model-settings.json` 与 `Local State` 到 `.scratch/desktop-real-models-round3/profiles/*`，每个套件独立 `--user-data-dir`、工作区与 `YUANTU_STATE_DIR`；未写入真实 `%APPDATA%\YuanTu Agent` 的会话和设置。
> 产物：`results/*.json`、截图与日志在 `.scratch/desktop-real-models-round3/`（Git 忽略）。

## 1. 结论摘要

第三轮补上了第二轮明确未覆盖的几块：**故障注入、凭据/路径穿越/junction/审批/只读边界、写入型子代理与 worktree 合入、MCP/LSP/Git/终端/Office 编辑预览、文件工具长尾、spill、长历史、多模态边界**。第二轮 6 项修复在当前 HEAD 上 6/6 通过。

尚未闭合或需要注意的：

- **原生 Windows 沙箱在本机被并发运行的 swe-bench Host 占住了共享授权状态**：`cap-sids.json.<pid>.tmp` 出现 `EPERM`，以及 `Windows sandbox workspace authorization is incomplete ... lock-grant-record`。受影响的 `auto`/`guarded` 命令没有真正启动，因此原生沙箱的隔离强度与 500/429 之外的命令边界**不能算通过**。
- **桌面构建里的浏览器工具不可用**：`browser_*` 一律返回“请安装 playwright/chromium”，但仓库里有 playwright，且从 `dist/packages/tools` 直接 `import('playwright')` 能启动 Chromium。真实原因被统一的 `catch` 吞掉了；这是打包/诊断问题，不是“没装”。
- **流/协议类失败横幅曾原样显示英文**（`Model stream interrupted...`、`Invalid JSON in model stream`、`Model endpoint omitted token usage...`、`Model request failed...`）。已在本轮修复并加单测，重建后故障套件 9/9 复验为中文。
- **目标自动续跑已观察到第二轮，但本轮目标没有完成**：改成“等待外部 `goal-trigger.txt`”后，Host 确实自动启动了第二轮（`roundsStarted: 2`、2 次 run）；测试脚本写触发文件晚于第二轮检查，目标按 2/2 预算记为 `blocked`。自动续跑本身有证据，目标完成路径受触发时序影响。
- 子代理合入后的撤销已复测通过；剩余未闭合项是原生沙箱环境、浏览器工具和 Goal 的确定性完成路径，不当作产品通过或失败。

## 2. 环境与方法

| 项目         | 值                                                                                                                                                                        |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 操作系统     | Windows 11 Home China 10.0.26300，64 位                                                                                                                                   |
| 运行时       | Node.js 24.19.0，Electron 43.5.0，Playwright 1.63                                                                                                                         |
| 应用构建     | `dist/desktop/main.cjs`，2026-10-25 23:26，来自 HEAD `a4a92a3`（含本轮本地化修复）；Electron 以 `--no-sandbox` 启动（当前宿主环境需要，产品自己的命令沙箱不受这一项影响） |
| 模型连接     | deepseek-flash、DeepSeek-V4.1-Flash-1017、GPT-6-Astra、GLM-5.3、Kimi-K3（5 条，2 个网关）                                                                                 |
| 主要测试模型 | deepseek-flash（功能与安全主路径）、Kimi-K3（needs_review 回归）                                                                                                          |
| 规模         | 31 个隔离会话库、72 个会话、95 次运行、203 次工具执行（含脚本化端点的精确工具调用）                                                                                       |
| 隔离         | 每个套件独立 profile、工作区、状态目录；真实 appdata 只读复制                                                                                                             |

### 2.1 三类“真实”要分开说

1. **真实模型 + 真实桌面**：回归、故障（代理后面的真实 DeepSeek）、子代理/worktree、MCP/LSP/Git/终端/Office、spill/长历史/多模态。
2. **真实桌面 + 真实 provider + 脚本化模型输出**：安全边界里“必须让工具收到精确参数”的几项（junction 写外部、`edit_file` 审批拒绝、只读下 `edit_file`、`.env` 读取）。模型输出是脚本，但 Host、工具、审批、OS 沙箱、文件系统都是真的；这类检查在文中标 `scripted`。
3. **真实桌面 + 本地故障代理**：500/429/断流/畸形 SSE/省略 usage/连接重置/停滞。代理转发真实 DeepSeek，只在指定模式注入故障。

## 3. 结果总览

| 套件                                       | 检查 | 通过 | 告警/跳过 | 失败 | 说明                                                                                      |
| ------------------------------------------ | ---- | ---- | --------- | ---- | ----------------------------------------------------------------------------------------- |
| 当前 HEAD 回归                             | 6    | 6    | 0         | 0    | 计划审批、/task、/export、目标面板、needs_review、输出上限                                |
| 故障注入                                   | 9    | 9    | 0         | 0    | 500/429/断流/畸形 SSE/无 usage/连接重置/停滞停止/恢复                                     |
| 安全边界（真实模型）                       | 9    | 8    | 1         | 0    | 凭据×2、穿越×2、junction×2、审批拒绝、只读通过；原生沙箱命令被环境阻塞                    |
| 安全边界（脚本化精确参数）                 | 5    | 4    | 1         | 0    | 精确 junction 写外部、审批拒绝、只读、`.env` 通过；原生沙箱 auto 因 `EPERM cap-sids` 告警 |
| 写入型子代理/worktree                      | 3    | 3    | 0         | 0    | worktree 隔离、apply 审批 + diff、撤销全部通过                                            |
| MCP / LSP / Git / 终端 / Office / 文件工具 | 6    | 6    | 0         | 0    | MCP 工具/资源/提示词、LSP 诊断、Git 提交、PTY、DOCX 编辑+HTML 预览、四个文件工具          |
| 浏览器                                     | 1    | 0    | 0         | 1    | 构建里的 `browser_*` 报“请安装 playwright”，真实原因被吞                                  |
| spill                                      | 1    | 1    | 0         | 0    | 脚本化 `run_command` 66,107 B 输出写入 spill                                              |
| 长历史                                     | 1    | 1    | 0         | 0    | 30 轮、62 条消息，重载后可读                                                              |
| 多模态                                     | 3    | 3    | 0         | 0    | 两图同轮、GIF/WebP/大图、`read_image`                                                     |
| 目标续跑                                   | 1    | 0    | 1         | 0    | 自动第二轮确实启动（2 次 run），但外部触发文件写入晚于第二轮检查，目标按预算 blocked      |
| 任务草稿                                   | 1    | 0    | 1         | 0    | `/task` 已创建 pending 任务；标题仍是 `Goal:`，任务面板 5 秒内未显示                      |

合计 46 项：41 通过、4 告警（原生沙箱×2、目标续跑、任务草稿）、1 失败（浏览器）。原始 `results/*.json` 共 56 条记录，其中包含早期被后续精确探针取代的无效检查（例如真实模型改写命令、图片附件计数用错 DOM 类名），表中只计有效结论。

## 4. 发现

### 4.1 P0（环境阻塞）：原生沙箱授权状态被并发 Host 占用

**现象。** 默认 `auto`/`guarded` 下执行命令失败，两种错误交替出现：

- `EPERM: operation not permitted, open 'C:\Users\sunjun\.yuantu\sandbox-state\windows-account\cap-sids.json.<pid>.tmp'`
- `Windows sandbox workspace authorization is incomplete for <workspace>; the command has not started. lock-grant-record (C:\Users\sunjun\.yuantu\sandbox-state\windows-account\grants.lock): Cannot acquire sandbox grant journal lock: ...`

**环境事实。** 本机同一时间有一个 2026-10-25 20:22 启动的 swe-bench 评估进程（`apps/agent-host/main.ts`，PID 9452）仍在运行，它和本轮桌面共用 `%USERPROFILE%\.yuantu\sandbox-state\windows-account`。该 Host 会持续申请 workspace grant；`grants.lock` 是 `share_mode(0)` + delete-on-close 的进程锁，`cap-sids.json` 也会被两边同时改写。第二轮 19:07 的沙箱探针通过时这个评估不在运行。

**判断。** 这更像**共享状态没有跨进程协调/没有把“另一个 Host 正在用”讲清楚**，而不是沙箱本身失效。产品侧至少有两点可改：状态目录按 Host/用户隔离，或把 `lock-grant-record`/`EPERM` 映射成“另一个 Agent Host 正在使用沙箱，请关闭后重试”，而不是让命令以“未启动”失败。**隔离强度未测**，不能把 `auto`/`guarded` 的命令边界算通过。

### 4.2 P1（打包/诊断）：桌面构建里的浏览器工具不可用，且错误信息误导

`browser_open` 的返回是：

> Browser tools require the optional playwright package and a chromium build. Install them with "npm install playwright" then "npx playwright install chromium".

但：

- `node_modules/playwright` 存在；从 `dist/packages/tools` 直接 `import('playwright')` 并 `chromium.launch()` 成功（Chromium 153）。
- `launchPersistentContext` 用桌面同样的 profile 目录也能启动。
- `packages/tools/browser.ts` 的 `launch()` 把 `import` 和**所有** `chromium.launch` 失败都 `catch` 成同一条 `MISSING`，真实原因没有进入日志或横幅。

因此用户得到的“安装 playwright”建议无法解决问题。需要保留 `cause`（至少写进 Host 日志），并检查桌面构建里 Host 的模块解析/浏览器 profile 目录。

### 4.3 P2（已修并复验）：流/协议类失败横幅仍是英文

故障注入在中文界面得到：

| 注入       | 横幅                                                                 |
| ---------- | -------------------------------------------------------------------- |
| 流中途断开 | `Model stream interrupted; check endpoint and network configuration` |
| 畸形 SSE   | `Invalid JSON in model stream`                                       |
| 省略 usage | `Model endpoint omitted token usage; enable streaming usage support` |
| 连接重置   | `Model request failed; check endpoint and network configuration`     |

第二轮只补了 `Incomplete model stream`、工具流、输出上限和 400；这四类没有走 `localizedRunError`。本轮在 `renderer-error-text.ts` 增加映射，在 `i18n-workspace.ts` 增加四条中英文案，并在 `tests/desktop-copy.test.ts` 加断言。重建后故障套件复跑 9/9，四条横幅均变为中文（见 5.2）。

### 4.4 目标自动续跑：已观察到第二轮，但本轮目标没有完成

第一次 `create_goal(max_goal_rounds=2)` 的 objective 是“写两行”；模型在第一轮就把两行都写了，自动验证又在同一轮追加步骤，没有留下“目标 active + 运行结束”的窗口。

第二次改成“等待外部 `goal-trigger.txt` 出现，出现后写入结果并 complete”：第一轮检查不到文件后结束，**Host 确实自动启动了第二轮**（`goal.changed` 记录 `roundsStarted: 2`，run 记录 2 次）。但测试脚本在第二轮开始后才写入触发文件，模型第二轮检查时文件还不存在，最终按 2/2 轮预算记为 `blocked`。

因此“自动续跑”本身已得到证据；“目标完成”这一半受触发时序影响，不能算产品失败。

### 4.5 子代理合入后的撤销：已通过

`workspace_result_apply` 成功后，撤销入口在 `.turn-changes` 卡片里：先点 `.turn-changes-heading` 展开预览，出现 `button.undo-change`，再点 `button.confirm-undo`。修正脚本后 `SUBP-03` 通过：变更卡片 1 个、撤销按钮 1 个、文件被移除。

### 4.6 测试夹具经验

- 模板工作区在 `resetWorkspace` 后没有 `.git`，写入型子代理会得到 `WORKSPACE_NOT_A_REPOSITORY`；需要先 `initGit`。
- `.yuantu/mcp.json`、`.yuantu/lsp.json` 也是生成物，模板复制会丢失；必须在 reset 后重新写。
- 图片附件渲染为 `.attachment`，文档附件才是 `.attachment.document-attachment`；用 `document-attachment` 统计图片会永远等到 0。
- 真实模型会改写“写工作区外”的命令或先做只读检查，安全边界不能只靠自然语言 prompt 断言；精确参数用脚本化端点。

### 4.7 P3：`/task` 创建的任务标题仍带 `Goal:` 前缀

`/task 在 notes.md 末尾追加一行 - TASK-DRAFT-7781…` 后，数据库确实新增一条 `pending` 任务，但标题是：

> `Goal: 在 notes.md 末尾追加一行 - TASK-DRAFT-7781…`

菜单已改成“任务草稿 / `/task`”，`task-spec.ts:212` 仍按 `kind === 'goal'` 生成 `Goal: ` 前缀。会话目标与任务草稿是两种实体，这个前缀会让用户误以为又创建了一个目标。同一探针里任务面板在 5 秒后仍为 `hidden`（数据库已有任务），可能是面板快照刷新滞后；需要点“刷新”或下一次状态推送才显示。

## 5. 覆盖明细

### 5.1 当前 HEAD 回归（真实模型）

- 计划审批问题卡：提交后 `notes.md` 落盘，无“会话操作正在进行”。
- `/task` 文案与命令面板：`/task` + “任务草稿”，无“创建目标”。
- `/export`：重新写出 Markdown（当前会话 8.8k 字符）。
- 深色目标面板：背景 `rgb(43,43,47)`。
- `needs_review`：Kimi 编辑后顶部无英文句。
- 输出上限 64：`status=limited`，横幅“模型输出达到本轮上限…”。

### 5.2 故障注入（真实 provider + 本地代理）

- 500：8.3s 失败，中文“模型接口服务端出错（HTTP 500）”。
- 429：9.6s 失败，中文“模型接口正在限流（HTTP 429）”。
- 断流：0.3s 失败，中文“模型流中途断开…”；不把半截当完成。
- 畸形 SSE：0.3s 失败，中文“模型流返回了无法解析的数据…”。
- 省略 usage：1.2s 失败，中文“模型没有返回用量信息…”；不静默成功。
- 连接重置：失败，中文“无法连接模型接口…”。
- 停滞：12s 后仍在运行，点停止后 `cancelled`。
- 恢复：切回直通后真实模型继续回答“恢复”。

### 5.3 安全边界

真实模型：

- `.env`、`id_rsa`：`read_file` 返回 `Access to internal or credential paths is blocked`；未泄露标记。
- `../../outside/secret.txt`：`Path is outside workspace`。
- `../../outside/traversal-write.txt`：未创建。
- `escape-link/secret.txt`、`escape-link/escape-target.txt`：junction 解析后仍拒绝，外部文件未变。
- `guarded` 明确点“拒绝”：`notes.md` 未变，工具结果为 `Permission denied by user`。
- `observe`：写工具不在目录中；`run_code` 调用 `tools.edit_file` 也不能绕过。
- `unconfined` 对照（脚本化精确参数）：junction 路径写外部成功，证明拒绝不是因为 junction 本身不可用。

原生沙箱：

- `auto` 下同一 junction 写外部：外部文件未创建，但命令没有启动（`EPERM cap-sids` / `authorization incomplete`），所以只能算“未执行”，不能算“沙箱拦住”。
- 写入型子代理内部也出现同一错误：子代理的 `run_command` 返回 `EPERM ... cap-sids.json.<pid>.tmp`，随后用文件工具完成验证。说明这不是单个套件的偶发。

### 5.4 子代理/worktree

- `delegate_task(role=general)` 在真实 Git worktree 中创建 `subagent-result.md`，父目录在合入前没有该文件；子代理卡片 `workspace.kind=worktree`、`result.paths=["subagent-result.md"]`。
- `workspace_results` 返回 `resultId` + `digest`；`workspace_result_apply` 的审批显示“批量修改 1 / 新建 subagent-result.md / +1 −0”和完整参数；允许后文件出现，内容 `SUBAGENT-WROTE-9182`。
- 撤销：点开 `.turn-changes-heading` → `button.undo-change` → `button.confirm-undo`，文件被移除（`SUBP-03` 通过）。

### 5.5 长尾工具

- MCP：`.yuantu/mcp.json` 启动本地 stdio 服务；`list_tools`、`call_tool(echo)`、`list_resources`、`read_resource(note://round3)`、`list_prompts`、`get_prompt` 均返回标记（`MCP-ECHO-OK`、`MCP-RESOURCE-5520`、`MCP-PROMPT-3319`）。
- LSP：`.yuantu/lsp.json` 指向仓库的 fake server；`lsp_start(fake)`、`lsp_diagnostics(sample.fake)` 返回 `BADTOKEN` 诊断，`lsp_stop` 正常。
- Git：`git_status/log/diff/stage/commit` 全链路，`git log -1` 为 `round3 git commit`。
- 终端：`terminal_open`（PowerShell）→ `terminal_send` → `terminal_read` 得到 `TERM-OK-4412` → `terminal_close`。
- Office：`office_edit` 把 DOCX 的 `YUANTU-DOCX-4207` 换成 `OFFICE-EDIT-3355`，`office_inspect` 可见新值，`office_preview` 生成 `sample-preview.html`。
- 文件工具：`apply_patch` 1→7、`batch_edit` 两文件、`move_file`、`delete_file` 都落盘；旧文件消失，新文件存在（脚本化精确参数）。

### 5.6 spill/历史/多模态

- spill：脚本化 `run_command` 输出 60,000 个 `y`（66,107 B），结果写入 `.yuantu/spill/...`，工具结果给出路径。`read_file` 整文件读取没有触发 spill（工具自己先截断并带 marker，结果阶段按设计不重复 spill）。
- 长历史：30 轮短对话（62 条消息），重载后仍能读到 `OK-30`。
- 多模态：两张图同轮（红/蓝）、GIF+WebP（绿/黄）、3000×2000 大图（黄）、`read_image` 工具读 `red.png`。

## 6. 仍未覆盖

- Windows 原生沙箱的**实际隔离强度**（本轮被并发 Host 阻塞；需要干净环境或独立状态目录）。
- macOS Seatbelt / Linux；安装包、升级、回滚、签名、单实例、托盘/通知、多显示器/HiDPI/IME/拖放、无障碍全量。
- MCP OAuth 授权码 + PKCE 的完整浏览器流程（本轮只测 stdio 工具/资源/提示词）。
- 安装型桌面（`dist/release`）与开发构建的差异；浏览器工具在安装包里的模块解析。
- 100+ 消息的分页/滚动、数据库损坏/磁盘满/断网等更极端的故障注入。
- `/task` 只验证了创建任务与数据库标题；任务面板在本探针中未自动显示，编辑器、触发器、`task_step` 执行与定时调度未覆盖。
- 目标多轮续跑的确定性完成路径（自动第二轮已观察到，外部触发时序仍需重跑）。

## 7. 修复记录

| #   | 问题                     | 修复                                                                     | 回归                                                                                                           |
| --- | ------------------------ | ------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------- |
| 1   | 流/协议/网络失败横幅英文 | `renderer-error-text.ts` 增加 4 类映射；`i18n-workspace.ts` 增加中英文案 | `tests/desktop-copy.test.ts` 14/14；`i18n:check`、`lint`、`typecheck` 通过；重建后故障套件 9/9，四条横幅为中文 |

## 8. 复现

```powershell
$env:ACCEPTANCE_PYTHON = '<bundled python>'
node .scratch/desktop-real-models-round3/prepare.mjs

node .scratch/desktop-real-models-round3/suite-regression.mjs
node .scratch/desktop-real-models-round3/suite-faults.mjs
node .scratch/desktop-real-models-round3/suite-scripted-security.mjs
node .scratch/desktop-real-models-round3/probe-subagent.mjs
node .scratch/desktop-real-models-round3/probe-mcp-lsp.mjs
node .scratch/desktop-real-models-round3/probe-file-tools.mjs
node .scratch/desktop-real-models-round3/probe-spill-scripted.mjs
node .scratch/desktop-real-models-round3/probe-vision.mjs
node .scratch/desktop-real-models-round3/probe-goal.mjs
```

- 结果：`.scratch/desktop-real-models-round3/results/*.json`。
- 截图：`.scratch/desktop-real-models-round3/evidence/`。
