# 源图AI 桌面端：模型选择器、会话标识与右侧文件/浏览器标签页改造方案

> 状态：待评审（Draft）  
> 日期：2026-10-27  
> 代码基线：`b58a8cc`（`main`）  
> 需求来源：本轮 4 张截图与文字说明（R1–R5）  
> 文档性质：需求定义 + 技术设计 + 验收/测试计划；**本文不包含代码实现**  
> 阅读指引：5 分钟看 §0、§3、§10；技术评审看 §4、§5；测试/排期看 §7、§8。  
> 第二轮评审修正：6 条意见均已核对并修正，见 §11。

<!-- references:planned -->

## 0. 摘要

本轮有 5 个需求，按依赖关系可以分成两组：

| 组         | 需求                                                                 | 结论                                                                         | 规模  |
| ---------- | -------------------------------------------------------------------- | ---------------------------------------------------------------------------- | ----- |
| 输入区细节 | R1 模型选择器宽度、R2 删除输入框右上会话 ID、R3 新会话在列表中的名称 | 局部改动，互不依赖，可先行合入                                               | S     |
| 右侧面板   | R4 `文件` 标签后的 `+` 与新建标签菜单、R5 内置浏览器                 | 需要把右侧面板从“文件面板”升级为“多类型标签页”，并在主进程新增浏览器视图管理 | M / L |

核心结论：

1. **R1** 不再按“最长模型名”定宽，改为按**当前选中模型名**定宽；箭头与文字之间保持约 8–14px 的间距。当前代码按最长选项定宽，是截图中短模型名与箭头距离过大的直接原因。
2. **R2** 删除 `ProductShell` 输入区上方的 `#session-short`，同时删掉 `chrome.sessionShort` 的投影与样式。会话 ID 仍在内部状态与 `data-session-id` 中，不影响功能与测试定位。
3. **R3** 未命名会话在列表、聊天标题、重命名弹窗中统一显示 `新增会话`，不再显示 `会话 {8 位 ID}`；首条用户消息写入后，标题会自然变成消息摘要。
4. **R4** 在 `文件` 标签后新增 `+`，菜单**只包含两个选项**：`工作区文件`、`浏览器`。不包含截图 4 中的 `新建终端`（按本轮文字“默认内容是工作区文件和浏览器两个选项”处理；终端保留为后续扩展）。
5. **R5** 内置浏览器采用 Electron **`WebContentsView`**，由主进程创建并管理，不启用 `<webview>` 标签，也不放宽 Host 页面的 CSP/导航限制。浏览器是**用户手动使用**的面板，和 Agent 的 `browser_*` Playwright 工具是两套东西，页面内容不会自动进入对话。

## 1. 需求清单与截图对应

| 编号 | 用户原文                                                                   | 本文解释                                                                                                     | 优先级 | 预估      |
| ---- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | ------ | --------- |
| R1   | “模型需要靠着右边箭头，现在太远了，可以根据模型长度来自适应选择框的宽度。” | 模型选择器（`#model`）的宽度按当前模型名自适应，箭头紧贴文字右侧；下拉菜单本身仍可用更宽的浮层展示完整模型名 | P0     | 0.5 人日  |
| R2   | “删除输入框右上的会话id。”                                                 | 删除输入框上方 `准备就绪` 行右侧的 `会话 bd6b71a4`；不删除内部会话 ID                                        | P0     | 0.25 人日 |
| R3   | “新建会话时，会话列表中展示的是会话id，改成新增会话。”                     | 没有标题的会话在侧栏/标题/重命名弹窗中显示 `新增会话`，不显示 8 位 ID                                        | P0     | 0.25 人日 |
| R4   | “右侧文件后面有个+号，可以新增tab，默认内容是工作区文件和浏览器两个选项。” | 在右侧标签栏的 `文件` 后加 `+`；点击弹出菜单，仅两项：`工作区文件`、`浏览器`；选择后激活/新建对应标签        | P0     | 1.5 人日  |
| R5   | “浏览器功能帮我添加。”                                                     | 右侧面板新增可交互的内置浏览器标签页：地址栏、前进/后退/刷新、页面标题、错误页、多标签、独立会话分区         | P0     | 4–6 人日  |

截图对应：

- 图 1：`GPT-6-Astra` 文字与右侧箭头之间空隙过大（R1）；右上角 `会话 bd6b71a4`（R2）。
- 图 2：新建会话行显示 `会话 15e64179`（R3）；输入框上方同样显示会话 ID（R2）。
- 图 3：右侧 `文件` 标签后的红框是希望放置 `+` 的位置（R4）。
- 图 4：目标交互的参考菜单，含 `工作区文件` / `新建终端` / `浏览器`；本轮按用户文字只做前两项（R4/R5）。

## 2. 现状与证据

### 2.1 界面结构

桌面端是 React 19 + Mantine 9 + Electron 的单窗口应用：

- 外壳：`apps/desktop/ui/layout/ProductShell.tsx` 使用 Mantine `AppShell`，左 `Navbar`、中 `Main`、右 `Aside`。
- 右侧面板：`ProductShell` 的 `aside` 里只挂了 `PanelSlot name="sidebar.right"`，实际内容来自 `apps/desktop/ui/workspace/WorkspacePanel.tsx`。
- 右侧面板状态：`apps/desktop/ui/workspace/workspace-model.ts` 的 `WorkspaceState`，目前只有 `selected: string | null`（`null` 表示文件树）和 `tabs: Map<path, WorkspaceTab>`。
- 模型选择器：`apps/desktop/ui/settings/ModelPicker.tsx`，通过隐藏的 `model-width-probe` 测量标签宽度。
- 会话侧栏：`apps/desktop/ui/sessions/SessionSidebar.tsx` / `SessionRow.tsx` / `session-model.ts`。
- 主进程/预加载：`apps/desktop/main.ts`、`apps/desktop/preload.ts`、`apps/desktop/contract.ts`。
- 安全基线：窗口 `sandbox: true`、`contextIsolation: true`、`nodeIntegration: false`、`webSecurity: true`；Host 页面拒绝 `window.open` 与 `will-navigate`；所有权限请求默认拒绝；CSP 见 `apps/desktop/index.html`，其中 `connect-src 'none'`、`frame-src blob:`。

### 2.2 R1：当前宽度是“最长选项”而不是“当前模型”

`apps/desktop/ui/settings/ModelPicker.tsx:32-41`：

```tsx
const labels = options.length ? options.map((option) => option.label) : [t('settings.noModel')];
const labelsKey = labels.join('\n');
const probe = useRef<HTMLSpanElement>(null);
const [fieldWidth, setFieldWidth] = useState(150);
useLayoutEffect(() => {
  const node = probe.current;
  if (!node) return;
  let widest = 0;
  for (const child of node.children) widest = Math.max(widest, child.getBoundingClientRect().width);
  const next = Math.min(360, Math.max(150, Math.ceil(widest) + 50));
  setFieldWidth((current) => (current === next ? current : next));
}, [labelsKey]);
```

样式侧还有一条硬下限：`apps/desktop/ui/styles.css:2381-2385` 的 `.chat-page .chat-model .model-picker-frame { min-width: 150px; }`。

因此，当保存了 `DeepSeek-V4.1-Flash-1017` 这类长模型名，而当前选中的是 `GPT-6-Astra` 时，选择框仍按最长项保持 150px 以上宽度，文字靠左、箭头靠右，产生截图 1 中的大空隙。

### 2.3 R2：会话 ID 的渲染点

`apps/desktop/ui/layout/ProductShell.tsx:375-383`：

```tsx
<footer className="composer-area">
  <div className="run-status">
    <span id="run-status" role="status">
      {status.runStatus || t('shell.connecting')}
    </span>
    <span id="session-short" className="session-short">
      {status.sessionShort}
    </span>
  </div>
```

`chrome.sessionShort` 在 `apps/desktop/ui/chrome.ts:26` 初始化，在 `apps/desktop/ui/application.tsx:617-622` 每次快照投影时写入：

```tsx
updateChrome({
  sessionShort: session.sessionId
    ? t('ui.sessionShort', { id: session.sessionId.slice(0, 8) })
    : '',
  welcomeVisible: !Boolean(session.messages.length || session.running),
});
```

样式在 `apps/desktop/ui/styles.css:1067-1070` 与 `:4137-4140`。

### 2.4 R3：未命名会话的回退标题

`apps/desktop/ui/sessions/session-model.ts:99-102`：

```ts
export function sessionTitle(item: Pick<SessionInfo, 'id' | 'title'>): string {
  return item.title || t('ui.sessionShort', { id: item.id.slice(0, 8) });
}
```

同一个回退还出现在：

- 聊天标题：`apps/desktop/ui/application.tsx:549-551`，当前使用 `t('ui.newSession')`（`新建会话`），与列表不一致。
- 重命名/删除弹窗：`apps/desktop/ui/sessions/session-model.ts:225-234`。
- 行按钮的无障碍标签：`SessionRow.tsx:102`。

`ui.sessionShort` 的文案在 `apps/desktop/i18n-conversation.ts:657`：`会话 {id}` / `Session {id}`。

存储层会在第一条**人类**用户消息写入时把空标题设为该消息的摘要（`packages/storage/session-blobs.ts:85-100`），模型随后可能生成更短的标题（`session.title.updated` 事件）。所以“没有标题”只应出现在**新会话尚未发消息**（以及极少数只有机器上下文消息）的情况。

### 2.5 R4：右侧面板目前没有 `+`，也没有浏览器

`WorkspacePanel.tsx:300-366` 的头部结构是：

```tsx
<header className="workspace-panel-header">
  <div id="workspace-tabs" role="tablist">
    <button id="workspace-tree-tab">文件</button>
    {fileTabs...}
  </div>
  <div className="workspace-panel-actions">
    <button id="workspace-fullscreen" />
    <button id="workspace-refresh" />
    <button id="workspace-close" />
  </div>
</header>
```

`workspace-model.ts:39-48` 仅有：

```ts
export interface WorkspaceState {
  workspace: string;
  open: boolean;
  fullscreen: boolean;
  selected: string | null;
  expanded: ReadonlySet<string>;
  listings: ReadonlyMap<string, WorkspaceListing>;
  failures: ReadonlyMap<string, string>;
  tabs: ReadonlyMap<string, WorkspaceTab>;
}
```

因此：

- `+` 按钮、菜单、浏览器标签都不存在；
- `selected === null` 同时表示“文件树”与“没有文件选中”，无法表达“浏览器标签激活”；
- 切换工作区时 `setWorkspace()` 会清空全部标签（`workspace-model.ts:185-200`），这对文件是合理的，但对浏览器需要重新定义。

### 2.6 R5：现有“浏览器”是 Agent 工具，不是面板浏览器

仓库里已有：

- `browser_open` / `browser_close` / `browser_screenshot` 等 Playwright 工具（`packages/tools/browser.ts` 等），由模型调用、受权限控制；
- 主进程只允许通过系统浏览器打开 `http/https` 外链（`main.ts:886-889`，且 `packages/carrier/contract.ts:531-540` 校验无凭据）。

没有嵌入式的网页视图。因此 R5 是**新增**一个用户可见的浏览器，不是把 `browser_*` 工具“显形”。两者边界必须在文档和 UI 文案中说清楚。

## 3. 需求详述

### 3.1 R1：模型选择器贴合当前模型

#### 目标

- 选择框宽度由**当前选中项**的文字宽度决定，而不是所有选项的最大宽度。
- 模型文字右侧到下拉箭头的距离保持在 `8–14px`（视觉上“挨着”）；箭头仍在下拉框右缘。
- 下拉菜单仍可展示完整模型名；长模型名在触发器中最多 360px，超出省略，`title` 提供完整值。
- 切换模型时宽度平滑变化；减少动态偏好（`prefers-reduced-motion`）下不播放动画。

