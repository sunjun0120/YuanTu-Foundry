# 记忆的召回过滤、打分与动态遗忘

> 日期：2026-10-30。仓库：`E:\agent-desktop\YuanTu-Foundry`，基线 `4c5797e` 加上《记忆重构设计》（`docs/2026-10-30-memory-redesign.md`）的 P0–P2 改动。
> 范围：`packages/knowledge/memory.ts`、`packages/knowledge/tools.ts`、`packages/knowledge/store.ts`、`packages/knowledge/context.ts`，新增 `packages/knowledge/secrets.ts`，以及 README 的记忆章节；使用统计实现在 `memory.ts`。
> 参考：Claude Code 的 auto memory（运行时提醒模型精简索引、`modified` 时间戳）；Codex 的 memories（后台合并、"多久没被召回"驱动的淘汰、生成环节的脱敏与外部内容过滤）。
> 状态：P0–P3 都已实现（未提交）。§5 的使用统计和 §7.4 的密钥检测由另一个会话按下面的差异实现。
> 与原方案的差异（和"Agent 记忆实现"会话协调后定的）：
>
> - **使用统计不用 sqlite**，改为记忆目录旁边的 `memory-usage.json`（工作区 `.yuantu/memory-usage.json`，用户级 `<globalDir>/memory-usage.json`），格式 `{"version":1,"memories":{"<key>":{"firstSeen","lastUsed"?,"usedDays"}}}`。`usedDays` 是用过的不同天数，取代 §5.1 的 `use_count`，所以每个 key 每天最多重写一次。读写函数在 `memory.ts`（`memoryUsage`、`recordMemoryUse`、`recordMemoriesSeen`），没有单独的 `memory-usage.ts`；§5.3 的进程内队列不再需要，写入经过 `serialized` 按文件串行、尽力而为。P2 打分前要先 `await recordMemoriesSeen(location)`，让没见过的旧条目从当天开始算宽限期。
> - **密钥检测在 `packages/knowledge/secrets.ts`**（`credentialIn`），不叫 `secret-patterns.ts`；正文和描述都检查。
> - 新增 `YUANTU_MEMORY` 开关（`on` / `read` / `off`）：`off` 时 `memorySources` 返回空，`recall_knowledge` 只搜文档；`read` 和只读的委派方目录下不记使用。
> - **归档不改表结构**：`memory_index` 没有 `archived` 列，`_archive/` 作为一个独立目录（`MemorySource.archived`）建索引，命中时带上 `archived: true`。
> - **召回里分数的用法改为乘法**：§4.3 原写的 `bm25_rank − α·score` 在 bm25 很小（常见词）时会让分数压过相关度。实际是 `bm25 × (1 + 0.2 · min(score, 7) / 7)`，最多提高 20%，只区分匹配程度相近的条目；相关度门槛仍按原始 bm25 算。
> - **疑似重复不走 FTS**：FTS 要求每个词都出现，改写过措辞的重复条目反而查不到。实际是新建后把它的 description 和同作用域所有条目、以及该作用域的归档条目（含同名的归档条目）的 description 算字符二元组 Dice 相似度，≥ 0.6 的按相似度从高到低放进 `similar`（最多 3 条，归档的带 `archived: true`）。这只比较措辞，所以工具描述要求模型先读、确认是同一件事才合并或恢复，并明确"只是格式相同（Q1 和 Q2 计划）的是两条记忆"，避免把不同的记忆误合并。
> - **每日清理挂在 `memoryContext` 上**：它改成 async，快照代码 `await` 它；`maintainMemories` 先 `recordMemoriesSeen`，再归档。分数里没有使用记录的条目按"今天第一次被看到"计算，所以只调用 `memorySummary` 的路径也不会把旧条目当成很久没用。
> - 分工：`store.ts`、`recall_knowledge` 以及 P2、P3（`memory.ts` 和其他记忆工具里的相应部分）由本会话完成；YUANTU_MEMORY 开关、只读位置、使用记录、密钥检测由"Agent 记忆实现"会话完成。

## 1. 结论摘要

