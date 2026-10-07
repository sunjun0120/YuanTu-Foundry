import {
  ListenerSet,
  dispatchEmit,
  dispatchFirst,
  dispatchSerial,
  dispatchThreaded,
  type Disposer,
} from './dispatch.ts';
import { EXTENSION_HOOK_NAMES } from '../protocol/tool-hooks.ts';
import type {
  SessionHookContext,
  SessionEndContext,
  PromptSubmitContext,
  PromptSubmitResult,
  StopContext,
  ToolGuard,
  ToolWrapper,
  ToolDispatch,
  PreStepContext,
  PreStepResult,
  ExtensionHooks,
  BeforeToolOutcome,
  PostExecuteOutcome,
} from '../protocol/tool-hooks.ts';
import type { GuardDecision, PostToolDecision, ToolExecution } from '../protocol/tool-pipeline.ts';
import type { ToolCall, ToolResult, ReasoningEffort } from '../protocol/index.ts';
export { EXTENSION_HOOK_NAMES } from '../protocol/tool-hooks.ts';
export type {
  SessionHookContext,
  SessionEndContext,
  PromptSubmitContext,
  PromptSubmitResult,
  StopContext,
  StopResult,
  ToolGuard,
  ToolWrapper,
  ToolDispatch,
  PreStepContext,
  PreStepResult,
  ExtensionHooks,
  BeforeToolOutcome,
  PostExecuteOutcome,
} from '../protocol/tool-hooks.ts';
const HOOK_NAMES = new Set<string>(EXTENSION_HOOK_NAMES);
/** Tool hooks run inside the tool path and stay tightly bounded. */
const TOOL_HOOK_TIMEOUT_MS = 5000;
/** The round preamble runs once per model round, so it gets the tool budget rather than the lifecycle one. */
const PRE_STEP_HOOK_TIMEOUT_MS = 5000;
/** Lifecycle hooks run outside a tool call, so they may legitimately need longer than a tool hook. */
const LIFECYCLE_HOOK_TIMEOUT_MS = 15_000;
/**
 * `close` must outlast a slow but successful cleanup. It previously shared the 5s tool-hook budget,
 * so an extension that took 6 seconds to shut down successfully was aborted, its rejection was read
 * as "Tool resource cleanup failed", and an otherwise complete run was recorded as failed.
 */
const CLOSE_HOOK_TIMEOUT_MS = 30_000;
const MAX_HOOK_REGISTRATIONS = 32;
/** A registration always returns the way to undo it. */
const noop: Disposer = () => undefined;
function hookError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
async function invokeHook<T>(
  run: (signal: AbortSignal) => T | Promise<T>,
  parent: AbortSignal,
  timeoutMs: number = TOOL_HOOK_TIMEOUT_MS,
): Promise<T> {
  const controller = new AbortController();
  const abort = () => controller.abort(parent.reason);
  parent.addEventListener('abort', abort, { once: true });
  if (parent.aborted) abort();
  const timer = setTimeout(
    () => controller.abort(new Error('Extension hook timed out; waiting for cooperative shutdown')),
    timeoutMs,
  );
  try {
    controller.signal.throwIfAborted();
    const result = await run(controller.signal);
    controller.signal.throwIfAborted();
    return result;
  } finally {
    clearTimeout(timer);
    parent.removeEventListener('abort', abort);
  }
}
/**
 * Holds extension hook sets and invokes them at every lifecycle point.
 *
 * A host keeps one instance for its whole lifetime and shares it with the per-run tool registries it
 * creates. Session hooks must outlive a run — `createAgent` builds a fresh tool registry per run — so
 * storing hooks only inside a `ToolRegistry` made session-level hooks impossible by construction.
 *
 * Everything here is registered as a *reversible effect*: `register`, `registerGuard` and `add` return
 * the disposer that takes the contribution back out. That is what lets an embedder add a policy for one
 * run, or a test add one for one case, without rebuilding the host.
 */
