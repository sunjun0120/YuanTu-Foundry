# 桌面 React 迁移验证记录（2026-10-27）

**结论：迁移未完成，本记录不是完成验收。** M2–M6 的迁移任务已落地，M7（外壳接管、CSS 退役、Slot/遗留清理、完整验收）尚未完成；计划中的完整验收标准（六份旧 CSS ≤1,200 行、单一 React 根、`renderer.ts` 仅创建 runtime/root、兼容 id 清零）未达到。下文分别列出已验证事实与未达标项。

## 1. 已完成并有证据的部分

| 任务                       | 实现                                                                                                           | 被替换/保留                                                           | 证据                                                                                 |
| -------------------------- | -------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| T1–T4 工具链               | tsconfig、eslint、layers/cycles/i18n gate、compat-id 登记、`renderer-globals.d.ts`、`ui/nonce.ts`              | —                                                                     | 全仓库 gate                                                                          |
| T5–T9 运行时/壳/基础组件   | `ui/stores`、`runtime`、`actions`、`context`、`primitives`、`providers`、`i18n`、`App`、`DesktopShell`、motion | —                                                                     | React 冒烟、motion 冒烟                                                              |
| T10 通用设置               | `ui/settings/GeneralSettings`                                                                                  | `renderer-general-settings.ts`                                        | controller 测试 8 条；settings 冒烟                                                  |
| T11 模型设置               | `ui/settings/ModelSettings` + model                                                                            | `renderer-settings.ts` 缩减为 picker 入口                             | settings 8 通过 + 1 跳过（MCP）                                                      |
| T12 沙箱/权限              | `ui/sandbox`、`ui/permissions`                                                                                 | `renderer-sandbox-setup.ts`、`renderer-permissions.ts`                | capabilities、language                                                               |
| T13 工作区维护/归档        | `ui/settings/WorkspaceMaintenance`、`ui/sessions/ArchivedSessions`                                             | `renderer-workspace-maintenance.ts`、`renderer-archived-sessions.ts`  | workspace-settings 10 条                                                             |
| T14 会话列表               | `ui/sessions/*`                                                                                                | `renderer-session-list.ts`、`session-management.ts`                   | desktop-react-sessions 10/10                                                         |
| T15 命令菜单/composer 状态 | `ui/composer/command-*`、`composer-model`                                                                      | `renderer-commands.ts`；`renderer-composer.ts` 为 DOM adapter         | desktop-react-composer 18/18；language/workflows/agent                               |
| T16 附件                   | `ui/composer/Attachments` + model/mount                                                                        | `renderer-attachments.ts`、`renderer-attachment-copy.ts`              | desktop-react-attachments 10/10；agent 7/7                                           |
| T17 工作区面板             | `ui/workspace/*`                                                                                               | `renderer-workspace.ts`                                               | workspace-panel-loading 12/12；desktop-sessions 6/6                                  |
| T18 后台/统计              | `BackgroundPanel`、`Statistics` + models                                                                       | `renderer-background.ts`、`renderer-statistics.ts`                    | statistics-model 9/9、background-model 7/7；agent/layout                             |
| T19 任务/计划/会话辅助     | `TasksPanel`、`PlanPanel`、`SessionPanels` + models                                                            | `renderer-tasks.ts`、`renderer-plan.ts`、`renderer-session-panels.ts` | task-view 11/11、plan-contract 10/10、session-panels 4/4；workflows 4/4              |
| T20 流式/live              | `stream-store`、`MarkdownView`、`LiveMessage` + mount                                                          | `renderer-live.ts` 仅调度；`live-content.tsx`                         | desktop-react-stream 10/10；agent 7/7                                                |
| T21 Transcript             | `Conversation`、`transcript-mount`、`completion-view`、`transcript-model`、`scroll-anchor`                     | `renderer-transcript.ts`；`renderer-messages.ts` 仅 DOM 岛            | desktop-react-transcript 7/7、scroll-anchor 5/5；desktop 9/9、history 2/2、agent 7/7 |
| T22 问题/审批/计划批准卡   | `question-model`、`Questions`、`approval-model`、`Approvals`                                                   | `renderer-questions.ts`；审批内联块移出 renderer                      | question-model 9/9、approval-model 2/2；agent/desktop/sessions                       |
| T23 子 agent/本轮改动      | `Subagents`、`TurnChanges` + mounts/models                                                                     | `renderer-subagents.ts`、`renderer-changes.ts`                        | subagent-model 5/5、turn-changes-model 6/6；agent/sessions/desktop                   |

