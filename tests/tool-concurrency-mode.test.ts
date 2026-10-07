/**
 * Which calls may overlap a sibling, decided by the registry and not by the tool's name.
 *
 * The rule is a promise, so the tests are about what happens when nothing promises anything: an unknown tool,
 * a tool that needs approval, a classifier that throws or answers something that is not `true`, and arguments
 * that do not validate all mean *serial*. A tool that quietly joins the parallel set by accident is the
 * failure this file exists to prevent — which is why the shipped set is pinned below: adding a tool to it
 * must be a decision someone makes here on purpose.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createTools } from '../packages/tools/index.ts';
import type { Tool } from '../packages/protocol/index.ts';

const tool = (name: string, extra: Partial<Tool> = {}): Tool => ({
  name,
  description: 'test tool',
  inputSchema: {
    type: 'object',
    properties: { path: { type: 'string' } },
    required: ['path'],
    additionalProperties: false,
  },
  execute: async () => ({ isError: false, content: 'ok' }),
  ...extra,
});
async function registry(t: test.TestContext) {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-mode-'));
  // `load_skill` only exists where a project skill does, so the workspace needs one for the pinned set below
  // to describe the build a user actually gets.
  await mkdir(path.join(root, '.agents', 'skills', 'demo'), { recursive: true });
  await writeFile(
    path.join(root, '.agents', 'skills', 'demo', 'SKILL.md'),
    '---\ndescription: demo skill\n---\n\nDo the demo.\n',
  );
  const tools = createTools(root);
  t.after(async () => {
    await tools.close?.();
    await rm(root, { recursive: true, force: true });
  });
  return tools;
}
const call = (name: string, args: Record<string, unknown> = { path: 'a.txt' }) => ({
  id: 'c1',
  name,
  arguments: args,
});

test('only an explicit true opts a call in, and everything else is exclusive', async (t) => {
  const tools = await registry(t);
  tools.register(tool('yes', { isConcurrencySafe: () => true }));
  tools.register(tool('no', { isConcurrencySafe: () => false }));
  tools.register(tool('truthy', { isConcurrencySafe: (() => 'yes') as unknown as () => boolean }));
  tools.register(
    tool('throws', {
      isConcurrencySafe: () => {
        throw new Error('classifier is broken');
      },
    }),
  );
  tools.register(tool('silent'));
  tools.register(tool('needs-approval', { permission: 'write', isConcurrencySafe: () => true }));
  assert.equal(tools.executionMode(call('yes')), 'parallel');
  assert.equal(tools.executionMode(call('no')), 'exclusive');
  // A classifier that answers something which is merely truthy did not make the promise the type asks for.
  assert.equal(tools.executionMode(call('truthy')), 'exclusive');
  assert.equal(tools.executionMode(call('throws')), 'exclusive');
  assert.equal(tools.executionMode(call('silent')), 'exclusive');
  // A tool that needs approval never overlaps: the human is asked one question at a time, in model order, and
  // the effect journal entry belongs to exactly one call.
  assert.equal(tools.executionMode(call('needs-approval')), 'exclusive');
  assert.equal(tools.executionMode(call('not-registered')), 'exclusive');
  // Invalid arguments are the model's own error to read, one at a time and in the order it wrote them.
  assert.equal(tools.executionMode(call('yes', {})), 'exclusive');
});

test('a classifier that is not a function is refused where it is installed', async (t) => {
  const tools = await registry(t);
  assert.throws(
    () => tools.register(tool('broken', { isConcurrencySafe: 'yes' as unknown as () => boolean })),
    /isConcurrencySafe must be a function/,
    'a declaration that cannot run must not silently mean "serial forever"',
  );
  // The registry is unchanged by the refusal, so nothing half-installed is left behind.
  assert.equal(tools.executionMode(call('broken')), 'exclusive');
});

/**
 * A minimal argument object that satisfies a tool's schema, so a probe measures the *declaration* and not
 * "the arguments happened to be invalid" — an invalid-argument call is exclusive for a different reason, and
 * a test that confused the two would pass for the wrong tool.
 */
function probeFor(schema: Record<string, unknown>): Record<string, unknown> {
  const properties = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;
  const required = (schema.required ?? []) as string[];
  const probe: Record<string, unknown> = {};
  for (const name of required) {
    const spec = properties[name] ?? {};
    if (spec.type === 'integer' || spec.type === 'number') probe[name] = 1;
    else if (spec.type === 'boolean') probe[name] = true;
    else if (spec.type === 'array') probe[name] = [];
    else if (Array.isArray(spec.enum)) probe[name] = spec.enum[0];
    else probe[name] = 'a';
  }
  return probe;
}

test('the shipped read-only tools opt in, and nothing that writes does', async (t) => {
  const tools = await registry(t);
  const specs = tools.specs();
  const mode = (name: string, schema: Record<string, unknown>) =>
    tools.executionMode({ id: 'probe', name, arguments: probeFor(schema) });
  const parallel = specs
    .filter((spec) => mode(spec.name, spec.inputSchema) === 'parallel')
    .map((spec) => spec.name);
  /**
   * Every entry here is a tool that only reads: a path chooses *what* is read, never whether anything is
   * written. Deliberately absent, each for a reason: the LSP tools share one language-server session and its
   * document state; `todo_write` writes this session's checklist; `ask_user_question` waits on a person;
   * `collect_subagents` marks children collected; `job_kill` stops a job; every file mutation, command and
   * network call declares a permission and is therefore exclusive whatever it says.
   */
  assert.deepEqual(parallel.sort(), [
    'git_branches',
    'git_diff',
    'git_log',
    'git_status',
    'git_worktrees',
    'job_list',
    'job_output',
    'list_files',
    'list_memories',
    'load_skill',
    'office_inspect',
    'read_file',
    'read_image',
    'recall_knowledge',
    'repo_map',
    'search_files',
    'verify_file_delivery',
  ]);
  // The other direction, with valid arguments: the calls that change something are exclusive even though a
  // probe of them looks exactly like a probe of a reader.
  const forbidden = new Set([
    'write_file',
    'edit_file',
    'apply_patch',
    'delete_file',
    'move_file',
    'batch_edit',
    'run_command',
    'start_command',
    'write_command',
    'run_validation',
    'todo_write',
    'ask_user_question',
    'job_kill',
    'web_fetch',
    'web_search',
    'browser_click',
    'git_stage',
    'git_commit',
    'save_memory',
    'forget_memory',
    'index_document',
    'office_create',
    // Read-only in name, but they share the language server session: two of them at once would interleave
    // edits into one document, and the writes among them do not even declare a permission to fence them.
    'lsp_diagnostics',
    'lsp_rename',
    'lsp_apply_code_action',
  ]);
  const shipped = new Set(specs.map((spec) => spec.name));
  for (const spec of specs)
    if (forbidden.has(spec.name))
      assert.equal(
        mode(spec.name, spec.inputSchema),
        'exclusive',
        `${spec.name} must not overlap a sibling call`,
      );
  // A guard against a typo in the list above quietly weakening this test.
  const missing = [...forbidden].filter((name) => !shipped.has(name));
  assert.deepEqual(missing, [], 'every tool named here is a tool this build actually ships');
});
