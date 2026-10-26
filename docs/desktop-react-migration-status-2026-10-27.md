# 桌面 React 迁移实施状态（2026-10-27）

本文件记录 `docs/superpowers/plans/2026-10-26-desktop-react-typescript-migration.md` 的实际进度，供 T26 完整验收时继续填写。它**不是**完成验收记录：迁移尚未全部结束，未完成项在下方明确列出。

## 已完成（有测试与冒烟证据）

| 区域                         | 实现                                                                                       | 旧模块                                                                                                         | 定向验证                                                                                           |
| ---------------------------- | ------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| 工具链/门禁                  | tsconfig、eslint、layers/cycles/i18n gate、compat-id 登记                                  | —                                                                                                              | 全仓库 gate                                                                                        |
| 设置（通用/模型/工作区维护） | `ui/settings/*`                                                                            | `renderer-general-settings.ts`、`renderer-settings.ts`（picker 入口保留）、`renderer-workspace-maintenance.ts` | settings 8 通过 + 1 跳过（MCP）；general-settings 8 条 controller 测试                             |
| 沙箱权限                     | `ui/sandbox/*`、`ui/permissions/*`                                                         | `renderer-sandbox-setup.ts`、`renderer-permissions.ts`                                                         | desktop-capabilities、desktop-language                                                             |
| 会话列表/对话框/归档         | `ui/sessions/*`（session-model、SessionSidebar/Row/Dialog、ArchivedSessions）              | `renderer-session-list.ts`、`session-management.ts`、`renderer-archived-sessions.ts`                           | desktop-react-sessions 10/10；desktop-sessions                                                     |
| 命令菜单                     | `ui/composer/command-*`                                                                    | `renderer-commands.ts`                                                                                         | desktop-react-composer 9/9（palette）                                                              |
| 附件                         | `ui/composer/attachment-*`、`Attachments`                                                  | `renderer-attachments.ts`、`renderer-attachment-copy.ts`                                                       | desktop-react-attachments 10/10；agent 7/7（附件全流程）                                           |
| 工作区面板                   | `ui/workspace/*`（model、WorkspacePanel、FileTree/FilePreview、mount）                     | `renderer-workspace.ts`                                                                                        | workspace-panel-loading 12/12；desktop-sessions 6/6（拖拽/全屏/预览/tab/滚动）                     |
| 统计/后台                    | `ui/panels/Statistics`、`BackgroundPanel`、两个 model                                      | `renderer-statistics.ts`、`renderer-background.ts`                                                             | statistics-model 9/9、background-model 7/7；agent 7/7、layout 4/4                                  |
| 任务/计划/会话辅助           | `ui/panels/task-view`、`TasksPanel`、`PlanPanel`、`SessionPanels`、`task-confirm-drafts`   | `renderer-tasks.ts`、`renderer-plan.ts`、`renderer-session-panels.ts`                                          | task-view 11/11、plan-contract 10/10、session-panels-model 4/4；workflows 4/4                      |
| 问题/审批/计划批准卡         | `ui/conversation/question-model`、`Questions`、`approval-model`、`Approvals`、mounts       | `renderer-questions.ts`（审批内联块从 renderer.ts 移出）                                                       | question-model 9/9、approval-model 2/2；agent 7/7、desktop 9/9、sessions 6/6                       |
| 流式答案与思考               | `stream-store`、`MarkdownView`、`LiveMessage`、`live-message-mount`、`live-model`          | `renderer-live.ts` 只剩调度（`#live` 为稳定宿主）                                                              | desktop-react-stream 10/10；agent 7/7、language 7/7、desktop 9/9                                   |
| Transcript/历史消息          | `Conversation`、`transcript-mount`、`transcript-model`、`scroll-anchor`、`completion-view` | `renderer-transcript.ts`（`renderer-messages.ts` 仅作 DOM 岛）                                                 | desktop-react-transcript 7/7、scroll-anchor 5/5；desktop 9/9、history 2/2、agent 7/7、sessions 6/6 |
| 子 agent                     | `Subagents`、`subagents-mount`、`subagent-model`                                           | `renderer-subagents.ts`                                                                                        | subagent-model 5/5；agent 7/7、workspace-ui 5/5、language 7/7                                      |
| 本轮改动                     | `TurnChanges`、`turn-changes-mount`、`turn-changes-model`                                  | `renderer-changes.ts`                                                                                          | turn-changes-model 6/6；desktop 9/9、sessions 6/6、agent 7/7                                       |

