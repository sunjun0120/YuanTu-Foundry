# 工具发现与加载优化 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 降低首个请求的负担和发现成本：按需加载的工具按 namespace 发现、可整组加载；少用的工具移出首个请求；LSP 13 个工具合并为 3 个；精简几个过大的工具描述。其余工具保持原子。

**Architecture:**

- 发现和加载的改动只在 `packages/tools/deferred-tools.ts`，工具名不变。
- LSP 合并的做法：`createTools()` 注册完全部工具后，把 LSP 成员取出来，组合成按 `action` 分派的 `lsp` 和 `lsp_edit`。旧 LSP 名到"新名 + action"的映射放在 protocol 层的一张静态表里，注册表、权限规则、钩子、按需加载记录、历史改写都从这张表读。
- 只读子代理需要按操作限权，所以注册表的 restriction 要支持 action 级别的限制。

**Tech Stack:** TypeScript（Node 24 直接跑 `.ts`）、`node:test`、Ajv。

**Spec:** `docs/superpowers/specs/2026-10-31-tool-consolidation-design.md`

## Global Constraints

- 不以工具数作为目标；除 LSP 外不合并任何工具；`browser_close` 保留。
- 合并只发生在权限相同的操作之间；工具契约里的 `permission` 仍是按工具固定声明，不改。
- 合并工具用扁平 schema：`action` 是枚举，其余参数平铺；不用 `oneOf`/`anyOf`/`if`。各操作的参数按原工具的 schema 在 `prepare` 里校验。
- 旧 LSP 名保留一个版本。
- 分阶段只跑定向测试：`node scripts/run-tests.mjs <文件>`；最后用 `FOUNDRY_TEST_CONTINUE_ON_FAILURE=1 npm test` 完整跑一轮（本地默认遇到失败就停）。
- 在 Windows 上改文件一律用编辑工具，避免 CRLF。
- README 自成一体，不链接 `docs/`。
- 每个任务结束提交一次，提交信息结尾加 `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`。
- 需要真实模型（花 API 额度）或推送分支的步骤，先问用户。

## 和 spec 的一处差异

spec 第 1 节写的是"`load_tools` 的描述不再逐个列出组内工具名"。但 `LOAD_TOOLS_DESCRIPTION` 允许模型不经加载、直接调用按需加载的工具，前提是它知道名字。LSP 合并之后，按需加载的名字只剩约 30 个，所以计划**保留组内名字**，只在每行前面加上 namespace 键：`- lsp — language servers (...): lsp, lsp_start, lsp_edit`。Task 1 Step 6 会把 spec 的这一句改成实际做法。

---

### Task 1: namespace 目录与整组加载

**Files:**

- Modify: `packages/tools/deferred-tools.ts`（`DEFERRED_GROUPS` 加 `namespace`；`deferredCatalog`；`loadToolsTool`；`addLoadedTools`；`matchDeferredTools`）
- Modify: `packages/tools/registry.ts`（新增 `tool(name)` 只读访问器）
- Modify: `packages/catalog/index.ts`（`loadToolsTool` 多传一个描述查询函数）
- Test: `tests/deferred-tools.test.ts`（追加）

**Interfaces:**

- Produces:
  - `DEFERRED_GROUPS` 的元素类型变为 `{ namespace: string; hint: string; names: readonly string[] }`
  - `export const DEFERRED_NAMESPACES: ReadonlyMap<string, readonly string[]>`（namespace → 组内工具名）
  - `loadToolsTool(offers: (name: string) => boolean, describe?: (name: string) => string | undefined): Tool`，参数新增 `namespace?: string[]`
  - `ToolRegistry.tool(name: string): Tool | undefined`

- [ ] **Step 1: 写失败的测试（追加到 `tests/deferred-tools.test.ts`）**

先读这个文件现有的用例，照它构造 `loader` 和 `context` 的方式写。

```ts
import {
  DEFERRED_GROUPS,
  DEFERRED_NAMESPACES,
  deferredCatalog,
  loadedTools,
  loadToolsTool,
  matchDeferredTools,
  DEFERRED_TOOLS,
} from '../packages/tools/deferred-tools.ts';

test('every deferred group has a unique namespace, and the catalog leads with it', () => {
  const keys = DEFERRED_GROUPS.map((group) => group.namespace);
  assert.equal(new Set(keys).size, keys.length);
  for (const key of keys) assert.match(key, /^[a-z]+$/);
  const catalog = deferredCatalog([{ name: 'web_search' }, { name: 'web_fetch' }]);
  assert.match(catalog, /^- web — [^:]+: web_search, web_fetch$/m);
});

test('a namespace loads its whole group, and the transcript remembers it', async () => {
  const offered = new Set(DEFERRED_NAMESPACES.get('web')!);
  const loader = loadToolsTool(
    (name) => offered.has(name),
    (name) => `${name} does a web thing. More detail.`,
  );
  const result = await loader.execute({ namespace: ['web'] }, {
    signal: new AbortController().signal,
  } as never);
  assert.equal(result.isError, false);
  assert.match(result.content, /Loaded web_search, web_fetch/);
  // Each loaded tool is introduced by its first sentence, so the model knows which one to call.
  assert.match(result.content, /web_fetch: web_fetch does a web thing\./);
  const loaded = loadedTools(
    [
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'l', name: 'load_tools', arguments: { namespace: ['web'] } }],
      },
    ],
    DEFERRED_TOOLS,
  );
  assert.deepEqual([...loaded].sort(), ['web_fetch', 'web_search']);
});

test('an unknown namespace is refused with the ones that exist', async () => {
  const loader = loadToolsTool(() => true);
  const result = await loader.execute({ namespace: ['nope'] }, {
    signal: new AbortController().signal,
  } as never);
  assert.equal(result.isError, true);
  assert.match(result.content, /web/);
});

test('a keyword search also matches namespace keys', () => {
  assert.ok(
    matchDeferredTools('terminal', DEFERRED_TOOLS).some((name) => name.startsWith('terminal_')),
  );
  assert.ok(matchDeferredTools('validation', DEFERRED_TOOLS).includes('run_validation'));
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node scripts/run-tests.mjs tests/deferred-tools.test.ts`
Expected: 新用例 FAIL（没有 `namespace`、没有 `DEFERRED_NAMESPACES`）。

- [ ] **Step 3: 实现**

`DEFERRED_GROUPS` 每组加 `namespace`，各组注释和顺序保持不变：

| 现在的 hint                                  | namespace    |
| -------------------------------------------- | ------------ |
| language server (...)                        | `lsp`        |
| browser automation                           | `browser`    |
| file delivery checks                         | `delivery`   |
| knowledge base indexing                      | `knowledge`  |
| web                                          | `web`        |
| interactive terminals                        | `terminal`   |
| git branches, worktrees, staging and commits | `git`        |
| more file operations (...)                   | `files`      |
| project validation                           | `validation` |
| background jobs (...)                        | `jobs`       |
| past sessions (...)                          | `sessions`   |
| session goal                                 | `goal`       |

