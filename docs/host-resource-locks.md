# Host 资源锁：把全局独占缩小到会话与执行目录

状态：已实现（2026-10-19）。设计稿写于同日，第 3、4 节保留当时的盘点；实现与设计的出入见第 10 节。

## 1. 背景与目标

Host 曾经是全局串行的：任意时刻只有一个运行。正在进行的改动引入了 `YUANTU_HOST_MAX_RUNS`（默认 2），
让不同会话可以同时运行、同一会话仍然串行。但除了 `run.start` 之外，还有 16 个处理函数仍然用
`ctx.active.size || ctx.restoring` 判断"Host 忙"，并在执行期间把 `ctx.restoring` 置为 `true`。结果是：

- 只要**任何**会话在运行，别的会话就不能改名、批准计划、撤销、验收、压缩……
- 任何一个手动操作进行时，**所有**会话都不能开始运行。

目标是参照 Codex 的做法，把"整个 Host"这把锁拆成按资源划分的锁，只在真正冲突时互斥。

**非目标**：每个会话一个进程。理由见第 7 节。

## 2. 参照：Codex 怎么做

以下来自对开源 Codex CLI（`openai/codex`，`codex-rs`）的了解，没有对照它的最新源码，名字可能已经改过：

- 一个进程（`app-server`）托管多个会话，每个会话是一个异步任务，对外只有提交队列和事件队列。
- 每个会话同一时间只有一个轮次；轮次进行中的新输入会并入当前轮次（steer），而不是排队。
- 一轮内的工具调用用一把**读写锁**区分：可并行的工具拿读锁，其余拿写锁。
- 子代理是同一进程里的另一个会话，有并发上限。
- 会话各自存储（每个会话一个 JSONL 文件），几乎没有"整个工作区共享"的可变状态；需要并行改代码时用 worktree 隔离。

本设计借用的是第三点：把工具层的读写锁思路提升到 Host 层，用在"执行目录"上。

## 3. 现状盘点

判断条件 `ctx.active.size || ctx.restoring` 出现在下表所有操作中（`session.recover` 例外，它已经只看本会话）。
"写 `restoring`"表示执行期间会挡住全部其他请求。

| 操作                                       | 文件                     | 写 `restoring` | 实际触及的资源                                 | 建议的锁                            |
| ------------------------------------------ | ------------------------ | -------------- | ---------------------------------------------- | ----------------------------------- |
| `context.compact`                          | `handlers/compaction.ts` | 是             | 本会话的消息与上下文；一次模型调用             | 会话                                |
| `plan.approve` / `plan.reject`             | `handlers/sessions.ts`   | 否             | 本会话的计划行                                 | 会话                                |
| `session.rename`                           | `handlers/sessions.ts`   | 否             | 本会话的标题                                   | 会话                                |
| `session.recover`                          | `handlers/sessions.ts`   | 否             | 本会话的运行租约                               | 会话（已基本如此）                  |
| `session.delete`                           | `handlers/sessions.ts`   | 是             | 本会话**整棵子树**、其后台命令与终端、溢出文件 | 子树中每个会话                      |
| `task.trigger` / `task.update`             | `handlers/tasks.ts`      | 否             | 本会话的任务行                                 | 会话                                |
| `task.propose`                             | `handlers/tasks.ts`      | 是             | 本会话的任务行；一次模型调用；`beginRun`       | 会话                                |
| `changes.undo`                             | `handlers/sessions.ts`   | 是             | **执行目录中的文件**                           | 会话 + 执行目录（独占）             |
| `task.verify` / `task.confirm`             | `handlers/tasks.ts`      | 是             | 在**执行目录**里跑验收命令并比对基线           | 会话 + 执行目录（独占）             |
| `workspace.apply`                          | `handlers/workspaces.ts` | 是             | 先检查再写入父会话的**执行目录**               | 会话 + 执行目录（独占）             |
| `workspace.archive` / `restore` / `remove` | `handlers/workspaces.ts` | 是             | 某个工作区绑定的目录本身                       | 绑定 + 其执行目录（独占）+ 所属会话 |

可以看出三类：

1. **只动本会话数据库行**（9 个）：本来就不需要挡别的会话。
2. **读写执行目录里的文件**（4 个）：需要防止另一个运行在同一目录里同时写；如果别的会话用的是自己的 worktree，就不冲突。
3. **管理工作区绑定的目录**（3 个）：只和使用该绑定的会话冲突。

## 4. 已发现的问题

这些问题是在盘点时发现的，和多会话改动直接相关，建议在实现锁之前或同时处理。

### 4.1 调度器触发的验收会在其他会话运行时失败（已修复）

`task.verify` 现在只检查本会话与执行目录的 `session` + `root` 独占锁，不再看全局 `ctx.active.size`；
调度器在其他会话运行时走验收分支不会再被误判为 Host 忙。锁表把“同一目录的写”与“别的会话在跑”分开，
与第 5 节的设计一致。

### 4.2 验收与撤销使用会话的执行目录（已修复）

