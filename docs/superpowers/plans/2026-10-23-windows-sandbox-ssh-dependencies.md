# Windows 沙箱加固 3：SSH 配置引用的文件不进入可读根 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `~/.ssh/config`（及其 `Include`）引用的文件——放在 `.ssh` 之外的私钥、证书、known_hosts、ControlPath——所在的目录不会成为沙箱可读根。

**Architecture:** 新模块 `account/ssh_config.rs` 移植 Codex `ssh_config_dependencies.rs` 的解析（`Include` 递归、路径类指令、`~`/`%d`/`${HOME}` 展开、引号与转义）。`read_refresh` 把含有任一依赖的自动根当作「未发现」（已授予的随之按过期撤销），`grant_snapshot_locked` 拒绝含依赖的用户路径。

**Tech Stack:** Rust，无新依赖（`Include` 通配只支持最后一级的 `*`/`?`，Codex 用的 `glob` crate 不引入）。

**Spec:** 设计 §5.2；参照 Codex `ssh_config_dependencies.rs`、`setup.rs::filter_ssh_config_dependency_roots`（`openai/codex@86e17e9`）。

## 更正

此前对比把这一项写成「Codex 让沙箱能读 SSH 配置、git 可走 ssh」，读源码后确认相反：Codex 用这些依赖**排除**可读根，防止 `.ssh` 之外的私钥泄露；Codex 沙箱内同样不能用 ssh。

## Global Constraints

- 分支 `windows-sandbox-hardening`；提交前 `cargo test --locked`、`npm run format:check`、`npm run docs:check`。
- 解析失败或文件不存在一律视为「无依赖」，不影响 refresh；`Include` 递归深度上限 32，循环用规范化路径去重。
- 提交信息中文，末尾 `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`。

---

### Task 1：解析器

**Interfaces:** Produces `pub fn dependencies(profile: &Path) -> Vec<PathBuf>`（含 `~/.ssh/config` 本身）。

- [ ] 失败测试（临时 profile）：`IdentityFile ~/keys/id_ed25519` → `profile\keys\id_ed25519`；`Include config.d/*` 递归收集被包含文件里的 `CertificateFile`；`IdentityFile none` 忽略；`Include` 自引用不死循环；引号与 `key=value` 形式；无 config 时只返回 config 路径。
- [ ] 实现并通过；提交 `feat(windows-sandbox): 解析 SSH 配置引用的文件`。

### Task 2：接入可读根

- [ ] 失败测试：`read_refresh` 中 PATH 指向的工具目录里放一个被 `IdentityFile` 引用的文件 → 该根进入 `skipped`（原因含 `SSH`）且不记录；已授予的根之后出现被引用文件 → 下一次 refresh 撤销；`grant_snapshot_locked` 对含依赖的用户路径返回 `"Path holds a file the SSH configuration uses"`。
- [ ] 实现：`read_refresh::refresh_with` 在授予前过滤 `discover` 结果；`grant_snapshot_locked` 开头检查。
- [ ] 通过、更新设计 §5.2、提交 `feat(windows-sandbox): SSH 配置引用的文件所在目录不授予沙箱读取`。