```ts
/** Namespace → the tools of its group; `load_tools({ namespace })` loads them together. */
export const DEFERRED_NAMESPACES: ReadonlyMap<string, readonly string[]> = new Map(
  DEFERRED_GROUPS.map((group) => [group.namespace, group.names]),
);
```

`deferredCatalog` 的每一行改为 `` `- ${namespace} — ${hint}: ${shown.join(', ')}` ``，未分组的那一行保持 `- other: ...`。

`LOAD_TOOLS_DESCRIPTION` 改为（语义和原来一致，只加上 namespace 的用法）：

```ts
export const LOAD_TOOLS_DESCRIPTION =
  'Load the full definitions of tools that are available but not yet in your tool list, so you can call them ' +
  'from your next step. Load only what your next step will call, all in one call: pass names (exact tool ' +
  'names), namespace (load a whole area, such as "lsp"), or query (keywords such as "rename symbol") and the ' +
  'best matches are loaded. A tool with no or obvious arguments can also be called directly without loading. ' +
  'Loading grants nothing: each loaded tool keeps its own permissions and approvals. The tools you can load, by ' +
  'namespace:';
```

`loadToolsTool`：

- schema 加 `namespace: { type: 'array', items: { type: 'string', pattern: '^[a-z]{1,32}$' }, minItems: 1, maxItems: 13 }`。
- 三个参数都没有时，报错文字改为 `'Pass names (exact tool names), namespace (an area from this tool\'s list) or query (keywords).'`。
- 先把 `namespace` 展开成名字，并入 `names`。有不认识的 namespace，且展开后什么都没有，就返回错误，列出全部 namespace 键；部分不认识的，在成功结果末尾加 `Unknown namespace: x.`。
- 成功结果在 `Loaded a, b; ...` 之后，每个加载的工具加一行 `- <name>: <describe(name) 的第一句>`（第一句取到第一个 `. ` 或换行为止；`describe` 没传或返回空时跳过这一行）。

`addLoadedTools`：读 `call.arguments?.namespace`，是数组时，把每个已知 namespace 的组内名字（且在 `deferrable` 里）加入 `loaded`。

`matchDeferredTools`：计分时，工具名和组提示之外，再匹配它所在组的 namespace 键，匹配上加 2 分，和匹配工具名同分。

`registry.ts` 新增：

```ts
  /** The registered tool of this name, for assembly code that reads or composes tools; not for dispatch. */
  tool(name: string): Tool | undefined {
    return this.entries.get(name)?.tool;
  }
```

`packages/catalog/index.ts`：`registry.register(loadToolsTool((name) => registry.offers(name)));` 改为同时传 `(name) => registry.tool(name)?.description`。

- [ ] **Step 4: 跑测试确认通过**

Run: `node scripts/run-tests.mjs tests/deferred-tools.test.ts tests/tool-restrict.test.ts`
Expected: PASS。如果现有用例断言了旧的目录格式（`- hint: names`），改成新格式。

- [ ] **Step 5: 更新快照**

Run: `npm run snapshot:update`，再看 `git diff tests/snapshots`：只应该是 `load_tools` 的描述和 schema 变了。

- [ ] **Step 6: 改 spec 并提交**

`docs/superpowers/specs/2026-10-31-tool-consolidation-design.md` 第 1 节"不再逐个列出组内工具名"一句，改为"每行以 namespace 键开头，组内工具名照旧列出，因为模型可以不经加载直接调用按需加载的工具，前提是知道名字"。

```bash
git add packages tests docs/superpowers/specs/2026-10-31-tool-consolidation-design.md
git commit -m "feat(tools): discover and load deferred tools by namespace"
```

---

### Task 2: 少用的工具移出首个请求

**Files:**

- Modify: `packages/tools/deferred-tools.ts`（新增 `memory` 组；`recall_knowledge` 并入 `knowledge` 组；`repo_map` 并入 `files` 组）
- Test: `tests/deferred-tools.test.ts`（追加）

- [ ] **Step 1: 记录改动前的基线**

Run: `npm run bench`，把输出里与工具 schema 字节数有关的几行，存到 `.scratch/tool-discovery-baseline.txt`。
Run: `node scripts/deferred-tool-usage.mjs .yuantu/sessions.sqlite`，结果也追加到同一个文件。

- [ ] **Step 2: 写失败的测试（追加）**

```ts
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createTools } from '../packages/catalog/index.ts';

test('the first request keeps save_memory and leaves the rarely used readers to load', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-first-request-'));
  const tools = createTools(root);
  t.after(() => tools.close?.());
  tools.toolMode = 'deferred';
  const first = tools.specs({ loaded: new Set() }).map((spec) => spec.name);
  assert.ok(first.includes('save_memory'));
  for (const name of [
    'list_memories',
    'read_memory',
    'forget_memory',
    'restore_memory',
    'recall_knowledge',
    'repo_map',
  ])
    assert.equal(first.includes(name), false, name);
  assert.deepEqual([...DEFERRED_NAMESPACES.get('memory')!].sort(), [
    'forget_memory',
    'list_memories',
    'read_memory',
    'restore_memory',
  ]);
});
```

（`tools.close` 的写法照 `tests/tool-concurrency-mode.test.ts` 的 teardown。）

Run: `node scripts/run-tests.mjs tests/deferred-tools.test.ts`
Expected: FAIL。

- [ ] **Step 3: 实现**

`DEFERRED_GROUPS` 里：

```ts
  /**
   * Reading and tidying memories. Saving stays sent — "remember this" is common, and a real-model comparison
   * showed the load round costing more than the schema — but reading, listing, forgetting and restoring were
   * never called in the sessions sampled for this change, and with recall they were a quarter of every request.
   */
  {
    namespace: 'memory',
    hint: 'saved memories (read, list, forget, restore; save_memory is always available)',
    names: ['read_memory', 'list_memories', 'forget_memory', 'restore_memory'],
  },
```

`knowledge` 组：`hint` 改为 `'knowledge base (recall, index, remove)'`，`names` 加上 `'recall_knowledge'`。
`files` 组：`hint` 加上 `repository map`，`names` 加上 `'repo_map'`。

改之前先用 Grep 查：系统提示词或别的工具描述里，有没有"用 `recall_knowledge` / `read_memory` / `repo_map`"这类指令（例如 `packages/core/prompt/notices.ts`、`packages/tools/repo-map.ts:367`）。有的话，措辞改成"可以加载 `memory` / `knowledge` namespace"，或者确认那段文字只在工具已加载时才出现。

- [ ] **Step 4: 跑测试、更新快照、量化**

Run: `node scripts/run-tests.mjs tests/deferred-tools.test.ts tests/runtime-context.test.ts tests/knowledge.test.ts`
Expected: PASS。
Run: `npm run snapshot:update`；`npm run bench`，把结果和基线对比，写进提交说明。如果 `npm run bench:check` 里有固定的 schema 字节阈值，按实际变化更新它，并在提交说明里写明原因。