上一轮重构解决了并发和"超过 12 条就看不见"的问题。记忆继续增长后，还剩三个缺口：

1. **召回粗糙且不设上限。** `recall_knowledge` 的记忆部分是子串匹配，命中多少条就返回多少条，每条都带完整正文。记忆越多，一次召回塞进上下文的字数越多，相关度也越差。
2. **没有优先级依据。** 常驻索引按"类型 + 更新日期"排序，一条半年没人用的 reference 和一条天天用到的 project 记忆，在预算里的待遇只取决于日期。
3. **只会涨不会落。** 64 条满了才报错，让模型手动 `forget_memory`。系统既不提醒，也没有"不删但先收起来"的中间状态。

本设计的改法：

- **记忆文件保持现状，所有动态信息放在旁路。** 使用统计、检索索引都存进已有的 `knowledge.sqlite`，不写进记忆文件。文件仍然是用户可编辑、git 跟踪的唯一内容来源，revision 和并发写入的机制都不变。
- **召回改用 FTS5 + bm25**，复用文档检索已有的中文分词，加上条数上限、相关度门槛、摘录截断和类型/作用域过滤。
- **记录使用情况**：`read_memory` 读取和 `recall_knowledge` 排名靠前的命中算一次"使用"。每轮注入只算曝光，不算使用。
- **打分是纯函数，不落盘**：类型权重 + 时间衰减 + 使用热度 + `pinned`。分数决定常驻索引的排序和召回的第二排序因子。
- **遗忘分三档，从不自动删除**：低分降级（不进常驻索引）→ 长期未用归档（移到 `memory/_archive/`，不占名额，可恢复）→ 删除仍然只由模型或用户主动发起并走审批。
- **接近上限时提醒模型整理**（借鉴 Claude），**写入时拦截疑似密钥**（借鉴 Codex）。

## 2. 现状

| 项目     | 现状                                                                                                       | 位置                           |
| -------- | ---------------------------------------------------------------------------------------------------------- | ------------------------------ |
| 存储     | 一条一文件 `<dir>/<key>.md`，frontmatter 有 `name`、`description`、`type`、`updated`、`session`            | `memory.ts:135`                |
| 限额     | 每个作用域 64 条；正文 2000 字；文件 8KB；满了新建报错 `forget an entry first`                             | `memory.ts:87`、`:354`         |
| 常驻索引 | 每轮快照，按 feedback → user → project → reference、再按 `updated` 排序，6000 字预算，超出只计数           | `memory.ts:509`                |
| 快照缓存 | 只有内容变了才重新宣告（`announce`），保住缓存前缀                                                         | `core/run/snapshots.ts:26`     |
| 召回     | `searchMemories` 对 key、description、正文做子串匹配，结果不限条数、返回全文                               | `memory.ts:538`、`tools.ts:85` |
| 文档检索 | `knowledge.sqlite`（用户状态目录，跨工作区共享）里的 `knowledge_fts`，FTS5 + bm25，汉字逐字切分，默认 8 条 | `store.ts:453`                 |
| 写入过滤 | 只校验长度和控制字符；工具描述里要求"不存密钥"，没有实际检测                                               | `memory.ts:263`                |

另有一个小 bug：`recall_knowledge` 给用户级记忆返回的 `source` 写死成 `~/.yuantu/memory/<key>.md`（`tools.ts:92`），设置了 `YUANTU_MEMORY_DIR` 时路径不对。

## 3. 参考：两家的做法与取舍

