# 源图AI 桌面端功能优化：合并执行方案

> 日期：2026-10-27  
> 状态：可开始实施；本文是本轮实现与验收的完整依据  
> 评审时代码基线：`b58a8cc`（main）；执行前记录实际 HEAD，按当前代码定位，不依赖旧行号  
> 来源：`docs/2026-10-27-desktop-tabs-browser-and-session-labels.md`、本轮 6 项评审发现及用户追加的 3 项功能  
> 本文只定义实现任务，未宣称功能已完成或测试已通过。原文档保留供追溯；冲突处以本文为准。

<!-- references:planned -->

## 1. 执行目标与已确定决策

完成 R1–R8，交付可运行的 Electron 桌面端。执行 agent 应先阅读适用的 AGENTS.md（仓库没有时读用户级）、package.json 和本文，再按 §8 推进；不要把已经明确的需求重新列为待确认问题。

| 编号 | 目标                                                         | 优先级 |
| ---- | ------------------------------------------------------------ | ------ |
| R1   | 模型选择框按当前模型名定宽，文字靠近箭头                     | P0     |
| R2   | 删除输入框右上方的可见会话 ID                                | P0     |
| R3   | 未命名会话统一显示“新增会话”                                 | P0     |
| R4   | 右侧标签栏新增 `+`，支持文件和浏览器标签                     | P0     |
| R5   | 新增用户可手动操作的内置浏览器                               | P0     |
| R6   | 右侧源码文件显示语法高亮                                     | P0     |
| R7   | 顶部展开右侧面板默认进入新建标签页，提供浏览器和文件两个入口 | P0     |
| R8   | 左侧支持多工作区、分组会话、悬停操作和两级折叠               | P0     |

默认决策如下，直接据此实施：

- R7 是后续明确要求，覆盖旧稿“默认文件树、点击 + 只弹菜单”的设计。顶部从收起状态展开面板以及点击 `+`，均激活新建标签页。
- 新建标签页只有“工作区文件”“浏览器”两个入口；不实现终端。
- 固定“新建标签页”在标签栏第一位，固定“文件”在第二位，均不可关闭；文件树只有一个实例。打开其他内容不会复制这两个固定标签。
- `+` 位于可滚动标签条之后、面板动作按钮之前；点击它激活固定新建页，不无限创建空白选择页。
- 浏览器采用 `WebContentsView`；不启用 webviewTag、不放宽应用 Host 页面的 CSP。
- 浏览器标签在本次应用运行内跨工作区保留，不跨重启恢复；独立浏览数据分区跨重启保留；最多 8 个浏览器标签。
- 浏览器支持 http/https 和本地开发服务器，搜索默认 Bing。浏览器内容不会自动发送给模型。
- “项目”是左侧总分组，每个工作区是本地文件夹，工作区下展示自己的会话；不新增另一层 Git 仓库/项目实体。
- 首次安装默认工作区使用 `<userData>/workspace`（保持现有默认），安装目录及其子目录不得注册为工作区：内置升级在 app 目录与数据目录重叠时会直接拒绝（`prepareUpgrade` 的 overlap 预检），卸载/覆盖安装还可能连带删除安装目录下的 `.yuantu/sessions.sqlite`。首次启动显示该路径和“选择其他目录”入口；目录不可写时给出原因，不静默改成别的路径、不要求提权运行整个应用。
- 工作区重命名只改列表显示名称。菜单“删除”仅从列表移除，保留真实目录、文件、会话数据库及历史；不得调用删除磁盘目录的工具。
- 不同工作区运行中的任务可以继续后台执行。完成多 Host 路由隔离之前，保留现有运行中禁止替换 Host 的保护。
- 下载完整体验、右键菜单和浏览器快捷键属于后续增强；本轮至少拦截并取消未支持的下载，给出提示。

## 2. 现状与代码入口

| 领域           | 当前实现与入口                                                                                    | 改造关注点                                                                         |
| -------------- | ------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| 外壳与左栏     | `apps/desktop/ui/layout/ProductShell.tsx`                                                         | 当前是一个工作区路径和切换目录按钮，改为项目/工作区/会话结构                       |
| 会话列表       | `apps/desktop/ui/sessions/SessionSidebar.tsx`、`SessionRow.tsx`、`session-model.ts`、相关挂载模块 | 会话标题回退、每工作区列表、菜单与搜索隔离                                         |
| 模型选择       | `apps/desktop/ui/settings/ModelPicker.tsx`                                                        | 当前测量所有选项最大宽度，最小 150px                                               |
| 页面投影       | `apps/desktop/ui/application.tsx`、`chrome.ts`                                                    | sessionShort、聊天标题、工作区选择和各订阅                                         |
| 右侧面板       | `apps/desktop/ui/workspace/WorkspacePanel.tsx`、`workspace-model.ts`、`workspace-mount.tsx`       | 当前 selected=null 表示文件树，tabs 按文件路径存储                                 |
| 文件预览       | `apps/desktop/ui/workspace/FilePreview.tsx`                                                       | 非 Markdown 文本目前是纯文本 pre                                                   |
| 已有高亮       | `apps/desktop/markdown.ts`、`ui/styles.css`                                                       | 已依赖 highlight.js，有语言注册与 hljs 样式；右侧部分通用 span 规则会覆盖语法颜色  |
| 进程与 IPC     | `apps/desktop/main.ts`、`main-context.ts`、`preload.ts`、`contract.ts`                            | 当前一个 service；attach 替换订阅；chooseWorkspace 在运行中拒绝切换                |
| 启动目录       | `apps/desktop/install-paths.ts`、`main-context.ts`                                                | 保持 userData/workspace 默认；注册表、显式参数优先级与旧用户发现规则；禁止安装目录 |
| 会话存储       | 默认 `<workspace>/.yuantu/sessions.sqlite`                                                        | 多工作区保留原数据库归属，不搬库、不合库                                           |
| 现有工作区工具 | `workspace-maintenance*`、`packages/workspaces`、`workspace.remove` 等                            | 用于隔离子代理目录，不可直接当作左栏项目管理接口                                   |

现有 `browser_*` 工具是 Agent 使用的 Playwright 能力，不是本轮浏览器面板。两者保持独立权限、进程/页面与会话状态。

