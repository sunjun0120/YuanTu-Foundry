# 逐步修复记录（2026-10-16）

按 [未完成问题清单（按优先级）](unfinished-issues-by-priority-2026-10-16.md) 的顺序逐项修复。每项遵守同一纪律：**先复现失败（RED）→ 改实现 → 补可判别回归 → 跑定向验证与门禁（GREEN）→ 记录证据**。不提交 Git，不修改他人文件，不调用真实模型。

外部写入者已于 08:55 停止，其最终全量为绿（2491 项 / 2377 通过 / 0 失败 / 114 跳过，见 [remaining-audit-repairs-2026-10-16.md](remaining-audit-repairs-2026-10-16.md)），本记录在其之上继续。

## P1-2 `office_inspect` 的解压上限（`integrations-4` 残余）

**问题**：`office_inspect` 是唯一把包交给本仓库之外的读取器的 Office 路径——DOCX 交给 mammoth、XLSX 交给 SheetJS——两者在解压时都不看任何上限。它上面只有一层 **20 MB 压缩体积** 检查，而那是包的作者写的数字，所以一个小包加一个巨大部件可以通过全部输入检查被整份交给库。

**RED（修复前实测，`.scratch/office-inspect-bomb-probe.mjs`）**

| 夹具                               | 包大小（输入上限 20 MB） | 修复前                                     |
| ---------------------------------- | ------------------------ | ------------------------------------------ |
| `word/document.xml` = 24 MB        | 24,312 字节              | mammoth **返回 24,000,002 字符**（111 ms） |
| `xl/worksheets/sheet1.xml` = 24 MB | 25,087 字节              | SheetJS 解析成功（311 ms，堆 +23 MB）      |

两个回归用例先观察到 `Missing expected rejection`，同文件的其余 16 项通过——失败面精确落在被指控的机制上。

**实现**

- [zip-entry.ts](../packages/office/zip-entry.ts)：把原 `readEntry` 的流式读取抽成 `pump(entry, limit, what, keep)`（`keep` 决定是否保留字节），`readEntry` 建在它之上；新增 `assertExpansionWithinBudget(zip, { part, total }, what)`，逐条流式计量**每个**部件，各自受单部件上限、合起来受总预算约束，越界即 `destroy()` 该流——所以拒绝的代价是预算而不是炸弹。哪几个部件会被第三方库读到是它们的事，因此这里不能用「已知部件白名单」，只能用「整包展开预算」。
- [tools.ts](../packages/office/tools.ts)：`inspect()` 在 20 MB 检查之后调用 `assertInspectablePackage()`，上限 **单部件 16 MB / 整包 48 MB**（12,000 字符的输出上限之下，这个尺寸的文档已无可读性）。**不是 zip 的文件直接放行**——它展不开任何东西（这条分支对 SheetJS 读非 OOXML 表格有意义）。

**GREEN**