#### 规则

- 宽度公式：`clamp(ceil(selectedLabelWidth) + 40, 72, 360)`。
  - `selectedLabelWidth` 用隐藏探针按当前字体测量；
  - `+40` 包含左内边距 8px、右内边距 28px、以及 2px 边框余量；
  - 箭头区宽度设为 24px（Mantine `rightSectionWidth`），箭头图形 13px；
  - 视觉验证标准：文字末端到箭头左缘 8–14px，而不是固定 50px。
- 下拉菜单：`comboboxProps={{ width: 'max-content', position: 'bottom-end' }}` 保持不变，菜单宽度不跟随触发器缩小。
- 无模型时显示 `未配置模型`，宽度按该文案计算。
- 环境变量提供的模型标签（如“环境模型：xxx”）同样按当前标签测量，过长则省略。
- 选择器被锁定/禁用时宽度仍按当前项计算。

#### 边界

- 切换模型后，整个 composer 行允许发生一次宽度变化；`chat-model` 仍是 `margin-left: auto`，发送按钮位置不变。
- 字体加载完成后重新测量一次（系统字体通常无问题；仍建议在 `document.fonts.ready` 后补一次测量，避免首帧偏差）。
- 语言切换（中/英）重新测量。
- 选择器的可点击区域不应小于 72px；高度不变。

#### 验收

- [ ] 保存两个连接：`GPT-6-Astra` 与 `DeepSeek-V4.1-Flash-1017`；选中短名称时，选择框宽度 ≤ 短名称宽度 + 48px，文字到箭头 ≤ 14px。
- [ ] 切换到长名称时，宽度增大但不超出 360px；文字不换行，超长时省略并可通过 `title` 查看完整值。
- [ ] 下拉菜单中所有模型名完整可读，选择后仍能正常切换模型。
- [ ] 窗口缩到最小宽度 820px 时，composer 不横向溢出，发送按钮仍可见。

### 3.2 R2：删除输入框右上的会话 ID

#### 目标

- 删除 `run-status` 行右侧的 `会话 xxxxxxxx`。
- 输入框上方只保留运行状态文本（`准备就绪` / `正在…` / 错误状态等），左对齐。
- 会话 ID 仍保留在 `CarrierSnapshot`、`data-session-id`、日志和测试定位中；只是不再展示。

#### 非目标

- 不改变会话列表/标题中的 ID 回退（由 R3 处理）。
- 不改变通知、导出、URL 或内部命令。
- 不把 ID 移到别处展示。

#### 验收

- [ ] `.composer-area` 内不存在 `#session-short`，也不存在匹配 `/会话 [0-9a-f]{8}/` 的可见文本。
- [ ] `准备就绪` 仍在原位置；输入框、统计行、队列提示布局不变。
- [ ] 所有会话（新建、已命名、运行中）都不显示该 ID。
- [ ] 语言切换后不出现空白占位或孤立分隔符。

### 3.3 R3：未命名会话显示 `新增会话`

#### 目标

- 侧栏行：`item.title` 为空时显示 `新增会话`，不显示 `会话 {8 位 ID}`。
- 聊天页标题：同样显示 `新增会话`（当前是 `新建会话`，与侧栏不一致）。
- 重命名/删除弹窗的默认标题：`新增会话`。
- 行 tooltip：`新增会话` + 运行/等待状态，不显示 ID。
- 英文界面：`New session`。
- 首条用户消息发送后：行/标题显示该消息生成的摘要；模型生成短标题后显示生成标题；手动重命名后显示手动标题。

#### 关键区分

- `ui.newSession`（按钮 `新建会话`）保持不动；新增独立的 `ui.untitledSession`（`新增会话`）。
- `ui.sessionShort` 在本轮后不再有展示用途，删除该键；`tests/ui-copy-migration.test.ts` 的断言改为新键。
- `data-session-id` 保留；行的菜单按钮 `aria-label` 可以保留短 ID 用于读屏区分（不可见），但不再渲染 ID 文本。

#### 边界

- 多个新建会话同时存在时，都显示 `新增会话`，右侧相对时间（`1分钟` 等）用于区分；这是可接受的。
- 只有机器上下文（runtime context / compact summary）作为首条消息的会话可能暂时没有标题；显示 `新增会话` 比显示 ID 更符合“没有人类标题”的语义。
- 搜索：无标题会话按 `新增会话` 展示；搜索匹配仍由后端标题/消息决定，不额外改搜索逻辑。

#### 验收

- [ ] 点击 `新建会话` 后，侧栏首行显示 `新增会话`，聊天标题显示 `新增会话`。
- [ ] 页面中不出现 `会话 15e64179` 这类 8 位十六进制 ID。
- [ ] 发送第一条消息后，行/标题更新为消息摘要（测试环境关闭模型标题生成时也一样）。
- [ ] 重命名弹窗默认值为 `新增会话`；重命名后显示新名称。
- [ ] 英文界面显示 `New session`，语言扫描通过。

### 3.4 R4：右侧 `+` 与新建标签菜单

#### 目标交互

1. 右侧面板标签栏在 `文件` 标签之后显示一个 `+` 按钮（28×28，圆形/圆角，hover 有背景）。
2. 点击 `+` 打开菜单，菜单仅有：
   - `工作区文件`（folder 图标，副标题“浏览项目中的文件”）
   - `浏览器`（globe 图标，副标题“在面板中打开网页”）
3. `工作区文件`：
   - 激活固定的 `文件` 标签（文件树）；
   - 如果已经在文件树，不产生重复标签；
   - 确保面板打开并加载根目录。
4. `浏览器`：
   - 新建一个浏览器标签并激活；
   - 显示起始页，地址栏获得焦点；
   - 可重复创建多个浏览器标签。
5. 标签栏顺序：
   - 固定的 `文件` 标签永远第一，不可关闭；
   - 之后按打开顺序排列文件标签与浏览器标签；
   - 新标签追加到末尾；
   - 已存在的文件标签再次打开时只激活，不改变位置、不重复创建。
6. 关闭标签：
   - 文件/浏览器标签有 `×`；
   - 关闭当前标签后，优先激活右侧相邻标签，否则左侧相邻标签，否则回到 `文件` 树；
   - 关闭非当前标签不改变当前激活项。
7. 溢出与响应式：
   - 标签多时标签条横向滚动，`+` 与右侧动作按钮保持可见；
   - 面板宽度小于约 300px 时，标签文字省略更积极，动作按钮仍可用。
8. 键盘与无障碍：
   - `+` 可 Tab 聚焦，Enter/Space 打开菜单；
   - 菜单支持方向键、Esc 关闭并把焦点还给 `+`；
   - 标签条 `role="tablist"`，左右箭头在标签间移动，Home/End 到首/尾；
   - `Delete` 关闭当前可关闭标签（P1）。

> 语义说明：本轮把“默认内容是工作区文件和浏览器两个选项”理解为**点击 `+` 打开的菜单只有这两项**；如果你指的是“面板初始就同时打开工作区文件 + 浏览器两个标签”，则还需要定义初始激活项、浏览器起始页是否立即创建、以及是否每个工作区都预置，请评审时确认（本文先按菜单语义实现）。

#### 明确不做

- 不做 `新建终端`（截图 4 中的第三项）；终端是后续独立需求。
- 不做标签拖拽排序、固定（pin）、复制标签、右键菜单（可作为后续增强）。
- 不做跨重启的标签恢复；浏览器标签在本次运行内保留。

#### 验收

- [ ] `+` 位于 `文件` 标签右侧、动作按钮左侧；只有 1 个标签时紧挨 `文件`。
- [ ] 点击 `+` 只看到 `工作区文件`、`浏览器` 两项，没有 `新建终端`。
- [ ] 连续点击 `浏览器` 生成多个标签，标签标题随页面标题更新。
- [ ] `工作区文件` 不产生第二个 `文件` 标签。
- [ ] 关闭当前标签后的激活项符合“右邻 → 左邻 → 文件树”。
- [ ] 切换工作区：文件标签关闭，浏览器标签保留（见 §4.4 决策）。
- [ ] 全屏、拖拽宽度、收起/展开面板后，标签与 `+` 仍可用。

### 3.5 R5：内置浏览器

#### 产品边界

- 浏览器是**用户手动操作**的面板，不是 Agent 的浏览器工具。
- 页面内容不会自动发送给模型；模型也不能读取该标签页。
- Agent 的 `browser_*` 工具保持现状：独立 Playwright 会话、独立权限、独立 profile。
- 浏览器不提供“把页面发给模型”的按钮（后续如需要，另立需求，走截图/可访问性树 + 权限设计）。

#### 功能要求

| 能力        | 要求                                                                                                                                                             |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 新建        | `+` → `浏览器`；起始页；地址栏自动聚焦                                                                                                                           |
| 地址栏      | 输入 URL 回车导航；支持省略 `https://`；非 URL 文本走搜索；Esc 还原当前 URL；非法协议不导航并提示                                                                |
| 前进/后退   | 按会话历史可用/禁用；导航后状态同步                                                                                                                              |
| 刷新/停止   | 加载中显示停止；否则刷新                                                                                                                                         |
| 加载状态    | 标签上显示 spinner；地址栏所在工具栏不阻塞                                                                                                                       |
| 页面标题    | 优先页面标题；无标题用主机名；再无则 `新标签页`；标签过长省略，tooltip 显示完整标题/URL                                                                          |
| 错误页      | 主框架加载失败显示错误码/描述/URL，提供重试与“用系统浏览器打开”                                                                                                  |
| 弹窗/新窗口 | 普通 GET 的 `target=_blank` / `window.open(http/https)` 在面板内新建标签；带 `postBody` 的 POST 弹窗打开受控真实子窗口（保留 method/body/opener）；非法 URL 拒绝 |
| 外部打开    | 工具栏提供“用系统浏览器打开”，复用现有 `openLink` 校验                                                                                                           |
| 多标签      | 每个浏览器标签独立历史；关闭销毁视图；上限 8 个                                                                                                                  |
| 会话隔离    | 使用 `persist:yuantu-browser` 分区；cookie/localStorage 跨标签、跨重启保留；不共享应用默认 session                                                               |
| 权限        | 摄像头/麦克风/定位/通知/剪贴板读等默认拒绝                                                                                                                       |
| 下载        | P1：保存对话框；未实现前按 Electron 默认行为并在验收中记录                                                                                                       |
| 右键菜单    | P1：后退/前进/刷新/复制/粘贴/全选/在系统浏览器打开链接                                                                                                           |
| 快捷键      | P1：Ctrl+Alt+T 新建浏览器标签；P2：Ctrl+L 聚焦地址栏、Alt+←/→                                                                                                    |
| 缩放        | P2；不实现 Ctrl+滚轮特殊逻辑，沿用页面默认                                                                                                                       |
| 持久化      | 标签页不跨重启；浏览数据（cookie 等）持久化                                                                                                                      |

> POST 表单弹窗是唯一例外：为了不把 POST 变成 GET、也不丢 opener，它打开为受控子窗口，而不是面板标签；普通 GET 链接仍在面板内开标签。

#### 地址解析规则

| 输入                     | 结果                                             |
| ------------------------ | ------------------------------------------------ |
| `example.com`            | `https://example.com/`                           |
| `example.com/a?b=1`      | `https://example.com/a?b=1`                      |
| `http://example.com`     | 原样（规范化后）                                 |
| `localhost:5173`         | `http://localhost:5173/`                         |
| `127.0.0.1:3000/api`     | `http://127.0.0.1:3000/api`                      |
| `hello world`            | `https://www.bing.com/search?q=hello%20world`    |
| `javascript:alert(1)`    | 拒绝，提示只允许 http/https                      |
| `file:///C:/...`         | 拒绝                                             |
| `data:text/html,...`     | 拒绝                                             |
| `mailto:a@b.com`         | 拒绝（不交给系统邮件客户端；外链仍走系统浏览器） |
| 空字符串                 | 不导航，保持焦点                                 |
| `https://user:pass@host` | 拒绝（与现有 `openLink` 的凭据规则一致）         |