| 做法                                             | 来源        | 本设计                                                                                                            |
| ------------------------------------------------ | ----------- | ----------------------------------------------------------------------------------------------------------------- |
| 索引接近上限时，运行时提醒模型合并或删除过时条目 | Claude Code | **采纳**（§7.3）                                                                                                  |
| 写入时自动记录 `modified` 时间戳                 | Claude Code | 已有（`updated`），不变                                                                                           |
| 单条记忆 30 天没被召回就删除                     | Codex       | **改动**：按"多久没被用到"归档而不是删除，阈值 90 天（§7.2）。YuanTu 的记忆提交进 git、用户可编辑，静默删除不合适 |
| 会话空闲后由后台模型抽取、合并记忆               | Codex       | **不采纳**：YuanTu 的写入需要审批，后台自动生成记忆与此冲突                                                       |
| 生成记忆时脱敏、用过外部内容的会话不参与生成     | Codex       | **部分采纳**：写入时拦截疑似密钥（§7.4）。YuanTu 只有显式 `save_memory` 一个入口，没有"哪些会话参与生成"这一层    |
| 召回靠读整份索引文件或 grep，没有相关度排序      | 两家        | **改进**：YuanTu 已有 FTS5 + bm25，直接复用（§4）                                                                 |
| 没有显式打分                                     | 两家        | **新增**（§6），但只用于排序和遗忘判断，不暴露给模型做决策                                                        |

## 4. 召回过滤

### 4.1 索引表

在 `knowledge.sqlite` 里新增，和文档用的 `knowledge_items` / `knowledge_fts` 分开（后者还留着早期版本的 `kind='memory'` 行，见 `store.ts:233`，不去碰它）：

```sql
CREATE TABLE IF NOT EXISTS memory_index (
  dir TEXT NOT NULL,          -- 规范化后的记忆目录，区分作用域和项目
  key TEXT NOT NULL,
  archived INTEGER NOT NULL,  -- 0：memory/<key>.md；1：memory/_archive/<key>.md
  size INTEGER NOT NULL, mtime_ms REAL NOT NULL,
  type TEXT NOT NULL, description TEXT NOT NULL, text TEXT NOT NULL, updated TEXT NOT NULL,
  PRIMARY KEY (dir, key, archived)
);
CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(key, description, text, tokenize='unicode61');
```

- `memory_fts` 的 rowid 对应 `memory_index` 的 rowid，写法和 `pinDocument` 一样：在同一个事务里写两张表，索引内容用 `ftsIndexText` 切分（SQL 算不出这个，所以不用触发器）。
- `dir` 用目录路径而不是 `root`：用户级记忆和工作区记忆天然分开，worktree 子代理通过 `memoryRoot` 已经指回委派方，拿到的也是同一个 `dir`。

### 4.2 同步

记忆文件是真源，索引只是缓存，所以同步是"召回前对一遍账"：

1. 列出 `memory/` 和 `memory/_archive/` 下的条目文件（复用 `entryKeys`）。
2. size 和 mtime 都没变的条目跳过；变了的重新解析并更新两张表；索引里有、目录里没有的删掉。
3. 整个过程在一个事务里完成。

用户在编辑器里直接改文件，下次召回就能检索到，不需要文件监听。64 条加归档最多几百个文件的 stat，开销和每轮注入时的目录扫描是同一量级。

### 4.3 查询与排序

- 匹配：`ftsMatchQuery(query, 8)`，与文档检索一致（每个词都要出现，汉字逐字成词）；key 或 description 包含整个查询的条目排最前，和文档"标题包含查询"的规则一致。
- 相关度：`bm25(memory_fts, 3.0, 4.0, 1.0)`，key 和 description 权重高于正文，因为它们就是写给检索看的摘要。
- 第二排序因子：§6 的分数。最终排序 `title_rank, bm25_rank - α·score`，`α` 取一个让分数只在相关度相近时起作用的小值（实现时用测试数据定，初值 0.5）。
- 门槛：bm25 结果按 SQLite 的约定是负数越小越相关；对每次查询取最优结果的分数作基准，丢掉比基准差太多的尾部（相对门槛，避免绝对阈值随语料变化失效）。

### 4.4 返回内容

| 字段                                                         | 说明                                                                                                              |
| ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| `kind`                                                       | `memory`                                                                                                          |
| `scope`、`key`、`type`、`description`、`updated`、`revision` | 和 `list_memories` 一致                                                                                           |
| `excerpt`                                                    | 正文摘录：用 `snippet()` 取命中附近的片段（窗口用 `ftsSnippetTokens`），再用 `ftsDisplayText` 还原；最多约 300 字 |
| `archived`                                                   | 只在为 `true` 时出现                                                                                              |
| `source`                                                     | 按实际目录生成，修复 §2 末尾的 bug                                                                                |

