import type {
  Message,
  ReasoningEffort,
  RunStatus,
  ToolCall,
  ToolResult,
  ToolScope,
} from './index.ts';
import type { GuardDecision, PostToolDecision, ToolExecution } from './tool-pipeline.ts';
export interface SessionHookContext {
  sessionId: string;
  workspace: string;
  /** True when an existing session was loaded rather than created. */
  resumed: boolean;
}
export interface SessionEndContext {
  sessionId: string;
  reason: 'delete' | 'shutdown';
}
export interface PromptSubmitContext {
  sessionId: string;
  prompt: string;
  /** A planning or read-only run: a hook that would touch the world outside this process must not run. */
  readOnly?: boolean;
}
/** A prompt hook may rewrite the prompt or refuse to start the run. */
export type PromptSubmitResult = void | { prompt?: string; block?: string };
export interface StopContext {
  sessionId: string;
  runId: string;
  status: RunStatus;
  text: string;
  error?: string;
  /** A planning or read-only run: a hook that would touch the world outside this process must not run. */
  readOnly?: boolean;
}
/**
 * A stop hook observes a finished run. It can report a reason for the user, but it cannot re-open the
 * run: the result is already persisted and the tool effects have happened, so "continue" would need a
 * whole new attempt rather than a veto.
 */
export type StopResult = void | { block?: string };
/**
 * Monotonic tool guard: it may only deny, and a thrown error denies too (an unanswerable guard must
 * not read as consent). Because denial is the only thing it can express, a guard is safe to install
 * on a host and inherit into every delegated run, which is exactly how `HookRegistry` guards behave.
 */
export type ToolGuard = (
  execution: ToolExecution,
  signal: AbortSignal,
) => GuardDecision | Promise<GuardDecision>;
/**
 * A wrapper around the dispatch itself, outermost first.
 *
 * It exists for the things that bracket a call rather than decide about it: a timeout, a retry, a
 * metrics span. Calling `next()` more than once re-runs the tool (that is what a retry is); *not*
 * calling it is an error, because a wrapper that returns without dispatching would report an effect
 * that never happened.
 *
 * `next` takes the {@link ToolDispatch} the rest of the chain runs under, and this is what makes wrapper
 * policies **composable** rather than merely nestable. A wrapper that replaces the signal (a shorter deadline,
 * a cancelled parent, a sandbox escalation that re-resolves the policy) hands the replacement down with
 * `next(replacement)`; one that only observes calls `next()` and passes its own through untouched. The
 * alternative — wrapping `next()` and hoping the body notices — can only bound the wrapper's own waiting, which
 * reports a stop that did not happen.
 */
export type ToolWrapper = (
  dispatch: ToolDispatch,
  next: (replacement?: ToolDispatch) => Promise<ToolResult>,
) => ToolResult | Promise<ToolResult>;
/**
 * What one tool body is handed, as the wrapper chain sees it.
 *
 * `execution` is the frozen, audit-facing identity of the call and stays the same object down the whole chain —
 * a policy that rewrites *that* would make the record of what was requested disagree with what ran, which is
 * what the frozen type exists to prevent. `scope` is the part a wrapper may legitimately replace. `signal` is a
 * convenience mirror of `scope.signal` so a wrapper that only cares about cancellation does not have to
 * destructure.
 *
 * `abort` is the controller that owns whatever signal `scope` currently carries, which is what makes a
 * replacement *reachable*: the registry's own deadline and the run's cancellation both end a call by aborting the
 * dispatch they hold, and a wrapper that installed its own signal hands down a controller whose abort reaches
 * that one. Without it a replacement signal would be a bound nobody could tighten — a policy that reported a
 * stop it had no way to cause.
 */
