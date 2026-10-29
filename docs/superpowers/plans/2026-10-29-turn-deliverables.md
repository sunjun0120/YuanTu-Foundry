# Turn Deliverables Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans to implement this plan task-by-task. The user authorized immediate implementation in the existing checkout.

**Goal:** 在每轮回复末尾展示可操作的本轮产物。

**Architecture:** 新增从现有日志恢复轮次及结束消息索引的投影；保持原汇总读取兼容。客户端读取分轮记录，React transcript 按消息索引插入已有卡片组件。

**Tech Stack:** TypeScript, React, SQLite session projections, Node tests, Electron/Playwright.

**Spec:** docs/superpowers/specs/2026-10-29-turn-deliverables-design.md

## Global Constraints

不新增依赖。保留已有工作区修改。不提交或推送。沿用文件预览与安全打开操作。

## Review Focus

同名文件跨轮不覆盖；同轮重复提交替换；中断后仍能交付；分页不误挂卡片；异步会话切换不能串入产物。

### Task 1: Durable turn ownership

- [x] 先写历史日志重放、同名文件跨轮、同轮替换、中断和重开数据库测试，确认失败。
- [x] 在 protocol/deliverables.ts 定义可选归属字段及分轮合并，在 storage/turn-deliverables.ts 实现新投影并注册；新增 store 读取方法。
- [x] deliverables.get 增加 byTurn 可选参数，旧调用保持原语义；运行相关测试。

### Task 2: Client and transcript

- [x] 增加按索引插入产物片段、隐藏运行中记录及分页边界测试，确认失败。
- [x] session-history 与 session-controller 保留分轮文件，结束后读取权威消息索引。
- [x] transcript-model / transcript-mount / Conversation 渲染每轮产物，复用 DeliverablesPanel 的无重复 id 模式；application 传入预览与 shell 操作并更新重绘身份。
- [x] 删除旧隐藏的会话底部产物挂载；增加本轮产物翻译。

### Task 3: Verification

- [x] 桌面 smoke 验证两轮同名文件分别留在回复后，能预览，重新加载仍存在。
- [x] 相关定向回归、typecheck、相关 lint、修改文件 format、build。
- [x] 审查最终差异与现有修改的交集，记录结果。

## 验证与决策记录

- 用户要求“先不用全量测试，还有其他改动”，已中止全量及先前较广的相关套件；不声明全仓测试通过。
- 最终定向验证：9 项客户端用例、28 项产物/消息布局/展示工具/面板用例、1 项 Electron smoke，全部通过。最终 build、typecheck、相关 ESLint、差异空白检查通过。
- 独立审查发现会话加载时运行恰好结束会漏刷新产物位置。先增加断言复现失败，再同时重读消息和产物，并覆盖消息已结束但产物读取得更早的情况；复查无新增问题。
- 普通沙箱内较广套件遇到 SQLite 备份目录访问失败和客户端写入失败，已停止；最终 Electron 用例在本机权限下运行成功。
- 此前全仓 docs:check 报告 README 生成块不同步，format:check 报告其他工作生成的 benchmark 文件格式问题；本次未修改这些文件。
- 原有工作区修改保留；没有提交或推送。
