# 去掉 Office 工具：改用技能与临时脚本

## 背景

`packages/office` 为每种文档操作设计了专用工具（`office_inspect`、`office_create`、`office_edit`、`office_preview`），背后还有 PowerShell 调本机 Office、LibreOffice 转 PDF 的引擎回退。工具的参数结构限定了能写出的文档（标题、段落、列表、表格、每页要点），模型想要的版式只要超出参数结构就做不到；维护成本也集中在这些接口上。

Claude 与 Codex 的做法都是：有合适的技能就加载技能，没有就由模型临时写脚本，用任务需要的库生成文件，最后检查文件再交付。本设计照此调整。

## 范围

**删除**：四个 `office_*` 工具及其引擎（Office 自动化、LibreOffice 预览、结构化创建与模板替换、检查 worker），以及绑定这些工具的内置技能 `office-documents`。

**保留**：用户查看文件的能力——桌面文件面板的只读 Office 预览，和附件的 PPTX 文字提取。它们与生成工具分开维护。

**不变**：通用命令执行、`run_code`、`verify_file_delivery`、`present` 与交付工具。不再为文档操作单独设计工具接口。

## 设计

### 1. 删除生成工具

- `packages/catalog/index.ts` 不再注册 `officeTools`。
- 删除 `packages/office` 下的 `tools.ts`、`automation.ts`、`automation.ps1`、`document.ts`、`presentation.ts`、`replace.ts`、`inspect.ts`、`inspect-runner.ts`、`inspect-worker.ts`、`preview.ts`、`preview-backends.ts`、`limits.ts`、`xml-text.ts`。
- `render.ts` 只留 `officePreviewHtml` 与它用到的 `page`、`documentHtml`、`presentationHtml`；删去 `renderHtml`、`renderPreview` 与 PDF 引擎回退。`OfficeFormat` 类型改在 `render.ts` 本地定义。
- `spreadsheet.ts` 只留 `spreadsheetPreviewHtml` 及其辅助函数，删去 `runSpreadsheetOperation` 的创建、编辑、预览写文件分支。
- 清理工具名引用：`packages/tools/deferred-tools.ts`、`packages/tools/tool-categories.ts`、`packages/core/subagents/contract.ts`（只读子代理白名单里的 `office_inspect`）。
- 构建与打包：`scripts/build-host-bundle.mjs` 不再打包 `office-inspect-worker.js`、不再复制 `automation.ps1`；`scripts/build-desktop.mjs` 不再复制 `automation.ps1`；`scripts/check-windows-package.mjs` 去掉对应检查；`YUANTU_LIBREOFFICE_PATH` 设置项随 LibreOffice 预览一起删除（`packages/protocol/settings.ts`）。
- 工具分类里的 `'office'`（`packages/protocol/tool-contract.ts`）随工具删除；`packages/protocol/environment-blocked.ts` 注释里以 Office 为例的说法改成别的例子。

### 2. 保留的只读能力

`packages/office` 只剩：`render.ts`（`officePreviewHtml`）、`read.ts`（`readPptxSlides`）、`spreadsheet.ts`（`spreadsheetPreviewHtml`）、`preview-page.ts`、`zip-entry.ts`。调用方 `apps/agent-host/handlers/files.ts` 与 `apps/desktop/attachment-reader.ts` 行为不变。目录名暂不改。

### 3. 应用自带文档库

临时脚本需要的库随应用附带，离线可用，类似 Claude 沙箱里预装的库：

