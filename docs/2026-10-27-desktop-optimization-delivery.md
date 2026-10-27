# 桌面端优化交付记录（2026-10-27）

> 代码分支：`main`（本轮未推送）
> 完整门禁基线：`f96e8a0` 之后的 `be184ba` 记录；并行 3322 通过 / 18 跳过，串行 26 通过 / 13 跳过，0 失败。
> 本记录只描述已提交内容；三个与本任务无关的未提交文件未纳入交付。

## 1. 需求状态

| 需求                   | 状态         | 主要提交 / 说明                                                                                                                                                |
| ---------------------- | ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R1 模型选择器宽度      | 完成         | `f21354e`；标签宽度 72–360，紧凑与 rightSection 适配                                                                                                           |
| R2 移除会话 ID         | 完成         | `61f88b9`；侧栏与 composer 不再显示短 ID                                                                                                                       |
| R3 未命名会话标签      | 完成         | `61f88b9`；空标题统一为“新增会话”                                                                                                                              |
| R4/R7 固定标签与新建页 | 完成         | `1779595`；`new`/`files` 固定、`+` 选择器、文件/浏览器标签                                                                                                     |
| R5 内置浏览器          | 完成         | `3d4e500`；独立 WebContentsView、地址栏/历史/错误/POST/弹窗/清理                                                                                               |
| R6 语法高亮            | 完成         | `e2deaef`；共享 hljs 注册表、语言识别、64 KiB 上限                                                                                                             |
| R8 多工作区            | **部分完成** | 注册表、启动恢复、项目列表、独立 Host 保留、后台运行/等待标记、每项目会话入口、跨项目等待汇总、折叠；**后台审批就地处理与 renderer 按 workspaceId 路由未完成** |

## 2. 已实现的多工作区能力

- 注册表 `project-workspaces.json`：原子写、串行化、损坏/future schema 拒绝覆盖。
- 启动解析：显式 `--workspace=` / `YUANTU_WORKSPACE`，否则注册表 active，否则默认 `<userData>/workspace`。
- 原生添加、重命名、软移除、`lastSessionId` 记录、collapse 持久化。
- `WorkspaceHostManager`：按需启动/复用、epoch、active、失败清理、空闲释放、adopt、stopAll。
- 项目切换保留旧 Host；主进程订阅所有 Host，左侧显示 running/waiting、最近会话、跨项目等待汇总。
- 等待会话/项目/汇总可切到对应工作区并加载，由 active Host 审批面板处理。

## 3. 验证

- `npm run check`（`65d3602` 之后）：format/docs/references/cycles/layers/i18n/typecheck/lint/test-isolation 全通过；并行 3322/18，串行 26/13，0 失败；build 与 `smoke:client` 通过。
- `npm run smoke:desktop`：18 套件、78 测试、77 通过、1 跳过（未安装 Chromium）、0 失败。
- Windows 打包：`package:windows:dir` 成功；`check:windows-package` 通过；打包窗口已手动 CDP 验证（Host ready、项目 1、snapshot ok）。
- 细节与未完成项见 `docs/validation-desktop-optimization-phase8-2026-10-27.md`。

## 4. 未完成（不得宣称 R8/Phase 8 全部完成）

- 后台审批不能就地处理：必须切到对应工作区，由 active Host 审批面板处理；renderer 仍只接收 active Host 快照。
- 系统化触摸验收（触摸目标尺寸、长按、滚动）未做。
- 打包验证自动化、安装/升级/卸载、macOS 手工记录未做。
- 沙箱真实账号、Chromium 截图等跳过项需在具备外部条件的机器补验。

## 5. 复现

```powershell
npm run check
npm run smoke:desktop
npm run package:windows:dir
npm run check:windows-package
node scripts/run-tests.mjs tests/desktop-sessions.smoke.mjs
```
