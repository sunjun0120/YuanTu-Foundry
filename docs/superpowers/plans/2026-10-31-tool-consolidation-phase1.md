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
  - `export function resolveToolAlias<T extends { name: string; arguments: Record<string, unknown> }>(call: T): T`：旧名改写成新名，并把 `action` 放进参数（参数里已有 `action` 时不覆盖）；不是旧名就原样返回同一个对象
  - `export function aliasedToolNames(tool: string, action: string | undefined): string[]`：给定新名和 action，返回对应的旧名（没有就返回空数组），给钩子匹配用

- [ ] **Step 1: 写失败的测试**

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  TOOL_FAMILIES,
  TOOL_ALIASES,
  resolveToolAlias,
  aliasedToolNames,
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
});

test('the table is consistent: unique names, members never reused, defaults are real actions', () => {
  const names = TOOL_FAMILIES.map((family) => family.name);
  assert.equal(new Set(names).size, names.length);
  const members = TOOL_FAMILIES.flatMap((family) => Object.values(family.actions));
  assert.equal(new Set(members).size, members.length);
  for (const family of TOOL_FAMILIES)
    if (family.defaultAction) assert.ok(family.actions[family.defaultAction], family.name);
  assert.deepEqual(aliasedToolNames('terminal', 'send'), ['terminal_send']);
  assert.deepEqual(aliasedToolNames('read_file', undefined), []);
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

/** The call as the current catalog understands it; the same object when its name is current. */
export function resolveToolAlias<T extends { name: string; arguments: Record<string, unknown> }>(
  call: T,
): T {
  const alias = TOOL_ALIASES.get(call.name);
  if (!alias) return call;
  return { ...call, name: alias.tool, arguments: { action: alias.action, ...call.arguments } };
}

/** The old names a call to `tool` with `action` used to go by, for matchers written before the merge. */
export function aliasedToolNames(tool: string, action: string | undefined): string[] {
  const names: string[] = [];
  for (const [old, alias] of TOOL_ALIASES)
    if (alias.tool === tool && alias.action === action) names.push(old);
  return names;
}
```

在 `packages/protocol/index.ts` 加 `export * from './tool-families.ts';`。（先看该文件的导出写法，照着加；如果它不是 `export *` 风格，就按它的风格逐个导出。）

- [ ] **Step 4: 跑测试确认通过**

Run: `node scripts/run-tests.mjs tests/tool-families.test.ts`
Expected: PASS（3 个用例）。`npm run layers:check` 通过。

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
// A call by a name a tool family replaced (`../protocol/tool-families.ts`) runs as the family call it now is.
// Only names that are not registered are rewritten, so an embedder's own tool of an old name still wins.
if (!this.entries.has(call.name)) call = resolveToolAlias(call);
```

`executionMode(call)` 的第一行同样加 `if (!this.entries.has(call.name)) call = resolveToolAlias(call);`。

新增：

```ts
  /** The registered tool of this name, for assembly code that composes tools; not for dispatch. */
  tool(name: string): Tool | undefined {
    return this.entries.get(name)?.tool;
  }
```

如果 `execute` 的参数是 `const` 或被别的地方当作原对象引用，就改成 `const resolved = ...`，并把函数里后面对 `call` 的引用都换成 `resolved`。审批描述、钩子、文件日志看到的就都是新名。

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
- `YUANTU_TOOL_ALLOWLIST` 拆出名字后，经 `TOOL_ALIASES.get(name)?.tool ?? name` 映射再去重。

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

### Task 5: 旧名在规则、钩子、加载记录和历史里继续有效

**Files:**

- Modify: `packages/protocol/permission-policy.ts`（编译规则时改写旧名）
- Modify: `apps/desktop/permission-settings.ts:117`（`terminal_send` 规则改用新名）
- Modify: `packages/resources/hook-bridge.ts`（匹配 subject 时也试旧名，payload 带上 `tool_action`）
- Modify: `packages/tools/deferred-tools.ts`（`addLoadedTools` 映射旧名）
- Modify: `packages/core/run/request.ts:431` 附近（发请求前改写历史里的旧名）
- Modify: `benchmarks/swe-bench/adapter.mjs:69-72,167-172`、`benchmarks/performance-cases.ts:42,165-166`
- Test: `tests/tool-families.test.ts`（追加）

**Interfaces:**

- Consumes: Task 1 的 `TOOL_ALIASES`、`resolveToolAlias`、`aliasedToolNames`。
- Produces: `export function rewriteToolHistory(messages: readonly Message[]): readonly Message[]`（`packages/protocol/tool-families.ts`；没有旧名时返回同一个数组）。

- [ ] **Step 1: 写失败的测试（追加）**

```ts
import { PermissionPolicy } from '../packages/protocol/permission-policy.ts';
import { loadedTools } from '../packages/tools/deferred-tools.ts';
import { rewriteToolHistory } from '../packages/protocol/tool-families.ts';

test('a permission rule written for an old name governs the family action it became', () => {
  const policy = new PermissionPolicy({
    version: 1,
    rules: [
      { effect: 'allow', kind: 'command' },
      { effect: 'ask', tool: 'terminal_send' },
    ],
  });
  const approval = (action: string) => ({
    kind: 'command' as const,
    description: '',
    toolCall: { id: 'x', name: 'terminal', arguments: { action, id: 't1', input: 'ls' } },
  });
  assert.equal(policy.decide(approval('send')), 'ask');
  assert.equal(policy.decide(approval('open')), 'allow');
});

test('a tool loaded by its old name stays loaded', () => {
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

test('history calls by old names are sent under the current ones, and current history is untouched', () => {
  const current = [{ role: 'user' as const, content: 'hi' }];
  assert.equal(rewriteToolHistory(current), current);
  const rewritten = rewriteToolHistory([
    {
      role: 'assistant',
      content: '',
      toolCalls: [{ id: 'g', name: 'git_log', arguments: { count: 3 } }],
    },
  ]);
  assert.deepEqual((rewritten[0] as { toolCalls: unknown[] }).toolCalls, [
    { id: 'g', name: 'git', arguments: { action: 'log', count: 3 } },
  ]);
});
```

`PermissionPolicy` 构造函数和 `Message` 的确切类型，照 `tests/permission-policy*.test.ts` 和 `packages/protocol/index.ts` 里的写法调整。

- [ ] **Step 2: 跑测试确认失败**

Run: `node scripts/run-tests.mjs tests/tool-families.test.ts`
Expected: 新增的 3 个用例 FAIL。

- [ ] **Step 3: 实现**

`tool-families.ts` 加：

```ts
/**
 * The transcript as the current catalog names it.
 *
 * A session recorded before the merge holds calls by old names, and a provider may refuse a history that calls a
 * tool its request does not declare. Rewriting on the way out keeps the stored log as it happened.
 */
export function rewriteToolHistory<
  M extends {
    role: string;
    toolCalls?: readonly { name: string; arguments: Record<string, unknown> }[];
  },
>(messages: readonly M[]): readonly M[] {
  if (
    !messages.some(
      (m) => m.role === 'assistant' && m.toolCalls?.some((c) => TOOL_ALIASES.has(c.name)),
    )
  )
    return messages;
  return messages.map((m) =>
    m.role === 'assistant' && m.toolCalls?.some((c) => TOOL_ALIASES.has(c.name))
      ? { ...m, toolCalls: m.toolCalls.map((c) => resolveToolAlias(c)) }
      : m,
  );
}
```

`request.ts`：`messages: resendNote ? [...context.messages, resendNote] : context.messages` 改为先 `const history = rewriteToolHistory(context.messages);`，再用 `history`。如果 `context.ts:557` 的压缩请求也带 `tools`，在那里做同样的处理；不带 `tools` 就不改。

`permission-policy.ts`：在构造函数里、规则校验通过之后，把每条 `tool` 是旧名的规则改写成：

```ts
const alias = rule.tool === undefined ? undefined : TOOL_ALIASES.get(rule.tool);
if (alias)
  rule = rule.arguments
    ? { ...rule, tool: alias.tool, arguments: { action: alias.action, ...rule.arguments } }
    : { ...rule, tool: alias.tool, match: { ...(rule.match ?? {}), action: alias.action } };
```

改写要在 `this.compiled`（匹配用的编译结果）生成之前做，不然 `match` 里新加的 `action` 不会被编译。`action` 的值不含 glob 特殊字符，按字面匹配。

`permission-settings.ts:117`：改为 `{ effect: 'ask', tool: 'terminal', match: { action: 'send' } }`，注释不变。

`hook-bridge.ts`：在 `dispatch` 里，把 `hookMatcherMatches(declaration.matcher, subject)` 改成"subject 或 `aliasedToolNames(subject, action)` 里任何一个匹配"；`action` 从 payload 的 `tool_input.action` 取（看 `hook-bridge.ts:232` 附近 payload 是怎么组的）。payload 加 `tool_action: action`（只有合并工具才加）。

`deferred-tools.ts` 的 `addLoadedTools`：两处 `deferrable.has(name)` 之前，先 `const current = TOOL_ALIASES.get(name)?.tool ?? name;`，再用 `current`。

`benchmarks/swe-bench/adapter.mjs`：路径提取改为认 `manage_file`（`action === 'move'` 时取 `from`、`to`，否则取 `path`）和 `edit_file` 的 `edits` 数组；167–172 行的写工具清单把 `delete_file`、`move_file`、`batch_edit` 换成 `manage_file`。`benchmarks/performance-cases.ts`：`batch_edit` 改为 `edit_file` 加 `action: 'batch'`，判断条件跟着改。

- [ ] **Step 4: 跑测试确认通过**

Run: `node scripts/run-tests.mjs tests/tool-families.test.ts tests/permission-policy.test.ts tests/hook-bridge.test.ts tests/deferred-tools.test.ts tests/swe-bench.test.ts`
（文件名以仓库里实际存在的为准，用 Glob 找 `tests/*permission*`、`tests/*hook*`、`tests/*deferred*`。）
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add packages apps benchmarks tests
git commit -m "feat: keep replaced tool names working in rules, hooks, loads and history"
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
- 钩子一节说明：钩子的 matcher 用旧名也能匹配，payload 新增 `tool_action`。

- [ ] **Step 2: 生成事实与快照**

Run: `npm run docs:generate`，然后 `npm run docs:check`。
Expected: 自动生成块里的工具数是 39 个（空工作区，全部，含终端）/ 首个请求 20 个；数字不同时，先找出原因再改，不要直接照抄生成结果。

Run: `npm run snapshot:update`，再看 `git diff tests/snapshots`：确认只是工具清单与 schema 字节数变了，系统提示词正文没变。

- [ ] **Step 3: 全量验证**

Run: `npm run typecheck`、`npm run lint`、`npx prettier --check . --log-level warn`、`npm run layers:check`、`npm run cycles:check`、`npm run references:check`、`npm run i18n:check`、`npm run build`
Run: `FOUNDRY_TEST_CONTINUE_ON_FAILURE=1 npm test`
Expected: 全部通过；日志里 `Phase parallel` 和 `Phase serial` 的文件数加起来等于测试文件总数（确认真的跑完了一整轮）。

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
