# 去掉 Office 工具 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 删除四个 `office_*` 工具与 `office-documents` 技能，改为内置 `docx` / `pptx` / `xlsx` 技能 + 应用自带的文档库，由模型临时写 Node 脚本生成文件；保留只读预览与附件读取。

**Architecture:** 新模块 `packages/platform/document-libs.ts` 找到自带库目录；打包脚本把 `docx`、`pptxgenjs`、`xlsx`、`jszip` 及依赖放到 `resources/document-libs/node_modules`；内置技能正文里的 `{{NODE}}`、`{{DOCUMENT_LIBS}}` 在展开时替换为绝对路径，脚本用 `createRequire` 加载库。`packages/office` 只剩只读预览。

**Tech Stack:** TypeScript（Node 24 直接跑 `.ts`）、`node:test`、esbuild、electron-builder、docx 9 / pptxgenjs 4 / SheetJS 0.20.3 / jszip 3。

**Spec:** `docs/superpowers/specs/2026-10-31-remove-office-tools-design.md`

## 本轮执行范围（2026-10-31 调整）

本轮只执行 **Task 5**、**Task 4 中删除 `office-documents` 的部分**和 **Task 6**；Task 1–3 与新增内置技能留作后续独立任务。与下文的差异：

- Task 4：只删 `OFFICE_DOCUMENTS`、i18n 键 `skill.officeDocumentsDescription` 与 `command-model.ts` 的映射，改 `CODE_ANALYSIS_REPORT` 第 4 步为"有 Word 相关技能就按技能写，否则临时写脚本生成 Word 报告"。`notices.ts` 那句改为：`For Word, Excel and PowerPoint files, load a matching skill when one is offered; otherwise write a temporary script with the libraries the task needs, and check the file before delivering it.` 测试里引用 `office-documents` 的断言改为断言它不存在，或改用 `code-analysis-report`。
- Task 5 照写执行（含 `clean-paused-builds.mjs`、安装包反向检查、PPT 夹具的类型适配）。
- 依赖审计：`docx`、`pptxgenjs` 只剩测试使用，从 `check-audit.mjs` 的 `SHIPPED_DEV` 删除，两条 `image-size` 豁免一并删除，跑 `npm run audit:check`。`check-windows-package.mjs` 的 "bundled dependency" 循环保留。
- Task 6 的 README 只写本轮的事实：不提自带库与 `docx`/`pptx`/`xlsx` 内置技能，"文档生成"一段改为通用规则。

## Global Constraints

- 分阶段只跑定向测试：`node scripts/run-tests.mjs <文件>`；全量 `npm test` 只在最后一个任务跑。
- 在 Windows 上用 Python/heredoc 改文件会写成 CRLF——一律用编辑工具改文件。
- README 自成一体：不链接 `docs/`，不引用 git 分支。
- 层次规则（`scripts/check-layers.mjs`）：`platform` 在第 2 层，`sandbox` 在第 3 层，`office`、`resources` 在第 6 层；低层不得导入高层。
- 注释密度、命名、写法照周围代码；新增用户可见文案要有中英两份（`apps/desktop/i18n-conversation.ts`）。
- 不复制 Anthropic 技能原文；技能正文自己写。
- 每个任务结束提交一次，提交信息结尾加 `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`。

---

### Task 1: 文档库定位模块

**Files:**

- Create: `packages/platform/document-libs.ts`
- Test: `tests/document-libs.test.ts`

**Interfaces:**

- Produces:
  - `export const DOCUMENT_LIBS: readonly ['docx', 'pptxgenjs', 'xlsx', 'jszip']`
  - `export function documentLibsCandidates(application?: string, resources?: string | null): string[]`
  - `export function documentLibsDirectory(candidates?: readonly string[]): string | undefined` —— 返回第一个四个库都在的 `node_modules` 目录，找不到返回 `undefined`。

- [ ] **Step 1: 写失败的测试**

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  DOCUMENT_LIBS,
  documentLibsCandidates,
  documentLibsDirectory,
} from '../packages/platform/document-libs.ts';
import { tempRoot } from './temp-fixture.ts';

test('document libraries are looked for in resources first, then beside the build', () => {
  const packaged = path.join('R', 'resources', 'app', 'dist');
  assert.deepEqual(documentLibsCandidates(packaged, path.join('R', 'resources')), [
    path.join('R', 'resources', 'document-libs', 'node_modules'),
    path.join('R', 'resources', 'document-libs', 'node_modules'),
    path.join('R', 'resources', 'app', 'node_modules'),
  ]);
  assert.deepEqual(documentLibsCandidates(path.join('repo'), null), [
    path.join('repo', 'node_modules'),
  ]);
});

test('a directory counts only when every document library is in it', async (t) => {
  const root = await tempRoot(t, 'yuantu-doclibs-');
  const partial = path.join(root, 'partial');
  const full = path.join(root, 'full');
  for (const name of DOCUMENT_LIBS) {
    await mkdir(path.join(full, name), { recursive: true });
    await writeFile(path.join(full, name, 'package.json'), '{}');
  }
  await mkdir(path.join(partial, 'docx'), { recursive: true });
  await writeFile(path.join(partial, 'docx', 'package.json'), '{}');
  assert.equal(documentLibsDirectory([partial, full]), full);
  assert.equal(documentLibsDirectory([partial]), undefined);
});

