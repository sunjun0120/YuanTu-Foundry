/**
 * What happens when a tool call runs out of its budget.
 *
 * The gap this closes was not "runs can be long" — a run may legitimately take an hour — but that a single call
 * that never answered held the run open until a human cancelled it. Four promises are made here and each one has
 * a test, because each has a wrong version that looks right:
 *
 * 1. The call is *cut off* and the model is told, in a result it can act on — not the run.
 * 2. The tool is *told to stop* (its own signal aborts), so a child process is killed and a socket is closed
 *    rather than abandoned; the run's own signal is untouched, or a deadline would be a cancellation.
 * 3. A cancellation is never reported as a timeout: those are two different things and only one of them is the
 *    user's decision.
 * 4. A pending deadline never keeps a process alive, so an abandoned call costs a failed result and nothing else.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Agent } from '../packages/core/agent.ts';
import { SessionStore } from '../packages/storage/sqlite.ts';
import { ToolRegistry } from '../packages/tools/registry.ts';
import {
  TOOL_DEADLINE_DEFAULTS,
  TOOL_TIMEOUT_MARKER,
  ToolTimeoutError,
  resolveToolDeadline,
  toolDeadlinePolicy,
} from '../packages/tools/timeouts.ts';
import type { Tool, ToolCall, ToolContext, ToolResult } from '../packages/protocol/index.ts';
import { replayProvider } from './replay.ts';
import { projectRoot } from './process-fixture.ts';

const approve = async () => true;
const call = (name: string): ToolCall => ({ id: `call-${name}`, name, arguments: {} });

/** A tool whose body is supplied by the case, so "hangs", "hangs until told" and "slow but fine" are data. */
function tool(name: string, execute: Tool['execute']): Tool {
  return {
    name,
    description: 'test tool',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    execute,
  };
}

/** Waits for the call's signal, then rejects with the reason it was given — what a cooperative tool does. */
function cooperative(name: string, seen: { reason?: unknown; aborted?: boolean }): Tool {
  return tool(name, (_, context: ToolContext) => {
    return new Promise<ToolResult>((_, reject) => {
      const stop = () => {
        seen.aborted = true;
        seen.reason = context.signal.reason;
        reject(context.signal.reason);
      };
      if (context.signal.aborted) stop();
      else context.signal.addEventListener('abort', stop, { once: true });
    });
  });
}

