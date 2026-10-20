# 桌面自动验证

普通消息输入框和计划执行面板不再提供验收表单。Agent 根据用户需求、项目指导文件和已有测试脚本选择检查，通过 `verify_work` 提交可执行命令及独立的参数数组。Host 为普通请求、批准计划和 Goal 后续运行启用自动验证；专门的 Task 和调用方显式提供的完成契约仍以原有检查定义为准。内嵌调用者可使用 `AgentRunInput.autoVerify` 启用这一流程。

登记检查不会执行命令或授予权限。Agent 结束工作时，现有完成契约执行器通过原有权限和沙箱机制运行检查。断言失败会把真实结果反馈给同一运行，默认最多修复三轮；权限拒绝、超时、环境故障及其他不可修复结果停止运行。检查登记后不能替换成更容易通过的检查。

自动验证保留批准计划的步骤和摘要约束。Agent 通过 `completion_step` 记录步骤进展，不能借检查通过跳过未完成步骤。运行中批准计划时，从下一轮开始提供验证工具。

验证会监测声明的输入路径和文件工具实际修改的路径。未声明输入时，在 Git 工作区内按 Git 自己的视图监测：已跟踪文件加上未忽略的未跟踪文件，`.gitignore` 排除的依赖树和构建产物不读；非 Git 目录回退到排除派生目录和运行时数据库的文件系统遍历。显式声明的路径不受派生目录排除规则影响，但显式命名运行时自己的数据库会被拒绝，而不是静默排除。检查期间和最终清理期间的源文件变化都会使证据失效。后续回合如果修改了工作区，之前的 `verified` 会被标记为 `unverified / superseded`，直到重新验证。

纯问答和只读运行不会强制执行检查。文件工具实际修改项目文件后仍未提交检查的运行会收到一次提醒；`.scratch/` 内的临时诊断探针不计作项目修改。对 Shell、终端、后台命令及 `run_validation`，在首次可能执行命令前和回答前比较工作区内容指纹；项目内容未变化的查询命令不触发验收。指纹沿用完成验证的派生目录和运行时数据库排除规则；扫描失败或不完整时以环境阻塞和未验证状态结束，不追加验收命令，也不会当作已确认修改来豁免调查预算。命令非零退出和扩展屏蔽输出不会抹除已执行命令的事实。执行前被拒绝的命令不触发提醒。该机制不能证明任意外部服务或未报告副作用已经被完整检测。

收到提醒后仍未提供检查时，以 `needs_review` 结束，并保存 `unverified / missing-verification`。提醒以 `<runtime-context>` 注入，不会在对话记录里显示成普通用户消息；被提醒替换的第一次回答会折叠，只保留最终回答。桌面把这个 `needs_review` 当作完成态说明呈现，不占用错误横幅，运行结果仍保留错误文本供 CLI/JSON 读取。

普通调查累计达到 12 个工具轮次或 60 秒模型处理耗时后提醒收敛，达到 20 个工具轮次或 120 秒模型处理耗时后下一次请求只允许输出结论。等待用户审批或回答问题的时间不计入该耗时。时间检查发生在工具轮次结束后，不会中断正在执行的请求或工具；暂存脚本和不断变化的查询不能清空预算。用户补充指令会重置预算，已登记完成契约、实际项目修改、批准计划、Task 和活动 Goal 使用各自的工作流程。沙箱启动失败后，同轮剩余命令标记为未执行并保留阻塞原因，独立文件检查仍会继续；不会自动切换到无隔离环境。错误摘要明确区分环境阻塞与断言失败，Windows 链接保护的拒绝信息包含具体路径。

结果区展示“自动验证 · 检查通过”或尚未验证等状态，可展开查看最近一轮真实退出码和输出。完整各轮证据保留在事件日志，最终结果携带检查证据；重新加载会话后仍可读取。检查通过只证明所选检查及其监测范围，Agent 选择检查的完整性仍需要真实任务评估。

相关实现：[automatic-verification.ts](../packages/core/automatic-verification.ts)、[run-completion.ts](../packages/core/run-completion.ts)、[run-finalization.ts](../packages/core/run-finalization.ts)、[completion-inputs.ts](../packages/core/completion-inputs.ts)、[renderer-transcript.ts](../apps/desktop/renderer-transcript.ts)。回归覆盖：[automatic-verification.test.ts](../tests/automatic-verification.test.ts)、[completion-finalization.test.ts](../tests/completion-finalization.test.ts)、[completion-inputs.test.ts](../tests/completion-inputs.test.ts)、[host-automatic-verification.test.ts](../tests/host-automatic-verification.test.ts)。