搜索服务固定为 Bing（`https://www.bing.com/search?q=`）；如产品希望改用其他搜索源，只需替换常量，不影响其他逻辑。

#### 起始页

- 标题：`新建标签页`
- 说明：`在上方输入网址，或输入要搜索的内容`
- 图形：globe 图标（不使用远程 favicon，原因见 §4.10）
- 地址栏在工具栏上方，自动聚焦；不额外放第二个输入框。

#### 错误页

- 标题：`无法打开此页面`
- 第二行：Chromium 的 `errorDescription`（原样展示，外部数据按文本渲染）
- 第三行：失败的 URL
- 操作：`重试`、`用系统浏览器打开`
- 渲染进程崩溃：显示 `页面已停止运行`，提供“重新打开”（销毁并重建视图）。

#### 验收

- [ ] `+` → `浏览器` 后出现起始页，地址栏聚焦，标签标题 `新标签页`。
- [ ] 输入 `example.com` 回车，地址栏变为最终 URL，标签标题变为页面标题。
- [ ] 前进/后退/刷新/停止状态正确；加载中停止按钮可用。
- [ ] 主框架加载失败显示错误页；重试可恢复。
- [ ] 页面 `target=_blank` 链接在面板内新开标签；`javascript:`/`file:` 不会加载。
- [ ] 带 POST 的表单 `target=_blank` 打开受控子窗口，服务端收到的仍是 POST（不是 GET）；该窗口无 preload/Node，关闭标签时一并关闭。
- [ ] 关闭标签后主进程视图被销毁（`webContents` 数量下降），无内存泄漏。
- [ ] 浏览器页面内 `typeof require`、`typeof process`、`window.yuantu` 均为 `undefined`。
- [ ] App 的 Host 页面仍不能导航、不能 `window.open`，CSP 未被放宽。
- [ ] 面板宽度 180–360px 时工具栏不溢出；地址栏仍可输入。

## 4. 技术方案

### 4.1 选型：`WebContentsView`，不启用 `<webview>`

| 维度              | `WebContentsView`（推荐）                 | `<webview>` 标签                                                         |
| ----------------- | ----------------------------------------- | ------------------------------------------------------------------------ |
| Electron 官方态度 | 推荐                                      | 明确不推荐，且不保证未来可用                                             |
| 安全边界          | 主进程创建/销毁，渲染进程不能自行造 guest | 需要 `webviewTag: true`，扩大渲染进程能力                                |
| 与 Host CSP       | 不受 Host 页面 CSP 影响                   | 可能受 `frame-src` 限制，需要实测/可能放宽 CSP                           |
| 布局              | 主进程按 renderer 上报的矩形 `setBounds`  | DOM 内自动布局                                                           |
| 层叠              | 原生视图覆盖 HTML，需要在菜单/弹窗时隐藏  | DOM 内，但 Electron/Chromium 实现可能把 guest 提升到 HTML 之上，仍需实测 |
| 事件/历史         | 主进程直接持有 `webContents`，控制完整    | 通过元素方法与事件，能力略少                                             |
| 代码量            | 高（IPC、bounds、可见性）                 | 低                                                                       |

结论：**采用 `WebContentsView`**。理由：

1. 项目现有安全基线（Host 页面拒绝导航、CSP 严格、无 `webviewTag`）不应为浏览器功能整体放宽；`WebContentsView` 把“能创建 guest”的能力留在主进程。
2. 浏览器面板是一个矩形区域，布局稳定；bounds 同步只需要一个 `ResizeObserver` + `getBoundingClientRect`，成本可控。
3. 菜单/弹窗的层叠问题可以用“有 `role=menu/dialog/listbox` 的原生浮层时隐藏浏览器视图”解决；这比 `webview` 的 CSP/未来兼容风险更可控。
4. `WebContentsView` 的 `webContents` 可直接用于权限、弹窗、下载、右键菜单和测试探针。

如果排期必须压缩到 2–3 天，可退化为 `<webview>`，但需要：主进程 `will-attach-webview` 白名单、固定 `webviewTag`、CSP 实测、未来迁移计划。本文不建议把它作为主方案。

### 4.2 总体架构

```text
┌──────────────────────────── Renderer（React） ────────────────────────────┐
│ WorkspacePanel                                                           │
│  ├─ TabBar: 文件 | 文件标签… | 浏览器标签… | [+] | ⛶ ↻ »                 │
│  ├─ FileTree / FilePreview（现有）                                        │
│  └─ BrowserPane（仅当前浏览器标签）                                       │
│       ├─ BrowserToolbar（HTML：后退/前进/刷新/地址栏/外链）                │
│       └─ BrowserSurface（HTML 占位：起始页/错误页；尺寸来源）              │
│                                                                          │
│  workspace-model（tabOrder / active / fileTabs / browserTabs）            │
└───────────────────────────────┬──────────────────────────────────────────┘
                                │ IPC: yuantu:browser
                                │      yuantu:browser-event
┌───────────────────────────────▼──────────────────────────────────────────┐
│ Main（Electron）                                                          │
│  BrowserViews                                                             │
│   ├─ Map<viewId, WebContentsView>                                        │
│   ├─ create / destroy / layout / navigate / back / forward / reload / stop│
│   ├─ 独立 partition: persist:yuantu-browser                              │
│   ├─ 权限拒绝、弹窗拦截、下载/右键（P1）                                  │
│   └─ 状态事件：url/title/loading/canGoBack/canGoForward/error/crashed    │
└──────────────────────────────────────────────────────────────────────────┘
```

关键点：

- 渲染进程只发“创建/布局/导航”命令，不直接持有 `WebContentsView`。
- 主进程只暴露浏览器能力，不把 `webContents` 或 `ipcRenderer` 暴露给页面内容。
- 浏览器页面无 preload、无 Node、无 `window.yuantu`。

### 4.3 右侧面板数据模型

把 `selected: string | null` 替换为显式的 `active`，并把文件标签与浏览器标签分开存储：

```ts
// apps/desktop/ui/workspace/workspace-model.ts

export interface FileTab {
  path: string;
  shown: WorkspacePreview | null;
  error: string | null;
  reading: boolean;
  token: number;
  scrollTop: number;
  changeKey?: string;
  changePreview?: Element | null;
  documentUrl?: string;
}

export interface BrowserTab {
  /** Renderer 内稳定 ID，用于 React key 和 tabOrder。 */
  id: string;
  /** 主进程 WebContentsView 的 ID；创建成功前为 null。 */
  viewId: string | null;
  /** 当前提交的 URL；起始页为 ''。 */
  url: string;
  title: string;
  loading: boolean;
  /** false = 起始页；true = 已发起过至少一次导航。 */
  started: boolean;
  error: { code: number; description: string; url: string } | null;
  crashed: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
}

export type PanelTab =
  { kind: 'files' } | { kind: 'file'; path: string } | { kind: 'browser'; id: string };

export type ClosableTab = { kind: 'file'; path: string } | { kind: 'browser'; id: string };

export interface WorkspaceState {
  workspace: string;
  open: boolean;
  fullscreen: boolean;
  active: PanelTab;
  /** `文件` 标签固定在最前，不在此数组中；数组只保存可关闭标签的显示顺序。 */
  tabOrder: readonly ClosableTab[];
  expanded: ReadonlySet<string>;
  listings: ReadonlyMap<string, WorkspaceListing>;
  failures: ReadonlyMap<string, string>;
  fileTabs: ReadonlyMap<string, FileTab>;
  browserTabs: ReadonlyMap<string, BrowserTab>;
}
```

不变量：

1. `active.kind === 'file'` 时，`fileTabs` 必须存在该 `path`；`active.kind === 'browser'` 时，`browserTabs` 必须存在该 `id`。
2. `tabOrder` 中文件路径不重复、浏览器 ID 不重复。
3. 任何时刻只有一个 `active`。
4. `文件` 标签不进入 `tabOrder`，始终可回退。
5. `browserTabs` 的 `id` 单调递增，永不复用；`viewId` 由主进程分配，可变化（重建视图时）。
6. `tabOrder` 中只出现仍存在于 `fileTabs` / `browserTabs` 的项。

控制器新增方法（与现有 `setOpen/setFullscreen/showFile/closeTab/...` 并列）：

```ts
export interface WorkspaceController {
  // …现有文件方法…
  openFiles(): void;
  openBrowser(url?: string): string;
  activateTab(tab: PanelTab): void;
  closeFileTab(path: string): void;
  closeBrowserTab(id: string): void;
  navigateBrowser(id: string, url: string): void;
  browserHistory(id: string, action: 'back' | 'forward'): void;
  reloadBrowser(id: string): void;
  stopBrowser(id: string): void;
  focusBrowser(id: string): void;
  layoutBrowser(id: string, bounds: BrowserBounds, visible: boolean): void;
  updateBrowserFromMain(viewId: string, state: BrowserViewState): void;
  openBrowserFromPopup(url: string): void;
  dispose(): void;
}
```

`openBrowser` 先同步创建 `BrowserTab` 并返回 `id`，再异步 `create` 视图；`updateBrowserFromMain` 通过 `viewId` 找到 tab 更新状态。

### 4.4 状态迁移

| 操作                       | `active`                           | `tabOrder`                  | 数据                                     | 备注                      |
| -------------------------- | ---------------------------------- | --------------------------- | ---------------------------------------- | ------------------------- |
| `openFiles()`              | `{kind:'files'}`                   | 不变                        | 确保根目录已加载                         | 不产生标签                |
| `openFile(path)`（新文件） | `{kind:'file',path}`               | 追加 `{kind:'file',path}`   | 新建 `FileTab`                           | 打开面板                  |
| `openFile(path)`（已存在） | `{kind:'file',path}`               | 不变                        | 不变                                     | 只激活                    |
| `openBrowser(url?)`        | `{kind:'browser',id}`              | 追加 `{kind:'browser',id}`  | 新建 `BrowserTab`，异步创建视图          | 打开面板；起始页/直接 URL |
| 激活标签                   | 对应标签                           | 不变                        | 不变                                     | 校验存在                  |
| 关闭当前标签               | 右邻 → 左邻 → 文件                 | 移除                        | 删除 tab；销毁视图                       | 见下                      |
| 关闭非当前标签             | 不变                               | 移除                        | 删除 tab；销毁视图                       | 不变                      |
| 切换工作区                 | 文件/文件树 → files；浏览器 → 保持 | 移除所有 file，保留 browser | 清空 fileTabs/listings；保留 browserTabs | 浏览器不随工作区走        |
| 切换会话                   | 不变                               | 不变                        | 不变                                     | 面板状态是窗口级          |
| 收起面板                   | 不变                               | 不变                        | 不变                                     | 视图隐藏，页面继续运行    |
| 全屏                       | 不变                               | 不变                        | 不变                                     | 视图 bounds 更新          |
| 打开设置页                 | 不变                               | 不变                        | 不变                                     | aside 隐藏，视图隐藏      |

关闭当前标签的“相邻”规则与现有文件标签一致：`paths[index + 1] ?? paths[index - 1] ?? null`，只是这里把文件与浏览器放在同一个 `tabOrder` 里计算；若没有可关闭标签，回到 `files`。

`setWorkspace()` 仍清空文件相关状态，但需要：

```ts
tabOrder = tabOrder.filter((tab) => tab.kind === 'browser');
if (active.kind !== 'browser') active = { kind: 'files' };
```

`browserTabs` 不清空；切换工作区后浏览器标签仍可访问（URL 与页面内容不属于工作区）。

### 4.5 UI 结构与样式

#### 头部

