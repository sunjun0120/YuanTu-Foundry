# 记忆重构设计：一条一文件、运行时索引、并发安全

> 日期：2026-10-30。仓库：`E:\agent-desktop\YuanTu-Foundry`，基线 `4c5797e`。
> 范围：`packages/knowledge/memory.ts`、`packages/knowledge/tools.ts`、`packages/knowledge/context.ts`、`packages/core/run/snapshots.ts`、`packages/core/prompt/notices.ts`、`packages/workspaces/runtime-exclude.ts`、子代理委派的工具过滤，以及 README 中的记忆章节。
> 参考：Claude Code 的自动记忆（一条记忆一个带 frontmatter 的 markdown 文件，加一个注入上下文的索引）。
> 状态：待定问题已在 §8 定案；P0（存储、并发、迁移、Git 排除）、P1（索引注入、`read_memory`、写入规范）和 P2（子代理只读、worktree 记忆归属）都已实现。
> P2 实现说明（和 §4.4、§4.8 原方案的差异）：
>
> - 禁用写工具没有新加 `toolDeny` 能力，而是在 `core/run/child-turns.ts` 里，对每个子代理的工具表统一加一条按名字的拒绝规则（`CHILD_DENIED_TOOLS`）。所有进程内子代理都经过这一处；subprocess provider 只接受 explore 任务，它的白名单里本来就没有写工具。
> - `memoryRoot` 没有新开一条委派链参数，而是直接用已有的事实：每轮注入用会话的 project（`Session.workspace`），子代理的工具用 `binding.projectRoot`。这两者在协议里都定义为"逻辑项目，从不被执行目录替换"。
> - subprocess 子代理通过 `YUANTU_MEMORY_ROOT` 读委派方项目的工作区记忆，取值是 `SubAgentParent.project`，没有时用 `parent.workspace`。为此在委派链上补了一个可选的 `project` 字段。这一条改变了早先"subprocess 子代理只看用户级记忆"的决定：它仍然碰不到本会话的其他文件，只多了这一个目录的只读访问。`memoryPaths` 把借来的位置标成 `readOnly`，所以这个位置上保存、删除都会被拒绝，旧版 `memory.md` 的迁移也会跳过，留给项目自己的 Host 去做。
>   P1 实现说明：`list_memories` 按作用域分组返回，所以每条里不再重复 `scope` 字段；`read_memory` 已加入 explore 子代理的白名单。
>   来源字段只记 `session`、不记 `agent`：按 §8 第 1 条，子代理不能写记忆，所有写入都来自主 agent。

## 1. 结论摘要

现在的记忆机制在多 agent 同时运行时有两类问题：

1. **会丢数据。** `saveMemoryEntry` 先读出整个文件，再整份写回，中间没有锁也没有版本检查。两个 agent 并发保存**不同的 key**，后写入的那份会把先写入的那条覆盖掉，而且不报错。
2. **会串台。** 同一工作区的所有会话和子代理共享同一份记忆，每轮都会重新注入，这本身符合设计。但条目没有类型、没有来源，也没有写入规范，一个 agent 的临时任务状态很容易被别的 agent 当成长期事实。另外，`worktree` 模式的子代理既看不到项目已有的工作区记忆（快照不复制 `.yuantu`），自己写的记忆也只留在 worktree 里。

本设计的改法：

- **一条记忆一个文件**（`.yuantu/memory/<key>.md`），带 frontmatter，包括 `type`、`description`、更新日期和来源。不同 key 写的是不同文件，从结构上消除"不同 key 互相覆盖"。
- **索引由运行时扫目录生成，不落盘，模型也不维护。** 这一点和 Claude 不同。Claude 的 `MEMORY.md` 由模型手动加行，多会话并发时是冲突热点。
- **同一个 key 的写入用 revision 做乐观并发**：覆盖或删除已有条目时，必须带上读到的 revision，不一致就拒绝，并返回当前内容。进程内再按路径串行化，保证"检查加写入"是原子的。
- **注入从正文改成索引**：每条只注入一行描述，短的 user/feedback 类条目内联正文。"超过 12 条就看不见"的问题随之消失。正文用新增的 `read_memory` 按需读取。
- **worktree 子代理的工作区记忆指回委派方的工作区**；子代理一律只读主记忆、拿不到写记忆的工具。
- 旧的单文件 `memory.md` 首次访问时自动迁移，原文件改名保留，不删除。