## 3. 产品行为与验收要求

### 3.1 R1：模型选择器贴合当前模型

- 只测量当前实际选中项的 label，包含环境模型标签、未配置模型占位、语言变化和禁用状态。
- 推荐宽度：`clamp(ceil(labelWidth) + 40, 72, 360)`；测量字体与真实输入框一致。
- Mantine `rightSectionWidth` 固定为 24px，箭头图形约 13px；输入框左内边距 8px、右内边距 28px。文字末端到箭头左缘保持约 8–14px。
- 对短到触发 72px 下限的名称，文字靠右排列，让多余空间留在左侧，避免最小宽度重新扩大文字与箭头间距。
- 长名称省略，title 展示完整选中标签；下拉菜单仍可完整阅读各项，不随触发器缩小。
- 选中项、语言或字体就绪后重新测量；宽度可用 120ms 过渡，尊重 prefers-reduced-motion。
- 删除三处旧的 150px/最长项逻辑：`ModelPicker.tsx` 的 `useState(150)`、`styles.css` 中 `.chat-page .chat-model .model-picker-frame { min-width: 150px }`，以及“按最长选项测量”的组件注释与 CSS 注释；保留现有模型切换业务规则。
- 验收覆盖短模型与长模型互切、环境模型、未配置模型、禁用状态、中英文、820px 最小窗口；发送按钮可见且 composer 不横向溢出。

### 3.2 R2：删除输入框右上会话 ID

- 删除 ProductShell 中 `#session-short`，删除 chrome.sessionShort 字段、application 中对应投影及两处 session-short 样式。
- 保留运行状态文本，不能留下空白占位或孤立分隔符。
- 保留内部 sessionId、data-session-id、日志与数据库标识。
- 新建、已命名、运行中的会话和中英文界面均不再在 composer 顶部显示 ID。

### 3.3 R3：未命名会话名称

- 新增字典键 `ui.untitledSession`：中文“新增会话”，英文“New session”。
- 侧栏行、聊天标题、tooltip、重命名/删除会话弹窗、归档会话列表（`ArchivedSessions`）统一使用该回退；非空标题原样保留，`sessionTooltip` 不再拼接完整 ID。
- `ui.newSession` 仍用于“新建会话”按钮；不要将动作文案和未命名标题混用。
- 首条人类用户消息持久化后显示摘要，后续自动标题和手动重命名沿用当前逻辑。
- 删除无展示用途的 `ui.sessionShort` 并更新迁移测试。`SessionRow` 与归档行的操作按钮 aria-label 可继续使用短 ID（不可见文本），视觉文本不显示 ID。
- 多个未命名会话允许同名，通过所属工作区、相对时间和状态区分。

### 3.4 R4/R7：右侧标签与新建页

1. 顶部 `#open-workspace` 从关闭状态展开右侧面板时，激活“新建标签页”，不直接显示文件树或之前的网页；面板已经打开时仍作为收起按钮。
2. 新建页主体展示两个可通过键盘操作的入口：“工作区文件”“浏览器”，各有图标和说明；不含终端、不自动创建 guest。
3. 选择“工作区文件”激活固定“文件”标签，并按当前工作区加载根目录；重复选择不产生新文件树标签。
4. 选择“浏览器”每次创建独立浏览器标签，激活起始页并聚焦地址栏；最多 8 个，达到上限时入口禁用且原因可读。
5. 标签顺序是固定“新建标签页”、固定“文件”、按打开顺序排列的源码/文件预览与浏览器标签。已存在文件再次打开只激活，不重排。
6. 可关闭标签有独立关闭按钮。关闭当前项选右邻、否则左邻、否则新建页；关闭非当前项不影响当前项。
7. 两个固定标签不进入 `tabOrder`（可关闭标签顺序），但属于完整的 roving tabindex 标签序列：左右方向键、Home/End 在固定标签与可关闭标签之间移动；`+`、关闭按钮另可用 Tab 到达，操作具备 aria-label。
8. 固定标签不随可关闭标签滚动；`+` 位于滚动标签条之后、面板动作按钮之前。面板宽小于 240px 时固定标签只显示图标（tooltip 与 aria-label 保留全称），`+` 和面板动作按钮始终可见。新建页在 180–360px 面板宽度内可用，180px 按图标布局验收。
9. 收起不销毁现有标签。再次由顶部展开时回到新建页，原有文件/网页继续保留，可从标签栏重新选中。
10. 从聊天消息直接打开文件应激活该文件，不绕到新建页；打开浏览器弹窗也直接激活对应浏览器。
11. 切换工作区时清理旧工作区的文件树/文件预览；当前若是文件或文件树则回到新建页，若是浏览器或新建页则保持类型。不能复用旧工作区同名文件的预览。
12. 新建页显示“当前工作区：名称”；无可用工作区时文件入口禁用并提供添加工作区入口，浏览器仍可用。

Escape 规则：地址栏先恢复 URL 并 stopPropagation；浏览器主体中的按键由 guest 处理。面板自身获得 Escape 时先退出面板全屏，否则从文件预览回到新建页，其他情况收起面板；不因此关闭网页。不要依赖 guest 键盘事件冒泡到 Host DOM。

### 3.5 R5：内置浏览器

