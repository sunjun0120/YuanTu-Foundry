# P2 逐项实施记录（2026-10-07）

依据 [开发建议](development-recommendations-2026-10-05.md)。按用户要求跳过 DEV-12，从 DEV-13 顺序实施；每项独立验证和提交。保留原有文档删除与 build 目录。

| 条目   | 本批范围                                                    | 状态                                            |
| ------ | ----------------------------------------------------------- | ----------------------------------------------- |
| DEV-12 | SSH 远程工作区                                              | 用户要求跳过；没有真实 SSH 验收环境             |
| DEV-13 | 显式选择 LibreOffice PDF 预览，保持现有创作、编辑和默认预览 | 已接线；真实 LibreOffice／视觉验收待环境        |
| DEV-14 | Host v1 协商、错误语义、公开 SDK 与外部示例                 | 已验证                                          |
| DEV-15 | 复用已安装 Host 的 Python SDK                               | 已验证                                          |
| DEV-16 | ACP v1 自动化适配与客户端验收                               | 文本自动化首批已验证；完整 stdio MCP 接入待后续 |
| DEV-17 | 依据同任务测量推进上下文与路由能力                          | 路由声明修正已验证；图片视图优化待进一步测量    |
| DEV-18 | 有限依赖链的契约／生命周期抽取                              | Host 请求生命周期首批已验证                     |

DEV-13：仅显式请求 `backend: libreoffice` 时转换为 PDF；默认 XLSX 仍为数据 HTML，DOCX/PPTX 仍使用原 Office 路径。转换器使用独立配置目录、输入副本、单进程队列、20 MB 输入／输出限制和覆盖等待时间的两分钟预算。取消／超时等待进程树收尾后清理。审批、源文件复核、文件日志和交付验证沿用现有工具管线。当前机器没有 LibreOffice，真实引擎转换和字体／分页视觉验收需另行记录，不能以替代进程测试冒充。

