# 工具收敛：按功能族合并

## 背景

空工作区里宿主注册 67 个工具（不按需加载时 66 个 schema、约 36 KB），默认模式下首个请求带 26 个、约 18.6 KB。对比之下，Codex CLI 每次请求只带 5–6 个工具，Claude Code 约 15–20 个。首个请求的数量其实差得不远，真正多的是功能族被拆得太细：LSP 13 个、终端 6 个、Git 8 个、浏览器 5 个、记忆 5 个。模型挑工具时选项多，按需加载时要点名的名字也多。

本设计**合并功能族，不删能力**：每项现有能力在合并后都还有一个入口。

## 使用数据

来源：本仓库 `.yuantu/sessions.sqlite`，共 16 个会话、约 760 次工具调用（另一个项目的库只有 1 个会话，且没有工具调用）。样本小，只能说明方向，不足以作为删除依据。

| 调用次数   | 工具                                                                                                                                                                                                                                                                                                                                              |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 100 次以上 | `read_file` 245、`search_files` 192                                                                                                                                                                                                                                                                                                               |
| 10–100 次  | `run_command` 96、`list_files` 50、`run_code` 33、`write_file` 25、`edit_file` 16、`ask_user_question` 12                                                                                                                                                                                                                                         |
| 2–9 次     | `web_fetch` 7、`load_tools` 7、`git_status` 5、`git_log` 4、`present` 3、`git_diff` 2、`browser_open` 2、`todo_write` 2、`job_output` 2                                                                                                                                                                                                           |
| 1 次       | `web_search`、`start_command`、`git_worktrees`、`git_branches`                                                                                                                                                                                                                                                                                    |
| 0 次       | 全部 `lsp_*`、全部 `terminal_*`、全部记忆工具、`apply_patch`、`batch_edit`、`delete_file`、`move_file`、`repo_map`、`read_image`、`run_validation`、`discover_validations`、`verify_file_delivery`、知识库索引、`job_list`、`job_kill`、`write_command`、`git_stage`、`git_commit`、`git_worktree_create`，以及除 `browser_open` 以外的浏览器工具 |

（`scan_*`、`completion_step`、`verify_work`、`exit_plan_mode` 是内置服务或运行内工具，不在本次范围内。）

## 合并规则

1. **只合并权限声明相同的工具。** `Tool.permission` 是按工具静态声明的：只读运行靠它过滤，审批也按它发起，只读子代理的白名单（`EXPLORE_TOOLS`）按工具名列出。所以一个功能族最多合并成"不需要权限的一个"加上"每种权限各一个"。把读和写塞进同一个工具，就得把权限改成按调用判断，这会动到工具契约和审批，不在本次范围内。
2. **合并后用 `action` 参数区分操作**，各操作原有的参数原样保留。schema 采用扁平写法：`action` 是枚举，其余参数都列在同一层，各 `action` 需要哪些参数在执行时校验，缺了就报错，并在错误里说明该 `action` 要哪些参数。不用 `oneOf`/`anyOf` 分支，因为有的接口严格模式不支持（`packages/providers/strict-tools.ts` 的转换要逐个验证）。
3. **`query` 标记**：合并后的工具只有在所有操作都是查询时才标 `query`，否则不标。这样做的代价是：有些原本是查询的操作，不再计入重复查询保护。受影响的是 `lsp`（`lsp_code_action` 和 `lsp_stop` 不是查询）和 `browser`。这些都是按需加载、使用很少的工具，可以接受。
4. **并发**：`isConcurrencySafe(args)` 本来就按单次调用判断，合并后按 `action` 返回原来的值。
5. **只读子代理**：`EXPLORE_TOOLS` 改用新工具名。原来有意排除的操作（`lsp_servers`、`lsp_stop` 会管到父运行的资源），通过分组把它们放进子代理白名单之外的那个工具。

## 目标清单