test('a tool that never answers is cut off, and the model is told what happened', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-tool-timeout-'));
  const store = new SessionStore(path.join(root, 'sessions.sqlite'));
  t.after(async () => {
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  const tools = new ToolRegistry();
  tools.register(tool('hang', () => new Promise<ToolResult>(() => {})));
  tools.deadlines = { defaultMs: 80 };
  const provider = replayProvider([{ toolCalls: [call('hang')] }, { text: 'gave up on it' }]);
  const agent = new Agent({ store, tools, approve, provider });
  const session = store.create(root);
  const result = await agent.run({ sessionId: session.id, prompt: 'Try the hanging tool' });

  // The run is not the thing that ran out of budget: it continues and answers.
  assert.equal(result.status, 'completed');
  assert.equal(result.text, 'gave up on it');
  const transcript = store.messages(session.id);
  const reported = transcript.find((message) => message.role === 'tool');
  assert.ok(reported, 'the failed call is in the transcript');
  assert.equal(reported.isError, true);
  assert.match(reported.content, new RegExp(`^${TOOL_TIMEOUT_MARKER}:`));
  assert.match(reported.content, /"hang"/);
  assert.match(reported.content, /80ms/);
  // The model saw it as a tool result — that is what makes the deadline recoverable rather than fatal.
  const followUp = provider.requests[1];
  assert.ok(followUp, 'the run made a second request');
  const seen = followUp.messages.filter((message) => message.role === 'tool');
  assert.equal(seen.length, 1);
  assert.match(seen[0]!.content, new RegExp(TOOL_TIMEOUT_MARKER));
  provider.assertConsumed();
});

test('the call is told to stop, through a signal of its own', async () => {
  const seen: { reason?: unknown; aborted?: boolean } = {};
  const tools = new ToolRegistry();
  tools.register(cooperative('cooperative', seen));
  tools.deadlines = { defaultMs: 60 };
  const run = new AbortController();
  const result = await tools.execute(call('cooperative'), { signal: run.signal, approve });

  assert.equal(result.isError, true);
  assert.match(result.content, new RegExp(`^${TOOL_TIMEOUT_MARKER}:`));
  // The tool was aborted, and with the very error the model is reading: what the tool was told and what the
  // report says cannot end up disagreeing.
  assert.equal(seen.aborted, true);
  assert.ok(seen.reason instanceof ToolTimeoutError);
  assert.equal(seen.reason.tool, 'cooperative');
  assert.equal(seen.reason.timeoutMs, 60);
  assert.equal(seen.reason.message, result.content);
  // A deadline ends one call; it must not end the run.
  assert.equal(run.signal.aborted, false);
});

test('a call that finishes inside its budget is left alone', async () => {
  const tools = new ToolRegistry();
  tools.register(tool('quick', async () => ({ isError: false, content: 'ok' })));
  tools.deadlines = { defaultMs: 5_000 };
  const result = await tools.execute(call('quick'), {
    signal: new AbortController().signal,
    approve,
  });
  assert.deepEqual(result, { isError: false, content: 'ok' });
});

test('a per-tool exemption turns the deadline off for that tool alone', async () => {
  const tools = new ToolRegistry();
  tools.register(
    tool(
      'slow_but_expected',
      () =>
        new Promise<ToolResult>((resolve) =>
          setTimeout(() => resolve({ isError: false, content: 'late' }), 120),
        ),
    ),
  );
  // A budget that the tool cannot meet, plus the exemption that is supposed to make that irrelevant.
  tools.deadlines = { defaultMs: 40, overrides: { slow_but_expected: 0 } };
  const result = await tools.execute(call('slow_but_expected'), {
    signal: new AbortController().signal,
    approve,
  });
  assert.deepEqual(result, { isError: false, content: 'late' });
});

test('an aroundTool wrapper sees the timeout and a retry gets a fresh budget', async () => {
  let bodies = 0;
  const signals: AbortSignal[] = [];
  const tools = new ToolRegistry();
  tools.register(
    tool('flaky', (_args, ctx) => {
      signals.push(ctx.signal);
      bodies += 1;
      if (bodies === 1) return new Promise<ToolResult>(() => {});
      // Longer than a third of the budget and shorter than all of it: it only passes if the second attempt
      // starts its own clock rather than inheriting what is left of the first one's.
      return new Promise<ToolResult>((resolve) =>
        setTimeout(() => resolve({ isError: false, content: 'second try' }), 40),
      );
    }),
  );
  tools.deadlines = { defaultMs: 60 };
  const caught: unknown[] = [];
  tools.registerExtension([], {
    aroundTool: async (dispatch, next) => {
      try {
        return await next();
      } catch (error) {
        caught.push(error);
        assert.equal(dispatch.execution.tool, 'flaky');
        if (error instanceof ToolTimeoutError) return await next();
        throw error;
      }
    },
  });
  const result = await tools.execute(call('flaky'), {
    signal: new AbortController().signal,
    approve,
  });
  assert.deepEqual(result, { isError: false, content: 'second try' });
  assert.equal(caught.length, 1);
  assert.ok(caught[0] instanceof ToolTimeoutError);
  assert.equal(bodies, 2);
  assert.equal(signals[0]!.aborted, true);
  assert.equal(signals[1]!.aborted, false);
  assert.notEqual(signals[0], signals[1]);
});

test('run cancellation still aborts the fresh signal of a timed-out tool retry', async () => {
  const tools = new ToolRegistry();
  const run = new AbortController();
  let attempts = 0;
  let retrySignal: AbortSignal | undefined;
  let started!: () => void;
  const retryStarted = new Promise<void>((resolve) => {
    started = resolve;
  });
  const fallback = setTimeout(() => run.abort(new Error('probe timeout')), 2000);
  tools.deadlines = { defaultMs: 20 };
  tools.register(
    tool('cancel_retry', (_args, ctx) => {
      if (++attempts === 1) return new Promise<ToolResult>(() => {});
      retrySignal = ctx.signal;
      started();
      return new Promise<ToolResult>((_resolve, reject) =>
        ctx.signal.addEventListener('abort', () => reject(ctx.signal.reason), { once: true }),
      );
    }),
  );
  tools.registerExtension([], {
    aroundTool: async (_dispatch, next) => {
      try {
        return await next();
      } catch (error) {
        if (error instanceof ToolTimeoutError) return next();
        throw error;
      }
    },
  });
  try {
    const result = tools.execute(call('cancel_retry'), { signal: run.signal, approve });
    void result.catch(() => {});
    await retryStarted;
    assert.equal(retrySignal?.aborted, false);
    run.abort(new Error('cancel retry'));
    await assert.rejects(result, /cancel retry/);
    assert.equal(retrySignal?.aborted, true);
  } finally {
    clearTimeout(fallback);
    await tools.close();
  }
});

test('cancelling the run is a cancellation, not a timeout', async () => {
  const seen: { reason?: unknown; aborted?: boolean } = {};
  const tools = new ToolRegistry();
  tools.register(cooperative('slow', seen));
  // Long enough that the deadline cannot be what ends this call: the test is about which mechanism wins.
  tools.deadlines = { defaultMs: 30_000 };
  const run = new AbortController();
  const cancelled = new Error('the user stopped the run');
  const pending = tools.execute(call('slow'), { signal: run.signal, approve });
  setTimeout(() => run.abort(cancelled), 30);
  await assert.rejects(pending, (error: unknown) => {
    assert.equal(error, cancelled);
    return true;
  });
  assert.equal(seen.aborted, true);
  assert.equal(seen.reason, cancelled);
});

test('a pending deadline does not keep the process alive', async () => {
  // The worker leaves a call hanging under a one-hour budget and never exits on its own. If the deadline timer
  // were ref'd, the process would sit there for the rest of the hour; the test would have to kill it, which is
  // exactly the bug this pins.
  const child = spawn(process.execPath, [path.join(projectRoot, 'tests/tool-timeout-worker.ts')], {
    cwd: projectRoot,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  const timer = setTimeout(() => child.kill(), 10_000);
  const code = await new Promise<number | null>((resolve) => child.on('close', resolve));
  clearTimeout(timer);
  assert.equal(code, 0, `worker exited ${code}: ${stderr}`);
  assert.match(stdout, /hanging call launched/);
});

test('the policy travels to a delegated run, which runs the same tools', async () => {
  const tools = new ToolRegistry();
  tools.register(cooperative('delegated', {}));
  tools.deadlines = { defaultMs: 40 };
  // The child registry is a copy of the parent's tool table; a copy that dropped the policy would leave a
  // delegated run — running the very same tools — unbounded while the parent's calls were bounded.
  const child = tools.forRun({ allow: ['delegated'] });
  const result = await child.execute(call('delegated'), {
    signal: new AbortController().signal,
    approve,
  });
  assert.equal(result.isError, true);
  assert.match(result.content, new RegExp(`^${TOOL_TIMEOUT_MARKER}:`));
});

test('the policy is resolved per tool, and the environment overrides the default', () => {
  assert.equal(resolveToolDeadline('anything', undefined), undefined);
  assert.equal(resolveToolDeadline('anything', { defaultMs: 0 }), undefined);
  assert.equal(resolveToolDeadline('anything', { defaultMs: 5 }), 5);
  assert.equal(
    resolveToolDeadline('exempt', { defaultMs: 5, overrides: { exempt: 0 } }),
    undefined,
  );
  assert.equal(resolveToolDeadline('bounded', { defaultMs: 5, overrides: { bounded: 900 } }), 900);

  const shipped = toolDeadlinePolicy({});
  assert.equal(shipped.defaultMs, TOOL_DEADLINE_DEFAULTS.defaultMs);
  assert.equal(toolDeadlinePolicy({ YUANTU_TOOL_TIMEOUT_MS: '120000' }).defaultMs, 120_000);
  assert.equal(toolDeadlinePolicy({ YUANTU_TOOL_TIMEOUT_MS: '0' }).defaultMs, 0);
  assert.throws(
    () => toolDeadlinePolicy({ YUANTU_TOOL_TIMEOUT_MS: 'soon' }),
    /YUANTU_TOOL_TIMEOUT_MS/,
  );

  // The two exemptions are decisions, not accidents: waiting for a person is not a hung tool, and the command
  // tool owns a budget of its own.
  const overrides = TOOL_DEADLINE_DEFAULTS.overrides;
  assert.equal(resolveToolDeadline('ask_user_question', TOOL_DEADLINE_DEFAULTS), undefined);
  assert.equal(overrides['run_command'], 330_000);
  assert.equal(resolveToolDeadline('run_command', TOOL_DEADLINE_DEFAULTS), 330_000);

  // The delegation tools are the third kind of exemption: their duration is set by other agents' work, so no
  // budget is both generous enough for a real fan-out and short enough to catch a hang. They carry bounds of
  // their own (per-run admission, the concurrency semaphore, and each child's round and window limits), which
  // is the condition for naming a tool here.
  assert.equal(resolveToolDeadline('delegate_task', TOOL_DEADLINE_DEFAULTS), undefined);
  assert.equal(resolveToolDeadline('workflow', TOOL_DEADLINE_DEFAULTS), undefined);
  // The read side keeps the default: `collect_subagents` is documented as a bounded wait, and it caps its own
  // `waitMs` below this budget, so the shared default never fires on it in practice.
  assert.equal(
    resolveToolDeadline('collect_subagents', TOOL_DEADLINE_DEFAULTS),
    TOOL_DEADLINE_DEFAULTS.defaultMs,
  );
});
