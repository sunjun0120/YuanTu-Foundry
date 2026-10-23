# SWE-bench Verified 外部评测

本目录把 YuanTu Agent Host 的补丁交给官方 SWE-bench 验收器。冻结子集包含 50 题，另有 5 题冒烟集；它不是排行榜成绩，也不表示真实模型已经通过。

当前完成数据与仓库准备，生成端和官方验收端尚待实现。此阶段不调用模型、不运行被测 Python 仓库的代码，不需要本机 Docker 或 WSL。

## 冻结的数据

题目来自 [SWE-bench Verified](https://huggingface.co/datasets/SWE-bench/SWE-bench_Verified)，`test` 划分；固定 Hub revision、种子、抽样规则、每题完整记录的 SHA-256 和冒烟题目列在 [subset-v1.json](subset-v1.json)。记录哈希覆盖所有原始字段；完整数据留在本地缓存，不交给被测 Agent。

按仓库比例使用最大余数法分配 50 个名额，每仓库至少 1 题；仓库内再按难度分层。输入先按题目 ID 排序，再使用固定种子的 mulberry32 洗牌。冒烟集只选两档较低难度，覆盖至少 3 个仓库。选样命令只创建新文件，不覆盖既有子集。

在临时 Python 虚拟环境安装 `datasets==5.1.0` 后运行：

```powershell
python benchmarks/swe-bench/fetch-dataset.py --revision 78f471bf655a3137b2e8a75af1501690ec009ec3 --out .scratch/swe-bench/dataset/78f471bf655a3137b2e8a75af1501690ec009ec3.jsonl
node benchmarks/swe-bench/select-subset.mjs .scratch/swe-bench/dataset/78f471bf655a3137b2e8a75af1501690ec009ec3.jsonl 78f471bf655a3137b2e8a75af1501690ec009ec3 .scratch/swe-bench/subset-reproduced.json
```

下载不需要模型凭据。缓存位于 `.scratch/swe-bench/`；可用 `HF_HOME` 将 Hugging Face 缓存也放在此目录。只对子进程设置下载代理，不改系统设置。

## 仓库副本

[repos.mjs](repos.mjs) 将公开仓库存为 `.scratch/swe-bench/repos/<owner>__<name>.git`，再按 `base_commit` 创建 detached worktree。缓存保留部分克隆的 promisor 配置，能够按需获取该提交的文件对象。副本创建后必须校验 HEAD 精确相等且工作区干净。`core.autocrlf=false`、`core.longpaths=true` 仅用于缓存及本次 Git 命令，不写全局配置。

工作副本与缓存共用 Git 对象；保留工作副本时也必须保留缓存。清理副本应使用对应缓存的 `git worktree remove <absolute-workspace>`，不要手工删除活跃 worktree 元数据。

## 离线验证

```powershell
node scripts/run-tests.mjs tests/swe-bench.test.ts
```

测试只使用内置假数据和本地临时 Git 仓库，不联网、不调用真实模型。完整检查使用 `npm run check`；它不等于真实模型评测、官方 Docker 验收或桌面发布验收。