## 未完成 / 明确保留的 legacy

1. **T21 剩余**：统一 PanelTransition 与专门的 transcript 动画冒烟未做；消息/工具卡/markdown 内容仍由 `renderer-messages.ts` 构建（DOM 岛）。
2. **T20 剩余**：`#live` 仍是静态宿主（内部全部 React，`hidden` 由 mount 写）；专门的 React DOM 身份/MutationObserver 冒烟未记录。
3. **T23 已完成**：子 agent 与本轮改动两组面板都由 React 接管；diff 正文与消息内容仍是 DOM 岛。
4. **任务编辑/触发设置表单**：`renderer-tasks-editors.ts` 仍是 legacy DOM，作为宿主节点嵌在 React 卡片中；字段、校验与保存协议原样。
5. **M7 T24 外壳接管/CSS 退役**：尚未开始。`#`/class 兼容 id 仍按计划保留，旧 CSS 仍为 6,033 行。
6. **M7 T25 Slot/遗留清理**：未开始；`renderer.ts` 仍创建多个 React 区域挂载点，旧整页渲染仍在。
7. **M7 T26 完整验收**：尚未完成；已写 `docs/validation-desktop-react-migration-2026-10-27.md`，其中明确列出未达标项与自动化证据。

## 当前门禁与测试证据（最近一次）

- `npx tsc --noEmit`、`npm run lint`、`npm run i18n:check`、`npm run layers:check`、`npm run cycles:check`、`npm run format:check`、`npm run docs:check`、`npm run build` 全绿。
- 单元/模型测试：desktop-react-stream 10、desktop-react-transcript 7、scroll-anchor 5、turn-changes-model 6、subagent-model 5、question-model 9、approval-model 2、task-view 11、plan-contract 10、session-panels-model 4、background-model 7、statistics-model 9、workspace-panel-loading 12、desktop-react-attachments 10、desktop-react-sessions 10、desktop-react-composer 18、desktop-copy 14、desktop-i18n 5。
- Electron 冒烟：agent 7、desktop 9、workflows 4、desktop-language 7、desktop-layout 4、desktop-capabilities 3、desktop-sessions 6、settings 8（+1 跳过 MCP）、round3 1（+1 跳过 Chromium）、backups 跳过（范围外）。

## CSS 基线（T24 尚未开始）

| 文件                 | 行数 | !important |
| -------------------- | ---- | ---------- |
| styles.css           | 1403 | 12         |
| styles-panels.css    | 452  | 0          |
| styles-subagents.css | 1005 | 0          |
| layout.css           | 1371 | 0          |
| layout-surfaces.css  | 1339 | 14         |
| layout-workspace.css | 413  | 3          |
| 合计                 | 5983 | 29         |

计划 T24 要求完成时旧 CSS 合计 ≤ 1,200 行；当前 5,983 行（T24 起步删除已移除的 #project-name/.header-context/.message-label/.message-model/.background-meta/.background-log 规则），外壳接管与其余删除尚未开始。

## 推进顺序（剩余）

1. 完成 T23 子 agent 面板迁移；把 `renderer-changes.ts` 与 transcript 一起处理。
2. T21 React 消息列表与滚动锚点（依赖 `transcript-model`）。
3. 接入 `stream-store` 与 LiveMessage/reasoning。
4. T24 外壳接管 + CSS 退役；T25 Slot/遗留清理；T26 完整验收记录替换本文件。