## 2. 现状

### 2.1 存储与读写

| 项目     | 现状                                                                                                       | 位置                             |
| -------- | ---------------------------------------------------------------------------------------------------------- | -------------------------------- |
| 文件     | 工作区 `<workspace>/.yuantu/memory.md`，用户级 `<YUANTU_MEMORY_DIR 或用户状态目录>/memory.md`              | `memory.ts:40`                   |
| 条目格式 | 一行一条：`- **<key>**: <text> (YYYY-MM-DD)`；非条目文本作为 preamble 原样保留                             | `memory.ts:28`、`memory.ts:54`   |
| 写入     | `readMemoryFile` 同步读出，修改后 `await atomicWriteFile` 整份写回；无锁、无版本                           | `memory.ts:124`、`memory.ts:142` |
| 原子性   | 临时文件 + fsync + rename，只保证不出现半截文件                                                            | `platform/write-all.ts:30`       |
| 限额     | 每个作用域 64 条；单条 500 字；文件 32KB                                                                   | `memory.ts:32`                   |
| 注入     | 每轮由 `snapshots.ts:148` 调 `memoryContext`，先工作区后用户级，最多 12 条、4000 字，注入的是正文          | `memory.ts:163`                  |
| 工具     | `recall_knowledge`、`list_memories`（可并行读）、`save_memory` / `forget_memory`（写，需审批，run 内互斥） | `tools.ts:42`                    |
| 提示     | 系统提示一句话：保存跨会话有用的偏好和决定                                                                 | `prompt/notices.ts:41`           |
| Git      | `info/exclude` 排除 `.yuantu/*`，放回 `memory.md`                                                          | `runtime-exclude.ts:50`          |

### 2.2 进程模型（决定并发方案）

- 每个工作区只有一个 Host 进程（`platform/host-lock.ts:175`），该工作区的会话和进程内子代理都在这个进程里写记忆。**例外**：subprocess provider 会把子代理跑在独立的子进程里（`core/subagents/subprocess.ts`），工具表通过 `YUANTU_TOOL_ALLOWLIST` 传入。所以工作区记忆的写入方**不一定**都在同一进程。
- **用户级记忆跨工作区共享**，写入方可能在多个 Host 进程中。
- `save_memory` 声明了 `permission: 'write'`，每次写入都要经过审批，写入频率受人的操作节奏限制。

### 2.3 问题清单

| #   | 问题                                                                | 后果                                                                                    |
| --- | ------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Q1  | 读改写之间没有锁：A 已经读完、还在 `await` 写入时，B 读到的是旧文件 | 并发保存不同 key 时会丢条目，且不报错；注释里"按 key 后写者胜"和实际行为不符            |
| Q2  | 覆盖同一个 key 时不检查对方是否已经改过                             | 模型基于旧内容"合并"后写回，把别人的更新冲掉                                            |
| Q3  | 注入的是正文，最多 12 条                                            | 第 13 条以后平时看不见，只能靠 `recall_knowledge` 的子串搜索碰运气                      |
| Q4  | 条目没有类型、描述和来源                                            | 模型分不清哪条是偏好、哪条是项目决定、哪条是别的任务的残留；出了问题也查不到是谁写的    |
| Q5  | 写入规范太弱                                                        | 容易存进任务进度、代码里能查到的事实，或者重复的条目                                    |
| Q6  | worktree 子代理以自己的 worktree 为 `root`，而快照不复制 `.yuantu`  | 子代理看不到已有的工作区记忆；它写的记忆落在 worktree 里，对父 agent 和后续会话都不可见 |
| Q7  | 所有非 explore 子代理都能写记忆                                     | 子代理的局部视角直接变成全局记忆，是串台的主要来源                                      |
| Q8  | 单条 500 字                                                         | 装不下"为什么"和"怎么用"                                                                |

