import test from 'node:test';
import assert from 'node:assert/strict';
import { MAX_TOOL_OUTPUT, HookRegistry, ToolRegistry } from '../packages/tools/registry.ts';
import { PIPELINE_ORDER, ToolPipelineInvariant } from '../packages/tools/pipeline.ts';
import type { PipelineStage, ToolExecution } from '../packages/tools/pipeline.ts';
import type { Tool, ToolCall, ToolContext } from '../packages/protocol/index.ts';
import {
  ListenerSet,
  dispatchEmit,
  dispatchFirst,
  dispatchSerial,
  dispatchThreaded,
  dispatchWaterfall,
} from '../packages/tools/dispatch.ts';
import { ToolTimeoutError } from '../packages/tools/timeouts.ts';

// ---- merged from tool-pipeline.test.ts ----

/**
 * The tool execution pipeline.
 *
 * `packages/tools/registry.ts` used to run its stages inline, in one long `execute()`: validation,
 * then the extension hooks, then the tool's own preparation, then approval, then the body, then the
 * observers. Nothing named the order, so "where does a redaction belong?" was answered by editing the
 * function, and nothing checked the order, so a future edit could run a policy stage after the effect
 * it was supposed to police without a single test noticing.
 *
 * The suite pins down three things: the order itself (asserted against the runtime trace of real
 * calls), what each stage is allowed to decide (deny-only guards, post-execute policy, content-only
 * finalization), and that every registration can be taken back out again.
 */

const context = (overrides: Partial<ToolContext> = {}): ToolContext => ({
  signal: new AbortController().signal,
  approve: async () => true,
  ...overrides,
});
const call = (name: string, args: Record<string, unknown> = {}): ToolCall => ({
  id: `call-${name}`,
  name,
  arguments: args,
});
/** A tool that echoes `text`, so a test can tell the body's result from a policy replacement. */
const echo = (overrides: Partial<Tool> = {}): Tool => ({
  name: 'echo',
  description: 'Echo text back',
  inputSchema: {
    type: 'object',
    properties: { text: { type: 'string' } },
    additionalProperties: false,
  },
  execute: async (args) => ({ isError: false, content: String(args.text ?? '') }),
  ...overrides,
});
/** The stage trace of the most recent completed call, which is what the invariant checks in the run. */
const lastTrace = (registry: ToolRegistry): PipelineStage[] =>
  registry.pipelineInvariant.history.at(-1)?.stages ?? [];

test('the pipeline runs every stage in order for a permission-free tool', async () => {
  const registry = new ToolRegistry();
  registry.register(echo());
  let captured: ToolExecution | undefined;
  registry.registerGuard((execution) => {
    captured = execution;
  });
  const result = await registry.execute(call('echo', { text: 'hi' }), context());
  assert.equal(result.isError, false);
  assert.equal(result.content, 'hi');
  assert.deepEqual(captured && registry.pipelineInvariant.trace(captured), [
    'validate',
    'pre-execute',
    'guards',
    'prepare',
    'execute',
    'post-execute',
    'finalize',
    'result',
  ]);
  assert.equal(registry.pipelineInvariant.violations.length, 0, 'a normal call violates nothing');
});

test('a permission-carrying tool adds the approval stage between prepare and execute', async () => {
  const registry = new ToolRegistry();
  const approvals: string[] = [];
  registry.register(echo({ permission: 'write' }));
  await registry.execute(
    call('echo', { text: 'hi' }),
    context({
      approve: async (approval) => {
        approvals.push(approval.kind);
        return true;
      },
    }),
  );
  assert.deepEqual(approvals, ['write']);
  assert.deepEqual(lastTrace(registry), [
    'validate',
    'pre-execute',
    'guards',
    'prepare',
    'approval',
    'execute',
    'post-execute',
    'finalize',
    'result',
  ]);
});

test('an early exit still ends at the result stage', async () => {
  const registry = new ToolRegistry();
  registry.register(echo());
  const unknown = await registry.execute(call('missing'), context());
  assert.match(unknown.content, /Unknown tool: missing/);
  assert.deepEqual(lastTrace(registry), ['validate', 'result']);

  const invalid = await registry.execute(call('echo', { text: 1 }), context());
  assert.match(invalid.content, /Invalid arguments/);
  assert.deepEqual(lastTrace(registry), ['validate', 'result']);
  assert.equal(registry.pipelineInvariant.violations.length, 0);
});