```text
┌──────────────────────────────────────────────────────────────┐
│ [📁 文件] [notes.txt ×] [example.com ×] [+]      [⛶] [↻] [»] │
│ ← → ⟳  [https://example.com................]           [↗]  │
└──────────────────────────────────────────────────────────────┘
```

- `#workspace-tree-tab` 保留，标签文字仍为“文件”（与现有测试/用户习惯一致）；菜单项叫“工作区文件”。
- `+` 的 DOM：`button#workspace-new-tab.workspace-new-tab`，放在 `#workspace-tabs` 之外、`.workspace-panel-actions` 之前。
- `#workspace-tabs` 的 CSS 从 `flex: 1` 改为 `flex: 0 1 auto`，让只有少量标签时 `+` 紧挨最后一个标签；`min-width: 0; overflow-x: auto` 保留。
- `.workspace-panel-actions` 保持 `margin-left: auto`，把全屏/刷新/收起推到最右。
- 浏览器标签的 DOM：`div.workspace-browser-tab[data-browser-id]`，内部 `button[role=tab]` + `button.workspace-tab-close`；与文件标签结构一致。
- 加载中：标签图标位置显示 `.session-spinner` 类似的小 spinner；非加载显示 globe；错误显示 warning 图标（P1）。
- 所有新增样式用**类选择器**，不要用 `#id`：`tests/desktop-style-budget.test.ts:24-33` 明确禁止在 `ui/styles.css` 里新增 ID 选择器。

#### `+` 菜单

- 使用 `primitives.tsx` 已导出的 Mantine `Menu`，`position="bottom-end"`、`withinPortal`。
- 菜单宽度约 248px；每项两行：
  - 主文案（`工作区文件` / `浏览器`）
  - 副文案（`浏览项目中的文件` / `在面板中打开网页`）
- 图标：`folder`、`globe`；沿用 `Icon.tsx` 的图标体系，新增 `globe`/`plus`（若没有）。
- 键盘：Mantine Menu 自带方向键/Esc；关闭后焦点回到 `+`（测试确认）。
- 浏览器标签达到上限时，菜单项禁用并显示原因（tooltip）。

#### 浏览器面板

```text
.browser-pane（flex column，占满 header 以下）
  .browser-toolbar（34px）
    .browser-nav（后退 / 前进 / 刷新或停止）
    input.browser-address
    button.browser-external（↗）
  .browser-surface（flex: 1，position: relative）
    - 原生 WebContentsView 覆盖这块矩形
    - 起始页 / 错误页是 HTML，只在原生视图隐藏时显示
```

- 原生视图的 bounds 由 `.browser-surface.getBoundingClientRect()` 得出；工具栏和面板头部在视图外，始终可点击。
- 起始页/错误页必须是 HTML 覆盖层；当它们显示时，主进程把视图设为不可见，否则原生视图会盖住它们。
- 页面加载中：视图可见（显示页面/空白），起始页隐藏；工具栏显示停止按钮。
- 错误：视图隐藏，错误页显示；重试时先隐藏错误页、显示视图、重新导航。
- 面板宽度 `< 300px` 时给 `.workspace-panel` 加 `data-compact="true"`（可用 `ResizeObserver`），隐藏“用系统浏览器打开”按钮、缩小地址栏字号；标签文字省略。
- 不使用远程 favicon：Host CSP `img-src 'self' data:` 会阻止 `https://.../favicon.ico`；v1 用 globe 图标。若要 favicon，后续由主进程抓取并转 data URL，另行设计。

### 4.6 主进程 `BrowserViews`

新增文件：`apps/desktop/browser-views.ts`（或 `main-browser.ts`，与 `main-attachment.ts` 同级）。

职责：

- 创建/销毁 `WebContentsView`；
- 维护 `viewId -> { view, state }`；
- 处理 `layout`（bounds + 可见性）；
- 处理 `navigate/back/forward/reload/stop/focus`；
- 转发页面状态事件；
- 安全策略：权限拒绝、弹窗拦截、导航协议白名单；
- 窗口关闭时销毁全部视图。

核心代码草案（结构示意；`handle`/`navigate`/`history` 等分派方法、类型导入与错误文案省略，实现时补齐）：

```ts
import {
  nativeTheme,
  session,
  WebContentsView,
  type BrowserWindow,
  type BrowserWindowConstructorOptions,
  type Rectangle,
} from 'electron';
import type { BrowserEvent, BrowserReply, BrowserViewState } from './browser-contract.ts';
import { directHttpUrl } from './browser-url.ts';

const BROWSER_PARTITION = 'persist:yuantu-browser';
const MAX_BROWSER_VIEWS = 8;

function securePopupOptions(parent: BrowserWindow): BrowserWindowConstructorOptions {
  return {
    width: 980,
    height: 720,
    parent,
    modal: false,
    show: true,
    autoHideMenuBar: true,
    webPreferences: {
      partition: BROWSER_PARTITION,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
    },
  };
}

interface BrowserViewEntry {
  view: WebContentsView;
  state: BrowserViewState;
  /** POST/auth popups owned by this tab; closed with it. */
  popups: Set<BrowserWindow>;
}

export class BrowserViews {
  private readonly views = new Map<string, BrowserViewEntry>();
  private sequence = 0;
  private active: string | null = null;

  constructor(
    private readonly window: BrowserWindow,
    private readonly emit: (event: BrowserEvent) => void,
  ) {
    const partition = session.fromPartition(BROWSER_PARTITION);
    partition.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
    partition.setPermissionCheckHandler(() => false);
  }

  create(url?: string): BrowserReply {
    if (this.views.size >= MAX_BROWSER_VIEWS)
      return { ok: false, error: 'Browser tab limit reached' };
    const target = url ? directHttpUrl(url) : undefined;
    if (url && !target) return { ok: false, error: 'Invalid browser URL' };
    const viewId = `view-${++this.sequence}`;
    const view = new WebContentsView({
      webPreferences: {
        partition: BROWSER_PARTITION,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        nodeIntegrationInSubFrames: false,
        webSecurity: true,
        allowRunningInsecureContent: false,
      },
    });
    view.setBackgroundColor(nativeTheme.shouldUseDarkColors ? '#141416' : '#ffffff');
    this.window.contentView.addChildView(view);
    view.setVisible(false);
    const entry: BrowserViewEntry = {
      view,
      state: {
        viewId,
        url: target ?? '',
        title: '',
        loading: false,
        canGoBack: false,
        canGoForward: false,
        error: null,
        crashed: false,
      },
      popups: new Set(),
    };
    this.views.set(viewId, entry);
    this.wire(viewId, entry);
    // loadURL 的 reject 不是 UI 错误：用户停止、被下一次导航取代都会 reject。
    // 真正的失败由 did-fail-load 处理，取消由 did-stop-loading/did-fail-provisional-load 处理。
    if (target) void view.webContents.loadURL(target).catch(() => {});
    return { ok: true, viewId, state: entry.state };
  }

  layout(viewId: string, bounds: Rectangle, visible: boolean): void {
    const entry = this.views.get(viewId);
    if (!entry) return;
    const [width, height] = this.window.getContentSize();
    const x = Math.max(0, Math.min(bounds.x, width));
    const y = Math.max(0, Math.min(bounds.y, height));
    const rect = {
      x,
      y,
      width: Math.max(0, Math.min(bounds.width, width - x)),
      height: Math.max(0, Math.min(bounds.height, height - y)),
    };
    entry.view.setBounds(rect);
    if (visible && rect.width > 0 && rect.height > 0) {
      for (const [id, other] of this.views) if (id !== viewId) other.view.setVisible(false);
      this.window.contentView.addChildView(entry.view); // 置顶
      entry.view.setVisible(true);
      this.active = viewId;
    } else {
      entry.view.setVisible(false);
      if (this.active === viewId) this.active = null;
    }
  }

  private wire(viewId: string, entry: BrowserViewEntry): void {
    const { webContents } = entry.view;
    const update = (patch: Partial<BrowserViewState>) => {
      entry.state = { ...entry.state, ...patch };
      this.emit({ type: 'state', state: entry.state });
    };
    webContents.setWindowOpenHandler((details) => {
      const target = directHttpUrl(details.url);
      if (!target) return { action: 'deny' };
      /**
       * 表单 POST 的 target=_blank 不能变成面板标签：把 url 交给 loadURL 会发 GET，
       * 请求体丢失。POST 弹窗保留为受控的真实子窗口（保留 opener / method / body）；
       * 只有普通 GET 弹窗才进入面板标签。
       */
      if (details.postBody) {
        return { action: 'allow', overrideBrowserWindowOptions: securePopupOptions(this.window) };
      }
      this.emit({ type: 'open', url: target });
      return { action: 'deny' };
    });
    // Electron 的 did-create-window 监听器签名是 (window, details)，没有 event 参数。
    webContents.on('did-create-window', (popup) => this.hardenPopup(viewId, popup));
    webContents.on('will-navigate', (event, url) => {
      if (!directHttpUrl(url)) event.preventDefault();
    });
    webContents.on('will-redirect', (event, url) => {
      if (!directHttpUrl(url)) event.preventDefault();
    });
    webContents.on('did-start-loading', () => update({ loading: true, error: null }));
    webContents.on('did-stop-loading', () =>
      update({
        loading: false,
        canGoBack: webContents.canGoBack(),
        canGoForward: webContents.canGoForward(),
      }),
    );
    webContents.on('did-navigate', (_event, url) => update({ url, error: null }));
    webContents.on('did-navigate-in-page', (_event, url, isMainFrame) => {
      // 子框架的 hash/history 变化不是主页面地址；只有主框架才更新地址栏。
      if (isMainFrame) update({ url });
    });
    webContents.on('page-title-updated', (_event, title) => update({ title }));
    // 用户停止/被新导航取代：did-fail-provisional-load 会触发，不能显示成错误页。
    webContents.on(
      'did-fail-provisional-load',
      (_event, _code, _description, _url, isMainFrame) => {
        if (isMainFrame) update({ loading: false });
      },
    );
    webContents.on('did-fail-load', (_event, code, description, url, isMainFrame) => {
      if (!isMainFrame) return;
      if (code === -3) {
        update({ loading: false });
        return;
      }
      update({ error: { code, description, url }, loading: false });
    });
    webContents.on('render-process-gone', () => update({ crashed: true, loading: false }));
    webContents.on('destroyed', () => this.forget(viewId));
  }

  private hardenPopup(viewId: string, popup: BrowserWindow): void {
    const entry = this.views.get(viewId);
    if (!entry) {
      popup.destroy();
      return;
    }
    entry.popups.add(popup);
    popup.removeMenu();
    popup.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    popup.webContents.on('will-navigate', (event, url) => {
      if (!directHttpUrl(url)) event.preventDefault();
    });
    popup.webContents.on('will-redirect', (event, url) => {
      if (!directHttpUrl(url)) event.preventDefault();
    });
    popup.on('closed', () => entry.popups.delete(popup));
  }

  private forget(viewId: string): void {
    this.views.delete(viewId);
    if (this.active === viewId) this.active = null;
  }

  destroy(viewId: string): void {
    const entry = this.views.get(viewId);
    if (!entry) return;
    this.views.delete(viewId);
    if (this.active === viewId) this.active = null;
    for (const popup of [...entry.popups]) if (!popup.isDestroyed()) popup.close();
    entry.view.setVisible(false);
    entry.view.webContents.close();
    this.window.contentView.removeChildView(entry.view);
  }

  destroyAll(): void {
    for (const viewId of [...this.views.keys()]) this.destroy(viewId);
  }
}
```

说明：