- 地址栏支持完整 http/https URL、裸域名、localhost/IP:port 和搜索词；空输入不导航，非法输入提示。
- 提供前进、后退、刷新/停止、外部打开；历史按钮同时随普通导航和 SPA/同文档导航更新。
- 标签显示页面标题，回退主机名或“浏览器新标签页”；标题作为纯文本，过长省略且 tooltip 完整。
- 加载中显示 spinner；主框架失败显示错误描述、代码、URL、重试和外部打开；崩溃显示重新打开并重建视图。
- 起始页/错误页由应用 HTML 渲染，出现时原生视图隐藏；浏览器工具栏始终在 guest 矩形之外。
- 普通 GET 的 target=_blank/window.open(http/https) 转为新浏览器标签；禁止协议不打开。
- 带 postBody 的新窗口请求明确拒绝并在来源标签显示提示，不能丢弃请求体后偷偷发 GET；不自动交给系统浏览器。v1 不承诺依赖 opener 的 OAuth 回传。
- 用户可主动打开系统浏览器重新操作；两者登录态隔离，系统浏览器不能接收原 POST 或恢复原 opener。
- 已知限制：依赖 POST 弹窗或受控子窗口的 OAuth、SAML `form_post` 登录在 v1 不可用；`about:blank`、`blob:` 等非 http/https 弹窗同样不打开。提示文案与 README 必须写明这些限制，不要把“用系统浏览器重试”描述成可保持登录态或重放原 POST。
- 所有浏览器标签共享 `persist:yuantu-browser`，与应用默认 session、Agent browser_* 工具的 profile 隔离。
- guest 无 preload、无 window.yuantu、无 Node；权限默认拒绝，证书错误不绕过；支持本地开发 HTTP，不擅自添加私网地址封禁。
- 上限在主进程强制执行，关闭标签立即释放 guest；达到上限时页面弹窗也不能绕过限制。
- 用户失焦或切换其他应用不会销毁网页；隐藏/最小化只影响可见性，恢复时按当前界面状态重新布局。
- v1 不下载远程 favicon。未实现下载保存体验前，在 will-download 中取消下载并通知来源标签；不自动打开文件。
- 非激活标签静音并使用 Chromium 后台节流；激活时恢复该标签的正常音频策略，不为节省内存自动销毁有表单或运行状态的页面。
- Ctrl+L、Alt+方向键、浏览器右键菜单、完整下载功能为 P1；无需为完成本轮自动扩大范围。

### 3.6 R6：右侧文件代码颜色

- 根据扩展名/明确语言映射选择语法，至少覆盖 JS/JSX、TS/TSX、JSON、Python、HTML/XML、CSS、Shell、PowerShell、YAML、Java、Go、Rust、C/C++；未知类型使用纯文本。
- 复用 highlight.js core 与按需注册的语言，抽取与 Markdown 共用的高亮模块；不导入全语言包，不把源码重新包装成 Markdown 解析。
- 保留空格、换行、制表符和原始文本复制；使用等宽字体和横向滚动。空文件提示、现有图片/Office/Markdown/diff 预览继续工作。
- 原始源码不得直接作为 innerHTML。只有 highlight.js 基于文本产生的转义后结果可以用于高亮 DOM；无法高亮时用 textContent 或 React 文本节点回退。
- 文件中的 script、img/onerror、HTML 标签只能显示为源码，不能执行或发起远程请求。
- 明暗主题均至少区分关键字、字符串、注释、数字；检查并调整现有 `.workspace-panel .code-block code span` 等通用颜色规则，避免覆盖 hljs token 颜色。
- 沿用 FILE_PREVIEW_BYTES=128KiB 的读取上限和截断提示。超过 64KiB 的可见文本回退纯文本；说明该降级，不在同步主线程对大文件自动猜语言。
- 按文件内容版本和语言缓存高亮结果，不因每个流式 token 或无关全局状态更新而重新计算。
- 验收包括同一示例中关键字/字符串/注释/数字有可辨颜色、复制结果一致、明暗主题、大文件回退及 HTML 注入样例。

### 3.7 R8：左侧多工作区

#### 3.7.1 布局与交互

```text
⌄ 项目                                      [+]
  ⌄ YuanTu-Foundry                 [···] [新建]
      新增会话                          刚刚
      修复登录错误                     5 分钟
  ⌄ another-project               [···] [新建]
      分析接口                          昨天
  › archived-project
```

- “项目”标题和其右侧新增入口持续可见；折叠项目分组只隐藏全部工作区子项。
- 工作区左侧独立折叠箭头控制其会话列表；点击工作区名称选择该工作区，不把选择、折叠和新建会话三个动作混在一起。
- 每个工作区行的 `···` 和新建会话按钮在 hover 或 focus-within 显示；触摸/粗指针设备保持可发现。预留按钮位置，避免行宽跳动。
- 操作按钮不嵌套在另一个 button 中；点击操作不能触发行选择或折叠。均有 tooltip、aria-label，键盘可到达。
- `···` 只有“重命名”“删除”。菜单打开、Esc 关闭、焦点归还遵循已有菜单规范，并参与浏览器浮层检测。
- 项目整体、每工作区分别记录 collapsed 状态；重启后恢复。折叠只影响显示，不停止任务、不变更当前会话。
- 工作区按添加顺序稳定排列；新增追加，重命名不重排。当前工作区及当前会话有明确选中态。
- 每工作区的会话分页、展开更多、搜索、归档入口和菜单状态单独保存；现有搜索默认限定当前工作区，不隐式改为全局跨库搜索。
- 点击 B 工作区的新建会话时，在 B 下创建一次并选择它，即便之前正在查看 A；A 的会话与后台任务不受影响。
- 保留顶部通用“新建会话”时，其目标是点击当时捕获的当前工作区；无当前工作区时进入添加工作区流程。

#### 3.7.2 新增、重命名与删除

- 项目右侧 `+` 使用主进程文件夹选择器，取消无副作用；添加现有目录，不自动创建新项目文件。
- 主进程 realpath/stat 验证目录，按实际目录身份去重，处理 Windows 路径大小写、软链接/junction 别名。同一路径再次添加只选择已有项。
- 默认显示目录 basename；根目录使用可读盘符/目录名，完整规范化路径在 tooltip 可见。
- 重命名只更新显示名，trim 后 1–80 字符；拒绝空名/控制字符。同名但不同路径可存在，以路径区分。
- 删除使用稳定 workspaceId，只从注册表软移除。提示明确“从项目列表移除，磁盘文件与会话保留”，可提供撤销。
- 有运行、排队、审批等待或维护写操作的工作区禁止移除，说明原因；用户可先完成或显式停止相关工作。不得因移除隐式中断任务。
- 删除非当前项不切换会话；删除当前空闲项后选择相邻可用项并加载其上次会话。最后一个工作区移除后显示空态与新增入口，不删除数据库，也不自动重建默认工作区项。
- 重新添加同一目录可以恢复原显示名/稳定身份和历史会话；会话以真实磁盘数据库为准，注册表不是消息真源。
- 目录失效/盘符离线时保留行并显示不可用，提供重试/移除；不能在原路径静默创建空目录并伪装为原工作区。

#### 3.7.3 首次安装与旧数据迁移

