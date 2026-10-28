# 桌面 React 迁移最终验收（2026-10-27）

**结论：迁移完成，本记录是可复核的交付证据。** React + TypeScript 迁移的 M1–M7 任务全部落地；产品由单一
React 根渲染，六份旧 CSS 退休，兼容 id 表清零，翻译 walker 与 select upgrader 删除。保留的过渡形态
（内容 DOM 岛、休眠 MCP 面板）在下方明确列出，不是遗漏。本文保留当时的验收结果与限制，已完成的计划和进度文档已清理。

## 1. 环境与基线

| 项       | 值                                                                                                                                                                                                           |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 基线提交 | `34a8ace`（M7 开始前，clean worktree）                                                                                                                                                                       |
| 交付分支 | `feat/desktop-react-completion`                                                                                                                                                                              |
| 迁移提交 | `033327b` 外壳、`2f5ef5d` CSS/全局改写退役、`cd74b1b` 页面过渡、`41eb844` 生命周期、`a718424` slots、`0756a12` 任务定义编辑器、`853a4d4` 触发编辑器、`7ecf759` 兼容表/DOM 审计、`c2c7a36` 折叠动画与身份证据 |
| 平台     | Windows（本机），Node 24.19、Electron 43、Chromium 由 Electron 内置                                                                                                                                          |
| 构建     | `npm run build`（tsc + esbuild；无 Vite/PostCSS 开发服务器，无外部字体/CDN）                                                                                                                                 |

## 2. 命令与结果

| 命令                                            | 退出码             | 结果                                                                                                                    |
| ----------------------------------------------- | ------------------ | ----------------------------------------------------------------------------------------------------------------------- |
| `npm run format:check`                          | 0                  | 全仓库格式                                                                                                              |
| `npm run docs:check`                            | 0                  | 先运行 `npm run docs:generate` 刷新 README 事实块                                                                       |
| `npm run references:check`                      | 0                  |                                                                                                                         |
| `npm run cycles:check`                          | 0                  |                                                                                                                         |
| `npm run layers:check`                          | 0                  | 含 `.tsx` 边界规则                                                                                                      |
| `npm run i18n:check`                            | 0                  |                                                                                                                         |
| `npm run typecheck`（`tsc --noEmit`）           | 0                  | 覆盖 `apps/**/*.tsx`                                                                                                    |
| `npm run lint`                                  | 0                  |                                                                                                                         |
| `npm run test:isolation:check`                  | 0                  |                                                                                                                         |
| `npm test`                                      | 未整体通过（见下） | 默认并行两次分别命中既有负载敏感用例；`--concurrency=4` 复跑在 44/327 文件后被运行器进程清理中止（该批 561 条全部通过） |
| `npm run build`                                 | 0                  | tsconfig.build + esbuild；renderer.js / renderer.css / ui.css / index.html                                              |
| `npm run smoke:client`（`compiled-client` 3/3） | 0                  | 编译后的客户端夹具                                                                                                      |
| `npm run smoke:desktop`                         | 0                  | **18 套件 76 通过 / 0 失败 / 3 跳过**（Chromium 未安装、MCP 超出当前产品范围、backups 范围外）                          |
| `npm run acceptance:desktop`                    | 0                  | 9 张截图 + `summary.json`（指标/动效/文档事实）                                                                         |

**关于全量 `npm test`**：两次默认并行运行分别失败在
`tests/windows-shell.test.ts`（“取消仍在启动的 PowerShell 不留下进程”，实际写出 late-2/6.txt）与
`tests/swe-bench.test.ts`（真实 Host 的 `run.interrupted` 时序，`undefined !== true`）；两个文件单独运行均通过
（7/7、19/19），失败只出现在高并发负载下，属既有 flake，与本轮改动无关（迁移前记录
`docs/validation-…` 也记录过同类 swe-bench 时序 flake）。`--concurrency=4` 的复跑没有断言失败：44 个文件、
561 条测试全部通过后，运行器在清理 `host-carrier-auth` 的进程树时报
`Process cleanup failed`，因此没有完整的 327 文件汇总。按计划“记录退出码与测试数、不如实写成通过”的要求，
这里不把全量套件记为通过；逐区域证据见下。