| 功能族                 | 现在                                                                                                                                            | 合并后                                                                              | 权限       | 说明                                                                                           |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- | ---------- | ---------------------------------------------------------------------------------------------- |
| 文件读取               | `read_file`、`read_image`、`list_files`                                                                                                         | 不变                                                                                | —          | `read_image` 不是查询（图片每次展示都算新证据），所以不并进 `read_file`                        |
| 文件写入               | `write_file`、`edit_file`、`batch_edit`、`apply_patch`                                                                                          | `write_file`、`edit_file`（吸收 `batch_edit`，接受跨文件的修改数组）、`apply_patch` | write      | `batch_edit` 的原子性（全部成功或全部不改）由 `edit_file` 的多文件形式继承                     |
| 文件移动删除           | `delete_file`、`move_file`                                                                                                                      | `manage_file`，`action: move \| delete`                                             | write      | 两者都走文件日志，可以撤销；这是不改走 shell 的原因                                            |
| 搜索                   | `search_files`、`repo_map`                                                                                                                      | 不变；`repo_map` 改为按需加载                                                       | —          | `repo_map` 调用 0 次                                                                           |
| Git 只读               | `git_status`、`git_diff`、`git_log`、`git_branches`、`git_worktrees`                                                                            | `git`，`action: status \| diff \| log \| branches \| worktrees`                     | —，查询    | 只读运行和子代理要用，所以不改成 shell                                                         |
| Git 写入               | `git_stage`、`git_commit`、`git_worktree_create`                                                                                                | `git_change`，`action: stage \| commit \| worktree_create`                          | command    | 仍然不提供 push、amend、rebase、reset                                                          |
| LSP 查询               | `lsp_diagnostics`、`lsp_definition`、`lsp_references`、`lsp_hover`、`lsp_symbols`、`lsp_workspace_symbols`、`lsp_code_action`（只列出可用操作） | `lsp`，`action` 对应这 7 种                                                         | —          | 子代理可用                                                                                     |
| LSP 服务管理           | `lsp_servers`、`lsp_start`、`lsp_stop`                                                                                                          | `lsp_server`，`action: list \| start \| stop`                                       | command    | `list` 和 `stop` 原本不需要权限，合并后要走命令审批，比原来严格。这两个操作调用 0 次，可以接受 |
| LSP 编辑               | `lsp_rename`、`lsp_apply_code_action`                                                                                                           | `lsp_edit`，`action: rename \| apply_code_action`                                   | write      |                                                                                                |
| 终端读取               | `terminal_list`、`terminal_read`                                                                                                                | `terminal_read`（不带 id 时列出全部）                                               | —          |                                                                                                |
| 终端操作               | `terminal_open`、`terminal_send`、`terminal_signal`、`terminal_close`                                                                           | `terminal`，`action: open \| send \| signal \| close`                               | command    |                                                                                                |
| 浏览器                 | `browser_open`、`browser_click`、`browser_fill`                                                                                                 | `browser`，`action: open \| click \| fill`                                          | external   |                                                                                                |
| 浏览器截图             | `browser_screenshot`                                                                                                                            | 不变                                                                                | write      | 会往工作区写文件                                                                               |
| 浏览器关闭             | `browser_close`                                                                                                                                 | 删除                                                                                | —          | 浏览器会话已经按会话池管理，空闲时自动关闭。这是唯一去掉入口的能力，见"待定"                   |
| 记忆读取               | `list_memories`、`read_memory`                                                                                                                  | `read_memory`（不带 key 时列出全部）                                                | —，查询    |                                                                                                |
| 记忆写入               | `save_memory`、`forget_memory`、`restore_memory`                                                                                                | `save_memory`，`action: save \| forget \| restore`                                  | write      | `CHILD_DENIED_TOOLS` 变成只有这一个名字                                                        |
| 知识库                 | `recall_knowledge`；`index_document`、`remove_indexed_document`                                                                                 | `recall_knowledge`；`index_document`，`action: add \| remove`                       | —；write   |                                                                                                |
| 命令与作业             | `run_command`、`start_command`、`write_command`、`run_code`、`job_list`、`job_output`、`job_kill`                                               | **第二阶段**，见下文                                                                |            |                                                                                                |
| 验证                   | `discover_validations`、`run_validation`                                                                                                        | 不变                                                                                | —；command | 自动验收在用                                                                                   |
| 交付、网络、交互、目录 | `verify_file_delivery`、`present`、`web_search`、`web_fetch`、`ask_user_question`、`todo_write`、`load_skill`、`load_tools`                     | 不变                                                                                |            |                                                                                                |