export class HookRegistry {
  private hooks = new ListenerSet<ExtensionHooks>();
  private guards = new ListenerSet<ToolGuard>();
  /** Contributions installed through `installOnce`, and the keys that stop them being installed twice. */
  private installed = new Set<string>();
  private disposers: Disposer[] = [];
  get size(): number {
    return this.hooks.size;
  }
  /**
   * Installs a contribution at most once per registry.
   *
   * A host keeps one hook registry for its whole lifetime while `createTools` builds a fresh tool registry
   * for every run *and* every resident child, so anything a tool registry installs into a shared hook
   * registry would otherwise be installed once more per run. The key says which contribution this is; the
   * registry remembers it so the caller does not have to thread "have I done this yet" through its own
   * state. The disposers are released by `close()`.
   */
  installOnce(key: string, install: () => Disposer[]): void {
    if (this.installed.has(key)) return;
    this.installed.add(key);
    this.disposers.push(...install());
  }
  /** Validates without registering, so a rejected extension cannot leave partial state behind. */
  validate(hooks: ExtensionHooks): ExtensionHooks {
    if (
      !hooks ||
      typeof hooks !== 'object' ||
      Array.isArray(hooks) ||
      this.hooks.size >= MAX_HOOK_REGISTRATIONS ||
      Object.entries(hooks).some(
        ([key, value]) => !HOOK_NAMES.has(key) || typeof value !== 'function',
      )
    )
      throw new Error('Invalid extension hooks or hook limit exceeded');
    return { ...hooks };
  }
  add(snapshot: ExtensionHooks): Disposer {
    return this.hooks.use(snapshot);
  }
  register(hooks?: ExtensionHooks): Disposer {
    return hooks ? this.add(this.validate(hooks)) : noop;
  }
  registerGuard(guard: ToolGuard): Disposer {
    return this.guards.use(guard);
  }
  /**
   * The method a hook declares, in registration order: `undefined` skips that hook entirely, so a
   * seam costs nothing when nothing listens to it.
   */
  private withMethod<Key extends keyof ExtensionHooks>(
    key: Key,
  ): readonly NonNullable<ExtensionHooks[Key]>[] {
    const found: NonNullable<ExtensionHooks[Key]>[] = [];
    for (const hook of this.hooks.all) {
      const method = hook[key];
      if (typeof method === 'function') found.push(method as NonNullable<ExtensionHooks[Key]>);
    }
    return found;
  }
  /**
   * The round preamble: a serial dispatch that stops at the first refusal.
   *
   * A block wins over later injections because the round they would have joined is not going to
   * happen; injections accumulate in registration order. A hook that throws refuses the run — a policy
   * that could not run must not read as consent, the same rule guards follow.
   */
  async preStep(
    context: PreStepContext,
    parent: AbortSignal,
  ): Promise<{
    blocked?: string;
    inject: string[];
    model: string;
    reasoningEffort?: ReasoningEffort;
  }> {
    const inject: string[] = [];
    // The two aimed fields are carried *through* the dispatch rather than collected after it: each hook sees
    // what the hooks before it chose, which is what makes this a waterfall instead of a last-writer-wins vote.
    let model = context.model;
    let reasoningEffort = context.reasoningEffort;
    for (const hook of this.withMethod('preStep')) {
      let result: PreStepResult;
      try {
        result = await invokeHook(
          (signal) => hook(structuredClone({ ...context, model, reasoningEffort }), signal),
          parent,
          PRE_STEP_HOOK_TIMEOUT_MS,
        );
      } catch (error) {
        if (parent.aborted) throw error;
        throw new Error(`Extension pre-step hook failed: ${hookError(error)}`);
      }
      if (!result) continue;
      if (Array.isArray(result.inject))
        for (const note of result.inject) if (note.trim()) inject.push(note);
      if (typeof result.model === 'string' && result.model.trim()) model = result.model;
      if (result.reasoningEffort !== undefined) reasoningEffort = result.reasoningEffort;
      if (typeof result.block === 'string' && result.block)
        return { blocked: result.block, inject, model, reasoningEffort };
    }
    return { inject, model, reasoningEffort };
  }
  /**
   * Runs the pre-execute gate. It is a *serial* gate rather than a waterfall: every hook sees every
   * call until one refuses. Interception (hiding a call from later policy) is deliberately not
   * available here — a policy that cannot see a call cannot audit it — and `aroundTool` covers the
   * legitimate wrapping case.
   */
  async beforeTool(call: ToolCall, parent: AbortSignal): Promise<BeforeToolOutcome> {
    const outcome = await dispatchFirst(this.withMethod('beforeTool'), async (hook) => {
      let allowed: boolean | void;
      try {
        allowed = await invokeHook((signal) => hook(structuredClone(call), signal), parent);
      } catch {
        return 'failed' as const;
      }
      return allowed === false ? ('deny' as const) : undefined;
    });
    return outcome ?? 'allow';
  }
  /**
   * Runs the host-level guards, plus any guard owned by the calling registry. The first denial wins.
   * A guard that throws denies as well: "I could not decide" must not read as "allowed".
   */
  async runGuards(
    execution: ToolExecution,
    own: readonly ToolGuard[],
    parent: AbortSignal,
  ): Promise<string | undefined> {
    // Host guards first, then guards declared inline by a registered hook set, then this registry's own.
    // The inline ones have to be listed here or `validate` would accept a `guard` key that nothing ever
    // calls: a declared policy that silently does nothing is worse than one that is rejected.
    return dispatchFirst(
      [...this.guards.all, ...this.withMethod('guard'), ...own],
      async (guard) => {
        let decision: GuardDecision;
        try {
          decision = await invokeHook((signal) => guard(execution, signal), parent);
        } catch (error) {
          // Cancellation is not a denial: a cancelled run must end as cancelled, not as a refused call.
          if (parent.aborted) throw error;
          return `Operation denied: guard failed (${hookError(error)})`;
        }
        return decision?.deny ? `Operation denied by guard: ${decision.deny}` : undefined;
      },
    );
  }
  /**
   * Wraps the dispatch in every `aroundTool` wrapper, outermost first.
   *
   * A wrapper that returns without calling `next()` is refused: it would report a result for an effect
   * that never happened, which is exactly the kind of lie the rest of this pipeline exists to prevent.
   * Cancellation and timeouts pass through the wrapper, so a hung tool still ends as a cancelled run.
   *
   * The chain threads a {@link ToolDispatch}, so a wrapper may hand the rest of it a **replacement** context with
   * `next(replacement)` — see {@link ToolWrapper} for why that is what makes wrapper policies composable. The
   * `execution` inside it is the same frozen object all the way down: a wrapper may change what the body runs
   * under, never what the record says was requested.
   */
  async aroundTool(
    dispatch: ToolDispatch,
    terminal: (dispatch: ToolDispatch) => Promise<ToolResult>,
    wrapperSignal: AbortSignal,
  ): Promise<ToolResult> {
    return dispatchThreaded(
      this.withMethod('aroundTool'),
      dispatch,
      async (wrapper, current, next) => {
        let delegated = false;
        /**
         * The wrapper's own hook budget lives on `wrapperSignal` and is *not* passed to the wrapper, because a
         * wrapper's job is to decide what the **body** runs under: handing it a second signal it might mistake for
         * the call's would give it a way to think it had bounded the call while the body kept running under the
         * original. It replaces the dispatch instead, and that replacement is what the deadline and the body see.
         */
        const result = await invokeHook(
          () =>
            wrapper(current, (replacement) => {
              delegated = true;
              return next(replacement);
            }),
          wrapperSignal,
        );
        if (!delegated)
          throw new Error(
            'around-tool hook returned without delegating; a wrapper must call next()',
          );
        return result;
      },
      (current) => terminal(current),
    );
  }
  /**
   * Runs post-execute policy, then the legacy observers.
   *
   * Order matters and is deliberate: policy decides, observers observe. `block` wins over everything
   * (a later replacement cannot un-block a result), replacements chain with the last one winning,
   * `add-context` accumulates, and a replacement of a *failed* result is refused loudly rather than
   * quietly turning a failure into a success.
   */
  async postExecute(
    execution: ToolExecution,
    result: ToolResult,
    parent: AbortSignal,
  ): Promise<PostExecuteOutcome> {
    let current: ToolResult = { ...result };
    const additionalContext: string[] = [];
    let observerFailed = false;
    for (const hook of this.hooks.all) {
      if (!hook.postExecute) continue;
      let decision: PostToolDecision | void;
      try {
        decision = await invokeHook(
          (signal) => hook.postExecute!(execution, structuredClone(current), signal),
          parent,
        );
      } catch {
        observerFailed = true;
        continue;
      }
      if (!decision || decision.action === 'accept') continue;
      if (decision.action === 'block') {
        current = {
          isError: true,
          content: `Tool result blocked by extension policy${
            decision.reason ? `: ${decision.reason}` : ''
          }`,
        };
        break;
      }
      if (decision.action === 'add-context') {
        if (decision.context.trim()) additionalContext.push(decision.context);
        continue;
      }
      if (decision.action === 'replace') {
        if (current.isError)
          throw new TypeError('post-execute cannot replace the result of a failed tool call');
        current = { ...decision.result };
        continue;
      }
      current = { ...current, content: decision.content };
    }
    for (const hook of this.hooks.all) {
      if (!hook.afterTool) continue;
      try {
        await invokeHook(
          (signal) =>
            hook.afterTool!(structuredClone(execution.call), structuredClone(current), signal),
          parent,
        );
      } catch {
        observerFailed = true;
      }
    }
    return { result: current, additionalContext, observerFailed };
  }
  /**
   * The final content-only stage. Failures are reported like observer failures: the effect happened and
   * post-processing is cosmetic, so it must not turn a completed call into a failed one.
   *
   * A serial dispatch: each hook sees the content the previous one produced, and a hook that returns
   * nothing keeps the current content.
   */
  async finalizeContent(
    execution: ToolExecution,
    result: ToolResult,
    parent: AbortSignal,
  ): Promise<{ content?: string; observerFailed: boolean }> {
    let observerFailed = false;
    const hooks = this.withMethod('finalizeContent');
    const content = await dispatchSerial(
      hooks,
      undefined as string | undefined,
      async (hook, current) => {
        try {
          const next = await invokeHook(
            (signal) =>
              hook(
                execution,
                { ...result, ...(current === undefined ? {} : { content: current }) },
                signal,
              ),
            parent,
          );
          return typeof next === 'string' ? next : undefined;
        } catch {
          observerFailed = true;
          return undefined;
        }
      },
    );
    return { ...(content === undefined ? {} : { content }), observerFailed };
  }
  /**
   * Runs every session-start hook. Failures are returned rather than thrown: a session hook is a
   * notification, and refusing to open a session because a hook misbehaved would be worse.
   */
  async sessionStart(context: SessionHookContext, parent: AbortSignal): Promise<string[]> {
    return dispatchEmit(this.withMethod('sessionStart'), async (hook) => {
      try {
        await invokeHook(
          (signal) => hook(structuredClone(context), signal),
          parent,
          LIFECYCLE_HOOK_TIMEOUT_MS,
        );
        return undefined;
      } catch (error) {
        return hookError(error);
      }
    });
  }
  async sessionEnd(context: SessionEndContext, parent: AbortSignal): Promise<string[]> {
    return dispatchEmit(this.withMethod('sessionEnd'), async (hook) => {
      try {
        await invokeHook(
          (signal) => hook(structuredClone(context), signal),
          parent,
          LIFECYCLE_HOOK_TIMEOUT_MS,
        );
        return undefined;
      } catch (error) {
        return hookError(error);
      }
    });
  }
  /**
   * Prompt hooks chain: each one sees the prompt as rewritten by the previous hook. The first hook to
   * return a non-empty `block` stops the chain and the run is refused with that reason.
   */
  async promptSubmit(
    context: PromptSubmitContext,
    parent: AbortSignal,
  ): Promise<{ prompt: string; block?: string; failures: string[] }> {
    let prompt = context.prompt;
    const failures: string[] = [];
    for (const hook of this.hooks.all) {
      if (!hook.promptSubmit) continue;
      let result: PromptSubmitResult;
      try {
        result = await invokeHook(
          (signal) => hook.promptSubmit!({ ...context, prompt }, signal),
          parent,
          LIFECYCLE_HOOK_TIMEOUT_MS,
        );
      } catch (error) {
        failures.push(hookError(error));
        continue;
      }
      if (!result) continue;
      if (typeof result.prompt === 'string' && result.prompt !== prompt) prompt = result.prompt;
      if (typeof result.block === 'string' && result.block)
        return { prompt, block: result.block, failures };
    }
    return { prompt, failures };
  }
  /** Collects stop reasons and hook failures. Neither can fail the run that already completed. */
  async stop(
    context: StopContext,
    parent: AbortSignal,
  ): Promise<{ reasons: string[]; failures: string[] }> {
    const reasons: string[] = [];
    const failures: string[] = [];
    for (const hook of this.hooks.all) {
      if (!hook.stop) continue;
      try {
        const result = await invokeHook(
          (signal) => hook.stop!(structuredClone(context), signal),
          parent,
          LIFECYCLE_HOOK_TIMEOUT_MS,
        );
        if (result && typeof result.block === 'string' && result.block) reasons.push(result.block);
      } catch (error) {
        failures.push(hookError(error));
      }
    }
    return { reasons, failures };
  }
  /** Returns the failure messages from every close hook. */
  async close(): Promise<string[]> {
    // Installed contributions go first: they are this registry's own state, not somebody else's hook.
    for (const dispose of this.disposers.splice(0)) {
      try {
        dispose();
      } catch {
        // A disposer that fails changes nothing: the process is closing and the hooks are gone either way.
      }
    }
    this.installed.clear();
    return dispatchEmit(this.withMethod('close'), async (hook) => {
      try {
        await invokeHook(() => hook(), new AbortController().signal, CLOSE_HOOK_TIMEOUT_MS);
        return undefined;
      } catch (error) {
        return hookError(error);
      }
    });
  }
}