- `view.webContents.close()` 释放页面进程；`removeChildView` 必须在关闭前后保持一致，按实际 API 行为调整。
- `setBackgroundColor` 按主题取 `#141416` / `#ffffff`，避免深色主题首帧白闪；页面自己的背景优先。
- 只允许一个视图可见；`layout(visible=true)` 会隐藏其他视图并置顶当前视图。
- `layout` 的 `x/y/width/height` 使用 renderer 的 CSS 像素；窗口未做页面缩放时与 Electron 的 DIP 一致。若后续支持 `zoomFactor`，需要乘/除缩放因子。
- `loadURL` 的 promise reject 不能当作错误页：停止、被下一次导航取代都会 reject。**实测（Electron 43，`webContents.stop()`）**：只触发 `did-stop-loading`，`loadURL` 以 `ERR_FAILED (-2)` reject，**没有** `did-fail-load`；原来的 `loadURL().catch` 会因此误显示错误页。真正的失败用 `did-fail-load`；取消可能走 `did-fail-provisional-load` 或只有 `did-stop-loading`，两者都不应产生红色错误页。
- `did-fail-load` 忽略 `ERR_ABORTED (-3)`，避免点击链接/停止时误报；`did-fail-provisional-load` 只把 `loading` 置回 false。
- `did-navigate-in-page` 必须检查 `isMainFrame`；子框架的 hash/history 变化不是主页面地址。
- `page-title-updated` 外部标题按文本渲染；不要插入 HTML。
- `setWindowOpenHandler` 只接受 http/https；带 `postBody` 的 POST 弹窗必须走受控真实子窗口，不能把 URL 交给 `loadURL`（否则 POST 退化为 GET）。普通 GET 弹窗才转面板标签；`about:blank`/`javascript:` 拒绝。
- **实测（Electron 43）**：表单 `method=POST target=_blank` 的 `HandlerDetails.postBody` 存在、`disposition` 是 `foreground-tab`（不是 `new-window`），且 `action:'allow'` 后服务端收到的仍是 POST；因此必须按 `postBody` 判断，不能只看 `disposition`。
- `did-create-window` 的回调签名是 `(window, details)`，没有 `event` 参数；写成 `(_event, popup)` 会把 details 当窗口，导致 `popup.webContents` 访问错误。

### 4.7 IPC 契约

新增文件：`apps/desktop/browser-contract.ts`，放纯类型与校验（可单测，不依赖 Electron）。

```ts
export interface BrowserBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface BrowserViewState {
  viewId: string;
  url: string;
  title: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  error: { code: number; description: string; url: string } | null;
  crashed: boolean;
}

export type BrowserCommand =
  | { type: 'create'; url?: string }
  | { type: 'destroy'; viewId: string }
  | { type: 'layout'; viewId: string; bounds: BrowserBounds; visible: boolean }
  | { type: 'navigate'; viewId: string; url: string }
  | { type: 'back'; viewId: string }
  | { type: 'forward'; viewId: string }
  | { type: 'reload'; viewId: string }
  | { type: 'stop'; viewId: string }
  | { type: 'focus'; viewId: string };

export type BrowserReply =
  { ok: true; viewId?: string; state?: BrowserViewState } | { ok: false; error: string };

export type BrowserEvent =
  { type: 'state'; state: BrowserViewState } | { type: 'open'; url: string };
```

`DesktopBridge` 增加：

```ts
browser(command: BrowserCommand): Promise<BrowserReply>;
subscribeBrowser(listener: (event: BrowserEvent) => void): () => void;
```

`preload.ts`：

```ts
browser: (command) => ipcRenderer.invoke('yuantu:browser', command),
subscribeBrowser(listener) {
  const receive = (_event: Electron.IpcRendererEvent, event: BrowserEvent) => listener(event);
  ipcRenderer.on('yuantu:browser-event', receive);
  return () => ipcRenderer.removeListener('yuantu:browser-event', receive);
},
```

主进程：

```ts
ipcMain.handle('yuantu:browser', async (event, input: unknown) => {
  try {
    assertSender(event);
    if (!browserViews) throw new Error('Browser is not available');
    const command = parseBrowserCommand(input);
    return browserViews.dispatch(command);
  } catch (error) {
    return { ok: false, error: safeError(error) };
  }
});
```

`dispatch` 是按 `command.type` 分派到 `create/layout/navigate/back/...` 的薄层，便于在单测里替换。

主进程 → 渲染进程：

```ts
window.webContents.send('yuantu:browser-event', event);
```

校验要点：

- `viewId` 必须是本窗口创建的 ID；
- `bounds` 必须是有限数字，宽高非负，坐标限制在合理范围（如 ±100000）；
- `navigate` 的 URL 必须再次经过 `isHttpUrl`（不信任 renderer）；
- `create` 的 URL 同样校验；`about:blank` 只允许内部初始值，不允许命令传入；
- `destroy/layout/...` 对不存在的 `viewId` 返回 `ok:false`，不抛异常到日志；
- 每个窗口最多 8 个视图。

### 4.8 渲染进程：`BrowserPane` 与状态同步

新增 `apps/desktop/ui/browser/BrowserPane.tsx`、`browser-url.ts`、`browser-overlays.ts`（或放在 `workspace/` 下，按现有目录习惯）。

#### 组件职责

- 只渲染**当前激活**的浏览器标签；非激活标签的状态保存在 `workspace-model` 中，主进程视图隐藏。
- `BrowserPane` 内部状态：地址栏草稿、是否聚焦、是否显示非法地址提示。
- 事件订阅在 `workspace-mount` 或 `application` 建立一次，转发给 controller；不要在每个 pane 里重复订阅。

#### 创建流程

1. 用户点击 `浏览器` → `controller.openBrowser()`：
   - 立即在 `browserTabs` 中加入 `BrowserTab`（`viewId: null`，`started: false`），激活、打开面板；
   - 调用 `bridge.browser({type:'create'})`。
2. 主进程创建 `WebContentsView`，返回 `{viewId, state}`。
3. Renderer 把 `viewId` 写回 tab；`BrowserPane` 挂载后测量 `.browser-surface` 并发送 `layout`（起始页时 `visible:false`）。
4. 用户输入地址回车 → `navigate` 命令；主进程加载；状态事件更新标题/URL/loading。
5. 用户关闭标签 → `destroy`；主进程关闭视图；renderer 删除 tab。

竞态处理：

- `create` 返回前用户关闭了标签：renderer 立即发送 `destroy(viewId)`。
- `create` 返回前用户输入并回车：把 URL 存入 `pendingUrlRef`，创建成功后发送 `navigate`。
- `create` 失败：tab 保留，显示错误页（`error`），提供重试；重试重新 `create`。
- 页面崩溃：`crashed=true`，显示“重新打开”；重试先 `destroy` 旧视图，再 `create` 新视图。

#### 布局同步

```tsx
const syncLayout = () => {
  if (!tab.viewId) return;
  const rect = surface.current?.getBoundingClientRect();
  if (!rect) return;
  const visible =
    active &&
    !overlayOpen &&
    tab.started &&
    !tab.error &&
    !tab.crashed &&
    rect.width > 0 &&
    rect.height > 0;
  void bridge.browser({
    type: 'layout',
    viewId: tab.viewId,
    bounds: {
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
    },
    visible,
  });
};
```

触发时机：

- `ResizeObserver` 观察 `.browser-surface`；
- `window.resize`；
- `tab.viewId`、`tab.started`、`tab.error`、`tab.crashed`、`active`、`overlayOpen` 变化；
- 面板展开/收起、全屏、设置页切换；
- 用 `requestAnimationFrame` 合并连续调用，避免拖动宽度时每像素一次 IPC。

**卸载/切页必须隐藏**：`BrowserPane` 在 effect cleanup 中立即发送一次 `layout(..., visible:false)`（fire-and-forget）。否则从聊天页切到设置页、收起面板或切到文件标签时，原生视图可能留在屏幕上盖住新页面。主进程只在**窗口关闭/应用退出**时 `destroyAll()`；窗口失焦（切到其他应用、系统对话框、DevTools）**不得销毁或隐藏**浏览器会话，否则标签、历史和页面状态会丢失。窗口最小化/隐藏时视图随窗口不可见，不需要额外处理；Host renderer 崩溃时由主进程兜底销毁。

```tsx
useEffect(() => {
  return () => {
    if (tab.viewId)
      void window.yuantu.browser({
        type: 'layout',
        viewId: tab.viewId,
        bounds: lastBounds.current,
        visible: false,
      });
  };
}, [tab.viewId]);
```

#### 浮层可见性

`WebContentsView` 在 HTML 之上，菜单/弹窗会被它盖住。渲染进程增加一个轻量的浮层观察器：

```ts
const OVERLAY_SELECTOR = '[role="dialog"], [role="menu"], [role="listbox"]';

function overlayVisible(element: Element): boolean {
  const node = element as HTMLElement;
  if (node.hidden || node.closest('[hidden]')) return false;
  if (node.getAttribute('aria-hidden') === 'true') return false;
  const style = getComputedStyle(node);
  if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0')
    return false;
  return node.getClientRects().length > 0;
}

export function watchBrowserOverlays(onChange: (open: boolean) => void): () => void {
  let open = false;
  let frame = 0;
  const update = () => {
    frame = 0;
    const next = [...document.querySelectorAll(OVERLAY_SELECTOR)].some(overlayVisible);
    if (next !== open) {
      open = next;
      onChange(next);
    }
  };
  const schedule = () => {
    if (frame) return;
    frame = requestAnimationFrame(update);
  };
  const observer = new MutationObserver(schedule);
  observer.observe(document.body, {
    subtree: true,
    childList: true,
    attributes: true,
    // 菜单可能只切换 hidden/class/style；只观察 role/aria-expanded 会漏掉开关。
    attributeFilter: [
      'role',
      'aria-expanded',
      'aria-hidden',
      'hidden',
      'class',
      'style',
      'data-state',
    ],
  });
  update();
  return () => {
    observer.disconnect();
    if (frame) cancelAnimationFrame(frame);
  };
}
```

- **不能只看元素是否存在**：`#session-menu` 在 `SessionSidebar.tsx:261-299` 始终以 `role="menu"` 挂在 body 上，关闭时只是 `hidden`。`querySelector('[role="menu"]')` 会一直命中，导致 `overlayOpen` 永远为 true、浏览器永远不可见。
- 必须同时判断 `hidden`、祖先 `hidden`、`aria-hidden`、计算样式与 `getClientRects()`；并观察 `hidden/class/style` 属性变化。
- 覆盖 `+` 菜单、会话菜单、命令面板、模型下拉、所有 `Dialog`（Mantine Modal 有 `role=dialog`）。
- 浮层打开时 `overlayOpen=true`，下一次 `layout` 发送 `visible:false`；关闭后恢复。
- 这是“隐藏原生视图”的最小方案；如果未来有新的浮层类型，扩展选择器或在组件里显式上报。
- 不把 tooltip 算进去（`role=tooltip`），因为 tooltip 通常不覆盖浏览器主体；若确实覆盖，可单独处理。
- 单测/冒烟必须覆盖：会话菜单隐藏时浏览器可见；打开 `+` 菜单时浏览器隐藏；关闭后恢复。

#### 地址栏

```tsx
const navigate = () => {
  const target = resolveBrowserAddress(draft);
  if (!target) {
    setInvalid(true);
    return;
  }
  setInvalid(false);
  controller.navigateBrowser(tab.id, target);
  setDraft(target);
  controller.focusBrowser(tab.id); // 主进程 view.webContents.focus()
};
```

- `resolveBrowserAddress` 是纯函数，放在 `apps/desktop/browser-url.ts`，主进程也可复用其 `directHttpUrl` 部分。
- 输入框 `onFocus` 全选；`Escape` 还原 `tab.url` 并 `stopPropagation`，避免触发面板的 Escape（退出全屏/收起面板）。
- 地址栏不随每次按键写回 tab；只在导航/页面事件时同步，且输入框聚焦时不覆盖草稿。
- 非法地址：`aria-invalid=true`，下方/工具栏显示 `只允许 http/https 地址`；不导航。