- [ ] **Step 5: 真实模型对比（需要用户同意）**

问用户：是否用真实模型跑两类任务的对比，会花 API 额度。两类任务是"记住某件事"和"回忆之前记住的事"，各跑若干次，比较改动前后的轮数。用户同意后，用 `npm run acceptance:desktop` 或 `benchmarks/coding-evaluation` 里现有的真实模型入口（先读它们的说明，看怎么指定任务），记录结果。回忆类轮数如果明显变多，就把 `read_memory` 从 `memory` 组移回首轮发送，并重跑 Step 4。用户不同意，就在提交说明里写明"未做真实模型对比"。

- [ ] **Step 6: 提交**

```bash
git add packages tests benchmarks
git commit -m "feat(tools): load memory readers, recall and the repo map on demand"
```

---

### Task 3: 工具家族表与组合函数（只用于 LSP）

**Files:**

- Create: `packages/protocol/tool-families.ts`
- Modify: `packages/protocol/index.ts`（导出）
- Create: `packages/tools/tool-family.ts`
- Modify: `packages/tools/registry.ts`（导出 `toolSchemaErrorsText`）
- Test: `tests/tool-families.test.ts`

**Interfaces:**

- Produces（protocol）：
  - `export interface ToolFamily { name: string; actions: Readonly<Record<string, string>> }`
  - `export const TOOL_FAMILIES: readonly ToolFamily[]`：`lsp`、`lsp_edit` 两个
  - `export const TOOL_ALIASES: ReadonlyMap<string, { tool: string; action: string }>`：12 个旧 LSP 名
  - `export function resolveToolAlias<T extends { name: string; arguments: Record<string, unknown> }>(call: T): T`
  - `export function hookSubjects(tool: string, action: string | undefined): string[]`
  - `export function scopeAllowlist(names: readonly string[]): { tools: string[]; actions: Map<string, Set<string>> }`
- Produces（tools）：`export function composeFamily(family: ToolFamily, members: ReadonlyMap<string, Tool>, summary: string): Tool`

- [ ] **Step 1: 写失败的测试**

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import type { Tool } from '../packages/protocol/index.ts';
import {
  TOOL_FAMILIES,
  TOOL_ALIASES,
  resolveToolAlias,
  hookSubjects,
  scopeAllowlist,
} from '../packages/protocol/tool-families.ts';
import { composeFamily } from '../packages/tools/tool-family.ts';

test('the old language server names map to the family and action they became', () => {
  assert.deepEqual(TOOL_ALIASES.get('lsp_hover'), { tool: 'lsp', action: 'hover' });
  assert.deepEqual(TOOL_ALIASES.get('lsp_servers'), { tool: 'lsp', action: 'servers' });
  assert.deepEqual(TOOL_ALIASES.get('lsp_code_action'), { tool: 'lsp', action: 'code_actions' });
  assert.deepEqual(TOOL_ALIASES.get('lsp_rename'), { tool: 'lsp_edit', action: 'rename' });
  assert.equal(TOOL_ALIASES.has('lsp_start'), false);
  assert.equal(TOOL_ALIASES.size, 12);
  // No family keeps an old name, so an old rule can only ever be narrowed, never widened.
  for (const family of TOOL_FAMILIES) assert.equal(TOOL_ALIASES.has(family.name), false);
});

test('a call by an old name is rewritten; a current call is the same object', () => {
  assert.deepEqual(
    resolveToolAlias({
      id: 'c',
      name: 'lsp_definition',
      arguments: { path: 'a', line: 1, character: 1 },
    }),
    {
      id: 'c',
      name: 'lsp',
      arguments: { action: 'definition', path: 'a', line: 1, character: 1 },
    },
  );
  const current = { id: 'r', name: 'read_file', arguments: {} };
  assert.equal(resolveToolAlias(current), current);
});

test('hooks and allowlists read an old name as the one operation it was', () => {
  assert.deepEqual(hookSubjects('lsp', 'hover'), ['lsp_hover', 'lsp']);
  assert.deepEqual(hookSubjects('read_file', undefined), ['read_file']);
  const scoped = scopeAllowlist(['read_file', 'lsp_hover', 'lsp_edit', 'lsp.definition']);
  assert.deepEqual(scoped.tools.sort(), ['lsp', 'lsp_edit', 'read_file']);
  assert.deepEqual([...scoped.actions.get('lsp')!].sort(), ['definition', 'hover']);
  assert.equal(scoped.actions.has('lsp_edit'), false);
});

const signal = new AbortController().signal;
const tool = (
  name: string,
  properties: Record<string, unknown>,
  extra: Partial<Tool> = {},
): Tool => ({
  name,
  description: `does ${name}`,
  inputSchema: {
    type: 'object',
    properties,
    required: Object.keys(properties).slice(0, 1),
    additionalProperties: false,
  },
  execute: async (args) => ({ isError: false, content: `${name}:${JSON.stringify(args)}` }),
  ...extra,
});

test('a family dispatches by action and validates with the member schema', async () => {
  const merged = composeFamily(
    { name: 'thing', actions: { a: 'thing_a', b: 'thing_b' } },
    new Map([
      ['a', tool('thing_a', { path: { type: 'string' }, limit: { type: 'integer', maximum: 5 } })],
      ['b', tool('thing_b', { path: { type: 'string' }, limit: { type: 'integer', maximum: 50 } })],
    ]),
    'Thing operations.',
  );
  const schema = merged.inputSchema as { properties: Record<string, unknown>; required: string[] };
  assert.deepEqual(schema.required, ['action']);
  assert.deepEqual(schema.properties.limit, { type: 'integer' });
  assert.match(merged.description, /- a: does thing_a/);
  const prepared = await merged.prepare!({ action: 'b', path: 'x', limit: 40 }, {
    signal,
  } as never);
  assert.equal(
    (await prepared.execute({ signal } as never)).content,
    'thing_b:{"path":"x","limit":40}',
  );
  await assert.rejects(
    merged.prepare!({ action: 'a', path: 'x', limit: 40 }, { signal } as never),
    /action "a"/,
  );
  await assert.rejects(merged.prepare!({ action: 'zzz' }, { signal } as never), /a, b/);
});