- 库：`docx`（Word）、`pptxgenjs`（PowerPoint）、`xlsx`（Excel，沿用 `vendor/xlsx-0.20.3.tgz`）、`jszip`（读回检查）。
- 打包：新脚本 `scripts/prepare-document-libs.mjs` 把这四个库及其运行时依赖装到 `.scratch/packaging/document-libs/node_modules`，`electron-builder.config.cjs` 以 extraResources 放到 `resources/document-libs/node_modules`。预览与附件读取继续内联 `mammoth`、`jszip`、`xlsx`，与这套库互不影响。
- 定位：新模块 `packages/resources/document-libs.ts` 导出 `documentLibsDirectory()`。打包版本取 `process.resourcesPath/document-libs/node_modules`；开发态与 CLI 取仓库根的 `node_modules`。都找不到时返回 `undefined`。
- 传给脚本的方式：工具子进程的环境变量走白名单（`packages/platform/child-environment.ts`），macOS Seatbelt 还会删除 `NODE_PATH`，所以不用环境变量。展开内置文档技能时，把技能正文里的 `{{DOCUMENT_LIBS}}` 替换成库目录的绝对路径，脚本用
  ```js
  const need = require('node:module').createRequire('{{DOCUMENT_LIBS}}/');
  ```
  加载库。库目录不存在时，正文改为说明"本构建没有附带文档库"，让模型告诉用户，或在用户同意后另行安装。
- 沙箱读取：实现时验证 Windows 受限令牌与 macOS Seatbelt 都允许子进程读取安装目录下的 `resources/document-libs`；不允许就在两边各加一条只读规则，并补沙箱回归测试。

### 4. 内置技能

- 删除 `office-documents` 及其 i18n 描述（`apps/desktop/i18n-conversation.ts`、`apps/desktop/ui/composer/command-model.ts`）。
- 新增三个内置技能 `docx`、`pptx`、`xlsx`，正文自写（Anthropic 的同名技能不允许再分发，只参照思路）。每个技能包含：
  1. 何时使用、用哪个库、库的加载方式；
  2. 一段可直接运行的最小示例脚本（脚本写在临时目录，用 `run_command` 以 Node 执行，输出到工作区）；
  3. 写作与排版要点（沿用旧 `office-documents` 里仍然成立的部分，例如 PPT 每页要点数量、Excel 公式写法）；
  4. 收尾：用 jszip / SheetJS 读回文件核对内容，再用 `verify_file_delivery` 与 `present` 交付；脚本本身不留在工作区。
- 工作区 `.agents/skills`、`.yuantu/skills` 下的同名技能照现有规则替换内置的，用户自带的技能优先。
- `code-analysis-report` 第 4 步改为"按 docx 技能写脚本生成 Word 报告"。
- `packages/core/prompt/notices.ts` 的提示改为"Word、Excel、PowerPoint 文件按 docx / xlsx / pptx 技能处理"。

### 5. 文档

README 删去 `office_*` 工具表、`YUANTU_LIBREOFFICE_PATH` 与 Office PDF 预览的说明，改写 `packages/office` 的职责描述、内置技能列表，补一段"文档生成靠技能与自带库"的说明。`npm run docs:check` 维护的事实同步更新。

## 测试

- 删除 `tests/office.test.ts`、`tests/office-native.test.ts`、`tests/office-preview.test.ts`；从中把只读预览与 `readPptxSlides` 的用例挪到新的 `tests/office-preview-readonly.test.ts`。
- `tests/malformed-input.test.ts`、`tests/files.test.ts` 中依赖创建工具的用例，改用直接调用 `docx` / `pptxgenjs` 生成夹具。
- 新增 `tests/document-libs.test.ts`：按三个技能里的示例脚本，用 `documentLibsDirectory()` 生成 docx/pptx/xlsx，再用预览函数与 `readPptxSlides` 读回，确认技能示例真的能跑。
- 更新引用工具名或技能名的测试与快照：`tests/resources.test.ts`、`tests/client.test.ts`、`tests/context-envelope.test.ts`、`tests/tool-concurrency-mode.test.ts`、`tests/desktop-react-composer.test.ts`、`tests/desktop-capabilities.smoke.mjs`、`tests/swe-bench.test.ts`、`tests/snapshots/*.json`。
- 分阶段只跑定向测试，全部改完再跑 `npm test`、`npm run typecheck`、`npm run lint`、`npm run layers:check`、`npm run docs:check`。

## 不做

- 不改桌面预览的渲染效果。
- 不内置 Python 或 LibreOffice；需要 PDF 时由模型按技能说明尝试本机已有的工具，没有就告诉用户。
- 不改 `packages/office` 目录名。
