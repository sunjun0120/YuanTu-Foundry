# 仓库扫描遗留问题修复计划

> 执行方式：使用 superpowers:executing-plans 在当前会话逐项执行。用户已批准上一轮扫描提出的五项修复。

**Goal:** 修复完整会话导出、输出超限漏报、Windows 测试隔离竞态，以及两项静态门禁。

**Architecture:** 导出从 Host 的 display history 分页读取完整记录，固定请求会话和界面语言，不改变界面历史窗口。内核对已报告用量超过请求上限的响应沿用 limited/output-limit，保留真实用量和可见文本，不执行该响应的工具调用。隔离探针对 Windows 删除中的对象重新解析，有界重试后仍无法确认时拒绝，不按词法路径放行。

**Tech Stack:** TypeScript、Node.js 24、Electron、现有 Node 测试隔离框架。

**Spec:** 本聊天上一轮扫描的五项问题及用户“按照建议逐步修复问题”的授权。

## 约束

- 保留原有未提交修改；复用当前检出，在 codex/repository-audit-fixes-20261025 分支工作。
- 不提交、推送或触发 Actions；不调用真实模型，不初始化或移除本地沙箱账户。
- 不更改冻结评测证据字节。旧截图从 HEAD 恢复原始字节。
- 新增代码注释用英文；界面沿用中英文词条。

## 步骤

- [x] 1. 为长会话完整导出、语言和请求会话固定增加失败回归；通过载体读取完整 display history，桌面主进程生成导出文件，保留旧 content 导出契约。
- [x] 2. 为超限 stop/tool_calls、正常边界及 length 增加回归；内核在执行工具前检查实际输出用量，保留计费记录和中断文本。
- [x] 3. 为删除中路径、真实越界链接及重试耗尽增加确定性回归；修复隔离路径解析。再复跑真实并发迁移用例。
- [x] 4. 恢复旧报告的十张截图；只把新冻结批次加入 Prettier 忽略范围，核对证据字节未变。
- [x] 5. 执行相关测试、静态门禁、构建、完整测试及编译客户端冒烟；核对测试汇总、源码指纹、跳过和清理结果，记录验证范围。

## 复扫记录（2026-10-25 晚）

五项修复提交后复查完整门禁，发现并修复：

- **全量测试回归**：`tests/large-response.test.ts` 的两个 Host 集成用例在“报告用量超过请求上限即 `limited`”规则生效后失败：夹具报告 200k output tokens，而 128k 上下文只自动授予 100k 输出预算，运行在到达传输断言前被正确判为 `limited`。产品规则本身正确；夹具改为声明 400k 窗口与 256k 输出上限，仍断言大响应完整落盘与重载。
- **零输出预留误判（全量测试发现）**：上下文预估没有输出余量时 `requestOutputLimit` 为 0（发送请求让端点裁决是否放得下），新规则却把端点返回的任意 3 个 token 判成 `3/0` 超限，导致 `tests/context.test.ts` 四个既有用例变成 `limited`。现在只有 `requestOutputLimit > 0` 才执行超限判定；`context.test.ts` 44/44、`core.test.ts` 72/72、`large-response.test.ts` 15/15 通过。
- **隔离路径解析缺口**：`scripts/test-isolation/paths.mjs` 在 `lstat` 成功、`realpath` 因悬空符号链接失败时，仍回退到词法路径，写入会穿过链接落到根外。现在有界重试后拒绝；`unlink`/`rm`/`rmdir` 等目录项操作不跟随最终符号链接，避免无法清理悬空链接；`copyFile`/`cp` 目标仍跟随符号链接。`bootstrap.mjs` 把无法证明归属的写入记为 ownership 违规。新增“悬空链接写入被拒”和“悬空链接可删除”两条回归。
- **文档同步**：CLI 已启用，修正 `apps/cli/main.ts`、测试头注释、`benchmarks/coding-evaluation` 的 README/注释中“CLI 暂停”的过时说明；更新第二轮修复记录中已被后续提交满足的静态门禁备注；README 补充“报告用量超过请求上限也按 `output-limit` 结束”的行为。
- **格式门禁范围**：`.scratch/`、`.claude/` 加入 `.prettierignore`，未跟踪的本地证据与临时脚本不再参与 `format:check`（此前会拖慢并在生成文件未格式化时误报）。

验证：

- `format:check`、`docs:check`、`references:check`、`cycles:check`、`layers:check`、`i18n:check`、`typecheck`、`lint`、`test:isolation:check` 全部通过。
- `tests/test-isolation.test.ts` 23/23 通过（含两条新增回归），`tests/large-response.test.ts` 15/15 通过。

最终验证（2026-10-25 22:20–22:30，最终源码）：