1. 优先使用本次显式 `--workspace`/YUANTU_WORKSPACE，保留现有启动参数语义；将实际选择注册到列表。显式路径若等于或位于安装目录内，拒绝注册并提示选择其他目录（`prepareUpgrade` 会判定 app/data 目录重叠）。
2. 已有注册表则恢复列表、有效的 activeWorkspaceId、上次会话和折叠状态；不覆盖已有条目或重复初始化。
3. 无注册表时按以下顺序确定旧工作区：显式参数 → `<userData>/workspace`（旧安装版默认，存在则注册）→ 首次默认。导入不搬动其 `.yuantu` 数据库；记录 initialized=true。旧版本没有保存最近工作区，曾用 `--workspace`/YUANTU_WORKSPACE 的用户需带同一参数启动一次，或通过“添加工作区”重新添加；不猜测其他路径。
4. 真正首次安装且无旧数据时，注册 `<userData>/workspace`，由 Host 首次启动时创建；不得使用安装目录、resources、随包 Node 的目录或开发者 cwd。开发模式沿用显式目录或项目 cwd。
5. 默认目录或显式目录不可读/不可写时仍可展示默认项及原因，在启动 Host/创建数据库前进入目录受限状态并提供选择可写目录；禁止为此自动提权、修改 ACL 或写入不明替代路径。
6. 注册表在 userData 中持久化 schemaVersion、initialized 和 activeWorkspaceId；空列表也是有效已初始化状态，不能每次重启重新添加默认项。
7. 安装升级/可执行文件路径变化不重置已有注册表；不按新安装路径猜测旧工作区的数据位置。安装目录及其子目录始终不得成为工作区。

## 4. 数据模型、进程与路由

### 4.1 右侧面板模型

用显式类型替换 selected=null 的复用语义：

```ts
type PanelTab =
  | { kind: 'new' }
  | { kind: 'files' }
  | { kind: 'file'; path: string }
  | { kind: 'browser'; id: string };
type ClosableTab = Extract<PanelTab, { kind: 'file' | 'browser' }>;
```

WorkspaceState 保留 open/fullscreen/expanded/listings/failures，新增 active、tabOrder、fileTabs、browserTabs，以及明确的 workspaceId。默认 active={kind:'new'}；固定 new/files 不进入 tabOrder，渲染顺序固定为 new、files、tabOrder；roving tabindex 序列包含固定项与 tabOrder。

- FileTab 保留现有 shown/error/reading/token/scrollTop/changeKey/changePreview/documentUrl，按工作区与路径识别。关闭/切换释放 blob URL 和高亮缓存。
- BrowserTab 包含稳定 id、可空 viewId、url/title/loading/started/error/crashed/canGoBack/canGoForward，以及非页面加载错误的 notice。
- tabOrder 每项都对应存活的 fileTabs/browserTabs，不重复；active 必须有效；无可关闭项时回到 new。
- 新增 openNewTab、openFiles、openBrowser、activateTab、closeFileTab、closeBrowserTab、navigate/history/reload/stop/focus/layoutBrowser、updateBrowserFromMain、dispose。
- setWorkspace 增加 generation，取消/丢弃旧文件读取与目录请求，清空文件状态并撤销 blob URL，保留窗口级浏览器状态。旧工作区异步结果不得写入新工作区。
- DOM 保留现有文件定位器，并添加 data-workspace-id/data-browser-id/data-tab-kind；不继续让测试把“第一个 tab”视为文件树。

### 4.2 工作区注册表

新增独立的桌面项目注册表与管理 IPC，不复用隔离子代理工作区维护接口。建议文件：

- `apps/desktop/project-workspaces-contract.ts`：纯类型与输入校验。
- `apps/desktop/project-workspaces-store.ts`：注册表读取、迁移、原子写入和串行化更新。
- `apps/desktop/main-project-workspaces.ts`：新增/选择/重命名/移除/恢复、目录选择和路径身份检查。
- `apps/desktop/ui/projects/ProjectSidebar.tsx`、`WorkspaceRow.tsx`、`project-model.ts`：左侧项目结构及控制器。

每个条目至少有 id、canonicalPath、displayName、collapsed、lastSessionId、order、removed；运行状态由 Host 当前快照提供，不从过期 JSON 猜测。组折叠、activeWorkspaceId 与初始化状态属于注册表顶层。displayName 不参与目录身份和 IPC 路由。canonicalPath 等于或位于 app 安装目录内的条目一律拒绝注册。

写入使用同目录临时文件与原子替换并串行化；失败显示原因且保留上一份有效状态。损坏/未来 schema 不能静默覆盖为默认列表，需保留原文件并显示恢复入口。

### 4.3 多 Host 管理

当前 main.ts 的全局 service、snapshotSender、pendingState、choices、runNotifier 和 MainContext 都假设单 Host，仅在 UI 增加分组是不完整实现。

新增 WorkspaceHostManager，按 workspaceId 持有 CarrierService、独立 Host epoch、snapshot/delta 发送状态、订阅、模型选择跟随状态和通知状态：

- Host 按需启动；切换视图不停止旧 Host。活跃运行、排队、审批等待或维护中的 Host 不回收；非当前且无任何运行/审批的空闲 Host 可在 5 分钟未使用后释放，同时最多保留 3 个空闲 Host，释放后从会话数据库重载列表。
- 未启动 Host 的工作区在左栏只显示名称、路径与不可用/加载标记，不伪造会话行；首次展开该工作区时启动 Host、读取真实会话列表并缓存到本次运行的内存（不跨重启）。当前工作区始终启动。不为折叠行加载全部消息/图片，也不为渲染一行启动所有 Host。
- 选择工作区的过渡先准备目标 Host；目标启动失败时保留原视图与任务，失败条目可重试，不先清空原会话。
- 正在后台运行的工作区在折叠行上仍显示运行/等待标记；需要审批时能定位到对应工作区和会话，批准命令必须发送给原目标。
- 同一目录只能有一个本应用注册表身份和对应 Host；Host 启动前继续执行现有工作区 hook 信任审查。
- 模型/凭据/通用设置仍按现有作用域管理；每次运行固定其配置，设置修改不得通过重启所有 Host 终止后台任务。逐个复核依赖 MainContext.service 的模块。
- 退出应用时复用现有运行中退出处理，覆盖全部 Host；确认退出后等待所有 service 停止、设置写入完成并销毁浏览器视图。
- 完成上述隔离和回归之前，不得直接删除旧 chooseWorkspace 的运行中保护来“实现切换”。

