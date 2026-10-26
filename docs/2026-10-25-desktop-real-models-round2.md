# 真实桌面第二轮：六模型多角度验收与问题报告

> 日期：2026-10-25。仓库：`E:\agent-desktop\YuanTu-Foundry`，基线 `91fa342`（工作区干净），`dist/desktop` 构建于同日 18:16。
> 方式：Playwright 驱动真实 Electron 主进程、IPC、Host 子进程与渲染层；使用系统 `safeStorage` 解密的六条真实模型连接；不是 mock provider，也不是只跑单元测试。
> 隔离：复制 `model-settings.json` 与 `Local State` 到 `.scratch/desktop-real-models-round2/profile*`，每个套件独立 `--user-data-dir`、独立工作区与状态目录；未写入真实 `%APPDATA%\YuanTu Agent` 的会话和设置。
> 产物：原始检查 `results/*.json`、截图与日志在 `.scratch/desktop-real-models-round2/`（Git 忽略）。截图未随仓库提交；报告中不包含任何密钥。

## 1. 结论摘要

**桌面外壳、设置、会话、工具、审批、撤销、队列、并发会话、崩溃恢复、子代理、后台任务、知识库、Office 与文档附件整体可用；六个模型的能力差异很大，其中 Claude-Opus-5.5 这条连接在桌面里完全不可用。**

- Shell 与设置 14 项：13 通过、1 告警（窗口高度被工作区钳制，环境行为）。
- 六模型矩阵 30 项：23 通过、5 失败、2 告警。失败集中在 Claude-Opus-5.5（全部请求 HTTP 400）、GLM-5.3 图片请求（>300 秒无响应）和 GPT-6-Astra 并行工具调用。
- 跨模型编码任务 6 项：5 个模型通过（deepseek-flash、DeepSeek-V4.1、GPT-6-Astra、GLM-5.3、Kimi-K3），Claude-Opus-5.5 失败；通过的模型都没有修改 `test.js`，独立复核均输出 `TEST_PASS`。
- 发现 3 个明确的桌面产品缺陷（计划审批死锁、输出上限失效、深色主题目标面板仍为浅色）、3 个产品/文档不一致（权限默认值、`/export`、`/goal` 语义），以及 5 个外部模型/网关兼容问题。
- 上一轮报告中的问题：未知环境变量可见性、运行中断标记已修复；只读语义改为“不暴露写工具”，不再出现“用户拒绝”；GPT-6-Astra 并行调用仍不可用，但桌面现在会明确失败而不是显示“完成”。

## 2. 测试环境

| 项目         | 值                                                                                                         |
| ------------ | ---------------------------------------------------------------------------------------------------------- |
| 操作系统     | Windows 11 Home China 10.0.26300，64 位                                                                    |
| 运行时       | Node.js 24.19.0，Electron 43.5.0（Chromium 150），Playwright 1.63                                          |
| 应用构建     | `dist/desktop/main.cjs`，2026-10-25 18:16，来自 `91fa342`                                                  |
| 桌面启动     | `dist/desktop/main.cjs --user-data-dir=<isolated profile>`                                                 |
| 状态隔离     | 每套件独立 `YUANTU_STATE_DIR` / `YUANTU_MEMORY_DIR` / `YUANTU_KNOWLEDGE_DB` / `YUANTU_WORKTREE_DIR`        |
| 模型连接     | 6 条（2 个网关）：deepseek-flash、DeepSeek-V4.1-Flash-1017、GPT-6-Astra、GLM-5.3、Claude-Opus-5.5、Kimi-K3 |
| 主要测试模型 | Kimi-K3（核心交互）、deepseek-flash（快速/工具流程）、六个模型（矩阵与编码）                               |
| 真实模型回合 | 约 120 个回合（矩阵、编码、计划、子代理、恢复、限额探针）                                                  |

### 2.1 方法

- UI 操作全部走真实 DOM（Playwright 点击/输入/选择），断言落在可观察事实：磁盘文件、独立 `node test.js` 输出、会话 SQLite 投影、SQLite 事件、DOM 文本、原生截图、Host 进程退出。
- 模型连接来自本机已加密的 `model-settings.json`；密钥不出现在报告、日志或截图中。
- 每个套件使用独立 profile 与工作区重置，避免会话、队列、审批互相污染；同一 profile 内一次只运行一个桌面实例，不同套件可并行。
- 部分场景使用只读 SQLite 查询与 CDP 附加（不修改 UI 状态）核实“事件存在但 UI 未呈现”的差异；这类证据在问题条目中单独标注。