## 3. 参考：Claude 的做法与取舍

| Claude Code 的做法                                                                                   | 本设计                                                                                                                               |
| ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| 一条记忆一个文件，frontmatter 有 `name`、`description`、`metadata.type`                              | **采纳**。字段见 §4.2                                                                                                                |
| 四种类型：user / feedback / project / reference                                                      | **采纳**，类型名不变                                                                                                                 |
| feedback 和 project 类正文写 **Why:** 和 **How to apply:**                                           | **采纳**，写进工具描述（§4.7）                                                                                                       |
| `MEMORY.md` 索引，每条一行，由模型维护，会话开始时加载                                               | **改动**：索引由运行时扫目录生成，不落盘，每轮刷新（沿用现有 per-round snapshot）                                                    |
| 用 `[[name]]` 互相链接                                                                               | **暂不做**：没有消费方，列为后续                                                                                                     |
| 写之前先查有没有现成的条目，有就更新                                                                 | **采纳并强制**：覆盖时必须带 revision（§4.3）                                                                                        |
| 不存代码结构、git 历史、只跟本次对话有关的内容                                                       | **采纳**，写进工具描述                                                                                                               |
| 相对日期转成绝对日期                                                                                 | **采纳**，写进工具描述                                                                                                               |
| 记忆是背景而不是指令；提到的文件、函数、开关，用之前先确认还存在                                     | **采纳**，写进注入时的提示                                                                                                           |
| 编辑前必须先读，文件读后被改过则拒绝（Edit 工具的通用机制）                                          | 用 revision 实现同样的效果                                                                                                           |
| 主会话的记忆不加载给子代理（fork 除外）；子代理用 `memory` 字段开启**按 agent 名隔离**的独立记忆目录 | **改动**：子代理**只读**主记忆、不能写（§4.8）。YuanTu 的子代理按角色委派，没有具名 agent 定义这一层，完全看不到项目约定反而容易出错 |
| 记忆目录按 git 仓库推断，同一仓库的所有 worktree 共用一份                                            | **改动**：只有 YuanTu 自己创建的子代理 worktree 通过委派链显式指回委派方，用户自建的 git worktree 各有一份（§4.4）                   |
| `MEMORY.md` 加载前 200 行或 25KB，写入后运行时测量大小，接近或超过上限时提醒精简                     | 索引由运行时生成，用注入预算控制大小（§4.5），不需要提醒模型去精简                                                                   |

不照搬索引文件的原因：YuanTu 的上下文本来就由运行时每轮组装，扫一遍目录（最多 128 个文件的 stat）成本很低。让模型去维护一个所有会话都要写的共享文件，正是 Q1 那类冲突的来源。

## 4. 设计

### 4.1 存储布局

```
<workspace>/.yuantu/memory/
  build-command.md        # 一条记忆
  release-process.md
  _notes.md               # 用户自由文本（原 preamble），运行时不解析
<YUANTU_MEMORY_DIR 或用户状态目录>/memory/
  reply-language.md
```

- 文件名就是 `<key>.md`，key 规则沿用 `^[a-z0-9][a-z0-9._-]{0,63}$`。
- 以 `_` 或 `.` 开头的文件不算条目。key 不能以这两个字符开头，所以不会和条目冲突。原子写的临时文件 `.<name>.yuantu-*.tmp` 也会被自然跳过。
- **新增规则：拒绝 Windows 保留设备名**（`con`、`prn`、`aux`、`nul`、`com1`–`com9`、`lpt1`–`lpt9`，以及它们带任意扩展名的形式，比如 `con.x`）。现在的 key 规则允许 `con`，改成一条一文件后，这类 key 在 Windows 上会写失败，或者写到设备上。
- 按 key 规则文件名全是小写，在大小写不敏感的文件系统上不会撞名。

### 4.2 条目格式