### 4.4 IPC 与事件归属

- 每个工作区业务命令在点击/发起时捕获 workspaceId；异步目录对话框、菜单、确认弹窗、文件读取、复制/导出和回调不能在完成时重新取“当前工作区”。
- 会话的 UI key/请求身份是 `(workspaceId, sessionId)`，不能假设跨库 sessionId 永不冲突。
- 扩展 bridge 为显式工作区命令封装，例如 `workspaceInvoke({workspaceId, hostEpoch?, command})`；注册表管理、浏览器和全局设置使用独立通道。迁移完全部工作区调用后，旧无目标业务入口应拒绝含糊调用。
- 全量快照、增量、子代理、统计、错误、审批和通知都携带 workspaceId/hostEpoch。每个 Host 使用独立 patch 基线；新订阅/重启首包必须是完整快照。
- renderer 按 workspaceId 保存状态，只将选中工作区的正文投影到聊天区；非当前工作区增量只能更新自己的缓存和状态标记。
- 快速 A→B→A 切换使用选择版本令牌；较早请求不能抢回选中态。已重启 Host 的旧 epoch 事件直接丢弃。
- 主进程所有新 IPC 继续 assertSender，限制为可信 Host 主 frame；校验 ID 归属、路径、名称、bounds 和命令类型，不给 guest 暴露 bridge。
- 删除条件在串行化操作中重新检查运行/排队/审批/维护状态，避免确认期间新任务启动造成误移除。

## 5. 浏览器实现与六项评审修正

### 5.1 视图创建和生命周期

新增 `browser-contract.ts`、`browser-views.ts`、`browser-url.ts` 和 UI browser 组件。主进程管理 `viewId -> {view,state}`，只有一个 guest 可见；browser 控制不经过工作区 Host，也不生成会话消息。

WebContentsView 的 webPreferences 固定 sandbox=true、contextIsolation=true、nodeIntegration=false、nodeIntegrationInSubFrames=false、webSecurity=true、allowRunningInsecureContent=false，无 preload。会话分区统一为 persist:yuantu-browser。

- 创建先隐藏，renderer 完成 viewId 绑定与 bounds 同步后再决定是否可见。
- create 返回前标签已关闭：拿到 viewId 后立即 destroy。创建前输入的待导航地址按标签身份保存，成功后只执行该标签最后一次有效提交。
- 切标签、收起面板、切设置页、新建页/错误页、HTML 浮层出现时隐藏；effect cleanup 发送 visible=false，取消尚未发出的 rAF。
- 失焦不销毁。窗口 hide/minimize 暂时隐藏；show/restore 发送 layout-request，让 renderer 根据实际路由、active、overlay 与 surface 尺寸重新布局。主进程还需拒绝隐藏/最小化窗口中到达的过期 visible=true 请求。
- 仅关闭标签、显式重建崩溃页面、实际销毁窗口或退出应用才释放相应视图；macOS 关闭按钮只隐藏窗口时保留页面。
- 每次销毁解除监听、从 contentView 移除并关闭 webContents，保证幂等；释放顺序以当前 Electron 43 API 实测为准。
- bounds 来自 `.browser-surface.getBoundingClientRect()`，取整、限制为有限非负尺寸并夹取到窗口内容区域；不把窗口屏幕坐标和 CSS/DIP 坐标混用。
- ResizeObserver、window.resize、路由/可见性/主题/标签变化触发布局，rAF 合并 IPC。验证 100%/125%/150% DPI 和副屏。

### 5.2 修正一：浮层不能只检查节点存在

当前 CommandPalette、PermissionChip、SessionSidebar 的 menu/listbox 节点隐藏后仍在 DOM。`Boolean(querySelector(...))` 会令浏览器永久隐藏。

- 检测 role=dialog/menu/listbox 的实际显示状态，排除自身或祖先 hidden、aria-hidden=true、display:none、visibility:hidden，以及无布局矩形的节点。
- 排除工作区面板自身：`#workspace-panel` 在全屏时会设置 `role="dialog"`/`aria-modal="true"`，它和它内部的节点不是浮层；检测范围限定为面板之外，或显式跳过该子树，否则全屏浏览器会被永久隐藏。
- 可使用 Chromium 的 `checkVisibility({checkVisibilityCSS:true})` 配合祖先状态与 getClientRects；不要仅凭 role/aria-expanded 或第一个匹配节点判断。
- MutationObserver 同时观察 childList 和 hidden、aria-hidden、style、class、role、aria-expanded、data-state。resize/transitionend/animationend 也刷新，回调 rAF 合并；初次订阅必须回传实际 false/true。
- 淡入淡出中仍占布局的浮层暂时计为打开，包括 opacity=0 的过渡首帧；直到隐藏/卸载后恢复 guest，避免覆盖动画。
- 无法可靠从 DOM 判断的浮层通过显式打开状态上报，与观察器结果取逻辑或；清理监听与 rAF，避免泄漏。

### 5.3 修正二：失焦保留页面

禁止 window.blur 调用 destroyAll。区分失焦、隐藏/最小化、真正销毁；恢复后重新布局，不无条件显示所有 guest、不抢回用户输入焦点。验证原 viewId、历史、登录态与未提交表单保持。

### 5.4 修正三：地址解析不会向 UI 抛异常

主进程只接受 directHttpUrl 的规范化结果；renderer 地址栏使用 resolveBrowserAddress。必须覆盖非法端口/IP/IPv6，而非只校验正则。