test('members with different permissions, or an argument with two types, are build errors', () => {
  assert.throws(
    () =>
      composeFamily(
        { name: 's', actions: { a: 's_a', b: 's_b' } },
        new Map([
          ['a', tool('s_a', {})],
          ['b', tool('s_b', {}, { permission: 'command' })],
        ]),
        'S',
      ),
    /permission/,
  );
  assert.throws(
    () =>
      composeFamily(
        { name: 'x', actions: { a: 'x_a', b: 'x_b' } },
        new Map([
          ['a', tool('x_a', { id: { type: 'string' } })],
          ['b', tool('x_b', { id: { type: 'integer' } })],
        ]),
        'X',
      ),
    /id/,
  );
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node scripts/run-tests.mjs tests/tool-families.test.ts`
Expected: FAIL，找不到模块。

- [ ] **Step 3: 实现 `packages/protocol/tool-families.ts`**

```ts
/**
 * Tool families: tools offered as one, told apart by an `action` argument.
 *
 * Only the language server tools are merged: thirteen near-identical position queries were the one place where
 * separate names cost the model more than they told it. A family joins only tools with the same permission
 * (`Tool.permission` is per tool), which is why `lsp_start` stays apart. The table sits below every layer that
 * reads an old name — the registry, permission rules, hooks, the run loop's history — so they cannot disagree.
 */
export interface ToolFamily {
  name: string;
  /** Action → the tool that used to answer it. */
  actions: Readonly<Record<string, string>>;
}

export const TOOL_FAMILIES: readonly ToolFamily[] = [
  {
    name: 'lsp',
    actions: {
      diagnostics: 'lsp_diagnostics',
      definition: 'lsp_definition',
      references: 'lsp_references',
      hover: 'lsp_hover',
      symbols: 'lsp_symbols',
      workspace_symbols: 'lsp_workspace_symbols',
      code_actions: 'lsp_code_action',
      servers: 'lsp_servers',
      stop: 'lsp_stop',
    },
  },
  {
    name: 'lsp_edit',
    actions: { rename: 'lsp_rename', apply_code_action: 'lsp_apply_code_action' },
  },
];

/** Old member names, with what they mean now. Kept for one release. */
export const TOOL_ALIASES: ReadonlyMap<string, { tool: string; action: string }> = new Map(
  TOOL_FAMILIES.flatMap((family) =>
    Object.entries(family.actions).map(
      ([action, member]) => [member, { tool: family.name, action }] as const,
    ),
  ),
);

const FAMILIES_BY_NAME = new Map(TOOL_FAMILIES.map((family) => [family.name, family]));

/** The call as the current catalog names it; the same object when its name is current. */
export function resolveToolAlias<T extends { name: string; arguments: Record<string, unknown> }>(
  call: T,
): T {
  const alias = TOOL_ALIASES.get(call.name);
  if (!alias) return call;
  return { ...call, name: alias.tool, arguments: { action: alias.action, ...call.arguments } };
}

/** The names a hook matcher written before the merge may use for this call: the old member, then the family. */
export function hookSubjects(tool: string, action: string | undefined): string[] {
  const member = action === undefined ? undefined : FAMILIES_BY_NAME.get(tool)?.actions[action];
  return member ? [member, tool] : [tool];
}

/**
 * An allowlist in the merged catalog's terms. An entry is a tool name, a family name (every action),
 * `family.action`, or an old member name, which allows only the action it used to be: allowing `lsp_hover` must
 * not allow `stop`.
 */
export function scopeAllowlist(names: readonly string[]): {
  tools: string[];
  actions: Map<string, Set<string>>;
} {
  const tools = new Set<string>();
  const actions = new Map<string, Set<string>>();
  const whole = new Set<string>();
  const allowAction = (tool: string, action: string) => {
    tools.add(tool);
    actions.set(tool, (actions.get(tool) ?? new Set<string>()).add(action));
  };
  for (const entry of names) {
    const [name = '', action] = entry.split('.', 2);
    const family = FAMILIES_BY_NAME.get(name);
    if (family && action !== undefined) {
      if (family.actions[action]) allowAction(name, action);
      continue;
    }
    const alias = TOOL_ALIASES.get(name);
    if (alias) {
      allowAction(alias.tool, alias.action);
      continue;
    }
    tools.add(name);
    if (family) whole.add(name);
  }
  for (const name of whole) actions.delete(name);
  return { tools: [...tools], actions };
}
```

`packages/protocol/index.ts` 照它现有的导出风格，导出这个模块。

- [ ] **Step 4: 实现 `packages/tools/tool-family.ts`**

`registry.ts` 先新增导出（错误文字和注册表报参数错误时用同一个 Ajv 实例）：

```ts
/** Ajv's text for a schema's errors, worded the way the registry's own invalid-argument results are. */
export function toolSchemaErrorsText(errors: ValidateFunction['errors']): string {
  return schemaValidator.errorsText(errors);
}
```

```ts
import { isDeepStrictEqual } from 'node:util';
import type { PreparedTool, Tool, ToolContext, ToolFamily } from '../protocol/index.ts';
import { invalidArgumentsMessage } from './call-result.ts';
import { compileToolSchema, toolSchemaErrorsText } from './registry.ts';

type Properties = Record<string, Record<string, unknown>>;

/**
 * One tool for a family of tools, told apart by `action`.
 *
 * The members keep their implementations and schemas: the flat schema the model sees is the union of their
 * arguments, loose where they disagree, and each call is checked against the chosen member's schema before it
 * runs. Validation sits in `prepare` because the registry turns what `prepare` throws into the call's error result.
 */
export function composeFamily(
  family: ToolFamily,
  members: ReadonlyMap<string, Tool>,
  summary: string,
): Tool {
  const actions = [...members.keys()];
  if (!actions.length) throw new Error(`Tool family ${family.name} has no members`);
  const permissions = new Set([...members.values()].map((member) => member.permission));
  if (permissions.size > 1)
    throw new Error(`Tool family ${family.name}: members declare different permissions`);
  const permission = [...permissions][0];
  const properties: Properties = {};
  for (const member of members.values())
    for (const [key, value] of Object.entries(
      ((member.inputSchema as { properties?: Properties }).properties ?? {}) as Properties,
    )) {
      const seen = properties[key];
      if (!seen) properties[key] = value;
      else if (!isDeepStrictEqual(seen, value)) {
        if (seen.type !== value.type)
          throw new Error(`Tool family ${family.name}: argument ${key} has different types`);
        properties[key] = {
          type: seen.type,
          ...(typeof seen.description === 'string' ? { description: seen.description } : {}),
        };
      }
    }
  const dispatch = (args: Record<string, unknown>) => {
    const action = typeof args.action === 'string' ? args.action : undefined;
    const member = action === undefined ? undefined : members.get(action);
    if (!member) throw new Error(`${family.name} needs "action", one of: ${actions.join(', ')}`);
    const { action: _omitted, ...rest } = args;
    const validate = compileToolSchema(member.inputSchema);
    return {
      action: action!,
      member,
      rest,
      valid: validate(rest) === true,
      errors: validate.errors,
    };
  };
  const checked = (args: Record<string, unknown>) => {
    const call = dispatch(args);
    if (!call.valid)
      throw new Error(
        `Invalid arguments for ${family.name} action "${call.action}": ` +
          invalidArgumentsMessage(
            toolSchemaErrorsText(call.errors),
            call.errors,
            call.member.inputSchema,
          ),
      );
    return call;
  };
  const classifies = [...members.values()].some((member) => member.isConcurrencySafe);
  const effects = new Set([...members.values()].map((member) => member.effect));
  const graces = [...members.values()].flatMap((member) =>
    member.cancellationGraceMs === undefined ? [] : [member.cancellationGraceMs],
  );
  return {
    name: family.name,
    description:
      summary +
      '\n' +
      actions.map((action) => `- ${action}: ${members.get(action)!.description}`).join('\n'),
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: {
          type: 'string',
          enum: actions,
          description: 'Which operation to run; see the description for each.',
        },
        ...properties,
      },
      required: ['action'],
    },
    ...(permission ? { permission } : {}),
    ...(effects.size === 1 && [...effects][0] ? { effect: [...effects][0] } : {}),
    ...(graces.length ? { cancellationGraceMs: Math.max(...graces) } : {}),
    // Attached only when a member has one, so "declared nothing" keeps the registry's default reading.
    ...(classifies
      ? {
          isConcurrencySafe(args: Record<string, unknown>) {
            try {
              const call = dispatch(args);
              return call.valid && call.member.isConcurrencySafe?.(call.rest) === true;
            } catch {
              return false;
            }
          },
        }
      : {}),
    async prepare(args, context: ToolContext): Promise<PreparedTool> {
      const { member, rest } = checked(args);
      if (member.prepare) {
        const prepared = await member.prepare(rest, context);
        return prepared.approvalDescription || !member.approvalDescription
          ? prepared
          : { ...prepared, approvalDescription: member.approvalDescription };
      }
      return {
        ...(member.approvalDescription ? { approvalDescription: member.approvalDescription } : {}),
        execute: (scope) => member.execute(rest, scope),
      };
    },
    async execute(args, context) {
      const { member, rest } = checked(args);
      return member.execute(rest, context);
    },
  };
}
```

LSP 成员都没有 `requestsNetwork`，所以这里不处理它。`tool-family.ts` 从 `registry.ts` 导入，`registry.ts` 绝不能反过来导入它。

- [ ] **Step 5: 跑测试确认通过**

Run: `node scripts/run-tests.mjs tests/tool-families.test.ts`
Expected: PASS（5 个用例）。`npm run layers:check`、`npm run cycles:check` 通过。

- [ ] **Step 6: 提交**

```bash
git add packages/protocol packages/tools/tool-family.ts packages/tools/registry.ts tests/tool-families.test.ts
git commit -m "feat(tools): compose language server tools into action families"
```

---

### Task 4: 注册表认旧名，并支持按 action 限制

**Files:**

- Modify: `packages/tools/registry.ts`（`execute` 与 `executionMode` 开头改写旧名；`restrict` 加 `actions`；`specs()` 收窄 `action` 枚举；`forRun` 的 `allow` 改用 `scopeAllowlist`）
- Test: `tests/tool-families.test.ts`（追加）

- [ ] **Step 1: 写失败的测试（追加）**

```ts
import { ToolRegistry } from '../packages/tools/registry.ts';