### 第一阶段之后

- 注册数：67 → 39（含终端；不含命令与作业的合并）。
- 首个请求：26 → 20（`git` 合并后少 2 个，`read_memory` 少 1 个，`save_memory` 少 2 个，`repo_map` 改为按需加载，少 1 个；`job_*` 暂不动）。

### 第二阶段：命令与作业

`run_command` 吸收 `start_command`（加 `background: true`）；`job_list`、`job_output`、`job_kill` 合成 `job`，`action: list | output | kill`，不需要权限；`write_command` 保留（它需要 command 权限，和 `job` 的权限不同）。合并后 7 → 4，首个请求再少 2 个，降到 18 个；全部工具降到 36 个。

单独分一个阶段，是因为这几个名字在别处引用最多：`job_output` 出现在内置服务（`packages/builtin-services/remote-tools.ts`、`tasks.ts`）、运行提示词（`packages/core/run/prompt.ts`）、子代理结算（`packages/core/subagents/*`）、存储投影与会话检索（`packages/storage/events.ts`、`projections.ts`、`session-search.ts`），`start_command` 还出现在桌面渲染（`apps/desktop/renderer-messages.ts`）和自动验收（`packages/core/completion/automatic-verification.ts`）里。存储投影是按工具名从历史事件推导状态的，改名必须同时认旧名，不然旧会话会读错。

### 不采用的激进做法

像 Codex 那样把 Git、LSP、验证、终端全交给 `run_command`，可以把全部工具压到 25 个左右。不采用的原因：

- 只读运行和只读子代理不能执行命令，会因此失去 Git 和 LSP；
- `git_commit` 单独存在，是为了守住"提交不在文件撤销覆盖范围内、不提供 push"这条边界，改走 shell 就只能靠命令审批来守；
- 文件移动和删除改走 shell，就失去撤销日志。

## 兼容

- **旧名别名**：注册表维护一张 `旧名 → 新名 + action` 的表。执行时遇到旧名就改写成新调用，不在目录里宣告旧名。这样续接的旧会话里，模型照旧名调用也能执行。别名保留一个版本，之后删除。
- **按需加载记录**：`deferredToolUsage` 和"本会话已加载哪些工具"都从对话记录推导。推导时先把旧名映射成新名，旧会话里加载过的工具才不会失效。
- **历史消息**：旧会话里旧名的工具调用照原样留在历史里。各家模型接口对历史中出现不在当前工具列表里的工具名，接受程度可能不同，第一阶段要逐家验证（Anthropic、OpenAI、兼容接口）。不接受的接口，就在组装请求时按别名表把历史里的名字改写成新名。
- **工作区钩子与权限策略**：`PreToolUse` 之类的钩子按工具名匹配。旧名匹配同样经别名表映射，并在 README 里写明哪些名字改了。
- **桌面界面**：工具卡片的标题、图标和摘要按工具名查找文案（`apps/desktop` 下的 i18n 和渲染代码），要为新名补文案，并按 `action` 显示具体操作。

## 测试

- 每个合并后的工具，原来每个工具的测试都改成调用新名 + `action`，覆盖的行为不变。
- 别名表：每个旧名都能执行，结果和新名一致；目录里不出现旧名。
- 只读运行：合并后，带权限的工具仍然被过滤；`EXPLORE_TOOLS` 不包含 `lsp_server`。
- 严格模式：每个合并工具的 schema 都能通过 `strict-tools` 的转换；每个 `action` 缺少必填参数时，返回的错误说清楚缺什么。
- 快照与 README 的自动生成数字随之更新；用 `scripts/docs-facts.mjs` 量出新的工具数和字节数，写进提交说明。
- 第二阶段另外测：旧会话的作业投影、会话检索在新旧名混合的历史上结果正确。

## 待定（需要确认）

1. `browser_close` 直接删除，还是作为 `browser` 的一个 `action` 保留（那样就要走 external 审批）。
2. `lsp_server` 的 `list` 和 `stop` 合并后需要命令审批，比现在严格，能否接受。
3. 别名保留一个版本后删除，还是长期保留。
4. 第二阶段（命令与作业）是否跟第一阶段一起做。
