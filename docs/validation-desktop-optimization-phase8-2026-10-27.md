# 桌面端优化 Phase 8 验证记录

日期：2026-10-27。接手基线 `ac9d988`，原有修改先提交为 `dbc8357`，接手实现提交为 `94bfc06`；所有结果来自本地实际运行。实现状态见 [交付记录](2026-10-27-desktop-optimization-delivery.md)。

> 后续修复：以下保留 2026-10-27 的历史运行结果。2026-10-28 已确认并修复 Low 完整性标签导致的包启动崩溃，沙箱开启的四次启动验收通过；进程清理及工作区恢复夹具也已补回归。最新门禁结果见 [验收问题修复记录](validation-desktop-acceptance-fixes-2026-10-28.md)。

## 1. 全量单测与桌面冒烟

全量单测命令：`npm test -- --continue-on-failure`，退出码 0。

- Run：`1793115111922-1560-adb56fa1-2cf2-423a-b99f-4f3191ba34fa`。
- 335 文件；并行 3353 项：3335 通过、18 跳过；串行 39 项：26 通过、13 跳过。共 3361 通过、31 跳过、0 失败。
- 日志保存在 `.scratch/test-logs/<run>-*.log` 及对应 NDJSON 中。真实账号、macOS 等条件跳过不计为通过。

完整桌面冒烟命令：`npm run smoke:desktop`，退出码 0。

- Run：`1793115097958-17292-3ac04679-101f-4766-ac2b-3e3f01ce6675`。
- 19 文件、79 测试：78 通过、1 跳过、0 失败；wall 536.94s。
- 跳过：`desktop-round3` 的 Agent Host Chromium 截图用例，本机未安装 Chromium。内置 WebContentsView 浏览器冒烟已执行并通过。
- 新增 `desktop-projects` 实际验证 A 后台等待、B 保持可见并回答 A、权限恢复、跨 Host 模型目录、两级折叠、粗指针目标、移除忙碌项拒绝、最后移除空态、数据库保留和重新添加恢复历史。

## 2. 回归修复与最后布局检查

- 独立评审的五项 Important 已修复：Host 权限标签复用、空闲回收重查、升级检查全部 Host、模型目录同步、启动中移除与关停竞态。对应路由/manager/升级守卫及真实 Electron 回归已执行。
- 全量运行曾暴露 `storage-rules` 1ms 时钟假设：改为验证时间戳处于操作前后时间区间。SWE 取消夹具在并发负载下 5s 预算于会话创建前耗尽，改为 30s，原取消确认和清理断言保留；生产存储与 benchmark 代码未更改。
- 原冒烟断言随界面所有权更新：目录错误由 `.project-error` 展示；工作区新建按钮 aria-label 含工作区名，避免与顶部入口重名。
- 布局初次复验 Run `1793115994239-6908-321867bb-dc86-416c-a1a9-5c265ca2438f`：5/5。截图人工核对另发现旧 `.session-sidebar-root` 的 flex 简写覆盖会话整行布局，新增位置断言于 Run `1793116182843-8840-6c765648-a95b-49ac-ae21-3ec150faec9f` 确认失败，随后修正选择器优先级。
- 最后布局回归 Run `1793116230749-408-7060f214-5c8a-4943-ba1e-bfa5dde21ea2`：项目 1/1、布局 4/4，退出码 0；新的标题/列表位置断言通过。人工核对 `project-sidebar.png`，列表已显示在标题下，底部设置入口可见；`project-pending.png` 已核对工作区分组和完整问答卡。

## 3. 完整门禁复跑

`npm run check` 的 format/docs/references/cycles/layers/i18n/typecheck/lint/test-isolation 全部通过；cycles 为 563 files、1450 value edges、0 cycles，test-isolation 为 0 violations。

但该次命令最终退出码为 1，不能记为完整通过：Run `1793116145878-9708-cdbb0a53-f15b-44f8-90dd-2af426b72de9` 在 20/335 文件后因 `test-workflow.test.ts` 的进程清理报告 `remaining: [29444]` 中断。已完成的 387 项断言通过，无断言失败。检查时该精确 PID 已不存在；没有修改清理规则或强杀不明身份进程。