#### 工具栏

- 后退/前进：`canGoBack/canGoForward` 为 false 时禁用。
- 刷新/停止：`loading ? stop : reload`。
- 外链：调用现有 `window.yuantu.invoke({type:'openLink', url})`；失败时在错误页/工具栏显示提示。
- 工具按钮 `aria-label` + `title`，全部走 i18n。

### 4.9 地址解析（纯函数）

`apps/desktop/browser-url.ts`：

```ts
export const BROWSER_SEARCH_URL = 'https://www.bing.com/search?q=';

const SCHEME = /^[a-zA-Z][a-zA-Z\d+.-]*:/;
const LOCAL = /^(?:localhost|(?:\d{1,3}\.){3}\d{1,3}|\[[0-9a-f:]+\])(?::\d+)?(?:[/?#].*)?$/i;
const HOST = /^(?:[\w-]+\.)+[a-z]{2,}(?::\d+)?(?:[/?#].*)?$/i;

/** Parse one absolute http/https URL; any malformed input returns null instead of throwing. */
function parseHttpUrl(text: string): string | null {
  try {
    const url = new URL(text);
    if (!['http:', 'https:'].includes(url.protocol)) return null;
    if (url.username || url.password) return null;
    return url.toString();
  } catch {
    return null;
  }
}

/** Direct navigation target: only http/https, no credentials. */
export function directHttpUrl(input: string): string | null {
  const text = input.trim();
  if (!text || text.length > 4096 || /[\x00-\x20]/.test(text)) return null;
  return SCHEME.test(text) ? parseHttpUrl(text) : null;
}

/** What Enter in the address bar does: URL, local address, or search. */
export function resolveBrowserAddress(input: string): string | null {
  const text = input.trim();
  if (!text || text.length > 4096) return null;
  const direct = directHttpUrl(text);
  if (direct) return direct;
  // Host:port must be checked before the scheme test: `example.com:8080` looks like a scheme.
  if (LOCAL.test(text)) return parseHttpUrl(`http://${text}`);
  if (HOST.test(text)) return parseHttpUrl(`https://${text}`);
  if (SCHEME.test(text)) return null; // javascript:, file:, mailto:, data: …
  return `${BROWSER_SEARCH_URL}${encodeURIComponent(text)}`;
}
```

主进程只使用 `directHttpUrl`（不接受搜索 URL 之外的空白/控制字符）；渲染进程使用 `resolveBrowserAddress`。

### 4.10 R1/R2/R3 的实现落点

#### R1

`ModelPicker.tsx`：

```tsx
const selectedValue = state.view?.connectionId || options[0]?.value || null;
const selectedLabel =
  options.find((option) => option.value === selectedValue)?.label ?? t('settings.noModel');
const probe = useRef<HTMLSpanElement>(null);
const [fieldWidth, setFieldWidth] = useState(MIN_MODEL_WIDTH);

useLayoutEffect(() => {
  const node = probe.current;
  if (!node) return;
  const label = node.firstElementChild as HTMLElement | null;
  const width = label?.getBoundingClientRect().width ?? 0;
  const next = Math.min(
    MAX_MODEL_WIDTH,
    Math.max(MIN_MODEL_WIDTH, Math.ceil(width) + MODEL_FIELD_CHROME),
  );
  setFieldWidth((current) => (current === next ? current : next));
}, [selectedLabel, lang]);
```

首帧字体未就绪时（自定义字体加载较慢），在 `document.fonts.ready` 之后用同一个测量函数补一次；系统字体通常不需要。

常量：

```ts
const MIN_MODEL_WIDTH = 72;
const MAX_MODEL_WIDTH = 360;
const MODEL_FIELD_CHROME = 40;
```

模板：

```tsx
<span ref={probe} className="model-width-probe" aria-hidden="true">
  <span>{selectedLabel}</span>
</span>
<div className="model-picker-frame" style={{ width: fieldWidth }}>
  <Select
    ...
    rightSectionWidth={24}
  />
</div>
```

CSS（`apps/desktop/ui/styles.css`）：

```css
.chat-page .chat-model .model-picker-frame {
  flex: 0 0 auto;
  min-width: 0;
  max-width: 100%;
  transition: width 120ms ease;
}

.chat-page .chat-model .mantine-Select-input {
  padding-left: 8px;
  padding-right: 28px;
}

@media (prefers-reduced-motion: reduce) {
  .chat-page .chat-model .model-picker-frame {
    transition: none;
  }
}
```

删除旧注释“measure the longest option”，删除 `min-width: 150px`。

验收测量：选择 `GPT-6-Astra` 时：

- `input` 的 `getBoundingClientRect().width` ≈ `labelWidth + 40`；
- `label` 右缘到 `.select-chevron` 左缘 ≤ 14px；
- 下拉菜单仍完整显示长模型名。

#### R2

`ProductShell.tsx`：删除 `#session-short` 的 `<span>`。

`chrome.ts`：删除 `sessionShort` 字段。

`application.tsx`：删除 `updateChrome({sessionShort...})` 中的该字段（保留 `welcomeVisible`）。

`apps/desktop/ui/styles.css`：删除 `.session-short` 与 `.chat-page .session-short` 两条规则。

`i18n-conversation.ts`：R3 后删除 `ui.sessionShort`。

`tests/ui-copy-migration.test.ts`：删除对 `ui.sessionShort` 的断言，改为 `ui.untitledSession`。

#### R3

`session-model.ts`：

```ts
/** The row's title: its own, or the untitled label; never an empty button. */
export function sessionTitle(item: Pick<SessionInfo, 'id' | 'title'>): string {
  return item.title || t('ui.untitledSession');
}
```

- `openDialog()` 的 `title` 回退改为 `t('ui.untitledSession')`。
- `application.tsx:550` 的回退改为 `t('ui.untitledSession')`。
- `SessionRow.tsx:102` 的 `aria-label` 可保留 `item.title || item.id.slice(0, 8)`（仅读屏），但视觉文本由 `sessionTitle` 决定。
- `sessionTooltip()` 的回退改为 `t('ui.untitledSession')`。
- `i18n-conversation.ts` 新增：

```ts
'ui.untitledSession': ['新增会话', 'New session'],
```

- 删除 `ui.sessionShort`。

### 4.11 改动文件清单

| 文件                                                                                                                  | 改动                                                                |
| --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `apps/desktop/ui/settings/ModelPicker.tsx`                                                                            | R1：按选中项测量；`rightSectionWidth`；常量                         |
| `apps/desktop/ui/styles.css`                                                                                          | R1 宽度/内边距；R2 删除 `.session-short`；R4/R5 新增标签/浏览器样式 |
| `apps/desktop/ui/layout/ProductShell.tsx`                                                                             | R2 删除 `#session-short`                                            |
| `apps/desktop/ui/chrome.ts`                                                                                           | R2 删除 `sessionShort`                                              |
| `apps/desktop/ui/application.tsx`                                                                                     | R2 删除投影；R3 标题回退；浏览器事件订阅挂载                        |
| `apps/desktop/ui/sessions/session-model.ts`                                                                           | R3 标题/弹窗/tooltip 回退                                           |
| `apps/desktop/ui/sessions/SessionRow.tsx`                                                                             | R3 视觉标题（如 aria 调整）                                         |
| `apps/desktop/i18n-conversation.ts`                                                                                   | R3 新增/删除键                                                      |
| `apps/desktop/ui/workspace/workspace-model.ts`                                                                        | R4/R5 标签模型、浏览器状态、控制器方法                              |
| `apps/desktop/ui/workspace/WorkspacePanel.tsx`                                                                        | R4/R5 标签栏、`+` 菜单、浏览器面板、布局同步                        |
| `apps/desktop/ui/workspace/workspace-mount.tsx`                                                                       | 注入 `browser` 依赖；订阅浏览器事件                                 |
| `apps/desktop/ui/browser/BrowserPane.tsx`（新）                                                                       | 浏览器工具栏/起始页/错误页/布局                                     |
| `apps/desktop/ui/browser/browser-url.ts`（新）                                                                        | 地址解析纯函数                                                      |
| `apps/desktop/ui/browser/browser-overlays.ts`（新）                                                                   | 浮层观察                                                            |
| `apps/desktop/browser-contract.ts`（新）                                                                              | 命令/事件类型与校验                                                 |
| `apps/desktop/browser-views.ts`（新）                                                                                 | `WebContentsView` 管理                                              |
| `apps/desktop/contract.ts`                                                                                            | `DesktopBridge.browser` / `subscribeBrowser`                        |
| `apps/desktop/preload.ts`                                                                                             | IPC 通道                                                            |
| `apps/desktop/main.ts`                                                                                                | 创建 `BrowserViews`；IPC handler；窗口关闭清理                      |
| `apps/desktop/index.html`                                                                                             | 预计不改 CSP；Phase 0 实测后再定                                    |
| `README.md`                                                                                                           | 浏览器能力与安全边界说明                                            |
| `tests/desktop-browser.smoke.mjs`（新）                                                                               | 浏览器 smoke                                                        |
| `tests/browser-url.test.ts`（新）                                                                                     | 地址解析                                                            |
| `tests/workspace-tabs.test.ts`（新）                                                                                  | 标签状态机                                                          |
| `tests/desktop-layout.smoke.mjs` / `desktop-sessions.smoke.mjs` / `settings.smoke.mjs` / `desktop-language.smoke.mjs` | 回归与新增断言                                                      |
| `tests/ui-copy-migration.test.ts`                                                                                     | 字典键调整                                                          |

## 5. 安全与隐私

### 5.1 威胁边界

浏览器页面是**不可信内容**。它不能：

- 访问 `window.yuantu` 或任何 preload API；
- 使用 Node/`require`/`process`；
- 读取工作区文件（除非用户通过页面自行上传/下载）；
- 触发 Host 页面的导航；它自己的 `window.open` 只由浏览器层按策略处理（GET → 面板标签，POST → 受控子窗口），不会落到 Host 页面；
- 修改应用设置、会话或 Agent 工具。

它只能：

- 在独立 `persist:yuantu-browser` 分区中加载 `http/https` 页面；
- 通过用户操作使用地址栏、前进/后退、刷新；
- 在用户允许的范围内使用网页自带能力（默认拒绝敏感权限）。

### 5.2 控制清单

| 风险              | 控制                                                                                                                                                          |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 任意本地文件/协议 | `directHttpUrl` 只允许 http/https；主进程 `will-navigate`/`will-redirect` 再次拦截；拒绝 `file:`/`data:`/`javascript:`/`blob:`                                |
| 凭据泄漏到 URL    | 拒绝带 `username/password` 的 URL（与 `openLink` 一致）                                                                                                       |
| Node/预加载注入   | `sandbox: true`、`contextIsolation: true`、`nodeIntegration: false`、无 preload；`webSecurity: true`                                                          |
| 弹窗/新窗口逃逸   | 普通 GET 弹窗：`deny` + 把 http/https URL 交给 renderer 新建面板标签；POST 弹窗：`allow` 到受控子窗口（同分区、无 preload/Node、禁止再弹窗）；其余一律 `deny` |
| 权限滥用          | 分区 session 的 `setPermissionRequestHandler`/`setPermissionCheckHandler` 全部拒绝；`setDevicePermissionHandler` 与 USB/串口/HID/蓝牙选择事件同样拒绝         |
| 窗口失焦/关闭     | 失焦不销毁、不隐藏；仅窗口关闭/应用退出 `destroyAll()`；renderer 崩溃时兜底销毁；避免失焦丢标签/历史/页面状态                                                 |
| Host 页面被导航   | 主窗口的 `will-navigate`/`setWindowOpenHandler` 保持现状（拒绝）                                                                                              |
| CSP 被放宽        | `WebContentsView` 不受 Host 页面 CSP 约束，因此不修改 `index.html` 的 CSP                                                                                     |
| 下载自动执行      | P1：`will-download` 弹保存对话框，不自动打开；文件名清洗                                                                                                      |
| 证书错误          | 不覆盖 `certificate-error`，错误页展示                                                                                                                        |
| 数据残留          | 浏览器数据在 `persist:yuantu-browser` 分区；本轮不提供清除 UI，README 说明路径与后续入口                                                                      |
| 隐私误解          | UI/README 明确：浏览器页面不会自动发送给模型；Agent 的 `browser_*` 工具是独立功能                                                                             |

