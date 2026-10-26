# Desktop React + TypeScript Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Use checkbox (`- [ ]`) syntax for tracking. 用户会把本文交给另一个 agent 执行；本文的编写不代表已经开始实现。

**Goal:** 将桌面客户端的原生 DOM 渲染层逐步迁移为 React + TypeScript，以 Mantine 统一页面布局和通用组件，以 Motion 补齐视图切换动画，保持现有功能、信息结构、持久化格式和 Electron/Host 行为一致。

**Architecture:** 保留 Electron/`DesktopBridge`/Carrier/esbuild，在 renderer 内建立按区订阅的外部状态层，以 Mantine AppShell 与通用组件替换手工 DOM 页面。整个迁移期共用一个 React 根和 MantineProvider，先用 portal 渐进替换独立区域，再完成应用外壳；控件使用 Mantine 内置过渡，页面切换使用 Motion，流式通道继续独立更新。

**Tech Stack:** React 19、React DOM 19、TypeScript、Mantine Core/Hooks、Motion（`motion/react`）、现有 esbuild、项目 CSS 与主题变量、Node test runner、Playwright/Electron。

**Spec:** 本文件的[迁移规格](#迁移规格)、[架构约定](#架构约定)（含 [§9](#9-i18n-文案迁移规范)–[§11](#11-smoke-迁移与兼容-id-规范) 的 i18n/CSS/smoke 规范）和[完整模块迁移表](#完整模块迁移表)共同构成实施规格，后续任务必须同时遵守。用户已选择 React + TypeScript，并明确要求按 Mantine + Motion 的建议补充布局、通用组件和切换动效；文件拆分、分阶段策略、静态 nonce 方案和任务粒度由本计划确定。

**状态与基线:** 2026-10-26 编写；同日 17:2x 完成 v2 修订前的技术核对。HEAD 为 `b87583a5f31e42e6649ba350d8269d9a6bc3c38f`，工作区存在其他任务的未提交修改（见[第 3 节](#3-接手前的-dirty-工作区)）。本文尚未执行任何产品代码迁移，也未运行迁移验收。

**核对结论（2026-10-26）:** 计划引用的依赖与 API 均存在且兼容——`react@19.3.1`、`@mantine/core@9.7.4`（peer `react ^19.2.0`，含 `getStyleNonce`/`forceColorScheme`/`cssVariablesResolver`/`env`）、`motion@14.6.0`（有 `./react` 导出）、`eslint-plugin-react-hooks@7.1.1`（peer 含 `eslint ^10.0.0`）、Electron `43.5.0`、Node `v24.19.0`；`npm run typecheck` 在 dirty 状态下通过。CSP 样式 nonce 机制已在 Electron 43.5.0 上实测通过（方法与结果见[架构约定 §8](#8-样式产物与-csp-接入)），实测夹具已删除，未改动仓库。

## 修订摘要（v2，相对 2026-10-26 v1）

1. **CSP nonce 改为“构建期静态 nonce”为主方案**，不再需要修改 `main.ts`、不拦截 `file:`；每次加载轮换 + 协议拦截降级为**可选强化**，且已如实记录实测结论。见[§8](#8-样式产物与-csp-接入)与 T3。
2. **结构由 11 个任务改为 8 个里程碑 / 26 个任务**，每个任务只覆盖一个页面、面板或子系统，并附定向测试子集、规模估算和“完成定义”。见[里程碑与工作量](#里程碑工作量与完成定义)。
3. **新增 i18n 文案键化任务**：现有“中文源码 + 全局 walker + 硬编码正则”不能进入 `ui/`（i18n gate 不豁免新目录），需要自动化迁移脚本与覆盖率断言。见[§9](#9-i18n-文案迁移规范)与 T2。
4. **新增旧 CSS 退役规范与任务**：六份旧 CSS 共 5,992 行按 `#id` 编写，必须给出删除口径与预算，而不是“逐步收缩”。见[§10](#10-旧-css-退役规范)与 T24。
5. **新增 smoke 迁移与兼容 id 规范**：15 个 smoke 套件中有约 1,068 处 `#id` 选择器；过渡期用登记表保留必要 id，先建 React 断言再删旧断言，完成时清零。见[§11](#11-smoke-迁移与兼容-id-规范)与 T4。
6. **补齐 dirty 清单**：核对时实际 18 个已修改文件，v1 漏了 `packages/core/run-tools.ts`、`tests/task-resume.test.ts`；修订期间工作区仍在变化，因此开工前置条件明确为“并行修改必须已提交”，M0 必须现场重新生成清单。
7. **补齐验收口径**：新增 i18n 覆盖率、CSS 删除行数、bundle/内存对比方法、CI 可运行范围、`desktop-ui` 串行测试规模上限。见[验收矩阵](#验收矩阵)与 T26。
8. **技术细节补强**：Mantine 会经 `InlineStyles`（Box 嵌套 styles）与 React 19 `<style href precedence>` 注入样式，必须各有 CSP 用例；`@mantine/core` 静态 `styles.css` 不含主题 CSS 变量，`withCssVariables:false` 不是免费捷径；`scripts/check-layers.mjs` 目前**没有**对应测试，需新建。见 T1、T3、T6。

## Global Constraints

- 只迁移桌面视图和必要的构建、检查、测试支持；不改 Agent/Carrier 的业务语义、模型请求、沙箱权限或数据库格式。
- 保留 Node `>=24.0.0`、现有 Electron 版本、`strict`、`noUncheckedIndexedAccess`、`verbatimModuleSyntax` 和 `erasableSyntaxOnly`，不为迁移降低检查强度。TypeScript 已经是 strict 的，本计划实质是 **DOM 渲染层 → React** 的重写，不是“补类型”。
- 保留 `nodeIntegration: false`、`contextIsolation: true`、`sandbox: true` 和当前 CSP 的其他限制。样式 nonce 默认采用**构建期固定值**（`style-src 'self' data: 'nonce-…'`），禁止使用 `unsafe-inline`、`unsafe-eval`、`bypassCSP` 或关闭 webSecurity；每次加载轮换只在[§8](#8-样式产物与-csp-接入)约定的条件下实施。React 组件只经 `window.yuantu` 访问桌面能力。
- renderer 继续输出 `dist/desktop/renderer.js`，不新增运行时开发服务器，不改安装包加载路径。
- 保留现有浅色、深色、跟随系统、字号、中文和英文；产品文案通过既有字典表达，模型输出与用户内容不翻译。新目录 `ui/` 不获得 renderer 的中文豁免。
- 保留流式文本 100ms 合并刷新、独立统计增量、子 agent 增量，以及已有的历史分页和消息窗口边界；本轮不新增虚拟列表。
- 页面布局与通用控件统一采用 Mantine，页面切换采用 Motion；不再增加 Radix、Tailwind、shadcn/ui、Next.js、Vite、Redux 或新的测试框架。
- 保持现有信息结构与品牌主题，允许为统一组件与动效进行必要的样式调整；动画不延迟命令发送，不以动画结束决定业务状态，不为流式 token 播放逐字动画。
- 迁移期间同一 DOM 子树只能由一个渲染器拥有；全局翻译 walker 和 select upgrader 不得改写 React 所有的 DOM。过渡期若必须保留旧 `#id` 供 smoke 使用，只能经[§11](#11-smoke-迁移与兼容-id-规范)的登记表，且 React 仍是唯一 owner。
- Node 测试运行器只做类型剥离，不能加载 `.tsx`。凡被 Node 测试直接或间接 import 的 `.ts`（纯 model、controller、copy/format helper 及迁移期仍在的旧 renderer 模块）不得经由任何路径 import `.tsx`；只有 `renderer.ts` 与 `ui/**/*.tsx` 可以依赖 TSX。该规则由 T1 的分层 gate 强制。
- 真实 Electron 测试是串行资源（`@test-serial desktop-ui`），新增的 Electron 测试文件原则上不超过 4 个：`tests/desktop-react-csp.test.ts`、`tests/desktop-react.smoke.mjs`、`tests/desktop-react-motion.smoke.mjs`、`tests/desktop-react-transcript.smoke.mjs`。其余断言优先写成 Node 层纯 model/controller 测试；确需新增 Electron 文件时必须说明串行队列代价。
- 不创建或重置本机 Windows 沙箱账号；真实 Windows 账号验收沿用现有 CI 条件，跳过项必须如实报告。
- 执行前重新检查指令、分支和 dirty diff；保留其他任务的修改，不执行 `reset --hard`、`clean` 或整文件覆盖恢复。

## Review Focus

1. 冷启动订阅与初始快照、命令回复与推送交错：不丢状态，不用旧回复覆盖已收到的新状态；由 T5 的竞态测试覆盖。
2. 切换会话/工作区后附件读取、预览请求或发送失败才返回：不把旧结果、旧草稿或旧附件写入新会话；由 T15、T16、T17 覆盖。
3. 英文界面被旧 DOM walker 改写、portal 与页面主题不同步、动态样式被 CSP 拦截：由 T3、T6、T7 的翻译/主题/CSP 测试覆盖。
4. 流式输出期间加载旧消息、展开思考/工具组或选中文字：保持阅读锚点、展开状态和已有 DOM；由 T20、T21 覆盖。
5. StrictMode、快速切换页面、运行中减少动态效果与组件卸载：无重复操作、旧动画回调覆盖或遗留监听器；由 T5、T6、T9、T24 覆盖。
6. 文案键化后英文界面出现中文、key 缺失或占位符错位，或 walker 正则被删除后动态文案不再翻译：由 T2 的覆盖率测试和 `desktop-language.smoke.mjs` 覆盖。
7. 旧 CSS 与 AppShell 同时生效导致双外壳、双滚动条、重复 landmark 或 `!important` 竞赛：由 T8、T24 的布局断言与 CSS 预算覆盖。
8. 过渡期兼容 id 被两套渲染器同时渲染，或 React 卸载后 smoke 仍在读旧节点：由 T4 的登记表测试和逐区域 smoke 迁移覆盖。

## 迁移规格

### 1. 交付边界

迁移完成指：全部当前可用桌面页面和交互由 React 组织，旧 `renderer.ts` 不再编排整页 DOM，旧 `setup*` renderer 不再是活动 UI 的实现。仅建立 React 空壳、把原 renderer 放进一个 `useEffect`，或只迁移设置页，都属于中间阶段。

完成时还必须同时满足：

- `ui/**` 与 `index.html` 中不出现产品中文文案字面量（注释除外），文案全部经 `t()`/`format()`；
- 旧六份 CSS 收缩到[§10](#10-旧-css-退役规范)的预算内，应用外壳由唯一 AppShell 接管；
- [§11](#11-smoke-迁移与兼容-id-规范)的兼容 id 登记表为空，`rg` 搜索旧 `setup*`、`document.getElementById`、`replaceChildren`、`new MutationObserver` 的剩余引用逐项有归属；
- `npm run check` 与 `npm run smoke:desktop` 在实施环境通过，未验证项如实记录。

本轮保持功能、信息结构、区域职责和品牌主题一致，以 Mantine 统一布局实现、控件视觉与交互，并增加下文指定的过渡动画；不要求逐像素复刻手写控件，也不另行重做导航、增删设置或调整运行判定。沿用 `PRODUCT_SCOPE`：当前隐藏的 MCP 管理等功能不因迁移重新开放；其控件如仍保留在仓库，应以受开关控制的 React 实现保留，或明确列为后续工作，不得作为已完成项。

页面外壳采用 Mantine `AppShell`，区域排版采用 `Flex/Grid/Stack/Group`，通用控件采用 Mantine Core。通过项目包装层统一尺寸、主题、文案和行为接口；页面/面板切换使用 Motion，Modal/Drawer/Menu/Popover/Tooltip 等使用 Mantine 内置过渡。同一元素的同一动画属性只能有一个实现所有者。

允许保留明确封装的非 React DOM 岛：Markdown 渲染、代码高亮、diff 和已有第三方/纯 DOM 内容渲染器。每个岛由 React 拥有外层容器，内部节点归适配器所有，并提供更新和清理；这不等于允许遗留 renderer 继续接管整块页面。

### 2. 保持一致的业务行为

- 会话新建、切换、搜索、分页、重命名、归档、恢复、删除、分支及完整会话导出。
- 普通发送、运行中 follow-up 排队、停止、停止后继续、斜杠命令、模型和权限预设选择。
- 图片/文档选择、粘贴和拖放；计数与大小限制、能力校验、发送失败恢复，以及异步读取期间切换会话的保护。
- 普通回复、思考、工具调用/结果、进程组、文件改动、审批、问题卡、计划、待办、目标和交付文件。
- 自动验证 `verified` 无提示；其他状态保留现有单行展开与证据展示，环境限制不改写为代码失败。
- 子 agent 列表、运行状态、子会话历史页，以及父会话与子会话流式显示隔离。
- 模型设置、通用设置、权限/沙箱初始化与恢复、工作区维护、归档管理、后台任务与统计。
- 工作区树、文件预览、改动预览、刷新、打开/定位本地文件，以及返回失败后的重试。
- 原有备份、通知跳转、启动环境问题、Host 恢复提示和相关能力入口。
- 中英文切换、浅深色/跟随系统、13/14/16px 字号，以及 `--surface/--sidebar/…` 品牌 palette 的现有取值。

### 3. 接手前的 dirty 工作区

**2026-10-26 17:2x 复核的实际状态**（核对当时 18 个已修改文件，合计 492 insertions / 45 deletions，另有 2 个未跟踪的 plans 文档；同一小时内工作区仍在变化，见下方“清单会变”）：

```text
 M apps/desktop/i18n-conversation.ts
 M apps/desktop/index.html
 M apps/desktop/layout.css
 M apps/desktop/renderer-question-copy.ts
 M apps/desktop/renderer-questions.ts
 M apps/desktop/renderer.ts
 M apps/desktop/session-management.ts
 M packages/core/agent.ts
 M packages/core/run-snapshots.ts
 M packages/core/run-tools.ts
 M packages/core/runtime-context.ts
 M packages/protocol/context.ts
 M tests/desktop-copy.test.ts
 M tests/desktop-i18n.test.ts
 M tests/request-override.test.ts
 M tests/runtime-context.test.ts
 M tests/task-resume.test.ts
 M tests/workspace-maintenance.smoke.mjs
?? docs/superpowers/plans/2026-10-26-current-model-context.md
?? docs/superpowers/plans/2026-10-26-desktop-react-typescript-migration.md
```

v1 的清单漏了 `packages/core/run-tools.ts` 与 `tests/task-resume.test.ts`，本版已按 `git status --porcelain` 更正。执行时以实际状态为准，不要相信本文的清单。

**清单会变：** 本文修订期间（同一小时）工作区又出现了 `tests/desktop-language.smoke.mjs` 的修改与未跟踪的 `docs/2026-10-26-desktop-real-models-round4.md`，说明并行任务仍在推进。因此上面的清单只是核对当时的快照；开工时必须现场运行 `git status --porcelain` 重新生成，并逐个判断是否属于本计划，不得把“清单里没有”当作干净的依据。

**开工前置条件（M0 门）：**

1. 上述并行修改（当前模型/上下文展示、计划批准卡等）必须先由其所属任务单独提交或合并；本文件和其他 `docs/superpowers/plans/` 文档可以是未跟踪状态。
2. 若开工时仍有不属于本计划的 dirty 文件，实施 agent **停下并报告清单**，等用户决定；不得自行提交、stash、`reset --hard`、`clean` 或覆盖它们。
3. 在提交后的 HEAD 上重新运行 `npm run typecheck` 并记录退出码；基线失败时先报告，不进入 T1。
4. 特别阅读 `index.html`、`session-management.ts` 和 runtime-context 相关 diff，确保当前模型/上下文展示和内部上下文消息的隐藏规则一起迁移。并行任务还修改了计划批准卡：短提示与 Markdown 计划正文分离、隐藏 digest、保留小字号列表排版，以及选项/提交时保持卡内和会话滚动位置；T22 必须保留这些行为和新增断言。不要从 HEAD 复制旧版文件覆盖当前工作区。

## 里程碑、工作量与完成定义

### 1. 里程碑

| 里程碑 | 范围                               | 任务    | 退出条件（可安全停下的点）                                                                                                    | 单人估算\* |
| ------ | ---------------------------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------- | ---------- |
| M0     | 开工前置                           | —       | dirty 清零或已裁定；HEAD/分支/指令复核；基线 typecheck 记录；启动说明中的停止条件已确认                                       | 0.5 天     |
| M1     | 工具链、CSP、i18n、smoke 基建      | T1–T4   | `.tsx` 被类型/lint/分层/循环/i18n 覆盖；静态 nonce 在真实 Electron 生效；文案键化脚本可用；兼容 id 登记表落地；产品仍是旧界面 | 6–10 天    |
| M2     | runtime、provider、主题、布局外壳  | T5–T8   | 单一 runtime/provider/theme；DesktopShell 与 AppShell 夹具通过；旧界面仍可用                                                  | 7–10 天    |
| M3     | 动效                               | T9      | PageTransition/PanelTransition/reduce 全绿；设置分类过渡自 T10 起使用，整页外壳切换留到 T24                                   | 3–5 天     |
| M4     | 设置页                             | T10–T13 | 四个设置面板全部 React；对应旧 `setup*` 退役；语言/主题/字号/保存失败恢复保持                                                 | 10–15 天   |
| M5     | 会话、输入、附件、工作区、面板     | T14–T19 | 侧栏、输入区、附件、工作区、后台/统计/任务/会话辅助面板全部 React                                                             | 14–20 天   |
| M6     | 对话流                             | T20–T23 | 流式、transcript、滚动锚点、问题/审批、子 agent、本轮改动全部 React                                                           | 12–18 天   |
| M7     | 外壳接管、CSS 退役、清理与完整验收 | T24–T26 | 单一 React 根/AppShell；旧 setup 无活动引用；兼容 id 清零；完整验收记录                                                       | 8–12 天    |

\* 单人、熟悉仓库、含测试与返工的粗估，不含评审与 CI 排队；合计约 60–90 人日（≈3–4.5 人月）。**这不是承诺**：实际以每个任务完成时的记录为准，偏差超过 50% 时先停下重排而不是加班推进。

### 2. 规模基线（用于判断任务是否被拆得足够细）

| 区域                                         | 规模                                                                                                                                                                                               |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/desktop/renderer*.ts`                  | 34 个文件、10,128 行                                                                                                                                                                               |
| `apps/desktop/index.html`                    | 700 行（含大量静态 `#id` 结构与中文文案）                                                                                                                                                          |
| 六份旧 CSS                                   | 5,992 行                                                                                                                                                                                           |
| `apps/desktop` 全部 TS                       | 18,880 行（含 main/preload/contract，多数不改）                                                                                                                                                    |
| 15 个 desktop smoke 套件                     | 约 1,068 处 `#id`/选择器引用（粗略上界）                                                                                                                                                           |
| 直接 import/读取旧 renderer 模块的 Node 测试 | 约 10 个（`desktop-copy`、`general-settings-pending`、`plan-contract`、`sandbox-setup-renderer`、`session-projections`、`task-confirm-selection`、`tool-arguments`、`workspace-panel-loading` 等） |

### 3. 任务规则与完成定义（DoD）

每个任务必须满足以下全部条件才可勾选：

1. 先补行为断言并确认红灯，再实现，再验证；已有测试能表达需求时直接复用，不为简单样式包装增加镜像测试。
2. 任务只覆盖**一个页面、一个面板或一个子系统**。若预计改动 > 1,200 行、或跨两个以上页面，实施 agent 必须先拆成子任务并在交付记录中列出拆分，不得把多个区域压进一个任务。
3. 任务内定向命令退出 0；并运行 `npm run typecheck && npm run lint && npm run layers:check && npm run cycles:check && npm run i18n:check`。
4. 被替换区域的旧 `setup*` 已解除绑定（不保留第二套活动实现）；该区域的兼容 id 登记与 smoke 断言在同一提交内更新（§11）。
5. 该区域的文案已完成键化，`rg -c '[\u4e00-\u9fff]' apps/desktop/ui/<区域>` 只命中注释（§9）。
6. 不新增 `skip`、不删除断言、不重导出旧 UI 来过门禁；未完成项写入交付记录。
7. 任务结束后应用仍可构建、可启动；旧界面未迁移部分继续工作。

## 架构约定

### 1. 文件组织与所有权

沿用现有 renderer 入口文件名，避免不必要的包装和安装路径变化。以下路径是目标位置，按任务创建，不要先生成一批空文件。

```text
apps/desktop/
  renderer.ts                         # 只负责创建 runtime、挂载 React、退出时清理
  renderer-globals.d.ts                # Window.yuantu: DesktopBridge + nonce 常量声明（如需要）
  main-ui-document.ts                 # 可选：每次加载轮换 nonce 的文档适配（默认不启用，见 §8）
  ui/
    App.tsx                           # 最终的单根页面与面板组合
    providers.tsx                     # 唯一 MantineProvider、MotionConfig 和 runtime Context
    theme.ts                          # 项目 palette、字体/字号、默认组件 props 与主题映射
    nonce.ts                          # style nonce 常量与读取/校验辅助（§8）
    styles.css                        # 项目 UI 样式；构建复制为 dist/desktop/ui.css
    motion-tokens.ts                  # 统一时长、easing、位移及 reduced-motion 配置
    transitions.tsx                   # PageTransition、PanelTransition 与页面切换处理
    layout/DesktopShell.tsx            # Mantine AppShell；页面区与输入区的稳定边界
    context.tsx                       # 稳定的 runtime Context + hooks
    runtime.ts                        # 唯一的 bridge 订阅所有者和生命周期
    stores.ts                         # ReadableStore、快照按区分发
    actions.ts                        # 命令发送与现有错误/忙碌控制
    ui-state.ts                       # 页面、草稿、pending、展开状态
    i18n.ts                           # React locale 订阅；继续调用已有 t/format
    ErrorBoundary.tsx
    primitives.tsx                    # Mantine Core 的项目包装层
    legacy/
      mount-region.tsx                # 迁移期区域挂载/事件适配
      compat-ids.ts                   # 过渡期兼容 id 登记表（§11）
    settings/                         # SettingsPage、GeneralSettings、ModelSettings 等
    sessions/                         # SessionSidebar、SessionRow、ArchivedSessions
    composer/                         # Composer、Attachments、CommandPalette
    workspace/                        # WorkspacePanel、FileTree、FilePreview
    panels/                           # Tasks、Background、Statistics、Todos、Goal 等
    conversation/
      Conversation.tsx                # 滚动容器、历史分页和父/子会话页面
      Transcript.tsx                  # 按稳定 identity 渲染历史消息和进程组
      Message.tsx                     # 消息壳、操作区、时间和内容适配
      LiveMessage.tsx                 # 只订阅当前流式显示值
      MarkdownView.tsx                # 现有 Markdown DOM 岛
      stream-store.ts                 # delta 缓冲与 100ms 显示快照
      transcript-model.ts             # 分组、身份和可见性投影，纯 TS
      scroll-anchor.ts                # 阅读锚点/尾部跟随，DOM 与 React 提交分离
      Approvals.tsx
      Questions.tsx
      Subagents.tsx
    slots.tsx                         # React SlotRegistry 与 SlotOutlet
scripts/
  migrate-ui-copy.mjs                 # 文案字面量 → 字典 key 的可重入迁移脚本（§9）
```

`App.tsx` 不接收每个 token 都变化的巨大 state props；Context 只传稳定 runtime 实例。各区域通过 hook 订阅所需切片。本地输入/展开等状态留在最近的 owner，跨页面且需要保持的草稿由 `ui-state.ts` 按会话标识管理。

### 2. 外部状态接口

在 `ui/stores.ts`、`ui/runtime.ts` 定义以下稳定接缝，消费者不直接注册 `window.yuantu.subscribe*`：

```ts
type Dispose = () => void;
type SnapshotListener = (
  state: CarrierSnapshot,
  changed: readonly (keyof CarrierSnapshot)[],
) => void;

interface ReadableStore<T> {
  getSnapshot(): T;
  subscribe(listener: () => void): Dispose;
}

interface DesktopRuntime {
  getSnapshot(): CarrierSnapshot | null;
  section<K extends keyof CarrierSnapshot>(key: K): ReadableStore<CarrierSnapshot[K] | undefined>;
  onSnapshot(listener: SnapshotListener): Dispose;
  start(): Promise<void>;
  dispose(): void;
}

function createDesktopRuntime(bridge: DesktopBridge): DesktopRuntime;
function useReadable<T>(store: ReadableStore<T>): T;
function useSection<K extends keyof CarrierSnapshot>(key: K): CarrierSnapshot[K] | undefined;
```

具体要求：

1. `section(key)` 返回同一个 store；未变更时 `getSnapshot()` 返回同一个值/引用，不在 getter 中创建对象或数组。`useReadable` 用 `useSyncExternalStore`，订阅函数保持稳定。
2. `changed` 指明只替换哪些区；其余切片保留旧引用。兼容没有 `changed` 或空列表的旧测试 bridge，按全量快照处理；缺失的可选区要能清除，不能留下旧值。
3. preload 的 `SnapshotMirror` 负责 IPC patch 合并和版本判断，React 层不再实现一份版本协议，也不修改其持有的可变对象。**注意：`SnapshotMirror.apply` 原地复用同一个 state 对象**（`snapshot-patch.ts`），所以 runtime 必须在通知时把切片投影成新的 UI 快照/稳定切片引用，直接透传 `state` 给 `useSyncExternalStore` 不会触发渲染。
4. 先建立订阅，再请求初始 `{ type: 'snapshot' }`。若已有推送建立状态，迟到的初始化回复不能倒退状态；初始请求拒绝/失败时可展示错误并重试。
5. `start()` 同时/重复调用只建立一组订阅；`dispose()` 幂等，清理频道、locale、定时器和 observer，拒绝接收其后的异步结果。runtime 在 React 树外启动与销毁，StrictMode 重挂载不重建全局 IPC 连接。
6. 命令回复不是任意覆盖 store 的第二来源。照现有 `invoke/select` 行为处理；需要立即读取的返回值可返回给动作调用者，正式状态跟随推送，初始化只在尚无状态时填充。
7. `onSnapshot` 是旧 renderer 迁移适配器的接缝，等价区全部迁移后删除，最终视图统一用切片订阅。过渡期 raw delta 的转发同样只能由频道的唯一 owner 分发。

流式 store 和统计 store 在 T20 建立；它们属于同一个 runtime 的资源，不能让每个消息组件各自订阅 IPC。`ui/actions.ts` 的动作入口固定为：

```ts
function invoke(command: CarrierCommand): Promise<CarrierSnapshot | null>;
function select(command: CarrierCommand): Promise<CarrierSnapshot | null>;
```

它们是 runtime/action 对象的方法，不是跨窗口模块单例；依赖通过创建函数注入。业务错误、网络异常、loading、operation 和 sending 状态的含义沿用现有代码。

### 3. 流式与历史消息

- 按 `messageId` 缓冲 text/reasoning 两个频道，遵守 delta 的 reset 语义。delta 可以早于声明 liveMessage 的 snapshot 到达，必须先暂存；消息结束、会话切换或 ID 改变后不能重现旧缓冲。
- store 内部累积每个 delta，但最多每 100ms 发布一次 UI 显示快照；结束/重置时立即收敛至最终快照，取消遗留定时器。
- 沿用 `markdownBlocks` 的已完成块复用和末尾块增量处理；保留当前 120,000 字符 live 尾部显示限制，不对整段文本每 token 重新解析。
- `StatisticsDelta` 只更新匹配会话的统计与状态显示；`SubAgentDelta` 只更新对应子 agent。二者都不触发历史消息列表重建。
- 历史消息投影按 `sessionId`、`messageRevision`、`historyStart`、语言和实际会影响展示的结束/改动状态失效，不以所有 session 对象变化作为重建条件。
- 有稳定消息 ID 时使用它；没有时用 `sessionId + (historyStart + 当前下标)`，并保留进程组身份。不能使用可见数组下标、文本内容、随机数或当前时间作 key。
- 加载更早历史前记录首个可见消息/工具组子项及相对顶部位置，提交后在 `useLayoutEffect` 恢复。只有用户原本接近底部、正在跟随父会话且没有 loadOlder 时才自动跟随尾部；沿用当前 90px 判定。

### 4. React 与旧 DOM 的隔离

- 迁移期每个 React 岛在已有区域内独占一个容器，先停止对应 `setup*` 再挂载。所有区域通过 `createPortal` 接到同一个 React 根和同一个 MantineProvider；不为每个岛各建一套 provider。最终移除区域适配器，保留同一个 `<div id="desktop-root">`。
- 初期 React 容器和 portal 目标标记 `data-react-owned`。修改既有翻译 walker，跳过该区域的文本与属性；React 使用 `t/format + useLocale` 自行渲染翻译，不依赖观察 DOM 后再翻译。
- `setupSelectMenus()` 的全局观察器跳过 `[data-react-owned]` 内的 select；React Select 不再让 upgrader 包裹/移动节点。最后移除应用入口中的全局 upgrader。
- `MarkdownView`、diff 等适配器只能更改自己 ref 容器的内部；React 不在同一容器内再声明子节点。回调更新、事件解绑与卸载都由适配器负责。
- 过渡期 `desktop-root` 不参与旧 body grid 的区域排版；最终由 `DesktopShell` 的 AppShell 接管全窗口外壳，并移除旧 body grid 对新应用的约束。检查 root 高度、`min-height: 0`、overflow 和唯一主滚动区域，不能叠加两套外壳导致双侧栏或双滚动条。
- portal 统一进入应用控制的专用容器，并纳入主题/React 标记；现有按 `#chat-page` 限定的弹层样式须同步核对，不能仅复用 class 就假设样式生效。
- 过渡期需要的旧 `#id` 只能来自[§11](#11-smoke-迁移与兼容-id-规范)的登记表；React 组件通过 `compatId()` 渲染，旧区域继续使用原 id，两处不得同时渲染同一 id。

### 5. Slot 接口

保留 `composer.above`、`message.actions`、`message.footer`、`sidebar.right`、`tool.result.extra` 五个位置及现有 context 类型。`ui/slots.tsx` 用 React 视图贡献替代 `(frame, context) => void`：

```ts
interface ReactSlotContribution<Context> {
  readonly id: string;
  readonly order?: number;
  readonly render: (context: Context) => ReactNode;
}
```

`register(slot, contribution)` 仍返回幂等 disposer；按 order 排序，同序保持注册顺序。`SlotOutlet` 以 contribution.id 保持组件身份，动态增删可见且不重复挂载。注册表必须能订阅变化，不能只在第一次渲染读取。旧 `slots.ts` 及旧测试在转换完成前保留，转换后用同等契约测试替换，不把扩展位直接改成硬编码组件列表。

### 6. 页面布局、通用组件和主题

| 作用         | 统一选型                                           | 实现约定                                                                                    |
| ------------ | -------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| 应用外壳     | `AppShell`                                         | `Navbar` 对应会话/设置导航，`Main` 对应当前页面，`Aside` 对应已有工作区区域；按现有条件显隐 |
| 区域排版     | `Flex/Grid/Stack/Group`                            | 负责表单、卡片和工具栏；长消息、文件树与 diff 保留适合内容的专用布局                        |
| 按钮与输入   | `Button/ActionIcon/TextInput/Textarea/NumberInput` | 使用统一默认尺寸、圆角、disabled/loading 状态；输入法事件保持现有语义                       |
| 选择控件     | `Select/Combobox/Checkbox/Switch`                  | 简单选择用 Select；需自定义行或额外操作的模型/权限菜单用 Combobox，不用假选项冒充菜单命令   |
| 导航与菜单   | `Tabs/Menu/Popover/Tooltip`                        | 统一选中态、焦点、键盘与关闭行为；已有导航不因 Tabs 组件而增加 URL router                   |
| 对话框与抽屉 | `Modal/Drawer`                                     | 项目包装层可继续导出 `Dialog` 语义；统一焦点陷阱、Esc、关闭后焦点返回及 busy 时关闭规则     |
| 折叠与反馈   | `Collapse/Alert/Loader/Skeleton`                   | 问题/审批/错误仍用既有文案；Collapse 负责高度动画，业务内容由各自 model 决定                |
| 复杂业务视图 | 项目 React 组件                                    | 对话、工具卡片、问题卡、审批和任务记录不能简单套用通用聊天模板替换既有语义                  |

`DesktopShell` 只建立一个 AppShell：聊天输入区属于 Main 内部，不改成覆盖整个窗口的 Footer；设置页替换导航/主区内容，不嵌套第二个全窗口 AppShell。侧栏宽度、最小窗口和断点以当前布局为基准，不新增移动端导航或可拖拽分栏的业务能力。Electron 原有窗口标题栏、拖动区域与窗口控制行为保持。

`providers.tsx` 内建立唯一 MantineProvider 和 MotionConfig。迁移期 `RegionHost` 用同一 provider 下的 portal 注册各区域；区域卸载只注销该 portal，整个窗口退出才 unmount root。`theme.ts` 定义 `desktopTheme`、`desktopCssVariablesResolver` 和以下纯映射：

```ts
function resolveColorScheme(
  appearance: UiSettings['appearance'],
  systemDark: boolean,
): 'light' | 'dark';
```

主题数据继续来自现有 `uiSettings`，不使用 Mantine 默认 localStorage 再存一份：

- 把 `system` 映射到当前 `matchMedia('(prefers-color-scheme: dark)')` 的结果，以 `forceColorScheme` 驱动 provider；监听系统变化，并同步旧 `data-theme` 与新的 `data-mantine-color-scheme`。用户明确选 light/dark 时不随系统变化。
- 通用设置、provider 和 DOM 岛使用同一份 UI 设置状态；初始读取只做一次，设置失败恢复仍走现有保存 controller，不因 provider 和页面各自初始化产生重复请求或落盘。
- 既有 `--surface/--sidebar/--raised/--hover/--line/--ink/--muted/--accent` 是项目 palette 来源；Mantine resolver 引用它们并覆盖适用组件，不在两套变量间循环引用。保留品牌图、现有字体与 small/medium/large 的 13/14/16px 基准。
- provider 设置 `forceColorScheme` 与统一 theme，portal 同样使用这一 context；不引入面向 SSR 的内联 `ColorSchemeScript`。启动时读取设置失败采用既有默认值并呈现错误，不能白屏等待。
- 旧 CSS 中全局 `button/input/select/header/aside` 和高特异性 ID 规则逐步缩到遗留区域或改为组件 `classNames`/Styles API；禁止靠不断增加 `!important` 覆盖 Mantine（T24 用脚本统计净增）。
- **`withCssVariables: false` 不是免费捷径**：`@mantine/core` 的静态 `styles.css` 只含组件样式与少量回退值，主题 CSS 变量（含 dark scheme）由 provider 在运行时生成。若要关闭运行时注入，必须自己生成完整的变量表；本计划不采用这条路线，除非有人单独评估并记录。
- 不在 `ui/` 中使用会触发 Mantine `InlineStyles`（`Box` 的嵌套 styles/at-rules）的写法；如确需使用，必须先有 T3 的 CSP 用例覆盖。

### 7. 动效规范与状态保持

`motion-tokens.ts` 集中定义以下毫秒值；CSS/Mantine 使用毫秒，Motion 使用秒，由包装层统一换算。共享 easing 为 `[0.2, 0, 0, 1]`，位移上限为 4px、缩放起点为 0.98。首次应用启动不播放整页入场，保持可输入时间。

| 场景                         | 所有者                               | 标准参数与效果                                                                     |
| ---------------------------- | ------------------------------------ | ---------------------------------------------------------------------------------- |
| 聊天页 ↔ 设置页              | `PageTransition` / Motion            | 总时长 180ms：旧内容退出 60ms、新内容淡入并从 y=4px 回到 0 用 120ms                |
| 设置分类切换                 | `PageTransition` / Motion            | 总时长 150ms：退出 50ms、进入 100ms；选中标记移动同为 150ms                        |
| 已有侧栏显隐                 | AppShell 内置 transition             | 200ms；只由 AppShell 控制该区域的布局偏移与过渡，不再叠加 Motion layout            |
| 下拉、菜单、Popover、Tooltip | Mantine transition                   | 进入 140ms、退出 120ms，fade 或轻微 scale；不重复包 AnimatePresence                |
| Modal、Drawer                | Mantine transition                   | 进入 160ms、退出 120ms，遮罩/内容协调过渡；保持原 Esc/busy 规则                    |
| 思考、工具详情、验证证据展开 | `PanelTransition` / Mantine Collapse | 180ms 高度与必要的透明度过渡，保留内容身份和展开状态                               |
| Button/ActionIcon 悬停与按下 | CSS                                  | 100ms 颜色/背景变化，不缩放整块布局                                                |
| 新消息容器首次出现           | 消息壳 / Motion                      | 120ms 淡入；已显示的 liveMessage 转历史时不重新播放                                |
| 会话之间切换                 | 内容层的轻淡入                       | 120ms，仅新内容出现；滚动容器和输入区保持，不做整个 transcript 的 exit/layout 动画 |

`transitions.tsx` 的项目接口固定为：

```ts
interface PageTransitionProps {
  viewKey: string;
  kind: 'page' | 'settings';
  children: ReactNode;
}
interface PanelTransitionProps {
  opened: boolean;
  children: ReactNode;
}
```

由 `PageTransition` 统一处理 AnimatePresence 退出/进入，页面调用方不自行写各套时长；`PanelTransition` 包装 Collapse。统一约束如下：

1. 导航状态、命令发送和 busy 变化立即执行；只让画面过渡，不在 `setTimeout(duration)` 或动画完成回调中才执行 send/load/create/save。快速 A→B→C 时以最新目标 C 为准，不能排队播放旧目标或在旧回调中恢复焦点/状态。
2. 页面过渡期间退出内容立即不可交互、不可聚焦并从可访问树隐藏；顺序退出/进入避免两个设置面板同时可见。全局导航和 runtime 保持挂载；进入页面挂载时就可交互，不等其淡入结束。
3. 设置草稿、会话输入和附件来源状态由已有 controller/store 保持；跨页面保存/恢复聊天锚点。动画 wrapper 的 key 只取页面/面板身份，不能包含 token、messageRevision、统计或语言，以免数据更新重启动画。
4. 流式正文只走 100ms 的增量通道，不播放逐字动画；不对整个 Transcript/Markdown 子树开启 `layout`，不为每个快照重新播放消息入场。不对聊天滚动容器或含固定定位/portal 的外壳施加页面位移。
5. 面板高度动画只在用户显式展开/关闭时执行；新 delta 导致高度增长不反复启动 Collapse。长工具输出使用既有内部滚动，保留选区、焦点与锚点。
6. MotionConfig 设置 `reducedMotion="user"`，并用 `useReducedMotion` 将项目动画及 Mantine `transitionProps`/AppShell/Collapse 时长统一设为 0；CSS 的 `prefers-reduced-motion` 规则同步覆盖。不能只设置 MotionConfig 就以为所有透明度和 CSS/Mantine 动画已关闭。运行中修改系统偏好须立即收敛到最终状态。
7. 主题/语言切换不播放整页退场；文本/颜色即时同步且不重挂页面。组件自带过渡与 Motion 在同一属性上只能选一个，避免双倍延迟。

### 8. 样式产物与 CSP 接入

**静态样式：** renderer 只引入一次 `@mantine/core/styles.css`，由现有 esbuild 输出同目录 `renderer.css`。`ui/styles.css` 是无须 PostCSS 的普通项目 CSS，由构建复制为 `dist/desktop/ui.css`。HTML 顺序固定为 `renderer.css` → 现有六份 CSS → `ui.css`；后续按功能迁移收缩旧样式，不重复引入 styles.css/styles.layer.css。打包配置 `files: ['dist/desktop/**/*']` 已覆盖新 CSS，执行时复核即可；运行时不加载 CDN 或外部字体。

**动态样式（主方案：构建期固定 nonce，不修改 `main.ts`）**

当前 `index.html` 的 CSP 为 `style-src 'self' data:`，会阻止未授权的内联 `<style>`；Mantine 在运行时注入 CSS 变量（`MantineCssVariables`）、global classes（`MantineClasses`）和 `Box` 嵌套样式（`InlineStyles`），必须被授权。

1. `index.html` 的 CSP 改为 `style-src 'self' data: 'nonce-<UI_STYLE_NONCE>'`，并加入 `<meta name="yuantu-style-nonce" content="<UI_STYLE_NONCE>" />`；其他 CSP 指令保持原值，不加到 `script-src`，不引入内联启动脚本。
2. `ui/nonce.ts` 导出唯一常量 `UI_STYLE_NONCE`；provider 的 `getStyleNonce` 返回它。HTML 中的两处写出与常量的一致性由测试锁定（`index.html` 是静态文件，无法直接 import 常量），三者任一不一致即失败。
3. 该方案不改变页面路径、origin、preload、`DesktopBridge` 或文档加载方式：`window.loadFile(pagePath)` 保持原样，主进程除本节外零改动。
4. **威胁模型必须写进 `ui/nonce.ts` 的注释：** 静态 nonce 防的是“无脚本的 HTML/CSS 注入”，页面脚本本来就能读取 meta；本文档是安装包内可信文件，渲染层不把不可信 HTML 交给 `dangerouslySetInnerHTML`（Markdown 保持现有安全处理）。一旦引入任何“不可信 HTML 可进入文档”的路径，必须切到下面的轮换方案，而不是放宽 CSP。
5. **可选强化：每次加载轮换 nonce。** 只有在安全评审要求、或第 4 条前提被打破时实施。实现沿用 `main-ui-document.ts`：在 app 使用的 Session 的 `file` protocol handler 中只对规范化后精确匹配可信 `pagePath` 的 HTML 请求生成响应，其余请求经同 Session 的 `session.fetch(request, { bypassCustomProtocolHandlers: true })` 委托；每次加载用 `randomBytes(16).toString('base64')` 生成新 nonce，替换模板占位符并写入 meta，文档响应禁用缓存；`renderUiDocument(template, nonce)` 为纯函数，占位符缺失/多余、无效 nonce、非目标路径必须明确失败或交回原处理。该路径 2026-10-26 已在 Electron 43.5.0 上实测通过（`session.protocol.handle('file')` 被接受；`loadURL` 与 `loadFile` 均被拦截；两次加载得到两个不同 nonce；带 nonce 的 `<style>` 生效、无 nonce 的 `<style>` 与 inline script 被拒；同目录 CSS/JS 经委托正常加载；无 `did-fail-load`）。实施时仍需按本计划补齐纯函数测试与真实 Electron 用例，不能以旧夹具代替。
6. **nonce 的覆盖范围：** nonce 只授权 `<style>` 元素，不授权 HTML 解析出的或经 `setAttribute('style', …)` 写入的 style 属性；React `style` prop、Motion 与 Floating UI 通过 CSSOM 写样式，不受 `style-src` 限制（实测 `getComputedStyle` 正常且无 violation）。必须覆盖的组件用例：AppShell 响应式样式、provider 变量、Grid/Stack 布局、Popover/Combobox 定位、`InlineStyles`（Box 嵌套 styles）、以及开启 `deduplicateInlineStyles` 时 React 19 的 `<style href precedence>` 提升。发现依赖 `setAttribute('style')` 的组件或代码时改用 CSSOM/class，不能为此放宽 CSP。
7. **测试要求：** 真实 Electron 下断言授权样式生效、未授权 `<style>` 与 inline script 仍被拒、`index.html` 的 CSP/meta/常量三者一致、`securitypolicyviolation` 只出现在测试主动触发的用例；夹具使用与产品一致的 CSP，不得沿用“剥掉 CSP meta 再注入 bundle”的旧做法来证明通过。

### 9. i18n 文案迁移规范

现状是“中文源码 + 全局 DOM walker + 硬编码正则 + 少量模块内联 pair”：`i18n.ts` 的 walker 用 `domText` 把渲染后的中文反查成英文，并对动态文案使用 8 条硬编码正则。i18n gate 只豁免 `renderer*.ts`/`i18n*.ts`/`session-management.ts`/`attachment-contract.ts`，**新目录 `ui/` 不在豁免内**。因此：

1. `ui/**` 与 `index.html` 中所有产品文案必须经 `t(key)`/`format(template, values)`；字面量只允许出现在注释和 `data-i18n-skip` 明确标记的测试夹具中。
2. 用 `scripts/migrate-ui-copy.mjs` 做机械迁移：解析 TS/TSX 的字符串与模板字面量，按 `messages` 的 zh→key 反查表替换为 `t('key')`；模板字面量中的 `${x}` 转为 `{x}` 占位符并生成 `values`；默认 dry-run，`--write` 才落盘；冲突（同一中文对应多个 key）与未命中必须写入报告并人工决定，脚本不猜测；转换后统一 prettier。
3. 反查表与 walker 的 `domText` 同源（都从 `messages` 生成），避免两份真相。冲突时优先 `ui.*` 命名空间，并把选择记录在报告里。
4. `i18n.ts` 的 8 条硬编码正则必须逐条替换为显式模板 + `format()`；替换后加断言：这些动态文案在 en-US 下不再依赖正则。walker 继续服务未迁移的旧 DOM，但必须跳过 `[data-react-owned]`。
5. 覆盖率断言：`tests/ui-i18n-coverage.test.ts` 提取 `ui/**` 中的 `t('…')` key，断言全部存在于字典；断言 `ui/**` 无中文字面量；`desktop-language.smoke.mjs` 继续作为“英文界面无中文”的端到端证据。
6. 模型输出、用户内容、文件名、代码片段不翻译；`data-i18n-skip` 只允许用于测试夹具，不允许在产品界面使用。

### 10. 旧 CSS 退役规范

六份旧 CSS 共 5,992 行，绝大多数按 `#id` 与高特异性选择器编写。退役不是“顺手删”，必须按区域记账：

1. 先做清单：对每个 `#id`/选择器标注归属——(a) 已迁移区域的布局/控件样式：迁到 Mantine `classNames`/`styles` 或 `ui/styles.css` 后删除；(b) DOM 岛（Markdown、diff、代码高亮、长消息、文件树）：保留，移入 `ui/styles.css` 或保留原名但只留岛内选择器；(c) 品牌/基础 token/滚动条：保留在 `ui/styles.css`；(d) 无引用：删除。
2. 预算：完成时六份旧 CSS 合计 ≤ 1,200 行，且不含任何已迁移区域的 `#id` 规则；每份文件的删减行数记录在交付文档。
3. 禁止 `!important` 净增：T24 用脚本统计 `rg -c '!important' apps/desktop/*.css` 并与 M0 基线比较，增加必须逐条说明理由。
4. 每次区域迁移必须同时删除该区域的旧 `#id` 规则，不得“先留着以防万一”；需要过渡的只能走 §11 的 id 登记表（id 与样式是两件事，样式规则不得为兼容 id 保留）。
5. 验收：不得同时存在两套外壳（旧 body grid + AppShell）；每个面板只有一个主滚动容器；HTML 只有一个 `main` landmark；侧栏宽度、最小窗口尺寸和 13/14/16px 字号与迁移前一致。

### 11. Smoke 迁移与兼容 id 规范

15 个 smoke 套件里约 1,068 处 `#id`/选择器引用，其中不少是行为断言（例如 `#permission-mode.value`）。迁移规则：

1. 新增/替换断言优先用 role/label（`getByRole`、`getByLabel`）和可见文本，不再新增 `#id` 选择器；Mantine Combobox 用 `getByRole('option')`/可见选值断言，不用 `.value`。
2. 过渡期确需保留的旧 id 必须登记在 `ui/legacy/compat-ids.ts`：

   ```ts
   interface CompatId {
     readonly id: string;
     readonly region: string; // 迁移任务编号/区域名
     readonly reason: string; // 哪个 smoke/哪条断言还在读它
     readonly removal: string; // 什么条件下删除
   }
   ```

3. React 组件用 `compatId('session-search')` 渲染该 id；旧 DOM 区域的同一 id 在 React 接管时由旧 setup 停止渲染。`tests/compat-ids.test.ts` 断言：id 全局唯一、region 已标记迁移时不得由 legacy 渲染、登记项数与 smoke 引用一致、M7 时表为空。
4. 每个区域任务的顺序固定：**先为 React 版新增 role/label 断言并通过 → 再删旧 `#id` 断言 → 同一提交删除登记项**。不允许先删断言再“补偿性”加弱断言，也不允许把断言改成只验证不抛错。
5. `desktop-smoke-support.mjs` 的共享 helper（如 `choosePermissionPreset`）在 T4 先改成操作真实 combobox 并断言最终可见值，后续区域直接复用。
6. 完成条件：`rg '#[a-z][a-z0-9-]+' tests` 的命中全部指向未迁移区域或 DOM 岛；M7 时兼容 id 表为空。

## 完整模块迁移表

下表是功能所有权与任务归属清单；功能可以拆成小文件，但不能因合并行而漏掉模块。

新增公共层的所有权固定为：`ui/providers.tsx` 管唯一 provider，`ui/theme.ts` 管主题，`ui/nonce.ts` 管样式 nonce，`ui/layout/DesktopShell.tsx` 管布局，`ui/motion-tokens.ts`/`ui/transitions.tsx` 管动效，`ui/legacy/compat-ids.ts` 管过渡 id，`scripts/migrate-ui-copy.mjs` 管文案键化。业务组件不再复制这些规则。

| 现有文件（均在 `apps/desktop/`）                                                                                       | 目标所有者                                                                                 | 要保留的职责                                                   | 任务      |
| ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | -------------------------------------------------------------- | --------- |
| `renderer.ts`                                                                                                          | `renderer.ts`、`ui/App.tsx`、runtime/actions                                               | 启动、错误、busy、页面组合、全局事件与退出清理                 | T5/T6/T24 |
| `renderer-panels.ts`、`renderer-general-settings.ts`                                                                   | `ui/settings/SettingsPage.tsx`、`GeneralSettings.tsx`                                      | 单面板路由、语言/主题/字号/通知、串行保存与失败恢复            | T10       |
| `renderer-settings.ts`                                                                                                 | `ui/settings/ModelSettings.tsx`、`model-settings-model.ts`                                 | 模型分组、连接、环境模型标签、切换锁定、加密能力提示           | T11       |
| `renderer-permissions.ts`、`renderer-sandbox-setup.ts`                                                                 | `ui/settings/PermissionSettings.tsx`、`SandboxSetup.tsx`                                   | 权限预设、初始化、恢复和 ready/busy 边界                       | T12       |
| `renderer-mcp.ts`                                                                                                      | `ui/settings/McpSettings.tsx`                                                              | 受 `PRODUCT_SCOPE.mcpManagement` 控制的管理入口                | T13       |
| `renderer-workspace-maintenance.ts`、`renderer-archived-sessions.ts`                                                   | `ui/settings/WorkspaceMaintenance.tsx`、`ui/sessions/ArchivedSessions.tsx`                 | 维护、归档、恢复、分页和错误                                   | T13       |
| `renderer-session-list.ts`、`session-management.ts`                                                                    | `ui/sessions/SessionSidebar.tsx`、`SessionRow.tsx`、`session-actions.ts`                   | 会话活动标记、菜单、搜索、删除/分支、通知切换、上下文展示      | T14       |
| `renderer-composer.ts`                                                                                                 | `ui/composer/Composer.tsx`、`composer-model.ts`                                            | 发送/排队/停止、输入法、焦点、失败恢复和 busy                  | T15       |
| `renderer-attachments.ts`、`renderer-attachment-copy.ts`                                                               | `ui/composer/Attachments.tsx`、`attachment-model.ts`                                       | 文件读取、校验、预览、图片/文档拼接；copy helper 可直接保留    | T16       |
| `renderer-commands.ts`                                                                                                 | `ui/composer/CommandPalette.tsx`、`command-model.ts`                                       | 菜单与 slash 共用词汇、过滤、选中、导出命令                    | T15       |
| `renderer-workspace.ts`                                                                                                | `ui/workspace/WorkspacePanel.tsx`、`FileTree.tsx`、`FilePreview.tsx`、`workspace-model.ts` | 树与预览、异步竞态、刷新与改动预览                             | T17       |
| `renderer-background.ts`、`renderer-statistics.ts`                                                                     | `ui/panels/BackgroundPanel.tsx`、`Statistics.tsx`                                          | 后台进程、独立统计频道、TPS 阈值和上下文提示                   | T18       |
| `renderer-tasks.ts`、`renderer-tasks-editors.ts`、`renderer-tasks-format.ts`                                           | `ui/panels/TasksPanel.tsx`、`TaskEditor.tsx`、`task-model.ts`                              | 定时/触发任务、确认草稿、验收证据和执行记录                    | T19       |
| `renderer-session-panels.ts`、`renderer-plan.ts`                                                                       | `ui/panels/SessionPanels.tsx`、`PlanPanel.tsx`                                             | 待办、目标、计划、交付文件、问题跳转                           | T19       |
| `renderer-changes.ts`                                                                                                  | `ui/conversation/TurnChanges.tsx`、`turn-changes-model.ts`                                 | 本轮改动、预览联动和结束状态                                   | T23       |
| `renderer-messages.ts`、`renderer-transcript.ts`                                                                       | `ui/conversation/Message.tsx`、`Transcript.tsx`、`transcript-model.ts`                     | 消息、时间、复制、进程组、上下文隐藏、自动验证和证据           | T21       |
| `renderer-live.ts`                                                                                                     | `ui/conversation/LiveMessage.tsx`、`stream-store.ts`                                       | 增量缓冲、100ms 刷新、思考隔离和尾部跟随                       | T20       |
| `renderer-questions.ts`、`renderer-question-copy.ts`                                                                   | `ui/conversation/Questions.tsx`、`question-model.ts`                                       | 分页问题、选择草稿、自由文本和产品问题翻译；copy helper 可保留 | T22       |
| `renderer-subagents.ts`                                                                                                | `ui/conversation/Subagents.tsx`、`subagent-model.ts`                                       | 子 agent 卡片、流式增量、子会话页与父页面状态                  | T23       |
| `renderer-select-menu.ts`                                                                                              | `ui/primitives.tsx` 中的 Mantine Select/Combobox/Menu                                      | 受控选值、禁用、分组、键盘、关闭与焦点恢复                     | T6        |
| `renderer-export.ts`、`renderer-error-text.ts`、`renderer-status.ts`、`renderer-memo.ts`                               | 保留纯 helper，按使用情况清理                                                              | 导出格式、错误本地化、状态规则和必要 memo                      | T25       |
| `slots.ts`                                                                                                             | `ui/slots.tsx`                                                                             | 类型约束、顺序、注销、稳定挂载和五个扩展点                     | T25       |
| `markdown.ts`、`markdown-blocks.ts`、`diff-view.ts`、`tool-cards.ts`、`transcript-cache.ts`                            | React 内容适配器/纯 model                                                                  | 保留安全链接/复制路径与解析规则；仅在无消费者后清理 DOM cache  | T20/T21   |
| `index.html`（静态结构）                                                                                               | `ui/App.tsx`、`ui/layout/DesktopShell.tsx`、`ui/styles.css`                                | 导航/主区/侧栏结构、品牌图、初始文案                           | T6/T24    |
| `styles.css`、`styles-subagents.css`、`styles-panels.css`、`layout.css`、`layout-surfaces.css`、`layout-workspace.css` | `ui/styles.css` + Mantine Styles API / `classNames`                                        | 品牌、DOM 岛与尚未退役的基础样式（预算见 §10）                 | T10–T24   |
| `preload.ts`、`contract.ts`、`snapshot-patch.ts`、`main*.ts`、`window-state.ts`                                        | 原位置保留                                                                                 | 外部边界保持，只有明确的 React 接入需要才做最小修改            | —         |

## 实施任务

每个任务遵循[任务规则与完成定义](#3-任务规则与完成定义dod)；命令均从仓库根目录运行，逐条执行。任务编号前的里程碑对应[里程碑](#1-里程碑)表。

### M0: 开工前置

- [ ] 确认并行修改已按[第 3 节](#3-接手前的-dirty-工作区)提交或合并；仍有不属于本计划的 dirty 文件时停下报告清单，不自行处理。
- [ ] 在提交后的 HEAD 记录 `git rev-parse HEAD`、`git status --porcelain`、`npm run typecheck` 退出码，写入交付文档的基线表。
- [ ] 复核 `AGENTS.md`（当前仓库不存在）与 `.github/workflows/ci.yml` 的检查矩阵，记录本地可运行/不可运行项。
- [ ] 复读 `index.html`、`session-management.ts`、`renderer.ts` 与 runtime-context 相关 diff，记下必须随迁移保留的行为（当前模型/上下文展示、计划批准卡、内部上下文隐藏）。

### M1: 工具链、CSP、i18n 与 smoke 基建

#### T1: React/TSX 构建和质量检查闭环

**Files:** 修改 `package.json`、`package-lock.json`、`tsconfig.json`、`tsconfig.build.json`、`eslint.config.mjs`、`scripts/build-desktop.mjs`、`scripts/check-layers.mjs`、`scripts/i18n-gate.mjs`；新增 `scripts/desktop-renderer-options.mjs`、`scripts/desktop-renderer-options.d.mts`、`apps/desktop/renderer-globals.d.ts`、`apps/desktop/ui/styles.css`、`tests/desktop-react-toolchain.test.ts`、`tests/layers-gate.test.ts`；扩展 `tests/i18n-gate.test.ts`、`tests/import-cycles.test.ts`；核对 `scripts/check-import-cycles.mjs`（已扫描 `.tsx`，无需改）、`scripts/select-tests.ts`、`scripts/check-related.mjs`。

**规模:** 约 400–600 行改动，主要是脚本与夹具，不含产品 UI。

**Interfaces:** 产出可由 esbuild 打包的 `.tsx` 组件、覆盖 `.tsx` 的类型/依赖/i18n 检查；构建输出路径不变。

- [ ] 增加工具链夹具断言：TSX 文件被层级/i18n 扫描；TSX 到 TS/TSX 的 value/type import 按现有规则处理；循环被拒绝。先确认现有 gate 的 `.tsx` 漏扫测试失败。
- [ ] 安装同一 React 19 版本的 `react`/`react-dom` 与对应 `@types`，增加同一稳定版本的 `@mantine/core`/`@mantine/hooks`、`motion` 和开发依赖 `eslint-plugin-react-hooks`。核对时可用版本：react 19.3.1、`@mantine/core` 9.7.4（peer `react ^19.2.0`）、motion 14.6.0、eslint-plugin-react-hooks 7.1.1（peer 含 eslint 10）；执行时用 `npm view` 复核并以 `--save-exact` 保存实际版本、提交 lockfile；不使用 `--force`，不另装 `framer-motion` 或旧方案的 `radix-ui`。
- [ ] 设置 TypeScript `jsx: "react-jsx"`；`tsconfig.json`（typecheck）的 include 显式覆盖 `apps/**/*.tsx`。`tsconfig.build.json` 的 exclude 只加入 `apps/desktop/ui` 与 `apps/desktop/renderer.ts`：前者防止 tsc 输出无消费者的 React UI，后者防止 tsc 跟着 import 把 TSX 编进 `dist/apps/desktop/`（tsc 会继续编译被 include 文件 import 到的 excluded 文件）；仓库内无 `dist/apps/desktop` 的消费者，执行时用 `rg` 复核。**`apps/desktop/renderer-globals.d.ts` 必须留在 build 内**：`Window.yuantu` 的全局声明原先写在 `renderer.ts` 里，排除 `renderer.ts` 后其他 `setup*` 模块会实测报 `Property 'yuantu' does not exist on type 'Window'`；因此 T1 先把声明移入该 `.d.ts`，并暂时保留 `renderer.ts` 内的同名声明（相同的接口声明由 TS 合并），T6/T24 重写入口时删除重复。renderer 产物只由 esbuild 生成：配置放进 `scripts/desktop-renderer-options.mjs`（automatic JSX + `process.env.NODE_ENV` 生产值），`build-desktop.mjs` 与工具链测试共用这一份选项；React 调试夹具单独使用开发值，不能误带入发布包。
- [ ] 在 `scripts/check-layers.mjs` 增加 TSX 边界规则：除 `apps/desktop/renderer.ts` 与 `apps/desktop/ui/**/*.tsx` 外，任何 `.ts` 不得经由 value 或 type import 的传递链到达 `.tsx`。用夹具确认违规被拒绝；当前直接 import 旧 renderer 模块的 Node 测试至少包括 `general-settings-pending`、`plan-contract`、`sandbox-setup-renderer`、`workspace-panel-loading`、`task-confirm-selection`（`setup*`），以及 `desktop-copy`、`tool-arguments`、`session-projections`（helper）；执行时以 `rg "apps/desktop/renderer" tests` 重新核对，后续任务迁移这些模块时先把被测逻辑抽到纯 `.ts`。
- [ ] 用工具链夹具验证 Mantine CSS import 产生本地 `renderer.css`；在 `scripts/build-desktop.mjs` 增加 `ui/styles.css` → `dist/desktop/ui.css` 的复制（T6 首次需要）；`index.html` 的 link 顺序由 T6 追加；检查安装包资源包含新 CSS。不引入 Vite/PostCSS 开发服务器，不依赖外部字体/CDN。
- [ ] ESLint 的 files 覆盖 `.tsx`，启用 Hooks 规则与依赖检查，保留 promise 规则；核对 `projectService: true` 能在 tsconfig include `.tsx` 后正常工作。
- [ ] i18n 的递归扫描包含 `.tsx`；新 `ui/` 目录不加入原 renderer 的宽泛中文豁免。纯文字注释处理与 JSX 注释/字符串扫描补夹具，不能把 `ui/` 全排除来过检查。
- [ ] 新增 `tests/layers-gate.test.ts`：在临时树上验证层级方向、`apps/` 只向下依赖、`.tsx` 边界与违规报错信息；确认该 gate 此前没有被任何测试覆盖。
- [ ] 运行 `node scripts/run-tests.mjs tests/desktop-react-toolchain.test.ts tests/layers-gate.test.ts tests/i18n-gate.test.ts tests/import-cycles.test.ts`、`npm run typecheck`、`npm run lint`、`npm run layers:check`、`npm run cycles:check`、`npm run i18n:check`、`npm run build`，均应退出 0。此时应用仍走原界面，不以空 React 根替换产品。

#### T2: i18n 文案键化

**Files:** 新增 `scripts/migrate-ui-copy.mjs`、`tests/ui-copy-migration.test.ts`、`tests/ui-i18n-coverage.test.ts`；修改 `apps/desktop/i18n.ts`（导出 `dictionaryEntries`/`hasTranslation`、walker 跳过 `[data-react-owned]`、动态文案改由字典模板生成）、`apps/desktop/i18n-workspace.ts`（补 `ui.sessionActionsFor`/`ui.currentWorkspacePrefix`/`ui.disabled` 三个动态 key）、`package.json`（`copy:migrate` 脚本）。

**规模:** 脚本约 330 行 + 测试约 230 行；实际文案转换随后续区域任务分摊。

**Interfaces:** `node scripts/migrate-ui-copy.mjs [--dry-run|--write] [--import-specifier <path>] <file-or-directory>...`；字面量/模板字面量/JSX 文本/JSX 属性 → `t(key[, values])` 的机械转换；冲突与未命中逐条报告到 stderr，有任一条时退出码 1；`--import-specifier` 供仓库外的夹具指定 import 路径。字典侧新增 `dictionaryEntries(): [key, zh, en][]` 与 `hasTranslation(key)`，与 `translate` 读同一张表。

- [ ] 先写失败测试：`ui/**` 出现中文字面量必须被 i18n gate 报告；`ui/**` 里引用不存在的 key 必须被覆盖测试报告；`index.html` 的静态中文随后续区域迁移逐块消失，T24 兜底清零（覆盖率测试在过程中允许显式清单，清单只减不增）。
- [ ] 实现脚本：用 TypeScript compiler API 解析，只处理 `ui/**` 与显式传入的 `index.html` 片段；从 `messages` 构建 zh→key 反查表（与 `domText` 同源），模板字面量 `${x}` 转 `{x}` 并生成 `values`；保留引号风格，默认 dry-run，`--write` 才落盘，结束后提示运行 prettier。
- [ ] 冲突与未命中：同一中文多个 key 时报告并**不替换**（旧文案保留，等人工决定）；脚本绝不自行发明 key 或改写文案；未命中的字符串原样保留并在 stderr 指名文件与文本。
- [ ] 动态文案改为字典模板：`i18n.ts` 里 8 个手写英文的 `.replace` 改为 `format(t('key'), values)`——`◇ MCP 服务` 用 `mcp.title`，会话操作/会话 id/项目规则/会话改动/正在执行分别用 `ui.sessionActionsFor`、`ui.sessionShort`、`ui.projectResources`、`ui.sessionChanges`、`ui.runningTool`，`当前工作区：` 与 `已停用` 用本任务新增的两个 key。**匹配仍是渲染后中文**（walker 的机制），但英文不再有第二份字面量；每条由 `tests/ui-copy-migration.test.ts` 断言 `format` 结果与迁移前一致。生产者的 `t()` 化（彻底去掉正则）随后续区域任务进行，最后一个生产者迁移时删除对应模式。
- [ ] walker 隔离：`translateDocument` 跳过 `[data-react-owned]` 子树（文本与属性都跳过），用 `excludedContent` 统一表达。真实 DOM 断言随第一个真实 React 夹具落地（T6 的 `desktop-react.smoke.mjs`）：React 节点在语言切换后文本/属性不变；本任务之前没有 React 节点可测，不以假 DOM 代替。
- [ ] 覆盖率测试：`tests/ui-i18n-coverage.test.ts` 先在自己的夹具上证明“能报告中文文案与不存在的 key”，再对 `apps/desktop/ui` 断言零问题；避免一个永远为空的检查冒充门禁。
- [ ] 迁移脚本测试：覆盖 JSX 文本、JSX 属性、模板字面量（含占位符顺序）、普通 `.ts` 字符串、dry-run 不改文件、未命中/冲突原样保留并退出 1、import 只插一次。
- [ ] 脚本只处理 `.ts/.tsx`：`index.html` 的静态文案随各区域迁移被 React 标记替换，不经过本脚本（T24 兜底核对）。本任务以一次 `apps/desktop` 的 dry-run 记录覆盖率：当前 705 处可机械替换、256 处需人工判断（多为“历史尝试”“续跑”这类片段，不应单独成 key），不写入产品代码。
- [ ] 运行 `node scripts/run-tests.mjs tests/ui-i18n-coverage.test.ts tests/ui-copy-migration.test.ts tests/i18n-gate.test.ts`、`npm run i18n:check`、`npm run lint`、`npm run typecheck`。

#### T3: 样式 nonce 与 CSP 接入（主方案：静态 nonce）

**Files:** 修改 `apps/desktop/index.html`（CSP + meta）；新增 `apps/desktop/ui/nonce.ts`、`tests/desktop-react-csp.test.ts`（`@test-serial desktop-ui`，真实 Electron）；`ui/providers.tsx` 的 `getStyleNonce` 接线在 T6（本任务不建 providers），`apps/desktop/main-ui-document.ts` 与 `main.ts` 仅在实施可选轮换路径时创建/修改。

**规模:** 约 300–450 行（含 Electron 夹具）。

**Interfaces:** `UI_STYLE_NONCE` 常量；`STYLE_NONCE_META`；`styleNonceFromDocument(document): string`（从 meta 读取并与常量校验，缺失或不一致即抛错）；可选轮换时 `renderUiDocument(template: string, nonce: string): string` 与 `installUiDocumentLoader(session: Session, pagePath: string): Promise<() => void>`。

- [ ] 静态 nonce 三方一致：`index.html` 的 CSP `style-src 'self' data: 'nonce-…'`、同名 meta、`UI_STYLE_NONCE` 常量必须相同；CSP 不含 `unsafe-inline`/`unsafe-eval`，只出现一个 nonce，其余指令（`script-src 'self'` 等）逐字保持。
- [ ] 真实 Electron 夹具用**产品 `index.html`**（CSP 与 meta 原样）加载 Mantine 树：AppShell、Grid/Stack、Popover（Floating UI 定位）、响应式 `Box`（触发 `InlineStyles`）、以及 `deduplicateInlineStyles` 下 React 19 的 `<style data-precedence>` 提升。断言 CSS 变量、global classes、内联响应式规则都生效且都带 nonce；无 nonce 的 `<style>` 与 inline script 被拒；启动后无 `securitypolicyviolation`。
- [ ] 负向控制已实测：只把 CSP 里的 nonce 去掉（meta 与常量不变），上述测试立即失败（响应式 Box 宽度 1185px 而非 200px），证明测试不是恒真；恢复后 2/2 通过。
- [ ] `ui/nonce.ts` 写常量、meta 读取函数与威胁模型注释（§8 第 4 条）；provider 在 T6 用 `getStyleNonce` 返回该常量，本任务先让夹具直接消费它。
- [ ] 记录可选轮换路径的实测结论与实施条件（§8 第 5 条）；默认不实现，不创建 `main-ui-document.ts`，不改 `main.ts`。若后续启用，必须同时实现纯函数测试与 `loadFile` 下的 nonce 轮换断言。
- [ ] 新测试必须使用真实 CSP，不复用“剥掉 CSP meta 再注入夹具”的旧做法；`desktop-i18n.test.ts` 等旧夹具可暂时保留剥离做法，T6 迁移时再收紧。
- [ ] 运行 `node scripts/run-tests.mjs tests/desktop-react-csp.test.ts`、`npm run build`，构建后运行 `tests/desktop-language.smoke.mjs` 确认产品页在新增 CSP 下仍正常。

#### T4: smoke 共享 helper 与兼容 id 基建

**Files:** 新增 `ui/legacy/compat-ids.ts`、`tests/compat-ids.test.ts`；本任务不改任何 smoke（产品的控件仍是原生实现，改 helper 会立刻让现有断言失败）；helper 与首个套件的迁移随控件迁移在 T6 进行。

**规模:** 约 150–250 行。

**Interfaces:** `CompatId { id, region, reason, removal }`；`COMPAT_IDS: readonly CompatId[]`；`MIGRATION_COMPLETE`（T24 置 true）；`compatId(id: string): string`（只返回值，强制在测试里做，避免线上一抛毁掉窗口）；`compatIdUsages(source): readonly string[]`。

- [ ] 建立登记表与类型：`{ id, region, reason, removal }`，region 使用任务编号（如 `T10`）；起始为空表，区域迁移到 React 开始渲染某个旧 id 时才登记。
- [ ] `compatId()` 不做运行时校验：缺登记必须是红构建，不能在用户窗口里抛错；`compatIdUsages()` 与测试共用同一套解析规则。
- [ ] 测试：id 唯一、字段非空、region 形如 `T\d+`；**双向一致**——`ui/**` 中 `compatId('…')` 的每个值都已登记，每个登记值都确实被渲染；每个登记值仍被 `tests/` 中至少一个文件引用；“迁移完成时表为空”由 `MIGRATION_COMPLETE` 控制，T24 置 true 后该断言生效（不写 `skip`）。
- [ ] 明确交接规则并写入文档：每个区域任务的交付必须包含“新增/删除的兼容 id 清单 + 对应 smoke 文件”；id 的删除与该断言的替换在同一个提交。
- [ ] 运行 `node scripts/run-tests.mjs tests/compat-ids.test.ts`、`npm run typecheck`、`npm run lint`、`npm run layers:check`、`npm run i18n:check`。

### M2: runtime、provider、主题与布局外壳

#### T5: 可订阅 runtime 与命令动作

**Files:** 新增 `ui/stores.ts`、`ui/runtime.ts`、`ui/actions.ts`、`ui/ui-state.ts`、`ui/context.tsx`、`renderer-globals.d.ts`（路径均相对 `apps/desktop/`）；改造 `renderer.ts` 的订阅接缝；新增 `tests/desktop-react-runtime.test.ts`。

**规模:** 约 500–700 行。

**Interfaces:** 架构约定中的 `DesktopRuntime`、`ReadableStore`、`useReadable/useSection` 和 `invoke/select`，提供稳定实例与幂等资源清理。

- [ ] 用 fake `DesktopBridge` 编写测试：重复 start 只订阅一次，dispose 只解绑一次；同一个 section getter 引用稳定，未变区不通知；旧 bridge 无 changed 时全量刷新；可选区删除后不留旧值。已实现 `tests/desktop-react-runtime.test.ts`（13 条）。
- [ ] 断言 `SnapshotMirror.apply` 原地复用 state 的事实：runtime 必须投影出新快照；直接透传同一对象时测试必须失败（先红后绿）。已由“bridge 复用同一对象、旧快照不被改写”用例覆盖。
- [ ] 增加交错时序：订阅期间先推送后回复初始快照，初始请求拒绝、卸载后回复，以及同一对象被 preload 继续合并时旧 UI 快照不被原地改变。断言最新视图不倒退且 late callback 无通知。已覆盖推送先于回复、首次失败可重试（不重复订阅）、dispose 后回复无通知。
- [ ] 将 `renderer.ts` 的 snapshot 订阅转交 runtime，通过 `onSnapshot` 暂时驱动旧视图；保留现有 1 frame/50ms 的快照绘制合并，不让过渡适配失去该优化。每个 delta/preset/通知频道移交时同时解除原 owner，不同时绑定两份 IPC。delta/preset/通知频道本任务不动（T20 接管流式），renderer 只在 runtime 回调里重排绘制。
- [ ] 抽取 `invoke/select` 到 `ui/actions.ts`，按原有逻辑保留 running 时允许 load/create、`loadOlder` 不抢输入焦点、恢复通知清除旧连接错误、操作 finally 解锁。pending 以操作 id 计数（`ui/ui-state.ts`），设置页自己的 busy 另用 `externalBusy`，不再与命令共用一个布尔值。命令回复不写入 runtime 状态（只有初始快照填充），与计划一致。
- [ ] 说明两处记录在案的取舍：`ui-state.ts` 目前只含 pending（页面/草稿/展开由拥有它们的区域任务补）；统计增量仍由 renderer 局部合并进 `state`，runtime 的 `session` 切片要等 T20 的统计 store 才同步。
- [ ] 运行 `node scripts/run-tests.mjs tests/desktop-react-runtime.test.ts tests/desktop.test.ts`；通过后构建并运行 `tests/desktop-sessions.smoke.mjs`，证明旧 UI 经过新 runtime 仍可用。已完成：23/23 与 6/6 通过。

#### T6: 单 provider、Mantine 包装层、翻译与 select 隔离

**Files:** 新增 `ui/legacy/mount-region.tsx`、`ui/providers.tsx`、`ui/primitives.tsx`、`ui/i18n.ts`、`ui/ErrorBoundary.tsx`、`ui/App.tsx`；修改 `ui/styles.css`、`index.html`（`desktop-root` 容器与 CSS link）、`renderer-globals.d.ts`（`*.css` 声明）、`i18n-workspace.ts`（`ui.renderFailed`/`ui.retry`）、`i18n.ts`（walker 隔离已在 T2）、`renderer-select-menu.ts`、`renderer.ts`（挂载 React 根、导入 Mantine 样式）；新增 `tests/desktop-react.smoke.mjs`（`@test-serial desktop-ui`），加入 `smoke:desktop`；`main.ts` 不修改（静态 nonce）。

**规模:** 约 600–850 行。

**Interfaces:** `mountRegion(key: string, container: HTMLElement, element: ReactNode): () => void` 注册同一 React 根内的 portal，返回幂等注销函数；`RegionHost` 订阅注册表；`useLocale(): UiLanguage`；`DesktopProviders({ runtime, actions, children })`；`mountDesktopApp({ runtime, actions }): () => void`；`Dialog` 包装 Mantine Modal；`selectValue('')` 适配旧空值。

- [ ] 用 esbuild 编译 TSX 探针并在真实 Electron 中加载产品 `index.html`（保留 CSP/meta/link 顺序）；夹具写入隔离目录，测试带 `@test-serial desktop-ui`。已完成 `tests/desktop-react.smoke.mjs`。
- [ ] 按 §8 接入静态 nonce 的 provider；`renderer.css` 由 esbuild 输出、`ui.css` 由构建复制，`index.html` 顺序为 `renderer.css` → 六份旧 CSS → `ui.css`；smoke 断言构建产物存在与顺序。
- [ ] 中→英→中、动态 placeholder 与 React 自有中文原文保留：walker 只翻译旧节点，`[data-react-owned]` 子树（含 React 渲染的中文原文）不被改写；select upgrader 不包裹 React 区域的 `<select>`。已由 smoke 断言，并做过负向控制（去掉 `data-react-owned` 标记后该用例失败）。
- [ ] 一个 provider/RegionHost，`createPortal` 挂载各区域；注销区域不重建 provider；非 React 区域继续由 walker 翻译、对应 `setup*` 由区域任务停止。已实现（区域本身在 T10 起迁入）。
- [ ] `primitives.tsx` 以 Mantine 再导出为主（尺寸/圆角等默认值留给 T7 的 theme `components`），只保留两个真正需要项目契约的：`Dialog`（busy 时禁用 Esc/遮罩关闭）与 `selectValue`；未引入第二套 Select。
- [ ] **记录在案的取舍**：主题默认值与 `resolveColorScheme` 属 T7，本任务 provider 只接 `getStyleNonce` 与 `MotionConfig reducedMotion="user"`（tokens 在 T9）；`InlineStyles` 等组件的业务 class/关键 ID 由迁入区域时经 T4 登记表处理；`tests/desktop-smoke-support.mjs` 的交互 helper 迁移随控件迁移（T12/T13）进行，现在改会让仍用原生控件的 smoke 失效。
- [ ] 在真实页面验证 ErrorBoundary 的本地化错误与重试、Dialog 的 Escape 关闭、Mantine 按钮/输入样式与 CSS 变量生效；方向键/Tab/下拉分组等键盘细节随对应控件迁入时逐个补测。
- [ ] 运行 `node scripts/run-tests.mjs tests/desktop-react.smoke.mjs tests/desktop-i18n.test.ts tests/desktop-layout.smoke.mjs tests/desktop-language.smoke.mjs tests/desktop-sessions.smoke.mjs`，依赖 dist 的 smoke 先 `npm run build`。已完成：2/2、9/9、4/4、7/7、6/6。

#### T7: 主题与 UI 设置单一数据源

**Files:** 新增 `ui/theme.ts`（`createDesktopTheme`、`desktopCssVariablesResolver`、`resolveColorScheme`/`resolveFontSize`、两个 document 读取函数）、`tests/desktop-react-theme.test.ts`；修改 `ui/providers.tsx`；扩展 `tests/desktop-react.smoke.mjs`、`tests/desktop-layout.smoke.mjs`。

**规模:** 约 250–400 行。

**Interfaces:** `resolveColorScheme(appearance, systemDark): 'light' | 'dark'`；`resolveFontSize(name): 13 | 14 | 16`；`createDesktopTheme(base): MantineThemeOverride`；`desktopCssVariablesResolver: CSSVariablesResolver`；`appearanceFromDocument(doc)`/`fontSizeFromDocument(doc)`。provider 订阅 `data-theme`/`data-font-size`（legacy 设置控制器写的同一份），`forceColorScheme` 驱动 Mantine，**不新建设置 store、不写 localStorage**。

- [ ] 主题状态单一来源：provider 用 `MutationObserver` 读 `data-theme`/`data-font-size`，`system` 经 `useMediaQuery('(prefers-color-scheme: dark)')` 解析；显式 light/dark 不随系统变化。已由 `tests/desktop-react-theme.test.ts`（4 条纯函数）与 React smoke 覆盖。
- [ ] palette 映射进 `desktopCssVariablesResolver`：`--mantine-color-body/text/dimmed/default/default-hover/default-border/anchor` 与 primary filled 指向既有 `--surface/--ink/--muted/--raised/--hover/--line/--accent`；默认变量先取自 `defaultCssVariablesResolver` 再覆盖。**注意**：覆盖必须同时写进 `variables`、`light`、`dark` 三个块，Mantine 的 per-scheme 块会重新定义 `--mantine-color-body`（首版只写 shared 块时弹层背景是 Mantine 默认 `#242424`，smoke 立即报错）。
- [ ] 字号：`createDesktopTheme(base)` 从 13/14/16 推导 `fontSizes`（xs=base-2 … xl=base+6），provider 以 `useMemo` 随属性重建；smoke 断言 `--mantine-font-size-md` 在 large/small 下分别为 16px/13px。
- [ ] 不重复持久化：`forceColorScheme` 让 Mantine 忽略 colour-scheme manager；smoke 断言 `localStorage['mantine-color-scheme-value']` 为空。启动读取失败仍走既有设置 controller 的默认值，provider 只反映 DOM 属性，不额外发 `uiSettings` 请求。
- [ ] portal 一致性：暗色下打开 Dialog，断言 `.mantine-Modal-content` 背景与 `var(--surface)` 探针一致、无第二个 provider。
- [ ] 运行 `node scripts/run-tests.mjs tests/desktop-react-theme.test.ts tests/desktop-react.smoke.mjs tests/desktop-layout.smoke.mjs tests/desktop-language.smoke.mjs`。已完成：4/4、2/2、4/4、7/7。

#### T8: AppShell 布局接管（仍不接管产品外壳）

**Files:** 新增 `ui/layout/DesktopShell.tsx`；修改 `ui/styles.css`；扩展 `tests/desktop-react.smoke.mjs`（专用 shell 夹具，不接产品页）；`tests/desktop-layout.smoke.mjs` 的产品级主题断言已在 T7 加入。

**规模:** 约 200–320 行。

**Interfaces:** `DesktopShell({ navbar, main, aside?, navbarWidth?, asideWidth?, navbarVisible?, asideVisible? })`：单一 `AppShell`，`Navbar`/`Main`/`Aside` 三区，`Main` 内部再分 `.desktop-shell-content` 作为唯一滚动容器。

- [ ] 单一 AppShell：专用夹具页只有 `renderer.css`/`ui.css`（不含六份旧 CSS），断言 `main` landmark 恰 1 个、`.mantine-AppShell-root` 恰 1 个；设置页将来替换 `main` 内容而不是再嵌套一层。
- [ ] 高度与滚动契约写进 `ui/styles.css`：`.desktop-shell-main` 为 `height:100vh` 的 flex 列，`.desktop-shell-content` 为唯一 `overflow:auto`；导航/侧栏各自 `height:100vh; overflow:auto`。测试断言主列高度等于视口、内容溢出时只有内容区滚动、`document` 自身不滚动。
- [ ] 导航宽度 264、侧栏宽度 360，侧栏默认折叠；`asideVisible` 为真时侧栏才渲染并让 `Main` 让出 360px（断言无横向溢出）。**取舍**：Mantine 的 `collapsed` 只负责偏移，不隐藏已渲染节点；因此侧栏同时按可见性条件渲染，DOM 与偏移保持一致（首版仅靠 `collapsed` 时侧栏仍占 359px，smoke 抓到）。
- [ ] 最小窗口宽度（820×560）下仍为单列且无横向溢出，主列保持满高。
- [ ] 运行 `node scripts/run-tests.mjs tests/desktop-react.smoke.mjs tests/desktop-layout.smoke.mjs`。已完成：3/3、4/4；typecheck/lint/i18n/layers/format/docs 全绿。

### M3: 动效

#### T9: Motion tokens、PageTransition、PanelTransition 与 reduce

**Files:** 新增 `ui/motion-tokens.ts`、`ui/transitions.tsx`、`ui/reduced-motion.ts`、`tests/desktop-react-motion.smoke.mjs`（`@test-serial desktop-ui`，加入 `smoke:desktop`）；修改 `ui/primitives.tsx`（Dialog）、`ui/layout/DesktopShell.tsx`（AppShell 时长）、`ui/styles.css`（reduce 兜底）、`package.json`。

**规模:** 约 450–650 行（含动效测试）。

**Interfaces:** `PageTransitionProps`、`PanelTransitionProps`（架构约定 §7）；`MOTION`/`EASING`/`OFFSET_PX`/`seconds()`/`overlayTransition(reduced)`；`usePrefersReducedMotion()`。

- [ ] 动效表落成 `motion-tokens.ts`：时间只用这一处，Motion 取秒、Mantine/CSS 取毫秒；`overlayTransition(reduced)` 供 Dialog 等 Mantine 弹层。
- [ ] `PageTransition` 用 `AnimatePresence mode="wait"` + **直接子节点** `motion.div`（退出动画只认 AnimatePresence 的直接子节点），退出中 `inert` + `aria-hidden` 由内层 `display:contents` 包装设置；`PanelTransition` 包 Mantine 9 的 `Collapse`（属性是 `expanded`，不是 `in`）。
- [ ] **两个实测坑已记录**：(a) 内层若调用 `usePresence()` 却不调用 `safeToRemove`，AnimatePresence 永远不会移除退出节点（新的页面因此一直挂不上），改用 `useIsPresent()`；(b) `motion` 14 的 `useReducedMotion` 只在首次渲染读取一次（源码里 `useState` + TODO），系统偏好在运行中切换不会生效；因此新增自订阅的 `usePrefersReducedMotion`，三个动画所有者（transitions/primitives/DesktopShell）都用它，MotionConfig 仍保留给 Motion 内部。
- [ ] 真实页面测试用帧采样而非 sleep：断言退出时旧页面 `inert`、进入存在中间透明度、结束时只剩目标；A→B→C 最终只剩 C；`Collapse` 使用 180ms（读计算 `transitionDuration`）；reduce 下无中间透明度、面板时长趋零；运行中切 reduce 立即收敛。**注意**：隐藏的 Electron 窗口会暂停 rAF，动效夹具必须 `show: true`，否则动画永不推进。
- [ ] CSS 兜底：`ui/styles.css` 的 `prefers-reduced-motion` 块把 React 子树内的 transition/animation 压到 0.01ms（Mantine 的 duration=0 分支不写 transition，计算值来自该兜底）。
- [ ] 运行 `node scripts/run-tests.mjs tests/desktop-react-motion.smoke.mjs tests/desktop-react.smoke.mjs tests/desktop-layout.smoke.mjs tests/desktop-i18n.test.ts`，同时验证 CSP 下的实际布局与过渡。已完成：5/5、3/3、4/4、9/9。

### M4: 设置页

#### T10: 设置骨架与通用设置

**Files:** 新增 `ui/settings/SettingsPage.tsx`、`GeneralSettings.tsx`、`settings-model.ts`、`mount.tsx`（legacy 接缝）；删除 `renderer-general-settings.ts`；修改 `renderer.ts`、`renderer-panels.ts` 注释、`i18n-panels.ts`（新增 `ui.settingsPage`/`ui.settingsMenu`，English 下 `general.languageZh` 用 `Chinese`）；迁移 `tests/general-settings-pending.test.ts` 到纯 controller 测试；新增 `tests/desktop-smoke-support.mjs` 的 `chooseSelectOption`；扩展 `tests/desktop-react.smoke.mjs`、`settings.smoke.mjs`、`desktop-language.smoke.mjs`、`desktop-layout.smoke.mjs`。

**规模:** 约 650–950 行。

**Interfaces:** `SettingsPage({ controller, environment })`、`GeneralSettings({ controller })`；controller 接受 `UiSettings` 并暴露稳定可订阅状态（draft/persisted/saving/error/loaded），组件不自建持久化协议；`mountGeneralSettings(bridge)` 负责容器清空、chrome 翻译、导航接线与环境列表刷新，返回 dispose。

- [x] 纯 controller 测试 8 条：读取填充、立即应用、串行落盘（in-flight 期间的修改合并为一次且用最新值）、拒绝回滚+错误、**rejected promise 释放 in-flight 并可重试**（旧用例的核心缺陷）、无变化不发请求、读取失败、dispose 忽略迟到回复。
- [x] React 侧新增 `desktop-react.smoke` 第 4 条：保存被拒时错误消息上屏且控件回滚到 persisted（真实 Electron + 真实 CSP）。
- [x] 初始读取/重挂载不重复保存：controller 持有 in-flight 与 pending，组件只读 draft 并调用 `change`；`StrictMode` 下 effect 只 `load()` 一次（已 dispose 保护）。
- [x] 删除旧 `setupGeneralSettings` 与整表 `replaceChildren`；通用面板容器由 React 独占，环境问题列表也由 React 渲染（打开面板与启动时各读一次 bridge，保存可能改变该列表）。`renderer-panels.ts` 仍保留为跨面板唯一开关，React 适配器调用同一 `showSettingsPanel`。
- [x] 新控件用 Mantine `Select`/`Switch`；smoke 增加 `chooseSelectOption`（点击字段再点 option，等 listbox 关闭——语言切换会同时改动该选项自身的标签，不能等 input value）。同步改写 layout/language/settings 的选择器交互与布局断言（标签在上、列表在 portal）。
- [x] `renderer-general-settings.ts` 删除后无残留引用；`rg`/i18n gate 确认 `ui/settings` 无中文字面量。
- [~] **范围调整（已记录）**：设置外壳（侧栏导航 + 另外三个面板）仍是 legacy，`PageTransition kind="settings"` 与唯一可交互面板延后到 T13 全部面板 React 后一起做——现在改用 React 外壳会把尚未迁移的模型/权限面板变成空白，属于功能回退，不是迁移。`DesktopShell` 的单一 AppShell 规则不变。
- [x] 运行 `node scripts/run-tests.mjs tests/general-settings-pending.test.ts tests/desktop-react.smoke.mjs tests/desktop-i18n.test.ts tests/settings.smoke.mjs tests/desktop-language.smoke.mjs`。已完成：8/8、4/4、9/9、8 通过+1 跳过（MCP 不在本期范围）、7/7；另 layout 4/4、desktop 9/9。

#### T11: 模型设置

**Files:** 新增 `ui/settings/ModelSettings.tsx`、`model-settings-model.ts`、`model-mount.tsx`、`model-lock.ts`、`tests/model-settings.test.ts`；重写 `renderer-settings.ts`（只保留 picker 与页面开合）；修改 `renderer.ts`、`i18n-conversation.ts`、`ui/styles.css`；扩展 `tests/settings.smoke.mjs`、`tests/desktop-react.smoke.mjs`、`tests/desktop-smoke-support.mjs`、`tests/desktop-copy.test.ts`。

**规模:** 约 700–900 行（实际约 1200 行，含 531 行数据/controller 与 350 行面板）。

**进度:** 数据层、controller（20 条纯测试）与 React 面板已完成；`renderer-settings.ts` 的表单逻辑已删除，只保留 composer 模型 picker 与设置页开合。

- [x] 环境模型只读标签、连接分组、加密不可用时禁用保存、运行中禁用切换与打开入口：`#settings-source` 仍显示来源与当前模型；`modelLock` 让 picker（legacy）与表单（React）共享同一把锁；保存按钮在 `!encryptionAvailable` 时禁用并说明原因。
- [x] `__settings__` 仍是动作而非连接：它只出现在 picker 末尾并立即还原值；controller 的 `selectConnection` 显式拒绝 sentinel、空值与当前连接，切换失败只写 `switchStatus`，不换视图、不丢草稿。
- [x] 删除表单旧绑定：`setupModelSettings` 改为 `setupModelSettingsEntry`（picker/开合），表单绑定与行 DOM 构造全部删除；`environmentModelLabel` 迁到数据层并更新 `desktop-copy.test.ts` 的导入；无中文字面量（i18n gate 通过）。
- [~] **范围调整（已记录）**：composer picker 仍是原生 `<select>`（`#model`），尚未迁到 Combobox/Menu；把它作为独立按钮、连同设置页开合一起迁，属于 composer/外壳任务（M5/T24）。当前 picker 的 sentinel 处理与原实现一致，不构成回退。
- [x] smoke 迁移与新增断言：`#settings-protocol`/`#settings-connection` 改为 `chooseSelectOption`/`readSelectOptions`；选项值断言改为可见标签；`[data-field]`、`data-action`、`.model-chevron` 等兼容钩子保留；因行展开/收起现在是 180ms Collapse，相关断言改为等待最终状态。
- [x] 验证：`settings.smoke` 8 通过+1 跳过（MCP 不在范围）、`model-settings` 20/20、`desktop-copy` 14/14、`desktop-react` 4/4、`desktop-i18n` 9/9、`desktop` 9/9、`layout` 4/4、`language` 7/7、`general-settings-pending` 8/8；typecheck/lint/i18n/layers/format 全绿，build 通过。

#### T12: 权限、沙箱初始化与恢复

**Files:** 新增 `ui/settings/PermissionSettings.tsx`、`ui/sandbox/{sandbox-setup-model.ts,SandboxPrompt.tsx,mount.tsx}`；停用 `renderer-permissions.ts`、`renderer-sandbox-setup.ts` 的活动接入；迁移 `tests/sandbox-setup-renderer.test.ts` 为纯 controller 测试；扩展 smoke。

**规模:** 约 600–800 行。

**进度:** 沙箱初始化与恢复已完成（本提交）：`commandsNeedSandboxAccounts` 移入 `ui/sandbox/sandbox-setup-model.ts`，新增 controller（状态/提示文案/可见性/操作）、React `SandboxPrompt`（保留 `#sandbox-prompt*` id 与 composer 外观）、`mountSandboxSetup` 接缝；`renderer-sandbox-setup.ts` 删除，`index.html` 的静态提示替换为容器；renderer 继续通过 `setMode` 把权限 chip 的会话沙箱模式传进来。旧 DOM 测试改写为 12 条 controller 测试（就绪/未初始化/命令不可用、模式矩阵、dismiss 后重新提示、损坏后端只 verify 一次、拒绝后可重试、无 bridge、较弱沙箱确认/失败、dispose）。**权限 chip 与完全访问对话框仍是 legacy**，其 controller/组件与文案键化留到下一步。

- [~] 权限预设、初始化、恢复继续调用既有专用 bridge，不改沙箱策略；`commandsNeedSandboxAccounts` 已抽出；`runStatusText` 断言保留在改写后的测试里。权限预设部分待迁移。
- [ ] 权限菜单的受控选值、禁用与 `#permission-trigger`/`#permission-menu` 的 smoke 语义迁到 React（role/option）。
- [ ] 权限文案键化；删除 `renderer-permissions.ts` 的旧绑定；沙箱提示已全部走字典。
- [x] 运行 `node scripts/run-tests.mjs tests/sandbox-setup-renderer.test.ts tests/windows-account-settings.smoke.mjs tests/settings.smoke.mjs tests/desktop-capabilities.smoke.mjs`。已完成：12/12、1/1、8 通过+1 跳过、3/3；另 desktop 9/9、layout 4/4。

#### T13: 工作区维护、归档会话与 MCP 开关

**Files:** 新增 `ui/settings/WorkspaceMaintenance.tsx`、`ui/sessions/ArchivedSessions.tsx`、`ui/settings/McpSettings.tsx`；停用 `renderer-workspace-maintenance.ts`、`renderer-archived-sessions.ts`、`renderer-mcp.ts` 的活动接入；扩展 `tests/workspace-maintenance.smoke.mjs`、`tests/settings.smoke.mjs`、`tests/desktop-capabilities.smoke.mjs`。

**规模:** 约 600–900 行。

- [ ] 维护、归档、恢复、分页和错误沿用原语义；MCP 跟随 `PRODUCT_SCOPE.mcpManagement`，不额外暴露入口。
- [ ] 删除该区域旧绑定；文案键化；兼容 id 更新。
- [ ] 运行 `node scripts/run-tests.mjs tests/workspace-maintenance.smoke.mjs tests/settings.smoke.mjs tests/desktop-capabilities.smoke.mjs`。

### M5: 会话、输入、附件、工作区与面板

#### T14: 会话列表、搜索与菜单

**Files:** 新增 `ui/sessions/SessionSidebar.tsx`、`SessionRow.tsx`、`session-actions.ts`；修改 `session-management.ts`、`renderer-session-list.ts` 的接入点；新增 `tests/desktop-react-sessions.test.ts`；扩展 `tests/desktop-sessions.smoke.mjs`、`tests/history.smoke.mjs`。

**规模:** 约 700–900 行。

- [ ] 会话列表用稳定 session ID；保留运行/等待交互图标、四行折叠与搜索时显示全部匹配、分页/归档/恢复/重命名/删除/分支、通知切换与上下文展示。
- [ ] 会话在运行时仍能切换，不能将全局 busy 简化为禁止所有切换；双击/Enter 重入不重复提交。
- [ ] 完整导出仍发送 sessionId 与建议文件名，由 Host 分页获取全会话；不能导出当前可见消息窗口冒充全会话。
- [ ] 删除旧绑定；文案键化；兼容 id 更新。
- [ ] 运行 `node scripts/run-tests.mjs tests/desktop-react-sessions.test.ts tests/desktop-sessions.smoke.mjs tests/history.smoke.mjs tests/desktop-language.smoke.mjs`。

#### T15: 输入区与命令菜单

**Files:** 新增 `ui/composer/Composer.tsx`、`composer-model.ts`、`CommandPalette.tsx`、`command-model.ts`；修改 `renderer-composer.ts`、`renderer-commands.ts` 接入点；新增 `tests/desktop-react-composer.test.ts`；扩展 `tests/desktop-react.smoke.mjs`、`tests/desktop-language.smoke.mjs`。

**规模:** 约 600–800 行。

- [ ] 行为测试：运行中输入生成 `enqueue(mode: 'follow-up')`，普通发送只提交一次；双击/Enter 重入不重复提交；发送失败仅在来源会话仍匹配、当前草稿为空时恢复文本/附件。
- [ ] 真实 React 测试覆盖中文 IME：`isComposing` 或输入法兼容事件期间 Enter 不发送；保留 Enter/Shift+Enter、slash 选中优先级和焦点恢复。
- [ ] 命令菜单与 slash 共用同一命令定义、过滤与导出；菜单命令不能以假选项冒充。
- [ ] 文案键化；旧绑定删除。
- [ ] 运行 `node scripts/run-tests.mjs tests/desktop-react-composer.test.ts tests/desktop-react.smoke.mjs tests/desktop-language.smoke.mjs`。

#### T16: 附件

**Files:** 新增 `ui/composer/Attachments.tsx`、`attachment-model.ts`；修改 `renderer-attachments.ts` 接入点；新增 `tests/desktop-react-attachments.test.ts`。

**规模:** 约 450–650 行。

- [ ] 复用原大小、数量、模型能力与 `attachmentPrompt` 校验；用延迟 Promise 验证选择/粘贴/拖放读取期间切换 session 或 workspace 时结果被丢弃；同名附件不误当同一条。
- [ ] 保留图片/文档拼接与预览、计数显示、发送失败恢复。
- [ ] 文案键化；旧绑定删除；兼容 id 更新。
- [ ] 运行 `node scripts/run-tests.mjs tests/desktop-react-attachments.test.ts tests/desktop-react.smoke.mjs tests/backups.smoke.mjs`。

#### T17: 工作区面板

**Files:** 新增 `ui/workspace/WorkspacePanel.tsx`、`FileTree.tsx`、`FilePreview.tsx`、`workspace-model.ts`；修改 `renderer-workspace.ts` 接入点；迁移 `tests/workspace-panel-loading.test.ts` 到纯 model/controller 或真实页面；扩展 `tests/workspace-ui.smoke.mjs`。

**规模:** 约 800–1,100 行。

- [ ] 用原测试覆盖目录/预览失败能重试、同路径 update 不重复读取、切换工作区拒收旧结果；控制并发请求 token（workspace + request generation），不能只在组件卸载时设一个 cancelled。
- [ ] 保留目录/文件预览限制和安全边界；改动预览继续复用既有 diff 数据，open/reveal 交给 `DesktopBridge.files/openWorkspacePath`，不在 renderer 使用 Node 文件 API。
- [ ] 运行结束触发工作区刷新一次；保留原树展开状态与滚动位置。
- [ ] 文案键化；旧绑定删除；兼容 id 更新。
- [ ] 运行 `node scripts/run-tests.mjs tests/workspace-panel-loading.test.ts tests/workspace-ui.smoke.mjs tests/backups.smoke.mjs`。

#### T18: 后台进程与统计

**Files:** 新增 `ui/panels/BackgroundPanel.tsx`、`Statistics.tsx`、`statistics-model.ts`；修改 `renderer-background.ts`、`renderer-statistics.ts` 接入点；扩展 `tests/desktop-round3.smoke.mjs`、`tests/desktop-copy.test.ts`。

**规模:** 约 600–800 行。

- [ ] 独立统计频道：`StatisticsDelta` 只更新匹配会话；保留 `decodeKnown` 与原 TPS 最小样本阈值，不新增推算数据；上下文提示文案沿用既有规则。
- [ ] 后台进程列表、停止与通知跳转保持；后台任务更新不替换当前输入框。
- [ ] 文案键化；旧绑定删除；`renderer-statistics.ts` 的内联 pair 一并迁入字典。
- [ ] 运行 `node scripts/run-tests.mjs tests/desktop-round3.smoke.mjs tests/desktop-copy.test.ts tests/desktop-react.smoke.mjs`。

#### T19: 任务与会话辅助面板

**Files:** 新增 `ui/panels/TasksPanel.tsx`、`TaskEditor.tsx`、`task-model.ts`、`SessionPanels.tsx`、`PlanPanel.tsx`；修改 `renderer-tasks.ts`、`renderer-tasks-editors.ts`、`renderer-tasks-format.ts`、`renderer-session-panels.ts`、`renderer-plan.ts` 接入点；迁移 `tests/task-confirm-selection.test.ts`、`tests/plan-contract.test.ts`；扩展 `tests/workflows.smoke.mjs`。

**规模:** 约 900–1,200 行。

- [ ] 先抽取 `TaskConfirmDrafts` 为纯 `.ts` 并保留原断言，再替换 UI；定时/触发任务、确认草稿、执行证据、待办、目标、计划、交付文件与问题跳转逐一保留。
- [ ] 任务进度更新不覆盖编辑中的确认选择或自由文本。
- [ ] 文案键化；旧绑定删除；兼容 id 更新。
- [ ] 运行 `node scripts/run-tests.mjs tests/task-confirm-selection.test.ts tests/plan-contract.test.ts tests/workflows.smoke.mjs tests/desktop-react.smoke.mjs`。

### M6: 对话流

#### T20: 流式 store 与内容适配器

**Files:** 新增 `ui/conversation/stream-store.ts`、`LiveMessage.tsx`、`MarkdownView.tsx`、必要时 `DomContent.tsx`；runtime 增加流式/统计/子 agent store；新增 `tests/desktop-react-stream.test.ts`；扩展 React smoke。

**规模:** 约 500–700 行。

**Interfaces:** `StreamView` 为 `{ messageId: string; text: string; reasoning: string } | null`；`createStreamStore()` 返回 `ReadableStore<StreamView>`，并提供 `acceptSnapshot(session)`、`acceptDelta(delta)`、`dispose()`。父/子 agent 实例独立，runtime 负责路由；UI 不直接合并 raw delta。

- [ ] 用可控时钟测试：同一 100ms 内 100 个 delta 只发布一次显示快照且文本完整；text/reasoning 分离；reset 替换；delta 先于 snapshot 不丢；终止/新 messageId/切换会话不串流；dispose 后不再发布。
- [ ] store 同步快照和缓冲时严格复刻现有 `renderer-live.ts` 的 ID、reset 与结束规则；按当前 bridge 能提供的关联信息路由，不擅自扩展 IPC 协议或虚构 delta 的 sessionId 字段。
- [ ] `MarkdownView` 保留 `markdownBlocks`、复制、外部链接和本地链接的既有校验/动作；只更新末尾变化块，不把模型 HTML 直接交给 `dangerouslySetInnerHTML`。已有 Markdown 的安全处理不能在迁移时绕过。
- [ ] 在 React smoke 记录历史消息 DOM 身份或 MutationObserver 证据：100 个流式 delta 不替换既有历史消息节点；统计增量不重建 transcript；流式结束后正文与最终历史结果一致。
- [ ] 运行 `node scripts/run-tests.mjs tests/desktop-react-stream.test.ts tests/markdown-links.test.ts tests/desktop-react.smoke.mjs tests/desktop-round3.smoke.mjs`。

#### T21: 历史消息、Transcript 与滚动锚点

**Files:** 新增 `ui/conversation/Conversation.tsx`、`Transcript.tsx`、`Message.tsx`、`transcript-model.ts`、`scroll-anchor.ts`；修改 `renderer-messages.ts`、`renderer-transcript.ts` 接入点；新增 `tests/desktop-react-transcript.test.ts` 与 `tests/desktop-react-transcript.smoke.mjs`（`@test-serial desktop-ui`）；扩展 `tests/desktop.smoke.mjs`、`tests/history.smoke.mjs`。

**规模:** 约 900–1,200 行。

**Interfaces:** `transcript-model.ts` 输出带稳定 key 和来源绝对消息下标的视图描述，React 只消费描述；`scroll-anchor.ts` 提供 `captureAnchor(container)`、`restoreAnchor(container, anchor)`，提交后恢复且缺失锚点时有 scrollHeight 差值回退。

- [ ] 纯 model 测试验证进程组、内部 runtime-context 消息过滤、历史 prepend 后 key 不变、失败/取消/验证状态文案继续调用既有 helper；时间与复制操作仍属于各自消息。
- [ ] 在真实页面验证 prepend 旧消息保持可见锚点：消息和展开工具组内部均测，允许像素取整误差但不能跳到底；用户滚离尾部后新 delta 不抢滚动，子 agent 页打开时父流也不抢滚动。
- [ ] 保持思考、工具组和验证证据的展开状态，以及未变化节点上的文字选择/焦点。key 不包含全局语言、messageRevision 或流式文本；语言变化通过 props 更新文案，不无故重挂整棵树。
- [ ] 保留自动验证 presentation：`verified` 不出现提示；环境限制、未验证、受限等展示和证据可展开；不丢原始命令、退出码或输出，不改完成判定。
- [ ] 思考、工具组、验证证据使用统一 PanelTransition，打开状态只响应用户操作；流式更新不重复播放高度动画。补测面板关闭途中重新打开、reduce 模式下即时展开，以及动画期间阅读锚点不跳。
- [ ] 文案键化；旧绑定删除；兼容 id 更新。
- [ ] 运行 `node scripts/run-tests.mjs tests/desktop-react-transcript.test.ts tests/desktop-react-transcript.smoke.mjs tests/desktop.smoke.mjs tests/desktop-round3.smoke.mjs tests/history.smoke.mjs`。

#### T22: 问题、审批与计划批准卡

**Files:** 新增 `ui/conversation/Questions.tsx`、`Approvals.tsx`、`question-model.ts`；修改 `renderer-questions.ts`、`renderer-question-copy.ts` 接入点；迁移 `tests/desktop-copy.test.ts`、`tests/desktop-i18n.test.ts` 的相关断言；扩展 `tests/desktop-react.smoke.mjs`。

**规模:** 约 600–850 行。

- [ ] 问题草稿按 request ID/问题 ID 保存；快照、统计或语言刷新不清除选择、翻页和自由文本；请求完成后释放草稿。审批请求去重及 pending 防重入维持原逻辑。
- [ ] 保留并行修改后的计划批准卡：短提示与 Markdown 正文分别展示，digest 不进入 UI，编号步骤独立成行且保持当前小字号；选择/提交不重置当前问题的卡内滚动或会话锚点，换到另一问题才重置卡内阅读位置。沿用 `localizedQuestion` 的原始选项值，不把翻译后的 label 发回内核。
- [ ] 文案键化；旧绑定删除；兼容 id 更新。
- [ ] 运行 `node scripts/run-tests.mjs tests/desktop-copy.test.ts tests/desktop-i18n.test.ts tests/desktop-react.smoke.mjs`。

#### T23: 子 agent 与本轮改动

**Files:** 新增 `ui/conversation/Subagents.tsx`、`subagent-model.ts`、`TurnChanges.tsx`、`turn-changes-model.ts`；修改 `renderer-subagents.ts`、`renderer-changes.ts` 接入点；扩展 `tests/desktop-round3.smoke.mjs`、`tests/desktop-sessions.smoke.mjs`。

**规模:** 约 800–1,100 行。

- [ ] 子会话页只呈现对应历史/最终结果；返回父页恢复原阅读位置。子 agent 卡片与文本只接收对应增量，父子不能共享一个 live 缓冲。
- [ ] 本轮改动、预览联动和结束状态保持；打开/定位仍经 bridge。
- [ ] 文案键化；旧绑定删除；兼容 id 更新。
- [ ] 运行 `node scripts/run-tests.mjs tests/desktop-round3.smoke.mjs tests/desktop-sessions.smoke.mjs tests/desktop-react.smoke.mjs`。

### M7: 外壳接管、CSS 退役、清理与验收

#### T24: 应用外壳接管与旧 CSS 退役

**Files:** 完成 `ui/App.tsx`、`ui/layout/DesktopShell.tsx`；精简 `renderer.ts`、`index.html`；按 §10 调整六份旧 CSS 与 `ui/styles.css`；扩展 `tests/desktop-layout.smoke.mjs`、`tests/desktop-react-motion.smoke.mjs`。

**规模:** 约 800–1,200 行（其中 CSS 删除远大于新增）。

- [ ] 移除 RegionHost/portal 区域适配，由同一根内的 App/DesktopShell 接管 `index.html` 的整页结构；保留单 provider 和所有业务状态。移除旧 body grid 的干扰，修复 AppShell 偏移、高度、overflow 及 portal 样式，核对 HTML 只有一个 `main` landmark。
- [ ] 接通产品中的 PageTransition 与各面板过渡，覆盖聊天/设置/设置分类/已有侧栏显隐和消息容器首次出现。验证返回聊天恢复锚点、草稿和附件，动画中快速切换或关闭窗口不遗留过期回调。
- [ ] 按 §10 完成 CSS 清单、删除与预算：完成时六份旧 CSS 合计 ≤ 1,200 行，不含已迁移区域 `#id` 规则；记录每份删减行数与 `!important` 计数变化。
- [ ] 确认 `index.html` 的静态文案已键化（T2 脚本 + 人工复核），`index.html` 与 `ui/` 无产品中文字面量。
- [ ] 构建后运行 `node scripts/run-tests.mjs tests/desktop-layout.smoke.mjs tests/desktop-react-motion.smoke.mjs tests/desktop-react.smoke.mjs tests/desktop-launcher.smoke.mjs`；验证桌面启动、缩放窗口、面板切换无 React warning/未处理 Promise/意外 CSP violation。

#### T25: Slot、遗留清理与旧测试迁移

**Files:** 完成 `ui/slots.tsx`；精简 `renderer.ts`；删除实际无消费者的旧 renderer 与迁移适配器；迁移 `tests/slots.test.ts` 契约断言；扩展 React/motion smoke。

**规模:** 约 600–900 行（含测试迁移）。

**Interfaces:** `renderer.ts` 只创建 runtime/actions、启动唯一 `createRoot`、在 DesktopProviders 内挂载 App、退出时 `root.unmount/runtime.dispose`。Slot 保持架构约定的五种 context 和注册/注销语义。

- [ ] 先用测试锁定 Slot 排序、同序稳定、动态注册、注销幂等、不重复挂载，以及 message/panel 的类型不能混用；React root 卸载后无订阅和定时器残留。
- [ ] 移除旧整页 render、全局 select upgrader 和 React 区域的翻译 walker 依赖；i18n 中面向 main process 的 `mainText/setMainLocale` 继续可用。若旧渲染豁免已无匹配项，连同理由更新 i18n gate，不保留失效豁免。
- [ ] 原测试若直接 import 已退役的 `setup*` 或读取旧源码字符串（`plan-contract`、`sandbox-setup-renderer` 等未在前序任务点名的测试），迁移到纯模型/真实 React 页面断言；保留同等行为覆盖，不靠重导出旧 UI、删断言或 skip 来过门禁。
- [ ] 用 `rg` 搜索旧 setup、`document.getElementById`、`replaceChildren`、`new MutationObserver`、`addEventListener` 的剩余引用，逐项说明归属；允许 DOM 岛和基础工具，不允许隐藏的第二套页面实现。
- [ ] 兼容 id 登记表清零（§11），并删除 `tests/compat-ids.test.ts` 中的过程中断言，保留“表为空”断言。
- [ ] 构建后运行 `node scripts/run-tests.mjs tests/slots.test.ts tests/compat-ids.test.ts tests/desktop-react.smoke.mjs tests/desktop-react-motion.smoke.mjs tests/desktop-layout.smoke.mjs tests/desktop-launcher.smoke.mjs tests/desktop-capabilities.smoke.mjs`。

#### T26: 完整验收与交付记录

**Files:** 按需更新 `README.md`、桌面架构相关现有文档、由 `npm run docs:generate` 更新的事实表，以及新增 `docs/validation-desktop-react-migration-YYYY-MM-DD.md`（实施当天替换日期）。

**规模:** 文档与证据为主，约 1–2 天。

- [ ] 对照完整模块表逐行填写实际目标文件与结果，确认隐藏功能的处理。检查 Electron/main/preload、协议、数据文件和模型/沙箱行为没有随迁移漂移。
- [ ] 使用真实 Electron 检查浅/深/系统主题、中英文、各字号和当前测试覆盖的窗口尺寸；与迁移前截图比较，记录 Mantine 统一控件引起的预期变化，以及实际修复的布局偏移。保留原有信息结构、品牌和可用空间，不以像素不同直接判失败或忽略真实遮挡。
- [ ] 正常动效与 reduced-motion 两套模式都验收页面切换、设置分类、已有侧栏、菜单/弹窗、折叠和新消息首次出现；覆盖快速反向切换和窗口关闭。记录短录屏或开始/中间/结束帧证据，另以真实断言确认最终焦点、草稿和锚点；单张最终截图不能证明动画通过。
- [ ] 核验未打包与打包资源中的 `renderer.css/ui.css` 均存在，离线启动无外部资源请求；真实 CSP 下没有意外样式拒绝、内联脚本放行或升级后的安全设置变化。
- [ ] 记录四项可复核指标：i18n 覆盖率（`ui/**` 中文字面量 = 0，`t()` key 缺失 = 0）、旧 CSS 行数（≤ 1,200）与 `!important` 计数变化、renderer bundle 大小（迁移前/后，同构建参数）、冷启动到可输入与长历史初次显示时间（同夹具、同机器，各测 3 次取中位数）。发现回退须定位处理并重跑相关项。
- [ ] 先运行必要的定向测试，再依次执行下列最终命令；全部通过后不无故重复全量测试。

```powershell
npm run docs:generate
npm run check
npm run smoke:desktop
```

- [ ] `npm run check` 已包含格式、文档、引用、循环、分层、i18n、类型、lint、隔离、全量行为测试、构建和 compiled-client smoke。记录每条命令退出码、测试通过/失败/跳过数、源码 commit/diff 标识和环境。
- [ ] 在现有 CI 平台矩阵上验证桌面 smoke；真实 Windows 沙箱账号项仅在其既有 CI 条件下运行。Electron 不可启动、平台不支持或账号用例跳过时，明确写“未验证”与原因，不能写全平台验收通过。
- [ ] 保留 `artifacts/` 或现有测试产物中的截图/报告路径；交付剩余限制、未实施的隐藏功能和必要后续项，不删除其他任务的修改或冻结 benchmark 证据。

## 验收矩阵

| 类别           | 必须得到的结果                                                                  | 主要证据                                              |
| -------------- | ------------------------------------------------------------------------------- | ----------------------------------------------------- |
| 工具链         | `.tsx` 被类型、lint、分层、循环和 i18n 检查覆盖；分层 gate 有独立测试           | T1 夹具与静态检查                                     |
| 状态与生命周期 | 快照不倒退、切片引用稳定、订阅不重复、卸载无回调                                | runtime 单测 + React smoke                            |
| 通用组件       | 主题、键盘、焦点、portal 和翻译正常                                             | React smoke + layout/i18n                             |
| 布局与主题     | 单一 AppShell/provider，三种主题与字号统一，portal 不分叉                       | theme/layout + React/motion smoke                     |
| 动效           | 时长统一、快速切换以最新目标为准，reduce 即时收敛，草稿/焦点/锚点保持           | 正常及 reduce 模式的 motion smoke + 中间帧证据        |
| 样式与 CSP     | 本地 CSS 完整，静态 nonce 三方一致，授权 style 生效，未授权 style/script 仍被拒 | T3 真实 Electron CSP 测试 + 一致性单测                |
| i18n           | `ui/**` 与 `index.html` 无产品中文，key 全部存在，动态文案走 `format()`         | T2 覆盖率测试 + `desktop-language.smoke.mjs`          |
| CSS 退役       | 六份旧 CSS ≤ 1,200 行，无已迁移区域 `#id` 规则，`!important` 无净增             | T24 清单与计数报告                                    |
| smoke 迁移     | 兼容 id 清零，断言用 role/label/可见值表达同等行为                              | `tests/compat-ids.test.ts` + 各套件                   |
| 设置           | 保存失败可恢复，连续修改不乱序，面板互斥                                        | pending 单测 + settings/maintenance                   |
| 会话与输入     | 多会话运行、排队/停止、IME、完整导出、附件竞态正常                              | composer/sessions/attachments 单测 + sessions/history |
| 工作区与任务   | 过期异步结果隔离、失败可重试、确认草稿保留                                      | loading/task-confirm + workspace/workflows            |
| 消息与流式     | 100ms 合并、历史 DOM 复用、父子频道隔离、锚点稳定                               | stream/transcript 单测 + desktop smoke                |
| 业务一致性     | 自动验证、内部上下文隐藏、权限、恢复、备份和通知保持                            | 原有相关行为测试与 smoke                              |
| 最终形态       | 单一 React 根/provider/AppShell、五个 Slot 保留、无活动旧页面 renderer          | 模块清单审计 + slots/launch                           |
| 平台与发布     | 既有安装/启动路径保持，支持平台验收结果如实记录                                 | check、desktop smoke、CI 记录                         |

## 接手 agent 的启动说明

可直接把下面内容连同本文件路径交给实施 agent：

> 请执行 `docs/superpowers/plans/2026-10-26-desktop-react-typescript-migration.md`（v2）。先读完全部规格、里程碑与任务，检查实际 HEAD 和 dirty diff；当前模型/上下文等并行修改须已提交，否则停在 M0 报告清单。按 M0→M7 顺序推进，每个任务只覆盖一个页面/面板，超过 1,200 行或跨两个页面必须先拆子任务并记录。样式 CSP 采用**构建期静态 nonce**：只改 `index.html` 与 provider，不改 `main.ts`、不拦截 `file:`；每次加载轮换仅在 §8 的条件成立时实施。逐区域完成时同步做三件事：文案键化、兼容 id 登记与 smoke 断言迁移（先加 React 断言再删旧断言）、旧 CSS 规则删除与记账。每阶段保持应用可运行并记录测试证据。统一采用 React + TypeScript + Mantine + Motion，布局使用 AppShell，控件使用 Mantine Core，按动效表实现页面和面板过渡。测试正常动效和减少动态效果，不能关闭测试动画后声称动效通过，也不能以 React 空壳或设置页试点代表全量迁移完成。不要创建本机 Windows 沙箱账号，不要修改业务内核或 frozen benchmark 证据。最终交付代码、逐模块迁移结果、i18n/CSS/bundle 指标和完整验收记录与未验证项。

## 官方参考

- [React：在现有项目逐步接入](https://react.dev/learn/add-react-to-an-existing-project)：用于设置页等区域的渐进迁移。
- [React：useSyncExternalStore](https://react.dev/reference/react/useSyncExternalStore)：外部 store 的订阅、缓存快照与清理约束。
- [React：useEffect](https://react.dev/reference/react/useEffect)：组件订阅/清理与开发期重复挂载行为。
- [React DOM：createRoot](https://react.dev/reference/react-dom/client/createRoot)：区域挂载、单根与 unmount。
- [esbuild：JSX](https://esbuild.github.io/content-types/#jsx)：沿用现有构建并支持 TSX/automatic JSX。
- [Mantine：AppShell](https://mantine.dev/core/app-shell/)：应用布局、导航/主区/侧栏和区域显隐。
- [Mantine：MantineProvider](https://mantine.dev/theming/mantine-provider/)：单一 provider、主题与 `getStyleNonce`。
- [Mantine：Color schemes](https://mantine.dev/theming/color-schemes/)：浅/深/系统主题和客户端配置。
- [Mantine：Styles](https://mantine.dev/styles/mantine-styles/)：本地 CSS 入口与加载顺序。
- [Mantine：Transition](https://mantine.dev/core/transition/)：弹层内置过渡的范围和复杂动画的分工。
- [Motion：React](https://motion.dev/docs/react)：`motion/react` 入口和动画能力。
- [Motion：AnimatePresence](https://motion.dev/docs/react-animate-presence)：视图退出/进入动画的生命周期。
- [Motion：Accessibility](https://motion.dev/docs/react-accessibility)：减少动态效果设置及相应处理。
- [Electron：protocol](https://www.electronjs.org/docs/latest/api/protocol)：仅在启用每次加载轮换时需要的受限文档 handler。
- [Electron：net.fetch](https://www.electronjs.org/docs/latest/api/net)：委托内置 protocol 处理及避免递归；非默认 Session 使用对应 `session.fetch`。