```markdown
---
name: build-command
description: 本仓库构建用 npm run build:desktop，不要直接调 tsc
type: feedback
updated: 2026-10-30
session: s_8f3c…
---

构建桌面端必须用 `npm run build:desktop`。

**Why:** 直接调 tsc 不会生成 preload 产物，启动后白屏。
**How to apply:** 任何需要构建验证的任务都用这条命令；只做类型检查时用 `npm run typecheck`。
```

| 字段          | 谁写               | 约束                                                           |
| ------------- | ------------------ | -------------------------------------------------------------- |
| `name`        | 运行时（等于 key） | 只供人阅读；和文件名不一致时以文件名为准                       |
| `description` | 模型               | 必填，1–150 字，单行；要能单独看懂，因为注入时通常只显示这一行 |
| `type`        | 模型               | 必填，`user` / `feedback` / `project` / `reference`            |
| `updated`     | 运行时             | `YYYY-MM-DD`，每次写入时更新                                   |
| `session`     | 运行时             | 写入时所在的会话 id                                            |
| 正文          | 模型               | 必填，最多 2000 字                                             |

- frontmatter 只支持上面这些**单行 `key: value`**，不引入 YAML 依赖。解析器遇到不认识的行原样保留，用户手写的其他字段不会丢。
- 用户手工编辑的文件如果缺少 `type` 或 `description`，照样能读：`type` 当作 `project`，`description` 取正文第一行的前 150 字。
- 单个文件上限 8KB，每个作用域上限 64 条，两条限额都沿用现有的报错方式。

### 4.3 并发写

目标：**不同 key 永远不会互相影响；同一个 key 不会被悄悄覆盖。**

1. **不同 key**：写的是不同文件，互不相干，Q1 从结构上消失。
2. **revision**：取文件字节的 sha256 前 12 位。`list_memories`、`read_memory` 和 `save_memory` 的返回值都带上它。
3. **覆盖或删除已有条目时必须带 `revision`**：
   - 文件存在、但没传 revision：拒绝，错误里附上当前内容和 revision，模型合并后重试。
   - revision 不一致：同样拒绝，附上当前内容和 revision。
   - 文件不存在、却传了 revision：说明已被别人删掉，拒绝。
   - 新建条目（文件不存在，也没传 revision）：直接创建。同一进程内，第 4 点的队列保证另一个调用会看到已创建的文件，并按"没带 revision 覆盖已有条目"处理；跨进程时，适用第 5 点所说的竞争窗口。
4. **进程内串行化**：按规范化后的文件路径维护一个 `Map<string, Promise>` 队列，写法和 `workspaces/git.ts:423` 的 `withRepositoryLock` 相同。"读 revision → 校验 → 原子写"整个过程在队列里执行，同一进程内的两个调用不会同时通过校验。
5. **跨进程**：用户级记忆会跨 Host 进程；subprocess 子代理虽然跑在独立进程里，但按 §4.8 它们没有写工具，所以工作区记忆的写入方始终在 Host 进程内。校验和 rename 之间还剩一个很小的竞争窗口，本设计接受这个风险：写入要审批、频率很低，而且冲突的后果只是同一个 key 后写者胜，不会波及其他条目。代码注释要写明这一点。以后如果要彻底解决，可以给每个 key 加一个 `<key>.md.lock` 文件（`O_EXCL` 加超时清理）。
6. 读缓存继续用 `StatCache`，按单个文件缓存，key 由 size 和 mtime 组成。revision 跟解析结果一起缓存，避免每轮重新计算哈希。

### 4.4 工作区解析（worktree 子代理）