export interface ToolDispatch {
  readonly execution: ToolExecution;
  readonly scope: ToolScope;
  readonly signal: AbortSignal;
  readonly abort: AbortController;
  /** The same scope with a different signal, and a controller that aborts it. */
  withSignal(signal: AbortSignal, abort: AbortController): ToolDispatch;
  /** The same scope plus overrides, for a wrapper that must change something else the body will read. */
  withScope(scope: ToolScope): ToolDispatch;
}
/** A round preamble: it observes the round and may refuse it, add model-visible context, or re-aim it. */
export interface PreStepContext {
  sessionId: string;
  runId: string;
  /**
   * Which round this is, counted from zero.
   *
   * A count, not a budget: a run has no round cap, so a policy that wants to bound what it does across rounds
   * keeps its own count rather than comparing this against a ceiling that does not exist.
   */
  round: number;
  /** The persisted transcript at the start of the round, before compaction for this request. */
  messages: readonly Message[];
  /**
   * The model and effort the request for this round would use if no hook said otherwise.
   *
   * Present so a policy can *chain* rather than guess: the pre-step dispatch is a waterfall for these two
   * fields, so each hook reads what the hooks before it chose — in this same round — and the last one to name
   * a value wins. Every round starts from the run's own values.
   */
  model: string;
  reasoningEffort?: ReasoningEffort;
}
export type PreStepResult = void | {
  block?: string;
  inject?: string[];
  /**
   * Serve this round on another model. Omitted leaves the run's own model — or, when an earlier hook in this
   * same round named one, that choice — in place.
   */
  model?: string;
  /** How much reasoning to buy for this round; `none` removes the parameter an earlier hook asked for. */
  reasoningEffort?: ReasoningEffort;
};
/**
 * The hook set a trusted embedder declares: `AgentExtension.hooks` in `packages/resources/extensions.ts`, applied
 * by `registerExtension` and taken back out by its disposer.
 *
 * It is an **embedding** API, so "no consumer inside this repository" is expected rather than rot — the consumers
 * are the embedders, and what keeps a seam from rotting here is that its semantics are written down, contract-tested
 * (`tests/tools-pipeline.test.ts`) and checked at runtime (the pipeline invariant rejects a stage that runs out of
 * order). A dated comparison flagged `guard`, `aroundTool` and `finalizeContent` as unused because only
 * `postExecute` has an in-repo consumer (the hook bridge, which maps a workspace's declared hooks onto it). That is
 * a fact about this repository, not a defect in the seams: deleting them would remove documented capability from
 * the embedding API, and adding a consumer would mean inventing product behaviour nobody asked for. What would make
 * one removable is narrower and worth stating: a seam that stopped being part of the documented API — nothing in
 * the README, the protocol or a test refers to it — is a seam nothing would miss.
 */
export interface ExtensionHooks {
  /**
   * Round preamble. `{block}` refuses the run before the request is made; `{inject}` adds model-visible
   * context that is persisted as a user message, exactly like `add-context` from post-execute. A hook
   * that throws refuses the run too: a policy that could not run is not a policy that consented.
   */
  preStep?(context: PreStepContext, signal: AbortSignal): PreStepResult | Promise<PreStepResult>;
  beforeTool?(call: ToolCall, signal: AbortSignal): boolean | void | Promise<boolean | void>;
  /**
   * Monotonic deny-only guard, evaluated after every `beforeTool` hook for the same call.
   *
   * Declaring it here is the same thing as calling `registerGuard`, except that it travels with the hook set
   * and is taken back out when that set is disposed.
   */
  guard?(execution: ToolExecution, signal: AbortSignal): GuardDecision | Promise<GuardDecision>;
  /** Around-dispatch wrapper for the `execute` stage. It must delegate with `next()`. */
  aroundTool?: ToolWrapper;
  afterTool?(call: ToolCall, result: ToolResult, signal: AbortSignal): void | Promise<void>;
  /** Post-execute policy: accept, block, replace the result, or inject model-visible context. */
  postExecute?(
    execution: ToolExecution,
    result: ToolResult,
    signal: AbortSignal,
  ): PostToolDecision | void | Promise<PostToolDecision | void>;
  /**
   * Last content-only stage. It runs after every policy decision and before truncation, so it can
   * normalize what the model reads but cannot change whether the call succeeded or what it changed.
   */
  finalizeContent?(
    execution: ToolExecution,
    result: Readonly<ToolResult>,
    signal: AbortSignal,
  ): string | void | Promise<string | void>;
  sessionStart?(context: SessionHookContext, signal: AbortSignal): void | Promise<void>;
  sessionEnd?(context: SessionEndContext, signal: AbortSignal): void | Promise<void>;
  promptSubmit?(
    context: PromptSubmitContext,
    signal: AbortSignal,
  ): PromptSubmitResult | Promise<PromptSubmitResult>;
  stop?(context: StopContext, signal: AbortSignal): StopResult | Promise<StopResult>;
  close?(): Promise<void>;
}
/**
 * The single source of truth for accepted hook names. Validation derives from it, because a hook that
 * is declared here but missing from a hand-written allow-list throws "Invalid extension hooks" — the
 * same class of drift that silently dropped event types in the client allow-list.
 */
export const EXTENSION_HOOK_NAMES = [
  'preStep',
  'beforeTool',
  'guard',
  'aroundTool',
  'afterTool',
  'postExecute',
  'finalizeContent',
  'sessionStart',
  'sessionEnd',
  'promptSubmit',
  'stop',
  'close',
] as const;
export type BeforeToolOutcome = 'allow' | 'deny' | 'failed';
/** What post-execute policy decided, plus whether an observer misbehaved along the way. */
export interface PostExecuteOutcome {
  result: ToolResult;
  additionalContext: string[];
  observerFailed: boolean;
}