### 2.2 结果总览

| 套件/探针               | 检查 | 通过 | 告警 | 失败 | 说明                                               |
| ----------------------- | ---- | ---- | ---- | ---- | -------------------------------------------------- |
| Shell 与设置            | 14   | 13   | 1    | 0    | 窗口高度 1000×700→1000×672（显示工作区钳制）       |
| 六模型矩阵              | 30   | 23   | 2    | 5    | Claude 3 失败 + 1 告警；GLM 视觉；GPT 工具参数质量 |
| 核心会话与工具（core2） | 15   | 11   | 1    | 3    | 3 项为测试断言问题，已用修正探针复测 3/3 通过      |
| 计划/目标/子代理/后台   | 6    | 4    | 1    | 1    | `/goal` 语义告警；create_goal 由独立探针通过       |
| 记忆/知识/Office/技能   | 6    | 6    | 0    | 0    | 含真实 web_fetch                                   |
| 会话与恢复              | 8    | 8    | 0    | 0    | 含 Host 崩溃与关窗中断                             |
| 限额与附件              | 4    | 2    | 1    | 1    | 大输出/输出上限测试设置无效，见 §4.2、§7           |
| 跨模型编码              | 12   | 11   | 0    | 1    | Claude 失败；5 模型通过                            |
| 专项探针                | 12   | 7    | 2    | 2    | Claude 400、GLM 视觉、GPT 并行、目标面板、沙箱     |

> 核心会话的 3 项失败均来自测试断言或产品设计变化，而非产品缺陷：附件内容定位到了错误的消息、`modelInfo` 取错了消息、只读模式不再暴露写工具（因此没有“策略拒绝”文本）。三项已分别用修正探针复测通过。限额套件的 1 项失败是模型自行把命令改写成 `| Select-Object -Last 1`，没有产生大输出，spill 路径因此未得到验证。

## 3. 模型能力矩阵

### 3.1 基础能力（真实桌面）

| 模型                     | 基础对话          | 单工具                                                                  | 同轮并行工具                                | 图片理解                 | 备注                             |
| ------------------------ | ----------------- | ----------------------------------------------------------------------- | ------------------------------------------- | ------------------------ | -------------------------------- |
| deepseek-flash           | 通过 1.5s         | 通过 2.3s                                                               | 通过 3.0s（2 调用）                         | 通过 1.4s “红色”         | 全通过，最快                     |
| DeepSeek-V4.1-Flash-1017 | 通过 4.9s         | 通过 4.3s                                                               | 通过 14.9s（2 调用）                        | 通过 2.0s                | 首 token 波动大                  |
| GPT-6-Astra              | 通过 12.9s        | 通过 46.4s（3 调用，先产生无效 `list_files` 参数后改用 `search_files`） | **失败**（`tool-arguments-dropped`，40.7s） | 通过 8.0s                | 并行调用仍不可用                 |
| GLM-5.3                  | 通过 20.5s        | 通过 22.4s                                                              | 通过 19.8s（2 调用）                        | **失败**（>300s 无响应） | 文本可用，视觉会挂起             |
| Claude-Opus-5.5          | **失败** HTTP 400 | **失败** HTTP 400                                                       | **失败** HTTP 400                           | **失败** HTTP 400        | 该网关安全策略拒绝桌面请求       |
| Kimi-K3                  | 通过 17.6s        | 通过 8.1s                                                               | 通过 25.6s（2 调用）                        | 通过 25.4s               | 全通过，但存在一次工具流 ID 失败 |

### 3.2 跨模型编码任务

任务：在独立工作区运行 `node test.js`，它因 `calc.js` 的 `add` 写成减法而失败；要求只改 `calc.js`、不改测试、再次跑通。独立复核：测试文件字节未变，`node test.js` 输出 `TEST_PASS`。

