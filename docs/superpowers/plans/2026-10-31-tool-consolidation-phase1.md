# 工具收敛第一阶段 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 按功能族合并工具，把空工作区注册的工具从 67 个减到 39 个，首个请求从 26 个减到 20 个。不删能力（`browser_close` 除外），旧名在一个版本内继续能用。

**Architecture:** 现有工具的实现一行不改。`createTools()` 注册完全部工具后，再调用 `mergeToolFamilies(registry)`：把同一功能族的成员取出、移除，组合成一个按 `action` 分派的工具重新注册。旧名到"新名 + action"的映射放在 protocol 层的一张静态表里，注册表执行、并发判断、权限规则、钩子匹配、按需加载记录、历史消息都经它改写。

**Tech Stack:** TypeScript（Node 24 直接跑 `.ts`）、`node:test`、Ajv。

**Spec:** `docs/superpowers/specs/2026-10-31-tool-consolidation-design.md`

## Global Constraints

- 只合并权限声明相同的工具；唯一的例外是 `lsp_server`，它显式声明为 `command`，比成员原来的权限更严格。
- 合并后的工具用扁平 schema：`action` 是枚举，其余参数平铺在同一层；不使用 `oneOf`/`anyOf`/`if`。各 `action` 自己的参数校验在合并工具的 `prepare` 里，用成员原来的 schema 做。
- 一个家族里有成员没注册（比如在子目录工作区里没有 Git 工具、宿主没给终端管理器），合并工具只包含已注册的成员；一个成员都没有就不注册。
- 分阶段只跑定向测试：`node scripts/run-tests.mjs <文件>`；全量放在最后，用 `FOUNDRY_TEST_CONTINUE_ON_FAILURE=1 npm test` 跑完整一轮（本地默认遇到失败就停）。
- 在 Windows 上改文件一律用编辑工具，避免 CRLF。
- README 自成一体，不链接 `docs/`。
- 每个任务结束提交一次，提交信息结尾加 `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`。
- 第二阶段的工具（`run_command`、`start_command`、`write_command`、`run_code`、`job_*`）本计划不动。

## 家族表（全计划的唯一来源）

| 新名             | 成员（action → 旧名）                                                                                                                                                                                        | 默认 action | 权限            | 查询 |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------- | --------------- | ---- |
| `git`            | status→`git_status`、diff→`git_diff`、log→`git_log`、branches→`git_branches`、worktrees→`git_worktrees`                                                                                                      | —           | —               | 是   |
| `git_change`     | stage→`git_stage`、commit→`git_commit`、worktree_create→`git_worktree_create`                                                                                                                                | —           | command         | 否   |
| `lsp`            | diagnostics→`lsp_diagnostics`、definition→`lsp_definition`、references→`lsp_references`、hover→`lsp_hover`、symbols→`lsp_symbols`、workspace_symbols→`lsp_workspace_symbols`、code_actions→`lsp_code_action` | —           | —               | 否   |
| `lsp_server`     | list→`lsp_servers`、start→`lsp_start`、stop→`lsp_stop`                                                                                                                                                       | —           | command（显式） | 否   |
| `lsp_edit`       | rename→`lsp_rename`、apply_code_action→`lsp_apply_code_action`                                                                                                                                               | —           | write           | 否   |
| `terminal_read`  | read→`terminal_read`、list→`terminal_list`                                                                                                                                                                   | read        | —               | 否   |
| `terminal`       | open→`terminal_open`、send→`terminal_send`、signal→`terminal_signal`、close→`terminal_close`                                                                                                                 | —           | command         | 否   |
| `browser`        | open→`browser_open`、click→`browser_click`、fill→`browser_fill`                                                                                                                                              | —           | external        | 否   |
| `read_memory`    | read→`read_memory`、list→`list_memories`                                                                                                                                                                     | read        | —               | 是   |
| `save_memory`    | save→`save_memory`、forget→`forget_memory`、restore→`restore_memory`                                                                                                                                         | save        | write           | 否   |
| `index_document` | add→`index_document`、remove→`remove_indexed_document`                                                                                                                                                       | add         | write           | 否   |
| `manage_file`    | move→`move_file`、delete→`delete_file`                                                                                                                                                                       | —           | write           | 否   |
| `edit_file`      | replace→`edit_file`、batch→`batch_edit`                                                                                                                                                                      | replace     | write           | 否   |

`browser_close` 不注册，也没有别名。`repo_map` 不合并，改为按需加载。

有默认 action 的家族，新名和某个旧成员同名（`terminal_read`、`read_memory`、`save_memory`、`index_document`、`edit_file`）。旧调用不带 `action` 时走默认 action，行为和原来完全一样，所以这些同名的旧名不需要别名。

---

### Task 1: 家族表与别名解析（protocol 层）

**Files:**

- Create: `packages/protocol/tool-families.ts`
- Modify: `packages/protocol/index.ts`（导出）
- Test: `tests/tool-families.test.ts`

**Interfaces:**

- Produces:
  - `export interface ToolFamily { name: string; actions: Readonly<Record<string, string>>; defaultAction?: string; permission?: 'write' | 'command' | 'external'; query?: boolean }`
  - `export const TOOL_FAMILIES: readonly ToolFamily[]`（内容即上面的家族表）
  - `export const TOOL_ALIASES: ReadonlyMap<string, { tool: string; action: string }>`：所有"旧名 ≠ 新名"的成员
  - `export const MEMBER_SCOPES: ReadonlyMap<string, { tool: string; action: string }>`：**所有**成员旧名（包括和家族同名的 `save_memory`、`edit_file` 等）→ 它在合并后对应的"家族 + action"。旧权限规则和旧白名单要把授权限定到原来那一个操作，靠的就是这张表；`TOOL_ALIASES` 只管"这个名字已经不是工具名了"
  - `export function resolveToolAlias<T extends { name: string; arguments: Record<string, unknown> }>(call: T): T`：把调用规范化成合并后的形式。旧名改写成新名，并把 `action` 放进参数（参数里已有 `action` 时不覆盖）；调用的是有默认 action 的家族、但没带 `action` 时，补上默认 action。什么都不用改时，原样返回同一个对象。这样审批、权限规则和钩子看到的调用一定带着 `action`
  - `export function scopeAllowlist(names: readonly string[]): { tools: string[]; actions: Map<string, Set<string>> }`：按合并后的目录解释白名单。条目可以是工具名、家族名（全部 action）、`家族.action`，或成员旧名（只允许它原来那一个 action）。保留了成员名的家族（如 `save_memory`）在这里按家族名处理，即允许全部 action，每次调用仍由权限策略决定
  - `export function hookSubjects(tool: string, action: string | undefined): string[]`：钩子 matcher 可以用来匹配这次调用的名字。规则是：这个 action 原来对应的成员名；家族名不和任何成员同名时，再加上家族名。这样 matcher 写 `save_memory` 的旧钩子，不会在 `forget` 时触发

- [ ] **Step 1: 写失败的测试**

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  TOOL_FAMILIES,
  TOOL_ALIASES,
  MEMBER_SCOPES,
  resolveToolAlias,
  hookSubjects,
  scopeAllowlist,
} from '../packages/protocol/tool-families.ts';

test('every old member name resolves to its family and action', () => {
  assert.deepEqual(TOOL_ALIASES.get('git_status'), { tool: 'git', action: 'status' });
  assert.deepEqual(TOOL_ALIASES.get('lsp_code_action'), { tool: 'lsp', action: 'code_actions' });
  assert.deepEqual(TOOL_ALIASES.get('terminal_list'), { tool: 'terminal_read', action: 'list' });
  assert.deepEqual(TOOL_ALIASES.get('batch_edit'), { tool: 'edit_file', action: 'batch' });
  // A member that shares its family's name is reached through the default action, not an alias.
  assert.equal(TOOL_ALIASES.has('edit_file'), false);
  assert.equal(TOOL_ALIASES.has('read_memory'), false);
  assert.equal(TOOL_ALIASES.has('browser_close'), false);
});

