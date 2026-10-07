/**
 * How long one tool call may take.
 *
 * The run had a dozen bounds and none of them was this one: `requestTimeoutMs` bounds a model request,
 * `run_command` has a `timeout_ms` of its own — and a tool that simply never answered (an MCP server that
 * stopped reading, a language server that never replied, a tool body waiting on a promise nobody will settle)
 * held the run open until the user noticed and cancelled it. This is that bound, and it is per call rather than
 * per run because "this tool is slow" and "this run is long" are different facts.
 *
 * Three decisions are worth stating:
 *
 * - **The budget is a deadline, not a race.** The call gets a signal of its own and the deadline aborts it, so a
 *   cooperative tool stops what it is doing (the command tool kills its child, an HTTP tool closes its socket)
 *   instead of being abandoned mid-flight while the run walks away. The wait is bounded either way, because a
 *   tool that ignores its signal must not be able to hold the run open; but the difference between "asked to
 *   stop" and "abandoned" is the difference between a clean failure and a leak.
 * - **A timeout is a tool result, not a run failure.** The model is told, in the tool result, that the call was
 *   cut off and what to do instead; the loop continues exactly as it does for any other tool error. Ending the
 *   run would take the decision away from the only party that knows whether the rest of the work still makes
 *   sense.
 * - **The default is generous and the exceptions are named.** Ten minutes is longer than any legitimate call
 *   this build makes and far shorter than forever; the two tools that legitimately take longer (or wait on a
 *   person) are listed in `overrides` with the reason. A caller that wants a different policy — a test, an
 *   embedder, a stricter deployment — sets one on the registry and gets exactly that.
 *
 * `YUANTU_TOOL_TIMEOUT_MS` overrides the default (`0` turns the deadline off entirely); it is deliberately not a
 * CLI flag, because the policy is a property of the tool registry the host builds, not of one run.
 */
import { parseSetting } from '../protocol/settings.ts';

/**
 * The token a client, a test or a human can branch on.
 *
 * The result also explains itself in prose — the model is the primary reader — but prose changes and a marker
 * does not, so the first word of the message is fixed here rather than spelled out at the throw site.
 */
export const TOOL_TIMEOUT_MARKER = 'TOOL_TIMEOUT';

/** Which calls get how long. `defaultMs` of 0 (or an override of 0) means "this one has no deadline". */
export interface ToolDeadlinePolicy {
  defaultMs?: number;
  overrides?: Readonly<Record<string, number>>;
}

/**
 * What the product ships.
 *
 * `ask_user_question` is exempt because waiting for a person is not a hung tool: it has a timeout of its own
 * (`YUANTU_QUESTION_TIMEOUT_MS`, and a per-question `timeoutMs`), and a deadline layered on top of it would cut
 * off an answer that was on its way. `run_command` is exempt from the default for the same kind of reason: it
 * owns a budget for the command itself (`timeout_ms`, default 60s, at most 300s) and reports `timedOut` in its
 * result, so the only thing left for this deadline to catch is a command stuck *past* its own timeout — a
 * sandbox teardown that never returns, a child that ignores the kill — which is why its number is that budget
 * plus room to clean up.
 *
 * The two delegation tools are exempt for the third kind of reason, and it is the one the original table
 * predicted: they are calls whose duration is set by *other agents' work*, not by this call. `delegate_task`
 * with the default `wait: true` resolves only when every task it admitted has settled, and `workflow` resolves
 * when the script returns — which for a script that fans out four investigations is four child runs deep. No
 * budget is both generous enough for that and short enough to catch a hang, and the two failure modes are not
 * equally bad: cutting a live delegation discards work that is still progressing and makes the parent delegate
 * the same ground again, while a genuinely stuck child is already bounded by its own run, by the run's end
 * (`SubAgentCoordinator.settle`) and by the user's Stop.
 *
 * `workflow` owns a bound of its own, which is what makes its exemption honest rather than a hole: the tool takes
 * a `timeoutMs` argument, `0` means no deadline, and a `0` here only removes the *deployment's default* — a caller
 * that wants a stopwatch still states one. It is the same arrangement the shell tools have (no executor timeout for
 * a registered command; the caller's deadline bounds the wait), and it is what lets a real fan-out finish instead
 * of being killed with its children at the deployment default.
 *
 * The list is deliberately short and every entry has a reason. Adding a name here removes the only automatic
 * bound on a call that never answers, so the tool it names must own a bound of its own — the two delegation
 * tools do: per-run admission, the concurrency semaphore, the child's own round and window limits, and (for
 * `workflow`) its own `timeoutMs`.
 */
export const TOOL_DEADLINE_DEFAULTS: Required<ToolDeadlinePolicy> = {
  defaultMs: 600_000,
  overrides: {
    ask_user_question: 0,
    run_command: 330_000,
    delegate_task: 0,
    workflow: 0,
  },
};

/**
 * A tool call that ran out of its budget.
 *
 * Its own class because three readers need to tell it apart from every other way a tool fails: the runner
 * (a cancellation must never be reported as a timeout), the client (the marker), and a test that wants to know
 * the tool was *told* to stop rather than abandoned. The message is written for the model, because that is who
 * reads it first: what happened, that the run continues, and what to do instead.
 */
export class ToolTimeoutError extends Error {
  readonly tool: string;
  readonly timeoutMs: number;
  constructor(tool: string, timeoutMs: number) {
    super(
      `${TOOL_TIMEOUT_MARKER}: "${tool}" exceeded its ${timeoutMs}ms tool budget and was asked to stop. ` +
        'Anything it had already changed is partial. Report the blocker instead of repeating the same call; ' +
        'if the work is genuinely long-running, use a tool that runs it in the background.',
    );
    this.name = 'ToolTimeoutError';
    this.tool = tool;
    this.timeoutMs = timeoutMs;
  }
}

/** The budget for one call, or `undefined` when it has none. */
export function resolveToolDeadline(
  name: string,
  policy: ToolDeadlinePolicy | undefined,
): number | undefined {
  if (!policy) return undefined;
  const budget = policy.overrides?.[name] ?? policy.defaultMs;
  return budget !== undefined && budget > 0 ? budget : undefined;
}

/**
 * The shipped policy with the environment applied.
 *
 * Validation happens before this point (`assertEnvironment` on every entry point), so a value that survives to
 * here parses; `parseSetting` still throws rather than guessing, because a run with an unreadable budget is not
 * something to start quietly.
 */
export function toolDeadlinePolicy(env: NodeJS.ProcessEnv = process.env): ToolDeadlinePolicy {
  const configured = parseSetting(env, 'YUANTU_TOOL_TIMEOUT_MS');
  return {
    defaultMs: typeof configured === 'number' ? configured : TOOL_DEADLINE_DEFAULTS.defaultMs,
    overrides: TOOL_DEADLINE_DEFAULTS.overrides,
  };
}
