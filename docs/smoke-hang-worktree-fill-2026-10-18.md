# 冒烟偶发卡住与子工作树填充（2026-10-18 晚）

处理 [剩余问题修复记录](remaining-fixes-2026-10-18.md) 第 4 节中的前两项：`agent.smoke.mjs` 偶发卡住，以及子工作树填充（`fillWorktree`）重复落盘。基线是 `7bed298`。

## 1. `agent.smoke.mjs` 偶发卡住

### 1.1 现象与复现

两次留存的失败日志（`.scratch/test-logs`）里，超时的分别是“子代理”用例（180 s）和“模型思考”用例（120 s）。这两个用例都会在中途 `app.close()` 后重启应用；不重启的 5 个用例从未超时。

用 `DEBUG=pw:api,pw:browser` 只跑这两个用例，第 2 轮就复现了：日志停在 `electronApplication.close started`，此后没有任何输出。此时 Electron 主进程已经退出，系统里还剩一个 `cmd.exe /d /s /c "echo probe> ...\yuantu-sandbox\probe-<pid>.txt"`，父进程已不存在，唯一线程的状态是 `Wait / Suspended`。

### 1.2 根因

桌面启动时会用独立的 Node 进程做一次沙箱可用性探测（`sandbox-probe-worker` → PowerShell 启动器 → 受限令牌下的 `cmd.exe`）。启动器原来的顺序是：

1. `CreateProcessAsUserW(..., CREATE_SUSPENDED)`；
2. `AssignProcessToJobObject`（作业设置了 `KILL_ON_JOB_CLOSE`）；
3. `ResumeThread`。

第 1 步和第 2 步之间，子进程已经存在，但还不属于任何作业。用例退出应用时，探测往往还没跑完；Electron 退出会连带结束探测进程和 PowerShell（libuv 给子进程挂的作业）。如果恰好落在这个窗口里，挂起的 `cmd.exe` 就没人恢复、也没人结束，并且一直持有它继承来的标准输出/错误管道。Playwright 的 `close()` 要等 Electron 的 stdio 全部关闭才返回，所以一直等到用例超时。

佐证：机器上还留着 8 个同类挂起进程，创建时间与历史上卡住的几次运行一一对应，其中包括 `remaining-fixes` 记录的那次失败（`agent.smoke.mjs-6so4cC`，16:34:48）。

`yuantu-appcontainer.exe`（AppContainer 模式）也是“先创建、后加入作业”，有同样的窗口。

### 1.3 修复

两个启动器都改成用 `PROC_THREAD_ATTRIBUTE_JOB_LIST` 在创建时直接放进作业，去掉单独的 `AssignProcessToJobObject`：

- [sandbox-windows.ts](../packages/tools/sandbox-windows.ts)：C# 启动器改用 `STARTUPINFOEX` 和属性列表，传入 `EXTENDED_STARTUPINFO_PRESENT`。启动器 DLL 按源码哈希命名，旧缓存不会被沿用。
- [main.rs](../packages/tools/windows-sandbox/appcontainer/src/main.rs)：属性列表从 2 项增加到 3 项，加上作业列表；作业的创建移到属性列表之前。

子进程从创建那一刻起就在 `KILL_ON_JOB_CLOSE` 作业里，启动器无论在哪一步被结束，它都会随作业句柄关闭而结束。启动器在测试环境变量 `YUANTU_SANDBOX_TEST_LAUNCH_PAUSE_MS` 下会在创建后暂停，用来把窗口从微秒级放大到秒级；这个变量来自启动器自身的环境，被沙箱隔离的命令改不到它。

### 1.4 验证

| 检查                                                                                   | 结果                                                                                        |
| -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| 新增 `sandbox-windows.test.ts`“启动器在启动命令时被结束，命令随之结束”                 | 修复前稳定失败（挂起的子进程存活）；修复后通过                                              |
| 两个重启用例循环（`DEBUG=pw:api`，单独运行）                                           | 修复前 2 轮中 1 轮卡住；修复并重新构建后 15/15 通过，耗时 11–24 s，没有出现新的挂起探测进程 |
| `sandbox-windows`、`sandbox-appcontainer(-native)`、`windows-sandbox-host` 等 6 个文件 | 58 例：56 通过、0 失败、2 跳过（WFP 网络验收、容器内子进程管道，与之前各次运行的跳过相同）  |