test('a call by an old name is rewritten; a call by a current name is left alone', () => {
  const old = { id: 'c1', name: 'git_diff', arguments: { mode: 'staged' } };
  assert.deepEqual(resolveToolAlias(old), {
    id: 'c1',
    name: 'git',
    arguments: { action: 'diff', mode: 'staged' },
  });
  const current = { id: 'c2', name: 'read_file', arguments: { path: 'a' } };
  assert.equal(resolveToolAlias(current), current);
  // A family call without action is given its default, so rules and hooks always see which operation it is.
  assert.deepEqual(
    resolveToolAlias({ id: 'c3', name: 'save_memory', arguments: { key: 'k' } }).arguments,
    {
      action: 'save',
      key: 'k',
    },
  );
});

test('every member, including one that kept its name, is scoped to the action it used to be', () => {
  assert.deepEqual(MEMBER_SCOPES.get('save_memory'), { tool: 'save_memory', action: 'save' });
  assert.deepEqual(MEMBER_SCOPES.get('edit_file'), { tool: 'edit_file', action: 'replace' });
  assert.deepEqual(MEMBER_SCOPES.get('git_stage'), { tool: 'git_change', action: 'stage' });
  assert.equal(MEMBER_SCOPES.has('read_file'), false);
});

test('an allowlist naming an old member allows only the action it used to be', () => {
  const scoped = scopeAllowlist(['read_file', 'git_stage', 'lsp', 'git.status', 'save_memory']);
  assert.deepEqual(scoped.tools.sort(), ['git', 'git_change', 'lsp', 'read_file', 'save_memory']);
  assert.deepEqual([...scoped.actions.get('git_change')!], ['stage']);
  assert.deepEqual([...scoped.actions.get('git')!], ['status']);
  // A family named whole carries no action limit.
  assert.equal(scoped.actions.has('lsp'), false);
  assert.equal(scoped.actions.has('save_memory'), false);
});

test('the table is consistent: unique names, members never reused, defaults are real actions', () => {
  const names = TOOL_FAMILIES.map((family) => family.name);
  assert.equal(new Set(names).size, names.length);
  const members = TOOL_FAMILIES.flatMap((family) => Object.values(family.actions));
  assert.equal(new Set(members).size, members.length);
  for (const family of TOOL_FAMILIES)
    if (family.defaultAction) assert.ok(family.actions[family.defaultAction], family.name);
  assert.deepEqual(hookSubjects('terminal', 'send'), ['terminal_send', 'terminal']);
  assert.deepEqual(hookSubjects('save_memory', 'forget'), ['forget_memory']);
  assert.deepEqual(hookSubjects('read_file', undefined), ['read_file']);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node scripts/run-tests.mjs tests/tool-families.test.ts`
Expected: FAIL，找不到模块。

- [ ] **Step 3: 实现**

```ts
/**
 * Tool families: several old tools offered as one, told apart by an `action` argument.
 *
 * The table lives here, below every layer that has to read it — the registry rewrites a call by an old name, a
 * permission rule written for an old name is rewritten the same way, and the run loop rewrites history — so they
 * cannot disagree about what an old name means. A family only joins tools that declare the same permission
 * (`Tool.permission` is per tool, and read-only runs and approvals depend on it); `lsp_server` is the one family
 * that declares a stricter permission than some of its members had.
 */
export interface ToolFamily {
  name: string;
  /** Action → the tool that used to answer it. */
  actions: Readonly<Record<string, string>>;
  /** The action a call without `action` means; set where the family keeps an old member's name. */
  defaultAction?: string;
  /** Declared instead of the members' own, when it is stricter. */
  permission?: 'write' | 'command' | 'external';
  /** Every action is a query, so the family is one too. */
  query?: boolean;
}

export const TOOL_FAMILIES: readonly ToolFamily[] = [
  {
    name: 'git',
    query: true,
    actions: {
      status: 'git_status',
      diff: 'git_diff',
      log: 'git_log',
      branches: 'git_branches',
      worktrees: 'git_worktrees',
    },
  },
  {
    name: 'git_change',
    actions: { stage: 'git_stage', commit: 'git_commit', worktree_create: 'git_worktree_create' },
  },
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
    },
  },
  {
    name: 'lsp_server',
    permission: 'command',
    actions: { list: 'lsp_servers', start: 'lsp_start', stop: 'lsp_stop' },
  },
  {
    name: 'lsp_edit',
    actions: { rename: 'lsp_rename', apply_code_action: 'lsp_apply_code_action' },
  },
  {
    name: 'terminal_read',
    defaultAction: 'read',
    actions: { read: 'terminal_read', list: 'terminal_list' },
  },
  {
    name: 'terminal',
    actions: {
      open: 'terminal_open',
      send: 'terminal_send',
      signal: 'terminal_signal',
      close: 'terminal_close',
    },
  },
  {
    name: 'browser',
    actions: { open: 'browser_open', click: 'browser_click', fill: 'browser_fill' },
  },
  {
    name: 'read_memory',
    query: true,
    defaultAction: 'read',
    actions: { read: 'read_memory', list: 'list_memories' },
  },
  {
    name: 'save_memory',
    defaultAction: 'save',
    actions: { save: 'save_memory', forget: 'forget_memory', restore: 'restore_memory' },
  },
  {
    name: 'index_document',
    defaultAction: 'add',
    actions: { add: 'index_document', remove: 'remove_indexed_document' },
  },
  { name: 'manage_file', actions: { move: 'move_file', delete: 'delete_file' } },
  {
    name: 'edit_file',
    defaultAction: 'replace',
    actions: { replace: 'edit_file', batch: 'batch_edit' },
  },
];

/** Old member names that are no longer tool names, with what they mean now. Kept for one release. */
export const TOOL_ALIASES: ReadonlyMap<string, { tool: string; action: string }> = new Map(
  TOOL_FAMILIES.flatMap((family) =>
    Object.entries(family.actions)
      .filter(([, member]) => member !== family.name)
      .map(([action, member]) => [member, { tool: family.name, action }] as const),
  ),
);

/**
 * Every member name, including the ones a family kept, with the one operation it used to grant.
 *
 * A rule or an allowlist written before the merge said "this tool", and that tool did one thing. Read against
 * the family it means every action — an `allow save_memory` would now allow `forget` — so whatever reads an old
 * name has to scope it through this table, never through the family name alone.
 */
export const MEMBER_SCOPES: ReadonlyMap<string, { tool: string; action: string }> = new Map(
  TOOL_FAMILIES.flatMap((family) =>
    Object.entries(family.actions).map(
      ([action, member]) => [member, { tool: family.name, action }] as const,
    ),
  ),
);

const FAMILIES_BY_NAME = new Map(TOOL_FAMILIES.map((family) => [family.name, family]));

/**
 * The call as the current catalog understands it, always naming its action; the same object when nothing changes.
 *
 * Filling the default action here is what lets every later reader — approval, permission rules, hooks — match on
 * `action` without knowing which families have a default.
 */
export function resolveToolAlias<T extends { name: string; arguments: Record<string, unknown> }>(
  call: T,
): T {
  const alias = TOOL_ALIASES.get(call.name);
  if (alias)
    return { ...call, name: alias.tool, arguments: { action: alias.action, ...call.arguments } };
  const family = FAMILIES_BY_NAME.get(call.name);
  if (family?.defaultAction && call.arguments.action === undefined)
    return { ...call, arguments: { action: family.defaultAction, ...call.arguments } };
  return call;
}

/**
 * The names a hook matcher written before the merge may use for this call.
 *
 * It is the member the action used to be, and the family name too unless the family kept one member's name: a
 * matcher `save_memory` meant saving, so it must not start firing for `forget`.
 */
export function hookSubjects(tool: string, action: string | undefined): string[] {
  const family = FAMILIES_BY_NAME.get(tool);
  const member = family && action !== undefined ? family.actions[action] : undefined;
  if (!family || !member) return [tool];
  const keptName = Object.values(family.actions).includes(family.name);
  return keptName || member === tool ? [member] : [member, tool];
}

