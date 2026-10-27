# 桌面端验收问题修复记录（2026-10-28）

基线：`d97cf42`，`main`。用户要求修复上一轮验收发现的问题；本轮不推送、不发布，不运行会清理本机既有沙箱账号的安装/卸载流程。

## 1. 测试进程清理误报

历史 `test-workflow` 强制结束的测试后代只留下 owner-start，未记录 owner-exit。清理程序原先仅用 `kill(pid, 0)` 判断遗留；Windows 已把旧 PID 分配给其他进程时，新的无关进程会被计入 remaining。虽然身份检查阻止了误杀，整套门禁仍会因误报中断。

修复仅在 WMI 成功查询、创建时间明确晚于旧登记窗口时退役该旧登记。查询失败、超时、无效时间或缺少身份信息仍按未确认处理；真实遗留进程即使成功终止，该次测试仍失败。没有增大超时、把用例移入串行或跳过泄漏检查。

- RED：Run `1793142418382-28452-9e8ba0fb-999a-4a53-a9d9-b450f7c136f4`，PID 复用回归失败，其他 2 项通过。
- GREEN：`test-isolation` 和 `test-workflow` 两文件 54/54；补充身份查询失败保护后 `test-isolation` 26/26（Run `1793142566283-35732-6661485c-2156-4b05-9144-d523b043b869`）。
- 历史 29444 的 WMI 结果未保存，不能直接证明它已被复用；该机制与历史时间线一致，并已用真实活进程确定性复现和回归。

## 2. 打包版早期崩溃

同轮新包原样启动再次复现 `0x80000003`。`icacls` 显示生成的 `YuanTu Agent.exe` 继承 Low mandatory label；开发 Electron 则为 Medium。仅将已核实、无重解析点的生成目录恢复为 Medium 后，沙箱开启的打包窗口和独立 Host 均启动成功，确认了本次故障来源。

持久修复放在 electron-builder 的 Windows beforePack：只给 release 输出目录和 appOutDir 设置可继承 Medium 标签，不递归修改源码、工作区或已有沙箱授权目录，不更改 DACL、CSP、sandbox 或 webSecurity。重打包后 Electron 和 bundled Node 都继承 Medium。

新增真实令牌回归：在私有夹具的 Low 父目录下生成程序，运行复制的 Windows 身份程序检查 SID。修复前令牌为 `S-1-16-4096`、Medium 断言失败；修复后为 `S-1-16-8192`，同级目录的程序仍保持 Low，证明没有修改父目录。

- RED：Run `1793142678047-4876-095e7401-5e82-4dfd-ad46-f3ffc12f98cb`。
- GREEN：完整性回归与 Windows runtime 两文件 8/8（Run `1793142765260-4464-943415f7-4ded-492d-b1c8-ba3f4ea58e5a`）。

## 3. 添加非法工作区的错误回执

打包验收发现 `projects.add` 返回 `register()` 的异步拒绝越过 try/catch，IPC 直接抛错而非返回标准 `{ ok: false, error }`。对显式路径和原生选择器两个分支补充 await，使验证错误进入原有错误回执。

包内原代码的安装目录拒绝断言已复现失败；修复后开发版真实窗口的缺失目录回归和原项目流程均通过，Run `1793142849071-29972-7c7695ab-f2f1-4fc6-9681-c1de46aab2c5`，1/1。

## 4. 工作区恢复测试的后台 Git 所有权

无打包负载复跑 Run `1793143408485-34708-8bc1580b-1537-4702-915d-14b2c8656f7a` 中，客户端取消测试已通过，未出现 PID 清理误报，但恢复测试的 after hook 报目录 EBUSY。`openHostServices` 会异步启动仓库清理；原测试直接在当前进程打开服务，业务断言完成后即删目录，后台 Git 仍可能占用 cwd。

将该恢复测试的真实服务启动放进短命 Node 子进程，等待其自然退出、事件循环内的后台操作结束并在 beforeExit 关闭数据库后，再释放夹具目录。保留原恢复数据断言，不新增生产测试专用 API，不增加删除重试或改变并行策略。

受控诊断给真实后台 Git 调用添加 2 秒延迟并保持原 cwd：旧夹具稳定复现 EBUSY，修复后同样装置 1/1 通过；证据为 `.scratch/recovery-red.log` 和 `.scratch/recovery-green.log`。

修复后该文件 22/22 通过（Run `1793143873625-24668-b04c4adc-c094-419d-9abf-821ff4bca96e`，91.92s）；Prettier、ESLint、TypeScript 和 diff 检查通过。独立增量评审确认原断言和观察时点保留，错误没有被吞掉。