| 模型                     | 结果 | 耗时   | 工具调用                        | 输入/输出 token | 首 token |
| ------------------------ | ---- | ------ | ------------------------------- | --------------- | -------- |
| deepseek-flash           | 通过 | 9.6s   | 6                               | 64,224 / 702    | 4.9s     |
| DeepSeek-V4.1-Flash-1017 | 通过 | 40.0s  | 6                               | 55,122 / 559    | 12.0s    |
| GPT-6-Astra              | 通过 | 115.0s | 8（含 `list_files`/`run_code`） | 64,234 / 378    | 16.0s    |
| GLM-5.3                  | 通过 | 53.8s  | 6                               | 52,173 / 1,391  | 45.8s    |
| Claude-Opus-5.5          | 失败 | 15.9s  | 0                               | 0 / 0           | —        |
| Kimi-K3                  | 通过 | 83.8s  | 7                               | 33,282 / 1,111  | 71.1s    |

## 4. 产品问题

### 4.1 P1：计划审批问题卡无法提交，`/plan` 进入死锁

**现象。** `/plan` 后模型调用 `exit_plan_mode`，界面出现“计划批准 / 批准这份计划，并在本轮开始执行吗？”的问题卡。选中“批准并执行”并点击“提交”后，问题卡不消失，顶部红条只有 **“会话操作正在进行，请稍候。”**，状态保持“等待你的回答”。运行永远不结束；只有关闭/重启窗口才能退出。

**复现（稳定）。**

1. 新会话，`/plan 在 notes.md 末尾追加一行：- PLAN-OK-1`。
2. 模型调用 `exit_plan_mode`，等待问题卡。
3. 点击“批准并执行”→“提交”。

**根因（源码定位）。**

- `plan` 在 `packages/carrier/command-policy.ts` 的 `MANAGING_COMMANDS` 中；`CarrierService.dispatch` 在 `packages/carrier/service.ts:972` 先执行 `if (this.restoring || this.managing) throw new CarrierError('sessionOperationBusy')`。
- `/plan` 的 `managing` 标志覆盖整个计划运行，而该运行正阻塞在问题卡上；`questionAnswer` 也走同一 `dispatch`，于是被同一条忙碌检查拒绝。
- 结果是一个确定的互相等待：问题等待 `questionAnswer`，`questionAnswer` 等待 `plan` 结束，`plan` 等待问题回答。

**证据。** CDP 读取到问题卡真实存在、选项已选中、提交按钮可用；点击后 `#error` 变为“会话操作正在进行，请稍候。”，`session.questions` 仍保留该问题。

**影响。** 模型选择“当面批准”这条更自然的路径时，计划模式完全不可用；用户会反复点击、以为按钮坏了。用 `submit_plan` 提交、再从计划面板批准/执行/拒绝的路径是正常的（AGENT-01/02 通过）。

**建议。** 在 `dispatch` 的忙碌检查之前放行 `questionAnswer`/`approve`（它们本来就是运行中的交互），或让 `plan` 不把 `managing` 覆盖到“等待用户回答”的时段；同时为“计划审批问题”增加一条不经过通用 `managing` 闸门的直达通道。

### 4.2 P1：模型设置里的输出上限在 DeepSeek 官方端点被静默忽略

**现象。** 把 deepseek-flash 连接的 `maxOutputTokens` 设为 64，发一条要求写 600 字散文的消息；请求 `context.envelope.maxOutputTokens` 确实是 64，但实际返回 **500 个输出 token**、`finishReason=stop`，运行状态是“completed”，没有 `limited`，也没有任何提示。

**根因。** OpenAI Chat 适配器只发送 `max_completion_tokens`：

```ts
// packages/providers/openai.ts:180
max_completion_tokens: request.maxOutputTokens,
```

对 `https://api.deepseek.com` 的直接对照实验（同 key、同 prompt、64 token）：

| 请求字段                    | 结果                                                                |
| --------------------------- | ------------------------------------------------------------------- |
| `max_tokens: 64`            | HTTP 200，`finish=length`，`completion_tokens=64`，无可见文本       |
| `max_completion_tokens: 64` | HTTP 200，`finish=stop`，`completion_tokens=541`，完整回答了 707 字 |

即该端点不认识 `max_completion_tokens`，产品也不检查“实际输出是否超过请求上限”。结果是：模型设置里的输出/成本上限在官方 DeepSeek 连接上无效，而且运行仍显示成功。

**影响。** 用户以为已经限制单次输出与费用，实际没有；对长回答、工具参数生成和批量任务尤其明显。产品侧的 `limited` 语义也不会触发。

