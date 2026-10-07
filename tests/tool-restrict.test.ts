/**
 * Narrowing a registry, where "cannot see it" and "cannot call it" are one fact.
 *
 * A tool registry has two audiences for the same question — `specs()` decides what the model is told exists, and
 * `execute()` decides what it may actually run — and the failure this suite exists to prevent is those two
 * drifting apart. A tool that is hidden from the schema but still callable is a capability the prompt denies and
 * the runtime grants; a tool that is callable but unlisted is a mystery the model has to discover by guessing.
 *
 * So the assertions come in pairs, from the same restriction, and the interesting cases are the ones with a
 * *second* restriction in play: two policies that both narrow a set have to compose without either knowing about
 * the other, and the order they were declared in must not change the answer.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { ToolRegistry } from '../packages/tools/registry.ts';
import type { Tool, ToolCall, ToolContext } from '../packages/protocol/index.ts';

const context = (): ToolContext => ({
  signal: new AbortController().signal,
  approve: async () => true,
});
const call = (name: string): ToolCall => ({ id: `call-${name}`, name, arguments: {} });
const echo = (name: string): Tool => ({
  name,
  description: `Echoes ${name}`,
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  execute: async () => ({ isError: false, content: `${name} ran` }),
});
const names = (registry: ToolRegistry): string[] =>
  registry
    .specs()
    .map((spec) => spec.name)
    .sort();

test('a restricted tool is unlisted and refuses to run, from one rule', async () => {
  const registry = new ToolRegistry();
  registry.register(echo('visible'));
  registry.register(echo('hidden'));
  const release = registry.restrict({ deny: ['hidden'] });

  assert.deepEqual(names(registry), ['visible']);
  assert.equal(registry.offers('hidden'), false);
  const refused = await registry.execute(call('hidden'), context());
  assert.equal(refused.isError, true);
  assert.match(refused.content, /not available in this run/);
  // The refusal must not read as a typo: the model has to be told the exclusion is deliberate.
  assert.doesNotMatch(refused.content, /Unknown tool/);
  // And the tool that is still offered still runs.
  const allowed = await registry.execute(call('visible'), context());
  assert.deepEqual(allowed, { isError: false, content: 'visible ran' });

  // The handle restores exactly what was there: one rule, one scope, one undo.
  release();
  assert.deepEqual(names(registry), ['hidden', 'visible']);
  assert.equal((await registry.execute(call('hidden'), context())).content, 'hidden ran');
});

test('a restriction names a tool that does not exist yet, and still binds when it does', async () => {
  // The reason restrictions are decided by name rather than by looking the tool up: `delegate_task` and the other
  // run-scoped tools are installed per run by `replace`, so a policy installed before a run starts cannot see
  // them — and a restriction built from "what is registered right now" would silently miss them.
  const registry = new ToolRegistry();
  const release = registry.restrict({ deny: ['delegate_task'] });
  registry.replace(echo('delegate_task'));
  assert.equal(registry.offers('delegate_task'), false);
  assert.deepEqual(names(registry), []);
  release();
  assert.deepEqual(names(registry), ['delegate_task']);
});

test('two restrictions compose by intersection, and the order they were pushed cannot change it', async () => {
  const registry = new ToolRegistry();
  for (const name of ['a', 'b', 'c']) registry.register(echo(name));
  const releaseFirst = registry.restrict({ allow: ['a', 'b'] });
  const releaseSecond = registry.restrict({ allow: ['b', 'c'] });
  // `allow` ∩ `allow`: the tool must satisfy every rule in force, so only the overlap survives.
  assert.deepEqual(names(registry), ['b']);

  releaseSecond();
  assert.deepEqual(names(registry), ['a', 'b']);
  releaseFirst();
  assert.deepEqual(names(registry), ['a', 'b', 'c']);
});

test('a deny scope and an allow scope reach the same answer about the same tool', async () => {
  // "deny everything but these" and "allow only these" are one statement read in two directions; the two chains
  // are normalized into one so that a policy cannot mean different things depending on which form it was given.
  const mixed = new ToolRegistry();
  mixed.register(echo('a'));
  mixed.register(echo('b'));
  mixed.restrict({ deny: ['b'] });
  const allowedForm = new ToolRegistry();
  allowedForm.register(echo('a'));
  allowedForm.register(echo('b'));
  allowedForm.restrict({ allow: ['a'] });
  assert.deepEqual(names(mixed), names(allowedForm));
  assert.equal(mixed.offers('b'), false);
  assert.equal(allowedForm.offers('b'), false);
});

test('releasing one of two scopes twice, or a scope that was already released, is harmless', async () => {
  const registry = new ToolRegistry();
  registry.register(echo('a'));
  registry.register(echo('b'));
  const release = registry.restrict({ deny: ['b'] });
  release();
  release();
  assert.deepEqual(names(registry), ['a', 'b']);
});

test('a malformed restriction is refused rather than read as one of its meanings', async () => {
  const registry = new ToolRegistry();
  assert.throws(() => registry.restrict({}), /exactly one of/);
  assert.throws(() => registry.restrict({ allow: ['a'], deny: ['b'] }), /exactly one of/);
  // Either one alone is well formed, including a list that admits nothing.
  const release = registry.restrict({ allow: [] });
  assert.deepEqual(names(registry), []);
  release();
});

test('a bound deny excludes the tools it named, not the name itself', async () => {
  /**
   * The distinction a delegated run depends on, and the one that is easy to get wrong in the obvious direction.
   *
   * `replace()` is how a child installs its **own** run-scoped tools under stable names — `submit_report` is the
   * tool a delegated child is required to answer with, and the parent's registry usually carries that same name.
   * A deny that followed the *name* would take the child's own tool away and it could never report; a deny bound
   * to the entries that were present when the allowlist was installed says what the allowlist means — *these*
   * tools are the parent's — and lets a replacement through. The public way to get such a deny is `forRun`, so
   * that is what this test drives.
   */
  const parent = new ToolRegistry();
  parent.register(echo('read_file'));
  parent.register(echo('write_file'));
  const child = parent.forRun({ allow: ['read_file'] });
  assert.equal(child.offers('write_file'), false);

  // The same name, a different tool: this is what the child's own `replace` does, and it is not the tool the
  // allowlist excluded.
  child.replace(echo('write_file'));
  assert.equal(child.offers('write_file'), true);
  assert.equal((await child.execute(call('write_file'), context())).content, 'write_file ran');

  // A name-only deny is the other half of the same distinction, and it is what `restrict({deny})` means when no
  // entries are bound: it takes away whatever carries the name, including a later replacement.
  const strict = new ToolRegistry();
  strict.register(echo('shared'));
  const release = strict.restrict({ deny: ['shared'] });
  strict.replace(echo('shared'));
  assert.equal(strict.offers('shared'), false);
  release();
  assert.equal(strict.offers('shared'), true);
});

test('a delegated run gets its allowlist as a restriction, so its own specs and calls agree', async () => {
  const parent = new ToolRegistry();
  for (const name of ['read_file', 'write_file', 'job_kill']) parent.register(echo(name));
  parent.replace(echo('delegate_task'));
  const child = parent.forRun({ allow: ['read_file'] });
  assert.deepEqual(names(child), ['read_file']);
  assert.equal(child.offers('write_file'), false);
  const refused = await child.execute(call('write_file'), context());
  assert.match(refused.content, /not available in this run/);
  // The tool the copy allows still works, so the restriction is a narrowing and not a lockout.
  assert.equal((await child.execute(call('read_file'), context())).content, 'read_file ran');
  // Run-scoped tools are *removed* rather than restricted, and the refusal says so: they belong to the run that
  // installed them, so in a copy they do not exist at all. That is a different answer from "this run may not use
  // it", and it is the one a reader of the child's transcript should get.
  assert.equal(child.offers('delegate_task'), false);
  assert.match((await child.execute(call('delegate_task'), context())).content, /Unknown tool/);
  // The parent is untouched by anything the copy did.
  assert.equal(parent.offers('write_file'), true);
  assert.deepEqual(names(parent).includes('delegate_task'), true);
});