`task.verify`、`task.confirm` 和 `changes.undo` 现在都用 `executionRoot(ctx, sessionId)` 作为
`fileClaims`、`verifyTaskAcceptance` 与 `undoFileChange` 的根；`run.start` 的待处理文件对账也用
`ActiveRun.root`，手工压缩的 spill 目标同样跟随执行目录。这与 baseline 采集、`workspace.apply` 的
“会话在哪个目录工作，就在哪个目录验收/撤销”一致：对 `worktree` 绑定的会话，检查和改写都落在它自己的树里。

### 4.3 `manualOperation` 单槽位（已修复）

`HostContext.manualOperations` 现为 `Set<ManualOperation>`，每个操作带自己的 `sessionId` 和
`AbortController`；`withLocks` 在请求声明 `operation` 时注册，`finally` 移除，shutdown/Stop 按会话中止。
后台唤醒不再用“有没有一个手动操作”判断全局，而是按会话与锁判断。

## 5. 设计

### 5.1 资源与模式

四种资源键：

- `host`：整个 Host。每个运行和操作都**共享**持有；只有孤立工作区的维护**独占**它。
- `session:<id>`：会话本身。总是**独占**。
- `root:<执行目录绝对路径>`：执行目录。分**共享**与**独占**两种模式。
- `binding:<id>`：工作区绑定。总是**独占**。

执行目录取自 `ctx.store.workspaceBinding(sessionId).executionRoot`。`shared` 绑定的会话都指向项目目录，
所以它们会落在同一个 `root:` 键上；`worktree` 会话各有自己的键。

### 5.2 各操作的锁

| 操作                                                             | 获取的锁                                                          |
| ---------------------------------------------------------------- | ----------------------------------------------------------------- |
| `run.start`                                                      | `host` 共享 + `session` 独占 + `root` 共享                        |
| 第一类（只动数据库行）                                           | `session` 独占                                                    |
| `session.delete`                                                 | 子树中每个会话的 `session` 独占                                   |
| `changes.undo`、`task.verify`、`task.confirm`、`workspace.apply` | `session` 独占 + `root` 独占                                      |
| `workspace.archive` / `restore` / `remove`                       | `binding` 独占 + 该绑定的 `root` 独占 + 所属会话的 `session` 独占 |

运行之间拿的是 `root` 共享锁，所以两个 `shared` 会话照样可以同时运行，这和当前的 `YUANTU_HOST_MAX_RUNS` 行为一致。
需要"在我检查和写入之间没人动这个目录"的操作拿独占锁，这正是现在 `restoring` 想保证的事，只是范围从整个 Host
缩小到一个目录。

`maxActiveRuns` 保持不变，它限制的是同时运行的数量（模型限流、内存），和锁是两件事。

### 5.3 语义：拒绝，不排队

现在的协议是"忙就立刻拒绝"，客户端按错误文本匹配（`already has an active run`、`Host is busy`）。
新的锁表保持同样的语义：

- 只提供 `tryAcquire(keys, mode)`，一次性拿到全部键或一个都不拿，失败时返回原因；不提供阻塞等待。
- 错误文本保留现有前缀，必要时在后面补充冲突的资源，例如 `Host is busy; wait before verifying (another run is writing in this workspace)`。
- 调度器和后台唤醒改用同一个判断函数（`canAcquire`）预先检查，而不是各自拼 `runSlotFree` / `sessionCanRun` / `manualOperation`。

一次性拿全部键可以避免死锁，因此不需要规定加锁顺序。

### 5.4 落点

- 在 Host 目录下新增一个 `resource-locks` 模块：一个纯内存结构，提供 `tryAcquire`、`release`、`canAcquire`、`holders`，不依赖 Host 其他部分，便于单测。
- `HostContext` 增加 `locks` 字段；`restoring` 与 `manualOperation` 最终由它取代。
- 每个处理函数把 `if (ctx.active.size || ctx.restoring) …; ctx.restoring = true; try { … } finally { ctx.restoring = false }`
  换成一个小工具函数，例如 `withLocks(ctx, keys, reason, fn)`。
- `admissionRefusal`、`runSlotFree`、`sessionCanRun` 改为基于锁表实现，对外签名不变。
- 关闭流程（`lifecycle.ts`）需要中止所有持锁的手动操作，而不只是 `ctx.manualOperation` 那一个。

## 6. 迁移步骤

每一步单独可提交、可回退。

1. 引入 `resource-locks` 模块和它的单元测试，不接入任何处理函数。
2. 修复 4.1：调度器在其他会话运行时不要走验收分支（或直接随第 4 步一起解决）。
3. 迁移第一类（只动数据库行的 9 个操作）为 `session` 锁。风险最低，收益最直观。
4. 迁移第二类（撤销、验收、导入），按 4.2 的结论锁会话的执行目录。
5. 迁移第三类（工作区绑定维护），同时把 `manualOperation` 换成按会话的映射。
6. 让 `run.start`、调度器、后台唤醒都通过锁表判断，删除 `restoring`。
7. 评估是否把"并发运行的会话默认使用 `worktree`"作为下一步，这样 `root` 独占锁几乎不会互相挡住。