**建议。** 对 OpenAI Chat 兼容端点优先发送 `max_tokens`（或按端点能力选择），并在 usage 明显超过请求上限时至少记录/提示一次；新增回归测试直接断言请求体的字段名。

### 4.3 P2：深色主题下“会话目标”面板仍是硬编码浅色

**现象。** 深色主题中，`create_goal` 成功后的目标面板是白底浅色卡片，标题和状态文字明显偏淡，和其余深色界面割裂；`todos`、`deliverables` 面板在 `layout.css` / `layout-surfaces.css` 里有主题覆盖，目标面板没有。

**证据。** 源码 `apps/desktop/styles-panels.css:344-349` 写死 `border: #dcdcd2; background: #fbfbf7`，且没有 `#chat-page .goal-panel` 的深色覆盖。对比同文件的 `.todos-panel`、`.deliverables-panel` 都被后续样式覆盖。

**建议。** 与另外两个面板一致，改为 `var(--surface)` / `var(--line)` 等主题变量，或补一条深色覆盖。

### 4.4 P2：`needs_review` 时顶部提示仍是英文

**现象。** Kimi 修改 `settings.txt` 后，模型回答“验证修改后的文件内容即可”，没有注册可执行检查，运行以 `needs_review` 结束。会话顶部出现浅红条：

> The work ended without executable verification checks.

同一状态的完成区却用中文写着“验收未通过，需检查”。中文界面同时出现英文失败句。

**证据。** 字符串来自 `packages/core/agent.ts:942`，桌面把它作为运行错误原样显示。`ui.completionReason.missing-verification` 已有中文词条，但这条运行错误没有走该映射。

**影响。** 普通编辑在未调用 `verify_work` 时就会触发；用户看到英文“工作结束”句，容易误以为应用出错或任务失败。

**建议。** 将 `verificationGate === 'review'` 的 `error` 映射到已有 `ui.completionReason.*`，或不要在运行错误横幅里重复完成区已经本地化说明的内容。

### 4.5 P2：权限说明与默认值与实际四档不一致

README 第 584 行仍写：

> **权限与隔离是 composer 上的一枚 chip，三档**：……工作区内修改（沙箱内、写入前询问，**新会话的默认**）……

实际实现是四档（`observe` / `guarded` / `auto` / `unconfined`），默认是 `auto`（“帮我批准”）：工作区写入和普通命令自动批准，只对检测到的风险操作询问。新会话 chip 显示“帮我批准”，实际写入**没有**逐项确认。

**影响。** 这是安全预期问题：按 README 阅读的用户会以为新会话默认在每次写入前询问，实际不是。菜单也不止三行，而是四行加“自定义”。

**建议。** 同步 README 的档位数与各档默认值；若产品希望默认“写入前询问”，则改 `DEFAULT_PRESET` 而不是只改文档。

### 4.6 P2：`/export` 已从桌面移除，文档仍说可用

README 第 584 行写只有 `compact`、`export`、`goal`、`plan` 四个会被解析执行；实际命令词汇（迁移后为 `apps/desktop/ui/composer/command-model.ts`）的正则只有 `compact|goal|plan`，命令面板只列 `/compact`、`/goal`、`/plan` 和技能。`renderer-export.ts` 与 carrier 的 `export` 命令仍在，但没有入口。

**影响。** 用户输入 `/export` 会把它当成普通消息发给模型，既不导出，也消耗一次调用；文档与 UI 不一致。

**建议。** 恢复出口（菜单/命令）或同步删除 README 的 `export` 描述和残留实现。

### 4.7 P2：`/goal` 创建的是任务草稿，不是会话目标

**现象。** `/goal 在 notes.md 末尾追加一行…` 后：`tasks` 表新增一条 `pending` 任务（标题即提示词），并触发一次 `task.propose` 规划运行；`session.goal` 为空，目标面板不出现。真正能建立目标面板的是模型调用 `create_goal` 工具（已通过：目标面板显示“已完成”，对象与轮数正确）。

**根因。** `packages/carrier/task-commands.ts:139` 的 `case 'goal'` 走 `task.create` + `task.propose`，不是 `create_goal`。UI 词条却是“创建目标 / 创建一个可持续跟踪的目标”。

