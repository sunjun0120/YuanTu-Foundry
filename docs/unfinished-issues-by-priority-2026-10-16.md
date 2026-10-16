# 未完成问题清单（按优先级）

**快照时间：2026-10-16 09:45（+0800，第二次修订）** · HEAD `27bb603` · 工作树状态：115 个文件已修改、34 个未跟踪、**未提交**

> **修订说明（09:45）。** 外部写入者已于 08:55 停止。本次修订：**P0-1、P1-1、P1-4 经源码复核关闭**；**P0-2 由最终全量日志关闭**（2491 项 / 2377 通过 / 0 失败 / 114 跳过，08:55:11–09:25:33，运行期间树静止）；其余条目逐条重查后**仍开 14 项缺陷**（P1 两项、P2 九项、P3 三项）外加 4 项流程/平台事项。第一版（07:47）的条目原文保留以便追溯。
>
> 本文档只做汇总与排序，**不修改任何产品代码、测试或他人的文件**。

## 0. 怎么读这份文档

**优先级判据**（不是照抄原审计的 high/medium/low，而是「现在该先做什么」）：

| 级别   | 含义                                                               |
| ------ | ------------------------------------------------------------------ |
| **P0** | 阻塞其它一切结论：正在进行的改动，或让「已验收」失去意义的前提缺失 |
| **P1** | 安全边界仍有缺口，或**默认路径**上用户/调用方可见的错误            |
| **P2** | 触发条件受限的缺陷、健壮性与维护缺口                               |
| **P3** | 有意的安全取舍、需要产品决策、以及流程与文档债                     |

**证据等级**（每条都标注，避免把推测当事实）：

| 等级  | 含义                                                     |
| ----- | -------------------------------------------------------- |
| **A** | 源码事实，且我本人或审计读过对应回归断言确实能判别该机制 |
| **B** | 静态审计给出的 `文件:行` 源码事实，未独立复跑验证        |
| **C** | 需要产品决策、环境条件或原始报告才能收敛                 |

**统计（第八次修订：清单内缺陷已全部收口，全量为绿）**：**原 14 项缺陷全部关闭**——11 项修复（P1-2、P1-3、P2-1…P2-5、P2-7、P2-8、P2-9、P3-1，另有 P0-1、P0-2、P1-1、P1-4 由外部写入者实现、本会话复核）与 3 项经用户裁定保持现状（P2-6、P3-2、P3-3）；原审计 34 条跟踪项中 **31 条已修、3 条已裁决保持现状、0 条仍开**（见附录 A）。**全量验收**：`npm test` **2514 项 / 2400 通过 / 0 失败 / 114 跳过 / exit 0**（2026-10-16 11:25–11:57，1866 秒）——第一次全量抓到了我自己的一个回归（P2-1 的 `close()` 清空输出，丢掉关停时对在途请求的答复），已定位、修复并重跑确认，过程见 [stepwise-repairs-2026-10-16.md](stepwise-repairs-2026-10-16.md)。仍待处理的**不在原 14 项内**：本会话新发现的 P2-10（`smoke:desktop` 不稳定，`npm test` 不含 `.smoke.mjs`）与流程/平台事项 4 项（P0-3 未提交、P3-4 文档索引合并、P3-5 结构优化、P3-6 平台验收）。

## 1. P0 — 阻塞验收

### P0-1 ✅ 已完成（09:45 关闭）—— 会话删除后的 workspace 绑定清理与恢复

