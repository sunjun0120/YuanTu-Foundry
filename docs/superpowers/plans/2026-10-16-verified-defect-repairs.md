# 已验证缺陷逐步修复与清单复核

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 先修复本会话确认的问题，再独立裁决新缺陷清单中的每项主张，修复成立的缺陷。

**Architecture:** 保持现有模块和权限边界。异步失败在所属生命周期内结算；无法确认进程终止时保留资源以供恢复，禁止以删除锁或吞掉错误伪造成功。

**Tech Stack:** Node 24、TypeScript、node:test、SQLite、Electron、Windows 原生后端。

**Spec:** 用户本轮指令及本文件的 Global Constraints；待复核输入为 [新缺陷清单](../../open-defects-2026-10-16.md)。清单是待验证主张，不是已批准的实现方案。

## Global Constraints

- 使用当前 checkout；保护已有未跟踪文件和并行修改，不创建额外 worktree、不提交 Git。
- 不删除机器租约锁，不改机器 ACL、WFP、签名或安装配置；仅通过现有测试验证原生行为。
- 每项行为修复先写可判别回归，确认 RED，再实现并确认 GREEN。
- 不增加 skip、自动重试或放宽断言来掩盖失败；完整测试在所有代码稳定后运行一次。
- 保留合法语义：未知进程终止保留租约；知识分块可重叠；SIGTERM 不等于确认终止。

## Review Focus

- 调度数据库失败、重排定时器失败以及诊断回调失败都不能产生未处理拒绝。
- 测试后端必须明确；用户凭据与其他 YUANTU 配置仍不能泄漏到 worker。
- SQLite 引号内的注释标记、分号、转义引号与绑定参数必须保留路径归属检查。
- 源码指纹覆盖实际配置输入，但不遍历二进制、依赖和运行产物。
- 清理失败不能撤销仍被活进程依赖的授权；可重试清理不能永久缓存拒绝的 Promise。

## Task 1: 调度器异常隔离

- [x] 在调度器现有测试中加入数据库故障下启动、定时触发及手动唤醒回归，观察 RED。
- [x] 修改 `apps/agent-host/scheduler.ts` 和任务审批调用点，保留显式 `tick()` 的错误契约，后台触发统一报告失败并重新定时。
- [x] 运行调度与任务回归，记录结果。

## Task 2: 测试隔离三个缺陷

- [x] 测试并修复 `scripts/test-isolation/environment.mjs` 的 Host 后端配置，明确普通夹具使用 host，真实 native 用例仍显式指定原生后端。
- [x] 测试并修复 `scripts/test-isolation/sqlite.mjs` 的 SQL 引号与注释分词；包含合法特殊路径和越界反例。
- [x] 测试并修复 `scripts/test-source-fingerprint.mjs` 的配置输入清单，覆盖 build 锁、根配置和 CI 输入，排除生成资产。
- [x] 运行隔离、调度、入口与相关 Host 回归。

## Task 3: 逐条复核新文档

- [x] 逐条裁决 D1–D11 与 §3 的失败归因，记录成立、部分成立、误报及其证据。
- [x] 对成立项依次 RED → 最小修复 → GREEN，不照搬清单中的不安全清理建议。
- [x] 复核根目录旧 SQLite 快照的历史等价性与引用，确认可再生后移入忽略的 scratch 备份，解除格式阻塞。
- [x] 更新原清单的裁决附录，不改写他人的原始扫描记录。

## Task 4: 汇总验证与独立复核

- [x] 格式、类型、文档事实、引用、循环依赖、i18n、隔离 lint、构建与编译客户端冒烟。
- [ ] 当前源码完整测试由用户安排的其他 agent 执行；本线程已按用户要求停止，不重复启动。
- [x] 新上下文审查本轮 diff，处理确认的实质问题；记录剩余平台验收边界。

## 执行记录

## Task 5: 用户部分修复后的续修

- [x] 独立复现 rescan 的 O1–O5，逐项 RED→GREEN，保留用户已有 27 项修改。
- [x] OAuth 元数据观察增加时间与大小上限；模型发现对响应头和响应体统一使用可取消的截止时间。
- [x] Host 重启前结算旧 transport，强停后仍未确认退出则拒绝启动新代。
- [x] 桌面退出有界等待初始化，超时仍清理其他资源并明确报告未确认；不强杀 UAC 子进程。
- [x] IPC 失败恢复后台与工作区动作按钮，并在真实 DOM 中验证重试与忙碌状态。
- [x] 定向回归、九项门禁；更新复扫文档中的独立裁决。
- [ ] 当前源码完整测试由其他 agent 执行，等待其独立结果。

Ruling: 用户已明确要求继续修复剩余问题，O1–O5 属于已有流程的有限修复，沿用已授权的内联执行，不增加设计确认；不启用暂停的公共入口，不改机器安装配置。

Ruling: 上一冻结快照全量为 2476 pass / 1 fail / 113 skip，原生阶段 0 fail；唯一失败为 150ms 子代理进度夹具。用户随后已修改源码与相关测试，因此旧运行不能代表当前源码，先验证当前版本。