**遗留**：修复前留下的挂起探测进程不会自行退出，需要手动结束（它们只占一个挂起的 `cmd.exe` 和对应的 `conhost.exe`）。

## 2. 子工作树填充

### 2.1 原来的成本

`git worktree add --no-checkout` 之后，工作树基本是空的，`fillWorktree` 逐个文件串行执行：`lstat` 目标 → 读取快照存储里的文件 → 计算 sha256 → `writeFileExact` 再读一次目标（不存在）→ 每个文件一次递归 `mkdir` → 写入。同一个快照派生出的每个子代理都重复这一整套操作，包括重新读取和哈希。

### 2.2 改动

- [snapshot.ts](../packages/workspaces/snapshot.ts) 新增 `verifiedSnapshotFile`：校验存储文件的 sha256 后，按 size/mtime/ctime/ino 记住“已验证”。同一快照后续的子工作树，只要存储文件没变就跳过重新读取和哈希；文件一旦被改写或替换，就重新完整校验。
- [manager.ts](../packages/workspaces/manager.ts) 的 `fillWorktree`：目录先统一创建一次；文件以 8 路并发填充；format 3 的文件用 `copyFile(COPYFILE_EXCL | COPYFILE_FICLONE)` 复制。支持克隆的卷（ReFS/Dev Drive、APFS、btrfs）上不重复占用数据块，其他卷由内核复制，不再把内容读进 JS 内存再写出去。复制后核对文件大小。出错时其他并发任务不再领取新文件，并且等所有在途写入结束后才抛出，调用方的清理不会和写入竞争。format 2 清单和工作树里已有的文件仍走原路径。

### 2.3 测量

新增 [worktree-fill.ts](../benchmarks/worktree-fill.ts)：`node benchmarks/worktree-fill.ts <文件数> <单文件KiB> <子代理数>`。合成仓库每 10 个文件有 1 个内容重复，并有 1 个未提交修改。冻结一次后，从同一快照分配 N 个子工作树。本机 NTFS（不支持克隆），每组跑 2 次，取接近的结果：

| 场景                      | 指标                   | 修改前                       | 修改后                       |
| ------------------------- | ---------------------- | ---------------------------- | ---------------------------- |
| 2000 × 16 KiB（31.3 MiB） | 4 个子工作树的分配耗时 | 3743 / 3740 / 3645 / 3599 ms | 1500 / 1387 / 1370 / 1390 ms |
|                           | 峰值 RSS               | 82 MiB                       | 89 MiB                       |
| 16 × 2 MiB（32 MiB）      | 4 个子工作树的分配耗时 | 536 / 536 / 518 / 533 ms     | 475 / 447 / 457 / 445 ms     |
|                           | 峰值 RSS               | 107 MiB                      | 107 MiB                      |

小文件多的仓库分配耗时降到约 38%；大文件场景由复制本身主导，只快了约 15%。峰值 RSS 多出约 7 MiB，来自首次校验时 8 路并发的读取缓冲。NTFS 上仍然会完整写一遍数据；只有在支持克隆的卷上，才会省掉重复的数据块，本机没有这样的卷可测。

### 2.4 新增回归

- `workspace-manager.test.ts`“一次分配用过的存储文件被改动后，下一次分配会拒绝”：验证缓存不会掩盖篡改（`WORKSPACE_INTEGRITY`）。
- `workspace-manager.test.ts`“内容相同的文件各自填充；子代理原地修改不会影响存储副本”：验证克隆/复制不是硬链接。

## 3. 冻结与结果导出的逐文件开销

### 3.1 定位

同一基准下，冻结 2000 个 16 KiB 文件约 17.6 s，而 16 个 2 MiB 文件（总字节数相近）只要约 1.1 s，说明冻结开销按文件数增长，与字节数关系不大。在 `freezeSnapshot` 里临时加计时（已移除）后，2000 个文件的分段耗时是：

| 阶段                     | 累计       |
| ------------------------ | ---------- |
| 仓库就绪检查             | 0.3 s      |
| 第一次遍历（只算摘要）   | 1.0 s      |
| 第二次遍历（写暂存目录） | 3.6 s      |
| `buildTree`              | **19.1 s** |
| 提交、发布               | 19.2 s     |

