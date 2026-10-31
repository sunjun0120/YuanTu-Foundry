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
  /** Planning or read-only lifecycle: workspace-declared commands must not run. */
  readOnly?: boolean;
}
export interface SessionEndContext {
  sessionId: string;
  reason: 'delete' | 'shutdown';
  /** Planning or read-only lifecycle: workspace-declared commands must not run. */
  readOnly?: boolean;
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
 * A stop hook observes a finished run. It can report a reason but cannot re-open the run, whose
 * result and effects are already persisted.
 */
export type StopResult = void | { block?: string };
/**
 * Monotonic tool guard: it may only deny, and a throw denies too. Safe to inherit into every
 * delegated run for that reason.
 */
export type ToolGuard = (
  execution: ToolExecution,
  signal: AbortSignal,
) => GuardDecision | Promise<GuardDecision>;
/**
 * A wrapper around the dispatch itself, outermost first, for timeouts, retries or metrics. Calling
 * `next()` again re-runs the tool; not calling it is an error.
 *
 * A wrapper that replaces the signal passes the replacement down with `next(replacement)`; an
 * observer calls `next()`. This keeps wrappers composable and cancellation real.
 */
export type ToolWrapper = (
  dispatch: ToolDispatch,
  next: (replacement?: ToolDispatch) => Promise<ToolResult>,
) => ToolResult | Promise<ToolResult>;
/**
 * What one tool body is handed, as the wrapper chain sees it. `execution` is the frozen audit
 * identity and never changes down the chain; `scope` is what a wrapper may replace; `signal`
 * mirrors `scope.signal`. `abort` owns the current signal, so the registry's deadline and the run's
 * cancellation still reach a replaced one.
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
  /** Which round this is, from zero. A count, not a budget: runs have no round cap. */
  round: number;
  /** The persisted transcript at the start of the round, before compaction for this request. */
  messages: readonly Message[];
  /**
   * The model and effort this round would use unless a hook changes it. Pre-step hooks form a
   * waterfall for these fields: each sees earlier hooks' choices, the last one wins, and every
   * round starts fresh.
   */
  model: string;
  reasoningEffort?: ReasoningEffort;
}
export type PreStepResult = void | {
  block?: string;
  inject?: string[];
  /** Serve this round on another model. Omitted keeps the current choice. */
  model?: string;
  /** How much reasoning to buy for this round; `none` removes the parameter an earlier hook asked for. */
  reasoningEffort?: ReasoningEffort;
};
/**
 * The hook set a trusted embedder declares (`AgentExtension.hooks` in
 * `packages/resources/extensions.ts`), applied by `registerExtension` and removed by its disposer.
 * An embedding API: seams without an in-repo consumer are still documented and contract-tested
 * (`tests/tools-pipeline.test.ts`).
 */
export interface ExtensionHooks {
  /**
   * Round preamble. `{block}` refuses the run before the request; `{inject}` adds model-visible
   * context persisted as a user message, like post-execute `add-context`. A throw refuses the run.
   */
  preStep?(context: PreStepContext, signal: AbortSignal): PreStepResult | Promise<PreStepResult>;
  /**
   * Pre-execute gate. `false` refuses the call; `{deny: reason}` refuses it and shows the reason to
   * the model. Anything else allows it.
   */
  beforeTool?(
    call: ToolCall,
    signal: AbortSignal,
  ): BeforeToolDecision | Promise<BeforeToolDecision>;
  /**
   * Deny-only guard, evaluated after every `beforeTool` for the same call. Same as `registerGuard`,
   * but disposed with the hook set.
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
   * Last content-only stage, after every policy decision and before truncation. It can normalize
   * what the model reads but not change the outcome or effects.
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
/** The single source of truth for accepted hook names; validation derives from it. */
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
export type BeforeToolDecision = boolean | void | { deny: string };
/** `{deny}` is a refusal that carries the hook's reason; `'deny'` is one that gave none. */
export type BeforeToolOutcome = 'allow' | 'deny' | 'failed' | { deny: string };
/** What post-execute policy decided, plus whether an observer misbehaved along the way. */
export interface PostExecuteOutcome {
  result: ToolResult;
  additionalContext: string[];
  observerFailed: boolean;
}