## 2. 未完成项（明确不达标）

1. **T21 动画项**：思考/工具组/验证证据尚未统一使用 `PanelTransition`，没有专门的 transcript 动画冒烟；流式行为由现有 Electron 冒烟覆盖。
2. **T20 React 冒烟证据**：未记录 MutationObserver/DOM 身份证据；现有 agent/desktop 断言覆盖流式正文与折叠状态。
3. **DOM 岛（按任务范围保留）**：消息/工具卡/markdown 内容仍由 `renderer-messages.ts` 构建；diff 正文仍由 `diff-view.diffBody` 构建；任务编辑/触发设置表单仍是 `renderer-tasks-editors.ts`；`turn-changes` 卡片内容通过 portal 承载。
4. **T24 应用外壳接管与旧 CSS 退役：仅起步**。六份旧 CSS 仍为 6,023 行 / 29 个 `!important`（T24 起步只删了已移除的 `#project-name`/`.header-context` 规则；目标 ≤1,200 远未达到）；`body` 仍是旧的页面 grid；`index.html` 仍保留整页静态结构；`renderer.ts` 仍创建多个 region 挂载点。
5. **T25 Slot/遗留清理：未开始**。`RegionHost`/portal 适配仍在；旧整页 render 仍在；兼容 id 登记表未清零；i18n walker 与原生 select upgrader 仍为 legacy 区域服务。
6. **T26 完整验收：未完成**。本记录只覆盖可自动化的检查，未做浅/深/系统主题、中英文、字号与窗口尺寸的截图对照，也没有动效的开始/中间/结束帧证据或打包资源校验。

## 3. 自动化验证

- 全量 `npm test`：一次完整运行在 45/324 个文件、631 条测试后遇到 `tests/swe-bench.test.ts` 的真实 Host 时序失败（`undefined !== true`）；该文件单独运行 19/19 通过，属于全量并行负载下的既有 flake，与本次迁移改动无关。调度器因失败未跑完剩余文件，因此不把全量套件记为通过。

- 门禁：`npx tsc --noEmit`、`npm run lint`、`npm run i18n:check`、`npm run layers:check`、`npm run cycles:check`、`npm run format:check`、`npm run docs:check`、`npm run references:check`、`npm run test:isolation:check`、`npm run build` 全绿。
- 最终定向批次（2026-10-27，24 个文件）：**190 通过 / 0 失败**（parallel 185 + serial 5，含 desktop-i18n）：desktop-react-stream 10、desktop-react-transcript 7、scroll-anchor 5、turn-changes-model 6、subagent-model 5、question-model 9、approval-model 2、task-view 11、plan-contract 10、session-panels-model 4、background-model 7、statistics-model 9、workspace-panel-loading 12、desktop-react-attachments 10、desktop-react-sessions 10、desktop-react-composer 18、desktop-copy 14、desktop-i18n 5、ui-i18n-coverage 2、compat-ids 5、render-caches 2、diff-view 6、i18n-gate 14、ui-copy-migration 7。\n- 最终完整桌面冒烟（2026-10-27，CSS/拖拽/会话菜单修复后重跑）：**72 通过 / 0 失败 / 3 跳过**（desktop-sessions 连续 3 次 6/6，确认 openMenu 的 cancelClose() 恢复执行后不再间歇超时）。desktop-react-stream 10、desktop-react-transcript 7、scroll-anchor 5、turn-changes-model 6、subagent-model 5、question-model 9、approval-model 2、task-view 11、plan-contract 10、session-panels-model 4、background-model 7、statistics-model 9、workspace-panel-loading 12、desktop-react-attachments 10、desktop-react-sessions 10、desktop-react-composer 18、desktop-copy 14、desktop-i18n 5、ui-i18n-coverage 2、compat-ids 5、render-caches 2、diff-view 6、i18n-gate 14。
- Electron 冒烟：完整
  pm run smoke:desktop（17 个套件）**72 通过 / 0 失败 / 3 跳过**；跳过项为 Chromium 截图（未安装）、MCP（范围外）、backups（范围外）。单套件：agent 7、desktop 9、workflows 4、language 7、layout 4、capabilities 3、sessions 6、settings 8（+1 跳过）、round3 1（+1 跳过）、history 2、workspace-ui 5、launcher 1、knowledge 1、react 4、motion 5。
