# 程序 runner 部署产物

`npm run build:program-runner` 只构建 `dist/program-runner`，不会安装服务、拉取镜像或改变沙箱模式。正常 `npm run build` 及 Windows 安装包也包含这些文件。

目录中只有 `code-process-entry.js`、`code-worker.js`、`package.json`、`manifest.json` 和 `Dockerfile`。两个 ESM bundle 仅依赖 Node 内置模块，不依赖宿主的 `node_modules` 或工作区文件。目录出现额外文件、子目录或文件链接时，构建拒绝继续，避免把无关内容纳入部署。

`manifest.json` 记录协议版本 1、最低 Node 主版本 24，以及两个 bundle 和 package.json 的 SHA-256。它用于部署方核对内容，不是签名，也不能单独证明镜像可信。部署方必须自己确定可信镜像来源和不可变内容身份。

Dockerfile 要求显式传入 `RUNNER_BASE`，没有默认基础镜像。部署方应选择已核对的 Linux Node 镜像，使用完整 digest 固定基础镜像；文件中还检查 Node >=24，并以非 root 用户运行。Dockerfile 只负责装配，网络、挂载、资源上限及容器清理仍需后续启动适配器负责，不能据此宣称隔离已经通过验收。

## 启动协议

broker 启动后首先输出 JSONL `{"type":"ready","protocol":1,"nodeMajor":24}`，实际 nodeMajor 由运行版本得出。宿主核对协议及最低版本后，才发送包含脚本、工具名和显式输入的 start 消息。握手前工具调用、重复握手、版本不符、畸形消息、启动断线和 5 秒无响应均拒绝；取消及失败会等待进程收尾。

后续工具调用沿用宿主的目录、schema、权限、审批和日志管线；此批没有新增容器工具授权。已有 RPC 帧、输出、调用数和日志上限继续生效。

## 当前验收边界

2026-10-09 已验证独立 bundle 在本地 Node 子进程里的握手、计算及工具 RPC，另有启动失败和取消回归。该测试不运行容器，不证明容器网络、挂载或凭据隔离。

Docker/sbx 的程序入口仍明确拒绝，且不回退 host。本机缺少 Docker CLI；sbx 仅核对到 CLI 0.45.1，服务、模板、标准流和隔离尚未验收。后续须先完成可信启动适配器、真实镜像运行与清理验收，再开放容器程序入口。Git、PTY、LSP、stdio MCP 和后台 workflow 不在本批范围内。