`buildTree` 占了约 15.5 s。单独在 Git 里试：`hash-object -w --stdin-paths` 写 2000 个对象需要 4.3–19.7 s，每个对象都要建一个松散对象文件（波动来自本机文件系统和扫描）。关掉 fsync 没有变化，换 `core.fsyncMethod=batch` 也没有。用 `core.bigFileThreshold=1` 逼它直接写包，结果是每个对象一个包，用了 30 s。`git fast-import` 把同样 2000 个 blob 写进一个包只要约 0.37 s，对象 id 完全相同。

结果导出用的 `collectTreeBlobs`（上一轮 R-02 的改动）每个文件启动一次 `git hash-object`，2000 个文件要 **72 s**。

### 3.2 改动

- [git.ts](../packages/workspaces/git.ts) 新增 `openBlobBatch` / `writeBlobs`：一个 `git fast-import --quiet --done` 进程接收所有 blob，最后用 `get-mark` 从标准输出按顺序取回 id，不在仓库旁边写 marks 文件。写入遵守背压，调用方一次只持有一个文件。fast-import 不跑过滤器、钩子和属性，存进去的就是原始字节。小批量（少于 `fastimport.unpackLimit` 个对象）由 Git 自己展开成松散对象。中途出错或取消时会结束进程并抛出错误。
- `buildTree`：暂存文件逐个读出，交给 `writeBlobs`，`update-index --index-info` 保持不变。
- `collectTreeBlobs`：遍历时把每个文件送进同一个批次，结束后按顺序配上 id。
- `writeTree`：需要写入的条目改为一次批量写。
- 删除已经没有调用方的 `writeBlob`。

### 3.3 测量（2000 × 16 KiB）

| 指标                                 | 修改前              | 修改后                                                 |
| ------------------------------------ | ------------------- | ------------------------------------------------------ |
| `collectTreeBlobs`（结果导出的遍历） | 72.0 s              | 0.95 s                                                 |
| `freezeSnapshot`                     | 17.5–17.6 s（2 次） | 6.5–6.6 s（5 次中 4 次；第 1 次 13.8 s，属于本机波动） |
| 16 × 2 MiB 冻结                      | 1.1 s               | 1.3 s                                                  |

冻结剩下的约 6.5 s 里，第二次遍历写暂存目录约占 2.5 s（逐文件建文件），两次遍历的读取和哈希约占 2 s。暂存目录是填充子工作树的数据来源，要去掉它得把快照内容改存成 Git 对象，属于格式变更，本轮没有做。

### 3.4 新增回归

`workspace-blob-batch.test.ts`：id 与 `hash-object` 逐个一致且顺序正确（含空文件、重复内容、二进制、CRLF），对象能读回；超过 unpackLimit 的批次写成包后仍能读回；空批次；取消时拒绝；数据源抛错时放弃批次并重新抛出。workspace-_、subagent_ 共 214 例通过。

## 4. 门禁与全量

| 检查                                                                                                                                                       | 结果                                                                          |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `format:check` / `docs:check` / `references:check` / `cycles:check` / `layers:check` / `i18n:check` / `typecheck` / `test:isolation:check` / `audit:check` | 全部通过（新增测试环境变量已登记到 `ENVIRONMENT`，README 生成表已重新生成）   |
| `npm run build`                                                                                                                                            | 通过                                                                          |
| 全量 `node scripts/run-tests.mjs --continue-on-failure`                                                                                                    | 并行 2692 例：2666 通过、2 失败、24 跳过；串行 60 例：56 通过、0 失败、4 跳过 |
| `smoke:client`                                                                                                                                             | 3/3                                                                           |
| 桌面冒烟 8 个套件                                                                                                                                          | 55 例：52 通过、1 失败、2 跳过；`agent.smoke.mjs` 7/7                         |

全量里的 2 个失败：

- `environment.test.ts`“项目读取的 YUANTU_* 名字都已登记”：新增的 `YUANTU_SANDBOX_TEST_LAUNCH_PAUSE_MS` 没有登记，是本轮引入的。已登记，重跑通过。
- `carrier.test.ts`“后台轮询只在变化时重新发布”：用的是假 Host，不经过沙箱或工作区。单独连跑 3 次都通过；`.scratch/test-logs` 里本轮之前已有 3 次同样的失败，属于负载下的计时偶发问题。

桌面冒烟的 1 个失败：`desktop.smoke.mjs`“后台任务和子代理并列显示”，点击“停止任务”时被卡片头部挡住。单独连跑 3 次都通过；本轮之前的日志里已有 3 次同样的失败，与本轮改动无关。