### 5.3 与 Host 安全设置的关系

- 应用的权限预设（`read-only` / `ask` / `full-access` 等）控制的是 **Agent 工具**，不控制用户手动浏览器。
- 浏览器不调用 `CarrierCommand`，不经过 Host，不产生会话消息。
- 如果未来希望 Agent 读取浏览器页面，需要新增显式的“分享当前页面给会话”动作，并经过权限/审批设计；不在本轮。

## 6. 文案与 i18n

所有新增文案进入字典（`apps/desktop/i18n-*.ts`），中英成对；不得在组件里写死中文。

| 键                           | zh-CN                               | en-US                                     | 用途                  |
| ---------------------------- | ----------------------------------- | ----------------------------------------- | --------------------- |
| `ui.untitledSession`         | 新增会话                            | New session                               | R3 未命名会话         |
| `workspace.newTab`           | 新建标签页                          | New tab                                   | `+` 的 aria/tooltip   |
| `workspace.filesTab`         | 工作区文件                          | Workspace files                           | 菜单项                |
| `workspace.filesTabHint`     | 浏览项目中的文件                    | Browse project files                      | 菜单副标题            |
| `workspace.browserTab`       | 浏览器                              | Browser                                   | 菜单项                |
| `workspace.browserTabHint`   | 在面板中打开网页                    | Open a web page in the panel              | 菜单副标题            |
| `browser.untitled`           | 新标签页                            | New tab                                   | 浏览器标签/起始页标题 |
| `browser.startHint`          | 在上方输入网址，或输入要搜索的内容  | Enter an address above, or search the web | 起始页                |
| `browser.addressLabel`       | 地址栏                              | Address bar                               | 输入框 aria           |
| `browser.addressPlaceholder` | 输入网址或搜索内容                  | Enter an address or search                | 输入框 placeholder    |
| `browser.back`               | 后退                                | Back                                      | 工具栏                |
| `browser.forward`            | 前进                                | Forward                                   | 工具栏                |
| `browser.reload`             | 重新加载                            | Reload                                    | 工具栏                |
| `browser.stop`               | 停止加载                            | Stop                                      | 工具栏                |
| `browser.openExternal`       | 用系统浏览器打开                    | Open in system browser                    | 工具栏/错误页         |
| `browser.closeTab`           | 关闭 {name}                         | Close {name}                              | 标签关闭 aria         |
| `browser.loading`            | 正在加载…                           | Loading...                                | 状态                  |
| `browser.errorTitle`         | 无法打开此页面                      | This page could not be opened             | 错误页                |
| `browser.errorCode`          | 错误代码 {code}                     | Error code {code}                         | 错误页                |
| `browser.retry`              | 重试                                | Retry                                     | 错误页                |
| `browser.crashed`            | 页面已停止运行                      | The page stopped working                  | 崩溃                  |
| `browser.reopen`             | 重新打开                            | Reopen                                    | 崩溃                  |
| `browser.unsafeAddress`      | 只允许 http/https 地址              | Only http and https addresses are allowed | 地址校验              |
| `browser.tabLimit`           | 最多同时打开 {count} 个浏览器标签页 | At most {count} browser tabs              | 上限                  |

P1 右键菜单若实现，另加 `browser.menu*` 与主进程 `mainText()` 键；不在本轮验收。

## 7. 测试计划

### 7.1 单元测试

| 文件                                           | 覆盖                                                                                                                                                     |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tests/browser-url.test.ts`（新）              | `resolveBrowserAddress` / `directHttpUrl`：域名、端口、localhost、搜索、非法协议、空串、控制字符、凭据、非法端口/非法 IPv4（必须返回 null 而不是抛异常） |
| `tests/workspace-tabs.test.ts`（新）           | `openFiles/openFile/openBrowser/close/activate/setWorkspace` 的 active、tabOrder、邻接选择、无重复、浏览器保留                                           |
| `tests/model-settings.test.ts`（扩展）         | 若抽出 `modelFieldWidth(labelWidth)`，测试 72/360 边界和 +40                                                                                             |
| `tests/desktop-react-sessions.test.ts`（扩展） | `sessionTitle` 空标题 → `新增会话`；有标题不覆盖                                                                                                         |
| `tests/ui-copy-migration.test.ts`              | 删除 `ui.sessionShort` 断言，新增 `ui.untitledSession`                                                                                                   |
| `tests/i18n-gate.test.ts` / `i18n:check`       | 新键中英齐全，无硬编码中文                                                                                                                               |

### 7.2 Electron smoke

新增 `tests/desktop-browser.smoke.mjs`，加入 `package.json` 的 `smoke:desktop` 列表：

1. 启动临时 workspace + 本地 HTTP fixture（HTML 页面、标题、target=_blank、慢页面、失败端口）。
2. 打开右侧面板，点击 `#workspace-new-tab`：
   - 菜单恰好两项；
   - 点击 `浏览器`，等待 `.browser-pane` 与 `.browser-surface`；
   - 断言主进程存在一个 `WebContentsView`。
3. 地址栏输入 `http://127.0.0.1:<port>/one` 回车：
   - 标签标题变为页面标题；
   - 地址栏 URL 正确；
   - 主进程 `webContents.getURL()` 正确；
   - `.browser-surface` 的 bounds 与视图 bounds 误差 ≤ 2px。
4. 前进/后退/刷新状态；慢页面加载中点“停止”后，**不出现错误页**，标签回到非 loading。
5. 失败地址 → 错误页；重试。
6. 页面内 `window.open('/popup')`（GET）→ 出现第二个标签；主进程视图数 +1。
7. 子框架（iframe）修改 `location.hash` → 主页面地址栏 URL 不变；主框架 hash 变化才更新。
8. 菜单层叠：
   - 会话菜单隐藏时（`#session-menu[hidden]` 仍在 DOM），当前浏览器视图必须可见；
   - 打开 `+` 菜单时，主进程当前视图 `getVisible() === false`；关闭后恢复 `true`；
   - 打开/关闭会话菜单同样触发隐藏/恢复。
9. 窗口失焦：`app.evaluate` 让主窗口 `blur()` 后，浏览器视图与标签仍存在（不被销毁）；重新聚焦后页面状态不变。
10. 安全：页面内 `typeof require`、`typeof process`、`typeof window.yuantu` 均为 `undefined`；`browser({type:'navigate',url:'file:///...'})` 返回错误且 URL 不变。
11. POST 表单 `target=_blank`：打开受控子窗口，HTTP fixture 收到的 method 为 `POST`（不是 GET）；关闭来源标签时子窗口一并关闭。
12. 关闭标签：主进程 `webContents` 数量下降；面板回到相邻标签或文件树。
13. 关闭窗口：所有浏览器视图与弹窗销毁，进程退出。

现有 smoke 调整：

- `tests/desktop-sessions.smoke.mjs`：文件树/文件标签选择器保持；新增 `+` 菜单与浏览器标签 case；标签条键盘导航覆盖混合类型。
- `tests/desktop-layout.smoke.mjs`：R1 宽度/箭头间距；R2 `#session-short` 不存在；`+` 在 1220 与 820 窗口下可见；浏览器工具栏在窄面板不溢出。
- `tests/desktop.smoke.mjs`：新建会话行/标题为 `新增会话`；发首条消息后更新。
- `tests/desktop-language.smoke.mjs`：en-US 下 `新增会话` → `New session`；`+` 菜单/浏览器起始页英文；语言扫描不进入 guest 页面。
- `tests/settings.smoke.mjs`：模型选择器截图更新（宽度变化属于预期）。

### 7.3 手工验收

- Windows 100%/125%/150% 缩放各一次：bounds 不偏移、不闪烁。
- 窗口最大化/还原、面板拖拽最窄/最宽、全屏/退出全屏。
- 打开菜单/弹窗时浏览器视图隐藏，关闭后恢复；会话菜单处于隐藏状态时浏览器不能被误隐藏。
- 点击其他应用让窗口失焦：标签、历史、页面状态保留；重新聚焦后浏览器仍可见。
- 页面视频全屏（HTML5）是否正常；Esc 行为。
- 登录态：同一站点在两个浏览器标签共享 cookie；重启应用后仍登录。
- 断网/错误域名/证书错误。
- 高 DPI 副屏。

### 7.4 回归风险

- `WorkspacePanel` 的 Escape 顺序（全屏 → 文件 → 收起）在浏览器标签下需要明确：浏览器激活时 Escape 只应退出全屏/收起面板，不应关闭浏览器页面；地址栏内的 Escape 先还原 URL，再冒泡。
- 现有文件标签测试大量依赖 `#workspace-tabs [role=tab][aria-selected=true]`；新增浏览器标签后，测试需限定 `data-path` 或 `data-browser-id`，避免选中错误。
- `setWorkspace` 保留浏览器标签会改变“切换工作区清空面板”的旧行为；如果产品希望清空，改为清空并在文档记录。
- 模型选择器宽度变化会影响 `settings.smoke` 的截图与任何固定宽度断言。
- 删除 `ui.sessionShort` 会影响字典迁移测试与语言扫描；必须同步改。

## 8. 实施计划

| 阶段    | 内容                                                                    | 产出                              | 预估       |
| ------- | ----------------------------------------------------------------------- | --------------------------------- | ---------- |
| Phase 0 | `WebContentsView` 技术验证：bounds、可见性、菜单隐藏、焦点、DPI、无白闪 | 0.5 天 spike 记录；确认无需改 CSP | 0.5 人日   |
| Phase 1 | R2 + R3：删除会话 ID、未命名标题、i18n、测试                            | 可独立合入                        | 0.5 人日   |
| Phase 2 | R1：模型选择器测量/样式/测试                                            | 可独立合入                        | 0.5 人日   |
| Phase 3 | R4：标签模型、`+` 菜单、文件/浏览器标签 DOM（浏览器先占位）             | 右侧面板可多标签                  | 1.5 人日   |
| Phase 4 | R5 核心：`BrowserViews`、IPC、BrowserPane、地址栏、起始/错误页          | 浏览器可用                        | 3 人日     |
| Phase 5 | 安全/体验：弹窗、权限、下载、右键、标签上限、浮层隐藏                   | 可交付                            | 1 人日     |
| Phase 6 | 测试、回归、README、截图验收                                            | 通过 `check`                      | 1.5–2 人日 |

总计约 **8.5–9.5 人日**（不含评审与不可预见问题）。建议 Phase 1/2 先合入，Phase 3/4 同一分支推进，避免 `+` 菜单出现“浏览器”但点击无反应。

### Definition of Done

- [ ] R1–R5 验收项全部通过；
- [ ] `npm run typecheck`、`npm run lint`、`npm run i18n:check`、`npm run format:check` 通过；
- [ ] 新增/更新的单测与 Electron smoke 通过；
- [ ] `npm run build` 与 `npm run smoke:desktop` 通过（至少相关子集；完整套件按仓库要求）；
- [ ] 无 `webviewTag`、无新增 `!important`、无新增 ID 选择器；
- [ ] README 的能力/安全描述与实现一致；
- [ ] 真实 Electron 手工验收记录（截图/日志）附在 PR。

## 9. 风险与备选