test('a pre-execute denial ends before the guards run', async () => {
  const registry = new ToolRegistry();
  let bodyRan = false;
  let guardRan = false;
  registry.register(
    echo({ execute: async () => ((bodyRan = true), { isError: false, content: '' }) }),
  );
  registry.registerGuard(() => {
    guardRan = true;
  });
  registry.registerHooks({ beforeTool: () => false });
  const result = await registry.execute(call('echo'), context());
  assert.equal(result.isError, true);
  assert.match(result.content, /Operation denied by extension/);
  assert.deepEqual(lastTrace(registry), ['validate', 'pre-execute', 'result']);
  assert.equal(bodyRan, false);
  assert.equal(guardRan, false, 'a denial that already happened must not run later stages');
});

test('guards run after every pre-execute hook and deny with a reason', async () => {
  const registry = new ToolRegistry();
  const order: string[] = [];
  let bodyRan = false;
  registry.register(
    echo({ execute: async () => ((bodyRan = true), { isError: false, content: '' }) }),
  );
  registry.registerHooks({ beforeTool: () => void order.push('hook') });
  registry.registerGuard(() => {
    order.push('guard');
    return { deny: 'no network in this profile' };
  });
  const result = await registry.execute(call('echo'), context());
  assert.deepEqual(order, ['hook', 'guard']);
  assert.equal(result.isError, true);
  assert.match(result.content, /Operation denied by guard: no network in this profile/);
  assert.deepEqual(lastTrace(registry), ['validate', 'pre-execute', 'guards', 'result']);
  assert.equal(bodyRan, false);
});

test('a guard that throws denies instead of allowing', async () => {
  const registry = new ToolRegistry();
  registry.register(echo());
  registry.registerGuard(() => {
    throw new Error('policy engine unreachable');
  });
  const result = await registry.execute(call('echo'), context());
  assert.equal(result.isError, true);
  assert.match(result.content, /Operation denied: guard failed \(policy engine unreachable\)/);
});

test('neither a hook nor a guard can grant what the approval layer refuses', async () => {
  const registry = new ToolRegistry();
  let bodyRan = false;
  registry.register(
    echo({
      permission: 'command',
      execute: async () => ((bodyRan = true), { isError: false, content: '' }),
    }),
  );
  registry.registerHooks({ beforeTool: () => true });
  registry.registerGuard(() => undefined);
  const result = await registry.execute(call('echo'), context({ approve: async () => false }));
  assert.equal(result.isError, true);
  assert.match(result.content, /Permission denied by user/);
  assert.equal(bodyRan, false);
});

test('cancellation during a guard stays a cancellation, not a denial', async () => {
  const registry = new ToolRegistry();
  registry.register(echo());
  const controller = new AbortController();
  registry.registerGuard(
    (_execution, signal) =>
      new Promise((_resolve, reject) =>
        signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }),
      ),
  );
  const pending = registry.execute(call('echo'), context({ signal: controller.signal }));
  setTimeout(() => controller.abort(), 30);
  await assert.rejects(pending, { name: 'AbortError' });
});

test('post-execute can inject model-visible context without touching the result', async () => {
  const registry = new ToolRegistry();
  registry.register(echo());
  registry.registerHooks({
    postExecute: () => ({
      action: 'add-context',
      context: 'The file was reformatted by prettier.',
    }),
  });
  const result = await registry.execute(call('echo', { text: 'body' }), context());
  assert.equal(result.isError, false);
  assert.equal(result.content, 'body');
  assert.deepEqual(result.additionalContext, ['The file was reformatted by prettier.']);
});

test('block wins over a later replacement', async () => {
  const registry = new ToolRegistry();
  registry.register(echo());
  registry.registerHooks({ postExecute: () => ({ action: 'block', reason: 'contains a secret' }) });
  registry.registerHooks({
    postExecute: () => ({ action: 'replace-content', content: 'unblocked' }),
  });
  const result = await registry.execute(call('echo', { text: 'token=abc' }), context());
  assert.equal(result.isError, true);
  assert.match(result.content, /Tool result blocked by extension policy: contains a secret/);
});

test('replace-content chains with the last replacement winning and keeps the failure flag', async () => {
  const registry = new ToolRegistry();
  registry.register(echo());
  registry.registerHooks({ postExecute: () => ({ action: 'replace-content', content: 'first' }) });
  registry.registerHooks({ postExecute: () => ({ action: 'replace-content', content: 'second' }) });
  const result = await registry.execute(call('echo', { text: 'body' }), context());
  assert.equal(result.content, 'second');
  assert.equal(result.isError, false);
});

