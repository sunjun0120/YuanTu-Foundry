import { Ajv } from 'ajv';
import { isDeepStrictEqual } from 'node:util';
import {
  describeExecutionBoundary,
  executionPolicy,
  snapshotExecutionPolicy,
  withExecutionPolicy,
} from './execution-policy.ts';
import { resolveSandboxConfig, sandboxProvider, type SandboxMode } from './sandbox-provider.ts';
import type { ValidateFunction } from 'ajv';
import { DeferredApprovalError } from '../protocol/failure.ts';
import { JobRegistry } from '../protocol/jobs.ts';
import type { PermissionPolicyView } from '../protocol/permissions.ts';
import type { Tool, ToolCall, ToolContext, ToolResult, ToolSpec } from '../protocol/index.ts';
import type { Disposer } from './dispatch.ts';
import { ToolPipelineInvariant } from './pipeline.ts';
import { ToolTimeoutError, type ToolDeadlinePolicy } from './timeouts.ts';
import { approveWithinBudget, createDispatch, runWithDeadline } from './call-runtime.ts';
import {
  errorResult,
  finalResult,
  invalidArgumentsMessage,
  normalizeImages,
} from './call-result.ts';
import { FOLDED_DESCRIPTION, RUN_CODE, toolSdk, type ToolMode } from './run-code-sdk.ts';
import { LOAD_TOOLS, deferredCatalog } from './deferred-tools.ts';
import { presentedSchema } from './presented-schema.ts';
import type {
  PipelineStage,
  PostToolDecision,
  ToolExecution,
  ToolExecutionResult,
} from './pipeline.ts';