不再返回全文；工具描述写明"要看全文用 `read_memory`"。

### 4.5 参数

`recall_knowledge` 新增可选参数：

| 参数               | 默认       | 说明                          |
| ------------------ | ---------- | ----------------------------- |
| `memory_types`     | 全部       | 只召回这些类型的记忆          |
| `memory_scope`     | 两个作用域 | `workspace` 或 `global`       |
| `include_archived` | `false`    | 是否包含已归档的条目          |
| `limit`            | 8          | 记忆和文档各自的上限，最大 20 |

记忆结果和文档结果仍然放在同一个 `results` 数组里，记忆在前，和现在一致。

## 5. 使用统计

### 5.1 表结构

```sql
CREATE TABLE IF NOT EXISTS memory_usage (
  dir TEXT NOT NULL, key TEXT NOT NULL,
  first_seen TEXT NOT NULL,   -- 第一次被扫描到的日期
  last_used TEXT,             -- 最近一次被用到的日期，从没用过时为空
  use_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (dir, key)
);
```

- 日期只精确到天（`YYYY-MM-DD`）：打分和遗忘都按天计算，更细的精度只会让排序更频繁地变化（见 §6.3）。
- `first_seen` 用于遗忘的宽限期：功能上线时所有已有条目都没有使用记录，如果只看 `last_used` 和 `updated`，迁移过来的旧条目会被一次性全部归档。

### 5.2 什么算"使用"

| 事件                                           | 是否记录                                                   |
| ---------------------------------------------- | ---------------------------------------------------------- |
| `read_memory` 读取                             | 是                                                         |
| `recall_knowledge` 命中且排在记忆结果的前 3 名 | 是                                                         |
| `save_memory` 更新已有条目                     | 是（模型显然在用它）                                       |
| 每轮常驻索引里出现、或内联了正文               | **否**：否则所有在索引里的条目都会显得很热，分数失去区分度 |
| `list_memories` 列出                           | 否                                                         |

### 5.3 写入方式

`read_memory` 是 `parallelRead` 工具，这个名字承诺"从不写入"（`tools.ts:15` 的注释）。直接在里面写 sqlite 会打破承诺，也会让两个并行的读调用变成两个写者。所以：

- 新增 `memory-usage.ts`，提供一个进程内的 `MemoryUsageSink`：工具里只调用 `sink.record(dir, key)`，往内存队列里追加一条，不做任何 IO。
- 队列在两个时机批量刷进 sqlite：每轮快照计算之前（`memoryContext` 被调用时），以及 `knowledgeTools().close()` 时。一次刷新是一个事务里的若干条 UPSERT。
- `knowledge.sqlite` 已经是 WAL 模式，多个 Host 进程同时刷新用户级记忆的统计不会损坏数据；同一行的并发 UPSERT 最坏是丢一次计数，可以接受。

## 6. 打分

### 6.1 公式

纯函数 `memoryScore(entry, usage, today)`，不落盘，每次需要时现算：

```
score = 类型权重 + 新鲜度 + 热度 + 钉住加成

类型权重：feedback 3，user 2，project 1，reference 0（沿用 typeOrder 的顺序）
新鲜度：  2 · 0.5 ^ (距今天数 / 半衰期)
          距今天数 = today − max(updated, last_used, first_seen)
          半衰期：  feedback、user 不衰减（新鲜度恒为 2）；project 60 天；reference 30 天
热度：    min(2, log2(1 + use_count) / 3)
钉住加成：pinned 为 true 时 +100（保证永远排最前、永远不被降级或归档）
```

- 所有系数和半衰期写成 `memoryScoring` 常量，放在 `memoryLimits` 旁边，测试里可以覆盖。
- 热度有上限：一条被反复读的记忆不该无限挤压其他条目。

### 6.2 `pinned` 字段