const lspMember = (name: string) => ({
  name,
  description: name,
  inputSchema: { type: 'object', properties: {}, additionalProperties: false } as const,
  isConcurrencySafe: () => true,
  execute: async () => ({ isError: false, content: name }),
});
const lspRegistry = () => {
  const registry = new ToolRegistry();
  registry.register(
    composeFamily(
      TOOL_FAMILIES[0]!,
      new Map([
        ['hover', lspMember('lsp_hover')],
        ['servers', lspMember('lsp_servers')],
        ['stop', lspMember('lsp_stop')],
      ]),
      'Language server.',
    ),
  );
  return registry;
};

test('the registry runs a call by an old name as the family call it now is', async () => {
  const registry = lspRegistry();
  const signal = new AbortController().signal;
  const result = await registry.execute(
    { id: 'o', name: 'lsp_hover', arguments: {} },
    { signal, approve: async () => false },
  );
  assert.equal(result.content, 'lsp_hover');
  assert.equal(registry.executionMode({ id: 'p', name: 'lsp_hover', arguments: {} }), 'parallel');
});

test('an action-scoped restriction hides and refuses the other actions', async () => {
  const registry = lspRegistry();
  registry.restrict({ allow: ['lsp'], actions: new Map([['lsp', new Set(['hover'])]]) });
  const spec = registry.specs().find((s) => s.name === 'lsp')!;
  const schema = spec.inputSchema as { properties: { action: { enum: string[] } } };
  assert.deepEqual(schema.properties.action.enum, ['hover']);
  assert.doesNotMatch(spec.description, /- stop:/);
  const signal = new AbortController().signal;
  const refused = await registry.execute(
    { id: 's', name: 'lsp', arguments: { action: 'stop' } },
    { signal, approve: async () => true },
  );
  assert.equal(refused.isError, true);
  assert.match(refused.content, /action "stop" is not available in this run/);
});

test('a run copy with an action-scoped allowlist keeps the limit', () => {
  const copy = lspRegistry().forRun({ allow: ['lsp.hover'] });
  const spec = copy.specs().find((s) => s.name === 'lsp')!;
  assert.deepEqual(
    (spec.inputSchema as { properties: { action: { enum: string[] } } }).properties.action.enum,
    ['hover'],
  );
});
```

Run: `node scripts/run-tests.mjs tests/tool-families.test.ts`
Expected: 新用例 FAIL。

- [ ] **Step 2: 实现**

`execute(call, context)` 和 `executionMode(call)` 的第一行：

```ts
// A call by a name a tool family replaced (`../protocol/tool-families.ts`) runs as the family call it now is.
// An old name an embedder registered as its own tool is not rewritten: that tool still wins.
if (!this.entries.has(call.name)) call = resolveToolAlias(call);
```

（如果 `call` 不能重新赋值，就引入 `const resolved`，把函数里后面对 `call` 的引用都换成它。这样审批、钩子、文件日志看到的就都是新名。）

`restrict(scope)` 的参数加 `actions?: ReadonlyMap<string, ReadonlySet<string>>`，和 `allow`、`deny` 都能同时出现。注册表另存一个列表 `actionLimits: ReadonlyMap<string, ReadonlySet<string>>[]`，push 时连同 disposer 一起管理，和 `restrictions` 一样。新增私有方法：

```ts
  /** The actions of `name` this registry offers, or `undefined` when no restriction limits them. */
  private allowedActions(name: string): ReadonlySet<string> | undefined {
    let allowed: Set<string> | undefined;
    for (const limits of this.actionLimits) {
      const set = limits.get(name);
      if (!set) continue;
      allowed = allowed ? new Set([...allowed].filter((action) => set.has(action))) : new Set(set);
    }
    return allowed;
  }