test('the checkout itself provides the document libraries', () => {
  assert.ok(
    documentLibsDirectory(),
    'repository node_modules should hold docx, pptxgenjs, xlsx, jszip',
  );
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node scripts/run-tests.mjs tests/document-libs.test.ts`
Expected: FAIL，找不到模块 `document-libs.ts`。

- [ ] **Step 3: 实现**

```ts
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The libraries the built-in document skills tell a script to load, shipped with the application.
 *
 * A script the model writes runs as an ordinary command, outside every bundle, so the copies the bundles inline
 * are out of its reach. The packaged application carries these under `resources/document-libs`; a checkout or a
 * CLI install has them in its own `node_modules` (they are devDependencies).
 */
export const DOCUMENT_LIBS = ['docx', 'pptxgenjs', 'xlsx', 'jszip'] as const;

/** `process.resourcesPath` in a packaged desktop process, otherwise `null`. */
function resourcesRoot(): string | null {
  const resources = (process as unknown as { resourcesPath?: unknown }).resourcesPath;
  return typeof resources === 'string' && resources ? resources : null;
}

/**
 * The directory above `packages/` (a checkout) or the `dist/` that holds the compiled code.
 *
 * The same rule `sandbox-seatbelt.ts` uses, and for the same reason: the desktop main process is a CommonJS
 * bundle in `dist/desktop`, the Host an ESM bundle in `dist/packages/tools`.
 */
function applicationRoot(): string {
  return typeof __dirname === 'string'
    ? path.resolve(__dirname, '..')
    : fileURLToPath(new URL('../../', import.meta.url));
}

/** Every place the libraries may live, most specific first. */
export function documentLibsCandidates(
  application = applicationRoot(),
  resources = resourcesRoot(),
): string[] {
  const candidates: string[] = [];
  if (resources) candidates.push(path.join(resources, 'document-libs', 'node_modules'));
  if (path.basename(application.replace(/[\\/]$/, '')) === 'dist') {
    // The Host runs on the bundled Node, which has no `resourcesPath`: `resources/app/dist` is two levels below.
    candidates.push(path.join(application, '..', '..', 'document-libs', 'node_modules'));
    candidates.push(path.join(application, '..', 'node_modules'));
  } else candidates.push(path.join(application, 'node_modules'));
  return candidates.map((candidate) => path.normalize(candidate));
}

/** The first candidate that holds every library, or `undefined` when this build ships none. */
export function documentLibsDirectory(
  candidates: readonly string[] = documentLibsCandidates(),
): string | undefined {
  return candidates.find((directory) =>
    DOCUMENT_LIBS.every((name) => existsSync(path.join(directory, name, 'package.json'))),
  );
}
```

注意：第一个测试里 `packaged` 路径用的是相对路径 `R/...`，`path.normalize` 之后与期望一致；如果 `path.join(application, '..', '..')` 归一化后的结果与期望不同，以实现为准修改期望，但三个候选的顺序不能变。

- [ ] **Step 4: 跑测试确认通过**

Run: `node scripts/run-tests.mjs tests/document-libs.test.ts`
Expected: PASS（3 个用例）。再跑 `npm run layers:check`，预期通过。

- [ ] **Step 5: 提交**

```bash
git add packages/platform/document-libs.ts tests/document-libs.test.ts
git commit -m "feat(platform): locate the shipped document libraries"
```

---

### Task 2: 打包时附带文档库

**Files:**

- Create: `scripts/prepare-document-libs.mjs`
- Modify: `electron-builder.config.cjs`（`extraResources`，以及 `files` 里那段"Office libraries need no entry here"的注释）
- Modify: `package.json`（所有 `package:windows*`、`package:macos*` 脚本）
- Modify: `scripts/check-windows-package.mjs`（新增文档库检查）
- Test: `tests/document-libs.test.ts`（追加）

**Interfaces:**

- Consumes: Task 1 的 `DOCUMENT_LIBS`（脚本是 `.mjs`，不能导入 `.ts`，在脚本里重复这份名单，并在测试里断言两份一致）。
- Produces: `export async function stageDocumentLibs(from: string, to: string, roots?: readonly string[]): Promise<string[]>` —— 把 `roots` 及其 `dependencies` 闭包从 `from`（一个 `node_modules`）复制到 `to`，跳过 `@types/*`、`*.map`、`*.d.ts`/`*.d.cts`/`*.d.mts`；返回复制的包名（已排序）。产物目录 `.scratch/packaging/document-libs/node_modules`。

- [ ] **Step 1: 写失败的测试（追加到 `tests/document-libs.test.ts`）**

```ts
import { readdir, readFile } from 'node:fs/promises';
import { stageDocumentLibs, DOCUMENT_LIBS as STAGED } from '../scripts/prepare-document-libs.mjs';

test('staging copies the libraries and their runtime dependencies, without types or source maps', async (t) => {
  const root = await tempRoot(t, 'yuantu-doclibs-stage-');
  const from = path.join(root, 'node_modules');
  const pkg = async (name: string, dependencies: Record<string, string> = {}) => {
    await mkdir(path.join(from, name), { recursive: true });
    await writeFile(path.join(from, name, 'package.json'), JSON.stringify({ name, dependencies }));
    await writeFile(path.join(from, name, 'index.js'), 'module.exports = 1;');
    await writeFile(path.join(from, name, 'index.js.map'), '{}');
    await writeFile(path.join(from, name, 'index.d.ts'), '');
  };
  await pkg('a', { b: '1', '@types/node': '1' });
  await pkg('b');
  await pkg('unrelated');
  const to = path.join(root, 'out');
  assert.deepEqual(await stageDocumentLibs(from, to, ['a']), ['a', 'b']);
  assert.deepEqual((await readdir(path.join(to, 'a'))).sort(), ['index.js', 'package.json']);
  await assert.rejects(readFile(path.join(to, 'unrelated', 'package.json')), { code: 'ENOENT' });
});

test('the staging script and the runtime agree on the library list', () => {
  assert.deepEqual([...STAGED], [...DOCUMENT_LIBS]);
});

test('staging the real libraries yields a directory the runtime accepts', async (t) => {
  const root = await tempRoot(t, 'yuantu-doclibs-real-');
  const to = path.join(root, 'node_modules');
  await stageDocumentLibs(path.resolve('node_modules'), to);
  assert.equal(documentLibsDirectory([to]), to);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node scripts/run-tests.mjs tests/document-libs.test.ts`
Expected: FAIL，找不到 `scripts/prepare-document-libs.mjs`。

- [ ] **Step 3: 实现脚本**

```js
/**
 * Stages the libraries the built-in document skills load into `.scratch/packaging/document-libs/node_modules`.
 *
 * electron-builder copies that directory to `resources/document-libs` (`electron-builder.config.cjs`). The
 * packages come from this checkout's own `node_modules`, so the shipped versions are the locked ones and staging
 * needs no network. Type declarations and source maps are left out; nothing at runtime reads them.
 */
import { cp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/** Kept equal to `DOCUMENT_LIBS` in `packages/platform/document-libs.ts` (a test checks). */
export const DOCUMENT_LIBS = ['docx', 'pptxgenjs', 'xlsx', 'jszip'];
const SKIPPED = /\.(map|d\.ts|d\.cts|d\.mts)$/;

export async function stageDocumentLibs(from, to, roots = DOCUMENT_LIBS) {
  await rm(to, { recursive: true, force: true });
  const staged = new Set();
  const pending = [...roots];
  while (pending.length) {
    const name = pending.pop();
    if (staged.has(name) || name.startsWith('@types/')) continue;
    staged.add(name);
    const source = path.join(from, name);
    const manifest = JSON.parse(await readFile(path.join(source, 'package.json'), 'utf8'));
    await cp(source, path.join(to, name), {
      recursive: true,
      filter: (file) => !SKIPPED.test(file),
    });
    pending.push(...Object.keys(manifest.dependencies ?? {}));
  }
  return [...staged].sort();
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const target = path.resolve('.scratch/packaging/document-libs/node_modules');
  const names = await stageDocumentLibs(path.resolve('node_modules'), target);
  console.log(`Staged ${names.length} document library packages in ${target}`);
}
```

如果真实依赖里有包不在顶层 `node_modules`（版本冲突导致嵌套安装），第三个测试会报 `ENOENT`。这种情况就在 `stageDocumentLibs` 里先找 `path.join(from, parent, 'node_modules', name)`（`parent` 是声明这个依赖的包），找不到再找顶层；同时补一个嵌套用例。

- [ ] **Step 4: 接入打包**

`electron-builder.config.cjs` 的 `extraResources` 末尾加：

```js
    /**
     * The libraries the built-in docx / pptx / xlsx skills load from a script the model writes, staged by
     * `scripts/prepare-document-libs.mjs`. A script runs outside every bundle, so the copies the bundles inline
     * are out of its reach; `packages/platform/document-libs.ts` finds this directory.
     */
    { from: '.scratch/packaging/document-libs', to: 'document-libs' },
```

`files` 里那段注释的最后两句改为：

```js
     * The Office libraries need no entry here: the Host and the attachment worker inline what the read-only
     * previews use, and the document skills' copies ship as `extraResources` (below).
```

`package.json`：每个 `package:windows*`、`package:macos*` 脚本里，在 `node scripts/copy-search-assets.mjs ...`（含它的参数）之后插入 ` && node scripts/prepare-document-libs.mjs`。改完用下面命令确认 9 个脚本都带上了：

```bash
node -e "const s=require('./package.json').scripts;for(const[k,v]of Object.entries(s))if(/^package:(windows|macos)/.test(k))console.log(v.includes('prepare-document-libs')?'ok ':'MISSING ',k)"
```

（`package:windows:candidate:dir` 也要有；只要 9 行全是 `ok` 即可。）

`scripts/check-windows-package.mjs`：在检查 `pdfjs-dist` 的循环之后加：

```js
// The document skills load these from a script; a package without them has skills that cannot run.
for (const name of ['docx', 'pptxgenjs', 'xlsx', 'jszip'])
  await readFile(path.join(resources, 'document-libs/node_modules', name, 'package.json'));
```

- [ ] **Step 5: 重新评估依赖审计豁免**

`scripts/check-audit.mjs` 第 25-40 行有两条 `image-size`（经由 pptxgenjs 引入）的豁免，理由是"PPTX 输出不嵌入图片"。改成模型直接用完整的 pptxgenjs 写脚本以后，`addImage` 也能用，这条理由就不成立了，不能照抄。

先查清 `image-size` 到底会不会被执行：

```bash
grep -rln "image-size" node_modules/pptxgenjs/dist/
```

计划编写时查过：pptxgenjs 4.0.1 的 `dist/` 里没有任何文件引用 `image-size`。Node 下量图片尺寸走的是 `require('sizeof')`（`dist/pptxgen.cjs.js` 约 5020 行），而 `sizeof` 并没有安装，加载失败会被捕获。也就是说 `image-size` 只是声明了依赖，实际从不加载。按查到的结果分两种情况：

- **仍然没有引用**（预期情况）：
  - 把两条豁免的 `reason` 改成：`'image-size via pptxgenjs: declared but never loaded; no file in pptxgenjs/dist requires it (guarded by tests/document-libs.test.ts)'`，`reviewBy` 不变。
  - 在 `tests/document-libs.test.ts` 加一个守护用例。pptxgenjs 哪天升级后开始加载 `image-size`，这个用例就会失败，逼人重新评估：

    ```ts
    test('pptxgenjs never loads image-size, which the audit exemption relies on', async () => {
      const dist = path.resolve('node_modules/pptxgenjs/dist');
      for (const name of await readdir(dist))
        if (name.endsWith('.js'))
          assert.doesNotMatch(await readFile(path.join(dist, name), 'utf8'), /image-size/, name);
    });
    ```

  - `stageDocumentLibs` 的名单不变（`image-size` 仍会被复制，它在 `dependencies` 里）。
- **有引用**：停下，向用户报告。可选的做法有两种：用 npm `overrides` 把 `image-size` 升到已修复的 2.x，并验证 pptxgenjs 的图片功能还能用；或者在 pptx 技能里禁止 `addImage`。不要自己挑。

同时更新 `check-audit.mjs` 顶部那段注释：现在 `docx` 和 `pptxgenjs` 的发布方式不再是"被 Host 内联"，而是"作为 `resources/document-libs` 整树发布"。在 `SHIPPED_DEV` 上方补一句：`docx` 与 `pptxgenjs` 在 Task 5 之后不再被 `apps/`、`packages/` 导入，但仍按 `tree` 留在清单里，因为它们整树打包进了 `document-libs`。

Run: `npm run audit:check`
Expected: 通过，并且没有 "stale exemption" 提示。

- [ ] **Step 6: 跑测试确认通过**

Run: `node scripts/run-tests.mjs tests/document-libs.test.ts`
Expected: PASS（7 个用例）。
Run: `node scripts/prepare-document-libs.mjs`
Expected: 打印 `Staged N document library packages`，N 在 10 到 20 之间。

- [ ] **Step 7: 提交**

```bash
git add scripts/prepare-document-libs.mjs electron-builder.config.cjs package.json scripts/check-windows-package.mjs scripts/check-audit.mjs tests/document-libs.test.ts
git commit -m "build: ship the document libraries as a resource"
```

---

### Task 3: 沙箱能读到文档库（卡口任务）

这个任务决定方案是否成立。Windows 原生沙箱用独立账户执行命令，`tests/windows-sandbox-host.test.ts` 已经证明：只有当前用户能读的目录，沙箱账户读不到。打包后的应用在 `%LOCALAPPDATA%\Programs\…`，很可能属于这种目录。**如果 Step 4 的探针失败，停下来，把结果和下面的备选方案报告给用户，由用户选择，不要自己挑。**

真实账户测试只在专门的 GitHub Actions 临时机器上执行：`accountAcceptanceSkip()`（`scripts/windows-account-ci.mjs`）要求 `GITHUB_ACTIONS=true`、`RUNNER_ENVIRONMENT=github-hosted`、`FOUNDRY_TEST_WINDOWS_ACCOUNT_JOURNEYS=1`，本机运行一律跳过。所以**本机跑通不算验收**，验收以 `.github/workflows/windows-account-sandbox.yml` 的结果为准。`scripts/check-windows-sandbox.mjs` 只跑 `WINDOWS_ACCOUNT_JOURNEY_FILES` 里的文件，并用 `assertAcceptanceOutput` 要求零跳过，所以新测试必须登记在这份清单里。

**Files:**

- Modify: `packages/sandbox/sandbox-seatbelt.ts:197-212`（`policyInput` 的 `runtimeDirectories`）
- Create: `tests/windows-sandbox-document-libs.test.ts`
- Modify: `scripts/windows-sandbox-suites.mjs`（登记新测试）
- Modify: `.github/workflows/windows-account-sandbox.yml`（`push` 和 `pull_request` 的 `paths` 各加 `packages/platform/document-libs.ts`、`scripts/prepare-document-libs.mjs`）
- Test: `tests/sandbox-seatbelt.test.ts`（只跑，不改）；`tests/test-workflow.test.ts`（如果它固定了清单或路径过滤，跟着改）

**Interfaces:**

- Consumes: Task 1 的 `documentLibsDirectory()`；Task 2 的 `stageDocumentLibs()`。

- [ ] **Step 1: macOS 加只读授权**

在 `sandbox-seatbelt.ts` 顶部导入 `import { documentLibsDirectory } from '../platform/document-libs.ts';`，在 `runtimeDirectories` 数组末尾加：

```ts
    // The document skills' scripts `require` these by absolute path (`../platform/document-libs.ts`).
    ...[documentLibsDirectory()].filter((directory): directory is string => !!directory),
```

后面的 `realpath` 循环会把它变成一条 `file-read*` 子树授权，和 `node_modules` 一样。

Run: `node scripts/run-tests.mjs tests/sandbox-seatbelt.test.ts`
Expected: PASS（非 macOS 上相关用例会带原因跳过）。

- [ ] **Step 2: 写 Windows 真实账户探针**

把 `tests/windows-sandbox-host.test.ts` 的结构照抄一份，改成下面的探针。文件头保留 `// @test-serial windows-sandbox: ...`，同样用 `useAccountTests()` 和 `windowsAccountTests`：

```ts
// @test-serial windows-sandbox: Runs a document-library script through the real sandbox account.
import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { startHost, connectClient } from './host-process-fixture.ts';
import { httpFixture, frames, sendFrames } from './http-fixture.ts';
import { permissionPolicyForMode } from '../apps/desktop/permission-settings.ts';
import { quoteWindowsArgument } from '../packages/sandbox/windows-command.ts';
import { stageDocumentLibs } from '../scripts/prepare-document-libs.mjs';
import { useAccountTests, windowsAccountTests } from './windows-account-fixture.ts';

useAccountTests();

test(
  'a sandboxed script can run the bundled Node and load the document libraries from the install location',
  windowsAccountTests,
  async (t) => {
    // Where an installed application lives: under the user's own profile, with its inherited ACL.
    const install = await mkdtemp(path.join(process.env.LOCALAPPDATA!, 'yuantu-doclibs-probe-'));
    t.after(() => rm(install, { recursive: true, force: true }));
    const libs = path.join(install, 'document-libs', 'node_modules');
    await stageDocumentLibs(path.resolve('node_modules'), libs);
    const node = path.join(install, 'runtime', 'node.exe');
    await mkdir(path.dirname(node), { recursive: true });
    await copyFile(process.execPath, node);

    let command = '';
    const receipts: unknown[] = [];
    const url = await httpFixture(t, (body, response, _headers, requestPath) => {
      if (requestPath.endsWith('/models')) return void response.end('{"data":[]}');
      const last = body.messages.at(-1);
      const hasResult =
        Array.isArray(last?.content) &&
        last.content.some((b: { type: string }) => b.type === 'tool_result');
      if (hasResult) receipts.push(last.content);
      sendFrames(
        response,
        hasResult
          ? frames('done')
          : frames('', [
              { id: 'doclibs', name: 'run_command', input: { command, timeout_ms: 60000 } },
            ]),
      );
    });
    const host = await startHost(t, { YUANTU_SANDBOX: 'native', YUANTU_BASE_URL: url });
    const script = path.join(host.root, 'make.cjs');
    // All three formats, each through the library the matching skill uses, and each read back with jszip.
    await writeFile(
      script,
      `const need=require('node:module').createRequire(${JSON.stringify(libs + path.sep)});
const fs=require('node:fs');
const {Document,Packer,Paragraph}=need('docx');const PptxGenJS=need('pptxgenjs');const XLSX=need('xlsx');const JSZip=need('jszip');
(async()=>{
  fs.writeFileSync('probe.docx',await Packer.toBuffer(new Document({sections:[{children:[new Paragraph('probe-docx')]}]})));
  const deck=new PptxGenJS();deck.addSlide().addText('probe-pptx',{x:1,y:1,w:6,h:1});await deck.writeFile({fileName:'probe.pptx'});
  const book=XLSX.utils.book_new();XLSX.utils.book_append_sheet(book,XLSX.utils.aoa_to_sheet([['probe-xlsx']]),'S');XLSX.writeFile(book,'probe.xlsx');
  const text=async(file,part)=>(await (await JSZip.loadAsync(fs.readFileSync(file))).file(part).async('string'));
  const result={
    docx:(await text('probe.docx','word/document.xml')).includes('probe-docx'),
    pptx:(await text('probe.pptx','ppt/slides/slide1.xml')).includes('probe-pptx'),
    xlsx:XLSX.readFile('probe.xlsx').Sheets.S.A1.v==='probe-xlsx',
  };
  fs.writeFileSync('probe-result.json',JSON.stringify(result));
})();`,
    );
    command = `${quoteWindowsArgument(node)} ${quoteWindowsArgument(script)}`;
    const { client } = await connectClient(host);
    let sessionId: string | undefined;
    try {
      await client.start();
      sessionId = (await client.request('session.create', {})).id;
      await client.request('permission.update', {
        sessionId,
        policy: permissionPolicyForMode('full-access'),
      });
      await client.request('sandbox.set', {
        sessionId,
        mode: 'native',
        files: 'workspace-write',
        network: 'denied',
      });
      await client.run(sessionId, 'make the probe document');
      const evidence = JSON.parse(
        await readFile(path.join(host.root, 'probe-result.json'), 'utf8'),
      );
      assert.deepEqual(evidence, { docx: true, pptx: true, xlsx: true }, JSON.stringify(receipts));
    } finally {
      if (sessionId) await client.request('run.cancel', { sessionId }).catch(() => {});
      await client.stop();
    }
  },
);
```

如果 `client.run` 的签名要求 `completion` 参数（看 `windows-sandbox-host.test.ts` 第 109 行的写法），就照那里补一个 `file-contains` 检查：`probe-result.json` 含 `"xlsx":true`。

- [ ] **Step 3: 登记到真实账户验收清单，本机确认只是跳过**

`scripts/windows-sandbox-suites.mjs` 的 `WINDOWS_ACCOUNT_JOURNEY_FILES` 按字母序加入 `'tests/windows-sandbox-document-libs.test.ts'`（放在 `'tests/windows-sandbox-host.test.ts'` 前面）。`.github/workflows/windows-account-sandbox.yml` 的两处 `paths` 加上 Files 里列的两条。新测试文件名已经能匹配现有的 `tests/windows-sandbox-*` 过滤，不用再加。

Run: `node scripts/run-tests.mjs tests/windows-sandbox-document-libs.test.ts tests/test-workflow.test.ts`
Expected: 探针显示 **skip**，原因是 "real account journeys require an explicitly enabled disposable GitHub Actions runner"；`test-workflow` PASS。本机这里出现 skip 是正常的，**不代表验收通过**。

提交：

```bash
git add packages/sandbox/sandbox-seatbelt.ts tests/windows-sandbox-document-libs.test.ts scripts/windows-sandbox-suites.mjs .github/workflows/windows-account-sandbox.yml
git commit -m "test(sandbox): probe document generation through the real sandbox account"
```

- [ ] **Step 4: 在 CI 上真实运行探针（卡口）**

推分支会触发外部 CI，**先问用户**：是否把当前分支推到远端，用来触发 `Windows sandbox accounts` 工作流。用户同意后：

```bash
git push -u origin HEAD
```

```bash
gh run list --workflow "Windows sandbox accounts" --branch "$(git branch --show-current)" --limit 1
```

```bash
gh run watch <run-id> --exit-status
```

在日志里确认 `tests/windows-sandbox-document-libs.test.ts` 是**实际执行并通过**的（`check-windows-sandbox.mjs` 的零跳过断言会让任何 skip 都判失败）。两种结果：

- 通过：沙箱账户能执行 `runtime/node.exe`、能读 `document-libs`，三种格式都能生成并读回。继续 Task 4。
- 失败，日志里有 `EACCES`/`EPERM`/"拒绝访问"：**停下**，把失败输出报告给用户，并给出备选方案：
  1. 安装时（或首次启用沙箱时）用现有 ACL 授权机制（`packages/sandbox/windows-sandbox/acl.ps1` 的 `grant`），给沙箱账户加 `resources/runtime` 和 `resources/document-libs` 的只读 + 执行权限；
  2. 每个会话把库复制到沙箱可读的会话临时目录，技能里的路径指向那里；
  3. 技能不写死自带 Node，先用 PATH 上的 `node`；库仍要靠方案 1 或 2 才能读到。
     等用户选定后，把选中的方案作为新任务插到 Task 4 之前，探针保持不变，重新跑这一步直到通过。

---

### Task 4: docx / pptx / xlsx 内置技能

**Files:**

- Modify: `packages/resources/builtin-skills.ts`（删除 `OFFICE_DOCUMENTS`，新增三个技能和占位符替换；改 `CODE_ANALYSIS_REPORT` 第 4 步）
- Modify: `packages/core/prompt/notices.ts:54`
- Modify: `apps/desktop/i18n-conversation.ts:292-295`
- Modify: `apps/desktop/ui/composer/command-model.ts:60`
- Modify tests: `tests/resources.test.ts:32-47,82,90`、`tests/context-envelope.test.ts:101`、`tests/client.test.ts:957`、`tests/desktop-react-composer.test.ts:70,103-106`、`tests/desktop-capabilities.smoke.mjs:91`（只改注释）
- Test: `tests/document-libs.test.ts`（追加：技能示例脚本真能跑）

**Interfaces:**

- Consumes: Task 1 的 `documentLibsDirectory()`。
- Produces: `export function fillDocumentPlaceholders(text: string, libs: string | undefined, node: string): string`（`builtin-skills.ts`）；`builtinSkillText()` 对 `docx`/`pptx`/`xlsx` 返回替换后的正文。

- [ ] **Step 1: 写失败的测试**

在 `tests/resources.test.ts` 里把第 32-47 行的 office 用例整段换成：

```ts
test('the built-in document skills are offered everywhere and a workspace skill of their name replaces them', async (t) => {
  const dir = await tempRoot(t, 'yuantu-skills-');
  for (const name of ['docx', 'pptx', 'xlsx']) {
    const builtin = discoverSkills(dir).find((skill) => skill.name === name);
    assert.equal(builtin?.path, `builtin:${name}`);
    const expanded = expandSkill(dir, `/skill:${name} write it`).prompt;
    assert.doesNotMatch(expanded, /\{\{(NODE|DOCUMENT_LIBS)\}\}/);
    assert.match(expanded, /createRequire\(/);
  }
  assert.equal(
    discoverSkills(dir).find((skill) => skill.name === 'office-documents'),
    undefined,
  );
  await mkdir(path.join(dir, '.yuantu', 'skills', 'docx'), { recursive: true });
  await writeFile(
    path.join(dir, '.yuantu/skills/docx/SKILL.md'),
    '---\nname: docx\ndescription: ours\n---\nOur own rules',
  );
  const replaced = discoverSkills(dir).filter((skill) => skill.name === 'docx');
  assert.equal(replaced.length, 1);
  assert.equal(replaced[0]!.path, '.yuantu/skills/docx/SKILL.md');
  assert.match(expandSkill(dir, '/skill:docx go').prompt, /Our own rules/);
});

test('without shipped libraries the document skills say so instead of naming a path', () => {
  const text = fillDocumentPlaceholders('A {{DOCUMENT_LIBS}} B {{NODE}}', undefined, '/n/node');
  assert.match(text, /does not ship the document libraries/);
  assert.doesNotMatch(text, /\{\{/);
  assert.equal(
    fillDocumentPlaceholders(
      '{{DOCUMENT_LIBS}}|{{NODE}}',
      'C:\\a\\node_modules',
      'C:\\n\\node.exe',
    ),
    '"C:/a/node_modules/"|C:/n/node.exe',
  );
});

test('a library path with quotes or backslashes still yields a valid JavaScript string', async (t) => {
  // An install location such as C:\Users\O'Brien\... must not end the string literal early.
  const root = await tempRoot(
    t,
    process.platform === 'win32' ? "yuantu-o'brien-$&-" : 'yuantu-o\'brien-$&-\\"x-',
  );
  const libs = path.join(root, 'node_modules');
  await stageDocumentLibs(path.resolve('node_modules'), libs);
  const script = fillDocumentPlaceholders(
    "const need = require('node:module').createRequire({{DOCUMENT_LIBS}});\n" +
      "console.log(typeof need('docx').Document);",
    libs,
    process.execPath,
  );
  const file = path.join(root, 'probe.cjs');
  await writeFile(file, script);
  const { stdout } = await promisify(execFile)(process.execPath, [file]);
  assert.equal(stdout.trim(), 'function');
});
```

Windows 的目录名不能含 `"`，所以那里只测 `'` 和 `$&`。这个用例要用到 Task 2 的 `stageDocumentLibs` 和 `execFile`/`promisify`，在文件顶部一并导入。期望值里的 `"C:/a/node_modules/"` 是 `JSON.stringify` 的结果，引号是值的一部分。

（在该文件顶部补 `import { fillDocumentPlaceholders } from '../packages/resources/builtin-skills.ts';`。）第 82、90 行的期望里，`'builtin:office-documents'` 换成 `'builtin:docx', 'builtin:pptx', 'builtin:xlsx'`（按字母序和 `builtin:code-analysis-report` 排在一起：`['builtin:code-analysis-report', 'builtin:docx', 'builtin:pptx', 'builtin:xlsx']`）。

`tests/context-envelope.test.ts:101`、`tests/client.test.ts:957`、`tests/desktop-react-composer.test.ts:70,103-106`：把 `office-documents` 换成 `docx`；composer 测试第 103 行的查询 `'/office'` 改成 `'/docx'`，第 106 行的中文断言改成匹配新描述里的 `/Word/`。

在 `tests/document-libs.test.ts` 追加"技能示例真能跑"：

````ts
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { expandSkill } from '../packages/resources/skills.ts';
import { readPptxSlides } from '../packages/office/read.ts';
import { officePreviewHtml } from '../packages/office/render.ts';

/** The first ```js block of a built-in skill, as the model would copy it. */
function exampleScript(name: string, workspace: string): string {
  const text = expandSkill(workspace, `/skill:${name} x`).prompt;
  const match = text.match(/```js\n([\s\S]*?)```/);
  assert.ok(match, `${name} skill has a js example`);
  return match[1]!;
}

for (const [name, check] of [
  [
    'docx',
    async (file: string) =>
      assert.match(await officePreviewHtml('docx', file, 'en'), /Quarterly report/),
  ],
  [
    'pptx',
    async (file: string) =>
      assert.ok(
        (await readPptxSlides(await readFile(file))).join('\n').includes('Revenue grew 12%'),
      ),
  ],
  [
    'xlsx',
    async (file: string) =>
      assert.match(await officePreviewHtml('xlsx', file, 'en'), /SUM\(B2:B3\)/),
  ],
] as const) {
  test(`the ${name} skill's example script runs with the shipped libraries`, async (t) => {
    const root = await tempRoot(t, `yuantu-skill-${name}-`);
    const script = path.join(root, `make.cjs`);
    const output = path.join(root, `out.${name}`);
    await writeFile(script, exampleScript(name, root));
    await promisify(execFile)(process.execPath, [script, output], { cwd: root });
    await check(output);
  });
}
````

- [ ] **Step 2: 跑测试确认失败**

Run: `node scripts/run-tests.mjs tests/resources.test.ts tests/document-libs.test.ts`
Expected: FAIL——`fillDocumentPlaceholders` 不存在，`docx` 技能不存在。

- [ ] **Step 3: 实现技能**

在 `builtin-skills.ts` 里删除整个 `OFFICE_DOCUMENTS` 常量，新增下面三个常量。模板字符串里的反引号要写成 `` \` ``，和原来 `OFFICE_DOCUMENTS` 的写法一致；`${` 不能出现在正文里（示例代码里不用模板字符串）。

```ts
/** Shared by the three document skills: how a script is run, and what finishing means. */
const DOCUMENT_SCRIPT_RULES = `## Running a script

- Write the script with write_file as a \`.cjs\` file in the workspace (for example \`_make_report.cjs\`), run it
  with run_command as \`"{{NODE}}" _make_report.cjs <output path>\`, and delete the script once the file is checked.
- Load libraries only through \`need\` as shown; a bare \`require('docx')\` will not find them.
- Never invent figures, names, dates or quotations; mark anything unknown as a placeholder such as [TBD: Q3 revenue].
- A workspace skill with the same name replaces this one: prefer the user's own skill when it exists.

## Finishing

- Read the output back before reporting it (snippet below) and confirm content, order and that no placeholder is
  left unfilled by mistake.
- Call verify_file_delivery on the final path, then hand the file over with present and say what is in it.
- PDF output is not part of this skill. If the user wants a PDF, check whether LibreOffice (soffice) or Microsoft
  Office is installed; if neither is, say so instead of trying other routes.`;

const DOCX_BODY = `---
name: docx
description: Create or revise Word (.docx) files by writing a short Node script with the bundled docx library, then read the result back.
---

# Word documents

Use this when the user wants a report, proposal, letter or handout as a .docx file.

## Writing

- Settle audience, purpose and length first; when the request leaves them open, choose defaults and say which.
- Use headings for structure (HEADING_1 for sections, HEADING_2 for subsections), short paragraphs, bullet
  lists for parallel items, and a table for anything compared across two or more attributes.
- Start a long report with a short summary and end with conclusions or next steps.

## Example

\`\`\`js
const need = require('node:module').createRequire({{DOCUMENT_LIBS}});
const fs = require('node:fs');
const { Document, Packer, Paragraph, HeadingLevel, Table, TableRow, TableCell, TextRun, WidthType } = need('docx');

const cell = (text, bold) =>
  new TableCell({ children: [new Paragraph({ children: [new TextRun({ text, bold })] })] });
const doc = new Document({
  sections: [{
    children: [
      new Paragraph({ text: 'Quarterly report', heading: HeadingLevel.TITLE }),
      new Paragraph({ text: 'Summary', heading: HeadingLevel.HEADING_1 }),
      new Paragraph({ children: [new TextRun('Revenue grew '), new TextRun({ text: '12%', bold: true })] }),
      new Paragraph({ text: 'New customers contributed most of it', bullet: { level: 0 } }),
      new Table({
        width: { size: 100, type: WidthType.PERCENTAGE },
        rows: [
          new TableRow({ children: [cell('Metric', true), cell('Value', true)] }),
          new TableRow({ children: [cell('Revenue'), cell('947')] }),
        ],
      }),
    ],
  }],
});
Packer.toBuffer(doc).then((bytes) => fs.writeFileSync(process.argv[2], bytes));
\`\`\`

## Changing an existing document

- To fill a template, unzip it with jszip (\`need('jszip')\`), replace distinctive placeholders such as
  {{client_name}} in \`word/document.xml\`, and zip it back. Word may split a placeholder across several \`<w:r>\`
  runs; read the XML first, and if a placeholder is split, rebuild that paragraph instead of patching text.
- When the change is larger than filling placeholders, write a new document with the script above.

## Reading it back

\`\`\`js
const need = require('node:module').createRequire({{DOCUMENT_LIBS}});
need('jszip').loadAsync(require('node:fs').readFileSync(process.argv[2]))
  .then((zip) => zip.file('word/document.xml').async('string'))
  .then((xml) => console.log(xml.replace(/<\\/w:p>/g, '\\n').replace(/<[^>]+>/g, '')));
\`\`\`
`;
```

三个 `*_BODY` 常量都不含公共规则，在本步末尾统一拼上 `DOCUMENT_SCRIPT_RULES`。

```ts
const PPTX_BODY = `---
name: pptx
description: Create PowerPoint (.pptx) decks by writing a short Node script with the bundled pptxgenjs library, then read the slides back.
---

# PowerPoint decks

Use this when the user wants a slide deck as a .pptx file.

## Writing

- One idea per slide. The title states the takeaway ("Revenue grew 12%"), not the topic ("Revenue").
- At most 5 bullets per slide and about 12 words per bullet; move detail to the speaker notes.
- Open with a title slide, close with a summary or next steps, and use title-only section slides in decks
  longer than about 10 slides. Put numbers in a table (about 6 rows by 5 columns at most), not in bullets.

## Example

\`\`\`js
const need = require('node:module').createRequire({{DOCUMENT_LIBS}});
const PptxGenJS = need('pptxgenjs');

const pptx = new PptxGenJS();
pptx.layout = 'LAYOUT_WIDE'; // 13.33 x 7.5 inches
let slide = pptx.addSlide();
slide.addText('Quarterly review', { x: 0.5, y: 2.6, w: 12.3, h: 1.4, fontSize: 40, bold: true, align: 'center' });

slide = pptx.addSlide();
slide.addText('Revenue grew 12%', { x: 0.5, y: 0.4, w: 12.3, h: 0.9, fontSize: 28, bold: true });
slide.addText(
  [
    { text: 'New customers contributed most of it', options: { bullet: true } },
    { text: 'Renewals held at 91%', options: { bullet: true } },
  ],
  { x: 0.7, y: 1.5, w: 11.8, h: 4.5, fontSize: 20, valign: 'top' },
);
slide.addNotes('Mention the two large renewals in March.');

slide = pptx.addSlide();
slide.addText('Key figures', { x: 0.5, y: 0.4, w: 12.3, h: 0.9, fontSize: 28, bold: true });
slide.addTable(
  [
    [{ text: 'Metric', options: { bold: true } }, { text: 'Value', options: { bold: true } }],
    ['Revenue', '947'],
  ],
  { x: 0.7, y: 1.5, w: 8, fontSize: 16, border: { type: 'solid', pt: 1, color: 'BBBBBB' } },
);
pptx.writeFile({ fileName: process.argv[2] });
\`\`\`

## Reading it back

\`\`\`js
const need = require('node:module').createRequire({{DOCUMENT_LIBS}});
need('jszip').loadAsync(require('node:fs').readFileSync(process.argv[2])).then(async (zip) => {
  const slides = Object.keys(zip.files).filter((n) => /^ppt\\/slides\\/slide\\d+\\.xml$/.test(n))
    .sort((a, b) => parseInt(a.match(/\\d+/)[0]) - parseInt(b.match(/\\d+/)[0]));
  for (const name of slides)
    console.log(name, (await zip.file(name).async('string')).replace(/<\\/a:p>/g, '\\n').replace(/<[^>]+>/g, ''));
});
\`\`\`
`;

const XLSX_BODY = `---
name: xlsx
description: Create or update Excel (.xlsx) workbooks by writing a short Node script with the bundled SheetJS library, then read the cells back.
---

# Excel workbooks

Use this when the user wants a workbook as a .xlsx file.

## Writing

- One table per sheet; the first row is the header. Keep columns to what the reader needs and set widths.
- Write totals and derived values as formulas with explicit ranges (\`SUM(B2:B3)\`), not whole columns.
- There is no calculation engine here: a formula is stored without a cached result and Excel, WPS or
  LibreOffice computes it when the file opens. Do not add another tool just to compute a value.
- To change an existing workbook, read it with \`XLSX.readFile\`, change only the cells asked for, and write it
  to the output path; SheetJS keeps values and formulas but not every style, so say so when styling matters.

## Example

\`\`\`js
const need = require('node:module').createRequire({{DOCUMENT_LIBS}});
const XLSX = need('xlsx');

const sheet = XLSX.utils.aoa_to_sheet([
  ['Item', 'Amount'],
  ['Licences', 100],
  ['Support', 200],
  ['Total'],
]);
sheet['B4'] = { t: 'n', f: 'SUM(B2:B3)' };
sheet['!ref'] = 'A1:B4';
sheet['!cols'] = [{ wch: 14 }, { wch: 10 }];
const book = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(book, sheet, 'Summary');
XLSX.writeFile(book, process.argv[2]);
\`\`\`

## Reading it back

\`\`\`js
const need = require('node:module').createRequire({{DOCUMENT_LIBS}});
const XLSX = need('xlsx');
const book = XLSX.readFile(process.argv[2], { cellFormula: true });
for (const name of book.SheetNames) console.log(name + '\\n' + XLSX.utils.sheet_to_csv(book.Sheets[name]));
for (const [address, cell] of Object.entries(book.Sheets[book.SheetNames[0]]))
  if (cell.f) console.log(address, '=' + cell.f);
\`\`\`
`;

const DOCX = DOCX_BODY + '\n' + DOCUMENT_SCRIPT_RULES + '\n';
const PPTX = PPTX_BODY + '\n' + DOCUMENT_SCRIPT_RULES + '\n';
const XLSX = XLSX_BODY + '\n' + DOCUMENT_SCRIPT_RULES + '\n';
```

模板字符串里的 `\\d`、`\\/`、`\\n` 会变成脚本里的 `\d`、`\/`、`\n`——这正是要的。Step 1 的示例测试只取每个技能的**第一个** `js` 代码块，也就是生成脚本；回读片段不在测试范围内，Step 5 手动跑一次回读片段确认没写错。

`BUILTIN` 改为：

```ts
const BUILTIN: Record<string, string> = {
  docx: DOCX,
  pptx: PPTX,
  xlsx: XLSX,
  'code-analysis-report': CODE_ANALYSIS_REPORT,
};
```

文件顶部导入 `import { documentLibsDirectory } from '../platform/document-libs.ts';`，并加：

```ts
const DOCUMENT_SKILLS = new Set(['docx', 'pptx', 'xlsx']);

/**
 * The document skills name the Node and the library directory a script must use, which only this process knows.
 *
 * `{{DOCUMENT_LIBS}}` becomes a whole JavaScript string literal, quotes included: an install path may hold a quote
 * (C:\Users\O'Brien\…) that would end a hand-quoted string early. Forward slashes work in a `require` path and on
 * a command line on every platform. `{{NODE}}` stays bare because the skill puts it inside double quotes on the
 * command line, and neither a Windows path nor the packaged macOS location contains one. Without shipped
 * libraries the skill says so up front, so the model reports it instead of running a script that cannot load
 * anything.
 */
export function fillDocumentPlaceholders(
  text: string,
  libs: string | undefined,
  node: string,
): string {
  const slash = (value: string) => value.replaceAll('\\', '/');
  const notice = libs
    ? ''
    : '> This build does not ship the document libraries, so the scripts below cannot run. Tell the user, and ' +
      'install docx, pptxgenjs, xlsx and jszip in a scratch directory only if they agree.\n\n';
  const literal = JSON.stringify(libs ? slash(libs) + '/' : 'node_modules/');
  // Function replacers: a string replacement would read `$&` or `$'` in a path as a substitution pattern.
  return (
    notice +
    text.replaceAll('{{DOCUMENT_LIBS}}', () => literal).replaceAll('{{NODE}}', () => slash(node))
  );
}
```

特殊路径测试里的目录名带 `$&`，就是为了锁住函数形式替换这一点。

`builtinSkillText` 改为：

```ts
export function builtinSkillText(skillPath: string): string | undefined {
  if (!skillPath.startsWith(BUILTIN_SKILL_PREFIX)) return undefined;
  const name = skillPath.slice(BUILTIN_SKILL_PREFIX.length);
  const text = BUILTIN[name];
  if (text === undefined || !DOCUMENT_SKILLS.has(name)) return text;
  return fillDocumentPlaceholders(text, documentLibsDirectory(), process.execPath);
}
```

`builtinSkills()` 里取描述的正则 `/^description:\s*(.+)$/m` 不变；如果没库时正文开头多了一行提示，描述是从未替换的 `BUILTIN[name]` 里取的，不受影响。

`CODE_ANALYSIS_REPORT` 第 4 步改成：

```
4. 用户要求定制报告时，按 docx 技能写脚本生成 Word 报告。
```

文件顶部那段注释（"They are text in the build rather than `SKILL.md` files…"）末尾加一句：`The document skills name absolute paths only this process knows, filled in when a skill is read (\`fillDocumentPlaceholders\`).`

- [ ] **Step 4: 改提示与界面文案**

`packages/core/prompt/notices.ts:54` 的最后一句改为：

```
For Word, Excel and PowerPoint files, load the docx, xlsx or pptx skill.
```

`apps/desktop/i18n-conversation.ts:292-295` 把 `skill.officeDocumentsDescription` 换成三个键：

```ts
  'skill.docxDescription': [
    '用自带的 docx 库写脚本生成或修改 Word 文档，并回读检查。',
    'Create or revise Word documents with a script using the bundled docx library, then read them back.',
  ],
  'skill.pptxDescription': [
    '用自带的 pptxgenjs 库写脚本生成 PowerPoint 演示文稿，并回读检查。',
    'Create PowerPoint decks with a script using the bundled pptxgenjs library, then read them back.',
  ],
  'skill.xlsxDescription': [
    '用自带的 SheetJS 库写脚本生成或更新 Excel 工作簿，并回读检查。',
    'Create or update Excel workbooks with a script using the bundled SheetJS library, then read them back.',
  ],
```

`apps/desktop/ui/composer/command-model.ts:60` 换成三行：

```ts
  'builtin:docx': 'skill.docxDescription',
  'builtin:pptx': 'skill.pptxDescription',
  'builtin:xlsx': 'skill.xlsxDescription',
```

`tests/desktop-capabilities.smoke.mjs:91` 的注释改为：`// By name, not by text: a skill description may contain "review" inside another word.`

- [ ] **Step 5: 跑测试确认通过**

Run: `node scripts/run-tests.mjs tests/resources.test.ts tests/document-libs.test.ts tests/context-envelope.test.ts tests/client.test.ts tests/desktop-react-composer.test.ts`
Expected: PASS。再跑 `npm run i18n:check`，预期通过。

手动确认回读片段：把 `docx`、`pptx`、`xlsx` 三个技能里的回读代码块各存成 `.cjs`，对 `tests/document-libs.test.ts` 生成的同类文件跑一遍（可以临时在测试里打印 `output` 路径，或直接用示例脚本另外生成一份），确认能打印出文字。三个都跑通才算完。

- [ ] **Step 6: 更新快照并提交**

Run: `npm run snapshot:update`
然后 `git diff tests/snapshots` 确认只变了技能列表和 notices 那一句。

```bash
git add packages/resources/builtin-skills.ts packages/core/prompt/notices.ts apps/desktop/i18n-conversation.ts apps/desktop/ui/composer/command-model.ts tests/resources.test.ts tests/context-envelope.test.ts tests/client.test.ts tests/desktop-react-composer.test.ts tests/desktop-capabilities.smoke.mjs tests/document-libs.test.ts tests/snapshots
git commit -m "feat(resources): replace the office skill with docx, pptx and xlsx script skills"
```

---

### Task 5: 删除 Office 工具

**Files:**

- Modify: `packages/catalog/index.ts:4,155`（删导入和注册循环）
- Modify: `packages/tools/deferred-tools.ts:9,23,62-65`、`packages/tools/tool-categories.ts:81-84`、`packages/core/subagents/contract.ts:276`、`packages/protocol/tool-contract.ts:184`、`packages/protocol/settings.ts:489-492`、`packages/protocol/environment-blocked.ts:3,10`（注释）
- Modify: `packages/office/render.ts`、`packages/office/spreadsheet.ts`、`apps/agent-host/handlers/files.ts:14-15`
- Delete: `packages/office/{tools,automation,document,presentation,replace,inspect,inspect-runner,inspect-worker,preview,preview-backends,limits,xml-text}.ts`、`packages/office/automation.ps1`
- Modify: `scripts/build-host-bundle.mjs:46-67`、`scripts/build-desktop.mjs:27-29`、`scripts/check-windows-package.mjs:51-52`、`scripts/clean-paused-builds.mjs`、`.github/workflows/ci.yml:12`、`benchmarks/coding-evaluation/dependencies.mjs:8`、`tests/coding-evaluation.test.ts:692`（注释）、`tests/windows-install-safety.test.ts:12-13`（注释）
- Create: `tests/office-fixtures.ts`、`tests/office-preview-readonly.test.ts`
- Delete: `tests/office.test.ts`、`tests/office-native.test.ts`、`tests/office-preview.test.ts`
- Modify tests: `tests/files.test.ts:24-44`、`tests/malformed-input.test.ts:17-21,230-300`、`tests/tool-concurrency-mode.test.ts:139,171`、`tests/swe-bench.test.ts:212`

**Interfaces:**

- Produces（保留的只读接口，调用方不变）：
  - `packages/office/render.ts`：`export type OfficeFormat = 'docx' | 'xlsx' | 'pptx'`；`export async function officePreviewHtml(format: OfficeFormat, sourcePath: string, language?: PreviewLanguage): Promise<string>`
  - `packages/office/read.ts`：`readPptxSlides(bytes: Buffer): Promise<string[]>`（不改）
  - `packages/office/spreadsheet.ts`：`spreadsheetPreviewHtml(sourcePath: string, language?: PreviewLanguage): Promise<string>`
  - `tests/office-fixtures.ts`：`writeDocx(file: string, paragraphs: string[]): Promise<void>`、`writePptx(file: string, slides: string[]): Promise<void>`、`writeXlsx(file: string, rows: (string | number)[][], sheet?: string): Promise<void>`

- [ ] **Step 1: 写测试夹具和只读预览测试**

`tests/office-fixtures.ts`：

```ts
/** Small Office files for the read-only preview and attachment tests, made with the same libraries the skills use. */
import { writeFile } from 'node:fs/promises';
import { Document, Packer, Paragraph } from 'docx';
import pptxgenjs from 'pptxgenjs';
import * as XLSX from 'xlsx';

export async function writeDocx(file: string, paragraphs: string[]): Promise<void> {
  const doc = new Document({
    sections: [{ children: paragraphs.map((text) => new Paragraph(text)) }],
  });
  await writeFile(file, await Packer.toBuffer(doc));
}

/** The same default-export adaptation `packages/office/presentation.ts` used: under NodeNext the import is the namespace. */
const PptxGenJS = pptxgenjs as unknown as typeof pptxgenjs.default;

export async function writePptx(file: string, slides: string[]): Promise<void> {
  const pptx = new PptxGenJS();
  for (const text of slides) pptx.addSlide().addText(text, { x: 0.5, y: 0.5, w: 9, h: 1 });
  await writeFile(file, (await pptx.write({ outputType: 'nodebuffer' })) as Buffer);
}

export async function writeXlsx(
  file: string,
  rows: (string | number)[][],
  sheet = 'Sheet1',
): Promise<void> {
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(rows), sheet);
  await writeFile(file, XLSX.write(book, { type: 'buffer', bookType: 'xlsx' }) as Buffer);
}
```

`tests/office-preview-readonly.test.ts`：先打开 `tests/office.test.ts`，把所有调用 `officePreviewHtml` 或 `readPptxSlides` 的用例原样挪过来。用例里凡是用 `office_create` 工具或 `runSpreadsheetOperation({operation:'create'})` 造输入文件的地方，改用 `writeDocx`/`writePptx`/`writeXlsx`；用到公式单元格的用例，在 `writeXlsx` 之后用 `XLSX.readFile` → 设置 `sheet['B4'] = { t: 'n', f: '...' }` → `XLSX.writeFile` 补上公式。只调用 `office_inspect`、`office_edit`、`office_preview`（写文件）、`runOfficeAutomation`、`inspectOffice` 的用例不挪，随旧文件删除。挪完至少要包含下面这三个用例；如果原文件里已有等价用例，用原来的：

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { officePreviewHtml } from '../packages/office/render.ts';
import { readPptxSlides } from '../packages/office/read.ts';
import { writeDocx, writePptx, writeXlsx } from './office-fixtures.ts';
import { tempRoot } from './temp-fixture.ts';

test('a Word preview is a script-free page with the document text', async (t) => {
  const file = path.join(await tempRoot(t, 'yuantu-preview-docx-'), 'a.docx');
  await writeDocx(file, ['Hello preview']);
  const html = await officePreviewHtml('docx', file, 'en');
  assert.match(html, /Hello preview/);
  assert.match(html, /default-src 'none'/);
  assert.doesNotMatch(html, /<script/i);
});

test('slide text is read in order', async (t) => {
  const file = path.join(await tempRoot(t, 'yuantu-preview-pptx-'), 'a.pptx');
  await writePptx(file, ['First', 'Second']);
  const slides = await readPptxSlides(await readFile(file));
  assert.equal(slides.length, 2);
  assert.match(slides[0]!, /First/);
  assert.match(slides[1]!, /Second/);
});

test('a workbook preview shows its cells', async (t) => {
  const file = path.join(await tempRoot(t, 'yuantu-preview-xlsx-'), 'a.xlsx');
  await writeXlsx(
    file,
    [
      ['Metric', 'Value'],
      ['Revenue', 947],
    ],
    'Summary',
  );
  const html = await officePreviewHtml('xlsx', file, 'en');
  assert.match(html, /<td>Revenue<\/td>/);
  assert.match(html, /<td>947<\/td>/);
});
```

Run: `node scripts/run-tests.mjs tests/office-preview-readonly.test.ts`
Expected: PASS（此时预览代码还没动，测试应该直接通过；目的是在删除前先锁住保留的行为）。

- [ ] **Step 2: 改其余测试里的生成调用**

`tests/files.test.ts`：删 `runSpreadsheetOperation` 导入，加 `import { writeXlsx } from './office-fixtures.ts';`，第 30-43 行换成：

```ts
await writeXlsx(
  path.join(root, 'book.xlsx'),
  [
    ['Metric', 'Value'],
    ['Revenue', 947],
  ],
  'Summary',
);
```

`tests/malformed-input.test.ts`：删第 17-21 行的四个导入（`OfficeFormat`、`inspectOffice`、`runSpreadsheetOperation`、`createDocx`、`createPptx`）。打开第 230-300 行：生成合法样本的地方（约 237、252、254 行）改用 `writeXlsx`/`writeDocx`/`writePptx`；断言 `inspectOffice` 的部分（约 298 行）改为断言 `officePreviewHtml(format, file)` 对畸形输入**抛错或返回不含原始 XML 标签的页面**——畸形包要被预览安全拒绝，这是保留下来的那部分行为。`OfficeFormat` 改从 `../packages/office/render.ts` 导入。

`tests/tool-concurrency-mode.test.ts:139,171`、`tests/swe-bench.test.ts:212`：从工具名清单里删掉 `office_inspect`、`office_create`、`office_edit`。

- [ ] **Step 3: 删除 office 测试并跑一遍，确认现在才失败**

```bash
git rm tests/office.test.ts tests/office-native.test.ts tests/office-preview.test.ts
```

Run: `node scripts/run-tests.mjs tests/tool-concurrency-mode.test.ts tests/swe-bench.test.ts`
Expected: FAIL——目录里还注册着 `office_*` 工具，和改过的清单对不上。

- [ ] **Step 4: 删除工具与引擎**

```bash
git rm packages/office/tools.ts packages/office/automation.ts packages/office/automation.ps1 packages/office/document.ts packages/office/presentation.ts packages/office/replace.ts packages/office/inspect.ts packages/office/inspect-runner.ts packages/office/inspect-worker.ts packages/office/preview.ts packages/office/preview-backends.ts packages/office/limits.ts packages/office/xml-text.ts
```

`packages/office/render.ts`：

- 删掉导入 `automation.ts`、`environment-blocked.ts`、`preview.ts`、`runSpreadsheetOperation`、`preview-backends.ts`，删掉两行 `export ... from './preview-backends.ts'` 和 `import type { PreviewBackend, PreviewType }`。
- 加 `export type OfficeFormat = 'docx' | 'xlsx' | 'pptx';`。
- 删掉 `renderHtml`、`renderPreview` 两个函数，以及 `officePreviewHtml` 上方那段说 "Render one preview with the requested engine…" 的孤立注释。
- `officePreviewHtml` 的注释第一句改为：`One Office document as a self-contained HTML page, for the workspace panel.`，删掉提到 `office_preview` 的那句。

`packages/office/spreadsheet.ts`：删掉 `runSpreadsheetOperation` 及只被它用到的函数（`isFormula`、创建/编辑/写文件分支）、`MAX_CREATED_SHEETS` 的导入与再导出、`OfficeOperation` 导入、`path`、`writeFile`、`JSZip`、`readEntry` 中不再使用的导入。保留 `spreadsheetPreviewHtml` 及它调用到的辅助函数。删完跑 `npx tsc --noEmit -p .`，按"未使用"的报错继续删干净。

`apps/agent-host/handlers/files.ts:15`：`import type { OfficeFormat } from '../../../packages/office/automation.ts';` 改成从 `render.ts` 导入（可以与第 14 行合并）。

`packages/catalog/index.ts`：删第 4 行导入和 `for (const tool of officeTools(root)) registry.register(tool);`。

`packages/tools/deferred-tools.ts`：删第 62-65 行四个工具名；第 9、23 行注释里列举子系统的 "an Office file" / "Office" 删掉，保持句子通顺。

`packages/tools/tool-categories.ts`：删第 81-84 行。如果 `q`/`c` 的参数类型来自 `ToolCategory` 联合，接着改下一项。

`packages/protocol/tool-contract.ts:184`：从分类联合里删掉 `| 'office'`。用 Grep 搜 `'office'` 确认没有别处再用这个分类值（`apps/desktop` 里可能有图标或文案映射，一并删掉）。

`packages/core/subagents/contract.ts:276`：从只读白名单删掉 `'office_inspect',`。

`packages/protocol/settings.ts:489-492`：删除整个 `YUANTU_LIBREOFFICE_PATH` 条目。用 Grep 搜 `YUANTU_LIBREOFFICE_PATH`，删掉剩余引用（README 留到 Task 6）。

`packages/protocol/environment-blocked.ts:3,10`：注释里以 Office 为例的地方换成仓库里另一个真实的环境阻断例子。Grep `environmentBlockedMessage(` 找一个现存调用，用它的原因描述。

- [ ] **Step 5: 改构建脚本**

`scripts/build-host-bundle.mjs`：删掉第 46-67 行里构建 `office-inspect-worker.js` 的那次 esbuild 调用（含上方注释），以及复制 `automation.ps1` 的 `copyFile`（含注释）。如果 `copyFile` 因此不再使用，从导入里删掉。

`scripts/build-desktop.mjs:27-29`：删掉复制 `automation.ps1` 的两行和 `mkdir('dist/packages/office', …)`；不再使用的导入一并删掉。

`scripts/check-windows-package.mjs:51-52`：删掉检查 `automation.ps1` 的注释和 `readFile`。"bundled dependency" 循环（`docx, jszip, mammoth, pptxgenjs, xlsx` 不应出现在 `app/node_modules`）保留不动。

`scripts/clean-paused-builds.mjs`：停止生成不会删掉旧产物。`npm run build` 第一步就是这个脚本，`tsc` 和打包脚本都不会清空 `dist`，而 `electron-builder` 会把 `dist/packages/**` 整个装进安装包。所以旧的 Office worker、自动化脚本和工具模块必须在这里显式删除。照文件里 `removedMcpModules` 的写法加一组：

```js
const removedOfficeModules = [
  'automation',
  'document',
  'inspect',
  'inspect-runner',
  'inspect-worker',
  'limits',
  'presentation',
  'preview',
  'preview-backends',
  'replace',
  'tools',
  'xml-text',
];
```

`removedOutputs` 里加：

```js
  ...removedOfficeModules.flatMap((name) =>
    ['.js', '.js.map', '.d.ts'].map((extension) => `packages/office/${name}${extension}`),
  ),
  'packages/office/automation.ps1',
  'packages/tools/office-inspect-worker.js',
  'packages/tools/office-inspect-worker.js.map',
  'packages/tools/automation.ps1',
  'desktop/automation.ps1',
```

`scripts/check-windows-package.mjs` 在删掉 `automation.ps1` 检查的同一处，改成反向检查，确保旧产物没有进安装包：

```js
// Removed with the Office tools (`scripts/clean-paused-builds.mjs`); a copy here means a stale `dist` was packaged.
for (const stale of [
  'dist/packages/tools/office-inspect-worker.js',
  'dist/packages/tools/automation.ps1',
  'dist/packages/office/automation.ps1',
  'dist/packages/office/tools.js',
  'dist/desktop/automation.ps1',
])
  if (await stat(path.join(resources, 'app', stale)).catch(() => null))
    throw new Error(`Packaged app still contains removed Office output ${stale}`);
```

`.github/workflows/ci.yml:12`：删掉 "Office tests need a local Microsoft Office install" 这一行注释。

`benchmarks/coding-evaluation/dependencies.mjs:8`、`tests/coding-evaluation.test.ts:692`、`tests/windows-install-safety.test.ts:12-13`：读上下文。注释里引用已删除文件（`automation.ts`）的，改成描述现状；只是泛称"Office 库"的，保持不动。

- [ ] **Step 6: 跑定向检查**

Run: `npx tsc --noEmit -p .`
Expected: 无错误。

Run: `node scripts/run-tests.mjs tests/office-preview-readonly.test.ts tests/files.test.ts tests/malformed-input.test.ts tests/tool-concurrency-mode.test.ts tests/swe-bench.test.ts tests/desktop.test.ts tests/document-libs.test.ts`
Expected: PASS。

Run: `npm run layers:check && npm run cycles:check && npm run references:check && npm run lint`
Expected: 全部通过。

Run: `npm run build`（**不要**先删 `dist`，要验证的正是在旧产物上做增量构建的情况）
Expected: 成功。再确认旧产物都已清掉：

```bash
ls dist/packages/office
```

Expected: 只有 `preview-page`、`read`、`render`、`spreadsheet`、`zip-entry` 这五个模块的 `.js`/`.js.map`/`.d.ts`。

```bash
ls dist/packages/tools/office-inspect-worker.js dist/packages/tools/automation.ps1 dist/desktop/automation.ps1
```

Expected: 三个都报 "No such file"。

Windows 打包验证（Task 6 Step 3 的 `package:windows:dir`）里，`validateWindowsPackage` 新加的反向检查会再确认一次安装包里没有这些文件。

用 Grep 在 `packages apps scripts tests`（排除 `node_modules`、`dist`、`.scratch`）里搜 `office_inspect|office_create|office_edit|office_preview|officeTools|runOfficeAutomation|automation\.ps1|LIBREOFFICE`，预期没有结果。

- [ ] **Step 7: 更新快照并提交**

Run: `npm run snapshot:update`，然后 `git diff tests/snapshots` 确认只是工具清单少了 `office_*`。

```bash
git add -A packages apps scripts tests benchmarks .github
git commit -m "refactor(office): remove the office tools, keep the read-only previews"
```

---

### Task 6: README 与全量验证

**Files:**

- Modify: `README.md`（第 100、105、110、116、117、271-282、315、568、745、801、859 行附近）
- 可能修改：`scripts/docs-facts.mjs` 生成的事实区块（由 `npm run docs:generate` 生成）

- [ ] **Step 1: 改 README**

- 第 100 行 `packages/office` 一行：职责改为 `DOCX / XLSX / PPTX 只读预览（文件面板）与 PPTX 附件文字提取`；依赖列按 `scripts/check-layers.mjs` 的实际导入改，删除后应该只剩 `protocol`（或者为空，以 `npm run layers:check` 和真实导入为准）。
- 第 105、110、116、117 行：`catalog` 依赖列表删掉 `office`；第 110 行描述里的 "Office" 删掉；`apps/agent-host` 依赖里的 `office` 保留（文件预览还在用），`apps/desktop` 的保留（附件读取还在用）。
- 第 271-282 行 "Office 与交付" 一节：删掉四行 `office_*` 工具和第 282 行整段说明；小节标题改为"交付"，只保留交付相关的行。在其后加一段：

  ```markdown
  ### 文档生成

  Word、Excel、PowerPoint 文件不走专用工具，由模型按内置的 `docx`、`pptx`、`xlsx` 技能写一段 Node 脚本生成，再把文件读回来核对。应用自带这些脚本需要的库（`docx`、`pptxgenjs`、SheetJS、`jszip`），打包后放在 `resources/document-libs`，从源码运行时用仓库自己的 `node_modules`；技能正文里给出的 Node 与库路径在加载技能时填入。工作区里同名的技能会替换内置的。需要 PDF 时，技能只会尝试本机已装的 LibreOffice 或 Microsoft Office，两者都没有就如实告知。
  ```

- 第 315 行技能那一行：`内置 office-documents、code-analysis-report` 改为 `内置 docx、pptx、xlsx、code-analysis-report`。
- 第 568 行：改成 "应用内置四个技能……：`docx`、`pptx`、`xlsx`（用自带库写脚本生成并回读 Word、PPT、Excel 文件），工作区里同名的技能会替换它们；`code-analysis-report`（……原文不变）"。
- 第 745 行：删除 `YUANTU_LIBREOFFICE_PATH` 一行。
- 第 801 行：改为 "**浏览器工具依赖可选的 `playwright`**；Office 文件的生成靠技能与自带库，文件面板的预览是纯 JS；PDF 转换不在内置能力里。"
- 第 859 行：跳过原因列表里删掉"本机 Office"。

改完不要链接 `docs/`，也不要提分支。

- [ ] **Step 2: 同步文档事实**

Run: `npm run docs:check`
Expected: 如果失败，跑 `npm run docs:generate`，再跑一次 `npm run docs:check`，预期通过。用 `git diff README.md` 确认生成器只改了它负责的区块。

- [ ] **Step 3: 全量验证**

Run: `npm run typecheck`
Run: `npm run lint`
Run: `npm run format:check`（失败就对改过的文件跑 `npx prettier --write <文件>`）
Run: `npm test`
Expected: 全部通过。有失败就贴出完整输出，按 superpowers:systematic-debugging 排查，不要跳过。

Run（Windows 本机）: `npm run package:windows:dir`
Expected: 成功，`afterPack` 的 `validateWindowsPackage` 通过（它会检查 `resources/document-libs` 里四个库都在）。

- [ ] **Step 4: 提交**

```bash
git add README.md
git commit -m "docs: describe document generation through skills"
```

---

## Self-Review 记录

- Spec 覆盖：删除工具（Task 5）、保留只读（Task 5 Step 1/4）、自带库（Task 1、2）、占位符传路径（Task 4）、沙箱读取验证（Task 3）、技能（Task 4）、code-analysis-report 与 notices（Task 4）、README（Task 6）、测试调整（Task 4、5）——都有对应任务。
- Spec 里写的"`OfficeFormat` 改在 `render.ts` 本地定义"→ Task 5 Step 4；"`tool-contract.ts` 的 `'office'` 分类"→ Task 5 Step 4。
- Spec 没写、计划补上的：用 `{{NODE}}` 指定自带 Node（工具子进程的 PATH 不保证有 `node`）；Task 3 改成卡口任务，因为 Windows 沙箱账户很可能读不到用户目录下的安装位置。
- 评审补充（2026-10-31）：真实账户探针登记进 `WINDOWS_ACCOUNT_JOURNEY_FILES`，以 CI 实际运行、零跳过为准，并覆盖三种格式（Task 3）；`image-size` 豁免改以"pptxgenjs 从不加载它"为依据，加守护测试，并跑 `audit:check`（Task 2 Step 5）；`clean-paused-builds.mjs` 清除旧 Office 产物，安装包检查反向确认（Task 5 Step 5）；库路径用 `JSON.stringify` 生成完整字符串字面量，并用函数形式替换，避免 `$&` 被当成替换模式（Task 4）；PPT 夹具沿用默认导出的类型适配（Task 5 Step 1）。