## 7. 为什么不做"每个会话一个进程"

可行但代价大，而收益大部分已经由进程内并发拿到：

- 调度器、后台唤醒、启动时的恢复流程（`services.ts` 里两个 `reconcile`）都假定一个工作区只有一个 Host 负责，拆进程需要另选一个协调者。
- 本文的锁表需要变成跨进程锁（锁文件或数据库租约）。
- 终端、hooks、子代理驻留、模型限流是进程级资源，拆开后要么各有一份，要么跨进程共享。
- 桌面端要同时连接多个 Host 并按会话路由请求和审批。
- 每个进程连同 LSP、MCP 子进程会占几十到几百 MB 内存。

已经具备的基础：SQLite 已开启 WAL 和 `busy_timeout=5000`；运行记录带 `owner_pid`；`worktree` 隔离已存在；
子代理已能以子进程方式运行。如果将来需要进程级隔离（崩溃隔离、按会话限内存），建议采用"协调进程 + 会话工作进程"：
现在的 Host 作为协调者保留存储、调度、锁和路由，只把正在运行的会话交给工作进程。

## 8. 测试要点

- 锁表：共享与共享兼容；共享与独占、独占与独占互斥；一次拿多个键时全有或全无；释放后可再获取。
- 两个 `shared` 会话同时运行时，第三个会话仍能改名、批准计划、更新任务。
- 会话 A 运行时，会话 B（同一项目目录）的 `task.verify` 被拒绝；B 若用 `worktree` 则允许。
- 调度器在会话 A 运行时为会话 B 触发验收，不计入失败退避。
- `session.delete` 在子会话运行时被拒绝。
- 关闭 Host 时，所有持锁的手动操作都被中止并释放锁。

## 9. 仍需决定

1. 是否值得在锁冲突时提供“排队等待”选项，还是一直保持立即拒绝。

## 10. 实现记录

**代码位置**

- 锁表：`apps/agent-host/resource-locks.ts`。纯内存，只有 `claims`、`conflict`、`tryAcquire` 三个方法，租约的 `release` 可重复调用。
- Host 侧的键与判断都在 `apps/agent-host/state.ts`：`hostClaim`、`sessionClaim`、`rootClaim`、`bindingClaim` 生成键；`runClaims`、`fileClaims` 是两组常用组合；`lockConflict`、`assertUnlocked`、`acquireLocks`、`withLocks` 负责判断与加锁。
- `ctx.restoring` 与 `ctx.manualOperation` 已删除，由 `ctx.locks` 与 `ctx.manualOperations`（集合）取代。`run.cancel` 中止该会话的全部手动操作，关闭流程中止所有手动操作。

**与设计的出入**

- 运行**不在锁表里登记租约**。运行持有的键由 `ctx.active` 推导（`runClaims`），每次判断时与锁表中的租约合并计算。这样运行不可能忘记释放，测试里直接往 `active` 放条目的写法也照样有效。运行的执行目录在准入时读一次，存进 `ActiveRun.root`。
- 增加了 `host` 键（见 5.1）。孤立工作区的归档、恢复、删除没有所属会话可锁，仍然要求整个 Host 空闲，所以独占 `host`；其他操作都共享它。
- 没有单独的 `canAcquire`。调度器、后台唤醒、`run.start` 都通过 `runSlotFree`、`sessionCanRun`、`admissionRefusal` 判断，它们内部改为基于锁表实现，签名不变。
- 错误文本保持原样，没有附加冲突资源。唯一新增的是会话被手动操作占用时，`run.start` 返回 `This session already has an active run (an exclusive operation is in progress)`；目录或 Host 被占用时仍是 `This Host already has an active run (an exclusive operation is in progress)`。
- `task.propose` 与 `context.compact` 只锁本会话，但通过 `ctx.modelSlots` 占用同一个 `maxActiveRuns` 容量；`runSlotFree` / `admissionRefusal` 会把它们计入，`acquireModelSlot` 的释放函数与租约一起在 `finally` 执行。

**第 4 节的处理**

- 4.1 已修复：调度器的 `canRun` 现在会收到任务本身。已批准的验收会以 `task.verify` 恢复，这时检查的是验收需要的锁（本会话 + 执行目录独占），而不是运行槽位；拿不到就继续等待，不再计入失败退避。
- 4.2 已修复：撤销、验收、人工确认均使用 `executionRoot(ctx, sessionId)`，锁的也是执行目录；与 baseline 采集一致。
- 4.3 已处理：`manualOperation` 改为集合 `manualOperations`。

**测试**

- 新增 `tests/host-resource-locks.test.ts`：锁表的共享与独占规则和全有或全无；会话 A 运行时会话 B 仍可改名；同一目录的运行挡住验收，而在独立目录里的运行不会；会话或目录被手动操作占用时的准入文本；只有独占 `host` 才挡住所有运行；`task.propose` / `context.compact` 的 model slot 计入 `maxActiveRuns`。
- 已有测试中手工构造 `HostContext` 的地方改用 `locks` 与 `manualOperations`。