### 定向批次（本轮运行的桌面与模型测试）

| 套件               | 结果                                                                                                                                                                                                                                                                              |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 桌面 Electron 冒烟 | agent 7/7、desktop 9/9、sessions 6/6、history 2/2、language 7/7、layout 4/4、settings 8 通过 + 1 个既有 MCP 跳过、capabilities 3/3、workflows 4/4、launcher 1/1、motion 5/5、navigation 2/2、React 6/6、identity 1/1、round3 1 通过 + 1 个 Chromium 跳过                          |
| 模型/视图单测      | stream 10/10、transcript 7/7、scroll-anchor 5/5、turn-changes 6/6、subagent 5/5、question 9/9、approval 2/2、task-view 11/11、plan-contract 10/10、session-panels 4/4、statistics 9/9、background 7/7、workspace-loading 12/12、attachments 10/10、sessions 10/10、composer 18/18 |
| 契约/门禁单测      | slots 6/6、compat-ids 2/2、ui-i18n-coverage 2/2、i18n-gate 14/14、runtime 13/13、theme 4/4、desktop-copy 14/14、schedule-draft 6/6、diff-view 6/6、render-caches 2/2、windows-shell 7/7、swe-bench 19/19                                                                          |

## 3. 视觉证据

`artifacts/desktop-react-acceptance-2026-10-27/`（由 `npm run acceptance:desktop` 生成，见 `scripts/desktop-acceptance.mjs`）
包含 9 张真实 Electron 截图与 `summary.json`：

| 截图                                                      | 覆盖                                    |
| --------------------------------------------------------- | --------------------------------------- |
| `screens/chat-light-zh.png`                               | 浅色 + 中文 + 1280×800 默认             |
| `screens/chat-dark-zh.png`                                | 深色 + 中文                             |
| `screens/chat-system-dark-zh.png`                         | 跟随系统（系统深色）                    |
| `screens/chat-light-en.png`                               | 英文界面（内容仍是用户原文）            |
| `screens/settings-small-zh.png` / `settings-small-en.png` | 设置页 + 小字号，中/英两套文案          |
| `screens/chat-large-zh.png`                               | 大字号                                  |
| `screens/chat-min-window-zh.png`                          | 最小窗口 820×560，单列、无横向溢出      |
| `screens/workspace-open-zh.png`                           | 工作区面板打开（树/预览区域，滚动可用） |

与迁移前对比：仓库没有保留迁移前的像素基线截图，因此不声称逐像素一致。已核对的预期变化是 Mantine 统一控件带来的
按钮/输入/弹层外观；信息结构（导航、会话列表、标题、状态、输入区、工作区）与品牌保持一致。截图同时人工核对了浅/深/
系统三套配色、中英两套文案、字号与最小窗口下无遮挡/溢出。

## 4. 动效证据

- **折叠动画**（`tests/desktop-react-identity.smoke.mjs`，1/1 通过，真实 Electron）：逐帧采样折叠容器高度，打开是
  ≥3 个中间帧、总爬升落在 60–420ms 区间（`MOTION.panel` = 180ms）；关闭到 0 后才移除 `open`；`prefers-reduced-motion`
  下中间帧 ≤1。
- **页面过渡**：`desktop-react-motion` 5/5（帧采样，含 reduce 与运行中切换 reduce）、`desktop-react-navigation`
  （正常/减弱动效下的页面切换、快速反向、草稿/锚点/附件保留）。验收脚本另外记录了打开设置的 `PageTransition`
  逐帧 opacity 曲线（`summary.json` → `metrics.motion.settingsEnter`，0 → 1 约 11 帧）。
- **流式身份**：同一 smoke 比较若干 delta 前后 `#live` 宿主、`#live-reasoning` 折叠与答案 `.message-content` 的对象
  身份不变，并用 MutationObserver 断言内容元素从未被移除重建。

## 5. 资源、CSP 与打包

- **未打包资源**（`dist/desktop`）：`index.html`（1,001 B）只引用 `./renderer.css`（Mantine，280,201 B）与
  `./ui.css`（应用样式，104,707 B），顺序为先 Mantine 后应用；两个文件均存在。`document.externalRequests = false`，
  没有 http(s) 资源引用。