test('replacing a failed result is refused rather than turning it into a success', async () => {
  const registry = new ToolRegistry();
  registry.register(
    echo({
      execute: async () => {
        throw new Error('disk exploded');
      },
    }),
  );
  registry.registerHooks({
    postExecute: () => ({ action: 'replace', result: { isError: false, content: 'all good' } }),
  });
  const result = await registry.execute(call('echo'), context());
  assert.equal(result.isError, true);
  assert.match(result.content, /cannot replace the result of a failed tool call/);
  assert.doesNotMatch(result.content, /all good/);
});

test('a tool body that throws still reaches post-execute and finalize', async () => {
  const registry = new ToolRegistry();
  const seen: string[] = [];
  registry.register(
    echo({
      execute: async () => {
        throw new Error('disk exploded');
      },
    }),
  );
  registry.registerHooks({
    postExecute: (_execution, result) => {
      seen.push(`post:${result.isError}`);
      return { action: 'add-context', context: 'the tool failed' };
    },
    finalizeContent: () => {
      seen.push('finalize');
      return 'final content';
    },
  });
  const result = await registry.execute(call('echo'), context());
  assert.deepEqual(seen, ['post:true', 'finalize']);
  assert.equal(result.isError, true, 'finalize is content-only: it cannot clear the failure');
  assert.equal(result.content, 'final content');
});

test('finalizeContent runs after post-execute and truncation happens after finalize', async () => {
  const registry = new ToolRegistry();
  const order: string[] = [];
  registry.register(echo());
  registry.registerHooks({
    postExecute: () => {
      order.push('post');
      return { action: 'replace-content', content: 'policy' };
    },
    finalizeContent: () => {
      order.push('finalize');
      return 'x'.repeat(MAX_TOOL_OUTPUT + 5000);
    },
  });
  const result = await registry.execute(call('echo', { text: 'body' }), context());
  assert.deepEqual(order, ['post', 'finalize']);
  assert.match(result.content, /\[output truncated\]$/);
  assert.ok(
    result.content.length <= MAX_TOOL_OUTPUT + 32,
    'truncation is the last thing that happens to content',
  );
});

test('afterTool observes the result the model will actually see', async () => {
  const registry = new ToolRegistry();
  const observed: string[] = [];
  registry.register(echo());
  registry.registerHooks({ postExecute: () => ({ action: 'replace-content', content: 'policy' }) });
  registry.registerHooks({ afterTool: (_call, result) => void observed.push(result.content) });
  await registry.execute(call('echo', { text: 'body' }), context());
  assert.deepEqual(observed, ['policy']);
});

test('a pipeline stage that throws becomes a failed call and skips post-execute', async () => {
  const registry = new ToolRegistry();
  let postRan = false;
  registry.register(
    echo({
      prepare: async () => {
        throw new Error('could not read the target file');
      },
    }),
  );
  registry.registerHooks({
    postExecute: () => {
      postRan = true;
    },
  });
  const result = await registry.execute(call('echo'), context());
  assert.equal(result.isError, true);
  assert.match(result.content, /could not read the target file/);
  assert.deepEqual(lastTrace(registry), ['validate', 'pre-execute', 'guards', 'prepare', 'result']);
  assert.equal(postRan, false, 'policy does not police a call that never dispatched');
});

test('every registration can be taken back out', async () => {
  const registry = new ToolRegistry();
  const disposeTool = registry.register(echo());
  const denyHooks = registry.registerHooks({ beforeTool: () => false });
  const disposeGuard = registry.registerGuard(() => ({ deny: 'nope' }));
  let closed = false;
  const disposeClose = registry.onClose(async () => void (closed = true));
  disposeGuard();
  disposeClose();
  await registry.close();
  assert.equal(closed, false, 'a disposed cleanup must not run');
  assert.equal((await registry.execute(call('echo'), context())).isError, true);
  denyHooks();
  const allowed = await registry.execute(call('echo', { text: 'hi' }), context());
  assert.equal(allowed.isError, false, 'the disposed hook must no longer deny');
  disposeTool();
  assert.match((await registry.execute(call('echo'), context())).content, /Unknown tool/);
});

test('a disposed extension takes its tools and its hooks with it', async () => {
  const registry = new ToolRegistry();
  const dispose = registry.registerExtension([echo({ name: 'extra' })], {
    beforeTool: () => false,
  });
  assert.deepEqual(
    registry.specs().map((spec) => spec.name),
    ['extra'],
  );
  assert.equal((await registry.execute(call('extra'), context())).isError, true, 'the hook denies');
  dispose();
  assert.deepEqual(registry.specs(), []);
  assert.match((await registry.execute(call('extra'), context())).content, /Unknown tool/);
});