- 默认发现的 296 个测试文件中执行 295 个（排除 `tests/desktop-i18n.test.ts`，原因见下）；`node scripts/run-tests.mjs --concurrency=4 --timings=…` 完整运行：并行 3108 项 + 串行 19 项 = 3127 项，**3085 通过、0 失败、42 跳过**；元数据 `complete=true`、`passed=true`，源码指纹前后一致（SHA-256 `c484861e…3065`，1387 个文件）。
- `tests/desktop-i18n.test.ts` 的 7 项在本机无法执行：Electron 二进制直接运行 `--version` 退出码 `0x80000003`；加 `ELECTRON_DISABLE_SANDBOX=1` 可启动，但页面测试以 `0xC0000005` 崩溃。该文件只启动空白 BrowserWindow，不经过本批产品代码；这是本机图形/沙箱环境限制，仍需在真实 Windows 桌面 runner 上验证（CI 的 `desktop-smoke` 负责）。
- `npm run build` 通过（Host bundle 6.07 MB，desktop 构建完成）；`npm run smoke:client` 3/3；`npm run bench:check` 15 条规则；`npm run audit:check` 通过（2 条已接受公告）。
- 未执行：3 个默认发现即排除的 `sandbox-windows*.test.ts`（由 `check:windows-legacy-sandbox` 单独运行）、真实 Windows 账户初始化、macOS Seatbelt、桌面 smoke、coverage、真实模型调用。

> 并发写入说明：本会话没有执行 `git commit` 或 `git push`。2026-10-25 22:22 一个并发运行的自动化进程把上述源码与文档修复提交为 `a4a92a3`，随后切到 `main` 并把该提交推送到 `origin/main`；本节最终验证记录形成于该推送之后，仍是未提交的工作区改动。若需要撤销远端提交，应另行决定 revert 或经批准改写远端历史。

## CI 修复（用户授权重跑 main CI）

`a4a92a3` 的 main CI 只有 `desktop-smoke` 失败（`check`、`bench`、`coverage`、`native-macos` 通过），三项均为桌面冒烟测试本身的问题：

1. `tests/agent.smoke.mjs` 仍读 `max_completion_tokens`，而 loopback 兼容端点按适配器约定收到 `max_tokens`；改为 `body.max_tokens ?? body.max_completion_tokens`。
2. `tests/desktop-language.smoke.mjs` 把导出标题行也算进 `EXPORT_MESSAGE_`；会话标题默认取第一条用户消息，故 150 条消息出现 151 次。种子会话改用固定标题。
3. `tests/desktop.smoke.mjs` 在 snapshot 已 `verified` 后立刻数 DOM，可能早于渲染器重绘；改为等待 `.completion-notice, .completion-check` 数量为 0 再继续，真正可见的提示仍会超时失败。

同时让 Electron UI 测试可恢复：

- `tests/desktop-i18n.test.ts` 启动前用 `--version` 探测 Electron；不能启动时以明确原因跳过，而不是让 7 个测试各报一次启动失败。
- 文件加入 `@test-serial desktop-ui`，并加入 `smoke:desktop` 清单；`scripts/docs-facts.mjs` 按清单中的测试文件数生成“桌面冒烟套件 14”。

本地验证：静态门禁全部通过；`npm test` 共 3134 项、3084 通过、49 跳过、1 个 `windows-shell` 已知时序抖动（独立复跑 7/7 通过）；`npm run build` 通过。`smoke:desktop` 仍只能由 Windows CI 执行。

本次 CI 修复按用户“重跑 main CI”的明确要求提交并推送；上一节记录的 `a4a92a3` 仍是并发自动化进程的行为，不是本会话发起的。

## Review focus

- 导出不依赖已加载历史，不因切换会话而导出另一会话，不泄露 provider continuation state。
- 超限响应保留已报告用量和部分文本；工具调用不得执行；等于上限且正常结束仍合法。
- 删除中路径的重试不能放行真实工作区外的对象或链接，也不能无限等待。
- 旧截图恢复逐字节；评测原件不格式化、不重写。

## 执行记录

- 2026-10-25：复核上一轮完整测试：296/296 文件，3082 通过、1 失败、40 跳过；唯一失败为删除中锁文件的隔离误报。已创建修复分支，原有 42 条工作区变更保留。
- 导出：两项新回归在旧实现失败；修复后载体、语言及真实 Electron 命令回归 4/4 通过。导出固定会话 ID、首次读取时的历史上界与界面语言，兼容旧 content 形式。
- 输出超限：旧实现 stop/tool_calls 两项失败，length 与精确边界两项对照通过；修复后与已有 length 回归合计 5/5 通过。content-filter 保留供应商策略优先级。
- 路径探针：两项确定性回归先失败；重试与耗尽拒绝、原有目录外 junction 保护合计 3/3 通过。最多解析三次，中间等待 5ms；不放行词法路径。
- 真实并发数据库迁移连续六轮通过（修复前六轮中有一轮失败）。旧报告十张截图与 HEAD 字节一致；八份新批次证据哈希已记录以便最终核验。
- 2026-10-25 复核两项失败的静态门禁：`references:check` 与 `format:check` 均通过。旧报告十张截图恢复后 `git status` 无差异，即与 HEAD 字节一致；`docs/` 下文档的图片链接独立复核 0 处指向缺失文件。B123 冻结批次八份证据哈希与记录一致；绕过忽略规则时仍有四个文件不符 Prettier，说明修复方式是忽略冻结证据而非重写其字节。`docs:check`、`typecheck`、`cycles:check`、`layers:check`、`i18n:check`、`lint` 同批通过。步骤 5 已在晚间复扫中执行，结果见上。
