import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Agent } from '../packages/core/agent.ts';
import { SubAgentResidency } from '../packages/core/residency.ts';
import { sessionQueryTools } from '../packages/core/session-query.ts';
import { SessionStore } from '../packages/storage/sqlite.ts';
import { RUN_SCOPED_TOOLS, ToolRegistry } from '../packages/tools/registry.ts';
import type { Disposer } from '../packages/tools/dispatch.ts';
import type { ModelResponse, Provider, Tool } from '../packages/protocol/index.ts';

/**
 * What a delegated child must not inherit.
 *
 * A run installs the tools that belong to *it* with `replace`: the delegation family, the resident control
 * surface, the goal tools, the attempt's `task_step`, the plan tools, the report tool. A child works on a copy
 * of its parent's registry (`forRun`), so those installs are also the set that has to be stripped from the
 * copy — which is why they are declared in `RUN_SCOPED_TOOLS` and why the list is the mechanism rather than a
 * convention.
 *
 * The shipped entry points (CLI, Host) hand every child its own registry through `childTools`, which is why a
 * name missing from the list stays invisible there; an embedder that does not provide that seam gets the copy.
 * That is how `subagent_fork`, `list_subagent_models` and `send_message` were reachable: each captures the
 * parent's coordinator or residency, and each is now declared. `send_message` is the one that matters most —
 * its lineage check reads the session id out of the same closure, so the parent's copy passes the child's own
 * check and lets it drive its siblings.
 *
 * Two assertions, because either one alone can be satisfied by an accident:
 *
 * 1. **The copy is clean**: nothing declared run-scoped survives `forRun()`, and the tools really were on the
 *    parent's registry first (otherwise the test would pass on an empty registry forever).
 * 2. **The list is complete**: every tool a real root run installed with `replace` is declared — so the next
 *    run-scoped tool fails this test instead of quietly reaching children.
 *
 * The one deliberate exception is the session-query family: every run installs its own copies for its own
 * session, so a child inherits nothing it would not have built for itself. Deriving that set from the factory
 * rather than listing names keeps the exception honest.
 */

/** A registry that remembers what the run replaced, which is what "run-scoped" means in practice. */
class RecordingRegistry extends ToolRegistry {
  readonly replaced: string[] = [];
  override replace(tool: Tool): Disposer {
    this.replaced.push(tool.name);
    return super.replace(tool);
  }
}

test('a run installs its own tools, and a child copy inherits none of them', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-run-scoped-'));
  const store = new SessionStore(path.join(root, 'sessions.sqlite'));
  const residency = new SubAgentResidency();
  t.after(async () => {
    await residency.disposeAll();
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  const session = store.create(root);
  const provider: Provider = {
    async complete(): Promise<ModelResponse> {
      return {
        text: 'Done',
        toolCalls: [],
        finishReason: 'stop',
        usage: { inputTokens: 1, outputTokens: 1 },
      };
    },
  };
  const tools = new RecordingRegistry();
  t.after(() => tools.close());
  await new Agent({
    store,
    provider,
    tools,
    approve: async () => true,
    // Everything a root run can install for itself: the delegation family, the model list, and the control
    // surface for resident children.
    subagents: { enabled: true },
    subagentResidency: residency,
    childTools: () => new ToolRegistry(),
    subagentModels: () => [{ model: 'declared-model' }],
  }).run({ sessionId: session.id, prompt: 'go' });

  const installed = new Set(tools.specs().map((spec) => spec.name));
  /**
   * The parent really has them, so "the copy does not" is a statement about the copy.
   *
   * These six are the delegation family: the two that were missing from the list (`subagent_fork`,
   * `list_subagent_models`) and `send_message` are named individually because they are the defect this test
   * was written for, and a passing test that never saw them would prove nothing.
   */
  for (const name of [
    'delegate_task',
    'subagent_fork',
    'collect_subagents',
    'workflow',
    'list_subagent_models',
    'send_message',
  ])
    assert.ok(
      installed.has(name),
      `${name} is installed on the registry of the run that may delegate`,
    );

  const inherited = tools.forRun();
  t.after(() => inherited.close());
  const offered = new Set(inherited.specs().map((spec) => spec.name));
  for (const name of RUN_SCOPED_TOOLS)
    assert.equal(
      offered.has(name),
      false,
      `${name} belongs to the parent's run and must not reach a delegated child`,
    );

  /**
   * And the list is complete.
   *
   * A run that installs a tool for itself must declare it, or the copy keeps it — which is the whole bug. The
   * session-query tools are the documented exception, built here through the same factory the run uses.
   */
  const inheritable = new Set(
    sessionQueryTools({ store, workspace: root, sessionId: session.id }).map((tool) => tool.name),
  );
  const declared = new Set<string>(RUN_SCOPED_TOOLS);
  const undeclared = [...new Set(tools.replaced)].filter(
    (name) => !declared.has(name) && !inheritable.has(name),
  );
  assert.deepEqual(
    undeclared,
    [],
    'a tool a run installs with replace must be declared in RUN_SCOPED_TOOLS (or be a session-query tool)',
  );
});