- frontmatter 新增可选的 `pinned: true`。解析器现在把它当作未知字段原样保留，需要改为认识它：加入 `parseMemoryEntry` 的字段白名单，`MemoryEntry` 增加 `pinned?: boolean`，`renderMemoryEntry` 只在为 `true` 时写出。
- `save_memory` 增加可选参数 `pinned`；工具描述写明"只在用户明确要求某条记忆始终生效时使用"。用户也可以直接改文件。

### 6.3 排序要稳定

快照只在内容变化时重新宣告。如果常驻索引的顺序跟着每次 `read_memory` 变，快照会频繁失效，缓存前缀也随之丢掉。所以常驻索引用的分数**按"排序时点"冻结**：

- 排序时点 = （目录里各条目文件的 size + mtime 签名，今天的日期）。
- 签名和日期都没变时，沿用上一次算好的顺序（缓存在 `memorySummary` 里，按 `dir` 存）。会话中途的使用记录只写进统计表，不会让索引重排。
- 文件被写入时快照本来就要重新宣告，这时顺带重算顺序；日期变化最多让索引每天重排一次。

召回（§4.3）不受这条限制，每次都用最新的分数：召回结果本来就是一次性的工具输出，不在缓存前缀里。

## 7. 动态遗忘

### 7.1 降级：不进常驻索引

- 常驻索引按 §6 的分数从高到低排，预算仍是 6000 字，超出的条目不列出，和现在一样计数提示。
- 另外，分数低于 `demoteBelow` 的条目，即使预算有余也不列出，计入"N further memories"。初值 1.0：feedback 和 user 类最低也有 4 分，永远不会被降级；很久没用的 reference 会降到 1 以下；project 只有在新鲜度几乎衰减完、又从没用过时才会接近这条线。
- 降级不改任何文件，召回和 `list_memories` 照常能找到。

### 7.2 归档：移出目录，不占名额

**条件**（全部满足）：

- 类型是 `project` 或 `reference`；
- 没有 `pinned`；
- `today − max(updated, last_used, first_seen) ≥ 90 天`。

**动作**：把 `memory/<key>.md` 移到 `memory/_archive/<key>.md`，文件内容一个字节都不改（revision 不变）。

**时机**：每个 Host 进程、每个记忆目录、每天最多执行一次，由当天第一次 `memoryContext` 调用触发，在注入快照之前完成。每次移动都经过 `serialized` 的按路径队列。用户级记忆可能被多个 Host 同时归档，`rename` 本身是原子的，输掉的一方会遇到 `ENOENT`，当作已完成处理。

**告知**：当天归档了条目时，常驻索引末尾加一行：`Archived today (unused for 90+ days): a, b. restore_memory brings one back.` 第二天这一行消失（排序时点的日期变了，快照本来就要重新宣告）。

**归档目录的规则**：

- `entryKeys` 只列 `memory/` 第一层的 `.md` 文件，`_archive` 是子目录，不会被当成条目，也不计入 64 条的名额。现有逻辑不用改。
- 归档目录上限 256 条。满了就不再自动归档，改为在 §7.3 的提醒里说明。不会因为归档满了而删除任何东西。
- 已有的 git 排除规则 `!.yuantu/memory/` 放回的是整个目录，`_archive/` 跟着被跟踪，`runtime-exclude.ts` 不用改，只需补一条测试。

**新增工具 `restore_memory`**（`permission: 'write'`）：入参 `scope`、`key`。把 `_archive/<key>.md` 移回 `memory/<key>.md`，同时把该条的 `last_used` 设为今天，避免第二天又被归档。活跃目录里已经有同名 key、或者活跃条目已满 64 条时拒绝。

`read_memory` 增加可选参数 `archived`（默认 `false`），用来读归档里的条目；`forget_memory` 同样增加 `archived`，可以直接删除归档条目。`list_memories` 增加可选参数 `include_archived`。

### 7.3 接近上限时提醒

当某个作用域的活跃条目达到 `nearLimit`（56 条，即 64 的 7/8）时，常驻索引末尾加上：

```
Workspace memory holds 58 of 64 entries. Lowest-ranked: release-notes-2026q2, old-ci-runner, ...
Merge overlapping entries or forget obsolete ones before saving more.
```

