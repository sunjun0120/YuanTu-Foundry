# Office P0：DOCX/PPTX 创建改为纯 JS

## 目标

`office_create` 生成 Word 与 PowerPoint 不再依赖本机 Microsoft Office、PowerShell 或 COM；Windows、macOS 上行为一致，桌面普通用户无需安装任何程序。

## 范围

| 做                                                                 | 不做（后续阶段）                         |
| ------------------------------------------------------------------ | ---------------------------------------- |
| DOCX 创建：`docx` 库生成                                           | DOCX/PPTX 模板编辑（P1，仍走 COM）       |
| PPTX 创建：`pptxgenjs` 库生成                                      | DOCX/PPTX PDF 预览（P2，仍走 Office/LO） |
| 输入扩展：DOCX `blocks`（标题、段落、列表、表格、分页）            | 图片、行内粗斜体、主题模板               |
| 输入扩展：PPTX 每页可选 `table`、`notes`，`body` 可省略            | 能力探测与动态工具描述（P3）             |
| 旧参数（`title`、`paragraphs`、`slides[].title/body`）保持原有含义 |                                          |

## 设计

- 新增 `packages/office/document.ts`：`createDocx(op)`，把 `title`、`paragraphs`、`blocks` 依次转成 `docx` 的段落与表格，`Packer.toBuffer` 写出。
- 新增 `packages/office/presentation.ts`：`createPptx(op)`，每页标题 + 要点 / 表格 + 备注，16:9 版式，`write({ outputType: 'nodebuffer' })` 写出。
- `runOfficeAutomation` 分派：`create` 的 DOCX/PPTX 走上面两个函数；`edit`、`preview` 仍走 `automation.ps1`。`automation.ps1` 删除已无调用方的 create 分支。
- `office_create` 的 schema 增加 `blocks` 与 slide 的 `table`、`notes`；描述改为「无需 Microsoft Office」。暂存、`verifyFileDelivery`、写后 `inspect`、原子 `link` 管线不变，所以生成结果仍要能被 mammoth 与 `readPptxSlides` 读回。
- 上限：`blocks` ≤ 400，表格 ≤ 200 行 × 20 列，单元格 ≤ 2,000 字符；与现有 20 MB 输出上限叠加。

## 测试

- `tests/office.test.ts`：新增跨平台用例，经 `office_create` 生成 DOCX（各类 block）与 PPTX（要点、表格、备注），用 mammoth / `readPptxSlides` 读回断言；旧参数形状继续可用；超限被 schema 拒绝。
- `tests/office-native.test.ts`：保留，只覆盖 COM 的编辑与预览；它的输入文件改由 JS 生成，顺带验证 Office 能打开 JS 生成的文件。

## 风险

- `readPptxSlides` 只读 `<a:t>`；pptxgenjs 的表格单元格同样写成 `<a:t>`，用例会钉住这一点。
- 两个库随 `dependencies` 发布，桌面主进程由 esbuild 打包，Host 由 `tsc` 产物加 `node_modules` 运行，两条路径都要通过构建。

---

# 后续阶段（P3 → P1 → P2 → P4，已实现）

P0 之后按同一目标继续：除 PDF 预览外，Office 工具不再依赖任何本机程序。

## P1：DOCX/PPTX 模板编辑改为纯 JS（`packages/office/replace.ts`）

- 只改写含文本的部件：Word 的正文、页眉、页脚、脚注、尾注；PPT 的各张幻灯片（与原 COM 路径一致，不改备注）。
- 按段落（`w:p` / `a:p`，用栈处理文本框里的嵌套段落）把文本节点拼成一个字符串再匹配，所以被拼写检查、格式或修订拆开的同一句话也能命中；替换文字写进匹配起点所在的节点并沿用它的格式，溢出到后续节点的部分被删去。不跨段落匹配。
- 每个 `from` 替换全部出现；任一项一处都没命中则整次失败、不写文件。COM 的 255 字符与 `^` 限制随之消失。
- 其余部件原样保留，读取前有与 inspect 相同的解压上限。

## P2：内置 HTML 预览（`packages/office/render.ts`）

- `.html` 输出：Word 用 mammoth 转 HTML（标题、列表、表格、内嵌图片），PPT 按页列出文字，Excel 沿用原数据预览。页面带 `default-src 'none'` 的 CSP，链接只保留文字。

## P3：引擎选择与回退

- 不做按机器动态生成的工具描述：描述会进入提示词缓存键和 README 生成事实，随机器变化会让两者都不稳定。改为在执行时选择引擎。
- `backend` 默认 `auto`：按输出扩展名，`.html` 走内置预览；`.pdf` 对 Word/PPT 先试 Office，只有在 Office 不可用（未安装、脚本被拒、PowerShell 起不来）时才回退 LibreOffice；转换真的失败则原样报错，不换引擎掩盖坏文档。两者都缺时报错并提示改用 `.html`。LibreOffice 缺失也改为可识别的 `OfficeUnavailableError`。
- `automation.ps1` 只剩 PDF 转换。
- 未做：桌面界面上的「安装 LibreOffice 可获得 PDF」提示。

## P4：内置技能 `office-documents`（`packages/resources/builtin-skills.ts`）

- 技能正文编进代码而不是随包的文件，避免三个产物（桌面主进程、Host、CLI）各自复制和查找资源。
- `discoverSkills` 在工作区技能之后补上内置技能；同名的工作区技能替换它；不计入工作区 64 个的上限。
- 影响：每个会话都会有 `load_skill` 工具和一条技能目录公告（turn snapshot 已更新，首个请求约多 240 个输入 token）。
