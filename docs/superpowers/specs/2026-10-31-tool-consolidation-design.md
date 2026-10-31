# 工具发现与加载优化

> 修订（2026-10-31）：本文取代同名文件的上一版"按功能族合并"方案，以及据此写的 `docs/superpowers/plans/2026-10-31-tool-consolidation-phase1.md`。方向改为：保留边界清楚的原子工具，优先优化发现与加载；合并只挑少数几处做，不以工具数作为目标。

## 背景

空工作区里宿主注册 67 个工具，默认模式下首个请求带 26 个、约 18.6 KB，其余 41 个按需加载，模型通过 `load_tools` 加载。对比的参照是 Claude Code：它同时保留 Read、Edit、Write、Grep、Glob 这些原子工具，并不追求工具少，而是让每个工具边界清楚。

问题不在工具多，而在两处：

1. **首轮负担**：有些首轮就发的工具几乎不用，却占了不少字节。
2. **发现成本**：`load_tools` 的描述里逐个列出 41 个名字；模型要知道"有什么"，只能读这张长清单。按领域加载时，也只能逐个点名或靠关键词猜。

## 目标与衡量

不看工具数，看这三个指标，改动前后各量一次：

| 指标                                              | 怎么量                                                                                             |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| 首个请求的 schema 字节数                          | `npm run bench` 新增的 `tools.schema.firstRequest`，以及 `scripts/docs-facts.mjs`（README 生成块） |
| 每次会话花在 `load_tools` 上的轮数                | `scripts/deferred-tool-usage.mjs` 的 `loadCalls`（补上 namespace 加载的识别）                      |
| 加载没命中的次数：`load_tools` 失败、调用未知工具 | 同上，新增的 `loadMisses`、`unknownCalls`                                                          |

现有使用数据：本仓库 `.yuantu/sessions.sqlite` 里 16 个会话、约 760 次调用。`read_file` 245 次、`search_files` 192 次、`run_command` 96 次；记忆、知识库、LSP、终端工具 0 次。样本小，只用来定方向。

## 设计

### 1. 按 namespace 发现与加载

现有的 `DEFERRED_GROUPS`（`packages/tools/deferred-tools.ts`）已经按领域分组，每组有一句提示。在此基础上：

- 每组加一个短的 namespace 键：`lsp`、`browser`、`terminal`、`git`、`files`、`validation`、`jobs`、`knowledge`、`web`、`delivery`、`sessions`、`goal`、`memory`（第 2 节新增）。
- `load_tools` 的描述按 namespace 列出，每行以 namespace 键开头，后面是这一组的提示和组内工具名：`- lsp — language server (...): lsp, lsp_start, lsp_edit`。组内工具名照旧列出，因为模型可以不经加载直接调用按需加载的工具，前提是知道名字。改完后要列的名字共 38 个：原来的 41 个，LSP 由 12 个合成 3 个，再加上第 2 节移出首轮的 6 个。加载结果里再给每个工具附一句用途。
- `load_tools` 新增 `namespace` 参数（一个或多个），一次加载整组。按名字加载、按关键词搜索照旧可用。
- 关键词搜索除了工具名和组提示，也匹配 namespace 键。
- 按需加载的工具本来就可以不经加载直接调用（`LOAD_TOOLS_DESCRIPTION` 已经这样说明），这一点不变。

namespace 只是发现和加载的分组，**工具名不变**。所以工具白名单、权限规则、钩子、历史记录、自动验收都不受影响。

### 2. 按使用数据调整首轮发送的工具

首轮就发的工具里，记忆和知识库 6 个合计约 5 KB，占首个请求的四分之一以上，样本里 0 次调用。不过 `deferred-tools.ts` 的注释记着一次真实模型对比："记住这个"这类请求很常见，首轮就发记忆工具，比多花一轮加载更划算。两者并不矛盾：常用的是"保存"，读取、列出、遗忘、恢复很少用。

- 改为按需加载，归入新的 `memory` namespace：`list_memories`、`read_memory`、`forget_memory`、`restore_memory`。
- `save_memory` 照旧首轮就发。
- `recall_knowledge` 改为按需加载，归入 `knowledge`。
- `repo_map`（0 次调用）改为按需加载，归入 `files`。
- `read_image`、`job_list`、`job_kill` 暂不动：`read_image` 是用户贴图后模型的第一反应，`job_*` 还要读子代理作业（注释里写明了原因）。

验收方式：用基准测试（`npm run bench`，以及可用时的真实模型评测）比较改动前后"记住某件事"和"回忆之前记住的事"两类任务所花的轮数。回忆类任务的轮数如果明显变多，就把 `read_memory` 放回首轮。

### 3. LSP 合并为 3 个工具

LSP 的 12 个工具在用法上高度同构：都按"文件、行、列"定位，只是问的事情不同。这里是唯一值得合并的地方。按权限分成 3 个：