**影响。** 用户按“目标”理解得到的是任务草稿；目标续跑、目标状态、目标预算这些能力不会生效。

**建议。** 明确 `/goal` 的语义：要么改为真正的 goal 命令，要么把菜单文案改成“创建任务草稿”，并把用目标的地方指向 `create_goal`。

### 4.8 P3：长问题卡顶部被裁切，计划内容从中间开始

计划审批问题卡的卡片顶部 `y≈-21px`，初始视口只显示“改动任何已有内容…”之后的部分，问题标题和计划前半段被顶栏/红条遮住；用户需要先向上滚动才能读完整计划，初始渲染的第一行就是半句。

**建议。** 问题卡容器限制最大高度并允许内部滚动；卡片顶部滚动到可见区域（`scrollIntoView({block:'start'})`），或给长问题一个“展开全文”入口。

### 4.9 P3：失败运行只有原始英文错误，且部分建议是错的

- Kimi 的一次命令请求以 `Duplicate tool ID fragment` 失败（`packages/providers/openai.ts:345`）。中文界面只在错误横幅里显示这句英文；没有中文解释或“换模型/重试”建议。
- Claude 的 HTTP 400 真实原因是网关安全策略：“请求内容触发安全策略，无法处理”，但桌面统一显示“模型接口拒绝了这次请求（HTTP 400）。请到设置 → 模型设置检查接口地址和密钥”，并给出“打开模型设置”按钮。地址和密钥都是对的，这个建议无法解决问题；真正的安全策略文本只藏在 `title` 里，而且是 Python `b'…'` 字节转义。
- 自动验证对一次简单配置修改也可能要求临时 PowerShell 脚本、CRLF 检查，产生多轮工具调用和 2 万+输入 token；某些模型会因此再发起提问或陷入行尾循环。建议对“单个文本文件的小编辑”降低自动验证的触发强度。

## 5. 外部模型/网关问题

以下问题不是桌面代码能单独修的，但都在真实使用中直接可见，且产品应给出更准确的识别与建议。

### 5.1 Claude-Opus-5.5：所有请求 400 安全策略，连接不可用

- 最简提示“只回复两个字：收到。”也失败；4 个矩阵场景和编码任务全部失败，0 工具调用、0 token。
- 原始错误（解码后）：“请求内容触发安全策略，无法处理”。同一密钥、同一端点的**最小**原始请求（无系统提示、无工具）返回 200 “OK”，说明是桌面的大系统提示/工具目录触发了网关过滤器。
- 桌面只给通用 400 建议，见 §4.9。
- 证据：`results/repro-claude.json`。

### 5.2 GLM-5.3：图片请求 >5 分钟无响应，UI 停在“正在推理…”

- 96×96 红色 PNG + “这张图片是什么颜色？”：90 秒时 `running=true`、0 条助手消息、状态“正在推理…”；停止按钮有效（“已停止”）。
- 矩阵中同一请求在 300 秒仍运行，测试超时；随后切换模型才取消。
- 同一连接的文字请求 20 秒左右可用。证据：`results/repro-glm-vision.json`。

### 5.3 GPT-6-Astra：并行工具调用仍然失败

- 同一轮要求两个 `read_file`：40.7 秒后运行失败，`code=tool-arguments-dropped`，错误“Tool arguments missing after one re-send with parallel tool calls disabled; still missing required arguments”。
- 桌面已经做了正确的缓解：检测到整批必需参数为空，关闭并行再重发一次，记录 `provider.degraded`；仍失败后以“运行失败”结束，横幅已本地化。相比上一轮“显示完成但什么都没做”，这是改进，但连接仍不能做并行工具调用。
- 单工具路径可用，且编码任务通过（115 秒）。
- 证据：`results/repro-gpt-parallel.json`。

### 5.4 Kimi-K3：偶发工具流 ID 冲突

一次命令请求在 48 秒后以 `Duplicate tool ID fragment` 失败（0 token，无助手消息）。同一模型在矩阵和编码中多次成功，属间歇性；适配器对“同一 index 出现不同 id”采取直接失败。若网关确实会分片发送 id，应拼接或容忍；若是网关重复发送两个不同调用，则应按两个调用处理而不是整轮失败。

### 5.5 延迟差异