```ts
const SEARCH = 'https://www.bing.com/search?q=';
const SCHEME = /^[a-zA-Z][a-zA-Z\d+.-]*:/;
const LOCAL = /^(?:localhost|(?:\d{1,3}\.){3}\d{1,3}|\[[0-9a-f:]+\])(?::\d+)?(?:[/?#].*)?$/i;
const HOST = /^(?:[\w-]+\.)+[a-z]{2,}(?::\d+)?(?:[/?#].*)?$/i;

export function directHttpUrl(input: string): string | null {
  const text = input.trim();
  if (!text || text.length > 4096 || /[\x00-\x20\x7f]/.test(text)) return null;
  try {
    const url = new URL(text);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
    return url.href;
  } catch {
    return null;
  }
}

export function resolveBrowserAddress(input: string): string | null {
  const text = input.trim();
  if (!text || text.length > 4096 || /[\x00-\x1f\x7f]/.test(text)) return null;
  const direct = directHttpUrl(text);
  if (direct) return direct;
  if (LOCAL.test(text)) return directHttpUrl(`http://${text}`);
  if (HOST.test(text)) return directHttpUrl(`https://${text}`);
  if (SCHEME.test(text)) return null;
  try {
    return `${SEARCH}${encodeURIComponent(text)}`;
  } catch {
    return null;
  }
}
```

基础解析规则：example.com→https；localhost:5173、127.0.0.1:3000、[::1]:3000→http；搜索词走 Bing；file/data/javascript/mailto 和含用户名密码的 URL 拒绝。空输入不导航。暂不识别的特殊主机/国际化裸域名可输入完整 URL，不因此增加危险协议支持。

### 5.5 修正四：取消/被替换的导航不显示错误页

- `did-fail-load` 仅处理主框架并忽略 ERR_ABORTED(-3)。
- 不允许 `loadURL(...).catch(error => fail(...))` 无条件写状态，否则旧 Promise 仍会覆盖新页面。
- 推荐加载失败由 did-fail-load 单一来源更新；loadURL rejection 只消费，不再改错误状态。无效参数/已关闭视图等命令错误通过 BrowserReply 返回。
- 所有导航入口遵循同一处理；若实现使用异步结果更新状态，须有每视图导航版本令牌，丢弃已替换/已销毁请求结果。
- 测试慢页面 A 加载中停止、A 被 B 替换、A 取消结果延迟到 B 成功之后：B 仍可见且没有错误页。

### 5.6 修正五：只同步主框架地址与历史

- `did-navigate-in-page(event,url,isMainFrame)` 必须检查 isMainFrame；iframe 的 hash/History API 变化不能覆盖地址栏。
- 主框架 did-navigate、did-navigate-in-page 均同步 URL、canGoBack、canGoForward；不能只在 did-stop-loading 更新历史。
- did-start/stop-loading 更新加载状态；page-title-updated 更新纯文本标题；render-process-gone 标记崩溃。
- 测试主页面带 iframe、SPA pushState/hash/后退/前进，无完整加载事件时按钮也正确。

### 5.7 修正六：POST 弹窗不降级为 GET

setWindowOpenHandler 始终 deny 原生新窗口：无 postBody 且 URL 是合法 http/https 时向 renderer 发 open；含 postBody 时发 popup-blocked，不发 open、不创建新标签。

BrowserEvent 至少包含：state、open、popup-blocked、layout-request、download-blocked。popup-blocked/download-blocked 带来源 viewId，提示按来源标签保存；不把非页面错误覆盖成页面加载错误。

提示文案：“暂不支持向新标签页提交表单，请在当前页重新操作，或在系统浏览器中重试。”英文成对提供。外部重试是用户主动从入口重新操作，不重放 POST，不声称保持登录态或 opener。

## 6. 安全、存储与兼容要求

- Host 窗口原有 CSP、will-navigate、window.open 拒绝规则不变；浏览器 guest 的跨站访问仅发生在独立视图。
- 浏览器 IPC 校验可信 sender 主 frame、viewId 归属、URL、bounds 有限数值、visible 布尔值及 8 标签上限；页面不能调用任何桥接 API。
- guest 分区同时拒绝权限请求、权限检查、设备权限及 USB/串口/HID/蓝牙选择；不绕过证书错误，不自动执行下载。
- 主框架导航及重定向持续执行 http/https、无凭据规则；代码驱动的 loadURL 也要独立校验，不能只依赖 will-navigate。
- 页面标题、错误、工作区名称、路径按文本渲染；上传本地文件只通过用户主动选择，不能暴露工作区读取接口给网页。
- 浏览器和项目注册表属于桌面层；既有会话数据库、快照、隔离子代理工作区及 CLI 协议身份不被注册表重命名/移除所改变。
- 保留现有工作区 hook 信任、权限预设、沙箱与文件路径包含性校验。工作区命令使用捕获的目标根目录，防止 A 的相对文件路径在 B 中被解析。
- 页面内容不自动共享给模型；README 和起始页帮助文案说明浏览器与 browser_* 工具独立。
- 浏览器 cookie/localStorage 持久化在独立分区；本轮不新增浏览数据清理 UI，README 说明存储位置和保留行为。

## 7. 文件清单与文案

执行时按当前代码合理拆分，但不要遗漏这些边界：

| 文件/模块                                                                | 改动                                                     |
| ------------------------------------------------------------------------ | -------------------------------------------------------- |
| ui/settings/ModelPicker.tsx、ui/styles.css                               | R1 测量/间距/主题/响应式；删除 session-short 样式        |
| ui/layout/ProductShell.tsx、ui/chrome.ts、ui/application.tsx             | R2/R3 投影、左侧项目结构、多工作区渲染与事件路由         |
| ui/sessions/*                                                            | 每工作区列表、会话动作目标、名称回退、独立菜单/分页/搜索 |
| ui/workspace/WorkspacePanel.tsx、workspace-model.ts、workspace-mount.tsx | 新建页、混合标签、文件缓存与工作区失效规则               |
| ui/workspace/FilePreview.tsx、markdown.ts、新共享高亮模块                | 安全语法高亮与原预览回归                                 |
| 新 ui/projects/* 与 ui/browser/*                                         | 工作区行、菜单/对话框、新建页、浏览器工具栏与浮层同步    |
| 新 project-workspaces-contract/store、main-project-workspaces            | 注册表、迁移、路径去重与可用性、工作区管理               |
| 新 workspace-host-manager、main.ts、main-context.ts、相关 main-*         | 多 Host 生命周期、设置/审批/通知/退出路由                |
| 新 browser-contract.ts、browser-views.ts、browser-url.ts                 | 浏览器管理、校验、地址与事件                             |
| contract.ts、preload.ts                                                  | 显式工作区业务通道、注册表管理和浏览器通道               |
| install-paths.ts、main-context.ts                                        | 默认工作区与启动优先级；注册表兼容旧工作区               |
| i18n-*.ts、主进程 mainText 字典                                          | 全部新中英文案，无组件硬编码中文                         |
| tests、package.json、README.md                                           | 有意义的测试、smoke 入口、能力与限制说明                 |

表中所有路径均相对于仓库根。新增样式使用类，不新增 ID 选择器和 !important；可以保留/新增 DOM ID 作为测试定位。

至少登记这些中英键或等价的项目命名：

- ui.untitledSession、projects.title/add/empty/collapse/expand。
- projects.rename/remove/removeHint/newSession/unavailable/retry/readOnlyDirectory。
- workspace.newTab、workspace.filesTab/filesTabHint、workspace.browserTab/browserTabHint、workspace.currentProject。
- browser.addressLabel/addressPlaceholder/back/forward/reload/stop/openExternal/untitled/startHint。
- browser.errorTitle/errorCode/retry/crashed/reopen/unsafeAddress/tabLimit。
- browser.postPopupUnsupported、browser.downloadUnsupported。

“新建标签页”选择页和“浏览器新标签页”起始页是两个状态；不要用同一布尔值或相同错误处理混为一体。

## 8. 实施顺序与完成标准

以下阶段按依赖顺序执行；每阶段完成后记录实际改动与验证结果。Phase 1/2 可先交付，右侧与多工作区最终需一起回归。

| 阶段 | 具体任务                                                                                                                                                       | 完成标准                                                            | 估算       |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- | ---------- |
| 0    | 记录基线；验证 WebContentsView 的布局、层叠、焦点、DPI、关闭与 guest 测试驱动方式；确认默认工作区不落在安装目录（upgrade overlap 预检）；梳理全局 service 依赖 | 生成 fixture 与 spike 记录，确认 API 与测试钩子；发现阻塞时给出证据 | 1–1.5 人日 |
| 1    | R2/R3：会话 ID、标题回退、i18n                                                                                                                                 | 页面无可见短 ID；标题/tooltip/弹窗一致；相关测试通过                | 0.5 人日   |
| 2    | R1/R6：模型宽度、共享高亮、主题与注入回退                                                                                                                      | 间距和窄窗正确；源码颜色和复制正确，其他预览无回归                  | 1–1.5 人日 |
| 3    | R4/R7：显式标签模型、新建页、顶部入口和混合标签生命周期                                                                                                        | 顶部与 + 均到选择页；文件读请求不会跨工作区污染                     | 2–2.5 人日 |
| 4    | R5：浏览器管理、IPC、地址/历史/错误/崩溃/浮层/窗口恢复、六项修正                                                                                               | 浏览器全流程及本地安全 fixture 通过，无残留视图                     | 4–5 人日   |
| 5    | R8 基础：注册表、默认目录首次初始化、旧用户迁移、新增/重命名/移除                                                                                              | 数据不搬移；路径去重；受限目录和空列表可恢复                        | 2–3 人日   |
| 6    | R8 隔离：多 Host、所有事件/命令作用域、后台任务/审批/设置/退出                                                                                                 | A 运行时可使用 B；无跨工作区消息或文件混入                          | 4–6 人日   |
| 7    | R8 UI：项目分组、独立会话列表、悬停按钮、两级折叠与持久化                                                                                                      | 产品行为与键盘交互通过，移除不删磁盘文件                            | 1–2 人日   |
| 8    | 完整回归、打包/安装路径场景、README 和交付记录                                                                                                                 | §9、§10 完成；记录通过与未覆盖项                                    | 2–3 人日   |

总量粗估 17.5–25 人日，不含评审和外部环境等待；不是对原稿 8.5–9.5 人日的沿用。多 Host 与作用域迁移是新增主要工作量，guest 测试驱动与升级/卸载兼容性也计入 Phase 0/8。不要先合入点击无反应的浏览器入口或会把 A 任务停掉的“多工作区”假实现。

WebContentsView 技术验证失败时先定位并修复；不要未经证据就启用 webviewTag、放宽 CSP 或换成打开外部浏览器来代替 R5。遇到实质性平台阻塞时报告具体复现与可评估替代方案，其余阶段继续完成。

## 9. 测试与验证

### 9.1 定向测试

- 地址解析：域名、端口、路径/查询、localhost、IPv4/IPv6、搜索、空输入、凭据、控制字符、非法协议；example.com:99999、999.999.999.999、[::::] 返回 null，不能抛异常。
- 标签状态机：固定项不进入 tabOrder、文件去重、混合顺序、相邻关闭、顶部重开到 new、跨工作区旧读结果失效、浏览器保留。
- 高亮：语言映射、未知类型回退、64KiB 降级、复制文字一致、恶意 HTML 原样显示而不执行。
- 注册表：初始/空列表/旧用户迁移、原子写失败不丢记录、未来 schema 不覆盖、路径别名去重、重命名不改路径、移除/重新添加不删历史。
- 迁移与升级：默认工作区不在安装目录；`prepareUpgrade` 的 app/data overlap 预检仍通过；旧默认 `<userData>/workspace` 被发现并注册。
- 标题回退：侧栏、聊天标题、tooltip、重命名/删除弹窗、归档列表均显示“新增会话”，不显示 8 位 ID。
- 全屏浏览器：面板全屏时 guest 仍可见（浮层检测排除面板自身）。
- 路由：不同 workspaceId 的同 sessionId 分开；快速切换丢弃旧选择响应；Host epoch 变化后旧 delta 无效；菜单目标不会随当前工作区变化。
- 生命周期：后台 Host 不因切换停止；有任务/队列/审批时不移除；启动目标失败保留原选中项；退出覆盖所有 Host。
- 保留现有会话、模型、权限、沙箱、文件读取与 workspace maintenance 测试，不因新增项目列表删掉保护断言。

不要为单纯宽度常量增加只重复公式的测试；优先验证实际 UI 间距和布局。

### 9.2 Electron smoke

新增或合并 desktop-browser、desktop-projects、workspace-preview 的本地 fixture；将新 smoke 纳入 package.json 的 smoke:desktop，不能只生成文件而从不运行。Phase 0 已验证 Playwright 1.63 的 `app.windows()`/`context().pages()` 会暴露 WebContentsView guest 页面，可直接用 locator/title/click 驱动；视图计数、bounds、可见性与 sandbox 标志通过主进程 `app.evaluate` 读取。保留仅测试环境启用的主进程探针作为兜底，不把 Playwright 的内部行为当作唯一契约。

1. 在独立临时 workspace/userData 启动，用本地 HTTP fixture 测试标题、链接、POST 弹窗、iframe、SPA、慢页面和错误页面；不依赖公网/真实账号。
2. 顶部打开面板默认新建页，只有两个入口，没有提前创建 guest；+ 返回同一选择页，文件入口不复制文件树。
3. 打开短/长名称模型检查实际文字到箭头间距，1220px/820px 窗口发送按钮可见；会话 ID 移除、新增会话文案和归档列表回退正确。
4. 打开 TS/JSON/Python/未知类型源码，检查 token 颜色、原始文本复制、暗色与亮色主题、截断提示、HTML 不执行；回归 Markdown/图片/Office/diff。
5. 浏览器导航/前进/后退/刷新/停止、错误重试、崩溃重建；主进程 URL/title/视图数与 UI 一致，bounds 误差不超过 2 DIP（高 DPI 另做手工验证）。
6. 常驻隐藏的 command/permission/session 菜单不会隐藏网页；可见菜单/Modal 打开时 guest 隐藏，关闭/动画结束后恢复；从设置页或新建页不错误恢复；面板全屏时浏览器 guest 仍可见。
7. iframe 改 hash 不影响主地址栏；主页面 pushState/hash 后历史按钮立即更新；取消 A 或切到 B 后 A 的旧失败不显示为错误页。
8. GET 弹窗新开一个标签；POST target=_blank 不发 GET、不增加 guest，来源标签有提示；超过 8 标签不继续创建。
9. 页面内 typeof require/process/window.yuantu 均为 undefined；非法导航 IPC 被拒绝；权限默认拒绝、未支持下载被取消。
10. 失焦/隐藏/最小化再恢复，原 viewId、历史、输入表单仍在；关闭标签/实际销毁窗口后 guest 数下降且无残留进程。
11. 加入 A/B 两个工作区、同一路径别名不重复；两个工作区都能独立新建、命名、搜索、分页和选择会话。
12. A 任务运行中切 B 并发起会话，A 继续；流式内容、审批、统计与完成通知只归属原工作区。使用确定性的测试 provider/fixture，不依赖真实模型。
13. B 的悬停/键盘聚焦显示操作；菜单重命名只改名称；移除空闲工作区后目录与会话库仍在，重新添加历史恢复；运行中移除被阻止。
14. 折叠项目整体及单个工作区后重启，折叠状态与所选项恢复；最后一项移除后重启不自动重新添加默认项。
15. 独立验证默认 `<userData>/workspace`、显式启动参数、旧用户发现、默认目录只读、路径含空格/中文、失效目录；使用测试路径注入，不能拿真实安装目录或用户数据目录做破坏性测试。

### 9.3 手工验证与仓库门禁

- Windows 100%/125%/150% DPI、最大化/还原、高 DPI 副屏、最窄面板、全屏/退出、键盘/触摸操作。
- 安装版验证默认项是 `<userData>/workspace` 且不在安装目录内；真实标准用户不可写时能选择目录恢复使用；不需要把整个应用以管理员启动。
- 若交付 macOS，同步验证 .app 路径、窗口隐藏/重新打开与 Cmd+Q 退出；无法验证的平台明确记录。
- 运行变更相关的单测、build 和定向 Electron smoke；最后按仓库脚本完成 npm run check 及 npm run smoke:desktop。门禁至少涵盖 format/docs/references/cycles/layers/i18n/typecheck/lint/test/build 和现有 smoke:client，不把其中几项通过描述成全部通过。
- 修改 smoke:desktop 套件清单后先运行 npm run docs:generate 更新 README 的生成事实，再运行 npm run check；docs:check 会校验套件数量。
- 本地可用时执行 npm run check:changed 辅助选定向检查；它不能替代最终约定门禁。
- 保存真实命令、结果、关键截图与剩余限制到新的 validation 文档；不伪造运行记录，不对未运行的安装/跨平台场景勾选通过。

## 10. 最终交付清单

- [ ] R1–R8 产品行为全部完成，尤其顶部默认选择页及两级折叠。
- [ ] 六项评审问题全部有实现处理与对应回归覆盖。
- [ ] 原文档、本文、README 与实际功能无冲突；若实现调整，更新本文对应决策。
- [ ] 多工作区会话/文件/审批/事件完全按目标隔离，切换不会停止后台任务。
- [ ] 注册表初始化/迁移可重复执行，移除工作区不删除目录与数据库。
- [ ] 默认工作区不在安装目录内；内置升级/回滚对 app/data 目录重叠的保护仍通过。
- [ ] 右侧所有预览保持原有读取边界，源码高亮不会执行内容或覆盖主题颜色。
- [ ] guest 无桥接/Node、CSP 未放宽、权限默认拒绝、生命周期无泄漏。
- [ ] 新文案中英齐全；无新增 ID 样式选择器和 !important。
- [ ] 相关单测、完整门禁、Electron smoke 与可交付平台手工记录齐全。
- [ ] 最终说明列出实际改动、验证结果及材料中的剩余限制；不把文档设计当作代码完成。

## 11. 交给执行 agent 的指令

请直接根据本文实现，不需要用户再次解释截图或确认已固定的产品选项。先检查工作区已有未提交变更并保留用户文件，按阶段推进，完成相关回归后继续后续阶段。

遇到默认目录不可写、缺失目录、任务运行中移除等情况，按本文定义的产品行为处理；不要为这些预期状态中止全部开发。仅对实际无法由代码/仓库证据解决的阻塞报告具体原因与影响，继续完成不受阻塞的工作。

本轮目标是完整实现和验证；仅新增组件占位、只改静态侧栏、只提交本方案，均不算实现完成。是否提交/推送/发布遵循执行会话的用户授权，不从本文推导额外外部操作权限。本轮执行会话已授权在当前 main 分支分阶段提交；不推送、不发布。