import { HookRegistry } from './hooks.ts';
import type { ExtensionHooks, ToolGuard } from '../protocol/tool-hooks.ts';
import { RUN_SCOPED_TOOLS, noop } from './tool-output.ts';
export {
  MAX_TOOL_OUTPUT,
  RUN_SCOPED_TOOLS,
  TRUNCATION_MARKER,
  bounded,
  failure,
} from './tool-output.ts';
export { HookRegistry } from './hooks.ts';
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
export class ToolRegistry {
  /**
   * The jobs this registry's session owns.
   *
   * It belongs to the registry rather than to a run because the registry is what knows the session scope: a
   * child's `job_*` tools have to answer for the child's own jobs, and the parent's registry would answer for
   * the parent's. Producers are registered by whoever owns them — the command manager here, the kernel for
   * sub-agents.
   */
  readonly jobs: JobRegistry;
  private entries = new Map<string, { tool: Tool; validate: ValidateFunction }>();
  /**
   * Hook sets normally live in a host-owned `HookRegistry` shared with every per-run registry, which
   * is what lets session hooks outlive a single run. A standalone registry gets its own so existing
   * embedders keep working unchanged.
   */
  private hooks: HookRegistry;
  /**
   * True when this registry created its own hook set. A host shares one `HookRegistry` across every
   * per-run registry, and closing it from each run would tear the host's hooks down after the first
   * run — so a shared hook set is closed exactly once, by its owner.
   */
  private ownsHooks: boolean;
  /**
   * Guards owned by this registry alone. Host-level guards live in the shared hook set and therefore
   * apply to delegated runs too (denial is monotonic, so inheriting one is safe); a guard installed on
   * a registry is scoped to it, so a child's guard never masks its parent or a sibling.
   */
  private guards: ToolGuard[] = [];
  /** Per-tool dispatch count, so a stage can tell a first attempt from a retry. */
  private attempts = new Map<string, number>();
  /**
   * The narrowing scopes currently in force, outermost first. A tool is offered only when **every** rule admits
   * it, which is what makes two independent policies compose: each one may only take away, so neither has to
   * know about the other and the order they were pushed in cannot change the result.
   *
   * Deliberately not copied by `forRun`: a delegated run's registry is a different registry with its own scopes,
   * and inheriting the parent's rules by reference would let the parent's later `restrict()` reach into a child
   * that already started.
   */
  private restrictions: ((current: { name: string; entry: object }) => boolean)[] = [];
  /**
   * How long one call may take, or `undefined` for "no deadline".
   *
   * A field rather than a constructor argument because a bare registry (a test, an embedder) has no policy until
   * someone gives it one, and the product installs the shipped policy where the tools are built —
   * `createTools`, next to the other environment-derived settings. See `./timeouts.ts` for what the default is
   * and why the two exemptions are exempt.
   */
  deadlines?: ToolDeadlinePolicy;
  workspaceRoot?: string;
  /**
   * How the catalog is presented to the model: every tool's schema, or `run_code` plus a generated declaration
   * list (`./run-code.ts`).
   *
   * A field for the same reason `deadlines` is, and one that travels with the tools through `forRun`: a
   * delegated run that silently lost the mode would send sixty schemas where its parent sent one.
   */
  toolMode: ToolMode = 'native';
  /**
   * The tools whose schema the `deferred` mode holds back until `load_tools` names them (`./deferred-tools.ts`).
   * Empty for a bare registry, so an embedder's own tool set is never deferred; travels through `forRun`.
   */
  deferrable: ReadonlySet<string> = new Set();
  /** The runtime stage-order invariant. Always on: it costs a few array operations per call. */
  readonly pipelineInvariant = new ToolPipelineInvariant();
  constructor(hooks?: HookRegistry, jobs?: JobRegistry) {
    this.ownsHooks = !hooks;
    this.hooks = hooks ?? new HookRegistry();
    this.jobs = jobs ?? new JobRegistry();
  }
  /** The hook sets this registry dispatches to, for callers that must invoke lifecycle hooks. */
  get extensions(): HookRegistry {
    return this.hooks;
  }
  registerExtension(tools: Tool[], hooks?: ExtensionHooks): Disposer {
    const names = new Set<string>();
    const prepared = tools.map((tool) => {
      if (this.entries.has(tool.name) || names.has(tool.name))
        throw new Error(`Duplicate tool: ${tool.name}`);
      names.add(tool.name);
      return this.compile(tool);
    });
    // Validate before touching either collection, so a rejected extension registers nothing at all.
    const snapshot = hooks ? this.hooks.validate(hooks) : undefined;
    for (const entry of prepared) this.entries.set(entry.tool.name, entry);
    const removeHooks = snapshot ? this.hooks.add(snapshot) : noop;
    return () => {
      for (const entry of prepared)
        if (this.entries.get(entry.tool.name) === entry) this.entries.delete(entry.tool.name);
      removeHooks();
    };
  }
  registerHooks(hooks: ExtensionHooks): Disposer {
    return this.registerExtension([], hooks);
  }
  /** Installs a guard for this registry only. See `guards` for how that differs from a host guard. */
  registerGuard(guard: ToolGuard): Disposer {
    this.guards.push(guard);
    return () => {
      const index = this.guards.indexOf(guard);
      if (index >= 0) this.guards.splice(index, 1);
    };
  }
  private cleanups: (() => Promise<void>)[] = [];
  onClose(cleanup: () => Promise<void>): Disposer {
    this.cleanups.push(cleanup);
    return () => {
      const index = this.cleanups.indexOf(cleanup);
      if (index >= 0) this.cleanups.splice(index, 1);
    };
  }
  async close(): Promise<void> {
    const results = await Promise.allSettled(this.cleanups.map((cleanup) => cleanup()));
    // A close hook reports its failures as messages instead of throwing, so surface them here too: a
    // cleanup that genuinely failed means an external process may still be running.
    const hookFailures = this.ownsHooks ? await this.hooks.close() : [];
    if (results.some((result) => result.status === 'rejected') || hookFailures.length)
      throw new Error('Tool resource cleanup failed');
  }
  private ajv = new Ajv({ allErrors: true, strict: true });
  /**
   * Compiles a tool into an entry, refusing a `isConcurrencySafe` that is not a function.
   *
   * The type says function, and a TypeScript extension cannot get it wrong — but a tool can also arrive from
   * JavaScript or from a module this project did not compile, and a classifier that is silently not a
   * function would *look* like a declaration while every call of it stayed serial. Failing at registration
   * names the tool once, at the point where it was installed, instead of leaving "why is this never
   * parallel?" to be discovered from a latency profile.
   */
  private compile(tool: Tool): { tool: Tool; validate: ValidateFunction } {
    if (tool.isConcurrencySafe !== undefined && typeof tool.isConcurrencySafe !== 'function')
      throw new Error(`Tool ${tool.name}: isConcurrencySafe must be a function when declared`);
    return { tool, validate: this.ajv.compile(tool.inputSchema) };
  }
  register(tool: Tool): Disposer {
    if (this.entries.has(tool.name)) throw new Error(`Duplicate tool: ${tool.name}`);
    const entry = this.compile(tool);
    this.entries.set(tool.name, entry);
    return () => {
      if (this.entries.get(tool.name) === entry) this.entries.delete(tool.name);
    };
  }
  /**
   * Install a per-run tool under a stable name. The agent registers `task_step` on every run, and
   * a registry can outlive a single run (embedded hosts and tests reuse one), so the current
   * closure must take over from the previous run's instead of colliding with it. The returned
   * disposer restores whatever this call displaced.
   */
  replace(tool: Tool): Disposer {
    const previous = this.entries.get(tool.name);
    const entry = this.compile(tool);
    this.entries.set(tool.name, entry);
    return () => {
      if (this.entries.get(tool.name) !== entry) return;
      if (previous) this.entries.set(tool.name, previous);
      else this.entries.delete(tool.name);
    };
  }
  /**
   * Uninstall a tool under a stable name, for a registry that outlives the run that installed it.
   *
   * `replace` installs a per-run tool; this is its asymmetry, and it exists for the same kind of host. A
   * resident sub-agent borrows one registry across every turn it runs, so a tool one turn installed — the report
   * tool a *delegation* has and a follow-up does not — must come back out when the next turn's contract differs,
   * or the model is offered a tool whose stated contract ("calling this completes the run") no longer holds.
   *
   * Returns whether anything was removed, so a caller that expects to find it can say so.
   */
  remove(name: string): boolean {
    return this.entries.delete(name);
  }
  /**
   * Narrow what this registry offers, and hand back the way to widen it again.
   *
   * The point of a restriction over `remove` is that it is **revocable and layered**. `remove` is for a host
   * whose tool set genuinely differs from one turn to the next; a restriction is for a *policy* — a phase, a
   * mode, a delegated run — that ends, and a policy that cannot be taken back is one a caller has to reach into
   * the registry to undo. Layering matters for the same reason: two policies that both narrow a set must compose
   * without either knowing about the other, so each call pushes a scope and the narrowest wins.
   *
   * `allow` and `deny` are both accepted and are normalized the same way — a deny list becomes the allow list of
   * everything else at the moment it is pushed — because the two are the same statement read in opposite
   * directions, and keeping two chains would be two rules that could disagree.
   *
   * **Names are not validated against the registry, deliberately.** A restriction says what a registry must
   * never offer, which has to stay meaningful for a name that is not registered *yet*: `delegate_task` is
   * installed per run by `replace`, so a restriction pushed before a run starts would fail to name it, and an
   * entry that is removed and re-registered would silently fall outside a restriction that had been built from
   * the registry's current contents. What is validated is that the restriction itself makes sense: at least one
   * of `allow`/`deny` must be given, and the two cannot both be.
   *
   * `entries` narrows a `deny` from "everything under this name" to "these particular tools", and it exists for
   * one caller and one situation. A delegated run's allowlist excludes *the parent's* tools, while `replace()` is
   * how that child installs its **own** under stable names (`submit_report`, `task_step`). Denying by name alone
   * would take away the tool the child is required to answer with, because the name is the same; denying the
   * entries that were present at the moment of narrowing says what the allowlist means. Anything installed
   * afterwards is the child's own and is offered normally.
   */
  restrict(scope: {
    allow?: readonly string[];
    deny?: readonly string[];
    entries?: readonly object[];
  }): Disposer {
    const hasAllow = scope.allow !== undefined;
    const hasDeny = scope.deny !== undefined;
    if (hasAllow === hasDeny) throw new Error('restrict() takes exactly one of `allow` or `deny`');
    const allowed = new Set(hasAllow ? scope.allow! : []);
    const denied = new Set(hasDeny ? scope.deny! : []);
    const bound = scope.entries === undefined ? undefined : new Set(scope.entries);
    const rule = (current: { name: string; entry: object }): boolean => {
      if (hasAllow) return allowed.has(current.name);
      if (!denied.has(current.name)) return true;
      // A name-only deny takes away whatever carries it; a bound deny takes away only the tools it named, so a
      // replacement installed under the same name is a different tool and is not caught by it.
      return bound !== undefined && !bound.has(current.entry);
    };
    this.restrictions.push(rule);
    return () => {
      const index = this.restrictions.indexOf(rule);
      if (index >= 0) this.restrictions.splice(index, 1);
    };
  }
  /**
   * Whether this registry currently offers `name`, as one answer for both halves of the question.
   *
   * Every caller that can see a tool and every caller that can call one reads this, which is what makes
   * "invisible" and "refuses to execute" the same fact rather than two rules that could drift. A name that is
   * registered but restricted is *hidden*, not unknown — the two are different answers and a caller that
   * conflated them would report a policy as a typo.
   */
  offers(name: string): boolean {
    const entry = this.entries.get(name);
    if (entry === undefined) return false;
    return this.restrictions.every((rule) => rule({ name, entry }));
  }
  /**
   * Whether this call may overlap its siblings from the same assistant message.
   *
   * Fail closed, in this order, and every "no" is a reason a reader can check:
   *
   * - an unknown tool, or a tool that declares a `permission`: a permission means an approval and an effect
   *   journal entry, and neither can be interleaved with a sibling's. It also means the human is asked one
   *   question at a time, in the order the model asked for them.
   * - arguments that fail the schema: the model gets one argument error, in the order it wrote the call.
   * - no classifier, a classifier that returns anything but `true`, or one that throws: the tool did not
   *   promise anything, so it runs alone.
   *
   * The classifier is the tool's own statement about *this* call, which is why it takes the arguments: a tool
   * may read safely for one path and not for another, and only the tool knows which is which.
   */
  /**
   * Whether this call may start before the model has finished its turn.
   *
   * Narrower than `executionMode`, on purpose: an early start overlaps whatever the model has not written yet, so
   * the call must be one that may overlap anything (`parallel`) *and* one whose discarded execution leaves no trace
   * (`Tool.earlyStart`). A name this run does not offer is never started early either — it would only be refused.
   */
  startsEarly(call: ToolCall): boolean {
    const entry = this.entries.get(call.name);
    return (
      entry?.tool.earlyStart === true &&
      this.offers(call.name) &&
      this.executionMode(call) === 'parallel'
    );
  }
  executionMode(call: ToolCall): 'parallel' | 'exclusive' {
    const entry = this.entries.get(call.name);
    if (!entry || entry.tool.permission) return 'exclusive';
    if (typeof entry.tool.isConcurrencySafe !== 'function') return 'exclusive';
    if (!entry.validate(call.arguments)) return 'exclusive';
    try {
      return entry.tool.isConcurrencySafe(call.arguments) === true ? 'parallel' : 'exclusive';
    } catch {
      return 'exclusive';
    }
  }
  /**
   * Tool specs as the provider sees them. `readOnly` omits every tool that declares a permission,
   * which is every workspace mutation (files, commands, network, memory, LSP rename/apply, Office
   * writes). Hiding is not the guarantee — `ToolRegistry.execute` still refuses the approval — but it
   * keeps a planning run from spending rounds on tools it can never use.
   *
   * `policy` trims the same way for the reason the model cannot see: a tool the effective permission policy
   * denies every call of is never sent either. A desktop session in read-only mode used to receive all 55
   * schemas and have 29 of them refused one by one; the schema it sends now matches what it will allow.
   */
  specs(
    options: {
      readOnly?: boolean;
      policy?: PermissionPolicyView;
      mode?: ToolMode;
      /**
       * The deferred tools this run's transcript has loaded (`loadedTools`). Only the `deferred` mode reads it,
       * and only a caller that passes it gets a deferred catalog: without it every tool is sent, which is the
       * answer a caller asking "what does this registry have" wants.
       */
      loaded?: ReadonlySet<string>;
    } = {},
  ): ToolSpec[] {
    const mode = options.mode ?? this.toolMode;
    const all = [...this.entries.values()]
      .filter(({ tool }) => this.offers(tool.name))
      .filter(({ tool }) => !options.readOnly || !tool.permission)
      .filter(({ tool }) => !options.policy?.deniesEveryCall(tool))
      // Plugin registration order must not change the serialized prompt after a restart.
      .sort((a, b) => (a.tool.name < b.tool.name ? -1 : a.tool.name > b.tool.name ? 1 : 0))
      .map(({ tool }) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: presentedSchema(tool.inputSchema),
      }));
    /**
     * Deferral, like folding, is a presentation of the same set: a held-back tool is still offered and
     * executable, and the `load_tools` description names it. `load_tools` itself only appears under this mode —
     * and, once every deferrable tool is loaded, not even then, since it would have nothing left to load.
     */
    const loaded = options.loaded;
    const hidden =
      mode === 'deferred' && loaded
        ? all.filter((spec) => this.deferrable.has(spec.name) && !loaded.has(spec.name))
        : [];
    const visible = all
      .filter((spec) => !hidden.includes(spec))
      .flatMap((spec) => {
        if (spec.name !== LOAD_TOOLS) return [spec];
        if (mode !== 'deferred' || (loaded && !hidden.length)) return [];
        return hidden.length
          ? // Loading one schema changes the declarations; it need not also rewrite the loader's description.
            [
              {
                ...spec,
                description: `${spec.description}\n${deferredCatalog(all.filter((tool) => this.deferrable.has(tool.name)))}`,
              },
            ]
          : [spec];
      });
    /**
     * Folding is a *presentation* of the same set, never a change to it: the declaration list names the tools the
     * model would otherwise have been sent one schema at a time, and each of them stays callable through
     * `run_code` with exactly the permissions and approval it always had.
     *
     * A registry with no `run_code` — an embedder's own tool set — is left unfolded rather than left with
     * nothing, because a mode that silently removed every capability would be the worst possible reading of a
     * schema-cost setting. `mode: 'native'` is how the run asks for the set the model may actually call, which is
     * what a program's catalog is built from.
     */
    if (mode !== 'ptc' || !visible.some((spec) => spec.name === RUN_CODE)) return visible;
    return visible
      .filter((spec) => spec.name === RUN_CODE)
      .map((spec) => ({
        ...spec,
        description: `${FOLDED_DESCRIPTION}\n${toolSdk(visible)}`,
      }));
  }
  /**
   * A registry for a delegated run: the same tool objects, the same hook set, but its own run-scoped
   * tools and no cleanup ownership. Cloning instead of sharing is what keeps a run's `replace` calls
   * (`task_step`, `submit_plan`, `submit_report`, `delegate_task`) from overwriting its parent's or a
   * sibling's. Hooks stay shared by reference, so extension hooks still observe every run.
   *
   * `allow`, when given, is a hard allowlist: the copy keeps only those tools, so an unlisted name is
   * not executable at all rather than merely absent from the schema. That is what makes a read-only
   * sub-agent unable to disturb the run that delegated to it — for example by stopping its parent's
   * background jobs or language server, tools that carry no permission and would otherwise pass the
   * read-only filter.
   */
  forRun(options: { allow?: readonly string[] } = {}): ToolRegistry {
    // The job registry is shared, not copied: it belongs to the session, and a per-run copy with no producers
    // would answer `job_list` with an empty list for a session that plainly has jobs.
    const copy = new ToolRegistry(this.hooks, this.jobs);
    copy.entries = new Map(this.entries);
    // The deadline policy travels with the tools it applies to. A delegated or read-only run whose registry
    // silently lost the policy would be exactly the "declared but not in effect" setting this project refuses:
    // the parent's calls would be bounded and the child's — running the same tools — would not.
    copy.deadlines = this.deadlines;
    copy.workspaceRoot = this.workspaceRoot;
    // The presentation travels with the tools too: see the field's comment.
    copy.toolMode = this.toolMode;
    copy.deferrable = this.deferrable;
    /**
     * The run-scoped tools come out by `remove`; the read-only allowlist goes on as a **restriction**.
     *
     * The two are different statements and the difference matters at the seam. `RUN_SCOPED_TOOLS` is not a policy
     * about this run — those tools belong to *that* run and must not exist in a copy at all, so removing them is
     * the honest description. An allowlist is a policy, and installing it as one keeps a single rule for what this
     * registry offers: `specs()` and `execute()` both read `offers()`, so a name off the list is neither visible
     * nor callable, with no second path that could disagree.
     *
     * The allowlist is installed as a restriction **bound to the entries the copy holds now**, not as a blanket
     * `allow` and not as a name-only `deny`. All three shapes would hide the same tools *at this moment*, and they
     * differ in what happens next — which is the only thing that matters here, because `childTurns` installs the
     * delegation's own `submit_report` with `replace` *after* this copy exists. A blanket `allow` would hide it
     * (the name is not on the read-only list) and a name-only `deny` would hide it too (the parent's registry
     * usually carries that name), and in both cases the child would be refused the one tool it is required to
     * answer with. Binding the deny to the entries says what the allowlist means: *these* tools are the parent's.
     * Both halves are exercised by `tests/tool-restrict.test.ts` and `tests/run-scoped-tools.test.ts`.
     */
    for (const name of RUN_SCOPED_TOOLS) copy.entries.delete(name);
    if (options.allow) {
      const allowed = new Set(options.allow);
      const denied = [...copy.entries.entries()].filter(([name]) => !allowed.has(name));
      if (denied.length)
        copy.restrict({
          deny: denied.map(([name]) => name),
          entries: denied.map(([, entry]) => entry),
        });
    }
    return copy;
  }
  /**
   * The staged pipeline: validate -> pre-execute -> guards -> prepare -> approval -> execute ->
   * post-execute -> finalize -> result (see `pipeline.ts`). Every early return still passes through
   * `result`, so the runtime invariant can tell "ended early by policy" from "ended out of order".
   */
  async execute(call: ToolCall, context: ToolContext): Promise<ToolExecutionResult> {
    const config = resolveSandboxConfig();
    const fixed = snapshotExecutionPolicy(
      context.executionPolicyForCall?.() ??
        context.executionPolicy ??
        executionPolicy(config.mode, config),
    );
    return withExecutionPolicy(fixed, () =>
      this.executeScoped(call, {
        ...context,
        executionPolicy: fixed,
        workspaceRoot: this.workspaceRoot ?? context.workspaceRoot,
      }),
    );
  }
  private async executeScoped(call: ToolCall, context: ToolContext): Promise<ToolExecutionResult> {
    context.signal.throwIfAborted();
    /**
     * This registry's own job control, unless the caller supplied one.
     *
     * The registry is what knows the session scope, so defaulting here is what makes `job_*` work for every
     * caller of `execute` — including an embedder or a test that built tools with `createTools` and never
     * heard of a job registry. A caller that supplies its own still wins.
     */
    /**
     * The call's own signal, so this call can be stopped without stopping the run.
     *
     * A child of the run's signal rather than the run's signal itself, because two different things now need to
     * end a tool call — the user cancelling the run, and this call running out of its budget — and only one of
     * them is a cancellation. Linking them keeps the first working exactly as it did (`aborted`, `reason` and
     * `throwIfAborted()` all behave the same through the child) while letting the deadline end the second.
     */
    const callAbort = new AbortController();
    const abortWithRun = () => callAbort.abort(context.signal.reason);
    if (context.signal.aborted) abortWithRun();
    else context.signal.addEventListener('abort', abortWithRun, { once: true });
    const scope = { ...context, signal: callAbort.signal, jobs: context.jobs ?? this.jobs };
    const attempt = (this.attempts.get(call.name) ?? 0) + 1;
    this.attempts.set(call.name, attempt);
    const entry = this.entries.get(call.name);
    const execution: ToolExecution = Object.freeze({
      call: Object.freeze(structuredClone(call)),
      tool: call.name,
      ...(entry?.tool.permission ? { permission: entry.tool.permission } : {}),
      attempt,
      ...(context.sessionId ? { sessionId: context.sessionId } : {}),
      ...(context.readOnly ? { readOnly: true } : {}),
    });
    const invariant = this.pipelineInvariant;
    let completed = false;
    let commandExecuted = false;
    const materialize = (
      result: ToolResult,
      extra: { notice?: boolean; additionalContext?: string[] } = {},
    ): ToolExecutionResult => {
      invariant.enter(execution, 'result');
      completed = true;
      const final = finalResult(result, call.name, context.spill, extra);
      return commandExecuted ? { ...final, commandExecuted: true } : final;
    };
    try {
      invariant.enter(execution, 'validate');
      if (!entry) return materialize(errorResult(`Unknown tool: ${call.name}`));
      if (entry.tool.permission === 'write' && context.executionPolicy?.files === 'read-only')
        return materialize(
          errorResult("File mutation is refused by this call's read-only execution policy"),
        );
      /**
       * A restricted tool is a *third* answer, and it has to read as one.
       *
       * "This tool does not exist" and "this run may not use this tool" send a model to different places: the
       * first makes it check the name it wrote, the second makes it report a limit. Reporting the second as the
       * first is how a policy turns into a wild goose chase, so the refusal names the restriction and says that
       * it is deliberate.
       */
      if (!this.offers(call.name))
        return materialize(
          errorResult(
            `Tool "${call.name}" is not available in this run; it is registered but excluded by a restriction. Do not retry it.`,
          ),
        );
      if (!entry.validate(call.arguments)) {
        const additional = entry.validate.errors?.some(
          (error) => error.keyword === 'additionalProperties' && error.instancePath === '',
        );
        return materialize(
          errorResult(
            invalidArgumentsMessage(
              this.ajv.errorsText(entry.validate.errors),
              entry.tool.inputSchema.properties,
              additional === true,
            ),
          ),
        );
      }

      invariant.enter(execution, 'pre-execute');
      const outcome = await this.hooks.beforeTool(call, context.signal);
      if (outcome === 'failed') {
        context.signal.throwIfAborted();
        return materialize(
          errorResult('Extension before-tool hook failed; operation was not executed'),
        );
      }
      if (outcome === 'deny')
        return materialize(
          errorResult('Operation denied by extension; permission cannot be granted by hooks'),
        );
      context.signal.throwIfAborted();

      invariant.enter(execution, 'guards');
      const denial = await this.hooks.runGuards(execution, this.guards, context.signal);
      if (denial) return materialize(errorResult(denial));
      context.signal.throwIfAborted();

      // A command the backend would refuse whatever it is (a sandbox lease a dead process left) is refused here,
      // before anyone is asked to approve it: an approval for an outcome already known only costs the person.
      if (entry.tool.permission === 'command' && context.executionPolicy) {
        const blocked = await commandBlocker(context.executionPolicy.mode);
        if (blocked) return materialize(errorResult(blocked));
        context.signal.throwIfAborted();
      }

      invariant.enter(execution, 'prepare');
      let prepared = await entry.tool.prepare?.(call.arguments, scope);
      context.signal.throwIfAborted();
      const approval = entry.tool.permission
        ? {
            kind: entry.tool.permission,
            description: `${call.name}: ${JSON.stringify(call.arguments)}${prepared?.approvalDescription ? '\n' + prepared.approvalDescription : entry.tool.approvalDescription ? '\n' + entry.tool.approvalDescription : ''}${entry.tool.permission === 'command' && context.executionPolicy ? '\n' + describeExecutionBoundary(context.executionPolicy) : ''}`,
            toolCall: call,
            ...(prepared?.change ? { change: prepared.change } : {}),
            ...(entry.tool.permission === 'command' && context.executionPolicy
              ? {
                  boundary: {
                    processFiles: context.executionPolicy.processFiles,
                    network: context.executionPolicy.network,
                  },
                }
              : {}),
          }
        : undefined;

      let approvedPolicy = context.permissionPolicyForCall?.();
      if (entry.tool.permission) {
        invariant.enter(execution, 'approval');
        const decision = await approveWithinBudget(
          approval!,
          context.approve,
          context.signal,
          this.deadlines?.approvalMs,
        );
        context.signal.throwIfAborted();
        if (!decision.allowed) {
          const reason = approval ? context.approve?.decisionReason?.(approval) : undefined;
          if (reason === 'read-only')
            return materialize(
              errorResult(
                `Tool "${call.name}" is not available in this read-only run: it declares a permission and no effect was executed. ` +
                  'If this is a planning run, do not ask the user to authorize it; call exit_plan_mode with the plan instead.',
              ),
            );
          return materialize(
            errorResult(
              decision.timedOut
                ? `Permission was not granted: nobody answered the approval request within ${decision.budgetMs}ms. Nothing was executed; do not retry without new authorization.`
                : 'Permission denied by user. Do not retry the operation without new authorization.',
            ),
          );
        }
      }
      if (context.readOnly && entry.tool.permission)
        return materialize(
          errorResult(
            `Tool "${call.name}" is not available in this read-only run: it declares a permission and no effect was executed. ` +
              'If this is a planning run, do not ask the user to authorize it; call exit_plan_mode with the plan instead.',
          ),
        );

      let dispatchPolicy = context.executionPolicy!;
      const refreshDispatch = async (dispatchSignal: AbortSignal) => {
        dispatchSignal.throwIfAborted();
        if (approval && context.permissionPolicyForCall?.() !== approvedPolicy) {
          approvedPolicy = context.permissionPolicyForCall?.();
          const decision = approvedPolicy?.decide(approval);
          if (decision === 'deny')
            throw new Error('Permission denied by the current policy. No effect was executed.');
          if (decision !== 'allow') {
            const answer = await approveWithinBudget(
              approval,
              context.approve,
              dispatchSignal,
              this.deadlines?.approvalMs,
            );
            if (!answer.allowed)
              throw new Error(
                answer.timedOut
                  ? 'Permission was not granted before the approval timeout; no effect was executed.'
                  : 'Permission denied by the current policy. No effect was executed.',
              );
          }
          dispatchSignal.throwIfAborted();
        }
        const next = snapshotExecutionPolicy(
          context.executionPolicyForCall?.() ?? context.executionPolicy!,
        );
        if (entry.tool.permission === 'write' && next.files === 'read-only')
          throw new Error("File mutation is refused by this call's read-only execution policy");
        if (prepared && !isDeepStrictEqual(next, dispatchPolicy)) {
          const refreshed = await withExecutionPolicy(next, () =>
            entry.tool.prepare!(call.arguments, {
              ...scope,
              signal: dispatchSignal,
              executionPolicy: next,
              executionPolicyForCall: undefined,
              permissionPolicyForCall: undefined,
            }),
          );
          dispatchSignal.throwIfAborted();
          if (
            !isDeepStrictEqual(refreshed?.change, prepared.change) ||
            refreshed?.approvalDescription !== prepared.approvalDescription
          )
            throw new Error('Operation changed after approval; request a new tool call.');
          if (
            !isDeepStrictEqual(context.executionPolicyForCall?.() ?? next, next) ||
            (approval && context.permissionPolicyForCall?.() !== approvedPolicy)
          )
            throw new Error(
              'Execution policy changed during preparation; request a new tool call.',
            );
          prepared = refreshed;
        }
        dispatchPolicy = next;
      };
      const dispatchScope = {
        ...scope,
        executionPolicy: dispatchPolicy,
        executionPolicyForCall: undefined,
        permissionPolicyForCall: undefined,
      };
      invariant.enter(execution, 'execute');
      let result: ToolResult;
      try {
        /**
         * The dispatch itself is wrapped by `aroundTool`, so a timeout, retry or metrics span can bracket the call
         * without gaining the power to fabricate its result.
         *
         * The chain threads a `ToolDispatch`, and what a wrapper replaces is the **scope** — the signal the body
         * observes, the jobs it may reach — never the frozen `execution`. That is what lets a wrapper shorten a
         * call's cancellation without rewriting the record of what was requested, and it is why the deadline below
         * reads the signal *the wrapper chain handed it* rather than the one this method created.
         */
        const dispatched = createDispatch(execution, dispatchScope, callAbort);
        let bodyAttempts = 0;
        let ownedDeadlineExpired = false;
        result = await withExecutionPolicy(dispatchPolicy, () =>
          this.hooks.aroundTool(
            dispatched,
            (current) => {
              const original = current;
              if (
                ownedDeadlineExpired &&
                current.abort === callAbort &&
                current.signal === callAbort.signal
              ) {
                const retryAbort = new AbortController();
                current = current.withSignal(
                  AbortSignal.any([context.signal, retryAbort.signal]),
                  retryAbort,
                );
              }
              return runWithDeadline(
                call.name,
                current.abort,
                async () => {
                  const dispatchSignal = AbortSignal.any([
                    context.signal,
                    current.signal,
                    current.abort.signal,
                  ]);
                  // Wrappers may wait before next(). Refresh at the first body, then pin retries.
                  if (!bodyAttempts) {
                    for (;;) {
                      await refreshDispatch(dispatchSignal);
                      dispatchSignal.throwIfAborted();
                      if (
                        (!approval || context.permissionPolicyForCall?.() === approvedPolicy) &&
                        isDeepStrictEqual(
                          context.executionPolicyForCall?.() ?? dispatchPolicy,
                          dispatchPolicy,
                        )
                      )
                        break;
                    }
                  }
                  dispatchSignal.throwIfAborted();
                  if (!bodyAttempts && entry.tool.permission) context.effectJournal?.begin(call);
                  const attempt = ++bodyAttempts;
                  const startedAt = Date.now();
                  const executionClock = performance.now();
                  const observe = (phase: 'started' | 'finished') => {
                    try {
                      void Promise.resolve(
                        context.onExecution?.({
                          phase,
                          attempt,
                          startedAt,
                          ...(phase === 'finished'
                            ? {
                                finishedAt: Date.now(),
                                durationMs: Math.max(0, performance.now() - executionClock),
                              }
                            : {}),
                        }),
                      ).catch(() => {});
                    } catch {
                      /* Diagnostics cannot change tool effects. */
                    }
                  };
                  observe('started');
                  try {
                    return await withExecutionPolicy(dispatchPolicy, () =>
                      prepared
                        ? prepared.execute({
                            ...current.scope,
                            executionPolicy: dispatchPolicy,
                            executionPolicyForCall: undefined,
                            permissionPolicyForCall: undefined,
                            workspaceRoot: context.workspaceRoot,
                          })
                        : entry.tool.execute(call.arguments, {
                            ...current.scope,
                            executionPolicy: dispatchPolicy,
                            executionPolicyForCall: undefined,
                            permissionPolicyForCall: undefined,
                            workspaceRoot: context.workspaceRoot,
                          }),
                    );
                  } finally {
                    observe('finished');
                  }
                },
                this.deadlines,
                entry.tool.cancellationGraceMs,
              ).catch((error) => {
                if (
                  original.abort === callAbort &&
                  error instanceof ToolTimeoutError &&
                  current.abort.signal.reason === error
                )
                  ownedDeadlineExpired = true;
                throw error;
              });
            },
            context.signal,
          ),
        );
      } catch (error) {
        if (
          error instanceof DeferredApprovalError ||
          (error instanceof Error && error.name === 'ToolCleanupError')
        )
          throw error;
        context.signal.throwIfAborted();
        // A tool body that threw still produced a result as far as the model is concerned, so policy
        // and observers get to see it. `postExecute` refuses to replace a failed result, which keeps
        // this from becoming a way to turn a failure into a success.
        result = errorResult(error);
      }

      context.signal.throwIfAborted();
      invariant.enter(execution, 'post-execute');
      // Extensions may redact or block a result, but cannot undo a command that already ran.
      commandExecuted = result.commandExecuted === true;
      // Invalid attachments are a failed tool result; observers and finalizers still run normally.
      result = normalizeImages(result);
      const post = await this.hooks.postExecute(execution, result, context.signal);

      context.signal.throwIfAborted();
      invariant.enter(execution, 'finalize');
      const finalized = await this.hooks.finalizeContent(execution, post.result, context.signal);
      const final =
        finalized.content === undefined
          ? post.result
          : { ...post.result, content: finalized.content };
      context.signal.throwIfAborted();
      return materialize(final, {
        notice: post.observerFailed || finalized.observerFailed,
        additionalContext: post.additionalContext,
      });
    } catch (error) {
      if (
        error instanceof DeferredApprovalError ||
        (error instanceof Error && error.name === 'ToolCleanupError')
      )
        throw error;
      context.signal.throwIfAborted();
      // Pipeline failures before dispatch bypass post-execute and finalize, exactly as the stage
      // contract says; they are normalized to a failed result here.
      return materialize(errorResult(error));
    } finally {
      context.signal.removeEventListener('abort', abortWithRun);
      invariant.leave(execution, completed);
    }
  }
}
/** The backend's own reason no command can run now; a failing check is no reason, so prepare still decides. */
async function commandBlocker(mode: SandboxMode): Promise<Error | undefined> {
  try {
    return await sandboxProvider(mode).blocked?.();
  } catch {
    return undefined;
  }
}
export { ToolPipelineInvariant };
export type { PipelineStage, PostToolDecision, ToolExecution, ToolExecutionResult };
