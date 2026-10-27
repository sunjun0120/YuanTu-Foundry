# 桌面端优化 Phase 8 验证记录（进行中）

> 日期：2026-10-27
> 代码基线：Phase 7 项目列表提交 `f06a585`（工作区另有三个与本轮无关的未提交文件）
> 本文记录实际的完整门禁尝试；未完成的部分不勾选。

## 1. 已通过的门禁

`npm run check` 在进入 `npm test` 前的各步均通过：

- `format:check`
- `docs:check`
- `references:check`
- `cycles:check`（561 files，1439 value edges，0 cycles）
- `layers:check`（18 packages / 4 apps，719 ordered imports）
- `i18n:check`
- `typecheck`
- `lint`
- `test:isolation:check`（0 violations）

## 2. `npm run check` 结果

第二次完整执行通过（`exit code 0`）：

- 前置门禁：`format`、`docs`、`references`、`cycles`、`layers`、`i18n`、`typecheck`、`lint`、`test:isolation` 全部通过。
- 并行测试：3347 个，3329 通过，18 跳过，0 失败。
- 串行测试：32 个，19 通过，13 跳过，0 失败。
- `npm run build` 通过（Host bundle 6.05 MB）。
- `npm run smoke:client`：3/3 通过。
- 跳过项均为平台/外部依赖条件（真实 Windows 账号、Chromium、macOS 等），不是通过的替代。

第一次尝试曾在 `tests/windows-shell.test.ts` 的 PowerShell 取消时序用例上失败；该文件单独重跑 7/7 通过。第二次完整运行未复现，记录为并行负载下的时序抖动，尚未修改该用例。

## 3. 完整桌面冒烟

`npm run smoke:desktop`（18 个套件）通过：

- 78 个测试：77 通过，1 跳过，0 失败。
- 跳过项：`desktop-round3` 的“opens Chromium and saves a screenshot”，原因是本机未安装 Chromium。
- 总 wall time 约 312 秒。
- 覆盖 `desktop.smoke`、`desktop-i18n`、`desktop-sessions`、`settings`、`workspace-ui`、`desktop-browser` 等；项目列表/`#choose-workspace`/`#workspace` 兼容钩子均由这些套件实际执行。

## 4. 定向验证（本轮及此前）

- `desktop-sessions.smoke.mjs` 6、`desktop-layout.smoke.mjs` 4、`desktop-browser.smoke.mjs` 1 通过。
- `project-workspaces-store` 6、`project-workspaces-path` 5、`workspace-host-manager` 5、`browser-url` 2、`workspace-panel-loading` 14 通过。
- 项目列表重命名、注册表启动写入、浏览器 guest 隔离与关闭销毁均有 smoke 断言。

## 5. 未完成

- Phase 6 的事件路由：`WorkspaceHostManager` 已保留旧 Host，主进程订阅所有 Host，项目列表显示 `running`/`waiting` 标记并列出各工作区最近会话；快照与审批操作仍只路由给 active Host，后台审批处理未完成。
- Phase 7 剩余：两级折叠、触摸/键盘完整行为；每工作区会话列表已接入。
- 打包/安装场景与跨平台手工记录。

## 6. 复现命令

```powershell
npm run check
npm run smoke:desktop
node scripts/run-tests.mjs tests/windows-shell.test.ts
```