- **对应**：`storage-protocol-carrier-2`（原 medium）
- **关闭依据**：Host 已接通 `workspaces.orphaned`（[workspaces.ts:63-66](../apps/agent-host/handlers/workspaces.ts#L63-L66)），`workspace.archive/remove/restore` 接受互斥的 `sessionId` 或 `bindingId`，会话删除后的绑定重新可寻址；桌面设置页新增「保留的工作区」入口（归档、二次确认移除、恢复），Host 广告能力 `workspace-orphans-v1`。
- **证据**：作者记录 [workspace-orphans-validation-2026-10-16.md](workspace-orphans-validation-2026-10-16.md)（定向回归 48/48、真实 stdio Host 重启后再发现并恢复）与 [remaining-audit-repairs-2026-10-16.md](remaining-audit-repairs-2026-10-16.md) 第 5 行（桌面入口）。
- **证据等级**：A（源码事实 + 作者记录；本次复核确认 handler 与协议参数存在，**未**重跑其 48 项定向回归）。
- **残留边界**：桌面 UI 的实机验收由作者的 Electron 冒烟覆盖，本文档未独立复跑。

### P0-2 ✅ 已解决（09:45 关闭）—— 冻结快照的全量验收缺失

- **关闭依据**：2026-10-16 的最终串行全量**已执行完毕且为绿**：**2491 项、2377 通过、0 失败、114 跳过、0 取消**，耗时 1821.75 秒（08:55:11 开始、09:25:33 结束）。
- **该结果对当前树有效**：全树最新的源码/脚本/配置/测试文件是 `tests/workspace-maintenance.smoke.mjs`（08:54:07），**早于**全量开始时间；运行结束至本次核对（09:45）无任何写入。
- **证据**：`.scratch/test-logs/1792112111763-22252-de024543-45e1-45ec-86ef-2fe8d48a8d56-serial.log` 与其 `-serial-timings.ndjson` 的 `kind: run-summary` 记录；作者未及写入的结论已补入 [remaining-audit-repairs-2026-10-16.md](remaining-audit-repairs-2026-10-16.md)。
- **证据等级**：A（运行器原始日志 + 文件时间核对）。
- **残留边界**：全量通过**不足以**替代平台验收（安装、签名、macOS、真实网络隔离），见 P3-6。

### P0-3 工作树未提交，归因基线缺失（仍开，流程类）

- **现状**：`HEAD 27bb603`（2026-10-14），现在 **115 改 + 34 未跟踪**。上面那次绿色全量**挂在一棵未提交的树上**：没有基线，就无法按提交二分定位、也无法回退。
- **证据**：`git log --oneline -3`、`git status --porcelain`（09:45 实测）。
- **证据等级**：A。
- **下一步**：提交（或在提交前至少产出一份全树哈希清单并归档），使验收结论可归因。

## 2. P1 — 安全边界或默认路径仍有缺口

### P1-1 ✅ 已完成（09:45 关闭）—— 生命周期 hook 的只读门

- **对应**：`integrations-1`（原 medium）
- **关闭依据**：`SessionStart`/`SessionEnd` 现在与其他四类事件一样先看只读标志：[hook-bridge.ts:188](../packages/resources/hook-bridge.ts#L188)、[:201](../packages/resources/hook-bridge.ts#L201) 均有 `if (context.readOnly) return;`；Host 与保留的 CLI 实现改为传递 `readOnly`，规划提交后可由后续普通运行或运行中审批释放限制，实时文件策略仍优先。
- **证据**：作者记录 [remaining-audit-repairs-2026-10-16.md](remaining-audit-repairs-2026-10-16.md) 第 1–2 行（含「取消后丢失规划转可写状态」的连带修复）；本次复核直接读到上述两处门。
- **证据等级**：A（源码事实；未重跑其 5 文件 64 项定向回归）。
- **残留边界**：该 hook 仍**不经审批**执行工作区声明的命令——这是文档化的 Claude-Code 兼容设计（`YUANTU_HOOK_BRIDGE=0` 可关），本次只关掉了「只读运行仍执行」这一半。

### P1-2 ✅ 已完成（2026-10-16 本会话修复）—— `office_inspect` 的解压上限

- **对应**：`integrations-4`（原 medium）
- **RED**：24,312 字节的 DOCX（`word/document.xml` 展开 24 MB）让 mammoth **返回 24,000,002 字符**；25,087 字节的 XLSX 让 SheetJS 解析成功（堆 +23 MB）。两者都通过了 20 MB 压缩输入检查。
- **修复**：[zip-entry.ts](../packages/office/zip-entry.ts) 抽出 `pump()` 并新增 `assertExpansionWithinBudget()`——逐部件流式计量、单部件与整包双重上限、越界即 `destroy()`；[tools.ts](../packages/office/tools.ts) 的 `inspect()` 在 20 MB 检查后调用 `assertInspectablePackage()`，上限 **单部件 16 MB / 整包 48 MB**，非 zip 输入直接放行。
- **GREEN**：`tests/office.test.ts` **20 项 / 18 通过 / 0 失败 / 2 跳过**（含两条炸弹回归与一条小包对照）；修复后两个炸弹 **66 ms、54 ms** 被拒（堆 +2 MB）；`typecheck`、`cycles:check`（338 文件 / 851 边 / 0 环）、`prettier --check` 均通过。
- **证据等级**：A（本会话 RED→GREEN 完整记录见 [stepwise-repairs-2026-10-16.md](stepwise-repairs-2026-10-16.md)）。
- **残留边界**：单部件 >16 MB 或整包展开 >48 MB 的**合法**文档会被拒——有意取舍，已写入常量注释。

### P1-3 ✅ 已完成（2026-10-16 本会话修复）—— 面向人的文案双向漏出

- **对应**：`desktop-app-1`（原 medium）
- **RED（修复前）**：运行状态行的 11 个字面量中有 4 个不在词典里（`正在处理`、`等待你的确认`、`连接未就绪`、`正在加载会话…`）；导出文件是文件、遍历器看不到；附件拒绝文案与文件名拼接，整串查表必然落空。权限标签方向此前已修。
- **GREEN**：新增 [renderer-status.ts](../apps/desktop/renderer-status.ts)、[renderer-export.ts](../apps/desktop/renderer-export.ts)、[renderer-attachment-copy.ts](../apps/desktop/renderer-attachment-copy.ts) 与 23 条词典项；新增 [desktop-copy.test.ts](../tests/desktop-copy.test.ts) **4/4**（英文无汉字、答案不是键本身、状态判定顺序、导出正文与标题原样、渲染层与内核措辞一致）；`desktop-i18n.test.ts` 2/2（真实 Electron）、`settings`+`task-confirm-selection` 43 项、`typecheck`、`cycles:check`（341/857/0 环）、`i18n:check`、`build` + `smoke:client` 3/3 全部通过。
- **证据等级**：A（本会话 RED→GREEN，详见 [stepwise-repairs-2026-10-16.md](stepwise-repairs-2026-10-16.md)）。
- **残留边界**：`index.html` 里写死的中文仍依赖 DOM 扫描发现；P2-9 的任务草案文案渲染在 `input.value` 上，词典机制到不了。

### P1-4 ✅ 已完成（09:45 关闭）—— i18n 遍历器改写用户文本

- **对应**：`desktop-app-3`（原 low，但用户可见）
- **关闭依据**：用户内容节点改用 `translate="no"` 排除，属性改为保存原文与已应用值两份并观察动态属性变化：[i18n.ts:1127](../apps/desktop/i18n.ts#L1127)（`excludedContent` 含 `[translate="no"]`）、[:1159](../apps/desktop/i18n.ts#L1159)（文本用 `originals` 往返）、[:1180](../apps/desktop/i18n.ts#L1180)（属性原文恢复）。覆盖目录树、标签页、预览无障碍名称、会话标题、计划、待办、目标与交付物。
- **证据**：作者记录 [remaining-audit-repairs-2026-10-16.md](remaining-audit-repairs-2026-10-16.md) 第 3 行（含故障注入：移除排除与属性原文恢复各被真实 DOM 回归检出）。
- **证据等级**：A（源码事实；未重跑其 DOM 回归）。
- **残留边界**：与 P1-3 同源——**硬编码的界面文案**仍然漏出，见下条。

## 3. P2 — 受限触发的缺陷、健壮性与维护缺口

| #     | 问题（原 ID）                                                                            | 现状与证据                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | 等级 |
| ----- | ---------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- |
| P2-1  | **stdio 入站无界缓冲**（`hosts-assembly-4`）                                             | ✅ **已完成（本会话）**：stdio 与 socket 现在共用 `lineFramer`（16 MiB），下游写不动即暂停上游；出站新增 64 MB「对端不读了」界限。RED 实测：修复前 readline 交付一条 **20,000,000 字节**的行（堆 +19 MB）；修复后 17 MB 处拒绝且不投递。回归 **2/2**，同一批 24/24 通过                                                                                                                                                                                                                                        | A    |
| P2-2  | **`session.get` 不带 `offset` 无字节上限**（`hosts-assembly-5`）                         | ✅ **已完成（本会话）**：兼容分支改为受**传输帧上限 64 MB**约束（不是页预算），拒绝时指向分页参数。过程中发现既有契约：[large-response.test.ts:229](../tests/large-response.test.ts#L229) 依赖 16 MB 记录走不分页路径，故未采用 15 MB 页预算。回归 **4/4**（含 16 MB 契约钉住），`large-response` + `history-window` 24/24 通过                                                                                                                                                                                | A    |
| P2-3  | **上下文窗口溢出被误报为 `output-limit`**（`R1-core-2`）                                 | ✅ **已完成（本会话）**：终态 stop-reason 分支在恢复失败后一律抛 `ContextLimitError`，「压缩没腾出空间」与「恢复额度用尽」分开措辞。RED 原文为 `Model output limit reached (5/256 output tokens, 0 visible characters)`；回归 **10/10**，同批 59/59                                                                                                                                                                                                                                                            | A    |
| P2-4  | **按 UTF-16 下标切分工具结果会劈开代理对**（`R1-core-3`）                                | ✅ **已完成（本会话）**：`charactersFor`/`shortenedContent`/`freedChars` 全部改按码点。RED 实测尾部以孤立 `\ude00` 开头；修 `codePointLength` 归属时 `cycles:check` 抓出 `prune → shrink → prune` 真环，遂新增中性 [text.ts](../packages/core/text.ts)。回归 74/74、342 文件/859 边/0 环                                                                                                                                                                                                                       | A    |
| P2-5  | **无时区 daily 触发器的 catch-up 标签可能报出规则未命名的时刻**（`R1-core-5`）           | ✅ **已完成（本会话）**：新增 `latestDailyRun`（逐日回退、只接受真正带有所请求墙钟时刻的候选），无时区分支改用它。RED 实测本地路径给 `03-08T07:30Z`（被跳过的 03:30），zone-aware 给 `03-07T07:30Z`；回归 **26/26**，断言两条拼写一致                                                                                                                                                                                                                                                                          | A    |
| P2-6  | **摘要校准用权重自身归一化**（`core-kernel-3`）                                          | ✅ **已裁决：保持现状 + 补钉住现状的回归（用户 2026-10-16 决定）**。新增 [context.test.ts](../tests/context.test.ts) 用例：先用能区分部件的证据把三个权重拉开，再发一条「不带分部件」的观测，断言三者按**同一相对量**移动（形状保持）——这正是 `calibration.ts:173-177` 注释主张的设计，把它变成可判别的断言而不是一句注释。`context.test.ts` **40/40**                                                                                                                                                         | A    |
| P2-7  | **被内容过滤的响应被报成干净的 `stop`**（`integrations-5`）                              | ✅ **已完成（本会话）**：新增第五种终止原因 `content-filter` 与失败码 `content-filtered`；三种适配器（chat 的 `content_filter`、Anthropic 的 `refusal`、Responses 的 `incomplete_details.reason`）统一映射，内核按失败处理且**不重发**，用户已看到的文本仍落盘。RED 为 chat 适配器给出 `'stop'`；回归 **17/17**，关联批 **120/120**                                                                                                                                                                            | A    |
| P2-8  | **基准运行配置入库，含本机路径、清单哈希与实盘预算授权**（`build-ci-tests-4`）           | ✅ **已完成（本会话，用户选择「只移出三个 JSON」）**：`git rm --cached` 三个配置（`pilot-config.json`、`run-config.json`、`budget-pilot.json`，文件保留在磁盘），[.gitignore](../.gitignore#L17-L20) 增加 `benchmarks/coding-evaluation/local/*.json` 规则；10 个 `.mjs`/`.ps1` 工具脚本仍受版本控制（`git ls-files` 复核）。**注意：这是索引变更，尚未提交**                                                                                                                                                  | A    |
| P2-9  | **4 条任务草案默认文案仍无条件中文**（`R1-core-4` 残余）                                 | ✅ **已完成（本会话，用户选择「内核按调用方语言生成」）**：新增协议层 `Language` 联合；`initialTaskDraft(kind, prompt, language = 'zh-CN')` 两种语言成文；carrier 命令带可选 `language`、渲染层发送 `locale()`；顺带启用词典里早已存在却从未使用的 `ui.commandNeedsDescription`。回归：单元用例 + **真实 Electron DOM** 用例（命令确实带 `en-US`/`zh-CN`、拒绝文案已翻译）；关联批 45 通过 / 0 失败 / 11 既有暂停                                                                                              | A    |
| P2-10 | **`smoke:desktop` 跑不完：`workflows.smoke.mjs` 不稳定（本会话新发现，不在原 34 条内）** | 本次全量冒烟 09:54:01 启动，首个用例 `task draft is editable…` 18.3 s 通过后，日志停在 09:59:28，一个 09:59:09 启动的 Electron 子进程直到 10:17 未退出（人工终止）。随后三次单独运行该文件：整文件 53 s 跑完**不再挂起**但**首个用例失败**（`.task-card input[type=checkbox]` 15 s 定位超时）；只跑首个用例失败（19.05 s）；只跑第二个用例通过（5.21 s）。**A/B 排除本次改动**：把 stdio 分帧临时还原成旧接线后，首个用例**同样失败**（19.29 s，同一断言）。同一批 `desktop.smoke.mjs` 的 30+ 用例此前均已通过 | A    |

## 4. P3 — 有意取舍、产品决策与流程/文档债

| #    | 事项                                                              | 现状与证据                                                                                                                                                                                                                                                                                                                                                                                                                                                | 等级 |
| ---- | ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- |
| P3-1 | **没有显式压缩维护命令**（`storage-protocol-carrier-4`）          | ✅ **已完成（本会话）**：新增 `compactDatabase()`（就地 `VACUUM`，拒绝活动读写者与待恢复库，报告前后字节）与 CLI `db-compact`，README 补文档。回归 **2/2**（文件确实变小、记录状态不变、二次压缩 0 收益、活动库被拒）。边界：CLI 在当前产品里暂停（`PRODUCT_SCOPE.cli=false`），用例直接驱动模块                                                                                                                                                          | A    |
| P3-2 | **macOS 已执行命令的私有临时目录无有界回收**（`tools-sandbox-2`） | ✅ **已裁决：保持现状并文档化（用户 2026-10-16 决定）**。理由记录在此：[seatbelt-scratch.ts:22-29](../packages/tools/seatbelt-scratch.ts#L22-L29) 在命令已启动后不清理，因为脱离进程组的子孙无法确认；测试把「存活」断言为期望（[seatbelt-scratch.test.ts:25-39](../tests/seatbelt-scratch.test.ts#L25-L39)）。按年龄清扫仍有误删并发目录的风险，不作为默认行为                                                                                           | A    |
| P3-3 | **未保存的语言预览与主进程持久语言不一致**（`desktop-app-2`）     | ✅ **已裁决：保持现状并文档化（用户 2026-10-16 决定）**。预览即时改渲染进程（[renderer-general-settings.ts:107-112](../apps/desktop/renderer-general-settings.ts#L107-L112) → [i18n.ts:1151-1167](../apps/desktop/i18n.ts#L1151-L1167)），主进程语言保存后才同步（[main.ts:919-928](../apps/desktop/main.ts#L919-L928)），分工本身有测试记录（[settings.test.ts:781-800](../tests/settings.test.ts#L781-L800)）；预览期原生对话框使用持久化语言属既定分工 | A    |
| P3-4 | **主评估文档状态过期**                                            | [architecture-capability-assessment-2026-10-14.md](architecture-capability-assessment-2026-10-14.md) §6.1 仍写 HIGH-1「规范化后未复查名称规则」的源码事实仍在（实际已在 [files.ts:179-181](../packages/tools/files.ts#L179-L181) 复查），§6.2 仍把 HIGH-2 记为未认证（实际已修）；34 条的关闭状态也未重算。另有多份验证记录分散（本目录 4 份），缺单一索引                                                                                                | A    |
| P3-5 | **流程优化项**                                                    | 测试并行调度（白名单 16 条 vs 229 个测试文件）、大模块职责收敛（`sqlite.ts`、`agent.ts` 等）。属优化，不属缺陷                                                                                                                                                                                                                                                                                                                                            | C    |
| P3-6 | **环境/平台验收缺口**（无法在本机完成）                           | Office COM 实际可用性受本机脚本授权限制、真实 WFP 网络隔离、签名安装/受保护安装与卸载、macOS 行为、原生托管 worktree。跳过项不等于功能验收                                                                                                                                                                                                                                                                                                                | C    |

## 5. 已修复（对照，避免重复投入）

| 原 ID                                   | 修复要点与证据                                                                                                                                                                                                                                                                                                                                                                                                        |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `R1-tools-credential-8dot3`（high）     | `realpath` 之后把名称规则重新应用到**规范化**路径：[files.ts:179-181](../packages/tools/files.ts#L179-L181)、[:168-174](../packages/tools/files.ts#L168-L174)；回归造真实 8.3 别名 [credential-paths.test.ts:60-92](../tests/credential-paths.test.ts#L60-L92)（别名未生成的环境会自我跳过）                                                                                                                          |
| `hosts-assembly-1`（high）              | 回环白名单 + `YUANTU_HOST_TOKEN` + `timingSafeEqual` + 首帧认证：[carrier.ts:26-36](../apps/agent-host/carrier.ts#L26-L36)、[:262-287](../apps/agent-host/carrier.ts#L262-L287)、[host-auth.ts](../packages/protocol/host-auth.ts)；回归 [host-carrier-auth.test.ts:65-96](../tests/host-carrier-auth.test.ts#L65-L96)；记录见 [tcp-carrier-auth-validation-2026-10-15.md](tcp-carrier-auth-validation-2026-10-15.md) |
| `R1-core-1`                             | 历史工具按逻辑项目作用域装配：[agent.ts:309-345](../packages/core/agent.ts#L309-L345)；回归 [session-query.test.ts:620-678](../tests/session-query.test.ts#L620-L678)                                                                                                                                                                                                                                                 |
| `core-kernel-1` / `core-kernel-2`       | resident 用量归属折叠（§7.2.10）；`tests/subagent-usage.test.ts` 本会话 8/8                                                                                                                                                                                                                                                                                                                                           |
| `ENV-1`                                 | 脚本授权失败单独分类并优先于 COM 判定：[automation.ts:70-79](../packages/office/automation.ts#L70-L79)、[:167-177](../packages/office/automation.ts#L167-L177)；回归 [office.test.ts:45-91](../tests/office.test.ts#L45-L91)                                                                                                                                                                                          |
| `R1-tools-toolcut-output-never-spilled` | `runGit` 不再预先截断（§7.2.7）；`tests/spill.test.ts`、`tests/git-write.test.ts` 本会话通过                                                                                                                                                                                                                                                                                                                          |
| `hosts-assembly-2`                      | 每个连接先装 socket 错误处理 [carrier.ts:143](../apps/agent-host/carrier.ts#L143)；回归 [host-carrier-auth.test.ts:190-202](../tests/host-carrier-auth.test.ts#L190-L202)                                                                                                                                                                                                                                             |
| `hosts-assembly-3`                      | `workspace.apply` 走 `ToolRegistry` + 审批 + 执行策略：[workspaces.ts:86-149](../apps/agent-host/handlers/workspaces.ts#L86-L149)；回归 [host-workspaces.test.ts:108-190](../tests/host-workspaces.test.ts#L108-L190)                                                                                                                                                                                                 |
| `hosts-assembly-6`                      | 手动压缩可取消：[compaction.ts:60-62](../apps/agent-host/handlers/compaction.ts#L60-L62)、[runs.ts:70-73](../apps/agent-host/handlers/runs.ts#L70-L73)；回归 [context.test.ts:1136-1209](../tests/context.test.ts#L1136-L1209)                                                                                                                                                                                        |
| `integrations-2`                        | LSP 预览前 `Workspace.resolve`（拒绝所有符号链接）：[lsp/tools.ts:294-309](../packages/lsp/tools.ts#L294-L309)；回归 [lsp.test.ts:1071-1106](../tests/lsp.test.ts#L1071-L1106)                                                                                                                                                                                                                                        |
| `integrations-3`                        | 重定向与 1 MiB 响应上限移进探测本身：[discovery.ts:202](../packages/providers/discovery.ts#L202)、[:210-233](../packages/providers/discovery.ts#L210-L233)、[:248-259](../packages/providers/discovery.ts#L248-L259)；回归 [models-discovery.test.ts:280-333](../tests/models-discovery.test.ts#L280-L333)                                                                                                            |
| `build-ci-tests-1`                      | 打包布局 lock 解析（§7.3.13）：[ripgrep-assets.ts](../packages/search/ripgrep-assets.ts) `lockFiles()` + [search-ripgrep.test.ts](../tests/search-ripgrep.test.ts)                                                                                                                                                                                                                                                    |
| `build-ci-tests-2`                      | 运行器区分四种文件形状（§7.3.14）：[run-tests.mjs](../scripts/run-tests.mjs) `verifyPhases` + [test-runner-shapes.test.ts](../tests/test-runner-shapes.test.ts)                                                                                                                                                                                                                                                       |
| `build-ci-tests-3`                      | 清单按 `--profile` 派生产物名：[write-release-manifest.mjs:21-30](../scripts/write-release-manifest.mjs#L21-L30)、[package.json:18](../package.json#L18)；回归 [desktop-upgrade.test.ts:275-320](../tests/desktop-upgrade.test.ts#L275-L320)                                                                                                                                                                          |
| `storage-protocol-carrier-1`            | 恢复副本准入与保留预算拆分（§7.2.8）+ 剪枝守卫；[database-maintenance.test.ts](../tests/database-maintenance.test.ts)                                                                                                                                                                                                                                                                                                 |
| `storage-protocol-carrier-3`            | 重试计数带会话作用域：[run-request.ts:230](../packages/core/run-request.ts#L230) → [session-runs.ts:357-365](../packages/storage/session-runs.ts#L357-L365)（无调用点回归）                                                                                                                                                                                                                                           |
| i18n 门禁 P3（非 34 条）                | `CORE_ALLOWED` 由「整行子串命中」改为「删掉已登记文本后再看剩余」：[i18n-gate.mjs:230](../scripts/i18n-gate.mjs#L230)、[:293-327](../scripts/i18n-gate.mjs#L293-L327)；回归 [i18n-gate.test.ts:179-208](../tests/i18n-gate.test.ts#L179-L208)（2026-10-15 本会话修复，RED→GREEN 已验证）                                                                                                                              |

### 2026-10-16 本次修订关闭的三项（由外部写入者实现，本次复核确认）

| 原 ID                               | 关闭依据与证据                                                                                                                                                                                                      |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `storage-protocol-carrier-2`        | `workspaces.orphaned` 接通 + `bindingId` 寻址 + 桌面「保留的工作区」入口；[workspaces.ts:63-66](../apps/agent-host/handlers/workspaces.ts#L63-L66)；作者记录 48/48 定向回归                                         |
| `integrations-1`                    | 生命周期事件补上只读门：[hook-bridge.ts:188](../packages/resources/hook-bridge.ts#L188)、[:201](../packages/resources/hook-bridge.ts#L201)（`if (context.readOnly) return;`）；连带修掉「取消后丢失规划转可写状态」 |
| `desktop-app-3`（`R1-core-4` 同族） | 用户内容节点 `translate="no"` + 属性原文往返：[i18n.ts:1127](../apps/desktop/i18n.ts#L1127)、[:1159](../apps/desktop/i18n.ts#L1159)、[:1180](../apps/desktop/i18n.ts#L1180)                                         |

## 6. 建议执行顺序

1. ~~等写入者停止、冻结快照、跑全量~~ —— 已于 2026-10-16 09:25 完成且为绿（见 P0-2）。**仍未做的是提交**（P0-3）。
2. ~~**P1-2**（`office_inspect` 解压上限）~~ —— 已完成（本会话）。
3. ~~**P1-3**（文案双向漏出）~~ —— 已完成（本会话）。
4. ~~**P2-1/P2-2**（两个无界接口）~~ —— 已完成（本会话）。P2-1 顺带补上出站背压界限；P2-2 的上限取传输帧界而非页预算，以保住 [large-response.test.ts:229](../tests/large-response.test.ts#L229) 依赖的 16 MB 不分页契约。
5. ~~**P2-3/P2-4/P2-5**（内核同区三个小缺陷）~~ —— 已完成（本会话）。P2-4 顺带由 `cycles:check` 抓出一个真实导入环，已用中性的 `packages/core/text.ts` 解开。
6. ~~**P2-7**（内容过滤的两种误读）~~ —— 已完成（本会话）。新增 `content-filter` 终止原因与 `content-filtered` 失败码，三种协议统一，内核不重发且保留可见文本。
7. **需产品决策后再动**：P2-6（校准归一化，源码注释主张现行为有意）、P2-9（草案文案语言）、P3-3（语言预览 vs 主进程）。
8. **仓库策略/取舍**：P2-8（基准本地配置移出版本控制并加 ignore 规则）、P3-2（macOS 临时目录回收策略）。
9. ~~**P3-1**（显式压缩命令）~~ —— 已完成（本会话）；**P3-4**（把本清单与各验证记录合并成单一索引并重算主评估文档状态）仍待做。
10. **P3-6** 平台验收按可获得的独立环境分别排期；**P2-10** 的 `smoke:desktop` 不稳定性需要单独定位。

## 附录 A：原审计 34 条跟踪项现状

| 严重度       | 已修                                                                                                                                                                                                                                                                                                                                                                                           | 仍开（本文档位置） |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ |
| high（2）    | `R1-tools-credential-8dot3`、`hosts-assembly-1`                                                                                                                                                                                                                                                                                                                                                | —                  |
| medium（13） | `ENV-1`、`R1-core-1`、`core-kernel-1`、`R1-tools-toolcut-output-never-spilled`、`hosts-assembly-2`、`build-ci-tests-1`、`build-ci-tests-2`、`build-ci-tests-3`、`storage-protocol-carrier-1`、`integrations-1`、`storage-protocol-carrier-2`、`integrations-4`、`desktop-app-1`                                                                                                                | —                  |
| low（19）    | `core-kernel-2`、`hosts-assembly-3`、`hosts-assembly-6`、`integrations-2`、`integrations-3`、`storage-protocol-carrier-3`、`desktop-app-3`、`hosts-assembly-4`、`hosts-assembly-5`、`R1-core-2`、`R1-core-3`、`R1-core-5`、`integrations-5`、`storage-protocol-carrier-4`、`build-ci-tests-4`、`R1-core-4`（P2-9），以及**裁决保持现状**的 `core-kernel-3`、`desktop-app-2`、`tools-sandbox-2` | —                  |

合计：**31 已修 · 3 已裁决保持现状 · 0 仍开**（本会话关闭：`integrations-4`、`desktop-app-1`、`hosts-assembly-4`、`hosts-assembly-5`、`R1-core-2`、`R1-core-3`、`R1-core-5`、`integrations-5`、`storage-protocol-carrier-4`、`build-ci-tests-4`、`R1-core-4`；本会话裁决保持：`core-kernel-3`、`desktop-app-2`、`tools-sandbox-2`；此前由外部写入者关闭：`storage-protocol-carrier-2`、`integrations-1`、`desktop-app-3`）。**原 34 条跟踪项到此全部收口。** 另有本会话新发现的 **P2-10（`smoke:desktop` 不稳定/挂起）**，不在原 34 条之内，仍未定位。

## 附录 C：本会话的产品决策记录（2026-10-16，用户裁定）

| 条目                       | 决定                                   | 落地方式                                                                                      |
| -------------------------- | -------------------------------------- | --------------------------------------------------------------------------------------------- |
| P2-6（`core-kernel-3`）    | **保持现状**                           | 新增 [context.test.ts](../tests/context.test.ts) 的形状保持回归，把注释里的主张变成可判别断言 |
| P2-8（`build-ci-tests-4`） | **只把三个 JSON 配置移出版本控制**     | `git rm --cached` + [.gitignore](../.gitignore#L17-L20) 规则；10 个工具脚本仍跟踪             |
| P2-9（`R1-core-4`）        | **内核按调用方传入的语言生成草案文案** | 实现待做（下一轮）：`task-spec` 增加语言参数，Host 从界面设置传入                             |
| P3-2（`tools-sandbox-2`）  | **保持现状**                           | 决定与理由记录在 P3-2 行                                                                      |
| P3-3（`desktop-app-2`）    | **保持现状**                           | 决定与理由记录在 P3-3 行                                                                      |

## 附录 B：本清单的证据来源与局限

- **来源一：三组只读静态审计**（2026-10-16 07:40 前后，针对当时的工作树）——分别覆盖内核/桌面、宿主/载体/存储、工具/沙箱/构建/集成，均给出 `文件:行` 证据；三组都被要求**不运行任何测试套件**（本机 Windows 沙箱 ACL 租约是机器级独占的，并行跑套件会互相污染）。
- **来源二：另一写入者的验证记录**——[incremental-repairs-validation-2026-10-15.md](incremental-repairs-validation-2026-10-15.md)、[tcp-carrier-auth-validation-2026-10-15.md](tcp-carrier-auth-validation-2026-10-15.md)、[core-storage-split-validation-2026-10-15.md](core-storage-split-validation-2026-10-15.md)、[stable-repairs-validation-2026-10-15.md](stable-repairs-validation-2026-10-15.md)。其「后续队列」与本清单的 P1/P3 一致。
- **来源三：本会话的直接核对**——`git log`/`git status`、`npm run typecheck`、`npm run cycles:check`（335 文件 / 837 边 / 0 环，按 10-15 记录；本会话早前为 321/797/0）、`npm run i18n:check`、`docs:check`、`references:check`，以及 2026-10-15 的定向回归 174 项（60 + 114，0 失败、8 项环境跳过）。另有 **8 条关键证据由我逐字复读原文确认**，行号与机制描述一致：`run-request.ts:423-433`、`shrink.ts:63-80`、`history.ts:22-36`、`calibration.ts:178`、`openai.ts:308-309`、`task-trigger.ts:261-264`、`seatbelt-scratch.ts:24`、`carrier.ts:87`。第二次修订（09:45）另核对：`git` 状态与文件时间戳、最终全量日志的 `run-summary`，以及 14 项仍开条目的源码逐一复查（全部与 07:47 判定一致，本轮无人改动）。
- **局限**：
  1. 除标注「A」的条目外，判定来自**单次静态审计**，未独立复跑；尤其 P1-2 的 zip 炸弹未实际构造。
  2. 第二次修订（09:45）时外部写入者已停止、最终全量为绿；但各项关闭判定仍以**源码复核 + 作者记录**为主，未重跑其定向回归（除本文档另行注明者）。
  3. 转述自另一写入者文档的「已修」条目按其记录与源码核对，未逐条重跑其回归。
  4. 本文档不构成发布或平台验收结论；跳过项不含在此列。