- **CSP**：`default-src 'self'; script-src 'self'; style-src 'self' data: 'nonce-b7Qm2xL9pR4sT1vW'; …`，
  无 `unsafe-inline`/`unsafe-eval`，静态 nonce 恰 1 个，与 `ui/nonce.ts`、meta 三方一致（`desktop-react-csp` 2/2）。
- **离线**：验收脚本与全部桌面冒烟都以本地 `dist/desktop/index.html` 启动，`connect-src 'none'`，无外部请求。
- **打包产物**：`electron-builder.config.cjs` 的 `files` 含 `dist/desktop/**/*` 且 `asar: false`，上述两个样式表会
  进入安装包；但 `dist/release/win-unpacked` 现有产物是 2026-10-26 的迁移前包（含六份旧 CSS、无 `ui.css`），
  不能用于本轮验收。**本轮未重新打包**：`npm run package:windows:dir` 需要 `.scratch/packaging/runtime` 的已准备
  Windows 运行时（本机当前缺失）。因此打包资源记为“未验证”，复核命令为
  `npm run package:windows:dir` 后检查 `resources/app/dist/desktop/ui.css` 与 `renderer.css`，而不是沿用旧包结论。

## 6. 四项可复核指标

| 指标                        | 迁移前                                                                    | 迁移后                                                                                        | 说明                                                                                                                             |
| --------------------------- | ------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| i18n 覆盖率                 | —                                                                         | `scanI18n` 0 问题；`ui/**` 中文字面量 0；未知 `t()` key 0                                     | `npm run i18n:check`、`tests/ui-i18n-coverage.test.ts`、验收脚本 `metrics.i18n`                                                  |
| 旧 CSS 行数                 | 6 份合计 5,983 行、29 个 `!important`                                     | 6 份合计 6 行（各 1 行说明）、0 个 `!important`                                               | 目标 ≤1,200 行；`tests/desktop-style-budget.test.ts`；应用样式表 `ui/styles.css` 6,172 行、25 个 `!important`                    |
| renderer bundle             | `renderer.js` 777,485 B；`index.html` 30,170 B；六份旧 CSS 合计 128,540 B | `renderer.js` 2,545,572 B；`renderer.css` 280,201 B；`ui.css` 104,707 B；`index.html` 1,001 B | 迁移前取自 `dist/release/win-unpacked`（2026-10-26 14:55 打包产物，M7 之前）；增长来自 React 19 + Mantine + motion 进入 renderer |
| 冷启动到可输入 / 长历史首屏 | 未记录                                                                    | 中位 1,358ms / 95ms（3 次）                                                                   | 同一夹具、同一机器；长历史为 150 条消息的会话，从点击会话到首条消息出现                                                          |

## 7. 已知差异与未验证项

1. **内容 DOM 岛**：消息正文、工具卡、Markdown、diff 正文与完成块仍是 DOM 岛（计划允许）；归属见
   `docs/desktop-react-dom-audit-2026-10-27.md`。
2. **休眠 MCP 面板**：`renderer-mcp.ts` 仍为 legacy，但 `PRODUCT_SCOPE.mcpManagement = false`，入口不渲染、
   `settings.smoke` 跳过该用例。重新启用前需迁移为 React（计划 T13 记录的偏差）。
3. **CI 平台矩阵**：本轮只在本机 Windows 上执行；其他平台与 CI 矩阵未验证，不声称全平台通过。
4. **打包产物**：见第 5 节的打包说明；未重新打包时明确标注为未验证，而不是沿用旧包结论。
5. **像素基线**：没有迁移前截图可直接对比；只对比结构、主题、语言与尺寸可用性，并记录 Mantine 控件带来的预期差异。

## 8. 复核命令

```powershell
npm run build
node scripts/run-tests.mjs tests/desktop-react-identity.smoke.mjs tests/desktop-react-motion.smoke.mjs tests/desktop-react-navigation.smoke.mjs
npm run acceptance:desktop
npm run smoke:desktop
npm run check
```
