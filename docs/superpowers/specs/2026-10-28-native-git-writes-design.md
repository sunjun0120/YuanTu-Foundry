# 原生模式下的受控 Git 写入

用户已选择补齐原生沙箱下 Git 写入：专用 Git 工具经现有审批写仓库，普通命令继续不能写 `.git`，不切换到 host 模式，不扩展 stdio MCP。

## 方案

- 不移除 `.git` 的沙箱保护：共享账号/令牌上的临时放行会影响并发普通命令。
- 不把任意 Git、hooks 或过滤器带到宿主执行。
- 使用专用 Host Git 元数据代理，仅允许暂存/取消暂存、提交、创建受管 worktree。它是受控的宿主操作，不宣称 Git 写入进程受 OS 沙箱隔离。原生读取仍走现有 runner，`host` 工具行为保留。

## 边界

- 保留审批；prepare 和 execute 都拒绝只读策略；每个 common-dir 串行写入。
- 原生发现仓库后才可进行宿主操作；复核 canonical root、git-dir、common-dir 和受管 worktree 反向关联，执行前拒绝身份变化。元数据中的链接、多硬链接、外部 alternates 和 partial-clone 配置拒绝。
- Git 发现、验证读取和元数据写入都从工作区外的绝对 PATH 项解析，使用同一个可信 Git 程序。原生写入要求选定工作区就是仓库根，拒绝 `core.worktree` 重定向到别处。禁用 hooks、filters、fsmonitor、签名、维护、外部 diff、协议与 lazy fetch。
- 拒绝配置 include/includeIf；带 clean/smudge/process 或 required 过滤器的仓库拒绝原生暂存和 checkout，提交已有暂存内容及取消暂存可用。此限制比只检查当前匹配的文件更严格，因为普通并发命令能在检查后改写 `.gitattributes`，不能默默改变 LFS 等文件的存储格式。
- 提交记录 index 内容摘要、HEAD/分支和配置；审批期间变化则拒绝。复核 worktree 目标及父目录，保持原工作区和未提交文件。
- 复用 Git 输出上限、取消、超时和清理。真实账号隔离验收仅在可丢弃 CI 环境；本地不初始化、删除或维护真实沙箱账号。

## 验证

真实 Git 仓库覆盖正常写入、拒绝/只读无副作用、审批期间暂存内容变化、hook/filter 哨兵、元数据链接与可执行文件劫持。保留原生读 runner 与普通命令保护回归。独立审查最终改动。