完整继续执行所有文件后，又发现 `host-carrier` 的 hostless 监听测试在 SIGKILL 主进程后立即删 cwd，同样可能撞上仍在运行的 Git 后代。该夹具改为使用已有客户端进行真实 token 鉴权，调用正常停止协议，等待最初捕获的 ChildProcess close 及零退出后才删目录。正常路径不再强杀进程；失败回收只使用已经持有的子进程句柄。

同时补齐既有打包钩子夹具的真实 `appOutDir` 字段，并在 Low 私有夹具目录中调用真正的 beforePack，再运行输出程序验证 Medium SID；权限设置仅限该私有夹具。两处夹具修复与完整性回归合计 21/21 通过（Run `1793144722567-9732-fe05dc92-a4b6-483c-937e-bf6cd0eeb7c0`），独立增量评审无问题。

## 5. 自动验收入口

新增 `npm run smoke:windows-package`：使用独立 `.scratch/windows-package-smoke-*` profile，显式检查没有 no-sandbox、应用窗口 sandbox/contextIsolation 开启、nodeIntegration 关闭；等待实际完成的 IPC 快照确认 Host 就绪，避免异步 waitForFunction 误判。

四次启动覆盖默认 userData/workspace、安装目录拒绝、会话改名持久化、中文空格路径的显式工作区、重启恢复注册表选中项；每次退出确认 Host 结束。成功保存 screenshot 和 result.json；失败保存 failure.log。不依赖真实模型，不运行沙箱账号初始化或卸载。

## 6. 最终门禁与产物

- `npm run package:windows`、`npm run check:windows-package`、`npm run smoke:windows-package` 依次执行，整体退出码 0。四次启动全部通过，result 位于 `.scratch/windows-package-smoke-WwreNc/result.json`；`packaged.png` 已人工核对，应用正常显示且 Host 就绪。
- 最终安装包：`dist/release/YuanTu-Agent-0.1.0-windows-x64-setup.exe`，164371734 字节；SHA-256：`d12c0658dc3d5d6f67db4a2c9417f621e198315279697d28f648534bb65d5b25`。bundled Node 24.19.0 的校验值仍为 `3602f2bb1a10f2cbab4c36886218a33c1ab3db87290e73b033c46c77147d0237`。
- 独立只读代码评审：无 Critical、Important 或需记录的 Minor。未判断的安装/跨平台场景仍归下面的环境限制；进行中的完整门禁不由评审代替。
- 完整 `npm run check` 的并发尝试 Run `1793143020085-19220-2c601ff3-3e74-45c5-bd10-2d9f7cedac2a` 暴露 `client.test.ts` 的取消测试在 `client.start()` 的 host.info 握手阶段超时，未进入取消逻辑。该次与 NSIS 压缩并行；后续无打包负载的完整复跑中该测试通过，没有修改其启动预算。
- 使用 `FOUNDRY_TEST_CONTINUE_ON_FAILURE=1` 跑完全部 336 文件的中间运行 `1793144065711-32976-e23d85c1-e910-411b-9ffa-d0f950da37d5` 为 3363 通过、2 失败、31 跳过；失败仅为上述 hostless 清理和旧钩子夹具，两处随后均已修复。该次记录仍按失败保留，不将定向通过改写为当次全量成功。
- **最终完整 `npm run check` 退出码 0**，日志 `.scratch/acceptance-fixes-check-20261028-verified.log`；仍使用 CI 的失败后继续策略，保持原并行数、超时与跳过规则。format/docs/references/cycles/layers/i18n/typecheck/lint/test-isolation 全部通过。
- 最终单测 Run `1793144897935-12636-e6f1000b-f3c5-486e-a703-32600d34d737`：336 文件、3396 测试；并行 3339 通过 / 18 跳过，串行 26 通过 / 13 跳过；合计 **3365 通过、31 跳过、0 失败**。并行 wall 484.22s，串行 87.28s；没有进程清理误报或目录 EBUSY。
- 最终 build 通过；编译客户端冒烟 3/3，通过 Run `1793145483800-35784-86c75de5-7dee-44dc-9c20-d7988a465470`，退出码 0。

安装/真实安装版升级/卸载、真实 Windows 沙箱账号隔离、macOS、实体触摸及多显示器 DPI 仍按原环境边界补验；这些未运行场景不因修复本轮两个故障而改记为通过。产物沿用未签名配置，本轮未发布。
