# 第二轮报告问题修复记录

> 日期：2026-10-25。基线：`91fa342`。依据：[2026-10-25-desktop-real-models-round2.md](2026-10-25-desktop-real-models-round2.md)。
> 范围：只修桌面产品问题，不做外部模型/网关治理。

## 修复清单

| #   | 问题                                                                                 | 修复                                                                                                                                                             | 回归测试                                                                                                                                     |
| --- | ------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `/plan` 的 `exit_plan_mode` 审批问题卡无法提交，报“会话操作正在进行，请稍候。”       | `packages/carrier/service.ts`：`questionAnswer`、`approve`、`cancel` 三类交互在 `plan` 持有 `managing` 时放行；`restoring` 仍拦截                                | `tests/carrier.test.ts` 新增“a managing command cannot close the door on the answer it is waiting for”；真实桌面提交成功并写入 `notes.md`    |
| 2   | 模型设置输出上限在 DeepSeek 官方端点被忽略（只发 `max_completion_tokens`）           | `packages/providers/openai.ts` 新增 `outputTokenField()`：`api.openai.com` 用 `max_completion_tokens`，其余兼容端点用 `max_tokens`                               | `tests/providers.test.ts` 覆盖字段选择与请求体；真实桌面 `maxOutputTokens=64` 时以 `limited` 结束、输出 64 token                             |
| 3   | 深色主题目标面板仍是硬编码浅色                                                       | `apps/desktop/layout.css` 增加 `--goal-*` 主题变量；`layout-surfaces.css` 让 `#chat-page .goal-panel`、标题、目标、状态使用主题色                                | 真实桌面计算样式：背景 `rgb(43,43,47)`、文字 `rgb(233,233,238)`，不再白底                                                                    |
| 4   | `needs_review` 顶部显示英文 “The work ended without executable verification checks.” | `renderer-status.ts` 的 `visibleRunError` 增加 `runStatus`：运行状态为 `needs_review` 时抑制运行自身的英文错误；`renderer.ts` 传入会话状态                       | `tests/desktop-copy.test.ts` 覆盖“completion 为 unverified + 运行 needs_review”与“failed 仍显示”；真实 Kimi 编辑后 `needs_review` 无英文横幅 |
| 5   | README 权限档位/默认值与实际不符                                                     | README 改为四档（仅可查看 / 请求批准 / 帮我批准 / 完全访问权限），默认“帮我批准”；同步命令沙箱段落                                                               | `docs:check`、`references:check`（本报告资源）                                                                                               |
| 6   | `/export` 已移除但 README 称可用                                                     | `renderer-commands.ts` 恢复 `/export` 命令与命令面板入口，复用 `conversationMarkdown` 和主进程保存对话框                                                         | `tests/desktop-i18n.test.ts` 断言 `/export` 命令；真实桌面 mock 保存对话框后写出 Markdown（26,560 字符）                                     |
| 7   | `/goal` 实际创建任务草稿，标签却叫“创建目标”                                         | 菜单改用 `/task`、文案“创建任务草稿”；`/goal` 保留为兼容别名，仍映射到原 task 命令                                                                               | `tests/desktop-i18n.test.ts` 断言 `/task` 与 `/goal` 都返回 goal 命令；真实命令面板显示 `/task` + “任务草稿”                                 |
| 8   | 长问题卡顶部被裁切                                                                   | `layout.css` 给 `.question-card` 加 `max-height: min(60vh, 520px)`、内部滚动与 `overscroll-behavior`                                                             | 真实计划审批卡片 `top=225px`、高 382、内部可滚动                                                                                             |
| 9   | 工具流/输出上限错误仍是英文，HTTP 400 建议误导                                       | `renderer-error-text.ts` 增加工具流、截断流、输出上限和 400 的中文说明；新增 `ui.modelStreamMalformed`、`ui.modelStreamIncomplete`、`ui.outputLimitReached` 词条 | `tests/desktop-copy.test.ts` 覆盖 400、Duplicate tool ID、Incomplete stream、output limit；真实输出上限横幅为中文                            |

## 验证结果

- `npm run typecheck`：通过。
- `npm run build`：通过（Host bundle 6.07 MB，desktop 构建完成）。
- `npm run lint`、`npm run i18n:check`、`npm run docs:check`：通过。
- 本次改动相关测试：`tests/carrier.test.ts`、`tests/providers.test.ts`、`tests/desktop-copy.test.ts`、`tests/desktop-i18n.test.ts` 共 **102 项通过**；`desktop-language.smoke.mjs`（命令面板现含 `/compact`、`/export`、`/task`、`/plan`）**6 项通过**；`tests/desktop.test.ts` **23 项通过**。
- 真实桌面复验：计划审批、`/task` 文案、`/export`、目标面板主题、`needs_review` 提示、输出上限 **6/6 通过**（脚本 `.scratch/desktop-real-models-round2/verify-fixes.mjs`，结果 `results/verify-fixes.json`）。

## 备注

- 验证期间仓库里有其他并发改动（例如 `packages/tools/*`、`tests/sandbox-account.test.ts`、`benchmarks/swe-bench/...`）。全量 `npm test` 仍会在这些文件上出现 `host.info` 启动超时（`host-workflows.test.ts`、`client.test.ts` 等），不是本批修复引入；`format:check` 也仍被 4 个并发生成的 benchmark 文件阻塞。本批改动文件的 lint 与 Prettier 均通过。
- 报告图片已恢复在 `docs/assets/2026-10-25-desktop-real-models-round2/`；上一轮报告图片目录的删除来自其他并发改动，未回滚，因此 `references:check` 仍会报告旧报告的缺图。