/**
 * An allowlist read in the merged catalog's terms: the tool names to allow, and the actions allowed of each family
 * that is not allowed whole.
 *
 * An entry is a tool name, a family name (every action), `family.action`, or an old member name, which allows only
 * the action it used to be — allowing `git_stage` must not allow `commit`. A family that kept a member's name
 * (`save_memory`) is a family name here, so it allows every action; the permission policy still decides each call.
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
    const set = actions.get(tool) ?? new Set<string>();
    set.add(action);
    actions.set(tool, set);
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

在 `packages/protocol/index.ts` 加 `export * from './tool-families.ts';`。（先看该文件的导出写法，照着加；如果它不是 `export *` 风格，就按它的风格逐个导出。）

- [ ] **Step 4: 跑测试确认通过**

Run: `node scripts/run-tests.mjs tests/tool-families.test.ts`
Expected: PASS（5 个用例）。`npm run layers:check` 通过。

- [ ] **Step 5: 提交**

```bash
git add packages/protocol/tool-families.ts packages/protocol/index.ts tests/tool-families.test.ts
git commit -m "feat(protocol): describe tool families and the old names they replace"
```

---

### Task 2: 组合函数 `composeFamily`

**Files:**

- Create: `packages/tools/tool-family.ts`
- Test: `tests/tool-family-compose.test.ts`

**Interfaces:**

- Consumes: Task 1 的 `ToolFamily`。
- Produces: `export function composeFamily(family: ToolFamily, members: ReadonlyMap<string, Tool>, summary: string): Tool`，其中 `members` 是 action → 已注册的成员工具（只含实际注册了的）。

合并规则：

- `inputSchema`：`{ type: 'object', additionalProperties: false, properties: { action: { type: 'string', enum: [...actions], description }, ...成员属性的并集 }, required: defaultAction ? [] : ['action'] }`。同名属性定义完全相同就原样保留；不同但 `type` 相同，就只保留 `type`（加上 `description`，如果有的话），精确约束交给成员 schema 在 `prepare` 里校验；`type` 不同直接抛错（构建时就暴露问题）。
- `description`：`summary` + 每个 action 一行，内容是成员的原描述 `- <action>: <member.description>`。
- `permission`：`family.permission` ?? 成员共同的权限；成员权限不一致、且没有显式声明时抛错。显式声明时，每个成员的权限要么相同、要么没有。
- `effect`：成员全部相同时保留，否则不设。`cancellationGraceMs`：取成员中的最大值。
- `prepare(args, ctx)`：确定 action（缺省时用 `defaultAction`；仍然缺失或不在成员里就抛错，错误信息列出可用的 action）→ 去掉 `action` → 用 `compileToolSchema(member.inputSchema)` 校验，不通过就抛错，错误信息用 `invalidArgumentsMessage`，并点明是哪个 action → 成员有 `prepare` 就调用它，结果没有 `approvalDescription` 而成员有静态 `approvalDescription` 时补上；成员没有 `prepare` 就返回 `{ approvalDescription: member.approvalDescription, execute: (c) => member.execute(rest, c) }`。
- `execute(args, ctx)`：同样分派、校验，然后调用 `member.execute(rest, ctx)`。正常流程走 `prepare`，`execute` 只为直接调用的嵌入方保留。
- `isConcurrencySafe(args)`：分派后，成员 schema 校验通过、且 `member.isConcurrencySafe?.(rest) === true` 才返回 `true`。
- `requestsNetwork(args)`：分派后委托给成员。

- [ ] **Step 1: 写失败的测试**

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import type { Tool } from '../packages/protocol/index.ts';
import { composeFamily } from '../packages/tools/tool-family.ts';

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

test('a family dispatches by action, validates with the member schema and strips action', async () => {
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
  assert.deepEqual(schema.properties.action, {
    type: 'string',
    enum: ['a', 'b'],
    description: 'Which operation to run; see the description for each.',
  });
  // Different bounds per member: the flat schema keeps the type, the member schema keeps the bound.
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

test('a default action keeps calls without action valid', async () => {
  const merged = composeFamily(
    { name: 'note', defaultAction: 'read', actions: { read: 'note', list: 'note_list' } },
    new Map([
      ['read', tool('note', { key: { type: 'string' } })],
      ['list', tool('note_list', {})],
    ]),
    'Notes.',
  );
  assert.deepEqual((merged.inputSchema as { required: string[] }).required, []);
  const prepared = await merged.prepare!({ key: 'k' }, { signal } as never);
  assert.equal((await prepared.execute({ signal } as never)).content, 'note:{"key":"k"}');
});

test('members with different permissions are refused unless the family declares a stricter one', () => {
  const members = new Map([
    ['list', tool('srv_list', {})],
    ['start', tool('srv_start', { language: { type: 'string' } }, { permission: 'command' })],
  ]);
  assert.throws(
    () =>
      composeFamily(
        { name: 'srv', actions: { list: 'srv_list', start: 'srv_start' } },
        members,
        'S',
      ),
    /permission/,
  );
  const strict = composeFamily(
    { name: 'srv', permission: 'command', actions: { list: 'srv_list', start: 'srv_start' } },
    members,
    'S',
  );
  assert.equal(strict.permission, 'command');
});

test('a property whose type differs between members is a build error', () => {
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

test('concurrency is the member’s answer for that action, and never for invalid arguments', () => {
  const merged = composeFamily(
    { name: 'g', actions: { status: 'g_status', commit: 'g_commit' } },
    new Map([
      ['status', tool('g_status', {}, { isConcurrencySafe: () => true })],
      ['commit', tool('g_commit', { message: { type: 'string' } })],
    ]),
    'G',
  );
  assert.equal(merged.isConcurrencySafe!({ action: 'status' }), true);
  assert.equal(merged.isConcurrencySafe!({ action: 'commit', message: 'm' }), false);
  assert.equal(merged.isConcurrencySafe!({ action: 'status', stray: 1 }), false);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node scripts/run-tests.mjs tests/tool-family-compose.test.ts`
Expected: FAIL，找不到模块。

- [ ] **Step 3: 实现**

```ts
import { isDeepStrictEqual } from 'node:util';
import type { PreparedTool, Tool, ToolContext, ToolFamily } from '../protocol/index.ts';
import { invalidArgumentsMessage } from './call-result.ts';
import { compileToolSchema, toolSchemaErrorsText } from './registry.ts';

type Schema = { properties?: Record<string, Record<string, unknown>>; [key: string]: unknown };

/**
 * One tool for a family of tools, told apart by `action`.
 *
 * The members keep their own implementations and their own schemas: the flat schema the model sees is the
 * union of their arguments, loose where they disagree, and each call is checked against the chosen member's
 * schema before it runs. Validation sits in `prepare` because the registry turns what `prepare` throws into the
 * call's error result, so a bad argument for one action reads like any other invalid call.
 */