配置 `YUANTU_LIBREOFFICE_PATH` 为可信部署的命令行程序路径，Windows 推荐 `soffice.com`。没有配置时从 PATH 查找。参数和独立配置目录依据 [LibreOffice 官方命令行说明](https://help.libreoffice.org/latest/en-US/text/shared/guide/start_parameters.html)。转换器未宣称为任意恶意文档提供完整操作系统沙箱。

验证：`node --test tests/office-preview.test.ts tests/office.test.ts`（16/16，含真实 Windows 子进程终止、队列取消、拒绝审批和默认 Office 回归）；`npm run typecheck`；生成并核对环境变量文档。受限执行时 taskkill 被权限阻止，提升后的同一测试通过；没有将清理失败降格为成功。

DEV-14：公开 `yuantu-agent/sdk` 入口与声明文件；Host v1 保持旧客户端兼容，新增明确版本 offer、验证和结构化错误。超时、同步发送异常携带未知结果，不自动重放。协议与分页／取消／恢复边界见 [SDK 契约](host-sdk.md)。既有真实 Host 集成测试改从公开入口调用；编译后外部示例另行验收。

DEV-14 验证完成：SDK／真实 Host／socket 客户端 40/40；新旧协议协商真实 Host 复验 1/1；编译后外部 SDK 示例 1/1；typecheck、完整 build 通过。协议仅支持 v1，不宣称未来主版本兼容。

DEV-15：Python 3.11+ asyncio 薄客户端，运行时仅标准库；严格 UTF-8 JSONL、有界帧／事件队列、流式审批、显式取消、历史／游标查询及 async with 收尾。没有请求重放或独立分发 Host。安装示例见 [Python SDK](../sdk/python/README.md)。正常退出不会残留 Host；操作系统强杀应用无法保证执行 finally。

验证：4 项 Python 隔离子进程故障测试通过；真实 Node Host 集成 1/1，覆盖中文流、写审批、历史分页、冷恢复、取消和退出后 PID 消失。全新 `.scratch/dev15-venv` 安装成功，清空 PYTHONPATH 后以已安装包再次完成相同集成 1/1；typecheck 通过。安装构建产物清理后仅提交 SDK 源文件。

DEV-16：官方 ACP SDK 1.7.0 连接文本自动化适配器；建／载入会话、中文流、工具状态和 Host 写审批映射已接线；审批拒绝、未知选项和审批期间取消均证明不写文件。标准客户端传入 MCP 和额外工作区目前明确拒绝，不能计为完整 ACP v1 合规，边界见 [ACP 首批说明](acp.md)。

DEV-13 后续回归：新 preview backend 参数／描述使工具目录增加 233 字符，整轮快照因此变化。完整 JSON 对比确认仅工具目录哈希、缓存前缀标识和由目录大小导出的估计预算变化，转录、实际工具结果和事件类型均一致；重建快照后上下文／整轮回归 67/67 通过。

验证：官方客户端＋真实 Host 4/4，编译适配器入口复验 1/1，typecheck、完整 build 通过。初次入口参数解析错误已定位并修正；失败测试结束后无该测试的适配器进程残留。模型端使用 HTTP fixture；未验收编辑器 GUI 和真实模型 ACP。

DEV-17：视觉布尔别名和未知缓存路由默认能力已修复，76 项配置／provider／Host 回归及 67 项上下文／快照回归通过。依据同任务失败复现处理声明漂移，详细测量边界见 [上下文与路由记录](context-capabilities-2026-10-07.md)。

DEV-18：只抽取 Host request ID／超时／结算生命周期到 HostRequests。stdio 与 socket 保留原有监督、编码、脱敏、取消和未知结果语义；组件只依赖协议契约，没有引入 renderer、SQLite 或第二套 transport。独立测试证明按 ID 结算、拒绝全部请求及迟到响应不会触发第二次结果；现有三入口行为另行回归。

DEV-18 验证：独立请求组件、公开 SDK、真实 Host/socket 和 ACP 共 48/48；typecheck 通过。新模块减少客户端内嵌计时与 pending map 的职责，收益为不加载进程／renderer 即可验证生命周期；数据库格式、工具授权与入口协议未改变。

收尾审查：独立审查确认 ACP 冷启动并发载入会话会重复重放历史，以及 Python 取消未能确认时丢失未知结果语义。新增失败用例复现后，分别把载入锁移到首个异步操作之前，并将取消超时／失败归为携带 `outcome_unknown` 的 `CANCEL_TIMEOUT`／`CANCEL_FAILED`；取消等待任务并读取其异常，避免后台异常泄漏。

历史边界复验还发现大消息分块的分页游标位于末块，适配器原先只读取首块，导致后续历史遗漏。已修正游标更新；官方 ACP 客户端和真实 Host 验证了 15 MB 消息及跨页的 104 条历史完整重放。ACP／Python 定向回归 7/7；重新安装最终 Python 包后，真实 Host 集成与故障契约包装测试 2/2，其中 Python 故障用例为 6/6。

审查中的 LibreOffice 清理风险未在故障注入中复现，保持为真实引擎验收边界，不据此声称已验证所有引擎行为。ACP 客户端 MCP／额外工作区暂不支持的范围已明确记录。

最终入口复验：typecheck、完整 build、format:check、docs:check、i18n:check 通过；编译客户端／公开 SDK 4/4，编译 ACP 入口 1/1，Web 2/2，本地 bench:check 13 条规则通过。桌面模型设置与图片／Office 附件专项 2/2 已在本批完成。

引用检查仍失败 3 处，均为本批开始前已缺失的报告：开发建议引用 architecture-capabilities-2026-10-05.md、capability-comparison-dsh-2026-10-05.md，以及性能实施记录引用 live-model-performance-2026-10-06.md。保留这些工作区删除，不生成替代报告或把引用检查记录为通过。

最终全量回归：`npm test` 共 1475 项，1467 通过、8 跳过、0 失败，耗时约 691 秒。跳过项为未安装／不可用的四个真实语言服务器、当前环境无法触发的缺浏览器分支、未启用的真实 Docker／sbx 验收及 Windows 不适用的 POSIX 权限位检查。它们不计为已验证能力。验证后清理本批 Python venv、安装构建产物和审查临时副本，保留测试证据日志及原有工作区变更。