- 列出分数最低的 5 条，只给 key，不给正文。
- 这段内容同样受 §6.3 的排序冻结约束，不会每轮变化。
- 满 64 条时 `save_memory` 的报错改成同样的信息（带上最低分的 5 条），让模型有据可依，而不是只说 `forget an entry first`。

### 7.4 写入过滤

**疑似密钥直接拒绝**：

- 新增 `secrets.ts`（实际实现，见文首差异说明），覆盖常见格式：`sk-ant-`、`sk-`、`ghp_`/`gho_`/`github_pat_`、`AKIA` 开头的 AWS key、`-----BEGIN ... PRIVATE KEY-----`、`xox[abp]-`、JWT 形态（三段 base64url），以及 `password|passwd|secret|token|api[_-]?key` 后紧跟 `:` 或 `=` 和一段 16 位以上无空白字符串。
- 同时调用现有的 `redactSecrets`（`platform/redact.ts`），它会遮掉环境变量里配置的真实凭据；遮完和原文不一样，也说明正文里有密钥。
- 命中时报错 `Memory content looks like it contains a secret (<类别>); store where to find it, not the value`，不回显命中的内容。
- 检测在 `saveMemoryEntry` 里做（`normalizeText` 之后），所以用户手写的文件不受影响，只拦截模型的写入。

**疑似重复给出提示，不拦截**：

- 新建条目成功后，用新条目的 description 查一次 §4 的记忆索引（同作用域、只查活跃条目）。最优结果的 bm25 分数优于门槛、并且 description 的字符二元组重合度 ≥ 0.6 时，在返回结果里加上 `similar: [{ key, description, revision }]`。
- 只提示不拦截：判断"是不是同一件事"需要语义理解，误拦会让模型绕着 key 起名。工具描述里补一句：返回了 `similar` 时，考虑合并进已有条目再删掉新条目。

## 8. 工具变更汇总

| 工具               | 变更                                                                                                                |
| ------------------ | ------------------------------------------------------------------------------------------------------------------- |
| `recall_knowledge` | 记忆部分改用 FTS；新增 `memory_types`、`memory_scope`、`include_archived`、`limit`；返回摘录而非全文；修复 `source` |
| `list_memories`    | 新增 `include_archived`；每条增加 `pinned`（为真时）、`lastUsed`、`archived`（为真时）                              |
| `read_memory`      | 新增 `archived`；读取时记录使用                                                                                     |
| `save_memory`      | 新增 `pinned`；疑似密钥拒绝；新建时可能返回 `similar`；满额报错带最低分条目                                         |
| `forget_memory`    | 新增 `archived`                                                                                                     |
| `restore_memory`   | **新增**，见 §7.2                                                                                                   |

`restore_memory` 是写工具，按《记忆重构设计》§4.8 加入 `CHILD_DENIED_TOOLS`（定义在 `core/subagents/contract.ts`，由 `core/run/child-turns.ts` 对每个子代理应用），子代理拿不到。工具数量和 schema 大小变化后，用 `npm run docs:generate` 更新 README。

## 9. 已定决策

1. ~~自动归档要不要审批~~ **已定（2026-10-30）：不审批，只告知。** 归档只是移动文件，内容和 revision 都不变，可以随时恢复；当天归档的条目在常驻索引里列出（§7.2）。不提供 `archive_memory` 工具。
2. ~~归档阈值和半衰期~~ **已定（2026-10-30）：归档阈值 90 天，半衰期 project 60 天、reference 30 天。** 都是 `memoryScoring` 里的常量，有了使用数据再调。
3. ~~feedback / user 类是否遗忘~~ **已定（2026-10-30）：不遗忘。** 这两类是"用户希望怎么工作"，久不触发不代表失效；它们不衰减、不降级、不归档，只能由模型或用户手动删除。

## 10. 影响面