| 新工具      | 包含的操作                                                                                                                              | 权限       |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| `lsp`       | `diagnostics`、`definition`、`references`、`hover`、`symbols`、`workspace_symbols`、`code_actions`（只列出可用操作）、`servers`、`stop` | 不需要审批 |
| `lsp_start` | 不变                                                                                                                                    | 命令审批   |
| `lsp_edit`  | `rename`、`apply_code_action`                                                                                                           | 写入审批   |

- `lsp` 和 `lsp_edit` 用 `action` 参数区分操作，schema 是扁平的一层：`action` 是枚举，其余参数平铺；各操作自己的参数按原工具的 schema 在执行前校验。`lsp_start` 保持原样。
- 这三个工具都只合并权限相同的操作。工具契约不改，`permission` 仍是按工具固定的声明。
- 只读子代理（`EXPLORE_TOOLS`）原来就不允许 `lsp_servers` 和 `lsp_stop`，因为它们管的是父运行的服务器。合并后要能按操作限制：只读子代理的 `lsp` 不包含 `servers` 和 `stop`，schema 里也不出现。注册表的限制机制因此要支持按操作限制。
- 合并后 `lsp` 不是查询工具了（`code_actions` 和 `stop` 本来就不是查询），重复查询保护不再覆盖它。LSP 调用很少，可以接受。

**旧名兼容**（只涉及 11 个旧 LSP 名，`lsp_start` 不改名；没有和新名同名的情况）：

- 注册表：旧名调用改写成"新名 + action"再执行。
- 权限规则：`tool` 写旧名的规则，改写成新名，并在 `match` 里加上 `action`。有 `arguments` 的精确匹配规则，就把 `action` 加进 `arguments`。旧名和新名不会同名，所以只会缩窄，不会放大授权范围。
- 工具白名单（`YUANTU_TOOL_ALLOWLIST`）：旧名只放开它原来那一个操作；写 `lsp` 就是整个工具。
- 钩子：matcher 写旧名，也能匹配对应的操作；payload 加 `tool_action`。
- 按需加载：`load_tools` 执行时认旧名；从历史推导"已加载"时，把旧名换成新名。
- 历史消息：在各协议的适配器里，把历史中旧 LSP 名的工具调用改写成新名加 `action`，包括可见的 `toolCalls` 和原生 `providerState.output` 里的工具调用项（Responses 的 `function_call`、Anthropic 的 `tool_use`、OpenAI 兼容接口的 `tool_calls`）。推理内容一字不动：Responses 的 `reasoning`、Anthropic 的 `thinking` / `redacted_thinking`、`reasoning_content`，因为工具循环进行到一半时，接口要求把它们原样带回。是否回放原生状态，仍按原始消息的哈希判断。要在三个适配器层面验证实际请求体：推理内容还在，旧名不在。
- 模型看得到的文字：工具描述、报错和提示词里提到旧 LSP 名的，都改成新写法。
- 旧名保留一个版本，之后删除。

### 4. 精简描述

每个工具的描述只写两件事：什么时候用，和相邻工具有什么区别；细节放进参数说明。先处理首轮就发、又特别大的几个：`save_memory`（1.8 KB）、`ask_user_question`（1.5 KB）、`run_command`（1.1 KB）、`run_code`（1.1 KB）。每改一个，都要确认相关的提示行为测试和快照不退化；描述里的约束如果是以前为修某个真实问题加的（看代码注释和 git 历史），就保留。

### 5. 不做的事

- 不把其他功能族合并成 action 工具。Git、终端、浏览器、文件、记忆、知识库都保持原子工具。
- `browser_close` 保留为单独的操作。
- 候选合并（默认不做）：`terminal_list` 并入 `terminal_read`（不带 id 时列出），`job_list` 并入 `job_output`（不带 id 时列出）。等有数据显示模型在这两处选错工具，再考虑。

## 预期效果（以实测为准）

- 首个请求：26 个 → 20 个工具，字节数大约少 5–6 KB（记忆、知识库、`repo_map` 改为按需加载）。
- 全部工具：67 个 → 58 个（LSP 12 个 → 3 个）。
- `load_tools` 的描述：按需加载的工具由 41 个变为 38 个，按 13 个 namespace 分组（新增 `memory`），每行以 namespace 键开头。

## 测试

- `load_tools`：`namespace` 加载整组；旧的按名字加载、关键词搜索不退化；namespace 键能被搜索命中。
- 首轮清单：按需加载的工具不出现在首个请求里，`save_memory` 还在。
- 只读子代理等多层限制叠加时，按操作限制取交集；交集为空时整个工具隐藏并拒绝执行，不发出空的 `action` 枚举。
- LSP：每个操作通过新工具执行，结果和原来的工具一致；参数错误时，错误信息说明是哪个操作、缺了什么；只读子代理看不到也调不了 `servers`、`stop`；旧名在注册表、权限规则、白名单、钩子、按需加载、历史和三个适配器的请求体里都按上面的规则处理。
- 描述精简：快照里只有被改的那几段描述变了；对应的提示行为测试通过。
- 用基准测试记录第 2 节的轮数对比，写进提交说明。