该文件随后单独复跑：Run `1793116443983-9072-7ce152ba-0d04-4282-a10b-fd08a2106bca`，29/29、退出码 0。此前 §1 的全量单测已完整通过。这些结果不能把后一次中断的 `check` 退出码改记为 0。

另行执行 `npm run build` 和 `npm run smoke:client`，均退出码 0；Host bundle 6.05 MB，编译客户端 3/3（Run `1793116486133-33932-ab35c4e0-9bae-47b9-9f07-6e1a4755303c`）。该构建包含最后的列表布局修复。

最后代码和文档更新后，format/docs/references/lint 再次执行并通过；原生测试临时目录的遍历需要正常用户环境，受限账号尝试曾报 EPERM，未更改这些目录的权限。`git diff --check` 通过。

## 4. Windows 包内容与启动

已执行 `npm run package:windows`：原生 executor、TypeScript、Host bundle 和桌面构建成功。受限环境在运行复制出的 Node 时以 `0xC0000142` 退出；正常用户环境执行相同 `prepare-windows-package.mjs` 通过，随后继续 copy-search-assets、electron-builder NSIS、write-release-manifest 和 `check:windows-package`，退出码 0。

- 产物：`dist/release/YuanTu-Agent-0.1.0-windows-x64-setup.exe`，并生成 blockmap 和 checksum manifest。
- Electron 43.5.0；bundled Node 24.19.0 / libuv 1.52.1，Node SHA-256：`3602f2bb1a10f2cbab4c36886218a33c1ab3db87290e73b033c46c77147d0237`。
- 打包配置仍为 `signExecutable: false`；产物未签名，未发布。
- 新包启动尝试：`.scratch/takeover-packaged-smoke.mjs`，独立 `.scratch/packaged-takeover-chvxk0` profile，清除开发期 YUANTU/CODEX/NODE 环境变量，正常用户环境启动，保持沙箱开启；进程在窗口/CDP 出现前以十进制 2147483651（`0x80000003`）退出，stderr 为空。
- 本记录纠正此前结论：旧 `.scratch/spike-packaged-cdp.mjs` 成功运行使用了 `--no-sandbox`，不能据此断言正常打包启动已通过，也不能断言根因已经排除。新失败尚未定位到具体系统或应用原因，未为通过测试添加安全降级。
- 最后布局样式修正后再次执行 electron-builder NSIS、write-release-manifest、`check:windows-package`，退出码 0。最终安装包 164371724 字节，SHA-256：`5d03779ba692e0068853448ad4c67dbf3a1a1a026d17b557a341bfa43c826c13`；unpacked 包中全部桌面 CSS 与最后 build 逐字节一致。启动失败记录来自同轮重打包前的启动尝试，最终只增加布局样式修正，未将启动验收记为通过。

## 5. 明确未执行的验收

- 安装、真实安装版升级/回滚与卸载：本机已有源图沙箱组及两个账号；NSIS 卸载脚本会清理全局沙箱账号，因此没有用当前机器做安装/卸载实验。需在可丢弃 Windows runner 补验；后台 Host 升级 busy 守卫已有单测覆盖。
- Windows 真实账号隔离强度：按既有项目边界仅在明确启用的可丢弃 CI 执行，本地跳过不替代验收。
- macOS、实体触摸、100%/125%/150% DPI 和高 DPI 副屏尚未验收。已执行键盘操作和 CDP 粗指针仿真。
- 打包程序沙箱开启的窗口启动尚未通过；不能将包内容校验等同于可运行安装版验收。

## 6. 复现命令

```powershell
npm run check
npm run smoke:desktop
node scripts/run-tests.mjs tests/desktop-projects.smoke.mjs tests/desktop-layout.smoke.mjs
npm run package:windows
npm run check:windows-package
```