同一时段、同一网络：deepseek-flash 1.4–2.3 秒；Claude 3.4 秒（最小请求）但桌面全失败；Kimi 8–26 秒；GLM 20 秒/轮、编码 54 秒；GPT 13 秒/轮、编码 115 秒；DeepSeek-V4.1 编码 40 秒、首 token 12 秒。桌面本身没有超时失败，但用户感知差异明显；建议在模型选择器里显示最近一轮的首 token/总耗时。

## 6. 上一轮问题的回归验证

| 上一轮问题                                   | 本轮结果                                                                                                                                       | 证据                              |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- |
| 5.1 GPT-6-Astra 并行工具参数丢失             | **仍在**；桌面现在会明确失败并重发一次，横幅本地化，不再是“完成但没做”                                                                         | `results/repro-gpt-parallel.json` |
| 5.2 未知 `YUANTU_*` 导致启动失败但原因藏起来 | **已修复**：首屏横幅“Agent Host 无法启动：启动环境里有不合法的设置…”；通用设置页显示环境问题                                                   | `SHELL-14`                        |
| 5.3 运行中关闭后没有中断标记                 | **已修复**：Host 崩溃后显示“运行因应用异常退出而中断。”和恢复横幅；关窗后显示“已停止，未产生回答。”                                            | `results/recovery.json`           |
| 5.4 只读把策略拒绝写成“用户拒绝”             | **已改为能力白名单**：只读会话不暴露 `write_file`/`edit_file`，文件不存在，模型回答“当前会话没有写入工具”；不再出现“Permission denied by user” | `core-fixes FIX-03`               |
| 5.5 Windows 原生沙箱未初始化导致命令不可用   | **本机已可用**：默认“帮我批准”（native）下 `node -e` 直接输出 42，没有出现沙箱提示；完全访问也可用。隔离强度未实测                             | SANDBOX-01/03                     |

## 7. 已覆盖与未覆盖

**已覆盖（真实窗口 + 真实模型）。**

- Shell：冷启动、三档尺寸无横向溢出、深/浅主题、字号、英文界面 0 残留中文、页面重载、工作区切换、渲染层安全（无 Node 全局、非法 IPC 拒绝、无密钥入 DOM）、进程/内存、窗口状态、键盘基础、无障碍标签。
- 模型：六连接解密与列表、切换、逐轮 `modelInfo`、测试连接、错误密钥 401（不回显）、容量发现结果、六模型基础对话/单工具/并行/视觉、跨模型编码。
- 会话与工具：读文件、自动批准编辑 + diff + 撤销、命令、审批允许/拒绝、只读、停止、提问卡、四类文档附件、todo、present 交付物、工作区预览、统计、斜杠面板、`/export` 可达性。
- 恢复：重命名/搜索/归档/恢复、运行中重载、队列、并发两会话、Host 崩溃自动重启、关窗中断、重启后模型与会话保持。
- 高级：计划面板批准/执行/拒绝、`create_goal` 目标面板、`/goal` 语义、explore 子代理与报告面板、后台命令启停、记忆保存/列出/跨会话回忆/删除、知识库索引与检索、Office docx 创建/检查/present、`/skill:` 技能、`web_fetch`、MCP 管理页暂停。
- 限额：显式 24k 窗口 + 16k 阈值确实触发 `context.compacted`（5 轮后仍能回答）；21MB 附件与二进制附件被拒；输出上限问题见 §4.2。

**未覆盖或只到边界。**

- MCP 工具调用与 OAuth（产品范围开关暂停了管理页）；备份/升级/安装包、签名与回滚。
- 写入型子代理的 worktree 隔离、`workspace_result_apply` 审批合入与撤销；任务编辑器、触发器、`task.verify`；目标自动续跑多轮。
- 长历史分页（100+ 消息）、通知、系统托盘、单实例二次启动、提升/缩放、无障碍全量审计。
- 平台：仅 Windows；未测 macOS Seatbelt/Linux。
- 故障注入：mock 端点 500/429/畸形 SSE、断网、超长流、供应商忽略 usage；未覆盖“输出上限被忽略”的自动告警（本轮只发现）。
- 大输出 spill：测试中模型把命令改写成 `| Select-Object -Last 1`，或对大文件分页读取，未产生单次超限工具结果；spill 路径未验证。
- 图片：只测了 96×96 纯色 PNG，未测多图、超大图、JPEG/GIF/WebP、文档内图片。
- PDF 预览依赖本机 Office/LibreOffice，未测渲染；Office 只测了 docx 创建与结构检查。

