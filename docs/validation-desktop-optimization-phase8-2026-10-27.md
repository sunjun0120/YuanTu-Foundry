# 桌面端优化 Phase 8 验证记录（进行中）

> 日期：2026-10-27
> 代码基线：跨项目等待汇总提交 `f96e8a0`（工作区另有三个与本轮无关的未提交文件）
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

最新完整执行（`65d3602` 之后）通过（`exit code 0`）：

- 前置门禁：`format`、`docs`、`references`、`cycles`、`layers`、`i18n`、`typecheck`、`lint`、`test:isolation` 全部通过。
- 并行测试：3340 个，3322 通过，18 跳过，0 失败。
- 串行测试：39 个，26 通过，13 跳过，0 失败。
- `npm run build` 通过（Host bundle 6.05 MB）。
- `npm run smoke:client`：3/3 通过。
- 跳过项均为平台/外部依赖条件（真实 Windows 账号、Chromium、macOS 等），不是通过的替代。

`tests/windows-shell.test.ts` 的取消时序用例曾在并行阶段两次失败、单独运行通过；现以 `@test-serial windows-sandbox` 移入串行阶段，仍执行同一取消竞态，7/7 通过。此前 `d099209` 基线的完整绿跑为并行 3329 通过 / 18 跳过、串行 19 通过 / 13 跳过。

在跨项目等待汇总提交 `f96e8a0` 之后再次完整执行，结果与上表相同：并行 3322 通过 / 18 跳过，串行 26 通过 / 13 跳过，build 与 `smoke:client` 通过。

## 3. 完整桌面冒烟

`npm run smoke:desktop`（18 个套件）通过：

- 78 个测试：77 通过，1 跳过，0 失败。
- 跳过项：`desktop-round3` 的“opens Chromium and saves a screenshot”，原因是本机未安装 Chromium。
- 总 wall time 约 312 秒。
- 覆盖 `desktop.smoke`、`desktop-i18n`、`desktop-sessions`、`settings`、`workspace-ui`、`desktop-browser` 等；项目列表/`#choose-workspace`/`#workspace` 兼容钩子均由这些套件实际执行。

## 4. Windows 打包

`npm run package:windows:dir` 成功：

- 构建 sandbox account executor（exec/broker/runner 与 account maintenance）。
- 完成 Host bundle、desktop build、bundled Node 24.19.0（libuv 1.52.1）与 win32-x64 search asset。
- electron-builder 26.15.3 产出 `dist/release/win-unpacked`（Electron 43.5.0，x64）。
- `npm run check:windows-package` 通过，校验打包 Node 的 SHA-256 为 `3602f2bb1a10f2cbab4c36886218a33c1ab3db87290e73b033c46c77147d0237`。

打包后验证通过（CDP，手动运行）：

- 使用仓库内可写的 `user-data-dir` 与 workspace，并清除继承的 `YUANTU_*` 环境变量后，`win-unpacked/YuanTu Agent.exe` 正常启动。
- 通过 `--remote-debugging-port` 连接后：窗口标题 `YuanTu Agent`，项目列表 1 项，`#workspace` 指向测试 workspace，Host 日志 `host.ready`，`snapshot` 返回 `ok`。
- 早先的 `0x80000003` 退出是启动环境问题：`user-data-dir` 位于临时目录时 SingletonLock/DevToolsActivePort 报 access denied，且继承了开发期的 `YUANTU_NODE_PATH`；不是包内容损坏。

尚未自动化：该验证目前是手动 CDP 脚本，未纳入 `smoke:desktop`；安装/升级/卸载与 macOS 仍未验证。尝试把这套 CDP 流程写成 `desktop-packaged.smoke.mjs` 时，test-isolation 的写入所有权与 Windows 打包进程无法在测试临时 profile/workspace 上创建锁文件（或 Host 报 EACCES）冲突，未能稳定，已移除该尝试，未把不稳定测试留在仓库。

## 5. 定向验证（本轮及此前）

- `desktop-sessions.smoke.mjs` 6、`desktop-layout.smoke.mjs` 4、`desktop-browser.smoke.mjs` 1 通过。
- `project-workspaces-store` 6、`project-workspaces-path` 5、`workspace-host-manager` 5、`browser-url` 2、`workspace-panel-loading` 14 通过。
- 项目列表重命名、注册表启动写入、浏览器 guest 隔离与关闭销毁均有 smoke 断言。

## 6. 未完成

- Phase 6 的事件路由：`WorkspaceHostManager` 已保留旧 Host，主进程订阅所有 Host，项目列表显示 `running`/`waiting` 标记、跨项目等待汇总，并列出各工作区最近会话；等待会话、等待项目名或汇总按钮会切到该工作区并加载会话，再由 active Host 的审批面板处理。后台审批的就地处理/队列仍未完成。
- Phase 7 剩余：系统化键盘/触摸验收；每工作区会话列表、项目级折叠、粗指针悬停操作与键盘 Enter/焦点显示已有覆盖。
- 打包产物已生成、包内容校验通过，打包后窗口已手动 CDP 验证；安装/升级/卸载场景、打包验证自动化与 macOS 记录未完成。

## 7. 复现命令

```powershell
npm run check
npm run smoke:desktop
node scripts/run-tests.mjs tests/windows-shell.test.ts
```
