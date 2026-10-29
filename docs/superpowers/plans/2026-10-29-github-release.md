# GitHub Release Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 标签发布经过验证的 Windows 安装包，用户从 GitHub Releases 下载。

**Architecture:** 保留现有 Windows 验证任务；增加版本检查和独立、最小写权限的发布任务，通过 artifact 传递本次构建的两个文件。

**Tech Stack:** GitHub Actions、PowerShell、GitHub CLI。

**Spec:** [设计](../specs/2026-10-29-github-release-design.md)

## Global Constraints

- 标签必须严格等于 `v` 加上 `package.json` 的版本。
- 手动运行仅生成 Actions 构建产物；普通提交不触发此流程。
- 不覆盖已有 Release，不实际推送标签或发布版本。
- 复用当前 checkout，只修改本任务文件，保留已有工作区修改。

## Review Focus

- 版本不匹配必须在构建前失败。
- 前置验证失败或手动触发不能发布。
- 安装包或校验清单缺失不能发布。
- 现有升级验证仅接受三个数字分量的稳定版本；标签构建应在开头拒绝预发布和 build metadata 版本。
- CLI 发布失败必须使任务失败，不能覆盖已有发行文件。

### Task 1: 发布工作流和使用说明

**Files:** 修改 `.github/workflows/windows-package.yml` 和 `README.md`。

**Interfaces:** 构建任务输出 `YuanTu-Agent-Windows-x64` artifact；发布任务消费其中的版本对应安装包和 JSON 校验清单。

- [x] 在 scratch 中验证现有工作流缺少发布和版本检查。
- [x] 增加版本检查、只读默认权限、依赖验证成功的标签发布任务，并让 artifact 缺失时报错。
- [x] README 补充版本更新、提交和推送标签命令，以及 Releases 下载说明。
- [x] 解析 YAML 并执行真实 PowerShell 步骤，以本地 CLI 替身验证匹配、不匹配、手动运行、预发布拒绝、缺失文件和 CLI 失败。
- [x] 运行修改文件的格式检查、文档及引用检查，审阅差异；记录云端验收尚待首次标签运行。

本次配置修改采用本地可执行验证，不新增永久测试文件、不提交其他正在进行的工作。

## 验证记录

- YAML 解析、触发条件、权限和 artifact 关联检查，以及 12 个 PowerShell 可执行场景通过；发布命令使用本地替身，没有请求真实发布。
- 修改文件的 Prettier 检查、`references:check` 和差异空白检查通过；独立审阅未发现遗留阻断问题。
- `docs:check` 报告已有生成事实块及设置表漂移。两个生成块与 HEAD 完全一致；用 HEAD 的 README 对当前代码复查，得到相同的两项失败，因此未刷新其他工作产生的生成内容。
- 云端完整安装、升级、回滚和实际 Release 上传，需要首次提交配置并推送匹配标签后验收；本次没有创建或推送标签。