```

- `execute`：在现有的 `if (!this.offers(call.name))` 检查之后，加上：如果 `allowedActions(call.name)` 有值，且 `call.arguments.action` 不在其中，就返回 `` `Tool "${call.name}" action "${String(call.arguments.action)}" is not available in this run; it is excluded by a restriction. Do not retry it.` ``。
- `specs()`：生成每个 spec 时，如果该工具有 action 限制，就复制一份 `inputSchema`，把 `properties.action.enum` 过滤成允许的值；`description` 按行过滤，去掉以 `- <不允许的 action>:` 开头的行。
- `forRun({ allow })`：先 `const scoped = scopeAllowlist(options.allow)`，用 `scoped.tools` 走原来按条目绑定的 deny 逻辑；`scoped.actions` 非空时，再给副本 push 一份 action 限制。父注册表已有的 `actionLimits` 也要复制到副本，和 `restrictions` 的处理保持一致：先看 `forRun` 现在有没有复制 `restrictions`，照它做。

- [ ] **Step 3: 跑测试确认通过**

Run: `node scripts/run-tests.mjs tests/tool-families.test.ts tests/tool-restrict.test.ts tests/run-scoped-tools.test.ts tests/tool-concurrency-mode.test.ts`
Expected: PASS。

- [ ] **Step 4: 提交**

```bash
git add packages/tools/registry.ts tests/tool-families.test.ts
git commit -m "feat(tools): run old language server names and limit a run to some actions"
```

---

### Task 5: 在目录里合并 LSP

**Files:**

- Modify: `packages/tools/tool-family.ts`（加 `mergeToolFamilies`）
- Modify: `packages/catalog/index.ts`（注册完之后调用；`YUANTU_TOOL_ALLOWLIST` 改用 `scopeAllowlist`）
- Modify: `packages/tools/tool-categories.ts`、`packages/tools/deferred-tools.ts`（`lsp` 组）、`packages/core/subagents/contract.ts`（`EXPLORE_TOOLS`）
- Test: `tests/tool-families.test.ts`（追加）

- [ ] **Step 1: 写失败的测试（追加）**

```ts
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createTools } from '../packages/catalog/index.ts';
import { EXPLORE_TOOLS } from '../packages/core/subagents/contract.ts';

test('the catalog offers lsp, lsp_start and lsp_edit and no old language server name', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-lsp-family-'));
  const tools = createTools(root);
  t.after(() => tools.close?.());
  const names = tools.specs().map((spec) => spec.name);
  assert.deepEqual(names.filter((name) => name.startsWith('lsp')).sort(), [
    'lsp',
    'lsp_edit',
    'lsp_start',
  ]);
  const readOnly = tools.specs({ readOnly: true }).map((spec) => spec.name);
  assert.ok(readOnly.includes('lsp'));
  assert.equal(readOnly.includes('lsp_edit'), false);
  assert.equal(readOnly.includes('lsp_start'), false);
  // A read-only child never had the server managers; it still has every query.
  const child = tools.forRun({ allow: EXPLORE_TOOLS });
  const lsp = child.specs().find((spec) => spec.name === 'lsp')!;
  const actions = (lsp.inputSchema as { properties: { action: { enum: string[] } } }).properties
    .action.enum;
  assert.deepEqual(actions.sort(), [
    'code_actions',
    'definition',
    'diagnostics',
    'hover',
    'references',
    'symbols',
    'workspace_symbols',
  ]);
});
```

Run: `node scripts/run-tests.mjs tests/tool-families.test.ts`
Expected: FAIL。

- [ ] **Step 2: 实现**

`tool-family.ts` 加：

```ts
/** One line per family, in front of the per-action lines `composeFamily` adds. */
export const FAMILY_SUMMARIES: Readonly<Record<string, string>> = {
  lsp:
    'Ask a language server about code: diagnostics, definitions, references, hover, symbols and the code actions ' +
    'offered at a position; also list running servers or stop one. Start a server with lsp_start first.',
  lsp_edit:
    'Apply a language server edit: rename a symbol, or apply a code action listed by lsp (action "code_actions").',
};

/**
 * Replace each family's registered members with the family tool. Runs after every tool is registered, so a family
 * offers exactly the members this host has, and one with none is not registered.
 */
export function mergeToolFamilies(registry: ToolRegistry): void {
  for (const family of TOOL_FAMILIES) {
    const members = new Map<string, Tool>();
    for (const [action, name] of Object.entries(family.actions)) {
      const tool = registry.tool(name);
      if (tool) members.set(action, tool);
    }
    if (!members.size) continue;
    for (const name of Object.values(family.actions)) registry.remove(name);
    registry.register(composeFamily(family, members, FAMILY_SUMMARIES[family.name] ?? family.name));
  }
}
```

`packages/catalog/index.ts`：

- 在 `return registry;` 之前调用 `mergeToolFamilies(registry);`。
- `YUANTU_TOOL_ALLOWLIST` 拆出名字后交给 `scopeAllowlist`，调用 `registry.restrict({ allow: scoped.tools, ...(scoped.actions.size ? { actions: scoped.actions } : {}) })`。
- `MUTATION_TOOLS`（第 56 行）不用改：`attachDiagnostics` 包的是成员，合并发生在注册之后。

`tool-categories.ts`：删掉 12 个旧 LSP 名，加 `['lsp', c('lsp')]`、`['lsp_edit', c('lsp')]`，`lsp_start` 不变。

`deferred-tools.ts` 的 `lsp` 组：`names: ['lsp', 'lsp_start', 'lsp_edit']`，`hint` 保持操作关键词：`'language server (definitions, references, hover, symbols, diagnostics, rename, code actions)'`。

`contract.ts` 的 `EXPLORE_TOOLS`：删掉 7 个 LSP 查询名，换成 `'lsp.diagnostics'`、`'lsp.definition'`、`'lsp.references'`、`'lsp.hover'`、`'lsp.symbols'`、`'lsp.workspace_symbols'`、`'lsp.code_actions'`，并在注释里说明这是按操作限权：没有 `servers` 和 `stop`。用 Grep 查 `EXPLORE_TOOLS` 的其他使用方（例如 `scripts/docs-facts.mjs` 量字节数、`delegation.ts` 的 `toolFilter`、`subprocess.ts` 拼环境变量），确认它们把条目当作"白名单条目"而不是"工具名"处理；只把它当工具名用的地方，改成先经 `scopeAllowlist`。

- [ ] **Step 3: 跑测试确认通过**

Run: `node scripts/run-tests.mjs tests/tool-families.test.ts tests/tool-concurrency-mode.test.ts tests/lsp.test.ts tests/subagent-providers.test.ts`
Expected: `tool-families` PASS。直接按旧 LSP 名从 `createTools()` 取工具、或断言旧名清单的测试会失败，逐个改成新名加 `action`。`tests/lsp.test.ts` 如果是直接用 `lspTools()` 构造工具，就不受影响。

- [ ] **Step 4: 提交**

```bash
git add packages tests
git commit -m "feat(catalog): offer the language server as lsp, lsp_start and lsp_edit"
```

---

### Task 6: 旧 LSP 名在规则、钩子、加载和历史里继续有效

**Files:**

- Modify: `packages/protocol/permission-policy.ts`（编译规则前改写旧名）
- Modify: `packages/resources/hook-bridge.ts`（matcher 按 `hookSubjects` 匹配；payload 加 `tool_action`）
- Modify: `packages/tools/deferred-tools.ts`（`load_tools` 认旧名；`addLoadedTools` 换算旧名；搜索匹配旧成员名与 action）
- Modify: `packages/protocol/tool-families.ts`（加 `rewriteToolHistory`）
- Modify: `packages/core/run/request.ts:431` 附近
- Test: `tests/tool-families.test.ts`、`tests/deferred-tools.test.ts:153,185`、`tests/providers.test.ts`（追加）

旧 LSP 名和新名不会同名，所以权限规则不用分版本：旧名规则改写成新名加 `action` 之后，只会缩窄，不会放大授权范围。

- [ ] **Step 1: 写失败的测试**

追加到 `tests/tool-families.test.ts`：

```ts
import { PermissionPolicy } from '../packages/protocol/permission-policy.ts';
import { rewriteToolHistory } from '../packages/protocol/tool-families.ts';