export function composeFamily(
  family: ToolFamily,
  members: ReadonlyMap<string, Tool>,
  summary: string,
): Tool {
  const actions = [...members.keys()];
  if (!actions.length) throw new Error(`Tool family ${family.name} has no members`);
  const permission = familyPermission(family, members);
  const properties: Record<string, Record<string, unknown>> = {};
  for (const member of members.values())
    for (const [key, value] of Object.entries((member.inputSchema as Schema).properties ?? {})) {
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
  const effects = new Set([...members.values()].map((member) => member.effect));
  const graces = [...members.values()].flatMap((member) =>
    member.cancellationGraceMs === undefined ? [] : [member.cancellationGraceMs],
  );
  const dispatch = (args: Record<string, unknown>) => {
    const action = typeof args.action === 'string' ? args.action : family.defaultAction;
    const member = action === undefined ? undefined : members.get(action);
    if (!member) throw new Error(`${family.name} needs "action", one of: ${actions.join(', ')}`);
    const { action: _omitted, ...rest } = args;
    const validate = compileToolSchema(member.inputSchema);
    return { action: action!, member, rest, valid: validate(rest), errors: validate.errors };
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
  const asksNetwork = [...members.values()].some((member) => member.requestsNetwork);
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
      required: family.defaultAction ? [] : ['action'],
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
              return call.valid === true && call.member.isConcurrencySafe?.(call.rest) === true;
            } catch {
              return false;
            }
          },
        }
      : {}),
    ...(asksNetwork
      ? {
          requestsNetwork(args: Record<string, unknown>) {
            try {
              const call = dispatch(args);
              return call.member.requestsNetwork?.(call.rest) === true;
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

function familyPermission(
  family: ToolFamily,
  members: ReadonlyMap<string, Tool>,
): Tool['permission'] {
  const declared = new Set([...members.values()].map((member) => member.permission));
  if (family.permission) {
    for (const value of declared)
      if (value !== undefined && value !== family.permission)
        throw new Error(
          `Tool family ${family.name}: a member's permission differs from ${family.permission}`,
        );
    return family.permission;
  }
  if (declared.size > 1)
    throw new Error(`Tool family ${family.name}: members declare different permissions`);
  return [...declared][0];
}
```

`registry.ts` 里新增导出（错误文字和注册表自己报错时用的同一个 Ajv 实例，见第 598–607 行）：

```ts
/** Ajv's text for a schema's errors, worded the way the registry's own invalid-argument results are. */
export function toolSchemaErrorsText(errors: ValidateFunction['errors']): string {
  return schemaValidator.errorsText(errors);
}
```

`tool-family.ts` 从 `registry.ts` 导入，`registry.ts` 绝不能反过来导入它（`npm run cycles:check` 会查）。

- [ ] **Step 4: 跑测试确认通过**

Run: `node scripts/run-tests.mjs tests/tool-family-compose.test.ts`
Expected: PASS（5 个用例）。`npm run cycles:check` 通过。

- [ ] **Step 5: 提交**

```bash
git add packages/tools/tool-family.ts tests/tool-family-compose.test.ts packages/tools/registry.ts
git commit -m "feat(tools): compose a family of tools into one action tool"
```

---

### Task 3: 注册表认旧名

**Files:**

- Modify: `packages/tools/registry.ts`（`execute` 开头、`executionMode`，新增 `tool(name)`）
- Test: `tests/tool-families.test.ts`（追加）

**Interfaces:**

- Consumes: Task 1 的 `resolveToolAlias`；Task 2 的 `composeFamily`。
- Produces: `ToolRegistry.tool(name: string): Tool | undefined`（只读访问已注册的工具，给 Task 4 用）。

- [ ] **Step 1: 写失败的测试（追加）**

```ts
import { ToolRegistry } from '../packages/tools/registry.ts';
import { composeFamily } from '../packages/tools/tool-family.ts';

test('the registry runs a call by an old name as the family call it now is', async () => {
  const registry = new ToolRegistry();
  const member = (name: string) => ({
    name,
    description: name,
    inputSchema: { type: 'object', properties: {}, additionalProperties: false } as const,
    isConcurrencySafe: () => true,
    execute: async () => ({ isError: false, content: name }),
  });
  registry.register(
    composeFamily(
      TOOL_FAMILIES.find((family) => family.name === 'git')!,
      new Map([
        ['status', member('git_status')],
        ['branches', member('git_branches')],
      ]),
      'Git.',
    ),
  );
  const signal = new AbortController().signal;
  const result = await registry.execute(
    { id: 'old', name: 'git_branches', arguments: {} },
    { signal, approve: async () => false },
  );
  assert.equal(result.isError, false);
  assert.equal(result.content, 'git_branches');
  assert.equal(registry.executionMode({ id: 'p', name: 'git_status', arguments: {} }), 'parallel');
  assert.equal(registry.tool('git')?.name, 'git');
  assert.equal(registry.tool('git_status'), undefined);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node scripts/run-tests.mjs tests/tool-families.test.ts`
Expected: FAIL，`Unknown tool: git_branches`（或者 `registry.tool is not a function`）。

- [ ] **Step 3: 实现**

在 `registry.ts` 顶部导入 `resolveToolAlias`（从 `../protocol/index.ts`）。

`execute(call, context)` 的第一行（在算 `attempt`、取 `entry` 之前）加：

```ts
// A call by a name a tool family replaced (`../protocol/tool-families.ts`) runs as the family call it now is,
// and a family call without `action` gets its default, so approval, rules and hooks all see the operation.
// An old name an embedder registered as its own tool is not rewritten: that tool still wins.
const normalized = resolveToolAlias(call);
if (normalized.name === call.name || !this.entries.has(call.name)) call = normalized;
```

`executionMode(call)` 的第一行做同样的规范化（同样两行）。

新增：

```ts
  /** The registered tool of this name, for assembly code that composes tools; not for dispatch. */
  tool(name: string): Tool | undefined {
    return this.entries.get(name)?.tool;
  }
```

如果 `execute` 的参数是 `const` 或被别的地方当作原对象引用，就改成 `const resolved = ...`，并把函数里后面对 `call` 的引用都换成 `resolved`。审批描述、钩子、文件日志看到的就都是新名。

**按 action 限制。** 白名单写的是旧名时（例如只允许 `git_stage`），只允许家族名就等于放开了 `commit` 和 `worktree_create`。所以 restriction 要能细到 action：

- `restrict()` 的参数加一个可选的 `actions?: ReadonlyMap<string, ReadonlySet<string>>`（工具名 → 允许的 action）。多层 restriction 叠加时，同一个工具的 action 集合取交集。
- `execute`：规范化之后，如果该工具有 action 限制，且 `call.arguments.action` 不在集合里，就返回错误：`Tool "<name>" action "<action>" is not available in this run; it is excluded by a restriction. Do not retry it.`。这个检查放在现有的 `offers` 检查旁边，措辞和它保持一致。
- `specs()`：有 action 限制的工具，返回的 schema 里 `action.enum` 只保留允许的值。描述里各 action 的那几行也只保留允许的；描述格式是 `composeFamily` 生成的 `- <action>: ...`，按行过滤即可。
- `forRun({ allow })` 的 `allow` 和 restriction 用同一个解析函数（见 Task 4 的 `scopeAllowlist`），所以进程内子代理和子进程子代理的白名单含义一致。

在 Step 1 的测试里追加：

```ts
test('an action-scoped restriction refuses the other actions and hides them from the schema', async () => {
  const registry = new ToolRegistry();
  const member = (name: string) => ({
    name,
    description: name,
    inputSchema: { type: 'object', properties: {}, additionalProperties: false } as const,
    permission: 'command' as const,
    execute: async () => ({ isError: false, content: name }),
  });
  registry.register(
    composeFamily(
      TOOL_FAMILIES.find((family) => family.name === 'git_change')!,
      new Map([
        ['stage', member('git_stage')],
        ['commit', member('git_commit')],
      ]),
      'Git changes.',
    ),
  );
  registry.restrict({
    allow: ['git_change'],
    actions: new Map([['git_change', new Set(['stage'])]]),
  });
  const spec = registry.specs().find((s) => s.name === 'git_change')!;
  assert.deepEqual(
    (spec.inputSchema as { properties: { action: { enum: string[] } } }).properties.action.enum,
    ['stage'],
  );
  const signal = new AbortController().signal;
  const refused = await registry.execute(
    { id: 'c', name: 'git_commit', arguments: { message: 'm' } },
    { signal, approve: async () => true },
  );
  assert.equal(refused.isError, true);
  assert.match(refused.content, /action "commit" is not available in this run/);
});
```

（`restrict` 现有的参数形状照 `registry.ts:311` 的定义写；如果它要求 `allow` 和 `deny` 二选一，`actions` 就作为两种形状都能带的附加字段。）

- [ ] **Step 4: 跑测试确认通过**

Run: `node scripts/run-tests.mjs tests/tool-families.test.ts tests/tool-concurrency-mode.test.ts tests/tool-restrict.test.ts`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add packages/tools/registry.ts tests/tool-families.test.ts
git commit -m "feat(tools): run calls by replaced tool names through their family"
```

---

### Task 4: 在目录里合并家族

**Files:**

- Create: 在 `packages/tools/tool-family.ts` 里加 `mergeToolFamilies`
- Modify: `packages/catalog/index.ts`（`createTools` 末尾调用；`YUANTU_TOOL_ALLOWLIST` 先经别名映射；不注册 `browser_close`）
- Modify: `packages/tools/tool-categories.ts`（新名的分类）
- Modify: `packages/tools/deferred-tools.ts`（`DEFERRED_GROUPS` 改用新名；`repo_map` 加入按需加载）
- Modify: `packages/core/subagents/contract.ts`（`EXPLORE_TOOLS`、`CHILD_DENIED_TOOLS`）
- Modify: `packages/providers/strict-tools.ts`（`STRICT_PRIORITY` 去掉 `batch_edit`）
- Modify: `packages/core/goal-progress.ts`（`QUERY_TOOLS` 加 `git`、`read_memory`）
- Test: `tests/tool-families.test.ts`（追加）

**Interfaces:**

- Consumes: Task 1–3。
- Produces: `export function mergeToolFamilies(registry: ToolRegistry, summaries?: Readonly<Record<string, string>>): void`，以及 `FAMILY_SUMMARIES: Record<string, string>`（每个家族一句话的英文说明）。

- [ ] **Step 1: 写失败的测试（追加）**

```ts
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createTools } from '../packages/catalog/index.ts';
import { TerminalSessions } from '../packages/tools/terminal.ts';
import { EXPLORE_TOOLS } from '../packages/core/subagents/contract.ts';

test('the catalog offers each family once and none of the member names', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-families-'));
  const terminals = new TerminalSessions(root);
  const tools = createTools(root, undefined, 'standalone', undefined, undefined, terminals);
  t.after(() => tools.close?.());
  const names = tools.specs().map((spec) => spec.name);
  for (const family of TOOL_FAMILIES) assert.ok(names.includes(family.name), family.name);
  for (const old of TOOL_ALIASES.keys()) assert.equal(names.includes(old), false, old);
  assert.equal(names.includes('browser_close'), false);
  tools.toolMode = 'deferred';
  const first = tools.specs({ loaded: new Set() }).map((spec) => spec.name);
  assert.equal(first.length, 20, first.join(' '));
  assert.equal(first.includes('repo_map'), false);
  // Read-only runs still drop every family that declares a permission.
  const readOnly = tools.specs({ readOnly: true }).map((spec) => spec.name);
  for (const name of [
    'git_change',
    'lsp_server',
    'lsp_edit',
    'terminal',
    'browser',
    'save_memory',
    'manage_file',
    'edit_file',
  ])
    assert.equal(readOnly.includes(name), false, name);
  for (const name of ['git', 'lsp', 'read_memory', 'terminal_read'])
    assert.ok(readOnly.includes(name), name);
  assert.ok(!(EXPLORE_TOOLS as readonly string[]).includes('lsp_server'));
});
```

（`tools.close` 的写法照 `tests/tool-concurrency-mode.test.ts` 里的 teardown 改。）

- [ ] **Step 2: 跑测试确认失败**

Run: `node scripts/run-tests.mjs tests/tool-families.test.ts`
Expected: FAIL，`git` 不在目录里。

- [ ] **Step 3: 实现 `mergeToolFamilies`**

```ts
/** One line per family, in front of the per-action lines `composeFamily` adds. */
export const FAMILY_SUMMARIES: Readonly<Record<string, string>> = {
  git: 'Read the repository state: status, diffs, history, branches and worktrees.',
  git_change:
    'Change the repository: stage, commit or create a worktree. No push, amend, rebase or reset.',
  lsp: 'Ask a running language server about code: diagnostics, definitions, references, hover, symbols and available code actions.',
  lsp_server: 'List, start or stop language servers.',
  lsp_edit: 'Apply a language server edit: rename a symbol or apply a code action.',
  terminal_read: 'Read an open terminal, or list the open ones.',
  terminal: 'Open an interactive terminal, send it input or a signal, or close it.',
  browser: 'Drive the browser: open a page, click or fill an element.',
  read_memory: 'Read one saved memory, or list them.',
  save_memory: 'Save, forget or restore a memory.',
  index_document: 'Add a document to the knowledge index or remove it.',
  manage_file: 'Move or delete a workspace file; both are recorded for undo.',
  edit_file:
    'Replace exact text in one file, or apply a batch of replacements across files atomically.',
};

/**
 * Replace each family's registered members with the family tool.
 *
 * Runs after every tool is registered, so it composes exactly what this host offers: a family missing members
 * (no terminal manager, no Git in a nested workspace) offers only the actions it has, and one with none is not
 * registered at all.
 */
export function mergeToolFamilies(
  registry: ToolRegistry,
  summaries: Readonly<Record<string, string>> = FAMILY_SUMMARIES,
): void {
  for (const family of TOOL_FAMILIES) {
    const members = new Map<string, Tool>();
    for (const [action, name] of Object.entries(family.actions)) {
      const tool = registry.tool(name);
      if (tool) members.set(action, tool);
    }
    if (!members.size) continue;
    for (const name of Object.values(family.actions)) registry.remove(name);
    registry.register(composeFamily(family, members, summaries[family.name] ?? family.name));
  }
}
```

注意 `edit_file`：要先把 `attachDiagnostics` 包装过的 `edit_file` 和 `batch_edit` 取出来再合并，这一点自然成立，因为合并发生在所有注册之后。

`packages/catalog/index.ts`：

- 在 `return registry;` 之前（`load_skill` 注册之后）加 `mergeToolFamilies(registry);`。
- 浏览器工具注册时跳过 `browser_close`：`for (const tool of browser.tools) if (tool.name !== 'browser_close') registry.register(tool);`，并加一行注释说明浏览器会话由会话池在空闲时关闭。
- `YUANTU_TOOL_ALLOWLIST` 拆出名字后交给 `scopeAllowlist`，用结果调用 `registry.restrict({ allow: scoped.tools, actions: scoped.actions })`。**不要**只把旧名映射成家族名：那样只允许 `git_stage`，就等于放开了整个 `git_change`。`registry.forRun({ allow })` 内部也改用 `scopeAllowlist`（Task 3）。
- `EXPLORE_TOOLS` 用新名列出（见下文），它经过 `scopeAllowlist` 解释后，和原来允许的操作完全一致：`git` 的 5 个操作原来就都在白名单里，`lsp` 的 7 个也是，`read_memory` 原来的读取和列出两个都在。

`tool-categories.ts`：删掉所有成员旧名的条目，按家族表加新名：`git` → `q('git')`，`git_change` → `c('git')`，`lsp`/`lsp_server`/`lsp_edit` → `c('lsp')`，`terminal_read`/`terminal` → `c('terminal')`，`browser` → `c('browser')`，`read_memory` → `q('memory')`，`save_memory` → `c('memory')`，`index_document` → `c('knowledge')`，`manage_file`/`edit_file` → `c('files')`。（`browser_screenshot` 保持原样。）

`deferred-tools.ts` 的 `DEFERRED_GROUPS` 改为：

```ts
  { hint: 'more file edits (patches, moves, deletes)', names: ['apply_patch', 'manage_file'] },
  { hint: 'repository map', names: ['repo_map'] },
  { hint: 'git branches, staging, commits and worktrees', names: ['git_change'] },
  { hint: 'language servers', names: ['lsp', 'lsp_server', 'lsp_edit'] },
  { hint: 'browser automation', names: ['browser', 'browser_screenshot'] },
  { hint: 'file delivery checks', names: ['verify_file_delivery'] },
  { hint: 'knowledge base indexing', names: ['index_document'] },
  { hint: 'web', names: ['web_search', 'web_fetch'] },
  { hint: 'interactive terminals', names: ['terminal', 'terminal_read'] },
```

先读这个文件现有的分组。上面只列出要改的组，其余组（后台命令、验证等）保持原样。`git` 一直随请求发送，不放进按需加载。

`contract.ts`：`EXPLORE_TOOLS` 里把 `git_status`、`git_diff`、`git_log`、`git_branches`、`git_worktrees` 换成 `'git'`；把 7 个 LSP 查询换成 `'lsp'`；把 `list_memories`、`read_memory` 换成 `'read_memory'`。`CHILD_DENIED_TOOLS` 改为 `['save_memory'] as const`，并检查它的使用方：如果它们按名字拒绝，`save_memory` 现在已经覆盖 forget 和 restore。

`strict-tools.ts`：`STRICT_PRIORITY` 删掉 `'batch_edit'`。

`goal-progress.ts`：`QUERY_TOOLS` 加 `'git'`、`'read_memory'`，旧名保留（别名期内模型可能还用旧名）。

- [ ] **Step 4: 跑测试确认通过**

Run: `node scripts/run-tests.mjs tests/tool-families.test.ts tests/tool-concurrency-mode.test.ts tests/tool-restrict.test.ts tests/run-scoped-tools.test.ts tests/strict-tools.test.ts`
Expected: `tool-families` PASS。其余测试里断言旧名清单的地方会失败：`tool-concurrency-mode.test.ts` 的 parallel 列表改成新名（`git`、`read_memory` 等），其余同理。改完再跑，全部 PASS。

再用 Grep 找直接按旧名从 `createTools()` 取工具的测试（`find((t) => t.name === 'git_status')` 之类），改成新名加 `action`。

- [ ] **Step 5: 提交**

```bash
git add packages tests
git commit -m "feat(catalog): offer tool families instead of their members"
```

---

### Task 5: 旧名在权限规则、钩子、按需加载和历史里继续有效

**Files:**

- Modify: `packages/protocol/permissions.ts`（`PermissionPolicySource.version` 改为 `1 | 2`）
- Modify: `packages/protocol/permission-policy.ts`（按版本解释规则；`source()` 输出版本 2）
- Modify: `apps/desktop/permission-settings.ts`（预设规则输出版本 2；`terminal_send` 规则改用新名）
- Modify: `packages/resources/hook-bridge.ts`（matcher 按 `hookSubjects` 匹配，payload 带上 `tool_action`）
- Modify: `packages/tools/deferred-tools.ts`（`load_tools` 执行时认旧名；搜索也匹配 action 和旧成员名；`addLoadedTools` 映射旧名；LSP 分组提示补上操作关键词）
- Modify: `packages/protocol/tool-families.ts`（新增 `rewriteToolHistory`）
- Modify: `packages/core/run/request.ts:431` 附近（发请求前改写历史）
- Test: `tests/tool-families.test.ts`（追加）、`tests/deferred-tools.test.ts:153,185`、`tests/providers.test.ts`（追加适配器层用例）

**Interfaces:**

- Consumes: Task 1 的 `TOOL_ALIASES`、`MEMBER_SCOPES`、`resolveToolAlias`、`hookSubjects`。
- Produces: `export function rewriteToolHistory<M>(messages: readonly M[]): readonly M[]`（没有旧名时返回同一个数组）。

**权限规则为什么要按版本区分。** 一条旧规则写的是"这个工具"，而那个工具当时只做一件事。合并之后，保留了成员名的家族（`save_memory`、`edit_file`、`index_document`）用同一个名字承担了好几个操作：旧的 `allow save_memory` 如果照字面读，就会自动放行 `forget`。新规则又需要能写"整个家族"。所以：

- 版本 1（合并前写下的规则，包括用户磁盘上已有的策略文件）：`tool` 是任何成员名（`MEMBER_SCOPES` 里有，不论是否和家族同名），就把它限定到原来那一个操作。没有 `arguments` 时，在 `match` 里加 `action`；有 `arguments`（整份参数精确匹配）时，在 `arguments` 里加 `action`。注册表现在总会给家族调用补上 `action`（Task 3），所以精确匹配仍然成立。
- 版本 2（合并后写的规则）：`tool` 按字面解释，家族名就是整个家族。
- `source()` 一律输出版本 2，规则已经换算成新名。否则存回磁盘、再读一次时，会被当成版本 1 再缩窄一次。

- [ ] **Step 1: 写失败的测试（追加到 `tests/tool-families.test.ts`）**

```ts
import { PermissionPolicy } from '../packages/protocol/permission-policy.ts';
import {
  loadedTools,
  matchDeferredTools,
  DEFERRED_TOOLS,
} from '../packages/tools/deferred-tools.ts';
import { rewriteToolHistory } from '../packages/protocol/tool-families.ts';

const approval = (kind: 'write' | 'command', name: string, args: Record<string, unknown>) => ({
  kind,
  description: '',
  toolCall: { id: 'x', name, arguments: args },
});

test('a version 1 rule for an old name governs only the operation it used to be', () => {
  const policy = new PermissionPolicy({
    version: 1,
    rules: [
      { effect: 'ask', kind: 'write' },
      { effect: 'allow', tool: 'save_memory' },
      { effect: 'allow', kind: 'command' },
      { effect: 'ask', tool: 'terminal_send' },
    ],
  });
  // `allow save_memory` meant saving; it must not start allowing forget or restore.
  assert.equal(
    policy.decide(approval('write', 'save_memory', { action: 'save', key: 'k' })),
    'allow',
  );
  assert.equal(
    policy.decide(approval('write', 'save_memory', { action: 'forget', key: 'k' })),
    'ask',
  );
  assert.equal(
    policy.decide(approval('command', 'terminal', { action: 'send', id: 't', input: 'ls' })),
    'ask',
  );
  assert.equal(policy.decide(approval('command', 'terminal', { action: 'open' })), 'allow');
  // Saved back, the rules are already in current terms and must not be narrowed a second time.
  const saved = policy.source();
  assert.equal(saved.version, 2);
  const reread = new PermissionPolicy(saved);
  assert.equal(
    reread.decide(approval('write', 'save_memory', { action: 'save', key: 'k' })),
    'allow',
  );
  assert.equal(
    reread.decide(approval('write', 'save_memory', { action: 'forget', key: 'k' })),
    'ask',
  );
});

test('a version 1 rule with exact arguments keeps matching the same call', () => {
  const policy = new PermissionPolicy({
    version: 1,
    rules: [
      { effect: 'ask', kind: 'write' },
      {
        effect: 'allow',
        tool: 'edit_file',
        arguments: { path: 'a.ts', old_text: 'x', new_text: 'y' },
      },
    ],
  });
  assert.equal(
    policy.decide(
      approval('write', 'edit_file', {
        action: 'replace',
        path: 'a.ts',
        old_text: 'x',
        new_text: 'y',
      }),
    ),
    'allow',
  );
});

test('a version 2 rule for a family name governs every action', () => {
  const policy = new PermissionPolicy({
    version: 2,
    rules: [{ effect: 'allow', tool: 'save_memory' }],
  });
  assert.equal(
    policy.decide(approval('write', 'save_memory', { action: 'forget', key: 'k' })),
    'allow',
  );
});

test('a version 1 deny of one old member does not hide the whole family', () => {
  const policy = new PermissionPolicy({
    version: 1,
    rules: [{ effect: 'deny', tool: 'forget_memory' }],
  });
  assert.equal(policy.deniesEveryCall({ name: 'save_memory', permission: 'write' }), false);
});

test('load_tools takes old names and keyword searches still find the operation', async () => {
  assert.equal(matchDeferredTools('rename symbol', DEFERRED_TOOLS)[0], 'lsp_edit');
  assert.equal(matchDeferredTools('hover', DEFERRED_TOOLS)[0], 'lsp');
  const loaded = loadedTools(
    [
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'l', name: 'load_tools', arguments: { names: ['lsp_hover'] } }],
      },
    ],
    new Set(['lsp', 'lsp_server']),
  );
  assert.deepEqual([...loaded], ['lsp']);
});

test('history calls by old names are rewritten and lose the native state they no longer match', () => {
  const current = [{ role: 'user' as const, content: 'hi' }];
  assert.equal(rewriteToolHistory(current), current);
  const rewritten = rewriteToolHistory([
    {
      role: 'assistant',
      content: '',
      toolCalls: [{ id: 'g', name: 'git_log', arguments: { count: 3 } }],
      providerState: {
        protocol: 'openai-responses',
        output: [{ type: 'function_call', name: 'git_log' }],
      },
    },
  ]);
  assert.deepEqual((rewritten[0] as { toolCalls: unknown[] }).toolCalls, [
    { id: 'g', name: 'git', arguments: { action: 'log', count: 3 } },
  ]);
  assert.equal('providerState' in rewritten[0]!, false);
});
```

`PermissionPolicy`、`Message`、`ProviderState` 的确切类型，照 `packages/protocol/index.ts` 和现有测试的写法调整（`providerState` 的字段补齐到类型要求的程度，`as never` 只用在测试数据上）。

`tests/deferred-tools.test.ts`：第 153 行的期望从 `'lsp_rename'` 改为 `'lsp_edit'`；第 185 行附近那个 `loader.execute({ query: 'rename symbol' })` 用例，期望加载的名字改为 `lsp_edit`；再加一个用例：`loader.execute({ names: ['lsp_hover'] })` 成功，结果里报告加载的是 `lsp`。

在 `tests/providers.test.ts` 里，按该文件现有"截获请求体"的写法（找用 `httpFixture` 或假 `fetch` 记录请求的用例），给 Responses、OpenAI Chat、Anthropic 三个适配器各加一个用例：

- 历史里一条 assistant 消息调用 `git_log`，并带有和当前连接、模型、端点都匹配的 `providerState`（Responses 用 `output`，另外两种用各自的原生字段和 `messageHash`）；
- 先经 `rewriteToolHistory`，再交给适配器的 `complete`；
- 断言实际发出的请求体里出现 `"git"`，并且**完全不含** `git_log`。

Responses 适配器在 `providerState` 匹配时会直接回放 `state.output`（`packages/providers/responses.ts:112-120`），不看 `toolCalls`。所以只改 `toolCalls` 不够，这个用例就是为了锁住"改写后去掉原生状态"这一点。

- [ ] **Step 2: 跑测试确认失败**

Run: `node scripts/run-tests.mjs tests/tool-families.test.ts tests/deferred-tools.test.ts tests/providers.test.ts`
Expected: 新增和改过的用例 FAIL。

- [ ] **Step 3: 实现**

`tool-families.ts` 加：

```ts
/**
 * The transcript as the current catalog names it.
 *
 * A session recorded before the merge holds calls by old names, and a provider may refuse a history that calls a
 * tool its request does not declare. Rewriting on the way out keeps the stored log as it happened. A rewritten
 * message drops its native provider state: that state replays the original calls verbatim (the Responses adapter
 * sends `output` as it was) or is bound to them by hash, so keeping it would either resend the old names or be
 * discarded by the adapter anyway.
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

`request.ts`：`messages: resendNote ? [...context.messages, resendNote] : context.messages` 改为先 `const history = rewriteToolHistory(context.messages);`，再用 `history`。`context.ts:557` 的压缩请求如果带 `tools`，也做同样处理；不带就不改，并在那里加一句注释说明原因。

已知的副作用：去掉原生状态后，这几条旧消息的思考内容不再回放。Anthropic 开启 thinking 时，续接一个停在工具循环中途的旧会话，可能对最后一条 assistant 缺少 thinking 块有要求。这种情况在本机测不了，列为 Task 6 的人工验收项。

`permissions.ts`：`version: 1` 改为 `version: 1 | 2`，注释写明两个版本的区别。

`permission-policy.ts`：

- 构造函数里 `input.version !== 1` 的校验改为接受 1 和 2。
- 规则校验通过之后、生成 `this.compiled` 之前，版本 1 的规则逐条换算：

```ts
const scope = version === 1 && rule.tool !== undefined ? MEMBER_SCOPES.get(rule.tool) : undefined;
if (scope)
  rule = rule.arguments
    ? { ...rule, tool: scope.tool, arguments: { action: scope.action, ...rule.arguments } }
    : { ...rule, tool: scope.tool, match: { ...(rule.match ?? {}), action: scope.action } };
```

- `source()`（第 158 行）返回 `{ version: 2, rules: ... }`。
- `deniesEveryCall` 已经要求规则没有 `match` 和 `arguments`，换算后的 deny 规则带着 `match`，不会把整个家族藏起来，所以这里不用改。Step 1 的用例锁住这一点。

`apps/desktop/permission-settings.ts`：所有预设的 `version: 1` 改为 `version: 2`；第 117 行改为 `{ effect: 'ask', tool: 'terminal', match: { action: 'send' } }`，注释不变。再用 Grep 查桌面端其他读写策略版本号的地方（例如校验、迁移、设置界面的解析），一并接受版本 2。

`hook-bridge.ts`：在 `dispatch` 里，把 `hookMatcherMatches(declaration.matcher, subject)` 改成"`hookSubjects(subject, action)` 里任何一个匹配"；`action` 从 payload 的 `tool_input.action` 取（看 `hook-bridge.ts:232` 附近 payload 是怎么组的）。合并工具的 payload 加 `tool_action: action`。

`deferred-tools.ts`：

- `loadToolsTool` 的 `execute`：读出 `args.names` 后，先逐个换算 `TOOL_ALIASES.get(name)?.tool ?? name` 再去重，后面的 `loaded`/`present`/`refused` 都基于换算后的名字。结果里如果有旧名被换算，加一句 `"<old> is now <new> (action: <action>)"`，让模型知道以后用新名。
- `matchDeferredTools` 计分时，工具的可匹配文本除了名字和分组提示，再加上它的 action 名和旧成员名：

```ts
const familyTerms = new Map(
  TOOL_FAMILIES.map((family) => [
    family.name,
    [...Object.keys(family.actions), ...Object.values(family.actions)].join(' ').toLowerCase(),
  ]),
);
// in the loop, after `hint`:
const terms = familyTerms.get(name) ?? '';
score += lower.includes(word) ? 2 : terms.includes(word) ? 2 : hint.includes(word) ? 1 : 0;
```

（写进现有循环时，把三种来源合成一个表达式，别重复加分。）

- `addLoadedTools`：两处 `deferrable.has(name)` 之前，先 `const current = TOOL_ALIASES.get(name)?.tool ?? name;`，再用 `current`。
- LSP 分组的 `hint` 改为 `'language servers: diagnostics, definitions, references, hover, symbols, rename, code actions'`；终端分组改为 `'interactive terminals: open, send input, read, signal, close'`；浏览器分组改为 `'browser automation: open, click, fill, screenshot'`。

- [ ] **Step 4: 跑测试确认通过**

Run: `node scripts/run-tests.mjs tests/tool-families.test.ts tests/deferred-tools.test.ts tests/providers.test.ts tests/hook-bridge.test.ts tests/hooks.test.ts tests/host-hook-policy.test.ts`
再用 Glob 找 `tests/*permission*` 一并跑。
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add packages apps tests
git commit -m "feat: keep replaced tool names working in rules, hooks, loads and history"
```

---

### Task 5b: 按名字判断的代码与模型看到的文字

合并后，工具名不再能单独说明调用的是哪个操作。代码里凡是按工具名判断的地方都要改成按"名字 + action"判断，模型看得到的描述和报错里提到旧名的也要改。

**Files:**

- Modify: `packages/core/completion/automatic-verification.ts:172,203`
- Modify: `packages/knowledge/tools.ts:131-133`
- Modify: `apps/desktop/renderer-messages.ts:239`
- Modify: `benchmarks/swe-bench/adapter.mjs:69-72,167-172`、`benchmarks/performance-cases.ts:42,165-166`、`benchmarks/coding-evaluation/adapters.mjs:133`
- Modify: 排查出来的工具描述、报错和提示词
- Test: `tests/automatic-verification.test.ts`（追加）

- [ ] **Step 1: 写失败的测试（追加到 `tests/automatic-verification.test.ts`）**

照该文件现有用例的写法：构造自动验收对象，模拟一轮 `beforeTools` + 修改文件 + `observe`。加两个用例：

- 用 `{ name: 'terminal', arguments: { action: 'send', id: 't', input: 'echo x > f' } }` 调用，并在其间改动工作区文件，断言 `hasProjectWork === true`；
- 同样的流程，换成旧名 `{ name: 'terminal_send', arguments: { id: 't', input: '...' } }`，断言结果相同。
  再加一个反例：`{ name: 'terminal', arguments: { action: 'open' } }` 不触发基线。原来 `terminal_open` 也不在名单里，所以不能因为合并就开始触发。

Run: `node scripts/run-tests.mjs tests/automatic-verification.test.ts`
Expected: 新名用例 FAIL（现在的名单只认 `terminal_send`）。

- [ ] **Step 2: 改自动验收**

在文件里加一个辅助函数，两处名单都改用它：

```ts
/** Calls that run a program, by what they do rather than by name: a family call names its operation in `action`. */
function runsProgram(call: ToolCall, includeCode: boolean): boolean {
  const current = resolveToolAlias(call);
  if (current.name === 'terminal') return current.arguments.action === 'send';
  return (includeCode ? ['run_code'] : [])
    .concat(['run_command', 'start_command', 'run_validation'])
    .includes(current.name);
}
```

第 172 行用 `runsProgram(call, true)`，第 203 行用 `runsProgram(call, false)`。两处原来的名单不一样（203 行没有 `run_code`），这个区别保持不变。

Run: `node scripts/run-tests.mjs tests/automatic-verification.test.ts tests/host-automatic-verification.test.ts`
Expected: PASS。

- [ ] **Step 3: 排查其余按名字判断的代码**

```bash
grep -rnE "['\"\`](git_status|git_diff|git_log|git_branches|git_worktrees|git_stage|git_commit|git_worktree_create|lsp_[a-z_]+|terminal_(read|list|open|send|signal|close)|browser_(open|click|fill|close)|list_memories|forget_memory|restore_memory|remove_indexed_document|move_file|delete_file|batch_edit)['\"\`]" packages apps benchmarks scripts --include=*.ts --include=*.tsx --include=*.mjs
```

排除工具自己的定义（`name: '...'`）、`tool-families.ts`、`tool-categories.ts` 和 `deferred-tools.ts` 之后，逐条处理：

- `packages/knowledge/tools.ts:131-133`：这两份名单是在说明哪些工具可用，改成合并后的名字（`read_memory`、`save_memory`），措辞里写清楚 `save_memory` 包括 forget 和 restore。
- `apps/desktop/renderer-messages.ts:239`：`edit_file` 的 `action: 'batch'` 带的是 `edits` 数组，渲染路径要从 `edits[].path` 取。先看这里原来怎么处理 `batch_edit` 的，照着改。
- `benchmarks/swe-bench/adapter.mjs`：路径提取改为认 `manage_file`（`action === 'move'` 时取 `from`、`to`，否则取 `path`）和 `edit_file` 的 `edits` 数组；167–172 行写工具清单里的 `delete_file`、`move_file`、`batch_edit` 换成 `manage_file`。
- `benchmarks/performance-cases.ts`：`batch_edit` 改为 `edit_file` 加 `action: 'batch'`，判断条件跟着改。
- `benchmarks/coding-evaluation/adapters.mjs:133`：`edit_file` 名字没变，不用改；在旁边加一句注释说明批量编辑也走这里。
- `packages/core/goal-progress.ts`：Task 4 已经处理。

每处改完都要有测试覆盖。已有测试覆盖的，跑该测试；没有的，补一个最小用例。

- [ ] **Step 4: 排查模型看得到的文字**

```bash
grep -rnE "\b(git_status|git_diff|git_log|git_branches|git_worktrees|git_stage|git_commit|git_worktree_create|lsp_[a-z_]+|terminal_(read|list|open|send|signal|close)|browser_(open|click|fill|close)|list_memories|forget_memory|restore_memory|remove_indexed_document|move_file|delete_file|batch_edit)\b" packages/tools packages/lsp packages/knowledge packages/core/prompt packages/core/run --include=*.ts
```

只看会发给模型的字符串：工具 `description`、错误结果文字、提示词。注释不在这一步处理。凡是提到旧名的，改成新写法，例如 `call lsp_start first` → `call lsp_server with action "start" first`。改完再跑一遍上面的 grep，确认字符串里不再出现旧名。

注释里描述行为的旧名，比如 `fs-observation.ts:17-18`、`pty-provider.ts:18-21`、`sandbox-provider.ts:87`、`lsp/manager.ts:114`、`knowledge/store.ts:292`、`terminal.ts:34-41`，也顺手改成新名，免得以后读代码的人被误导。

Run: `npm run snapshot:update`，确认快照里系统提示词或工具描述的变化，正好就是这一步改的文字。

- [ ] **Step 5: 提交**

```bash
git add packages apps benchmarks tests
git commit -m "fix: read tool families by action wherever a tool name used to decide"
```

---

### Task 6: README、快照与全量验证

**Files:**

- Modify: `README.md`（工具清单各节、注册条件表、钩子说明、`browser_close`、旧名一节）
- Modify: `tests/snapshots/*.json`（`npm run snapshot:update` 生成）

- [ ] **Step 1: 改 README**

- 用 Grep 找 README 里所有旧名（家族表里的每个成员名，以及 `browser_close`），逐处改成新名加 `action`。工具表按家族一行，"行为"列写可用的 action。
- 在工具一节末尾加一小段"旧工具名"：说明这些名字已合并、在一个版本内照旧能用（包括权限规则与钩子匹配），并列出"旧名 → 新名 + action"的对照，内容和 `packages/protocol/tool-families.ts` 一致。
- 说明 `lsp_server` 的 `list`、`stop` 现在需要命令审批；`browser_close` 已移除，浏览器会话空闲时自动关闭。
- 钩子一节说明：钩子的 matcher 用旧名也能匹配，并且只匹配它原来那个操作；payload 新增 `tool_action`。
- 权限策略一节说明：策略文件分版本 1 和 2。版本 1 里的旧工具名只代表它原来那一个操作；版本 2 按新名解释，家族名代表全部操作。保存时一律写成版本 2。
- 工具白名单（`YUANTU_TOOL_ALLOWLIST`）一节说明：可以写家族名、`家族.action` 或旧名，旧名只放开它原来那个操作。

- [ ] **Step 2: 生成事实与快照**

Run: `npm run docs:generate`，然后 `npm run docs:check`。
Expected: 自动生成块里的工具数是 39 个（空工作区，全部，含终端）/ 首个请求 20 个；数字不同时，先找出原因再改，不要直接照抄生成结果。

Run: `npm run snapshot:update`，再看 `git diff tests/snapshots`：确认只是工具清单与 schema 字节数变了，系统提示词正文没变。

- [ ] **Step 3: 全量验证**

Run: `npm run typecheck`、`npm run lint`、`npx prettier --check . --log-level warn`、`npm run layers:check`、`npm run cycles:check`、`npm run references:check`、`npm run i18n:check`、`npm run build`
Run: `FOUNDRY_TEST_CONTINUE_ON_FAILURE=1 npm test`
Expected: 全部通过；日志里 `Phase parallel` 和 `Phase serial` 的文件数加起来等于测试文件总数（确认真的跑完了一整轮）。

人工验收（本机测不了，在提交说明里写明结果或写明未验证）：用真实的 Anthropic 连接、开启 thinking，续接一个停在工具循环中途、历史里带旧工具名的会话，确认请求被接受。

- [ ] **Step 4: 量化结果并提交**

用 `scripts/docs-facts.mjs` 的数字，把"工具数与 schema 字节数，改动前 → 改动后"写进提交说明。

```bash
git add README.md tests/snapshots
git commit -m "docs: describe tool families and the names they replace"
```

---

## Self-Review 记录

- Spec 覆盖：合并规则 1–5（Task 2、4），目标清单（家族表、Task 4），第一阶段数字（Task 4 Step 1 断言 20 个、Task 6 Step 2 核对 39 个），兼容（别名：Task 3；加载记录、历史、钩子、权限规则：Task 5），测试（各任务），待定问题按默认处理（删除 `browser_close`；`lsp_server` 需要命令审批；别名保留一个版本；第二阶段另做）。
- 和 spec 的差异：spec 写的是"`read_memory`/`terminal_read` 不带 key/id 时列出"，计划改成用默认 action 加 `action: 'list'`，因为扁平 schema 里按参数是否存在来分派，会让成员 schema 的校验变得含糊。已在家族表写明。
- 第二阶段（命令与作业）不在本计划内。
- 评审修订（2026-10-31）：
  - 白名单按 action 限制（`scopeAllowlist` + restriction 的 `actions`，Task 1、3、4）；
  - 权限策略按版本 1、2 区分，旧规则只授权原来那个操作，包括和家族同名的成员与精确参数规则（Task 5）；
  - 自动验收按 `terminal` + `action: send` 识别（Task 5b）；
  - 历史改写同时去掉原生 `providerState`，并在三个适配器层面验证实际请求体（Task 5）；
  - `load_tools` 执行时认旧名，搜索也匹配 action 和旧成员名（Task 5）；
  - 补了一次按名字判断代码与模型可见文字的排查（Task 5b）；
  - 钩子 matcher 只匹配原来那个操作（Task 1 的 `hookSubjects`）。