test('replace hands back the tool it displaced', async () => {
  const registry = new ToolRegistry();
  registry.register(echo());
  const dispose = registry.replace(echo({ description: 'replacement' }));
  assert.equal(registry.specs()[0]?.description, 'replacement');
  dispose();
  assert.equal(registry.specs()[0]?.description, 'Echo text back');
});

test('the hook limit counts live registrations, not registrations ever made', () => {
  const hooks = new HookRegistry();
  const disposers = Array.from({ length: 32 }, () => hooks.register({}));
  assert.throws(() => hooks.register({}), /Invalid extension hooks or hook limit exceeded/);
  disposers[0]!();
  const late = hooks.register({});
  assert.equal(hooks.size, 32);
  late();
  assert.equal(hooks.size, 31);
});

test('the runtime invariant rejects stages that are out of order, repeated or missing', () => {
  const invariant = new ToolPipelineInvariant();
  const execution = (permission?: 'write'): ToolExecution =>
    Object.freeze({
      call: call('echo'),
      tool: 'echo',
      ...(permission ? { permission } : {}),
      attempt: 1,
    });

  const first = execution();
  assert.throws(() => invariant.enter(first, 'execute'), /first stage must be validate/);

  const repeated = execution();
  invariant.enter(repeated, 'validate');
  assert.throws(() => invariant.enter(repeated, 'validate'), /stage repeated/);

  const backwards = execution();
  invariant.enter(backwards, 'validate');
  invariant.enter(backwards, 'result');
  assert.throws(() => invariant.enter(backwards, 'post-execute'), /stage ran out of order/);

  const unguarded = execution();
  invariant.enter(unguarded, 'validate');
  invariant.enter(unguarded, 'pre-execute');
  assert.throws(() => invariant.enter(unguarded, 'execute'), /execute requires guards first/);

  const unapproved = execution('write');
  invariant.enter(unapproved, 'validate');
  invariant.enter(unapproved, 'pre-execute');
  invariant.enter(unapproved, 'guards');
  assert.throws(() => invariant.enter(unapproved, 'execute'), /execute requires approval first/);

  const unfinalized = execution();
  invariant.enter(unfinalized, 'validate');
  invariant.enter(unfinalized, 'pre-execute');
  invariant.enter(unfinalized, 'guards');
  assert.throws(
    () => invariant.enter(unfinalized, 'finalize'),
    /finalize requires post-execute first/,
  );

  const truncated = execution();
  invariant.enter(truncated, 'validate');
  assert.throws(() => invariant.leave(truncated, true), /execution ended after validate/);

  assert.equal(invariant.violations.length, 7, 'every violation is recorded for the operator');
  assert.match(invariant.violations[0]!.detail, /first stage must be validate/);
  assert.equal(invariant.violations[0]!.execution, 'echo#1');
  assert.match(PIPELINE_ORDER, /validate -> pre-execute -> guards/);
});

test('a cancelled pipeline leaves no trace behind and reports nothing', async () => {
  const registry = new ToolRegistry();
  registry.register(
    echo({
      execute: async (_args, toolContext) =>
        new Promise((_resolve, reject) =>
          toolContext.signal.addEventListener('abort', () => reject(new Error('aborted')), {
            once: true,
          }),
        ),
    }),
  );
  const controller = new AbortController();
  const pending = registry.execute(call('echo'), context({ signal: controller.signal }));
  setTimeout(() => controller.abort(), 30);
  await assert.rejects(pending, { name: 'AbortError' });
  assert.deepEqual(registry.pipelineInvariant.history, []);
  assert.deepEqual(registry.pipelineInvariant.violations, []);
});

