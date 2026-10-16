# 六项复核遗漏修复计划

> 执行方式：本会话按 executing-plans 逐项实施，全部完成后集中审查与全量验证。

目标：修复 22429e6 上独立复现的六项遗漏，保留正常关停答复、分页和大响应兼容、已显示文本以及恢复副本安全余量。

约束：用户已授权六项修复；沿用当前 checkout，不提交 Git，不改动产品策略，不调用真实模型。逐项 RED/GREEN 定向验证，所有问题解决后才运行全量。审计与测试临时文件在交付前清理。

- [x] 命令语言字段：`packages/carrier/contract.ts` 放行且校验 goal/plan 的可选 language；解析回归涵盖两种语言、旧调用及非法字段；最新桌面 workflows 冒烟复验。
- [x] 出站背压：`apps/agent-host/carrier.ts` 将背压越界的硬拒写与普通关停结算分开，越界帧在 write 前拒绝；用受阻输出测试、既有取消/关闭回归验证。
- [x] 历史帧预算：`apps/agent-host/handlers/history.ts` 核对完整兼容结果及传输封装，包含 statistics/steps/session 和分隔符；验证近 64 MB 边界和 16 MB 旧契约。
- [x] 上下文超限：`packages/core/run-request.ts` 分类不依赖可见文本；已输出时保存原文且不重发、不压缩，错误码仍为 context-window-exceeded。
- [x] Responses 兼容：`packages/providers/responses.ts` 对缺失/null 的 incomplete_details 保持 length 回退；保留 content_filter 与 max_output_tokens 判定，补真实解析回归。
- [x] 备份空间：`packages/storage/database-maintenance.ts` 写出临时副本后只检查剩余空间是否保有 reserve；测试模拟余量充足/不足及常规容量预算不变。

最后：完成独立审查及必要修复，类型/格式/文档/引用/i18n/循环/构建和相关桌面/编译客户端验证通过，冻结相关文件哈希，再运行一次最终串行全量。平台签名、安装和原生隔离验收不在本轮范围内。

## 执行记录

- 基线：22429e6，工作区干净。
- Ruling：用户已明确授权修复这六项已复现问题，按既有行为做有界修复，不重复请求设计批准；保留新发现问题的具体证据，修复范围内的审查遗漏一并收口。
- 六项均先复现正确 RED，再修复。审查补充发现背压预算漏计低于水位的写入、累计预算误伤部分排空读者，已改用 UTF-8 Buffer 与实际 writableLength 核算，并增加多水位、多字节、部分排空与正常取消回归；独立审查无剩余 P1/P2。
- 桌面任务复验发现夹具将 Chromium profile 放在被指纹监测的工作区内，造成 EBUSY；四项 workflows 夹具已隔离 profile，任务执行夹具明确记录 task_step 后再请求人工确认。备份冒烟的导航列表已纳入已有的工作区维护入口，保留禁用自动备份和恢复防护断言。
- 定向结果：语言/任务 41 通过；历史/大响应 20 通过；上下文/失败码 28 通过；providers 58 通过；备份/升级 36 通过、3 项既有 CLI 跳过；最终 carrier/客户端/TCP 四文件 85 通过。四项 workflows 与三项编译客户端均通过，备份桌面冒烟补验通过。
- 全桌面门禁暴露子代理 UI 旧夹具依赖 auto 模式共享写入，现由原生 worktree 策略正确拒绝（WORKSPACE_POLICY_UNSUPPORTED）；夹具显式使用已有 shared 模式，并将旧 changes-list 定位迁移到当前回合文件卡片的预览，审批、实际文件内容、作者归属、会话恢复和语言断言保留。完整单用例 14.19 秒通过；补充只读审查确认没有弱化产品策略或验收条件。
- 桌面九文件发现批次：59 项，57 通过、1 项夹具失败、1 项既有 MCP 跳过（466.67 秒）；失败为上述已修的子代理用例，其他八文件无失败。修复后的 agent 文件正在整文件重跑，避免把发现批次误记为通过。
- 已冻结 701 个源码/配置/测试文件的 SHA-256，后续只更新验收记录；全量结束后逐项核对。
- agent 桌面整文件重跑 7/7 通过（80.87 秒）；加上发现批次中其他八个通过文件，最终分组验收覆盖九文件 59 项：58 通过、1 项既有 MCP 跳过。发现批次失败和修复后的通过分别保留原始 timings，不将失败批次改写成成功。
- 13:22–13:54 最终串行全量完成：236 文件、2534 项，2420 通过、0 失败、114 跳过、0 取消，exit 0，1941.99 秒。无文件过滤、无用例过滤；没有新增跳过项，原暂停入口及平台/环境条件仍按既有测试规则处理。
- 全量结束后核对 701 个源码/配置/测试文件，SHA-256 全部一致。类型、构建、格式、文档、引用、i18n、循环依赖门禁均通过；没有提交 Git。以上只覆盖本批缺陷与已运行的门禁，平台发布验收仍按原独立计划处理。

## 最终验收证据

- 命令：`npm test -- --schedule=serial --timings=artifacts/six-followup-repairs-20261016/full-timings.ndjson`。
- [全量逐项计时](../../../artifacts/six-followup-repairs-20261016/full-timings.ndjson)及[原始汇总元数据](../../../artifacts/six-followup-repairs-20261016/full-timings.ndjson.meta.json)：基线 22429e6、236 文件、未过滤、串行，工作区保留本批修改。
- [冻结源码清单](../../../artifacts/six-followup-repairs-20261016/source-sha256.json)：701 文件，最终验证与冻结快照一致。
- [桌面发现批次](../../../artifacts/six-followup-repairs-20261016/desktop-discovery-timings.ndjson)保留原失败；[修正夹具后的 agent 整文件验证](../../../artifacts/six-followup-repairs-20261016/agent-desktop-timings.ndjson)为 7/7 通过。其余八文件在发现批次均通过，分组验收覆盖 59 项，58 通过、1 项既有 MCP 跳过。