## 8. 复现方式

所有脚本在 `.scratch/desktop-real-models-round2/`（Git 忽略）：

```powershell
# 一次性准备隔离 profile、工作区与文档/图片夹具
$env:ACCEPTANCE_PYTHON = 'C:\...\python.exe'   # 可选，生成 PNG/DOCX/PDF/XLSX/PPTX
node .scratch/desktop-real-models-round2/prepare.mjs

# 用 Electron safeStorage 解密真实密钥（只写 .scratch 私有文件，不打印密钥）
node_modules\electron\dist\electron.exe .scratch\desktop-real-models-round2\decrypt.cjs --user-data-dir=<profile>

# 六模型矩阵 / 编码矩阵 / Shell / 核心 / 计划与子代理 / 资源 / 恢复 / 限额
node .scratch\desktop-real-models-round2\suite-model-matrix.mjs
node .scratch\desktop-real-models-round2\suite-coding.mjs
node .scratch\desktop-real-models-round2\suite-shell.mjs
node .scratch\desktop-real-models-round2\suite-core2.mjs
node .scratch\desktop-real-models-round2\suite-agents.mjs
node .scratch\desktop-real-models-round2\suite-resources.mjs
node .scratch\desktop-real-models-round2\suite-recovery.mjs
node .scratch\desktop-real-models-round2\suite-limits.mjs

# 专项：Claude 400、GLM 视觉挂起、GPT 并行、create_goal、输出上限/压缩、沙箱
node .scratch\desktop-real-models-round2\repro-claude.mjs
node .scratch\desktop-real-models-round2\repro-glm-vision.mjs
node .scratch\desktop-real-models-round2\repro-gpt-parallel.mjs
node .scratch\desktop-real-models-round2\probe-goal.mjs
node .scratch\desktop-real-models-round2\probe-limits-config.mjs
node .scratch\desktop-real-models-round2\probe-sandbox.mjs
```

- 结果：`results/*.json`（矩阵 `model-matrix.json`、编码 `coding-results.json`、恢复 `recovery.json` 等）。
- 截图：`evidence/`（本机生成，未随仓库提交）。
- 全量门禁基线：`npm run typecheck`、`npm run lint` 通过；`npm test` 在并发桌面负载下出现 1 个 `windows-shell.test.ts` 取消命令失败（853 通过 / 1 失败 / 4 跳过，fail-fast 后 44/296 文件有汇总），单独重跑 `tests/windows-shell.test.ts` 7/7 通过，判断为重负载下的偶发，不作为产品缺陷。

## 9. 结论与建议顺序

1. **先修计划审批死锁（4.1）**：这是可稳定复现、会让 `/plan` 完全不可用的阻塞问题；修好后用桌面冒烟覆盖 `exit_plan_mode` 的“批准/继续修改”两条分支。
2. **修输出上限字段（4.2）**：改为端点兼容的 `max_tokens` 或在适配器层做能力选择，并加“请求上限 vs 实际 usage”断言；否则模型设置页的输出/费用控制是假的。
3. **补深色目标面板与本地化横幅（4.3、4.4）**：两处都是小改动、用户可见。
4. **同步文档与产品语义（4.5、4.6、4.7）**：权限默认值涉及安全预期，应优先于 `/export` 和 `/goal`。
5. **外部连接治理**：把 Claude-Opus-5.5 标注为不可用/需网关放行；为 GLM 视觉设置明确的请求超时与“该模型视觉不可用”的提示；对 GPT 并行调用在模型选择器或连接说明中标注限制，而不是等用户在任务中失败。
6. **继续补未覆盖项**：worktree 子代理合入、MCP、故障注入、长历史、spill，以及 macOS/Linux。

**总体判断。** 桌面主链路（会话、工具、审批、撤销、队列、恢复、子代理、任务、知识、Office）在真实模型下是可用的；问题集中在“计划模式的交互闸门”、一个协议字段导致的成本控制失效，以及若干文档/主题/本地化细节。模型侧则呈现明显的网关差异：deepseek-flash/Kimi-K3 最稳定，DeepSeek-V4.1/GLM 文本可用但慢，GPT 并行不可用，Claude 在这条网关上完全不可用。