- Baseline: HEAD `0f756df`；已有未跟踪 `.scratch-old-sqlite.ts`、`docs/open-defects-2026-10-16.md`。
- Baseline 全量：249 文件完整结算，2454 pass / 2 fail / 113 skip；失败为会话删除并发断言及 Windows ACL 租约冲突。单独会话删除用例通过。
- Ruling: 用户已明确授权顺序修复并复核文档，直接在当前 checkout 执行，不再增加技能中的计划确认或 worktree 确认环节。
- Ruling: 不执行 Git 提交；进度和证据保存在此计划，避免影响用户的提交与并行文档。
- Pre-flight: Task 1 的调度错误入口供 D1 关闭；Task 2 的 Host 默认后端影响 §3 原生竞争归因；D2/D3/D5 必须遵循现有终止确认与租约所有权合同。
- Task 1 complete: 4 个故障注入 RED，最小修复后 35 项相关回归通过。
- Task 2 complete: 3 个原始探针 RED→GREEN；隔离/入口/调度/Host 七文件 100/100。额外 protected 打包配置回归 RED→修补根配置匹配。
- Task 3 in progress: D6 请求 Promise、D7 短读、D8 SIGTERM、D10 socket 错误均 RED→GREEN；六文件 100/100。D2/D3/D5 所需清理与租约边界回归 13/13，D4 强停错误回归 5/5。
- Ruling D2/D3: 保留未确认终止或恢复失败资源是安全合同，不使用文档建议的强制 finally 删除。真正缺陷是 available 拒绝逃逸、拒绝 Promise 永久缓存和已完成步骤重复释放；以可重试分阶段清理修复。
- Ruling D4: 根 PID 不存在不能证明 Windows 后代不存在，不把 taskkill 的非零结果伪装成功。改为确保后台失败经过清理结算并以 ToolCleanupError 返回。
- Ruling D9: 新回归发现总字节预算实际未执行；去掉首文件的预算豁免后 GREEN，不仅删除不可达分支。
- Ruling D11: 分块重叠保留边界上下文，计数与真实行数相符，原“计数虚高”不是功能缺陷；保持结果、显式化常量与注释。
- Ruling §3: 未验证身份不能结束进程，未知清理阻止后续调度是必要保护。仅增大 WMI 身份查询的有界等待，不降低 unsafe 门槛或添加自动重试。
- 根目录残留已验证与 `27bb603:packages/storage/sqlite.ts` 逐字符一致（仅 BOM/CRLF 不同），无运行引用，已移动到忽略的 `.scratch/verified-defect-repairs/original-sqlite.ts` 保留原件。

- 最终独立复核：两项 Important 已确认并按 RED→GREEN 处理。SIGTERM 投递拒绝不得误报成功；终止确认加入可重试清理检查点，避免 control 部分删除导致永久租约。两文件 32/32；不再重复委派复核。
- Ruling D8: 明确 PtyProcess.terminate 的可投递命名信号合同为投递确认，非等待退出；工具等待投递确认并传播拒绝，只在强停时等待 closed。原“后端可一直等退出而仍立即报告 Sent”会误报，已撤销。

- 全库验证迭代：history-window 两个 after 钩子在夹具强杀 Host 后才 stop 客户端，D10 正确暴露该异常。先 RED（全库两处失败），再让夹具 beforeStop 先执行真实客户端关闭；相关两文件 16/16。未通过首轮不计全库完成，取消后核对本轮登记的存活进程为 0 并清理专属临时目录。

- 原生全库迭代：249 文件完整执行、源码指纹相同，2453 pass / 24 fail / 113 skip。首个失败为 termination 检查前设置 releasing 导致已有重复启动合同改变，随后自身 stale ACL 租约造成 23 个连锁失败；已补实际 cleanup+mark 状态回归 RED→GREEN，将 releasing 标记移到终止确认成功之后。
- 自身测试恢复：PID 6828 已退出，9 个日志授权条目及整个 Qnr1v1 测试树全部不存在，完整报告证明无未结算进程。经哈希核对，仅把本轮 workspace-owner.lock 和对应 journal 可逆移入 .scratch/verified-defect-repairs/own-native-lease-backup；未删除锁、未修改 ACL/WFP，也未处理任何未知所有者租约。备份保留 evidence.json。

- Task 5 实施完成：O1–O5 均 RED→GREEN；关联8文件 166 pass / 0 fail / 10 skip，source 未变且清理正常。独立新上下文复核没有阻断发现。
- Ruling: 150ms 子代理夹具在真实全库中曾失败，不以重跑通过将其关闭；改用受控 setTimeout 时钟，在保留原截止与完成断言外增加总时间已跨窗断言。用户追加的同文件测试不变。

## Task 6: 后台任务状态样式

- [x] 入口只保留数量与文字，去掉前置图标和下拉箭头；保留展开交互与无障碍状态。
- [x] 每个子任务复用子代理的 7px 状态点：运行中脉动、已完成绿色静态；采用同一 CSS 类。
- [x] 状态回归核对真实子代理的计算样式、运行/完成切换与减少动画设置；桌面 DOM 完整文件 6/6。
- [x] shell 列使用自动宽度，避免 powershell 名称覆盖命令内容。
- [x] 九项门禁和构建通过；全量验证按用户要求交由其他 agent。

为优先处理用户的 UI 修改，上一轮全量通过受控取消结算；报告 complete=false，清理与隔离正常，不计为完整通过。

用户明确要求不再执行全量，由其他 agent 负责。已向当前运行器发送受控取消并等待退出；remaining-final 报告 complete=false，7/249 文件结算，源码指纹未变、清理与隔离问题为 0。保留取消报告供交接，不把已通过的 68 项计作全量通过。
