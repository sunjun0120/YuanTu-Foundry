# 容器程序 runner 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 先交付可独立部署的最小 runner 和执行前握手，再以真实容器验收为条件开放 Docker；sbx 独立验收。

**Architecture:** broker/worker 构建为独立 ESM 产物，版本握手在发送脚本之前完成。宿主保留统一 RPC 校验、权限和收尾职责。没有真实 Docker 环境时保持现有拒绝行为，不用宿主模拟冒充容器验收。

**Tech Stack:** Node 24、TypeScript、esbuild、Node test、Docker。

**Spec:** [设计](../specs/2026-10-09-container-program-runner-design.md)

## Global Constraints

- 不自动拉取、安装或激活容器服务；runner 只含最小可信运行文件。
- 不挂载宿主安装目录、工作区、凭据或 Docker socket。
- 保留全部无关工作区改动；没有本次提交请求，不提交。
- 开发只跑相关检查；实际接线完成的里程碑再跑一次全量。
- 容器未经真实验收继续拒绝，不回退 host。

## Review Focus

- 旧 runner、重复握手或握手前 RPC：脚本和工具均不得开始。
- 握手前断线、取消和静默启动：等待必须有界，等待清理结束。
- 完成后多余 RPC、非法帧及超量输出：维持现有拒绝和收尾。
- 部署目录被混入旧文件：构建拒绝不属于产物的文件，避免意外打包。
- 只有 CLI 或 fixture 可用：不能宣布容器隔离验收成功。

### Task 1: 独立 runner 与协议握手

**Files:** `packages/tools/environment.ts`、`code-process-entry.ts`、`code-process.ts`、`scripts/build-program-runner.mjs`、`tests/program-runner.test.ts`、`tests/program-handshake.test.ts`、`package.json`、`electron-builder.config.cjs`。

**Interfaces:** `validateCodeReady(value: unknown): void`；`connectCodeProcess(data, running, signal)`；`buildProgramRunner(output: string): Promise<void>`。产物为两个 ESM 文件、package.json、manifest.json、Dockerfile；协议 1，Node >=24。

- [x] 写真实子进程回归：初始 ready、版本不符/握手前调用无脚本效果、启动断线/取消、正确握手后计算及 RPC；运行见红。
- [x] 增加执行前握手，保持原消息限额、断线语义及退出清理；定向见绿。
- [x] 写独立构建回归，运行见红；构建两个最小 bundle、内容哈希清单、固定基础镜像输入的 Dockerfile。
- [x] 独立 bundle 真实执行计算和工具往返，验证目录不含其他项目文件，并纳入正常构建/安装包。
- [x] 更新部署说明、待修复状态；运行相关程序/workflow/权限回归、类型、格式及文档检查；独立审阅。

### Task 2: Docker 接线与真实验收（依赖真实服务）

**Files:** 后续新增 `packages/tools/program-container.ts`、`tests/program-container.test.ts`，修改 `code-process.ts` 和可信设置。

- [ ] 核对可信镜像协议和内容身份，使用不可变镜像 ID；CLI 环境不继承密钥。
- [ ] 限制网络、写权限、资源及挂载；复用可取消进程生命周期和容器清理责任。
- [ ] 真实镜像验收：RPC 读、拒绝/批准写、凭据、网络、断线、取消、workflow 子任务及清理。
- [ ] 真实验收通过后开放入口，固定源码运行一次完整门禁。

### Task 3: sbx 独立验收

- [ ] 按已安装 CLI 的真实模板和标准流契约设计启动方式。
- [ ] 通过同等真实隔离验收后接线；未验证继续拒绝。

## Execution Ledger

- 2026-10-09：用户确认继续。当前没有 Docker CLI；sbx 仅核对到 CLI 版本 0.45.1，未验证服务/隔离。推进 Task 1，Task 2/3 不以模拟结果代替真实验收。
- 用户随后明确选择“没有，先保持容器入口拒绝”；本批停在可验收的 Task 1，不开放容器入口。
- 独立审阅发现握手后不完整帧和初始发送错误丢失，已补红回归后修复；追加初始写入取消、快速结果、清理错误名称和延迟投递取消回归。审阅已复核通过。
- 相关 9 个文件复跑 102 项通过；最后延迟投递取消修复另跑 4 个受影响文件，52 项通过。最终类型、所改文件格式、文档事实、引用、i18n 及 diff 检查通过。仅运行定向构建，不运行镜像构建、安装包生成或全量门禁。
