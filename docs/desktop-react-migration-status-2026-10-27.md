# 桌面 React 迁移最终状态（2026-10-27）

本文件是迁移完成后的状态说明，取代同名文件早期的“实施中”版本。过程记录与逐任务证据在
`docs/superpowers/plans/2026-10-27-desktop-react-completion-ledger.md`，验收结果与截图/指标在
`docs/validation-desktop-react-migration-2026-10-27.md`。

## 结论

计划 `docs/superpowers/plans/2026-10-26-desktop-react-typescript-migration.md` 的 M1–M7 任务全部完成，桌面产品由单一
React 根渲染：`renderer.ts`（36 行）只创建 runtime/actions 和一个 root，`index.html`（21 行、无静态产品结构、无中文）
只保留 `#desktop-root` 与两个本地样式表。六份旧 CSS 退休为 1 行说明；兼容 id 表为空且 `MIGRATION_COMPLETE = true`；
i18n 翻译 walker 与原生 select upgrader 已删除。

## 完成情况

| 里程碑                         | 结果 | 主要证据                                                                                                                                              |
| ------------------------------ | ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| M1 工具链/CSP/i18n/smoke 基建  | 完成 | 全仓库 gate；`desktop-react-csp` 2/2；`desktop-react-toolchain` 6/6；`ui-i18n-coverage` 2/2                                                           |
| M2 runtime/provider/主题/外壳  | 完成 | 单一 root/provider/theme；`desktop-react` 6/6；`desktop-react-runtime` 13/13                                                                          |
| M3 动效                        | 完成 | `desktop-react-motion` 5/5（帧采样）；`desktop-react-navigation`（页面过渡/快速反向）                                                                 |
| M4 设置页                      | 完成 | controller 测试；`settings` 8 通过 + 1 个既有 MCP 跳过；`desktop-language` 7/7                                                                        |
| M5 会话/输入/附件/工作区/面板  | 完成 | `desktop-react-sessions` 10/10、`desktop-react-composer` 18/18、`desktop-react-attachments` 10/10、`workspace-panel-loading` 12/12、`task-view` 11/11 |
| M6 对话流                      | 完成 | `desktop-react-stream` 10/10、`desktop-react-transcript` 7/7、`scroll-anchor` 5/5、`question-model` 9/9、`approval-model` 2/2、`subagent-model` 5/5   |
| M7 外壳接管/CSS 退役/清理/验收 | 完成 | `desktop-react-dom-audit-2026-10-27.md`；`desktop-react-identity` 1/1；CSS 预算 6 行；最终验收记录                                                    |

## 明确保留的过渡形态（不是遗漏）

1. **内容 DOM 岛**：消息正文、工具卡、Markdown、diff 正文、完成块仍由 `renderer-messages.ts` / `markdown.ts` /
   `tool-cards.ts` / `diff-view.ts` / `completion-view.ts` 构建，由 React 行通过 ref 承载。React 拥有位置、key、
   展开状态与元数据；计划允许这些安全敏感内容保持岛状并已逐项登记在 DOM 审计中。
2. **休眠 MCP 设置面板**：`renderer-mcp.ts` 由 `PRODUCT_SCOPE.mcpManagement`（当前 `false`）关闭，入口不渲染、冒烟跳过。
   这是计划 T13 记录的偏差；重新启用该功能前需迁移为 `ui/settings/McpSettings.tsx`。
3. **纯文本 helper**：`renderer-status.ts`、`renderer-messages.ts` 的文案函数、`renderer-error-text.ts`、
   `renderer-question-copy.ts`、`renderer-export.ts` 不含页面构建，保留供模型与测试共享。

## 文档关系

- 本文件：完成状态摘要。
- `docs/validation-desktop-react-migration-2026-10-27.md`：最终验收（命令、截图、指标、限制）。
- `docs/desktop-react-css-retirement-2026-10-27.md`：CSS 归属迁移与最终行数。
- `docs/desktop-react-dom-audit-2026-10-27.md`：剩余 DOM 调用的逐项归属。
- `docs/superpowers/plans/2026-10-27-desktop-react-completion-ledger.md`：M7 拆解、缺陷与证据流水。