test('a rule for an old language server name governs only that action', () => {
  const policy = new PermissionPolicy({
    version: 1,
    rules: [
      { effect: 'ask', kind: 'write' },
      { effect: 'allow', tool: 'lsp_rename' },
    ],
  });
  const approval = (action: string) => ({
    kind: 'write' as const,
    description: '',
    toolCall: {
      id: 'x',
      name: 'lsp_edit',
      arguments: { action, path: 'a.ts', line: 1, character: 1 },
    },
  });
  assert.equal(policy.decide(approval('rename')), 'allow');
  assert.equal(policy.decide(approval('apply_code_action')), 'ask');
  assert.equal(policy.deniesEveryCall({ name: 'lsp_edit', permission: 'write' }), false);
});

test('history calls by old names are rewritten and lose the native state they no longer match', () => {
  const current = [{ role: 'user' as const, content: 'hi' }];
  assert.equal(rewriteToolHistory(current), current);
  const rewritten = rewriteToolHistory([
    {
      role: 'assistant',
      content: '',
      toolCalls: [{ id: 'h', name: 'lsp_hover', arguments: { path: 'a', line: 1, character: 1 } }],
      providerState: {
        protocol: 'openai-responses',
        output: [{ type: 'function_call', name: 'lsp_hover' }],
      },
    },
  ]);
  assert.equal((rewritten[0] as { toolCalls: { name: string }[] }).toolCalls[0]!.name, 'lsp');
  assert.equal('providerState' in rewritten[0]!, false);
});
```

`tests/deferred-tools.test.ts`：

- 第 153 行 `matchDeferredTools('rename symbol', DEFERRED_TOOLS)[0]` 的期望从 `'lsp_rename'` 改为 `'lsp_edit'`；
- 第 185 行附近 `loader.execute({ query: 'rename symbol' })` 的期望同样改为 `lsp_edit`；
- 新增：`loader.execute({ names: ['lsp_hover'] })` 成功，结果里写着加载的是 `lsp`，并提示 `lsp_hover is now lsp (action: hover)`；
- 新增：`loadedTools`，历史里有 `load_tools({ names: ['lsp_hover'] })` 时，结果包含 `lsp`；
- 新增：`matchDeferredTools('hover', DEFERRED_TOOLS)[0] === 'lsp'`。

`tests/providers.test.ts`：照这个文件里截获请求体的现有写法，给 Responses、OpenAI Chat、Anthropic 三个适配器各加一个用例：

- 历史里一条 assistant 消息调用 `lsp_hover`，并带有和当前连接、模型、端点都匹配的 `providerState`（Responses 用 `output`，另外两种用各自的原生字段和 `messageHash`）；
- 先经 `rewriteToolHistory`，再交给适配器；
- 断言实际请求体里出现 `"lsp"`，并且**完全不含** `lsp_hover`。

Responses 适配器在 `providerState` 匹配时直接回放 `state.output`（`packages/providers/responses.ts:112-120`），不看 `toolCalls`，这组用例就是为了锁住"改写后去掉原生状态"。

Run: `node scripts/run-tests.mjs tests/tool-families.test.ts tests/deferred-tools.test.ts tests/providers.test.ts`
Expected: 新用例和改过的用例 FAIL。

- [ ] **Step 2: 实现**

`tool-families.ts`：

```ts
/**
 * The transcript as the current catalog names it. A session recorded before the merge holds calls by old names,
 * and a provider may refuse a history that calls a tool its request does not declare; rewriting on the way out
 * keeps the stored log as it happened. A rewritten message drops its native provider state: that state replays
 * the original calls verbatim (Responses sends `output` as it was) or is bound to them by hash.
 */
export function rewriteToolHistory<
  M extends {
    role: string;
    toolCalls?: readonly { name: string; arguments: Record<string, unknown> }[];
    providerState?: unknown;
  },
>(messages: readonly M[]): readonly M[] {
  const stale = (m: M) =>
    m.role === 'assistant' && m.toolCalls?.some((c) => TOOL_ALIASES.has(c.name));
  if (!messages.some(stale)) return messages;
  return messages.map((m) => {
    if (!stale(m)) return m;
    const { providerState: _dropped, ...rest } = m;
    return { ...rest, toolCalls: m.toolCalls!.map((c) => resolveToolAlias(c)) } as M;
  });
}
```

`request.ts`：发请求前 `const history = rewriteToolHistory(context.messages);`，用 `history` 代替 `context.messages`。`packages/core/context/context.ts:557` 的压缩请求如果带 `tools`，也做同样处理；不带就不改，并加一句注释说明原因。

`permission-policy.ts`：规则校验通过之后、生成编译结果之前，逐条换算：

```ts
const alias = rule.tool === undefined ? undefined : TOOL_ALIASES.get(rule.tool);
if (alias)
  rule = rule.arguments
    ? { ...rule, tool: alias.tool, arguments: { action: alias.action, ...rule.arguments } }
    : { ...rule, tool: alias.tool, match: { ...(rule.match ?? {}), action: alias.action } };
