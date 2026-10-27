# 桌面端优化 Phase 0 验证记录

> 日期：2026-10-27
> 方案基线：`b58a8cc`；Phase 0 开始时 HEAD：`fa60730`（方案修订已提交）
> 环境：Windows 10.0.26300，Node v24.19.0，Electron 43.5.0，Playwright 1.63.0
> 本文只记录实际执行的检查；未执行的 DPI、焦点、白闪和多屏场景在 §4 保留为后续工作。

## 1. 结论

- `WebContentsView` 的创建、`contentView` 挂载、`setBounds`/`getBounds`、`setVisible`/`getVisible`、`webContents` 导航与 `close()` 在本机可用。
- 沙箱 guest 中 `typeof require === 'undefined'` 且 `window.yuantu === undefined`，符合方案的 guest 安全底线。
- Playwright 1.63 的 `app.windows()` 与 `app.context().pages()` 会暴露 `WebContentsView` 的 guest 页面；`title()`、`locator()`、`click()` 可直接驱动。Phase 4 的浏览器 smoke 可以主要使用 Page API，视图数、bounds、可见性和 sandbox 标志用主进程 `app.evaluate` 读取；仅测试环境的主进程探针保留为兜底。
- 安装目录不能作为默认工作区：`prepareUpgrade` 的 app/data 目录 overlap 预检会直接拒绝，已增加回归测试。方案已改为 `<userData>/workspace`。
- 单 Host 依赖已清点，多 Host 改造点见 §2.3。

## 2. 命令与结果

### 2.1 `WebContentsView` 与 guest 测试驱动 spike

本地脚本（未提交，放在 `.scratch/`）：

```powershell
node .scratch/spike-webcontentsview.mjs
```

脚本在真实 Electron 窗口中创建 `WebContentsView`、加载 `data:` 页面，并检查 guest 与 Playwright Page：

```text
OK host: file:///E:/agent-desktop/YuanTu-Foundry/dist/desktop/index.html
OK create-view: {"id":2,"bounds":{"x":20,"y":20,"width":200,"height":120},"visible":true,"children":1}
OK guest-execute: "SPIKE-TITLE|undefined|undefined"
OK playwright-windows: ["file:///.../index.html","data:text/html,<title>SPIKE-TITLE</title>..."]
OK playwright-context-pages: [host, guest]
OK playwright-guest-locator: {"title":"SPIKE-TITLE","button":"hit","body":"hit"}
OK guest-click: "SPIKE-TITLE"
OK cleanup-view: {"children":0}
```

结论：

- guest 页面能作为 Playwright Page 取得，`locator('#b').click()` 和 `title()` 生效；不需要先写测试专用 IPC 才能操作 guest。
- guest 的 `require` 和 `window.yuantu` 均为 `undefined`；这只覆盖了 `sandbox: true`、`contextIsolation: true`、`nodeIntegration: false`、无 preload 的临时视图，正式视图仍需在 Phase 4 用同样的断言回归。
- `setVisible`、`setBounds`、`contentView.removeChildView` 和 `webContents.close()` 都按预期工作；视图挂载数为 1，关闭后回到 0。
- 本 spike 没有覆盖层叠顺序、键盘焦点、白闪、DPI 缩放、副屏和最小化恢复；这些留到 Phase 4 的定向 smoke 与手工验证。

### 2.2 安装目录与升级 overlap 守卫

```powershell
node scripts/run-tests.mjs tests/desktop-upgrade.test.ts
```

结果：16 个用例全部通过（新增 1 个回归用例）。

新增用例：`preparation refuses a workspace that is the application directory`，把会话库放在安装目录内，断言 `prepareUpgrade` 以 `/overlap/` 拒绝。对应实现：

- `packages/maintenance/desktop-upgrade.ts` 的 `overlap(installed, workspace)` 检查；
- `apps/desktop/main-upgrade.ts` 传入 `path.dirname(app.getPath('exe'))` 与 `workspace/.yuantu/sessions.sqlite`。

这条证据确认了方案评审中的阻塞项：默认工作区不能落在安装目录。方案已改为 `<userData>/workspace`，并要求显式参数也拒绝安装目录及其子目录。

### 2.3 单 Host 依赖清点

主进程的全局状态：

- `apps/desktop/main.ts`：`service`、`snapshotSender`、`pendingState`/`pendingFlush`、`choices`、`runNotifier`、`switching`、`quitting`；`chooseWorkspace` 在运行/排队时拒绝切换；设置命令直接使用 `service`。
- `apps/desktop/main-context.ts`：`service` 的 live getter、`createService`、`attach`、`assertSender`，以及 `switching`/`quitting` 的 setter。
- `apps/desktop/main-upgrade.ts`：读取 `ctx.service` 的 snapshot/busy 状态，升级前停止 service。
- `apps/desktop/main-notifications.ts`：全局 `runNotifier`，从快照更新通知状态。
- `apps/desktop/main-hook-trust.ts`、`apps/desktop/main-attachment.ts`：只依赖窗口/worker，不直接持有 service。
- `SessionChoices`：通过 getter 绑定单个 `service`。

结论：多 Host 需要按 `workspaceId` 拆分 `CarrierService`、`SnapshotSender`、`SessionChoices`、`runNotifier` 和 Host epoch；`main.ts` 的全局绑定要收敛到 `WorkspaceHostManager`，并逐个迁移 `main-upgrade` 等直接读取 `ctx.service` 的模块。

## 3. 方案调整

- 默认工作区从“安装目录”改为 `<userData>/workspace`；安装目录及其子目录禁止注册为工作区。
- 旧工作区发现顺序明确为：显式参数 → `<userData>/workspace` → 首次默认；旧版本没有最近工作区记录，显式参数用户需带参数启动一次或重新添加。
- §9.2 的 guest 测试说明改为“Playwright 可直接取得 guest Page，主进程 evaluate 读取视图状态，测试探针兜底”。
- Phase 0 估算从 0.5–1 人日调整为 1–1.5 人日；总量相应调整。

## 4. 未覆盖与后续

- `WebContentsView` 的层叠、焦点、白闪、100%/125%/150% DPI、副屏、最小化/隐藏恢复：Phase 4。
- 正式浏览器视图的权限、下载、弹窗、持久分区和生命周期：Phase 4。
- Playwright 暴露 guest Page 属于实现细节；Phase 4 固定 Playwright 版本，并保留主进程 `app.evaluate` 的兜底断言，避免升级后测试失效。
- 多 Host 的 snapshot/delta 路由、审批、通知、设置和退出：Phase 5–7。