test('aroundTool wraps the dispatch outermost first and sees the same execution', async () => {
  const registry = new ToolRegistry();
  const order: string[] = [];
  let seenAttempt: number | undefined;
  registry.register(
    echo({
      execute: async () => {
        order.push('body');
        return { isError: false, content: 'body' };
      },
    }),
  );
  registry.registerHooks({
    aroundTool: async (execution, next) => {
      order.push('outer before');
      seenAttempt = execution.execution.attempt;
      const inner = await next();
      order.push('outer after');
      return { ...inner, content: `outer(${inner.content})` };
    },
  });
  registry.registerHooks({
    aroundTool: async (_execution, next) => {
      order.push('inner before');
      const result = await next();
      order.push('inner after');
      return { ...result, content: `inner(${result.content})` };
    },
  });
  const result = await registry.execute(call('echo', { text: 'x' }), context());
  assert.deepEqual(order, ['outer before', 'inner before', 'body', 'inner after', 'outer after']);
  assert.equal(result.content, 'outer(inner(body))');
  assert.equal(seenAttempt, 1);
  assert.deepEqual(lastTrace(registry).slice(0, 5), [
    'validate',
    'pre-execute',
    'guards',
    'prepare',
    'execute',
  ]);
  assert.equal(registry.pipelineInvariant.violations.length, 0);
});

test('a wrapper that returns without delegating fails the call instead of faking a result', async () => {
  const registry = new ToolRegistry();
  let bodyRan = false;
  registry.register(
    echo({
      execute: async () => {
        bodyRan = true;
        return { isError: false, content: 'x' };
      },
    }),
  );
  registry.registerHooks({
    aroundTool: async () => ({ isError: false, content: 'pretend success' }),
  });
  const result = await registry.execute(call('echo'), context());
  assert.equal(result.isError, true);
  assert.match(result.content, /around-tool hook returned without delegating/);
  assert.doesNotMatch(result.content, /pretend success/);
  assert.equal(bodyRan, false);
});

test('a wrapper may delegate twice, which is how a retry is expressed', async () => {
  const registry = new ToolRegistry();
  let attempts = 0;
  registry.register(
    echo({
      execute: async () => {
        attempts++;
        return attempts === 1
          ? { isError: true, content: 'transient failure' }
          : { isError: false, content: 'recovered' };
      },
    }),
  );
  const attemptsSeen: number[] = [];
  registry.registerHooks({
    aroundTool: async (execution, next) => {
      attemptsSeen.push(execution.execution.attempt);
      const first = await next();
      return first.isError ? await next() : first;
    },
  });
  const result = await registry.execute(call('echo'), context());
  assert.equal(result.content, 'recovered');
  assert.equal(attempts, 2, 'the tool body really ran twice');
  assert.deepEqual(
    attemptsSeen,
    [1],
    'the wrapper runs once and delegates twice: one call is one attempt, however often the body re-runs',
  );
  assert.equal(registry.pipelineInvariant.violations.length, 0);
});

// ---- merged from dispatch.test.ts ----

/**
 * The four dispatch modes.
 *
 * Each seam in the runtime used to be its own `for` loop, and each loop re-decided the same questions:
 * does a failure stop the others, does the first answer win, does the value thread through, may a
 * listener wrap the call. These tests pin the answers down by name, because a seam that silently
 * changes mode is a policy that silently stops being applied — the same failure class as a dropped
 * event type.
 */

test('a listener set keeps registration order and hands back its own removal', () => {
  const set = new ListenerSet<string>();
  const first = set.use('a');
  set.use('b');
  assert.deepEqual([...set.all], ['a', 'b']);
  assert.equal(set.size, 2);
  first();
  assert.deepEqual([...set.all], ['b']);
  first();
  assert.deepEqual(
    [...set.all],
    ['b'],
    'disposing twice is a no-op, not a removal of someone else',
  );
});

test('emit notifies everyone and collects failures without stopping', async () => {
  const seen: string[] = [];
  const failures = await dispatchEmit(['a', 'b', 'c'], async (listener) => {
    seen.push(listener);
    return listener === 'b' ? 'b exploded' : undefined;
  });
  assert.deepEqual(seen, ['a', 'b', 'c'], 'a broken observer must not silence the rest');
  assert.deepEqual(failures, ['b exploded']);
});

test('first stops at the first opinion and ignores the rest', async () => {
  const seen: string[] = [];
  const verdict = await dispatchFirst(['allow', 'deny', 'never'], async (listener) => {
    seen.push(listener);
    return listener === 'deny' ? 'refused' : undefined;
  });
  assert.equal(verdict, 'refused');
  assert.deepEqual(seen, ['allow', 'deny']);
  assert.equal(await dispatchFirst(['allow'], async () => undefined), undefined);
});

test('serial threads the value and keeps it when a listener has no opinion', async () => {
  const seen: string[] = [];
  const result = await dispatchSerial(['a', 'b', 'c'], 1, async (listener, value) => {
    seen.push(`${listener}:${value}`);
    return listener === 'b' ? value * 10 : undefined;
  });
  assert.deepEqual(
    seen,
    ['a:1', 'b:1', 'c:10'],
    'each listener sees the value its predecessor left',
  );
  assert.equal(result, 10);
});