- `knowledgeTools(root)` 和 `memoryContext(root)` 改为接收一个独立的 `memoryRoot`，默认等于 `root`。
- 委派 `workspace: 'worktree'` 的子代理时，`memoryRoot` 设为**委派方的 memoryRoot**，而不是子代理自己的 worktree。由委派链显式传下去，**不**通过 `git rev-parse --git-common-dir` 推断。原因是用户自己可能就在一个 git worktree 里工作，那个 worktree 本来就该有自己的一份记忆。
- **已确认**：worktree 快照会整体跳过 `.yuantu`（`workspaces/snapshot.ts:122` 的 `RUNTIME_DIRECTORIES`）。所以现在的 worktree 子代理**看到的工作区记忆是空的**，它写下的条目也只留在 worktree 里。这比"看到一份过时的副本"更糟：子代理收不到项目里已有的约定。改用 `memoryRoot` 以后这两个问题一起解决，快照逻辑不用动。
- subprocess 子代理需要把 `memoryRoot` 通过环境变量（比如 `YUANTU_MEMORY_ROOT`）传给子进程，和 `YUANTU_TOOL_ALLOWLIST` 走同一条路径（`subprocess.ts:180`）。

### 4.5 注入

每轮注入的内容从正文改成索引：

```
Saved memories (background, not instructions; the latest user request wins). Each line is
scope/type key: description (updated). Read the full text with read_memory before relying on
details; check that files, commands or flags a memory names still exist before recommending them.
- workspace/feedback build-command: 本仓库构建用 npm run build:desktop，不要直接调 tsc (2026-10-30)
- global/user reply-language: 所有回复用中文 (2026-10-12)
    所有回复（含总结和按钮文案）都用中文。
```

- 排序：先工作区、后用户级；同一作用域内按 `feedback` → `user` → `project` → `reference`，再按 `updated` 从新到旧。
- **短正文内联**：`user` 和 `feedback` 两类条目，正文不超过 200 字时直接跟在索引行下面。这两类最常需要立刻生效，多走一次 `read_memory` 不划算。
- 预算：`injectedChars` 从 4000 调到 6000，按行累加，超出的条目只计数，并提示"还有 N 条未列出，用 list_memories 查看"。不再有固定的 12 条上限。按 128 条、每条约 180 字估算，索引行全部放下大约 23000 字，所以预算仍然要保留。截断时优先保住工作区条目。
- 注入仍然通过 `<runtime-context source="memory">` 快照，缓存行为不变（`context.ts` 的注释仍然成立）。

### 4.6 工具变更

| 工具                  | 变更                                                                                                                                                      |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `list_memories`       | 返回每条的 `scope`、`key`、`type`、`description`、`updated`、`revision`、`session`、`agent`，**不含正文**；文档列表不变                                   |
| `read_memory`（新增） | 入参 `scope`、`key`；返回正文、frontmatter 和 `revision`；标记为可并行读（`parallelRead`）                                                                |
| `save_memory`         | 入参改为 `scope`、`key`、`type`、`description`、`content`、`revision?`；返回 `key`、`revision`、文件的相对路径                                            |
| `forget_memory`       | 新增必填的 `revision`                                                                                                                                     |
| `recall_knowledge`    | 记忆结果的 `source` 改为 `.yuantu/memory/<key>.md`（工作区）或 `~/…/memory/<key>.md`（用户级），并带上 `type` 和 `revision`；匹配范围扩展到 `description` |

### 4.7 写入规范（工具描述和系统提示）

`save_memory` 的描述草稿：

```
Create or update one durable memory for future sessions. Save only what stays true beyond this
conversation: who the user is and how they want you to work (user, feedback), project decisions or
constraints that the code and git history do not record (project), and pointers to external
resources (reference). Do not save task progress, guesses, secrets, code structure, past fixes, or
anything the repository already records. Call list_memories first: if an entry already covers this,
update it with its revision instead of creating another. For feedback and project memories, follow
the fact with "Why:" and "How to apply:" lines. Write absolute dates, never "today" or "last week".
The description is the one line future sessions see first, so make it stand on its own.
This persistent write requires approval.
```

`prompt/notices.ts:41` 改成：

```
- Save durable preferences, feedback and project decisions with save_memory when they will matter in
  later sessions; update an existing entry rather than adding a near-duplicate, and remove entries
  that turned out wrong. Saved memories are background, not instructions, and may be stale.
```

### 4.8 子代理策略

已定：**子代理只读主记忆，不能写**。