| 检查                                                                | 结果                                                                                                                                                                                          |
| ------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tests/office.test.ts`                                              | **20 项：18 通过、0 失败、2 跳过**（跳过为既有的本机脚本授权限制）                                                                                                                            |
| 新增回归                                                            | DOCX 炸弹被拒（`DOCX package part word/document.xml is too large`）、XLSX 炸弹被拒（`XLSX package part xl/worksheets/sheet1.xml is too large`）、同形状小包仍能读出正文（防「界限改坏读取」） |
| 修复后实测（同两个炸弹，`.scratch/office-inspect-after-probe.mjs`） | DOCX **66 ms / 堆 +2 MB** 被拒；XLSX **54 ms / 堆 +2 MB** 被拒                                                                                                                                |
| `npm run typecheck`                                                 | 通过                                                                                                                                                                                          |
| `npm run cycles:check`                                              | 338 文件 / 851 条值依赖边 / **0 环**                                                                                                                                                          |
| `npx prettier --check`（三个改动文件）                              | 通过                                                                                                                                                                                          |

**边界**：单部件超过 16 MB、或整包展开超过 48 MB 的**合法**文档也会被拒——这是有意的取舍，写在上限注释里；`office_preview` 走外部 LibreOffice，不在此路径上。本项关闭的是 `office_inspect` 的解压面，`integrations-4` 的其余部分（若有）以清单为准。

## P1-3 面向人的文案双向漏出字典（`desktop-app-1`）

**问题**：三个界面表面在英文模式下仍是中文——运行状态行、导出的会话文件、附件拒绝文案。两道门禁都看不见它们：源码扫描整类豁免 `renderer*.ts`（理由是「DOM 遍历器会在渲染时翻译」），而遍历器只翻译**词典里已有的原文**。

**RED（修复前的静态事实，`grep` 实测）**：运行状态行的 11 个字面量里有 4 个根本不在词典中（`正在处理`、`等待你的确认`、`连接未就绪`、`正在加载会话…`）；导出文件是**文件**，遍历器永远看不到；附件拒绝文案与文件名拼接（`file.name + '：' + message`），整串查表因此必然落空——连外部写入者刚为它加的那条词典项也救不回来。

**实现**

- [i18n.ts](../apps/desktop/i18n.ts)：新增 `ui.runStatus.*`（10 条，`idle` 复用既有的 `ui.ready`，避免同一中文原文出现两种英文）、`ui.export.*`（4 条）、`attach.renderer*`（5 条；其中 `attach.rendererFailure` 是 `{name}：{message}` 这样的**模式**，分隔符由语言决定而不是在代码里拼）。
- [renderer-status.ts](../apps/desktop/renderer-status.ts)（新）：把状态词汇与**判定顺序**从 `renderer.ts` 搬出来——正在压缩 > 待确认 > 连接未就绪 > 会话加载中 > 状态本身。顺序本身就是规则，搬出来才可测：每个分支都是一个词典键。
- [renderer-export.ts](../apps/desktop/renderer-export.ts)（新）：导出 markdown 的标题回退与三个角色名改为词典查表；**消息正文原样透传**（那是用户内容，`desktop-app-3` 的边界）。
- [renderer-attachment-copy.ts](../apps/desktop/renderer-attachment-copy.ts)（新）：五个拒绝文案改为词典键；`vision` 直接复用内核消息所用的 `attach.visionModelRequired`，让同一情形只有一种措辞。
- 三个消费点接线：[renderer.ts](../apps/desktop/renderer.ts)、[renderer-commands.ts](../apps/desktop/renderer-commands.ts)、[renderer-attachments.ts](../apps/desktop/renderer-attachments.ts)。

**GREEN**

| 检查                                                              | 结果                                                                                                                                                                                                                                                                                                                    |
| ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 新增 [desktop-copy.test.ts](../tests/desktop-copy.test.ts)        | **4/4 通过**：每个状态在英文下无汉字、中文下有汉字，且**答案不是键本身**（词典缺项时 `translate` 回退成键，那是 ASCII，只查汉字会漏）；状态判定顺序逐条钉住；导出在中英两种语言下的标题与角色名，用户内容与真实标题原样保留；五个附件拒绝文案 + 分隔符（英文 `name: ` / 中文 `name：`）；渲染层与内核的视觉拒绝措辞一致 |
| `tests/desktop-i18n.test.ts`                                      | 2/2 通过（**真实 Electron**，1.29 s / 0.85 s）——确认词典增项没有破坏遍历器与用户内容排除                                                                                                                                                                                                                                |
| `tests/settings.test.ts` + `tests/task-confirm-selection.test.ts` | 43 项通过（语言相关既有回归）                                                                                                                                                                                                                                                                                           |
| `npm run typecheck`                                               | 通过                                                                                                                                                                                                                                                                                                                    |
| `npm run cycles:check`                                            | 341 文件 / 857 条值依赖边 / **0 环**                                                                                                                                                                                                                                                                                    |
| `npm run i18n:check`                                              | 通过（新模块命中既有的 `renderer*.ts` 规则，未放宽任何豁免）                                                                                                                                                                                                                                                            |
| `npm run build` + `npm run smoke:client`                          | 构建通过；编译客户端 **3/3**                                                                                                                                                                                                                                                                                            |
| `npx prettier --check`（8 个改动文件）                            | 通过                                                                                                                                                                                                                                                                                                                    |

**过程记录**：新增测试第一次运行是 **3/4**——最后一条断言在 `zh-CN` 语言环境下与 `en-US` 的期望值比较，是测试自己的错误而非产品行为；修正为同语言比较后 4/4。

**边界**：本次只覆盖清单点名的三个表面。遍历器仍依赖「词典里有这条原文」这一前提，`index.html` 里写死的中文串依旧要靠 DOM 扫描发现；`packages/core` 的任务草案文案（P2-9）是另一个问题——它渲染在 `input.value` 上，词典机制到不了那里。

## P2-1 stdio 入站无界 + 出站不看背压（`hosts-assembly-4`）

**问题**：默认桌面走 stdio，而 stdio 侧只用 `createInterface({ input: process.stdin })` 组装行——**没有上界**。TCP 侧自认证那批起就走 `lineFramer`（16 MiB），stdio 侧没有；`dispatch.ts` 的体积门只在整行组装完成后才跑，那正是它无法再起作用的时刻。出站方向 `send()` 丢弃 `write()` 的返回值，也不等 `drain`。

**RED（`.scratch/stdio-frame-probe.mjs`，同一批字节、一个换行都没有）**

```
old: heap +19 MB, buffered by readline, delivered lines=[20000000] (one line of 20000000 bytes)
new: refused after 17 MB with "Agent Host response exceeds frame limit", delivered lines=[]
```

即：修复前 peer 写多少，这个进程就吃多少，最后一次性交付一条 20,000,000 字节的行。

**实现**（[carrier.ts](../apps/agent-host/carrier.ts)）

- stdio 读取改为与 socket 同一条路径：`lineFramer({ maxFrameBytes: MAX_INPUT_BYTES })` 在前，行写进 `PassThrough`，readline 再切分；下游写不动时暂停上游（`ingress.write()` 返回 false → `pause()`，`drain` 后 `resume()`），所以入站队列也有界。越界即报错并关闭载体。
- 出站新增 `writeBounded(target, line)`：`write()` 返回 false 时累计字节，超过 **64 MB**（客户端自己的入站帧上限）就判定「对端不读了」并关闭载体；`drain` 时清零，所以慢但活着的读者不会被误杀。stdio 与 socket 两条出站都走它。
- `close()` 现在把 `output` 置空并销毁 `stdioInput`（默认仍是 `process.stdin`），使关闭后不会继续往正在拆除的载体里写。
- 新增构造项 `stdioInput`（默认 `process.stdin`）：文档化的接入缝，让测试能用自己的流验证同一套分帧规则。

**GREEN**

| 检查                                                                                                          | 结果                                                                                                                                   |
| ------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| 新增 [carrier-frame-bound.test.ts](../tests/carrier-frame-bound.test.ts)                                      | **2/2**：没有换行的超限帧让读取循环结束、载体 `connected === false`；普通行仍按序到达，且**跨两个 chunk 的行会被重组**（不是替换字符） |
| [carrier-frame-bound + history-page-bound + history-window + large-response](../tests/history-window.test.ts) | **24/24**                                                                                                                              |
| `host-carrier` / `host-carrier-auth`                                                                          | 通过（同一批 54 项中仅 1 项失败，且属于 P2-2 的契约问题，见下）                                                                        |
| `npm run typecheck`、`cycles:check`（341/857/0 环）、`prettier --check`                                       | 通过                                                                                                                                   |

**边界**：拒绝一条超限帧的代价是**上限本身**的内存（探针里新的那条路径一次性到 +108 MB，因为 `lineFramer` 在字符串里累积到 16 MiB 才判定），不是无界增长；把共享 framer 改成按字节计数而不建字符串是更大的重构，未纳入本项。

## P2-2 不传 `offset` 的 `session.get` 无字节上限（`hosts-assembly-5`）

**问题**：分页分支有 15 MB 页预算与超大消息分块，而**兼容分支**（不传 `offset`）直接把整份 transcript 交出去，没有任何上限——Host 会先把它组装出来，再由对端的帧上限拒绝。

**过程（一次真实的契约冲突，记录而非掩盖）**：第一版把兼容分支也限制在**页预算 15 MB**。这立刻打挂了 [large-response.test.ts:229](../tests/large-response.test.ts#L229) 的「大 Responses 轮次可重新加载」——它明确断言一条 **16 MB** 的记录能通过不传 `offset` 的调用取回。也就是说这里存在一个**既有契约**（不传 `offset` 的调用可以取回超过一页的记录），而清单条目要的是给它加上限：两者只能取一个。

**决定**：兼容分支的上限取**传输层自身的帧上限 64 MB**（[host-transport.ts](../packages/client/host-transport.ts) 的默认入站界），而不是页预算。理由：大于 64 MB 的回复发给本仓库任何一个客户端都收不到，旧行为的实质是「在这里花掉内存、在对端失败」；而 16 MB 这条既有契约保持不变。拒绝时明确指向分页参数。

**GREEN**

| 检查                                                                   | 结果                                                                                                                                                                                            |
| ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 新增 [history-page-bound.test.ts](../tests/history-page-bound.test.ts) | **4/4**：超过帧上限的不分页回复被拒并给出分页写法；同会话仍能整页读取（页 15 MB 预算不变）；小会话仍整份返回（statistics/steps 完整）；**16 MB 记录仍能通过不分页读取**（把这次踩到的契约钉住） |
| `large-response.test.ts` + `history-window.test.ts`                    | 24/24 通过（含 5.2 MB 与 16 MB 两条既有断言）                                                                                                                                                   |
| `npm run typecheck`、`cycles:check`、`prettier --check`、`docs:check`  | 通过                                                                                                                                                                                            |

**边界**：64 MB 是客户端默认帧界；把入站界调小的调用方仍会先在自己的帧上限失败——那是调用方自己的界限。真正被关掉的是「Host 无上限地组装回复」。

## P2-3 上下文窗口溢出被误报为 `output-limit`（`R1-core-2`）

**问题**：同一个事实（provider 说请求超出上下文窗口、压缩救不回来）有**两种到达形状**，而它们给出不同的失败码。抛错形状走 `context-window-exceeded`；**终态 stop-reason 形状**在「没有 compaction 问题可指名」时直接落空，最后在 `response.finishReason === 'length'` 分支被报成 `output-limit`——那是唯一一个含义为「压缩没用」的诊断，却用在了 provider 因体积拒绝的请求上。

两种「没有 compaction 问题」的情形：压缩跑了但没能腾出空间（那时有 `lastCompactionProblem`，这条分支本来就对），以及**恢复额度已用尽**——后者是常态：成功的那次压缩会把 `lastCompactionProblem` 清空，于是同一轮里第二次溢出就带着空手上来了。

**RED**（[overflow-recovery.test.ts](../tests/overflow-recovery.test.ts) 新增用例，provider 持续以终态 stop-reason 报窗口溢出）

```
'Model output limit reached (5/256 output tokens, 0 visible characters); partial tool calls were not executed'
```

**实现**（[run-request.ts](../packages/core/run-request.ts)）：终态分支在恢复失败后**一律**抛 `ContextLimitError`，两句话分开写——「压缩跑过但没腾出空间：<原因>」与「溢出恢复额度已用尽」。不再落空到 `length` 分支。

**GREEN**：新增用例通过（`status === 'limited'`、文案含 context window、**不含 output limit**、`mainCalls === 2`、事件序列 `[true, false]`）；[overflow-recovery.test.ts](../tests/overflow-recovery.test.ts) **10/10**；`context`、`stream-recovery`、`summary-performance`、`task-cron` 同批 59/59。

## P2-4 按 UTF-16 下标切分会劈开代理对（`R1-core-3`）

**问题**：`shrink.ts` 的字符预算按 `.length`（UTF-16 码元）计算并按码元 `slice`，而 `measure` 也是按码元定价——于是「按字符预算切」在等距 emoji 上切出孤立的半个代理对。同级 `prune.ts` 从一开始就按码点计数并写明了原因。

**RED**（[context-shrink.test.ts](../tests/context-shrink.test.ts) 新增用例：`'😀'.repeat(3000)`、`tokens: 1001`）

```
actual: '…\n[shortened for context: 4999 of 6000 characters removed …]\n' + '\ude00😀😀…'
```

尾部以 `\ude00` 开头——一个孤立低代理，正是断言 `doesNotMatch(LONE_SURROGATE)` 抓到的东西。

**实现**：`charactersFor` 与 `shortenedContent` 改用码点（`[...content]` 迭代并按字符切片），`freedChars` 也改为码点差，使「报告省下的量」与「预算的单位」一致。

**导入环（门禁抓到的真问题）**：`shrink.ts` 直接 `import { codePointLength } from './prune.ts'` 会形成 `prune → shrink → prune` 的值导入环，`cycles:check` 立刻报出。`codePointLength` 有两个测试消费者（从 `prune.ts` 读），所以既不能简单搬走、也不能就地反向依赖：新增中性的 [text.ts](../packages/core/text.ts) 存放它，`prune.ts` 与 `shrink.ts` 都从那里导入，`prune.ts` 保留同名再导出以免改动既有消费者。

**GREEN**：[context-shrink.test.ts](../tests/context-shrink.test.ts) + [context-prune.test.ts](../tests/context-prune.test.ts) 19/19；含 `codePointLength` 消费者的 `audit-boundaries.test.ts` 在内共 74/74；`cycles:check` 341→**342 文件 / 859 边 / 0 环**；`typecheck` 通过。

**边界**：多码点字素簇（如带修饰符的 emoji 序列）仍可能被切开，这是字符预算的既有边界，与 `prune.ts` 的注释一致。

## P2-5 catch-up 标签可能报出规则未命名的时刻（`R1-core-5`）

**问题**：正向路径（`nextDailyRun`）此前已修——夏令时跳变日没有 02:30，于是跳过该日。而 `latestScheduledAt` 的**无时区分支**仍直接 `setHours`，在跳变日得到 03:30，并被 `scheduler.ts` 持久化为 `scheduledAt`：一条「02:30」的规则把一次补跑记在了 03:30 名下。zone-aware 那条路径（`latestCalendarRun`）一直是往回逐日走、跳过不存在的墙钟时刻的。

**RED**（[tasks.test.ts](../tests/tasks.test.ts) 新增用例，`TZ=America/New_York`、`now = 2026-03-08T12:00-04:00`）

```
+ actual:   '2026-03-08T07:30:00.000Z'   （本地 03:30，规则从未命名的时刻）
- expected: '2026-03-07T07:30:00.000Z'   （本地 02:30，zone-aware 路径的答案）
```

**实现**：新增 `latestDailyRun(atMinutes, now)`——从 `now` 起逐日回退，只接受**真正带有**所请求墙钟时刻且不晚于 `now` 的候选；一年内都找不到就抛错（与正向路径同一判据）。`latestScheduledAt` 的无时区分支改为调用它。

**GREEN**：[tasks.test.ts](../tests/tasks.test.ts) **26/26**；断言的是**两条拼写互相一致**（而非硬编码瞬时），另钉住「普通日子仍标当日、这是跳过而不是平移」；`task-cron.test.ts` 含 interval/weekly 的既有 catch-up 断言同批 59/59 通过。

## P2-7 被内容过滤的响应被报成干净的 `stop`（`integrations-5`）

**问题**：同一个事件在三种协议里有三种形状，而适配器把其中两种读成了**不是它**的东西：OpenAI 的 `finish_reason: 'content_filter'` 与 Anthropic 的 `stop_reason: 'refusal'` 都被映射成 `'stop'`（看着像一次正常回答），Responses 的 `response.incomplete` 一律映射成 `'length'`（看着像输出上限，而它唯一的补救手段——压缩会话——恰好没用）。第三处更隐蔽：Responses 的 `incomplete_details.reason` **从未被读过**。

**RED**（[providers.test.ts](../tests/providers.test.ts) 新增用例，三协议各一条 + 一条 `max_output_tokens` 对照）

```
actual: 'stop'   expected: 'content-filter'      （OpenAI chat）
```

**实现**

- 协议层新增第五种终止原因 `finishReason: 'content-filter'`（[index.ts](../packages/protocol/index.ts)），三种适配器各自映射到它：`content_filter`、`refusal`、以及 `incomplete_details.reason === 'content_filter'`；无法识别的 incomplete 原因仍按 `length`（不发明新语义）。
- 新增失败码 `'content-filtered'`（[failure.ts](../packages/protocol/failure.ts)）。**两处 `Record<FailureCode, boolean>` 立刻拒绝编译**（[retry.ts](../packages/protocol/retry.ts) 与 [retry.test.ts](../tests/retry.test.ts)）——这正是该模块注释里写的机制：加一个码就必须有人表态。两处都判为**不可重试**：同一个请求会被同样过滤。
- 内核（[run-request.ts](../packages/core/run-request.ts)）：新分支在失败前把用户已经看到的文本落盘（与 `length` 共用新提取的 `recordPartialTurn`），抛 `RunFailure('content-filtered', …)`；`carried` 的空响应重试分支同时排除 `content-filter`，否则一个被过滤的空回合会被当作网关抖动**再发一次**。
- 两个适配器在 `length`/`content-filter` 下都不再收集工具调用（半截或被拒绝的调用都不该执行）。

**GREEN**：[failure-codes.test.ts](../tests/failure-codes.test.ts) 新增 run 级用例（`status === 'failed'`、`code === 'content-filtered'`、文案含 content policy、**provider 只被调用 1 次**、部分文本保留、无 `context.overflow` 事件、事件日志里也是同一码）**17/17**；[providers.test.ts](../tests/providers.test.ts) + `retry` + `core` + `step-boundary` + `performance-statistics` 同批 **120/120**；`typecheck`、`cycles:check`、`prettier` 通过。

## P3-1 缺少显式压缩维护命令（`storage-protocol-carrier-4`）

**问题**：删除记录不会让 SQLite 文件变小——空闲页留在文件里等待后续写入复用，文件保持历史峰值。产品里**没有任何路径**结束这个状态：全仓 `VACUUM` 只有备份/恢复用的 `VACUUM main INTO ?`（那是**复制**，不是压缩）。

**前提先被断言**（新用例的第一段）：写入约 1.2 MB 消息、删除、关闭后文件仍 > 500 KB——如果 SQLite 哪天自己缩了，这条断言会失败，条目也就作废了。

**实现**

- [database-maintenance.ts](../packages/storage/database-maintenance.ts) 新增 `compactDatabase(file)`：`gated` + `assertOffline`（拒绝仍有活动读写者的库）+ 拒绝待恢复的库；先 `wal_checkpoint(TRUNCATE)`、再 `VACUUM`、再 checkpoint，返回 `{ file, beforeBytes, afterBytes, freedBytes }`。**就地**压缩而不是换文件：路径与身份不变、无需 journal，且被中断的 `VACUUM` 会回滚而不是留下半个库。
- [apps/cli/main.ts](../apps/cli/main.ts) 增加 `db-compact`，与 `db-backup`/`db-verify`/`db-restore`/`db-recover` 同一处分派、同样的 `--db` 与 `--json` 约定；README 的存储小节补上它以及「删除不缩文件、压缩才缩」这件事。

**GREEN**：新增两个用例**2/2**——压缩后文件确实变小、被删除的记录仍是删除状态、**压缩前写入的任务仍在**（返回的是页不是记录）、第二次压缩 `freedBytes === 0`；以及「有活动读写者时拒绝」。整文件 **20 项：17 通过、0 失败、3 暂停**（三项暂停是本机既有原因）；`typecheck`、`cycles`、`docs`、`references`、`i18n`、`prettier` 全绿。

**边界**：CLI 在当前「桌面优先」产品里是**暂停**的（`PRODUCT_SCOPE.cli = false`，实现保留待恢复），所以命令本身无法在本产品里跑通——用例因此直接驱动 `compactDatabase`，与同文件里被暂停的 CLI 备份/恢复用例同一原因。压缩是维护者操作：运行工具与 Host RPC 都不暴露它。

## P2-9 任务草案默认文案无条件中文（`R1-core-4` 残余；用户决定：内核按调用方语言生成）

**问题**：草案的三条默认步骤与一条验收是无条件中文。它们**不是**词典能翻的文案：词典在**渲染**时查表，而这几条被写进 `textarea` 的 `input.value`（[renderer-tasks.ts:219](../apps/desktop/renderer-tasks.ts#L219)），遍历器不处理该位置。所以语言必须在**写出它们的那一刻**决定，而当时唯一知道界面语言的进程（渲染进程）没有把这件事告诉内核。

**RED**（[tasks.test.ts](../tests/tasks.test.ts) 新增用例：同一请求分别按 `en-US` 与 `zh-CN` 生成）

```
actual: '检查相关文件，确认实现范围'   expected: 不含汉字
```

**实现**

- 新增 [packages/protocol/language.ts](../packages/protocol/language.ts)：`Language = 'zh-CN' | 'en-US'`。放在协议层而不是 app 里，因为这条联合跨进程：渲染进程画界面、主进程翻译自己的对话框、而**内核按它生成内容**；声明在 app 里会让内核反向依赖 app。
- [task-spec.ts](../packages/core/task-spec.ts)：`initialTaskDraft(kind, prompt, language = 'zh-CN')`，两种语言的步骤/验收各自成文；**默认仍是中文**，因为旧调用方发来的就是没有语言字段的命令。
- [contract.ts](../packages/carrier/contract.ts)：`goal`/`plan` 命令增加可选的 `language`（carrier 是知道窗口在显示哪种语言的那一侧）；[service.ts](../packages/carrier/service.ts) 原样转交内核。
- [renderer-commands.ts](../apps/desktop/renderer-commands.ts)：发送命令时带上 `locale()`；[ui-settings.ts](../apps/desktop/ui-settings.ts) 的 `UiLanguage` 改为别名，保持一份取值表。
- 顺带修掉同一个文件里的一处真漏出：`/${name} 需要描述内容。` 是拼出来的中文，而词典里**早就有** `ui.commandNeedsDescription`（含 `{name}` 占位）却从未被使用；现在它由 `format(t(...))` 生成。

**GREEN**

| 检查                                                                                                                | 结果                                                                                                                                                |
| ------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| 新增 [tasks.test.ts](../tests/tasks.test.ts) 用例                                                                   | 通过：英文请求的步骤与验收无汉字、请求本身（内容）原样保留、中文请求仍有汉字、**不传语言时与中文逐字相同**（兼容旧调用方）                          |
| 新增真实 Electron DOM 用例（[desktop-i18n.test.ts](../tests/desktop-i18n.test.ts)）                                 | 通过：`/plan …` 交给 carrier 的命令带 `language: 'en-US'`（切到中文后是 `'zh-CN'`）、`/plan` 缺描述的拒绝在英文下是 `/plan requires a description.` |
| `tasks` + `carrier` + `carrier-i18n` + `web-bridge-timeouts`                                                        | 56 项：45 通过、0 失败、11 暂停（既有环境暂停）                                                                                                     |
| `typecheck`、`cycles:check`（343 文件 / 859 边 / 0 环）、`i18n:check`、`docs:check`、`references:check`、`prettier` | 全绿                                                                                                                                                |

**边界**：草案标题前缀仍是 `Goal: `/`Plan: `（两种语言下都一样，与改动前一致）；本次只改默认步骤与验收的**语言**，不改它们的措辞取舍。

## 全量验收：一次由全量抓到的**自身回归**（记录而非掩盖）

清单内 14 项收口后跑了全量（`npm.cmd test`，2026-10-16 10:46–11:18）：**2514 项、2399 通过、1 失败、114 跳过**，耗时 1894.97 秒。唯一失败是 [client.test.ts](../tests/client.test.ts#L149) 的 `stop during approval cancels the run and keeps side effects absent`：

```
Error [HostDisconnectedError]: Agent Host exited (code=0, signal=null); requests were not replayed
```

**这是我的回归，且是 P2-1 引入的。** 定位过程：

1. 先做 A/B，把 stdio 读取接线临时还原成旧写法——**仍然失败**。这一步只排除了「分帧读取」这一半，没有排除同一批改动里的其它部分（教训：A/B 必须还原到改动的**完整**边界，否则会得出错误结论）。
2. 症状指向关闭顺序：Host 以 **code=0 干净退出**而客户端仍有在途请求。[lifecycle.ts:20-37](../apps/agent-host/lifecycle.ts#L20-L37) 显示关停是「先 abort 活动运行、再**同步**调用 `carrier.close()`」，而运行的结算（以及它对 `run.start` 的答复）发生在 abort unwind 之后——**即 close 之后**。我在 P2-1 里给 `close()` 加的 `this.output = null` 正好把那批答复丢掉了。
3. 修法：`close()` 不再清空 output（stdout 此时仍然打开，这正是「close 之后还能写」的原因），并把这个契约写进 `close()` 的注释；`connected` 改为 `output !== null && !closed`，让「还有没有载体」这个问题在关停后仍答 false（唯一的消费者 [background-wake.ts:63](../apps/agent-host/background-wake.ts#L63) 同时看 `closing`，语义不变）。

**修复后验证**：原失败用例单独通过；`carrier-frame-bound` + `client` **42/42**；`host-carrier` + `host-carrier-auth` **36/36**（含 `carrier.connected === false` 的断言）。随后重跑全量，结果见下节。

## 全量验收（重跑，修复后）

`npm.cmd test`，2026-10-16 11:25–11:57：

```
Tests: 2514  pass=2400  fail=0  skip=114  cancelled=0  todo=0
Total: serial tests=2514  duration=1866.03s  wall=1866.14s   exit code 0
```

- **0 失败**；114 项跳过与修复前同一批（本机脚本授权、POSIX 权限位、真实 LSP 安装等既有环境原因），**没有新增跳过**。
- 与第一次全量的差别只有一处：`client.test.ts` 的那条用例由失败转为通过（即上面记录的那次自身回归），其余数字不变（2514 / 114）。
- 产物：`.scratch/test-logs/1792120…-serial.log` 与其 timings；`--timings=artifacts/stepwise-20261016/full-timings.ndjson`。

**结论**：清单内 14 项缺陷已全部收口，定向回归与**全量**均为 0 失败。这仍不构成平台发布验收（安装、签名、macOS、真实网络隔离按 P3-6 另行跟踪），也不覆盖 P2-10（`smoke:desktop` 不稳定，`npm test` 不含 `.smoke.mjs`）。