test('waterfall wraps the terminal, outermost first, and unwinds in reverse', async () => {
  const seen: string[] = [];
  const result = await dispatchWaterfall(
    ['outer', 'inner'],
    'value',
    async (listener, _value, next) => {
      seen.push(`${listener} before`);
      const inner = await next();
      seen.push(`${listener} after`);
      return `${listener}(${inner})`;
    },
    async (value) => {
      seen.push('terminal');
      return value;
    },
  );
  assert.equal(result, 'outer(inner(value))');
  assert.deepEqual(seen, [
    'outer before',
    'inner before',
    'terminal',
    'inner after',
    'outer after',
  ]);
});

test('an empty waterfall goes straight to the terminal', async () => {
  let terminalRan = 0;
  const result = await dispatchWaterfall(
    [] as string[],
    'x',
    async () => 'never',
    async (value) => {
      terminalRan++;
      return value.toUpperCase();
    },
  );
  assert.equal(result, 'X');
  assert.equal(terminalRan, 1);
});

test('a waterfall listener may delegate more than once, which is what a retry is', async () => {
  let attempts = 0;
  const result = await dispatchWaterfall(
    ['retry'],
    'x',
    async (_listener, _value, next) => {
      const first = await next();
      return first === 'fail' ? await next() : first;
    },
    async () => {
      attempts++;
      return attempts === 1 ? 'fail' : 'ok';
    },
  );
  assert.equal(result, 'ok');
  assert.equal(attempts, 2);
});

/**
 * The threaded dispatch, which is what a tool wrapper's `next(replacement)` runs on.
 *
 * The difference from `dispatchWaterfall` is the whole reason both exist: there the threaded value is an
 * *identity* the chain audits and must not rewrite, here it is a *context* the chain runs under and must be able
 * to replace. A listener that observes passes its own state through with `next()`; one that changes something
 * hands the replacement to `next(replacement)` and every later listener and the terminal see it.
 */
test('a threaded listener hands a replacement to the rest of the chain, and a bare next() keeps its own', async () => {
  const seen: string[] = [];
  const result = await dispatchThreaded(
    ['bound', 'observe', 'after'],
    'start',
    async (listener, state, next) => {
      seen.push(`${listener}:${state}`);
      if (listener === 'bound') return next(`${state}+bounded`);
      return next();
    },
    async (state) => {
      seen.push(`terminal:${state}`);
      return state;
    },
  );
  assert.equal(result, 'start+bounded');
  // The observer after the replacement sees it and passes it on unchanged; the terminal sees it too.
  assert.deepEqual(seen, [
    'bound:start',
    'observe:start+bounded',
    'after:start+bounded',
    'terminal:start+bounded',
  ]);
});

test('a wrapper may replace the signal a tool body runs under, and the deadline still reaches it', async () => {
  const registry = new ToolRegistry();
  const observed: { aborted: boolean; reason?: unknown } = { aborted: false };
  registry.register({
    name: 'waits',
    description: 'Waits until something ends it',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    execute: async (_args, scope) => {
      await new Promise<void>((resolve) => {
        scope.signal.addEventListener(
          'abort',
          () => {
            observed.aborted = true;
            observed.reason = scope.signal.reason;
            resolve();
          },
          { once: true },
        );
      });
      return { isError: true, content: 'stopped' };
    },
  });
  // A wrapper installs a signal of its own — the shape a policy uses to narrow or re-resolve what a call runs
  // under — and hands it downstream. The registry's deadline must abort *that* signal, or the wrapper would be
  // holding a bound it cannot actually tighten.
  registry.registerHooks({
    aroundTool: async (dispatch, next) => {
      const controller = new AbortController();
      return await next(dispatch.withSignal(controller.signal, controller));
    },
  });
  registry.deadlines = { defaultMs: 40 };
  const started = Date.now();
  const result = await registry.execute(call('waits'), context());
  assert.ok(result.isError, 'the call ends as a failed result, not a hung run');
  assert.ok(Date.now() - started < 5_000, 'the deadline ended it rather than the test');
  assert.equal(observed.aborted, true, 'the body saw the signal the wrapper installed');
  assert.ok(
    observed.reason instanceof ToolTimeoutError,
    'and it was ended by the deadline, with the same error the model reads',
  );
});
