# Windows 沙箱账户后端 第一期：令牌 Spike 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 确定 runner 的令牌方案：`WRITE_RESTRICTED`（不降 Low）下 node 能否派生子进程；据此在设计文档 §3.3 选定主方案或退路方案。

**Architecture:** 复用 `packages/tools/sandbox-windows.ts` 里的 C# 启动器源码，加一个环境变量开关控制是否 `SetLowIntegrity`，在 PowerShell 中 `Add-Type` 后直接调用 `YuantuSandbox.Run`，分别运行 fork 探针、`node --test`（多文件，会 fork）。全部是一次性代码，放在 scratchpad，不进仓库。

**Tech Stack:** Node 22+、Windows PowerShell 5.1、C#（Add-Type）

**Spec:** `docs/superpowers/specs/2026-10-21-windows-account-sandbox-design.md`

## Global Constraints

- spike 代码不进仓库；只把结论写回设计文档 §3.3 与本计划末尾。
- 不执行任何提权操作，不创建账户。真实账户（`CreateProcessWithLogonW`）验证在第二期验收中由用户在 VM 里确认后执行。

---

### Task 1: 令牌矩阵 spike

**Files:**
- Create（scratchpad）：`spike/run.mjs`、`spike/fixture/fork.js`、`spike/fixture/a.test.js`、`spike/fixture/b.test.js`

- [ ] **Step 1:** 写 fixture：`fork.js` 用 `spawnSync(process.execPath, ['-e', ...], {stdio:'pipe', input})` 回显 stdin 并打印 `FORK-OK`；`a.test.js`、`b.test.js` 各一个通过的 `node:test` 用例。
- [ ] **Step 2:** 写 `run.mjs`：从 `sandbox-windows.ts` 提取 `launcherSource`，把 `SetLowIntegrity(restricted);` 替换为 `if (Environment.GetEnvironmentVariable("SPIKE_LOW") == "1") SetLowIntegrity(restricted);`，写入 scratchpad 的 `.cs`；对矩阵 {Low, 不降 Low} × {`node fork.js`, `node --test`} 逐一生成 PowerShell 脚本，`Add-Type` 后调用 `[YuantuSandbox]::Run(cmd, fixtureDir, env, @(workspaceSid), 0xD)`，记录退出码与输出。
- [ ] **Step 3:** 运行 `node spike/run.mjs`，预期：Low 组合复现 `spawn EPERM`（与线上一致，证明 spike 有效）；记录不降 Low 组合的结果。
- [ ] **Step 4:** 若不降 Low 也失败，再加一组 {不带 `WRITE_RESTRICTED`（flags=0x5）+ Low} 以区分两个因素。
- [ ] **Step 5:** 把结论写入设计文档 §3.3（删除另一方案或保留为备注）和本计划“结论”节；提交两个文档。

## 结论

本机（Windows 11 26300，Node 24.19）结果，启动器 = 现有 C# 启动器 + 开关：

| 令牌 | fork（spawnSync + stdio pipe） | `node --test`（2 个文件） |
|---|---|---|
| WRITE_RESTRICTED + Low | EPERM | EPERM |
| WRITE_RESTRICTED，不降 Low | EPERM | EPERM |
| WRITE_RESTRICTED，不降 Low，默认 DACL 补 Everyone + logon | EPERM | EPERM |
| 无限制 SID（DISABLE_MAX_PRIVILEGE \| LUA_TOKEN）+ Low | OK | 2/2 通过 |
| 无限制 SID，不降 Low | OK | 2/2 通过 |

- 根因是 `WRITE_RESTRICTED` 受限令牌，不是 Low 完整性。
- 设计文档 §3.3 改为退路方案：runner 不加限制 SID，写边界由沙箱账户 SID 的 ACL 决定，同一账户同一时刻只租给一个工作区。
- 未覆盖：真实沙箱账户经 `CreateProcessWithLogonW` 启动的行为（需管理员建账户），放到第二期在用户确认后验证。
