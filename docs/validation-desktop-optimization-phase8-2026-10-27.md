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

## 2. `npm test` 结果

- 执行 334 个测试文件；并行阶段报告 1360 个测试。
- 1354 通过，5 跳过，1 失败。
- 失败：`tests/windows-shell.test.ts:156 cancelling a command while PowerShell is still starting it leaves no program behind`，断言 `late-2.txt`、`late-3.txt`、`late-5.txt` 未出现，实际出现。该用例与桌面端 UI、注册表或浏览器改动无交集。
- 单独重跑该文件：7/7 通过（11.0s），判定为并行负载下的时序抖动；尚未修改测试。

因 `npm test` 失败，后续 `npm run build` 与 `npm run smoke:client` 未在本轮 `check` 中执行；它们在之前的定向构建/冒烟中已分别通过。

## 3. 定向验证（本轮及此前）

- `desktop-sessions.smoke.mjs` 6、`desktop-layout.smoke.mjs` 4、`desktop-browser.smoke.mjs` 1 通过。
- `project-workspaces-store` 6、`project-workspaces-path` 5、`workspace-host-manager` 5、`browser-url` 2、`workspace-panel-loading` 14 通过。
- 项目列表重命名、注册表启动写入、浏览器 guest 隔离与关闭销毁均有 smoke 断言。

## 4. 未完成

- 完整 `npm run check` 的绿跑（需在低负载下重跑，或先稳定 `windows-shell` 取消用例）。
- 完整 `npm run smoke:desktop`（新增 `desktop-browser.smoke.mjs` 后尚未整套执行）。
- Phase 6 的 Host 路由集成：`WorkspaceHostManager` 已有单测，但 `main.ts` 仍是单 `service` 全局。
- Phase 7 剩余：每工作区独立会话列表、两级折叠、触摸/键盘完整行为、运行中移除保护。
- 打包/安装场景与跨平台手工记录。

## 5. 复现命令

```powershell
npm run check
node scripts/run-tests.mjs tests/windows-shell.test.ts
```