- 受限环境：本机未安装 Chromium，`desktop-round3` 的 Chromium 截图用例跳过；无法完成 T26 要求的真实 Electron 截图/录屏对照。

## 4. 与迁移前行为的已知差异

- Mantine 统一控件带来的外观差异（按钮/输入/弹层）属于计划预期变化；行为断言均以原契约为准。
- 任务编辑器表单、消息内容、diff 正文仍是 legacy DOM 岛；这是计划中允许的过渡形态，但不是 T24/T25 完成后的终态。
- `#live` 仍是静态宿主：其 `hidden` 属性由 React 适配器写入，内部节点全部 React；把宿主本身移入 React 树需要 T24 的外壳改造。

## 5. M7 剩余工作拆解（供后续继续）

### T24 外壳接管与 CSS 退役

1. **页面结构**：把 `index.html` 的 `body` 网格、`#chat-sidebar`/`#chat-page`/`#workspace-root` 静态骨架迁入 `ui/layout/DesktopShell`；保留现有 region 容器（可先作为 `DesktopShell` 的 children）以缩小一次性改动。
2. **唯一根**：`renderer.ts` 只创建 runtime/actions 与一个 `createRoot`；删除 `RegionHost` 之外的多个 `mountRegion` 入口（区域组件改为同根子树）。
3. **过渡**：接通 `PageTransition` 到聊天/设置/设置分类/侧栏显隐；验证返回聊天恢复锚点、草稿与附件，快速反向切换不留下过期回调。
4. **CSS**：按迁移区域逐块删除 `#id` 规则；每删一块先跑 `desktop`/`desktop-sessions`/`settings` 冒烟，维护 §10 的六文件行数与 `!important` 预算（当前 5,983 / 29，目标 ≤1,200）。
5. **验收命令**：`node scripts/run-tests.mjs tests/desktop-layout.smoke.mjs tests/desktop-react-motion.smoke.mjs tests/desktop-react.smoke.mjs tests/desktop-launcher.smoke.mjs`，并检查 React warning / 未处理 Promise / CSP violation。

### T25 Slot 与遗留清理

1. 删除 `RegionHost`/portal 适配与旧整页 render；把 slot 语义迁入 `ui/slots.tsx`（五种 context、排序稳定、注销幂等、卸载无残留）。
2. 移除全局 select upgrader 与翻译 walker 的 legacy 依赖；旧 i18n 豁免若无匹配项一并删除。
3. 兼容 id 登记表清零（§11），`tests/compat-ids.test.ts` 只保留“表为空”断言。
4. 用 `rg` 清点剩余 `setup*`、`document.getElementById`、`replaceChildren`、`MutationObserver`、`addEventListener` 引用，逐项说明归属。

### T26 完整验收

1. 真实 Electron：浅/深/系统主题、中英文、字号、窗口尺寸截图对照；记录 Mantine 控件带来的预期差异。
2. 动效：正常与 reduced-motion 两套，覆盖页面切换、设置分类、侧栏、菜单/弹窗、折叠、新消息首次出现；记录开始/中间/结束帧与最终焦点/草稿/锚点断言。
3. 打包：确认 `renderer.css/ui.css` 存在、离线无外部请求、真实 CSP 下无样式拒绝或脚本放行变化。

## 6. 复现验证

```powershell
npm run typecheck
npm run lint
npm run i18n:check
npm run layers:check
npm run cycles:check
npm run format:check
npm run docs:check
npm run references:check
npm run test:isolation:check
npm run build
node scripts/run-tests.mjs tests/desktop-react-stream.test.ts tests/desktop-react-transcript.test.ts tests/scroll-anchor.test.ts tests/turn-changes-model.test.ts tests/subagent-model.test.ts tests/question-model.test.ts tests/approval-model.test.ts tests/task-view.test.ts tests/plan-contract.test.ts tests/session-panels-model.test.ts tests/background-model.test.ts tests/statistics-model.test.ts tests/workspace-panel-loading.test.ts tests/desktop-react-attachments.test.ts tests/desktop-react-sessions.test.ts tests/desktop-react-composer.test.ts tests/desktop-copy.test.ts tests/desktop-i18n.test.ts tests/ui-i18n-coverage.test.ts tests/compat-ids.test.ts tests/render-caches.test.ts tests/diff-view.test.ts tests/i18n-gate.test.ts tests/ui-copy-migration.test.ts
npm run smoke:desktop
```