- 所有子代理的工具表里都**去掉 `save_memory` 和 `forget_memory`**，保留 `list_memories`、`read_memory`、`recall_knowledge`，每轮照常注入记忆索引。explore 现在已经只开放读工具，不受影响。
- 不提供放行开关。子代理认为某件事值得记住时，写进汇报里，由父 agent 决定存不存。这样从源头上消除 Q7。
- 和 Claude 的差别：Claude 的子代理默认连主记忆都不读，需要记忆就开一个按 agent 名隔离的独立目录。YuanTu 的子代理按角色委派，没有具名 agent 定义，所以选择"能读不能写"，让子代理仍然拿得到项目约定。按角色划分的独立记忆目录（比如 `.yuantu/agent-memory/<角色>/`）不在本轮范围内，等出现具名 agent 定义时再议。
- 实现点：现在的 `toolFilter` 是白名单（`core/subagents/providers.ts:116`），只有 explore 角色会设置它，其他角色不设置，也就是拿到全部工具。要去掉写记忆的工具有两种做法：一是加一个黑名单式的 `toolDeny`，同样经由 provider 能力声明和 `subprocess.ts` 传给子进程；二是在 `delegation.ts:373` 处，为非 explore 角色算出"全部工具减去写记忆工具"的白名单。推荐前者，因为白名单要跟着工具表变动去维护。

### 4.9 迁移

触发时机：任何读写操作访问某个作用域时，如果 `memory/` 目录不存在、旧的 `memory.md` 存在，就先迁移。

1. 用现有的 `parseMemory` 解析旧文件。
2. 每条写成 `memory/<key>.md`：
   - `type`：工作区条目为 `project`，用户级条目为 `user`
   - `description`：正文的前 150 字
   - 正文：原 text
   - `updated`：原日期
   - `session`：写 `migrated`
3. preamble 非空时写进 `memory/_notes.md`。
4. 旧文件改名为 `memory.md.migrated`，不删除。
5. 迁移放在该目录的进程内队列里执行。用户级记忆可能有多个进程同时迁移，但写出的内容完全一样，而且是先建目录、再写文件、最后改名，重复执行不会出问题；改名失败（另一个进程已经改过）当作成功处理。
6. 迁移时遇到 Windows 保留名的 key，改名为 `<key>-entry` 写入，并在 `_notes.md` 末尾记一行说明。

`knowledge.sqlite` 里早期版本留下的 `kind='memory'` 行保持现状（`store.ts:233` 的注释仍然成立）。

### 4.10 Git 排除规则

- `runtime-exclude.ts` 的放行行从 `!${prefix}/memory.md` 改为 `!${prefix}/memory/`。因为排除的是 `.yuantu/*`（目录里的内容），而不是 `.yuantu` 本身，对子目录做否定是有效的。
- **已有仓库的兼容问题**：现在判断规则块是否已写入，靠的是检查 `block[1]` 那一行存不存在（`runtime-exclude.ts:62`）。已经写过旧规则块的仓库会被判定为"已存在"，新的放行行就永远加不进去。需要补一个逻辑：规则块存在、但缺少 `!${prefix}/memory/` 这一行时，单独追加这一行。

## 5. 影响面

