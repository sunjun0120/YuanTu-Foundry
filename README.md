---
description: 'YuanTu Agent 的总览：一次运行的架构、模型协议、工具目录、会话存储、权限边界与全部配置。'
kind: 'project-readme'
---

# YuanTu Agent

独立实现的编程 Agent 内核，四种入口：命令行、JSONL Agent Host、Electron 桌面与 Web。不依赖 Pi（不读 `.pi` 配置或会话），也不依赖 DSH 的包——模型协议、会话存储、工具管线与扩展点都是本项目自己的实现。

需要 **Node.js 24 或更新版本**。工程是 ESM，TypeScript 源码由 Node 的类型擦除直接运行，`npm run build` 的产物只是分发形式。

## 目录

- [概述](#overview)
- [快速开始](#quick-start)
- [架构](#architecture)
- [模型与协议](#providers)
- [工具目录](#tools)
- [工具执行管线](#pipeline)
- [权限、审批与沙箱](#permissions)
- [会话、事件与投影](#sessions)
- [上下文与预算](#context)
- [多 Agent、任务、目标与计划](#collaboration)
- [记忆、知识库与工作区资源](#knowledge)
- [四种入口](#entry-points)
- [配置](#configuration)
- [已知边界](#boundaries)
- [开发](#development)
- [文档索引](docs/README.md)

---

<a id="overview"></a>

## 概述

`packages/core` 是一次运行的唯一所有者：它把会话历史、上下文预算与工具注册表组合成「请求模型 → 执行工具 → 事件落盘」的循环，并在其上提供子代理委派、持久任务、目标续跑与计划模式。工具面由 `packages/tools` 提供，空工作区下发一套基础目录，其余工具（会话查询、技能、任务、MCP、扩展）按宿主与工作区的实际情况追加。会话是 SQLite 里的事件日志（`packages/storage`），界面看到的一切都从日志投影出来，不另存一份状态。宿主进程把内核包成一组 JSON-RPC 方法（`packages/protocol/rpc.ts`），载体（Electron 桌面与 Web）通过 `packages/carrier` 的**一套命令词表**驱动它，CLI 则在进程内直接装配同一套内核。

这套运行时的形状由几个可数的量决定，它们由代码算出而不是写在这里：[生成事实表](#facts)给出工具数、只读工具数、schema 版本、事件类型数与测试规模。

---

<a id="quick-start"></a>

## 快速开始

Windows 使用 PowerShell：

```powershell
cd E:\agent-desktop\agent-test
npm.cmd ci

$env:ANTHROPIC_API_KEY = '你的 API 密钥'
$env:YUANTU_MODEL = '你的接口实际支持的模型 ID'

# 先问端点它究竟提供哪些模型与上下文窗口
npm.cmd run dev -- models

# 窗口必须显式声明，否则运行会被拒绝
npm.cmd run dev -- run "列出项目文件，读取 package.json，解释项目结构" `
  --workspace . --max-context-tokens 200000
```

桌面与 Web：

```powershell
npm.cmd run desktop -- --workspace E:\your-project
npm.cmd run web                 # 打印 http://127.0.0.1:<port>/?token=<token>
```

Agent Host（供自建载体连接）：

```powershell
npm.cmd run host -- --workspace . --listen 127.0.0.1:0
```

首次运行 Electron 可能需要下载对应二进制；终端依赖代理时可先设 `$env:NODE_USE_ENV_PROXY = '1'` 再执行 `node node_modules/electron/install.js`。`resources`、`models`、`mcp`、`sessions`、`show` 这些命令不需要 API 密钥。

Windows x64 安装包通过 `npm.cmd run package:windows` 构建，产物位于 `dist/release`，附版本/schema 与 SHA-256 清单；程序、安装器与卸载器使用 `build` 中的图标。安装版自带 Node 运行时，不需要开发 Node/npm；卸载保留设置和工作区数据。安装、路径与数据保留验证及未签名发行边界见 [P1 实施记录](docs/p1-implementation-2026-10-05.md#dev-02windows-安装包与安装验证)。

---

<a id="architecture"></a>

## 架构

### 分层与真实依赖

包之间**不是**严格的单向分层（`protocol` 与 `core`、`tools` 与 `storage` 之间存在相互引用），因此下表给出的是实际观测到的依赖，而不是一张理想图。

| 位置                 | 职责                                                         | 内部依赖                                                        |
| -------------------- | ------------------------------------------------------------ | --------------------------------------------------------------- |
| `packages/protocol`  | 类型真源：消息/事件/RPC/设置表/失败码/限额                   | core, resources                                                 |
| `packages/core`      | 内核：agent 循环、上下文预算、子代理、任务、目标、计划、投影 | knowledge, protocol, resources, storage, tools                  |
| `packages/tools`     | 工具目录与执行管线、沙箱、后台命令、终端、文件日志           | core, knowledge, lsp, mcp, office, protocol, resources, storage |
| `packages/providers` | 三种模型协议的适配器、SSE、缓存、端点发现、容量目录          | protocol                                                        |
| `packages/storage`   | SQLite 会话日志、事件、投影检查点、租约、检索                | core, protocol, tools                                           |
| `packages/client`    | 宿主客户端：传输缝隙、JSONL RPC、会话状态机                  | core, protocol, storage                                         |
| `packages/carrier`   | 载体契约与服务：一套命令词表 + 快照 + 四条增量通道           | client, core, protocol, providers                               |
| `packages/knowledge` | markdown 记忆与文档索引（FTS5）                              | protocol, resources, tools                                      |
| `packages/resources` | 项目指令、Skills、声明式扩展、外部钩子桥                     | protocol, tools                                                 |
| `packages/lsp`       | 语言服务器管理（启动、诊断、定义、重命名、代码操作）         | protocol, tools                                                 |
| `packages/mcp`       | MCP 客户端（stdio/http/sse）与 OAuth 2.1                     | protocol, resources, tools                                      |
| `packages/office`    | DOCX / XLSX / PPTX 读写与预览                                | core, protocol, resources, tools                                |

| 入口              | 职责                                                                 | 内部依赖                                                                  |
| ----------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `apps/shared`     | CLI 与 Host 共用的装配层：沙箱默认值、容量解析、store、`createAgent` | core, protocol, providers, storage, tools                                 |
| `apps/cli`        | 一次性命令行：17 个运行型命令 + `resources`/`models`/`mcp`           | shared, core, mcp, protocol, providers, resources, storage, tools         |
| `apps/agent-host` | 长驻 Host：JSONL(stdin 或 TCP) RPC 服务端 + 任务调度器               | shared, core, protocol, providers, resources, storage, tools              |
| `apps/desktop`    | Electron 主进程 + preload + 渲染层；自持一个 Host 子进程             | carrier, client, core, mcp, office, protocol, providers, resources, tools |
| `apps/web`        | 本机 Web 桥：静态页 + 单条 WebSocket + 一个 Host 子进程              | desktop（复用渲染层）, carrier                                            |

`packages/carrier` 是这套架构的接缝：`CarrierService` 是「面向任何界面层的客户端状态机」，它回答「界面该看到什么」，所有答案都来自 Host 应答；包里不允许出现 Electron、DOM 或 `apps/` 引用（由 `tests/carrier.test.ts` 从源码文本上钉住）。`apps/web` 复用 `apps/desktop/renderer.ts`，只替换掉 `window.yuantu` 背后的桥——渲染层因此不知道底下是 Electron IPC 还是 WebSocket。

### 一次运行的数据流

```text
载体（桌面 / Web / 自建）
  │ CarrierCommand（一套受校验的词表）
  ▼
CarrierService ── AgentHostClient ── JSONL ──► apps/agent-host（长驻进程）
                                                  │
                                                  ▼
                                          packages/core Agent
                                    循环：请求模型 → 执行工具 → 落盘
                                        │            │          │
                                  providers      tools     storage
                                  （SSE/usage）  （管线）  （事件日志）
                                                  │
                                                  ▼
                                    界面看到的一切 ← 日志投影
```

CLI 走另一条路：它不经 `CarrierService`，而是在自己进程里 `createAgent()` 直接跑内核，并明确拒绝 `--listen`（提示改用 Agent Host）。

### 关键装配

`apps/shared/runtime.ts` 的 `createAgent()` 是唯一装配点，顺序为：读 provider 配置 → 建 provider → 建 `Agent` 并注入工具注册表、子代理 provider 解析器、可委派模型列表、fork 预算、审批与提问回调、权限策略 getter、子代理开关/并发/超时、驻留与 `childTools`、以及全部预算参数 → 解析上下文窗口（**解析不出就拒绝运行**）→ 注册工具 → 装载钩子。

---

<a id="providers"></a>

## 模型与协议

三种内置协议，唯一声明处是 `packages/protocol/index.ts` 的 `BUILTIN_PROTOCOLS`（同一份常量同时喂给设置表的枚举与注册表，避免两处漂移）。宿主可用 `registerProvider()` 注册第四种。

| 协议                    | `YUANTU_PROTOCOL`   | 密钥变量            | 端点拼接                                                                |
| ----------------------- | ------------------- | ------------------- | ----------------------------------------------------------------------- |
| Anthropic Messages      | `anthropic`（默认） | `ANTHROPIC_API_KEY` | 以 `/v1` 结尾则追加 `/messages`，否则追加 `/v1/messages`                |
| OpenAI Chat Completions | `openai`            | `OPENAI_API_KEY`    | 已以 `/chat/completions` 结尾则保留；`/v1` 结尾追加 `/chat/completions` |
| OpenAI Responses        | `openai-responses`  | `OPENAI_API_KEY`    | 已以 `/responses` 结尾则保留；`/v1` 结尾追加 `/responses`               |

`YUANTU_API_KEY` 优先级高于上面两个。环境变量都没有时，读取 `~/.yuantu/credentials.json`（`YUANTU_CREDENTIALS_FILE` 可改名），形如 `{"anthropic": "sk-ant-…", "openai": "sk-…"}`：这是给没有系统钥匙串的调用方（CLI、Host）用的第二来源，**环境变量始终优先**。文件是明文，保护来自权限（目录 `0700`、文件 `0600`，创建时就带上）与所在的用户账户；桌面端保存的密钥仍走系统 `safeStorage`。写入用 `credentials set <协议>`，密钥只从标准输入读（命令行参数会进进程表与 shell 历史），`credentials list` 只列协议名、不打印密钥。base URL 不得内嵌凭据、query 或 hash；**必须 HTTPS**，仅 `localhost`/`127.0.0.1`/`[::1]` 允许 http；请求一律 `redirect: 'error'`。

- **鉴权**：Anthropic 用 `x-api-key` + `anthropic-version: 2023-06-01`；OpenAI 两种用 `authorization: Bearer`。
- **OpenAI Chat 的硬前提**：`stream_options.include_usage` 必须被网关支持，**缺用量即明确失败**（`Model endpoint omitted token usage`），不猜、不静默。
- **Responses 的硬前提**：恒为 `store: false` 且恒带 `include: ['reasoning.encrypted_content']`；端点未返回加密推理项即失败（`Responses endpoint omitted encrypted reasoning required for stateless continuation`）。连续性靠原样回放整段 `output`，且只在**同一端点 + 同一模型**时回放，跨端点自动降级为文本编码。
- **流式**：统一的 SSE 解析器，单帧上限 16 MB；每个协议都要求看到终态事件与块闭合，否则按传输失败处理。Anthropic 的 `thinking` 预算 = 输出上限的 25%/50%/75%（low/medium/high），下限 1024 token 且必须小于输出上限。
- **用量与缓存**：Anthropic 的缓存读取与写入分别计入 `cachedInputTokens` / `cacheWriteInputTokens`；供应商没报写入时该字段**未定义而不是 0**。提示缓存的粒度由 `YUANTU_PROMPT_CACHE` 决定，四种取值：`auto`（默认）按**路由声明的能力**选，`blocks` 打 `cache_control` 断点（系统提示、最后一个工具定义、最新消息末尾，这是 Anthropic 的扩展），`key-only` 只传 `prompt_cache_key`，`off` 两个字段都不发；旧的 `0` / `false` 等价于 `off`，`1` / `true` 等价于 `auto`。**不认识的协议名在 `auto` 下不发送任何缓存字段**（沉默不等于声明支持），要发就显式点名。键是「协议 + 模型 + 系统提示 + 工具定义」的 SHA-256 摘要，正文与凭据都不进键。
- **重试**：适配器与传输层**不**重试。重试决策在步骤边界，只对 `rate-limit` / `server` / `timeout` / `transport` / `no-stream` 生效，且要求**尚未向用户显示任何内容**；退避 `min(30s, 250·2ⁿ⁻¹ + jitter)`，服务端 cooldown 不被缩短——要求等待超过 30 秒就直接放弃。计数从日志读回，因此进程崩溃不会重置额度。
- **失败分类**：12 个失败码定义在 `packages/protocol/failure.ts`；其中 `context-window-exceeded` 与 `output-limit` 让运行以「任务太大」（`limited`）结束，其余归为「出问题」（`failed`）。上下文溢出只在供应商明确确认时触发压缩恢复。

---

<a id="tools"></a>

## 工具目录

下列工具由 `createTools()` 在空工作区下发，是本项目的稳定工具面；每项的审批列就是它声明的权限（`—` 表示不声明权限，也正因如此才出现在只读运行里）。

### 文件与编辑

| 工具           | 行为                                                         | 审批 |
| -------------- | ------------------------------------------------------------ | ---- |
| `list_files`   | 递归列出最多 1000 个文件，跳过链接、凭据与依赖目录           | —    |
| `read_file`    | 读 UTF-8 文本并标注行号，可切起止行；只读前 256KB            | —    |
| `read_image`   | 读工作区内图片（PNG/JPEG/GIF/WebP，≤5MB）并作为图片返回      | —    |
| `search_files` | 在最多 1000 个文件中搜索；默认字面量、区分大小写、100 条结果 | —    |
| `repo_map`     | 工作区结构大纲（文件 → 声明）；带 `query` 时按符号名检索     | —    |
| `edit_file`    | 把唯一匹配的 `old_text` 换成 `new_text`，保留其他字节        | 写入 |
| `write_file`   | 在已有目录新建文件；拒绝覆盖                                 | 写入 |
| `apply_patch`  | 对单个文件应用精确 unified diff，审批后重新校验源内容        | 写入 |
| `delete_file`  | 删除单个文件，审批后做精确字节校验                           | 写入 |
| `move_file`    | 移动到不存在的目标路径，源与目标审批后重新校验               | 写入 |
| `batch_edit`   | 按顺序执行 1–100 次精确替换，按一组展示、记账与撤销          | 写入 |

### 命令与终端

| 工具                   | 行为                                                        | 审批 |
| ---------------------- | ----------------------------------------------------------- | ---- |
| `run_command`          | 执行命令并返回真实退出码；**host 模式不是沙箱**             | 命令 |
| `start_command`        | 启动受管的后台命令并返回作业 id；不得自行守护化             | 命令 |
| `write_command`        | 向受管命令的 stdin 写入；`eof` 关闭 stdin                   | 命令 |
| `discover_validations` | 只从已知根清单发现 test/typecheck/lint/build 等命令，不执行 | —    |
| `run_validation`       | 执行已发现的验证；`node --test` 项目可指定文件与失败用例名  | 命令 |
| `terminal_open`        | 打开真正的伪终端（REPL、调试器、交互式 rebase）             | 命令 |
| `terminal_list`        | 列出本会话已打开的终端及其状态与输出量                      | —    |
| `terminal_read`        | 按 cursor 读取终端输出，并报告是否已退出                    | —    |
| `terminal_send`        | 向终端输入，默认补换行；`enter: false` 发按键               | 命令 |
| `terminal_signal`      | 发送 SIGINT / SIGTERM / SIGKILL                             | 命令 |
| `terminal_close`       | 关闭终端及其启动的一切                                      | 命令 |

### 作业控制面

`job_list` / `job_output` / `job_kill` 三个工具同时服务后台命令与子代理——它们回答的是同样三个问题：**有哪些、产出了什么、怎么停**。作业按会话归属，一个 id 只属于一个产出者；`job_kill` 幂等，停一个已结束的作业返回它的最终状态而不是失败。

### Git

| 工具                  | 行为                                                                | 审批 |
| --------------------- | ------------------------------------------------------------------- | ---- |
| `git_status`          | 读取工作区内仓库的 porcelain v2 状态                                | —    |
| `git_diff`            | 读取 working/staged/HEAD diff，可限路径并禁用外部 diff/textconv     | —    |
| `git_log`             | 读取近期提交历史，用于对齐仓库的提交信息风格                        | —    |
| `git_branches`        | 查看本地分支与当前分支                                              | —    |
| `git_worktrees`       | 查看本地工作树及其分支                                              | —    |
| `git_worktree_create` | 从 HEAD 建立新分支与独立工作树（`.yuantu/worktrees/<name>`）        | 命令 |
| `git_stage`           | 暂存或取消暂存指定路径（可能触发 `.gitattributes` 的 clean filter） | 命令 |
| `git_commit`          | 用给定信息提交已暂存改动；默认运行仓库钩子                          | 命令 |

### 网络与浏览器

| 工具                 | 行为                                                 | 审批 |
| -------------------- | ---------------------------------------------------- | ---- |
| `web_search`         | 搜索公网，返回标题、URL 与摘要                       | 外部 |
| `web_fetch`          | 抓取单个 http/https 页面并转为可读文本               | 外部 |
| `browser_open`       | 用真实无头浏览器打开页面、执行脚本并返回渲染后的文本 | 外部 |
| `browser_click`      | 点击元素并返回结果文本                               | 外部 |
| `browser_fill`       | 向输入框填值（可回车提交）并返回结果文本             | 外部 |
| `browser_screenshot` | 截图 PNG 到工作区并记入文件日志                      | 写入 |
| `browser_close`      | 关闭共享的浏览器会话                                 | —    |

`web_search` 默认用无密钥端点开箱即用，可用 `YUANTU_SEARCH_PROVIDER`（`brave` / `tavily`）配合 `YUANTU_SEARCH_API_KEY` 覆盖。浏览器工具依赖**可选**的 `playwright` 与 Chromium：未安装时工具明确报错并给出安装命令。网页内容一律视为不可信数据。

### 语言服务器

| 工具                                              | 行为                                               | 审批 |
| ------------------------------------------------- | -------------------------------------------------- | ---- |
| `lsp_servers`                                     | 列出已配置的服务器、可执行文件是否可用及运行状态   | —    |
| `lsp_start`                                       | 通过 host 或 Windows 执行后端启动语言服务器        | 命令 |
| `lsp_stop`                                        | 停止服务器并释放进程                               | —    |
| `lsp_diagnostics`                                 | 返回诊断；给定路径会同步该文件并等待其发布         | —    |
| `lsp_definition` / `lsp_references` / `lsp_hover` | 跳转定义 / 查找引用 / 类型签名与文档               | —    |
| `lsp_symbols` / `lsp_workspace_symbols`           | 单文件符号 / 全工作区按名检索                      | —    |
| `lsp_rename`                                      | 重命名符号，跨文件原子写入并记入文件日志           | 写入 |
| `lsp_code_action`                                 | 列出该位置的快速修复/重构/源操作，带编号与可应用性 | —    |
| `lsp_apply_code_action`                           | 按编号应用代码操作，跨文件原子写入并记入文件日志   | 写入 |

内置四种语言的服务器定义，`.yuantu/lsp.json` 可按语言覆盖 `command`/`args`/`extensions`/`env`/`install`/`notes`/`disabled`，未声明的字段继承内置：

| 语言       | 命令                                 | 认领的扩展名                            | 覆盖安装                                               |
| ---------- | ------------------------------------ | --------------------------------------- | ------------------------------------------------------ |
| TypeScript | `typescript-language-server --stdio` | `.ts .tsx .mts .cts .js .jsx .mjs .cjs` | `npm install -D typescript-language-server typescript` |
| Python     | `pyright-langserver --stdio`         | `.py .pyi`                              | `npm install -D pyright`                               |
| Go         | `gopls`                              | `.go`                                   | `go install golang.org/x/tools/gopls@latest`           |
| Rust       | `rust-analyzer`                      | `.rs`                                   | `rustup component add rust-analyzer`                   |

解析可执行文件时**先看工作区本地包**（`node_modules/<package>/package.json` 的 `bin`，此时命令是 `process.execPath`），再找 `<root>/node_modules/.bin`，最后才查 `PATH`；Windows 只接受 `.exe` 与 `.com`。文件到语言按**最长后缀**匹配。诊断是推送式的：`lsp_diagnostics` 先同步文档，再按「这一代是否已有更新发布」决定是立刻返回还是在截止时间内等——服务器已死会直接报错，**不会假装没有诊断**。编辑 6 个变更文件后会自动附注新诊断（最多 3 个文件 × 每文件 10 条，只留 error/warning），附注永不隐式启动服务器，也永不把一次成功的编辑变成失败。

### Office 与交付

| 工具                   | 行为                                                           | 审批 |
| ---------------------- | -------------------------------------------------------------- | ---- |
| `office_inspect`       | 读取 DOCX/XLSX/PPTX 的结构与文本                               | —    |
| `office_create`        | 新建文档、表格或演示文稿（Word/PPT 需要本机 Microsoft Office） | 写入 |
| `office_edit`          | 基于模板替换文本、编辑单元格，保留未受影响的格式               | 写入 |
| `office_preview`       | 默认 PDF（DOCX/PPTX）或 HTML（XLSX）；可选 LibreOffice PDF     | 写入 |
| `verify_file_delivery` | 校验类型、大小、SHA-256 与结构标记                             | —    |
| `present`              | 把工作区文件声明为本次任务的交付物，供用户打开                 | —    |

### 记忆与知识

| 工具                                         | 行为                                    | 审批 |
| -------------------------------------------- | --------------------------------------- | ---- |
| `recall_knowledge`                           | 搜索 markdown 记忆与已索引的项目文档    | —    |
| `list_memories`                              | 列出工作区与用户级记忆，以及已索引文档  | —    |
| `save_memory` / `forget_memory`              | 按 key 创建或替换 / 删除一条记忆        | 写入 |
| `index_document` / `remove_indexed_document` | 加入检索索引 / 从索引移除（不删源文件） | 写入 |

### 会话与协作

| 工具                | 行为                                                                                                                                            | 审批 |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ---- |
| `ask_user_question` | 提 1–4 个结构化问题并等待回答（非交互时立即返回未回答）                                                                                         | —    |
| `todo_write`        | 覆盖本会话的当前计划清单（只有会话状态，无副作用）                                                                                              | —    |
| `run_code`          | 用一段 JavaScript 自己调用工具，让多步只花一轮；程序内的调用与模型的批量走**同一套并发分类**（带权限的工具独占，宽度取 `--max-parallel-tools`） | —    |

### 按宿主与工作区追加的工具

这些不在上面的基础目录里，注册与否取决于装配结果，因此名字也不是固定的：

| 家族     | 注册条件                                 | 工具                                                                                                                        |
| -------- | ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| 子代理   | 宿主启用委派（`--no-subagents` 关闭）    | `delegate_task`、`subagent_fork`、`collect_subagents`、`list_subagent_models`、`send_message`；子代理内另有 `submit_report` |
| 会话查询 | 宿主提供了会话库                         | `search_sessions`、`read_session_events`、`search_session_events`、`trace_session`                                          |
| 目标续跑 | 该运行自己拥有这份工作（根运行）         | `create_goal`、`get_goal`、`update_goal`                                                                                    |
| 计划模式 | 计划阶段                                 | `submit_plan`、`exit_plan_mode`                                                                                             |
| 工作流   | 宿主启用                                 | `workflow`（在独立 Node 进程中运行编排脚本，支持 host/Windows 后端）                                                        |
| 技能     | 工作区发现至少一个技能                   | `load_skill`                                                                                                                |
| 持久任务 | 有任务尝试活动                           | `task_step`                                                                                                                 |
| MCP      | 工作区配置了服务                         | `mcp_<服务名>_list_tools`、`_call_tool`、`_list_resources`、`_read_resource`、`_list_prompts`、`_get_prompt`                |
| 扩展     | `.yuantu/extensions/*.json` 或嵌入方注册 | `ext_<名称>`                                                                                                                |

因此「这次运行到底有哪些工具」取决于装配结果，而不是一个固定清单；发出去的 schema 就是这次运行能用的工具。

---

<a id="pipeline"></a>

## 工具执行管线

工具调用不是「校验 → 执行 → 观察」三步，而是一条有名字、有顺序、在每次执行时被校验的管线：

```text
validate → pre-execute → guards → prepare → approval → execute → post-execute → finalize → result
```

| 阶段           | 谁能影响它                              | 能决定什么                                                                                                                            |
| -------------- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `validate`     | —                                       | 参数不合法就结束，后面的阶段一步都不跑                                                                                                |
| `pre-execute`  | `beforeTool`                            | 只读观察 + allow/deny；拒绝即到此为止                                                                                                 |
| `guards`       | `guard`（宿主级、注册表级或钩子集内联） | **只能拒绝**，无法授权——审批层拒绝的操作，钩子和守卫都放行不了                                                                        |
| `prepare`      | 工具自己的 `prepare`                    | 计算审批描述与 Diff；被守卫拒绝的调用连文件都不会读                                                                                   |
| `approval`     | 人工审批                                | 无审批者或无法回答 = 拒绝                                                                                                             |
| `execute`      | 工具实现 + `aroundTool`                 | 工具体抛错变成 `isError` 结果但仍进入后续阶段；`aroundTool` 环绕调度本身，可多次调用 `next()`（那就是重试），但不调用 `next()` 会失败 |
| `post-execute` | `postExecute` + `afterTool`             | accept / block / replace / replace-content / add-context；`block` 优先且不可被后续钩子解除                                            |
| `finalize`     | `finalizeContent`                       | **只能改内容**，改不了失败标记与变更记录，且在截断之前运行                                                                            |
| `result`       | —                                       | 截断、观察器失败提示、`additionalContext` 透出                                                                                        |

阶段顺序、重复与倒序由 `packages/tools/pipeline.ts` 在**每次执行时**校验（把成因写进错误文本），而不是只靠测试覆盖到的路径。

钩子的分发语义由 `packages/tools/dispatch.ts` 的五个具名模式统一表达。此前每个缝都各写一个 `for` 循环，于是同样四个问题被四次偶然地回答成不同样子；现在它们按名字回答一次，缝的语义在调用处就能读出来：

| 模式                | 语义                                                                                                                                                                      | 用在               |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ |
| `dispatchEmit`      | 通知每一个监听者并收集失败、忽略结果——一个坏观察者不能静默其余                                                                                                            | 事件型钩子         |
| `dispatchFirst`     | 依序执行到第一个非 `undefined`；`undefined` 表示「没有意见」                                                                                                              | `beforeTool`、守卫 |
| `dispatchSerial`    | 把值依序穿过每个监听者，返回 `undefined` 则保持当前值                                                                                                                     | 精炼链             |
| `dispatchWaterfall` | 环绕中间件：`next()` 不带参数，因为被传递的值是**正在被审计的身份**，包装者不得改写；监听者从不 delegate 是**错误**而非隐式短路                                           | 审计型包装         |
| `dispatchThreaded`  | 同上，但 `next(state)` 可以替换**调用上下文**（信号、截止时间、可及资源）。只观察的包装者只能限定自己的等待，于是会报告「已停止」而工具仍在跑——这是这条管线唯一拒绝的谎言 | `aroundTool`       |

`pre-execute` 与守卫因此是**单调的**：它们只能拒绝，「扩展允许了它」在这条管线里无法表达。这正是守卫可以安全地继承进被委派的运行的原因。

`add-context` 注入的上下文**不会塞进工具结果文本**，而是由 agent 循环在本批工具结果之后写成本轮的一条 user 消息，因此它和任何模型可见输入一样落在会话记录里，也照常参与摘要与压缩边界。

---

<a id="permissions"></a>

## 权限、审批与沙箱

读取和搜索不需要授权。文件写入、命令执行和外部访问按工具声明逐项询问，审批展示完整参数，由「允许一次」或「拒绝」决定。已确定本次运行允许的操作时可显式放行：

```powershell
npm.cmd run dev -- run "修改代码并运行测试" --workspace E:\your-project --allow-write --allow-command
```

- `--allow-write` 放行内置文件工具写入工作区。
- `--allow-command` 放行**主机 shell 命令**，权限范围大于文件工具；它同时放行 `git_stage`、`git_commit`、`git_worktree_create`、`lsp_start` 与 `run_validation`，但**不放行** MCP 与浏览器工具。
- 管道、非交互输入与 `--json` 模式下，未显式允许的写入和命令**默认拒绝**：CLI 在非 TTY 或 `--json` 时直接不提问。
- `Ctrl+C` 取消模型请求、等待中的审批、等待中的提问与前台命令；已写入的文件不会自动回滚。

### 权限策略

用 `--permission-policy <file>` 或 `YUANTU_PERMISSION_POLICY` 指定可信 JSON 规则。`deny` 优先于 `ask`，再优先于 `allow`；deny/ask 覆盖 `--allow-command` 与 `--allow-write`；不匹配则保留原审批行为。规则按 kind、精确工具名和**完整** arguments 对象匹配——arguments 不是命令前缀白名单。CLI 与 Host 用 `--allow-*` 与策略文件表达这四档；桌面把它们和沙箱捆成三档（仅可查看 = 只读、工作区内修改 = 逐项询问、完全权限 = 完全访问 + 宿主执行），只能整档选择。

### 命令沙箱

`YUANTU_SANDBOX` 取 `host`、`docker`、`sbx` 或 `windows`，镜像由 `YUANTU_SANDBOX_IMAGE` 指定。**CLI 与 Host 默认 `host`**：命令直接在主机的 shell 中运行，初始目录是工作区——**目录校验不是操作系统沙箱**，授权后的命令可以访问主机其他位置和网络。桌面默认 `sbx`，而 `YUANTU_SANDBOX` 在桌面上只表示**新会话从哪个模式开始**（不改写、不锁定）：某个会话在 chip 里换了档只影响它自己，新会话回到这个起点。切换是**活的**——沙箱模式在每次命令执行时读取，所以换档不重启载体进程、不打断会话，下一条命令就按新模式约束。模式属于会话（每个会话 id 各自记住自己的档位，窗口重开回到起点），因此两个会话可以一个在沙箱里、一个在宿主上。

非 host 模式下，**会执行宿主程序的工具响亮地拒绝**，而不是静默降级成一条更弱的路径：

- **全部 8 个原生 Git 工具**（不只是写操作）——仓库过滤器、`diff.external`、hooks、alias 与 `core.hooksPath` 都能执行宿主程序，所以连 `git_status` 都不在容器里跑。
- **终端与 LSP 的容器模式**——host 与 Windows 已接入统一执行环境，Windows 的部分写入限制同样作用于真实 PTY 和 LSP server；docker/sbx 明确拒绝，不回退宿主。进程保留创建策略，切换后只能查看或关闭，不能继续输入、发信号或发送 LSP 请求；重新启动后使用新策略。关闭等待进程及 backend 资源清理，已完成的终端输出保留。
- **stdio MCP**（会 spawn 进程）；**远程 HTTP/SSE MCP 不受沙箱约束**。
- **hook 桥**：`hook` 类别的沙箱不是 host 时直接拒绝装载，并提示用 `YUANTU_SANDBOX_HOOK=host` 让「命令被隔离、钩子在宿主」共存。

这些工具**仍然注册**（`host` 是默认，装配时无法预知运行期会切到哪种模式），失败发生在调用时，报错文案按当前模式命名。`run_validation` 不在其列——它改走沙箱化的命令路径。网页抓取与浏览器工具也不受约束：沙箱只隔离命令执行，不隔离 agent 进程自己发的网络请求。

### 外部钩子桥

工作区里的命令钩子走另一条路：`.claude/settings.json` 与 `.yuantu/hooks.json` 被读成上面管线里的普通钩子，因此顺序、超时与可撤销性自动一致。退出码就是契约：`0` 放行、`2` 拒绝（stderr 是理由）、**其他非零码是「钩子坏了」而不是「拒绝」**，只记录不否决。`permissionDecision: 'ask'` 映射为拒绝——这次调用里没有通道能替 hook 去问人。两条硬边界：命令钩子是**在 agent 进程树里执行任意代码**，不是沙箱；沙箱被设成容器模式时桥直接拒绝装载。整座桥可用 `YUANTU_HOOK_BRIDGE=0` 关闭。

---

<a id="sessions"></a>

## 会话、事件与投影

默认会话数据库是 `<workspace>/.yuantu/sessions.sqlite`，桌面、CLI 与 Host 共用。SQLite 打开时设置 `busy_timeout`、WAL 与 `foreign_keys=ON`；**比当前代码更新的库会被拒绝打开**并给出明确错误，不自动降级。旧库迁移前自动创建包含已提交 WAL 的一致性备份，备份失败则拒绝迁移；新空库和当前 schema 的正常打开不备份。维护命令、保留规则与恢复限制见 [数据库备份与恢复](docs/p1-implementation-2026-10-05.md#dev-01会话数据库备份与恢复)。

### 事件日志是唯一真源

持久事件写在 `session_events`，`seq` 是全局自增游标，同时被复用为客户端的事件游标。界面需要的一切都是**投影**：会话消息、统计、轮次计时、子代理卡片、子代理收件箱、待办清单、交付物、目标、步骤——共 10 个内置投影，其中消息投影刻意不落盘（它便宜到不需要缓存）。投影检查点让重开界面不必从 `seq=0` 重放；检查点版本或 seq 不合法时**退回全量折叠**，写失败也静默——它是派生数据。一条运行时不变式（`storage.log-tables-agree`）在每次运行结束时用字符串比较「日志折叠」「读出的转录」「落盘的行」三者，因此表与事件不可能各说一套。

未知事件类型**拒绝**而不是跳过，只有明确列入「可忽略」的记账类事件例外。

模型**实际看到的内容**也落在日志里，而不只是会话消息：每轮请求的**信封**（`context.envelope`：system 提示词与工具目录各自的摘要与体积、该轮瞄准的模型与限额、以及缓存键）与 `resources.loaded`（本次运行加载了哪些指令文件与技能）都是持久事件。提示词本身只在**该轮发生变化时**再存一份——所以一百轮同一个提示词只占一份拷贝，而读侧（`foldContextEnvelopes`）按摘要把省略的那份补回来；提示词超过 32K 字符时只存前缀并**标记为截断**，`systemBytes` 记录真实体积，截断的副本不会被当成完整提示词。因此「这一轮模型究竟看到了什么」以及「AGENTS.md 改过之后，早先那轮被告诉的是什么」都能从日志回答，而不是只能回答「是不是同一个提示词」。

### 崩溃恢复与租约

会话租约是一行「当前有谁在写」，不是历史。持有者是否还活着用 `process.kill(pid, 0)` 判定，**租约永不按时间过期**——主请求没有总时长，唯一看门狗每次收到数据都重置，按龄过期会误杀健康的运行并放进第二个写者。压缩另有一把锁，在摘要请求之前取、在写入时复核。

Host 启动时做一次收敛：把中断的运行 settle 掉（未闭合的工具调用补一条错误结果）、恢复中断的任务、收敛子会话、把流式检查点落成带 `interrupted` 标记的助手消息，并把仍可继续的定时任务重新排队。CLI 因为是单次调用，每次运行前也做一次。

### 文件改动与撤销

每个改动组在执行前把「之前的字节」存进 `file_changes`，因此撤销可以做到冲突安全：撤销前先按当前字节判断该组是已应用、已放弃还是冲突，只有全部路径都仍然等于「改后」才逆序恢复；中止过的撤销（`undoing`）允许继续完成。撤销本身也包在一次运行里。

### 会话查询

存储层支持子串与全文检索（FTS5，`unicode61`），并按会话聚合 bm25 排序。模型侧的会话查询工具（`search_sessions`、`read_session_events`、`search_session_events`、`trace_session`）全部不声明权限，因此只读运行也能用；它们对跨工作区会话按名拒绝。

---

<a id="context"></a>

## 上下文与预算

### 窗口必须显式声明

没有「猜一个窗口」这回事。运行前解析「操作者声明 → `YUANTU_MODEL_CAPACITIES` 里的同端点其他模型 → 内置目录」，三者都答不出就**拒绝运行**，并指向 `--max-context-tokens`、`YUANTU_MAX_CONTEXT_TOKENS`、桌面模型设置或 `yuantu-agent models`。`DEFAULT_MAX_CONTEXT_TOKENS` 只用作桌面输入框的占位提示，不是运行时默认值。

### 每一轮只做一次前瞻

模型请求之前做**一次**前瞻，它同时回答「这次请求需要多少输入」与「这份预算还剩多少」；同一个结果被三处共用——裁剪输出上限、决定是否缩短旧结果、决定是否提前压缩——所以「报告出来的数字」和「据以决策的数字」在构造上是同一个。估算按 UTF-8 字节 / 3、256 token 协议余量，每张图片另留 4096 token，**并非精确 tokenizer**，并会用供应商报告的真实用量自我校准（限幅 0.5–3，只缩放按字节估出的那部分，协议余量不缩放）。校准随后**按路由落盘**（`context.calibration`：协议 + 模型，宿主声明了连接名时还含连接），因此同一会话的下一次运行从上次测到的比值开始，而不是从 1 重来；换模型或换端点不会继承上一个的误差。前瞻结论作为事件发出来，所以「这一轮为什么这么贵」可以在日志里直接读。

### 旧结果缩短与提前压缩

旧工具结果在模型看到之前会被缩短（`packages/core/shrink.ts`），提示写明删了多少字符、完整文本在磁盘的哪个路径，`read_file` 可以分页读回。预算按 **token** 而不是字符：字符预算在中文下要多花三倍上下文（1 200 字符≈英文 400 token、中文 1 200 token），所以预算是同一个数，切成多少字符由这段文字自己的密度决定。最新的若干条永不缩短，且**结构上**保证「最后一次工具调用之后的那批结果」永不缩短。缩短发生在压缩之前——它不花预算，先做便宜的。压缩略微提前发生：如果现在付得起摘要、发完这一轮就付不起了，那就现在做，花掉的预算略早，换来的是历史还在。手动压缩不受这条可负担性门禁约束。

历史摘要**活在对话里**，不是 system 提示词的一段：它是请求的第一条 user 消息，用 `<compacted-summary>` 包起来并写明「只是上下文、不是更高优先级的指令」。原因是 provider 的提示缓存是**逐字节前缀**——摘要若挂在 system 末尾，每次压缩都会把 system 与整份工具目录一起作废，此后整场会话都读不到缓存；放进对话后，每次压缩只是**替换**那条快照，system 提示词与它的缓存键跨压缩逐字节不变（`tests/snapshots/compaction-before-answering.json` 把这一点钉在两轮的 digest 与 cacheKey 上）。摘要请求重放的是同一个前缀：同一条快照 + 同一批消息 + 末尾一条指令，所以那次请求读的正是上一轮写下的缓存条目。摘要不是自由散文：指令要求固定八段 markdown（目标 / 决策与约束 / 已完成 / 当前状态 / 待确认问题 / 下一步 / 不确定处 / 附件），顺序固定、空段写 `None.`、不许加别的标题——摘要每压缩一次就被重写一遍，散文每过一遍都会悄悄丢掉一段，固定骨架把「没写」变成必须回答的问题。模型若把 `<compacted-summary>` 连壳一起回给你，落盘时会剥掉这层壳（否则每压缩一次就套一层），而它**原样说了什么**记在同一条 `context.compacted` 记录的 `rawOutput` 里（没剥壳时该字段不出现，沉默即「存的就是它说的」）；同一记录还带 `protocol`（适配器名，快照里叫 provider）、`model` 与 `maxTokens`，与每轮的 `context.envelope` 一起回答「这条摘要是在什么信封下产生的」。

工具的完整输出不会因为截断而消失：整份输出写到 `.yuantu/spill/<会话>/` 下，截断提示给出路径、字节数与行数，`read_file` 只对这一个子树放行。

### 上限的来源

所有默认限额只在 `packages/protocol/settings.ts` 的 `RUN_DEFAULTS` / 子代理常量里声明一次，CLI 帮助文本由这些常量插值渲染，因此文档与代码不可能各说一个数字。主要的几项：

| 参数                            | 默认值   | 含义                                             |
| ------------------------------- | -------- | ------------------------------------------------ |
| `--max-output-tokens`           | 256000   | 每个模型请求的输出上限                           |
| `--max-context-tokens`          | 无默认   | 模型上下文窗口；**不给就拒绝运行**               |
| `--auto-compact-tokens`         | 未设置   | 提前压缩阈值，须小于上下文窗口                   |
| `--max-context-chars`           | 10000000 | 附加字符保护上限                                 |
| `--max-parallel-tools`          | 4        | 同一助手消息里可重叠的工具调用数（1 = 严格串行） |
| `--max-retries`                 | 5        | 步骤边界重发模型请求的次数上限（0–5）            |
| `--tool-result-keep-recent`     | 6        | 末尾永不缩短的工具结果条数                       |
| `--tool-result-shrink-tokens`   | 400      | 缩短后保留的 token 数（头尾各半）                |
| `--context-shrink-percent`      | 60       | 占窗口这个百分比时开始缩短旧结果（10–95）        |
| `--question-timeout-ms`         | 120000   | 向用户提问的等待上限                             |
| `--request-timeout-ms`          | 未设置   | 可选的单次请求总时长上限                         |
| `YUANTU_STREAM_IDLE_TIMEOUT_MS` | 300000   | 连接与流式无数据超时，每次收到新数据重置         |

退出码：`0` 本轮正常结束、`1` 失败、`2` 达到预算或长度限制、`130` 用户取消。正常结束表示模型结束了这一轮，**不代表任务验收通过**。

---

<a id="collaboration"></a>

## 多 Agent、任务、目标与计划

### 子代理

内核本身仍是单会话循环；`delegate_task` 让它把自成一体的工作交给拥有独立会话的子代理，父运行只拿到一份有界报告。`explore` 角色只读——白名单在子代理**自己的注册表**上强制生效，清单外的工具不是「不展示」而是**不可调用**；`general` 继承父运行的权限，每一次写入、命令与外部访问照旧逐项询问。

- **能力是声明而不是尽力而为**：协调器只请求任务真正需要的能力，**被请求但未声明的一律响亮拒绝**，而且发生在任何子会话创建之前——被拒绝的委派不会留下一个空子会话。
- **子代理可以驻留，于是能被追问**：报告之后它作为 `idle` 留在内存里，同一会话的后续运行可以 `send_message` 追问、`job_kill` 叫停。发给**正在运行**的子代理时消息会被递进它当前那一轮，而不是另起一轮。
- **重启之后还能问那个孩子**：驻留会随进程消失，但子代理的会话、转录与当初给的额度都在磁盘上；`send_message` 会按父日志重建它的身份，用**它自己的转录**继续，并把「授予 − 已花掉」作为剩余额度交还。
- **可以不等**：`delegate_task({ wait: false })` 立即返回任务 id；阻塞调用也会让位——等待期间一旦有修正指令入队就停止等待、降级为「稍后 collect」。
- **报告是结构化的**：子代理必须用 `submit_report` 结束，给出结论 + 依据 + 未核实项 + 阻碍；空报告会被拒绝并要求重写。
- **上限**：单次调用最多 4 个任务、并发 8、单次父运行最多 8 个、默认不再往下委派、无进展 600 秒后停止（看门狗按「沉默」计时，只要还在产出就重新计时）。`list_subagent_models` 只列出宿主**确实能服务**的模型。

### 持久任务与目标

持久任务是带验收条件与触发器的实体，落在同一 SQLite 里（任务、尝试、步骤检查点、效果、审批各有表），由 Host 的调度器按到点或事件触发；事件级联有深度上限，且调度器只在没有活动运行时动手。目标续跑由 `runGoalRounds` 在运行结束后自动推进，轮数上限**独立于目标自身的预算**（后者模型可以用 `update_goal` 抬高，所以不能同时充当宿主的那道闸）；预算耗尽会记成 `blocked` 并写明轮数，而不是停在 `active`。`edit` / `pause` / `resume` 只允许出现在带用户输入的回合里：续跑轮可以报进展、可以结束目标，但不能抬高自己的预算，也不能撤销一个人刚按下的暂停（`HUMAN_ONLY_GOAL_ACTIONS`）。

### 计划模式

计划模式把「计划 → 批准 → 执行」分成三个可检视的阶段：模型产出计划后被拒绝执行，人批准（并核对计划哈希）后才落盘执行。只读运行与只读子代理只允许委派 `explore`。计划模式的状态就是计划行本身：一个停在计划阶段的会话（用户中断、进程消失）在下一次 `resume` 时仍是计划运行，未决的计划不会被当作普通会话继续；要放弃它，就在界面上拒绝那张计划，行随之交出决定权。

---

<a id="knowledge"></a>

## 记忆、知识库与工作区资源

### 记忆与知识库

**markdown 是记忆的真源**：工作区级 `<workspace>/.yuantu/memory.md` 与用户级 `<YUANTU_MEMORY_DIR>/memory.md`，条目是 `- **<key>**: <text> (YYYY-MM-DD)`，非条目文本原样保留。SQLite 不再写记忆。

文档检索用独立的 `~/.yuantu/knowledge.sqlite`（FTS5），`index_document` 只接受工作区内的 UTF-8 文本与代码（30 种扩展名），拒绝凭据类文件名与 `node_modules` 之类目录；每个工作区最多 64 个文档，搜索按标题命中 → bm25（标题列加权 4）→ 记忆优先 → 更新时间排序，并保证一个文档只占一个结果位。

### 项目指令与 Skills

项目指令每次运行重新加载，同一目录按 `AGENTS.override.md` → `AGENTS.md` → `CLAUDE.md` 取**第一个存在的**，按根到目标目录合并、越近优先级越高。渲染预算单文件 32KB、合计 64KB，**从最靠近目标的文件往外分配**：放不下的文件被截断或整个略去，并在提示词里点名说明——文件本身不动，`read_file` 可以读全文。超限因此不再让整个工作区无法运行。

Skills 放在 `.agents/skills/<name>/SKILL.md` 或 `.yuantu/skills/<name>/SKILL.md`（同名时 `.yuantu` 优先），每个最多 32KB、最多 64 个。用户输入 `/skill:<name> 任务` 加载全文，模型也可用 `load_skill`。技能指引**不能改变运行时权限**，这句话会随技能内容一起注入。

### 声明式扩展

`.yuantu/extensions/*.json` 声明一个命令，注册成 `ext_<name>`，参数为空对象，命令保持清单原文并在审批中完整展示。**不会自动导入项目 JavaScript**；需要 JS 工具要用受信任的嵌入 API（`AgentExtension` + `registerExtension`），由嵌入方负责信任与权限分类。

### 钩子的信任边界

JS 钩子必须由人显式指定模块路径（`--hooks <module>` 或 `YUANTU_HOOKS_MODULE`），解析后位于工作区内的模块会被**直接拒绝**——否则克隆一个仓库就足以让它的代码执行。项目 JSON 扩展不会自动执行 JS 钩子。

---

<a id="entry-points"></a>

## 四种入口

### CLI

`apps/cli/main.ts` 是单文件入口，17 个运行型命令（`run`、`resume`、`plan`、`plan-show`、`plan-execute`、`sessions`、`show`、`task-create`、`tasks`、`task`、`task-attempts`、`task-steps`、`task-trigger`、`task-schedule`、`task-approval`、`task-verify`、`task-retry`）加四个不需密钥的命令（`resources`、`models`、`mcp list|authorize|revoke`、`credentials set|list`）。交互模式下**进度全部走 stderr**，stdout 只留答复本身，因此它可以安全地接管道；`--json` 模式把事件、结果与计划都变成 JSONL。它明确拒绝 `--listen`：要对外服务请用 Agent Host。

CLI 与 Host 的 `main()` 第一行都做环境检查：**认不出的 `YUANTU_*` 变量与取值不合法的已知变量都会被列出并拒绝启动**，拼错的名字给出最近似名建议，且一次报出全部问题。库代码（`packages/core`、`packages/client`）不做这项检查——嵌入方进程里可能有别的 `YUANTU_*` 变量，判断环境是否合法是宿主的决定。

### Agent Host

长驻进程，在 stdin/stdout 或 TCP 上提供 JSONL JSON-RPC。报文只有四种形状：请求 `{id, method, params}`、成功 `{id, result}`、失败 `{id, error}`、事件 `{event}`；此外还有**没有 id 的 error**，表示「拒绝这条链路」而不是回答某个请求。方法共 46 个，按域分组：

| 域         | 方法                                                                                                                                                                                       |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 控制面     | `host.info`、`permission.update`、`invariants.list`                                                                                                                                        |
| 会话       | `session.create`、`session.list`、`session.rename`、`session.delete`、`session.get`、`session.audit`、`session.events`                                                                     |
| 运行       | `run.start`、`run.cancel`、`run.enqueue`、`run.queue.get`、`run.queue.clear`、`context.compact`                                                                                            |
| 审批与提问 | `approval.respond`、`question.respond`                                                                                                                                                     |
| 计划       | `plan.get`、`plan.approve`、`plan.reject`                                                                                                                                                  |
| 任务       | `task.create`、`task.get`、`task.list`、`task.update`、`task.attempts`、`task.steps`、`task.approval.respond`、`task.trigger`、`task.propose`、`task.confirm`、`task.verify`、`task.retry` |
| 后台命令   | `background.list`、`background.poll`、`background.stop`、`background.clear`                                                                                                                |
| 资源与文件 | `resources.list`、`files.list`、`files.read`                                                                                                                                               |
| 变更       | `changes.list`、`changes.undo`                                                                                                                                                             |
| 会话附属   | `todos.get`、`deliverables.get`、`subagents.list`、`goal.get`                                                                                                                              |

**同时只接受一个连接**（审批、运行、提问映射与工作区锁都是 per-Host），第二个连接会收到明确的拒绝报文后被关闭。载体断开即走同一个关闭流程——Host 属于拉起它的载体。

### Electron 桌面

主进程负责窗口、单实例锁、设置存储、IPC 与 Host 子进程的生命周期；preload 用 `contextBridge` 暴露一组 invoke 通道与四条订阅通道（整快照、助手流式文本、子代理增量、统计增量）；渲染层只与 `window.yuantu` 交互。窗口开启 `contextIsolation`、`sandbox`、`nodeIntegration: false`，并拒绝所有窗口打开与导航、拒绝一切会话权限请求，也没有应用菜单加速键——外链只能走系统浏览器，且只接受无凭据的 `http`/`https`。

渲染层**没有框架也没有状态库**：整个界面是一份 `CarrierSnapshot` 加四条订阅，重绘按区块的 key 做差量，locale 也进 key，因此一次流式增量只改动真正变了的那一块。对话区只画对话：`<runtime-context source="…">`（`workspace-outline` / `memory` / `skills` / `task`）这类**机器写给模型的快照**留在会话与日志里、也照旧发给模型，但不作为消息画出来——它们不是谁说的话，而人滚屏是为了看问答；识别由 `packages/core/runtime-context.ts` 的 `isRuntimeSnapshot()` 提供（与写快照的那一端共用同一个包装标签）。`<compacted-summary>` 不在此列：那是这场对话自己的摘要，读者要看的正是它。

| 面板       | 内容                                                                                                                                                                                                             |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 审批       | 按 kind 分「修改文件／执行命令／访问外部服务」，带默认展开的差异预览与「完整操作参数」，只提供「允许一次」与「拒绝」两键——没有「永久允许」                                                                       |
| 提问       | 一张卡一次请求、一次一题：眉标（`header`）+ 问题作标题、编号选项行（标签 / `recommended` 徽标 / 说明）、自由文本行、`‹ 1/1 ›` 翻页与「跳过本题」；选择与输入存在渲染之外，所以运行中的进度事件不会把已选内容冲掉 |
| 计划       | `planning → proposed → approved/rejected` 状态机；批准要回传计划摘要的 hash，Host 在执行前重新校验，两步之间计划被改动就不能执行                                                                                 |
| 变更与撤销 | 每个会话改动带差异与撤销按钮，撤销需二次确认，中断的撤销可以继续；没有本会话快照的历史记录只提示可看差异                                                                                                         |
| 工具结果   | 文件/搜索/命令三类卡片由结构化输出渲染（形状不符即回退纯文本），原文永远保留在嵌套的「工具结果原文」里                                                                                                           |
| 子代理     | 目录含状态点、目标、tokens 与耗时（每秒只改文本不重建行），另有详情卡与整页子代理记录                                                                                                                            |
| 统计       | 两个 pill：会话统计（模型用时／工具用时／首 token 平均／输出速度）与 Token 用量（缓存命中／未缓存输入／缓存读取／缓存写入／输出）                                                                                |

输入区支持 `/` 唤起指令与技能面板，其中只有 `compact`、`export`、`goal`、`plan` 四个会被解析执行，其余（切换模型、权限设置、新建会话、停止、刷新技能）走面板点击。设置页分通用、模型、MCP 三组。**权限与隔离是 composer 上的一枚 chip，三档**：仅可查看（沙箱内、只读）、工作区内修改（沙箱内、写入前询问，**新会话的默认**）、完全权限（宿主执行、不再询问，需要一次显式确认）。每档一次写入沙箱与批准两件事——不存在只改一半的路径——当前组合不是任何一档时 chip 显示「自定义」并说明它来自启动环境，而「自定义」只能被读出、不能被选中。档位**属于会话**：换了档只影响当前会话，新建会话回到默认，切回旧会话恢复它自己的档。菜单就是三行（盾牌图标 + 名称 + 当前项的对勾），**只在后端不可用时**多一行说明原因。界面文案由 zh/en 双语字典驱动，主进程的设置校验、失败对话框与回执用同一本字典（`apps/desktop/i18n.ts`，见下文的 `i18n:check`），`index.html` 里的静态中文在切换语言时经反向索引翻译并跟随新增节点；主题（跟随系统／浅色／深色）与三档字号写在根元素属性上。

密钥用系统 `safeStorage` 加密（系统加密不可用时拒绝保存），配置文件（模型、界面、权限、沙箱）都在 Electron 的应用数据目录，MCP 凭据在 `mcp-oauth/`；每个接口分组最多 100 个模型。

### Web

`npm run web` 先构建静态页，再启动一个**只绑回环**的桥：默认端口 `0`（由系统分配）与随机 token，访问地址形如 `http://127.0.0.1:<port>/?token=<token>`，WebSocket 走 `/ws?token=`，非回环来源一律 403。桥自身是 `spawnedCarrier`，页面与桌面共用同一套渲染层与同一个 `CarrierService`。第二标签页会被拒绝且不会踢掉已连接的页面。网页版刻意不提供壳专属能力（附件、MCP 设置、权限与沙箱设置、模型设置），这些请求会返回明确的拒绝文案。

---

<a id="configuration"></a>

## 配置

### 设置只有一个所有者

进程拥有的每个 `YUANTU_*` 名字、它的类型与取值范围都登记在 `packages/protocol/settings.ts` 的 `ENVIRONMENT` 表里，运行上限的默认值同样只在 `RUN_DEFAULTS` 里声明一次。CLI 帮助里的默认值由这些常量渲染。

| 主题         | 变量                                                                                                                                                                                           |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 连接与协议   | `YUANTU_API_KEY`、`YUANTU_BASE_URL`、`YUANTU_MODEL`、`YUANTU_PROTOCOL`、`YUANTU_CONNECTION_ID`、`YUANTU_SUPPORTS_VISION`、`YUANTU_MODEL_CAPACITIES`、`YUANTU_CREDENTIALS_FILE`                 |
| 缓存与重试   | `YUANTU_PROMPT_CACHE`、`YUANTU_MAX_RETRIES`、`YUANTU_REQUEST_TIMEOUT_MS`、`YUANTU_STREAM_IDLE_TIMEOUT_MS`                                                                                      |
| 窗口与预算   | `YUANTU_MAX_CONTEXT_TOKENS`、`YUANTU_MAX_OUTPUT_TOKENS`、`YUANTU_AUTO_COMPACT_TOKENS`、`YUANTU_MAX_PARALLEL_TOOLS`、`YUANTU_TOOL_TIMEOUT_MS`、`YUANTU_INVARIANT_TIMEOUT_MS`                    |
| 上下文整理   | `YUANTU_TOOL_RESULT_KEEP_RECENT`、`YUANTU_TOOL_RESULT_SHRINK_TOKENS`、`YUANTU_CONTEXT_SHRINK_PERCENT`、`YUANTU_TOOL_MODE`、`YUANTU_REPO_MAP`、`YUANTU_FS_OBSERVATION`、`YUANTU_LSP_AFTER_EDIT` |
| 子代理       | `YUANTU_SUBAGENTS`、`YUANTU_SUBAGENT_CONCURRENCY`、`YUANTU_SUBAGENT_TIMEOUT_MS`、`YUANTU_SUBAGENT_MODELS`、`YUANTU_FORK_TRANSCRIPT_CHARS`、`YUANTU_FORK_TRANSCRIPT_MESSAGES`                   |
| 工作区与沙箱 | `YUANTU_WORKSPACE`、`YUANTU_SANDBOX`、`YUANTU_SANDBOX_HOOK`、`YUANTU_SANDBOX_IMAGE`、`YUANTU_SANDBOX_SPEC`、`YUANTU_PTY`、`YUANTU_ALLOW_PRIVATE_NETWORK`、`YUANTU_PERMISSION_POLICY`           |
| 集成与钩子   | `YUANTU_HOOKS_MODULE`、`YUANTU_HOOK_BRIDGE`、`YUANTU_HOOK_TIMEOUT_MS`、`YUANTU_QUESTION_TIMEOUT_MS`                                                                                            |
| 检索与记忆   | `YUANTU_SEARCH_PROVIDER`、`YUANTU_SEARCH_API_KEY`、`YUANTU_SEARCH_BASE_URL`、`YUANTU_MEMORY_DIR`、`YUANTU_KNOWLEDGE_DB`、`YUANTU_MCP_OAUTH_DIR`                                                |
| 调度与会话   | `YUANTU_WORKFLOWS`、`YUANTU_WORKFLOW_INTERVAL_MS`、`YUANTU_SESSION_TITLES`                                                                                                                     |

表中不含仅供测试使用的键（它们同样登记在 `ENVIRONMENT` 里，因为检查必须知道项目自己用到的每一个名字）。CLI 不自动加载 `.env`，配置从进程环境读取；`.env.example` 仅说明变量。桌面配置优先于环境变量，适用于所有工作目录。

`ENVIRONMENT` 的每一条都带一句说明，而那句话此前没有任何读者：设置页有自己的双语词典，CLI 帮助只列出一部分。下面这张表就是它的读者——与事实块同源、同一道门禁，登记一个变量就自动出现在这里，说明不会再只存在于代码里。

<!-- settings:start -->

**由代码算出**：共 62 个名字，取自 `packages/protocol/settings.ts` 的 `ENVIRONMENT`；`npm run docs:generate` 重写，`docs:check` 在不一致时失败。

<!-- prettier-ignore -->
| 变量 | 取值 | 说明 |
| --- | --- | --- |
| `YUANTU_API_KEY` | `string` | 模型 API 密钥 |
| `YUANTU_BASE_URL` | `string` | 模型端点 |
| `YUANTU_MODEL` | `string` | 模型 ID |
| `YUANTU_PROTOCOL` | `anthropic` / `openai` / `openai-responses` | 协议适配器 |
| `YUANTU_CONNECTION_ID` | `string` | 设置文件中的连接名（仅标注） |
| `YUANTU_SUPPORTS_VISION` | `0` / `1` | 该模型是否接受图片 |
| `YUANTU_PROMPT_CACHE` | `auto` / `blocks` / `key-only` / `off` | 提示缓存的粒度：auto / blocks / key-only / off；auto 按路由声明的能力选，其余三种照字面执行，off 不发送缓存字段（旧值 0 / false 等价于 off，1 / true 等价于 auto） |
| `YUANTU_STREAM_IDLE_TIMEOUT_MS` | `1000–3600000` | 流式空闲超时（毫秒） |
| `YUANTU_MAX_RETRIES` | `0–5` | 每个 step 边界重发模型请求的次数上限（0 = 不重试） |
| `YUANTU_MAX_CONTEXT_TOKENS` | `1–100000000` | 模型上下文窗口 |
| `YUANTU_MAX_OUTPUT_TOKENS` | `1–10000000` | 单次输出上限 |
| `YUANTU_MODEL_CAPACITIES` | `string` | 同一端点其他模型的窗口声明（JSON） |
| `YUANTU_AUTO_COMPACT_TOKENS` | `1–100000000` | 提前压缩阈值 |
| `YUANTU_REQUEST_TIMEOUT_MS` | `1000–3600000` | 单次模型请求超时 |
| `YUANTU_MAX_PARALLEL_TOOLS` | `1–32` | 一条助手消息里可同时运行的工具调用上限（1 = 严格串行；只对声明了并行安全的工具生效） |
| `YUANTU_QUESTION_TIMEOUT_MS` | `1000–3600000` | 模型向用户提问的等待超时（毫秒） |
| `YUANTU_TOOL_TIMEOUT_MS` | `0–3600000` | 单次工具调用的墙钟上限（毫秒，0 = 不设上限） |
| `YUANTU_INVARIANT_TIMEOUT_MS` | `100–600000` | 单条运行时不变量检查的超时（毫秒） |
| `YUANTU_WORKSPACE` | `string` | 工作区目录 |
| `YUANTU_SANDBOX` | `host` / `docker` / `sbx` / `windows` | 命令沙箱模式（桌面：新会话从哪个模式开始——档位按会话选择，改动即时生效，不改写这个值） |
| `YUANTU_SANDBOX_HOOK` | `host` / `docker` / `sbx` / `windows` | 钩子用的沙箱模式（默认跟随 YUANTU_SANDBOX；容器模式装不了钩子，所以只能显式写 host） |
| `YUANTU_SANDBOX_IMAGE` | `string` | 沙箱镜像 |
| `YUANTU_SANDBOX_SPEC` | `string` | （内部）沙箱启动器的单次命令载荷 |
| `YUANTU_PTY` | `string` | 终端（terminal_* 工具）使用的 PTY 后端名，默认为内置的 node-pty |
| `YUANTU_ALLOW_PRIVATE_NETWORK` | `0` / `1` | 是否允许访问私有网段 |
| `YUANTU_FS_OBSERVATION` | `0` / `1` | 改动文件前是否要求本运行已读过该文件（默认开启，关闭则不检查） |
| `YUANTU_TOOL_MODE` | `native` / `ptc` | 工具下发方式：native 逐个下发，ptc 折成 run_code + 生成 SDK |
| `YUANTU_PERMISSION_POLICY` | `string` | 权限策略文件路径 |
| `YUANTU_HOOKS_MODULE` | `string` | 扩展钩子模块路径 |
| `YUANTU_HOOK_BRIDGE` | `0` / `1` | 是否加载工作区里声明的外部钩子（.claude/settings.json、.yuantu/hooks.json） |
| `YUANTU_HOOK_TIMEOUT_MS` | `1000–600000` | 单条外部钩子命令的超时（毫秒） |
| `YUANTU_FORK_TRANSCRIPT_CHARS` | `1000–10000000` | 分叉子代理继承的父会话转录字符上限 |
| `YUANTU_FORK_TRANSCRIPT_MESSAGES` | `1–10000` | 分叉子代理继承的父会话消息条数上限 |
| `YUANTU_SUBAGENT_MODELS` | `string` | 额外的可委派模型 id（逗号分隔），供 list_subagent_models 列出 |
| `YUANTU_TOOL_RESULT_KEEP_RECENT` | `0–100` | 末尾永不缩短的工具结果条数 |
| `YUANTU_TOOL_RESULT_SHRINK_TOKENS` | `100–32000` | 缩短后保留的 token 数（头尾各半） |
| `YUANTU_CONTEXT_SHRINK_PERCENT` | `10–95` | 占窗口（或提前压缩阈值）百分之多少时开始缩短旧工具结果 |
| `YUANTU_TOOL_RESULT_PRUNE_THRESHOLD_CHARS` | `1000–10000000` | 旧工具结果超过多少字符时丢弃中段（保留头尾） |
| `YUANTU_TOOL_RESULT_PRUNE_HEAD_CHARS` | `0–1000000` | 丢弃中段时在开头保留的字符数 |
| `YUANTU_TOOL_RESULT_PRUNE_TAIL_CHARS` | `0–1000000` | 丢弃中段时在结尾保留的字符数 |
| `YUANTU_MCP_OAUTH_DIR` | `string` | MCP OAuth 令牌目录 |
| `YUANTU_CREDENTIALS_FILE` | `string` | 凭据文件路径（默认 ~/.yuantu/credentials.json；环境变量中的密钥优先于它） |
| `YUANTU_MEMORY_DIR` | `string` | 用户级记忆目录 |
| `YUANTU_KNOWLEDGE_DB` | `string` | 知识库数据库路径 |
| `YUANTU_REPO_MAP` | `on` / `off` | 是否注入结构大纲 |
| `YUANTU_LSP_AFTER_EDIT` | `0` / `1` | 编辑后是否附加诊断 |
| `YUANTU_SUBAGENTS` | `0` / `1` | 是否启用子代理委派 |
| `YUANTU_SUBAGENT_CONCURRENCY` | `1–16` | 子代理并发上限 |
| `YUANTU_SUBAGENT_TIMEOUT_MS` | `0–3600000` | 子代理无进展（卡住）多久后停止（毫秒，0 = 不设看门狗；只要子代理还在产出就会重新计时，长任务不会被它切断） |
| `YUANTU_SEARCH_PROVIDER` | `string` | 联网搜索提供方 |
| `YUANTU_SEARCH_API_KEY` | `string` | 联网搜索密钥 |
| `YUANTU_SEARCH_BASE_URL` | `string` | 联网搜索端点 |
| `YUANTU_WORKFLOWS` | `0` / `1` | 是否启用持久任务调度 |
| `YUANTU_SESSION_TITLES` | `0` / `1` | 是否用一次模型调用为会话生成标题（默认开启） |
| `YUANTU_WORKFLOW_INTERVAL_MS` | `1000–86400000` | 调度器两次查看之间的最长间隔（到期时刻会直接唤醒它；这里是上限与兜底） |
| `YUANTU_LIBREOFFICE_PATH` | `string` | 可选 Office PDF 预览的 LibreOffice 命令行程序路径（Windows 建议 soffice.com） |
| `YUANTU_NODE_PATH` | `string` | （测试）子进程使用的 node 路径 |
| `YUANTU_QA_DIR` | `string` | （测试）QA 产物目录 |
| `YUANTU_QA_SCREENSHOT` | `string` | （测试）是否截图 |
| `YUANTU_MCP_TEST_SECRET` | `string` | （测试）MCP 夹具密钥 |
| `YUANTU_TEST_DOCKER` | `string` | （测试）Docker 沙箱可用性 |
| `YUANTU_TEST_SBX` | `string` | （测试）sbx 沙箱可用性 |

<!-- settings:end -->

### 模型设置页

桌面可直接配置多组连接（名称、协议、地址、模型、密钥、是否支持图片）。编辑已有连接时密钥框留空表示保留原密钥；更换地址或协议需要重新输入。「测试连接」发送一条无工具的简短请求确认可达，不保存配置。每个用户轮次记录实际使用的模型、协议与连接 ID，切换模型后历史标识不会被覆盖。窗口与输出上限的取值范围只有 `ENVIRONMENT` 一处声明：表单的 `min`/`max`、保存时的校验、以及启动环境的读取都从它取，因此桌面与 CLI 对同一个值给同一个答案；启动环境里取值不合法或名字拼错的设置会在设置页明说，而不是被无声忽略。

---

<a id="facts"></a>

## 生成事实

<!-- facts:start -->

本节数字**由代码算出**：`npm.cmd run docs:generate` 重写，`npm.cmd run docs:check` 会在文档与代码不一致时失败（`scripts/docs-facts.mjs`）。

<!-- prettier-ignore -->
| 指标 | 值 | 来源 |
| --- | --- | --- |
| 工具（空工作区，全部） | 67 个 / 35.9 KB | `createTools().specs()` |
| 工具（只读运行） | 34 个 / 17.6 KB | `specs({ readOnly: true })` |
| 工具（折叠为 `run_code`） | 1 个 / 10.5 KB | `specs()`（`YUANTU_TOOL_MODE=ptc`） |
| `explore` 白名单条目 | 24 条 | `EXPLORE_TOOLS` |
| 会话 schema 版本 | v28 | 新建库上的 `PRAGMA user_version` |
| 持久事件类型 / 实时事件类型 | 49 / 41 | `SESSION_EVENT_TYPES`、`AGENT_EVENT_TYPES` |
| 桌面冒烟套件 | 5 | `smoke:desktop` 的清单 |
| 行为测试文件 | 152 个 | `tests/*.test.ts` |
| 整轮快照场景 | 4 个 | `tests/snapshots/*.json`（`npm run snapshot:update` 重写） |
| `collect_subagents` 的等待上限 | 120000 ms | `SUBAGENT_CEILINGS.collectWaitMs`（描述文本与 schema 必须一致） |

<!-- facts:end -->

---

<a id="boundaries"></a>

## 已知边界

- **上下文窗口是必填项**：解析不出窗口就拒绝运行；内置容量目录只覆盖它明确核对过的端点与模型，不做型号猜测。
- **host 沙箱不是安全边界**：授权后的命令可以访问主机其他位置与网络；命令工具不适合不受信任的工作负载。权限策略作用于需要审批的操作，同样不能代替操作系统沙箱。
- **不提供 `push`、`amend`、`rebase`、`reset --hard`**：它们需要凭据、改写历史或丢弃工作成果，不能由模型顺带推断。
- **文件工具不是并发安全边界**：它们拒绝工作区外路径与符号链接，但不对抗有意绕过它的进程。
- **浏览器工具依赖可选的 `playwright`**；DOCX/PPTX 的创建、编辑与默认 PDF 预览依赖 Windows 和本机 Microsoft Office，XLSX 的读写及默认 HTML 数据预览使用纯 JS。`office_preview` 可显式选择 `backend: 'libreoffice'`，为三种格式生成 PDF；需要另行安装 LibreOffice，真实引擎、字体、版式和公式计算仍需独立验收，见 [P2 实施记录](docs/p2-implementation-2026-10-07.md)。
- **语言服务器支持 host 与 Windows 执行后端**，docker/sbx 明确拒绝；服务器保留创建策略，切换后需要停止并重新启动才能继续请求。服务器不会自动重启，也没有空闲回收，必须显式 `lsp_start`。没有格式化工具，而语言服务器返回的 `WorkspaceEdit` 里除了文本编辑还可能带**建文件/改名/删文件类资源操作**——这些一律拒绝整份编辑，而不是只应用文本那一半（否则引用被改名而文件没动，调用方还会以为重命名成功了）。
- **MCP 没有命令允许名单，也没有域名白名单**：约束是「HTTPS 或回环」加上来源白名单，stdio 传输额外要求 host 沙箱。运行时的授权请求不会自动弹浏览器，必须显式完成一次授权；远端返回的 schema、提示词与内容一律当作不可信数据。工具目录在连接建立时读取一次，此后只在服务器自己发出 `notifications/tools/list_changed` 时按需重读——用已经开着的连接重读，不重握手，也不因为收到通知就立刻发起请求。
- **`verify_file_delivery` 校验的是结构而不是语义**：它核对大小、SHA-256 与魔数，不判断页数、能否被 Office 打开、版式或内容是否正确。
- **Windows 沙箱只限制写入**：工作区外的读与网络不受限，越界写在系统调用层失败。
- **模型设置页目前只暴露模型 ID、上下文窗口与输出上限**：协议的校验接受自动压缩阈值、流空闲超时与视觉能力，但页面还没有对应控件；删除接口的能力已实现，界面尚未接上。
- **子代理默认只往下走一层**（`maxDepth: 1`），且不会比父运行活得更久——要拿结果就必须在运行结束前 collect。
- **运行时不变量与钩子都不是沙箱**：同步的可信 JS 与忽略取消信号的异步钩子需要硬终止保证时，应由嵌入方放进 worker。
- **guest 脚本使用独立 Node 进程**：`run_code` 与 `workflow` 复用 host/Windows 执行后端，内部 Worker 的 V8 堆上限 256MB，console 输出 8KB，RPC 帧及总输出有上限。每条工具 RPC 经 catalog 校验、原有审批和并发管线；失联保留已知收据，未确认效果阻止自动续跑。VM 和 Node Permission Model 都不是恶意代码沙箱，直接效果仍取决于所选 OS backend；Windows 仍是部分写入边界，host 不提供 OS 隔离。目前 docker/sbx 程序 runner 未完成运行时路径接线，会明确拒绝而不回退 host。
- **CLI 不是 Host**：它不监听端口，`--listen` 会被明确拒绝。
- **数据库自动备份仅在旧库迁移前触发**：没有周期备份或自动恢复；较新 schema 的库仍拒绝打开，恢复需停止使用者并显式执行维护命令。
- 环境检查只做在 CLI 与 Host，库代码不做——嵌入方进程里可能存在别的 `YUANTU_*` 变量。

---

<a id="development"></a>

## 开发

```powershell
npm.cmd run check        # format:check → docs:check → references:check → i18n:check → typecheck → test → build → smoke:client → smoke:web
npm.cmd run check:changed   # 开发时按 Git 改动及传递依赖选择验证；不确定时回退全量
npm.cmd run check:changed -- --plan   # 只预览改动、选测数量与回退原因
npm.cmd test             # 全量行为测试：仅输出汇总、跳过原因和失败详情，完整日志落盘
npm.cmd test -- tests/host-requests.test.ts   # 明确指定测试文件
npm.cmd run test:verbose    # 原始详细输出，排查时使用
npm.cmd run check:full      # 阶段验收；与 check 相同
npm.cmd run check:release   # check 加真窗口桌面冒烟；打包另行执行
npm.cmd run smoke:desktop   # 真窗口 Electron 冒烟（需要图形桌面）
npm.cmd run bench:check     # 确定性基准门禁
npm.cmd run docs:generate   # 重写 README 的生成事实块
```

开发验证的选测规则、日志、并发与增量类型检查见 [测试工作流](docs/testing-workflow.md)。`check:changed` 用于开发反馈，不替代阶段验收或发布前的完整门禁。

`npm run check` 里的 `docs:check` 会**计算**文档引用的数字并与文档比较：它既重写生成事实块，也拒绝那些曾经为真、现在不再为真的说法（`scripts/docs-facts.mjs` 里逐条带原因登记）。因此本 README 里的计数一律以生成块为准，而不是手写。`references:check` 管另一半：文档、工作流与 `package.json` 脚本里指向本仓库的路径必须存在，markdown 链接的 `#anchor` 必须能解析（`scripts/check-references.mjs`），因此「引用了被删掉的文件」会在门禁里失败，而不是等到 CI 或读者发现。

`i18n:check` 是语言门禁的另一半。渲染层的门禁是**真窗口冒烟**：切到 `en-US` 后遍历可见 DOM，任何还能看到的中文都算失败——这对渲染层是对的，因为它本来就以中文为源文本，由遍历器在渲染时翻译。主进程没有 DOM，它产出的校验文案、失败对话框与设置回执只会被递给可能已经切到英文的页面，所以这里改用静态规则：**人读的模块把词放进 `apps/desktop/i18n.ts`**，这些文件里再出现中文就失败（扫描前先剥掉注释，所以规则针对代码而不是注释；行号按原文给，注释吞掉换行的话报的位置就会漂）。规则本身是**目录扫描**而不是文件清单——`apps/desktop/**/*.ts` 默认全在门禁内，例外只有四条并各带理由（渲染层自己的模块与字典、`session-management.ts`、给模型的 `attachment-contract.ts`），且每条例外必须仍然匹配到文件：改名或被删就会失败，而不是悄悄少扫一个模块（`scripts/i18n-gate.mjs`）。guest worker 另有一条规则：`packages/tools/*worker*.ts` 的文案进的是模型与调用方的日志、不是带语言的人，所以要求是「保持英文」而不是「进字典」；桌面自己的 worker 属于界面进程，仍按界面规则。两个进程读同一本字典，因此设置页的标签和它自己的报错不会各说一种语言。

CI 的 `check` job 直接跑 `npm run check`——聚合名是唯一入口，因此新增的门禁不可能只加进 `package.json` 而漏在 CI 里（`smoke:web` 就这样漏过）。CI 在 Linux 上跑检查、基准与覆盖率，Windows 上单独跑桌面冒烟。部分测试在外部依赖缺失时会**带原因自我跳过**（真实语言服务器、Docker 守护进程、本机 Office、Playwright 的 Chromium 下载），这是预期行为而不是失败。