| 风险                                         | 影响           | 缓解                                                                                                                                                                      |
| -------------------------------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `WebContentsView` 覆盖 HTML，菜单/弹窗被盖住 | 交互不可用     | 浮层观察器隐藏视图；Phase 0 验证；必要时扩展选择器                                                                                                                        |
| bounds 与 DPI/缩放不一致                     | 视图错位       | 用 `getBoundingClientRect` + `getContentSize` 夹取；高 DPI 手工验收；不实现页面缩放                                                                                       |
| 面板宽度过渡时视图滞后                       | 视觉闪烁       | `ResizeObserver` 每帧更新；过渡期间可暂时隐藏视图                                                                                                                         |
| 站点依赖 OAuth 弹窗回传                      | 登录失败       | POST 弹窗已走受控真实子窗口（保留 opener）；GET `window.open` 仍可能是面板标签、丢失 opener；v1 提供系统浏览器兜底，P1 再按 `disposition === 'new-window'` 放行受控子窗口 |
| 站点拒绝 Electron UA                         | 页面提示不支持 | v1 不伪造 UA；后续可配置 UA（需产品/合规确认）                                                                                                                            |
| 浏览器进程内存                               | 多标签占用高   | 上限 8；关闭即销毁；闲置标签 `setAudioMuted`/后台节流                                                                                                                     |
| `persist:yuantu-browser` 数据增长            | 磁盘占用       | 本轮不做清理 UI；README 记录路径；后续设置页“清除浏览数据”                                                                                                                |
| 测试无法直接读 guest DOM                     | 覆盖不足       | 主进程 `webContents.executeJavaScript` 探针 + 标题/URL 断言 + 主进程视图状态断言                                                                                          |
| 未来 Electron 升级                           | API 变化       | 只用稳定 `WebContentsView`/`webContents`；Phase 0 记录版本；升级前跑浏览器 smoke                                                                                          |

备选：若 Phase 0 发现 `WebContentsView` 在该窗口的层叠/焦点问题不可接受，退回 `<webview>`。退回时必须：

- `webPreferences.webviewTag: true` 仅主窗口；
- `will-attach-webview` 强制 partition、删除 preload、锁定安全偏好；
- 实测 Host CSP 是否需要调整 `frame-src`（尽量不要放宽）；
- 保持同一套 `BrowserPane`/URL/安全测试，仅替换 host 层。

## 10. 待确认问题

以下问题不阻塞文档评审；括号内是本文默认值，若无异议按默认实现。

1. **右侧 `+` 菜单是否只保留两项？** 截图 4 有 `新建终端`；本文按用户文字只做 `工作区文件` + `浏览器`。（默认：两项）
2. **未命名会话文案**：`新增会话`（用户原文）还是更自然的 `新会话` / `未命名会话`？（默认：`新增会话`）
3. **浏览器标签是否跨工作区保留？** 本文默认保留（浏览器不属于工作区）；文件标签随工作区清空。（默认：保留）
4. **浏览器标签是否跨重启恢复？** 本文默认不恢复；浏览数据（cookie）保留。（默认：不恢复）
5. **地址栏搜索源**：Bing；如面向国内用户可换 `cn.bing.com` 或其他。（默认：`www.bing.com`）
6. **是否要求 OAuth 弹窗登录**：POST 弹窗已保留为受控子窗口；GET `window.open` 仍可能因面板标签丢失 opener，v1 用系统浏览器兜底，P1 可按 `disposition` 放行受控子窗口。（默认：仅 POST 走子窗口）
7. **下载与右键菜单是否本轮必须**：本文列为 P1，若必须请提升到 P0（+0.5–1 人日）。（默认：P1）
8. **快捷键**：`Ctrl+Alt+T` / `Ctrl+Alt+P` 是否本轮实现？本文列为 P1。（默认：不实现，仅菜单）
9. **浏览器标签上限**：8 个是否合适？（默认：8）
10. **是否允许 HTTP 页面**：本文允许（浏览器需要访问本地开发服务）；可在地址栏加“不安全”提示（P2）。（默认：允许）

## 11. 评审意见核对（2026-10-27 第二轮）

以下 6 条意见来自对本文件上一版的评审；行号是上一版的，修正后内容已合并回 §4.6–§4.9、§5、§7。

| #   | 意见                                | 结论与原因                                                                                                                                                                                                                         | 修正                                                                                                                                                                                          |
| --- | ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | P1 隐藏的菜单会导致浏览器始终不可见 | **属实**。`SessionSidebar.tsx:261-299` 的 `#session-menu` 始终以 `role="menu"` 挂在 body 上，关闭时只是 `hidden`；`querySelector` 不判断可见性，会永远命中                                                                         | 浮层检测改为同时判断 `hidden`/祖先 `hidden`/`aria-hidden`/计算样式/`getClientRects()`；MutationObserver 增加 `hidden/class/style` 观察                                                        |
| 2   | P1 窗口失焦不能销毁浏览器会话       | **属实**。原文把“失焦/关闭”并列并写了 `destroyAll()`，若照做会在切换应用、系统对话框或 DevTools 时销毁标签/历史/页面状态                                                                                                           | 改为仅窗口关闭/应用退出 `destroyAll()`；失焦不销毁、不隐藏；增加失焦冒烟测试                                                                                                                  |
| 3   | P2 非法地址会直接抛异常             | **属实**。`localhost:99999`、`example.com:99999`、`999.999.999.999` 等能通过 `LOCAL`/`HOST` 正则，但 `new URL()` 会抛 `TypeError`                                                                                                  | 抽出 `parseHttpUrl()` 统一 `try/catch`；`resolveBrowserAddress` 对这些输入返回 `null`，由地址栏显示非法提示                                                                                   |
| 4   | P2 取消导航仍会被标记为加载失败     | **属实，触发点是 `loadURL().catch`，不是 `did-fail-load`**。Electron 43 实测 `webContents.stop()` 只触发 `did-stop-loading`，`loadURL` 以 `ERR_FAILED (-2)` reject，原代码无条件 `fail()` 显示错误页                               | 移除 `loadURL().catch` 的错误页逻辑；增加 `did-fail-provisional-load` 只清 loading；`did-fail-load` 对 `-3` 只清 loading、不显示错误                                                          |
| 5   | P2 子框架导航会覆盖主页面地址栏     | **属实**。`did-navigate-in-page` 的签名包含 `isMainFrame`，原处理器忽略它，iframe 的 hash/history 变化会更新主地址栏                                                                                                               | 处理器改为 `if (isMainFrame) update({url})`；增加 iframe hash 冒烟测试                                                                                                                        |
| 6   | P2 认证弹窗的 POST 请求会退化为 GET | **属实**。`setWindowOpenHandler` 只把 `url` 交给 `loadURL`，`postBody` 丢失；表单 POST 的新窗口会变成 GET，且 opener 也丢失。Electron 43 实测：`postBody` 存在、`disposition=foreground-tab`，`action:'allow'` 后服务端仍收到 POST | `postBody` 弹窗改为 `action:'allow'` 的受控真实子窗口（同分区、无 preload/Node、禁止再弹窗）；普通 GET 弹窗才进面板标签；POST 冒烟测试；修正 `did-create-window` 回调签名 `(window, details)` |

> 说明：第 6 条修正后，POST 弹窗是**独立子窗口**，不是面板标签；这是为了保留 method/body/opener。GET `window.open` 仍可能因面板标签丢失 opener，属于 v1 已知限制（见 §9、§10）。

## 附录 A：线框

### A.1 右侧面板头部（只有文件标签时）

```text
┌──────────────────────────────────────────────────────────────┐
│ [📁 文件] [+]                                  [⛶] [↻] [»] │
├──────────────────────────────────────────────────────────────┤
│ E:\agent-desktop\YuanTu-Foundry                              │
│ 📁 .claude                                                   │
│ 📁 .github                                                   │
│ 📁 .scratch                                                  │
└──────────────────────────────────────────────────────────────┘
```

### A.2 `+` 菜单

```text
        ┌──────────────────────────────┐
        │ 📁  工作区文件                │
        │     浏览项目中的文件           │
        │ 🌐  浏览器                    │
        │     在面板中打开网页           │
        └──────────────────────────────┘
```

### A.3 浏览器标签（起始页）

```text
┌──────────────────────────────────────────────────────────────┐
│ [📁 文件] [新标签页 ×] [+]                     [⛶] [↻] [»] │
│ ← → ⟳  [ 输入网址或搜索内容................ ]          [↗]  │
├──────────────────────────────────────────────────────────────┤
│                                                              │
│                            🌐                                │
│                        新建标签页                             │
│              在上方输入网址，或输入要搜索的内容                 │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

### A.4 浏览器标签（已加载）

```text
┌──────────────────────────────────────────────────────────────┐
│ [📁 文件] [Example Domain ×] [+]                [⛶] [↻] [»] │
│ ← → ⟳  [ https://example.com/................ ]          [↗]  │
├──────────────────────────────────────────────────────────────┤
│                                                              │
│                     Example Domain                            │
│                                                              │
│              This domain is for use in illustrative ...      │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

### A.5 浏览器错误页

```text
┌──────────────────────────────────────────────────────────────┐
│ ← → ⟳  [ https://bad.invalid/................ ]          [↗]  │
├──────────────────────────────────────────────────────────────┤
│                            ⚠                                 │
│                      无法打开此页面                           │
│                  ERR_NAME_NOT_RESOLVED                        │
│                  https://bad.invalid/                         │
│                                                              │
│                  [ 重试 ]   [ 用系统浏览器打开 ]               │
└──────────────────────────────────────────────────────────────┘
```

## 附录 B：关键常量与约定

| 名称              | 值                                                 | 位置                  |
| ----------------- | -------------------------------------------------- | --------------------- |
| 浏览器分区        | `persist:yuantu-browser`                           | `browser-contract.ts` |
| 最大浏览器标签    | 8                                                  | `browser-contract.ts` |
| 搜索地址          | `https://www.bing.com/search?q=`                   | `browser-url.ts`      |
| 模型宽度下限      | 72                                                 | `ModelPicker.tsx`     |
| 模型宽度上限      | 360                                                | `ModelPicker.tsx`     |
| 宽度附加量        | 40                                                 | `ModelPicker.tsx`     |
| 箭头区宽度        | 24                                                 | `ModelPicker.tsx`     |
| 面板 `+`          | `#workspace-new-tab` / `.workspace-new-tab`        | `WorkspacePanel.tsx`  |
| 浏览器工具条      | `.browser-toolbar`                                 | `BrowserPane.tsx`     |
| 浏览器占位/尺寸源 | `.browser-surface`                                 | `BrowserPane.tsx`     |
| 浮层选择器        | `[role="dialog"], [role="menu"], [role="listbox"]` | `browser-overlays.ts` |

## 附录 C：参考资料

- Electron `WebContentsView`: <https://www.electronjs.org/docs/latest/api/web-contents-view>
- Electron `Web Embeds`（官方对 `WebContentsView` / `webview` / `iframe` 的取舍）: <https://www.electronjs.org/docs/latest/tutorial/web-embeds>
- Electron `<webview>` 警告: <https://www.electronjs.org/docs/latest/api/webview-tag>
- 仓库内相关实现：
  - `apps/desktop/ui/settings/ModelPicker.tsx`
  - `apps/desktop/ui/layout/ProductShell.tsx`
  - `apps/desktop/ui/workspace/WorkspacePanel.tsx`
  - `apps/desktop/ui/workspace/workspace-model.ts`
  - `apps/desktop/main.ts`
  - `apps/desktop/contract.ts`
  - `apps/desktop/preload.ts`

---

**评审建议**：先确认 §10 的 1–4 项（尤其 `+` 菜单是否两项、浏览器标签是否跨工作区保留），以及是否接受 `WebContentsView` 的 Phase 0 验证。确认后可先合入 R1–R3，再进入 R4/R5。