| 位置                                       | 变更                                                                                                                            |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| `packages/knowledge/store.ts`              | 新增 `memory_index`、`memory_fts` 两张表；同步与查询（P0 已实现）                                                               |
| `packages/knowledge/memory.ts`（使用记录） | 已实现为 `memory-usage.json`，见文首差异说明                                                                                    |
| `packages/knowledge/secrets.ts`            | 已实现：密钥格式检测                                                                                                            |
| `packages/knowledge/memory.ts`             | `pinned` 字段；`memoryScore` 与 `memoryScoring` 常量；排序冻结；归档、恢复；上限提醒；写入过滤；`searchMemories` 改为调用 store |
| `packages/knowledge/tools.ts`              | 各工具参数和返回值（§8）；新增 `restore_memory`；修复 `source`                                                                  |
| `packages/knowledge/context.ts`            | 调用前刷新使用统计、触发每日归档                                                                                                |
| `packages/core/subagents/contract.ts`      | `CHILD_DENIED_TOOLS` 加入 `restore_memory`                                                                                      |
| `README.md`                                | 记忆章节：召回、归档目录、`pinned`；工具表由 `docs:generate` 更新                                                               |

## 11. 测试计划

召回：

- 中文查询能命中正文中间的词；key 或 description 包含整个查询的条目排第一。
- 命中 30 条时只返回 `limit` 条；结果里只有摘录，没有全文。
- `memory_types`、`memory_scope`、`include_archived` 各自生效。
- 用户手动改了文件，下一次召回能检索到新内容；删掉的文件不再出现。
- 设置了 `YUANTU_MEMORY_DIR` 时，用户级记忆的 `source` 指向实际目录。

使用统计：

- `read_memory` 和召回前 3 名各记一次；常驻索引里出现、`list_memories` 列出都不记。
- 两个并行的 `read_memory` 不直接写 sqlite（统计在下一次刷新时才出现）。
- 刷新后 `use_count`、`last_used` 正确；文件删除后统计行在下次同步时清掉。

打分与排序：

- `memoryScore` 的单元测试：类型、衰减、热度上限、`pinned`。
- 会话中途多次 `read_memory`，常驻索引的文本不变（快照不重新宣告）；写入一条记忆或日期变化后才重排。
- `pinned` 的往返：解析 → 渲染不丢；`pinned: true` 的条目永远在索引第一位。

遗忘：

- 功能上线当天，`updated` 很早但 `first_seen` 是今天的条目不会被归档。
- 满足条件的 project / reference 条目被移到 `_archive/`，文件字节和 revision 不变；feedback、user、`pinned` 的条目从不归档。
- 同一天第二次调用不再执行归档；两个进程同时归档同一条，结果一致、不报错。
- `_archive/` 里的条目不计入 64 条名额，不出现在常驻索引里。
- `restore_memory` 把条目移回并刷新 `last_used`；同名活跃条目存在或已满 64 条时拒绝。
- 达到 56 条时索引里出现提醒和最低分的 5 条；满 64 条时报错带同样信息。
- git：`.yuantu/memory/_archive/` 下的文件不被 `info/exclude` 排除。

写入过滤：

- 各类密钥格式被拒绝，错误信息不回显命中内容；普通文本里出现 "token" 一词不误报。
- 新建一条和已有条目描述几乎相同的记忆：写入成功，返回 `similar`。

子代理：

- 任何角色的子代理都没有 `restore_memory`。

## 12. 分期

| 阶段 | 内容                                                  | 解决                         |
| ---- | ----------------------------------------------------- | ---------------------------- |
| P0   | §4 召回过滤（含 `source` 修复）                       | 召回无上限、相关度差         |
| P1   | §5 使用统计                                           | 为打分和遗忘提供数据         |
| P2   | §6 打分、`pinned`、排序冻结；§7.1 降级；§7.3 上限提醒 | 预算分配没有依据；满额才处理 |
| P3   | §7.2 归档与 `restore_memory`；§7.4 写入过滤           | 只会涨不会落；密钥误存       |

P0 可以单独合并，不改变任何数据语义。P1 上线后至少积累一段时间的使用数据，P3 的归档才有意义；`first_seen` 的宽限期保证 P3 即使紧跟着上线，也不会误归档旧条目。