| 位置                                                    | 变更                                                                                                                                     |
| ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/knowledge/memory.ts`                          | 改写：目录存储、frontmatter 解析和渲染、revision、按路径的写队列、迁移、新的索引式 summary                                               |
| `packages/knowledge/tools.ts`                           | 改 schema 和描述，新增 `read_memory`，`recall_knowledge` 的 source 和匹配字段                                                            |
| `packages/knowledge/context.ts`                         | 接收 `memoryRoot`                                                                                                                        |
| `packages/core/run/snapshots.ts`                        | 传入 `memoryRoot`                                                                                                                        |
| `packages/catalog/index.ts`                             | `knowledgeTools(root)` 改为接收 `memoryRoot`                                                                                             |
| `packages/core/subagents/*`                             | 传递委派方的 `memoryRoot`；默认过滤掉写记忆的工具                                                                                        |
| `packages/core/prompt/notices.ts`                       | 改提示文案                                                                                                                               |
| `packages/workspaces/runtime-exclude.ts`                | 改放行行，补旧规则块的兼容逻辑                                                                                                           |
| `packages/core/subagents/providers.ts`、`subprocess.ts` | `toolDeny` 能力，以及经环境变量传递 `memoryRoot`                                                                                         |
| `README.md`                                             | 第 289–290 行的工具表、第 540 行的"markdown 是记忆的真源"一段，改为新的布局和格式；工具数量和 schema 大小由 `npm run docs:generate` 更新 |
| `tests/knowledge.test.ts` 等                            | 见 §6                                                                                                                                    |

## 6. 测试计划

并发：

- 同一进程内并发 `save_memory` 两个不同 key（不 await 第一个就发出第二个），两条都在。这是 Q1 的回归测试，在旧实现上应该失败。
- 同一进程内并发覆盖同一个 key、带相同的 revision：恰好一个成功，另一个收到 revision 不一致的错误，并带回当前内容。
- 覆盖已有 key 但不带 revision：拒绝。删除时 revision 不一致：拒绝，文件还在。
- 两个子进程（`tests/risk-concurrency.ts` 风格）并发写用户级记忆的不同 key：两条都在。

格式与兼容：

- frontmatter 往返：解析后再渲染，结果不变；不认识的行保留。
- 手写文件缺少 `type` 或 `description` 时能读，并按 §4.2 的默认值处理。
- 拒绝 Windows 保留名作 key；`_notes.md` 和临时文件不出现在列表里。

迁移：

- 旧 `memory.md` 带 preamble 和多条条目，迁移后条目、日期、preamble 都对得上，旧文件改名为 `.migrated`。
- 重复迁移（模拟两个进程）结果一致，不报错。

注入：

- 128 条时注入不超出预算，并报告未列出的条数，工作区条目优先保住。
- 短的 user/feedback 条目内联正文；超过 200 字的不内联。
- 回合之间修改条目，下一轮能看到（保留现有的 per-round 刷新测试）。

子代理：

- worktree 子代理写入的记忆，落在委派方工作区的 `.yuantu/memory/` 下。
- 任何角色的子代理都没有 `save_memory` 和 `forget_memory`（调用返回 `Unknown tool`），但能用 `list_memories`、`read_memory`，并且收到记忆索引注入。

Git：

- 新仓库的 exclude 规则块包含 `!…/memory/`；只有旧规则块的仓库，会被补上这一行，而且只补一次。

## 7. 分期

| 阶段 | 内容                                                                                        | 解决                       |
| ---- | ------------------------------------------------------------------------------------------- | -------------------------- |
| P0   | §4.1 存储布局、§4.2 格式（含来源字段）、§4.3 并发、§4.9 迁移、§4.10 Git 排除、README 存储段 | Q1、Q2，以及 Q4 的来源部分 |
| P1   | §4.5 索引注入、§4.6 工具变更（含 `read_memory`）、§4.7 写入规范                             | Q3、Q4、Q5、Q8             |
| P2   | §4.4 worktree 的 memoryRoot、§4.8 子代理策略                                                | Q6、Q7                     |

P0 只改存储层，工具 schema 先加上可选的 `type`、`description`、`revision`，保持向后兼容；P1 再把它们改为必填。这样 P0 可以单独合并，不会和提示词改动搅在一起。

## 8. 已定决策（2026-10-30）

1. **子代理只读主记忆，不能写**，也不提供放行开关（§4.8）。
2. **索引由运行时生成，不落盘**。不像 Claude 那样让模型维护 `MEMORY.md`，也不生成给人看的 `INDEX.md`（§4.5）。
3. **worktree 记忆通过委派链显式传 `memoryRoot`**。只有 YuanTu 自建的子代理 worktree 指回委派方，用户自建的 git worktree 不变（§4.4）。
4. **本轮不做桌面端记忆管理界面**，等格式稳定后再做。
5. **跨进程暂不加锁文件**，接受 §4.3 第 5 点所说的竞争窗口。
6. **`[[key]]` 链接推迟**，等出现读取方之后再做。