```

`deniesEveryCall` 要求规则不带 `match` 和 `arguments`，换算后的 deny 规则带着 `match`，不会把整个工具藏起来，不用改。

`hook-bridge.ts`：在 `dispatch` 里，把 `hookMatcherMatches(declaration.matcher, subject)` 改成 `hookSubjects(subject, action)` 里任何一个匹配即可；`action` 取自 payload 里的 `tool_input.action`（看 `hook-bridge.ts:232` 附近 payload 是怎么组的）。合并工具的 payload 加 `tool_action`。

`deferred-tools.ts`：

- `loadToolsTool` 执行时：`names` 逐个换算 `TOOL_ALIASES.get(name)?.tool ?? name` 再去重；有换算的，在成功结果里加 `` `${old} is now ${tool} (action: ${action}).` ``。
- `addLoadedTools`：两处 `deferrable.has(name)` 之前，先换算旧名。
- `matchDeferredTools`：工具属于某个家族时，它的 action 名和旧成员名也参与匹配，权重和工具名相同（2 分）。

- [ ] **Step 3: 跑测试确认通过**

Run: `node scripts/run-tests.mjs tests/tool-families.test.ts tests/deferred-tools.test.ts tests/providers.test.ts tests/hook-bridge.test.ts tests/hooks.test.ts tests/host-hook-policy.test.ts`
再用 Glob 找 `tests/*permission*` 一并跑。
Expected: PASS。

- [ ] **Step 4: 提交**

```bash
git add packages tests
git commit -m "feat: keep old language server names working in rules, hooks, loads and history"
```

---

### Task 7: 模型看到的 LSP 文字

**Files:**

- Modify: `packages/lsp/tools.ts:202,414`、`packages/lsp/tool-support.ts:99,527,537,611`、`packages/tools/repo-map.ts:367,642`，以及排查出来的其他地方

- [ ] **Step 1: 排查**

```bash
grep -rnE "\blsp_(servers|stop|diagnostics|definition|references|hover|symbols|workspace_symbols|rename|code_action|apply_code_action)\b" packages apps --include=*.ts --include=*.tsx
```

只改会发给模型的字符串：工具描述、错误结果文字、提示词。例如：

- `call lsp_start first` 不变（`lsp_start` 没改名）；
- `listed by lsp_code_action` → `listed by lsp (action "code_actions")`；
- `Run lsp_code_action again` → `Run lsp with action "code_actions" again`；
- `use repo_map or lsp_symbols for detail` → `use repo_map or lsp (action "symbols") for detail`。

注释里描述行为的旧名（例如 `lsp/manager.ts:114`），也顺手改成新写法。

- [ ] **Step 2: 确认并提交**

再跑一遍 Step 1 的 grep：字符串里不应该再出现旧名，只剩 `tool-families.ts` 里的别名表，以及 `lspTools()` 里成员自己的 `name:` 定义。
Run: `node scripts/run-tests.mjs tests/lsp.test.ts tests/repo-map.test.ts`（以实际存在的文件为准）。
Run: `npm run snapshot:update`，确认快照里只有这些措辞变了。

```bash
git add packages tests
git commit -m "fix(lsp): name the merged tools in what the model reads"
```

---

### Task 8: 精简过大的工具描述

**Files:**

- Modify: `save_memory`（`packages/knowledge/tools.ts`）、`ask_user_question`（`packages/tools/question.ts`）、`run_command`（`packages/tools/command.ts`）、`run_code`（`packages/tools/run-code.ts`）的 `description` 和参数说明

- [ ] **Step 1: 逐个看描述里每句话是干什么的**

对每个工具：

- 列出描述里的每一句；
- 用 `git log -S "<这句话里的关键词>" --oneline -- <文件>` 查它是哪次提交加的；
- 是修某个真实问题加的（提交说明或代码注释里能找到对应的问题），就保留；
- 只是重复参数说明的，挪进对应参数的 `description`；
- 和相邻工具的区别（例如 `run_command` 和 `start_command`、`run_code` 的分工），要保留，用一句话说清楚。

把分析结果写在提交说明里：每个工具删了哪些、挪了哪些、为什么保留了哪些。

- [ ] **Step 2: 改并验证**

Run: 和这几个工具行为相关的测试（`tests/question*.test.ts`、`tests/command*.test.ts`、`tests/run-code*.test.ts`、`tests/knowledge.test.ts`，以实际存在的文件为准）。
Run: `npm run snapshot:update`，确认快照里只有这几段描述变了；用 `npm run docs:generate` 看首个请求的字节数变化。

- [ ] **Step 3: 提交**

```bash
git add packages tests
git commit -m "docs(tools): trim the largest always-sent descriptions"
```

---

### Task 9: README、生成事实与全量验证

- [ ] **Step 1: 改 README**

- 工具一节：LSP 一行写 `lsp`（列出各操作）、`lsp_start`、`lsp_edit`（`rename`、`apply_code_action`）；加一小段"旧 LSP 工具名"：在一个版本内照旧能用（包括权限规则、工具白名单和钩子 matcher），附"旧名 → 新名 + action"的对照表，内容和 `packages/protocol/tool-families.ts` 一致。
- 按需加载一节：说明 namespace，以及 `load_tools` 的三种用法（`names`、`namespace`、`query`）；更新"哪些工具首轮就发"的说明（记忆的读取类工具、`recall_knowledge`、`repo_map` 改为按需加载）。
- 工具白名单（`YUANTU_TOOL_ALLOWLIST`）：说明可以写 `lsp.hover` 这种按操作的条目，写旧名只放开原来那个操作。
- 钩子：payload 新增 `tool_action`。

- [ ] **Step 2: 生成事实与快照**

Run: `npm run docs:generate`，然后 `npm run docs:check`。预期：全部工具 57 个（含终端），首个请求 20 个。数字不一样时，先找出原因再改，不要直接照抄生成结果。
Run: `npm run snapshot:update`。

- [ ] **Step 3: 全量验证**

Run: `npm run typecheck`、`npm run lint`、`npx prettier --check . --log-level warn`、`npm run layers:check`、`npm run cycles:check`、`npm run references:check`、`npm run i18n:check`、`npm run audit:check`、`npm run build`
Run: `FOUNDRY_TEST_CONTINUE_ON_FAILURE=1 npm test`
Expected: 全部通过；日志里 `Phase parallel` 和 `Phase serial` 的文件数加起来等于测试文件总数。

人工验收（本机测不了，在提交说明里写明结果或写明未验证）：用真实的 Anthropic 连接、开启 thinking，续接一个历史里带旧 LSP 名、停在工具循环中途的会话，确认请求被接受。

- [ ] **Step 4: 提交**

提交说明里写上：首个请求的字节数和工具数、`load_tools` 描述的字节数，改动前 → 改动后（数字来自 Task 2 Step 1 的基线和本次的 `docs:generate`）；Task 2 Step 5 的真实模型对比结果，或写明未做。

```bash
git add README.md tests/snapshots
git commit -m "docs: describe namespaces, on-demand tools and the language server tools"
```

---

## Self-Review 记录

- Spec 覆盖：
  - 第 1 节 namespace → Task 1；
  - 第 2 节首轮调整，含基线和真实模型对比 → Task 2；
  - 第 3 节 LSP 合并，以及它的兼容项（注册表、按操作限权、白名单、权限规则、钩子、按需加载、历史与三个适配器、模型可见文字）→ Task 3–7；
  - 第 4 节精简描述 → Task 8；
  - 第 5 节不做的事：计划里没有其他合并，`browser_close` 不动；
  - 测试 → 各任务；
  - 量化 → Task 2、9。
- 和 spec 的差异：目录里保留组内工具名（见开头说明），Task 1 Step 6 同步改 spec。
- 吸收了上一版计划的评审意见：白名单按操作限制；旧名规则只缩窄不放大，而且这次没有新旧同名的情况，不需要给权限策略分版本；历史改写去掉原生状态，并在三个适配器层面验证；`load_tools` 认旧名，搜索匹配操作关键词；排查模型看得到的文字。自动验收按 `terminal_send` 识别的问题，这次不涉及，因为终端工具不合并。
