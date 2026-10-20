import type { Message, ModelResponse, Provider, ToolSpec, Usage } from '../protocol/index.ts';
import type { SessionStore } from '../storage/sqlite.ts';
import { contextMessageSize } from '../protocol/images.ts';
import { contextBoundaries } from '../protocol/context.ts';

import { ContextLimitError, estimateInputTokens } from './budget.ts';
import { WINDOW_EXHAUSTED, forecastRequest, windowPressure } from './forecast.ts';
import { resolveCompactionSpec, retentionStart } from './compaction-policy.ts';
import type { RequestForecast } from './forecast.ts';
import { shortenMessages } from './shrink.ts';
import { pruneMessages } from './prune.ts';
import { assertPrunePolicy } from './prune.ts';
import type { PruneOutcome } from './prune.ts';
import type { TokenCalibration } from './calibration.ts';
import { storedSummary, summaryTranscript, withSummary } from './context-summary.ts';
import { firstHolding, lastHolding } from './boundary-search.ts';
import { projectToolResults } from './context-tool-results.ts';
export {
  SUMMARY_INSTRUCTION_PREFIX,
  SUMMARY_SECTIONS,
  withoutSummarySection,
} from './context-summary.ts';
import type { PreparedContext, PruneSeam, ShrinkSeam } from './context-seams.ts';
export type { PreparedContext, PruneSeam, ShrinkSeam } from './context-seams.ts';
export { ContextLimitError } from './budget.ts';
export async function prepareContext(input: {
  store: SessionStore;
  sessionId: string;
  system: string;
  tools: ToolSpec[];
  provider: Provider;
  limit: number;
  signal: AbortSignal;
  maxOutputTokens: number;
  maxContextTokens?: number;
  autoCompactTokens?: number;
  /** How long this summary request may take. A summary is a bounded task, so it always has a limit. */
  summaryTimeoutMs: number;
  onSummaryRetry?: (details: Record<string, unknown>) => void;
  /**
   * How to name the request a summary request is, when the caller caches prompts at all.
   *
   * A cache key has to describe the request that carries it, and the summary request is composed *here* — the
   * caller's system prompt, the caller's tool catalogue, and the summary instruction as the last message — so the
   * key cannot be a value the caller computed before the call. It is a function for that reason, and it is handed
   * the request's own system prompt and catalogue, so a caller whose provider files entries by key
   * (`promptCacheEnabled`) gets a key per request rather than one per round.
   *
   * The summary is a *message* (`summarySnapshot`), so compaction no longer moves the prefix: a summary request
   * replays the prefix of the round it follows and the round after it sends the same one, which is what makes the
   * key worth computing at all. What still makes it per-request is the prompt itself — approving a plan changes
   * the catalogue mid-run, and a key taken once per run would then name two prefixes.
   *
   * Returning `undefined` is allowed and is a refusal rather than an omission: a caller replaying a *recorded*
   * request names the key only while the request still matches the record, because a key for a prompt that is not
   * the one behind it points the provider at somebody else's conversation.
   */
  cacheKeyFor?: (system: string, tools: readonly ToolSpec[]) => string | undefined;
  calibration?: TokenCalibration;
  /** Absent when the host has nowhere to put the full text, in which case nothing is shortened. */
  shrink?: ShrinkSeam;
  /** Share of the window at which old tool results are shortened. Absent means only when the request cannot fit. */
  shrinkPercent?: number;
  /**
   * Absent means oversized old results are left whole.
   *
   * Unlike `shrink`, mounting this needs nothing from the host — no spill target and no calibrated measure — so
   * its absence is a deployment's choice rather than a missing capability.
   */
  prune?: PruneSeam;
  /**
   * Share of the window at which oversized old results start losing their middle.
   *
   * Absent means the same reading `shrinkPercent` has: the operator set no "in good time" point, so the pass
   * runs only when the request cannot fit as it stands.
   */
  prunePercent?: number;
  /**
   * The run this call is compacting for, when there is one.
   *
   * Compaction rewrites what the model sees, so it goes through the session's write lease: `claimCompaction`
   * is taken before the first summary request (so the run does not pay for a summary it would be refused at
   * the write) and `applyCompaction` re-checks the same rule when the op is recorded. Absent for a
   * store-level caller that holds no lease — there is then no competing writer to exclude.
   */
  runId?: string;
  onUsage: (response: ModelResponse) => void;
  onCompaction: (
    state: 'started' | 'finished' | 'failed',
    covered?: number,
    usage?: Usage,
    reason?: string,
  ) => void;
  forceCompact?: boolean;
  /**
   * Skip a compaction the *threshold* alone would start, because a recent attempt failed.
   *
   * Only the early trigger is deferred: a request that no longer fits is still compressed, because sending it as
   * it stands is the one thing known not to work. Without this a failing summary was retried — and paid for, and
   * waited on for up to `summaryTimeoutMs` — on every round the conversation stayed above the threshold.
   */
  deferThresholdCompaction?: boolean;
  /**
   * How many compressions this call has already paid for, when the convergence retry re-enters.
   *
   * Internal: it exists so the retry can call this same function again — re-reading the surface it just
   * recorded — instead of carrying a remembered view of the conversation through the loop.
   */
  compactionAttempt?: number;
  /**
   * What a compaction that cannot be performed means to this caller.
   *
   * `'throw'` is the default and is what a caller that asked for a compression on purpose wants: a person clicked
   * compact, the compaction did not happen, and the honest answer is a failure with the reason. A run wants
   * `'send'` instead: the run's estimate is a heuristic, the endpoint is the authority on whether the request
   * fits, and a compression that could not be produced is not a reason to abandon a request the endpoint may
   * still accept — see `PreparedContext.compactionProblem`, and `recoverFromOverflow` in the agent loop, which
   * handles the case where the endpoint *does* refuse.
   */
  compactionFailure?: 'throw' | 'send';
  /**
   * The model this round aims at, when the caller knows it.
   *
   * Recorded with the compaction the round produces, because a summary is a model answer: which model produced it
   * is part of what the record has to say for the summary to be reconstructible rather than merely present.
   */
  model?: string;
  /**
   * The adapter that answers this round — `anthropic`, `openai`, `openai-responses` — when the caller knows it.
   *
   * This runtime's word for the provider, and the other half of the route: a model name does not say which wire
   * protocol a summary came back over, so a record that names one without the other answers "what produced this?"
   * with half a sentence. Named `protocol` rather than `provider` because `provider` in this call is the adapter
   * *object* the summary is requested from.
   */
  protocol?: string;
}): Promise<PreparedContext> {
  const { store, sessionId, limit } = input;
  /**
   * The correction this session has learned for this route, in the two shapes the decisions below need.
   *
   * `factors()` is the per-part weights, for a whole request whose parts `measureRequest` will blend them over;
   * `messageWeight()` is the one weight that applies when nothing else is in the measure — a per-message cost, a
   * message-only budget. Keeping both here means no caller has to decide which of the three weights "the
   * correction" is.
   */
  const factors = () => input.calibration?.parts;
  const messageWeight = () => input.calibration?.factor ?? 1;
  const history = store.messages(sessionId);
  /**
   * The surface the log's last compaction defines, not a row: the summary that stands in for the covered
   * messages, and the count the tail is cut at. Everything below derives from it, so a session whose
   * compaction was recorded by an older build (or by another process) compacts cumulatively from exactly
   * where that build left off.
   */
  const surface = store.contextSurface(sessionId);
  const previouslyCovered = surface?.coveredMessages ?? 0;
  const previousSummary = surface?.summary ?? '';
  let covered = previouslyCovered;
  let summary = previousSummary;
  /**
   * The last batch's answer as it arrived, when storing it changed something.
   *
   * A multi-batch compaction merges the conversation in pieces, so the stored summary is the *final* answer; the
   * raw text kept here is that same answer, unnormalised. The pieces before it are already folded into it, and
   * they are not separately reconstructible from any record — which is a fact about compaction rather than about
   * this field.
   */
  let rawOutput: string | undefined;
  /**
   * How the request is *sized*, which is now the same shape as how it is sent: a constant system prompt, the tool
   * catalogue, and the messages with the running summary in front of them. The summary used to be counted as part
   * of the system prompt, and moving it cost nothing here — the same bytes are counted either way — but every
   * budget decision below has to look at the messages it actually sends.
   */
  // The catalogue does not change during one assembly, and it was serialised again for every size asked.
  const toolChars = JSON.stringify(input.tools).length;
  const size = (messages: Message[]) =>
    input.system.length + toolChars + contextMessageSize(withSummary(messages, summary));
  const charsFit = (messages: Message[]) => size(messages) <= limit;
  const forecastOf = (messages: Message[]): RequestForecast =>
    forecastRequest({
      system: input.system,
      messages: withSummary(messages, summary),
      tools: input.tools,
      maxOutputTokens: input.maxOutputTokens,
      maxContextTokens: input.maxContextTokens,
      ...(factors() ? { factors: factors()! } : { factor: messageWeight() }),
    });
  const toolResults = projectToolResults(store, sessionId, history, covered, input.runId);
  const current = toolResults.messages;
  /**
   * The policy this round compresses under, when a window is known.
   *
   * The request's own output reservation and the headroom come out of the window first — what is left is what
   * messages may use — and the threshold sits inside that. `autoCompactTokens` survives as an operator's
   * explicit threshold: it replaces the computed one rather than acting as a second, independent ceiling, so
   * there is exactly one number that says when compression starts.
   *
   * A window that cannot carry the reservation plus the headroom is reported rather than thrown: that pair is a
   * configuration mistake (a 128K window with a 256K output cap), and the honest response is to compress only
   * when the request stops fitting — loudly, in `policyProblem` — instead of failing a run the endpoint would
   * still answer. This is the trade DeepSeek Harness makes for the same condition.
   */
  let spec: ReturnType<typeof resolveCompactionSpec> | undefined;
  let policyProblem: string | undefined;
  if (input.maxContextTokens !== undefined) {
    try {
      spec = resolveCompactionSpec({
        contextWindow: input.maxContextTokens,
        reservedCompletionTokens: input.maxOutputTokens,
        ...(input.autoCompactTokens === undefined
          ? {}
          : { thresholdTokens: input.autoCompactTokens }),
      });
    } catch (error) {
      policyProblem = error instanceof Error ? error.message : String(error);
    }
  }
  /** Spread into every return, so a caller cannot get a prepared context that hides a broken policy. */
  const policyNote = {
    ...(policyProblem === undefined ? {} : { policyProblem }),
    ...(spec === undefined ? {} : { maxOverflowRetries: spec.maxOverflowRetries }),
  };
  /** The ceiling a request is measured against: the window itself, with room left to answer. */
  const compactWindow = spec?.thresholdTokens ?? input.maxContextTokens;
  const fits = (messages: Message[], forecast: RequestForecast) =>
    charsFit(messages) && forecast.problem === undefined;
  const aboveThreshold = (forecast: RequestForecast): boolean =>
    spec !== undefined && forecast.inputTokens >= spec.thresholdTokens;
  const summaryOutputBudget = () =>
    Math.min(input.maxOutputTokens, Math.max(64, Math.floor(limit / 8)));
  /**
   * The least output room a summary request must leave to be worth sending.
   *
   * Reserve up to 1024 tokens for reasoning and useful summary text before selecting a batch. A smaller
   * explicit output cap remains authoritative. This does not change the model's compaction headroom policy.
   */
  // Reserve a useful body plus reasoning allowance before choosing a batch. Respect a smaller
  // operator output cap, but never let a greedy batch squeeze a 1024-token allowance down to 77.
  const SUMMARY_MIN_OUTPUT_TOKENS = Math.min(1024, summaryOutputBudget());
  /**
   * Whether one summary batch can be sent.
   *
   * Measured as the request that will actually be made: the main system prompt, the same tool schemas in the
   * same order, the verbatim batch and the instruction — every part of the prefix the summary request replays.
   * Measuring it against a small standalone prompt would admit a batch that the real request cannot send, and
   * the real request now carries the whole tool catalogue.
   *
   * What it is measured *against* is the model's window, not the round's own ceiling. The round's output
   * reserve is the answer's budget for the request the user is waiting on; applying it here would ask a
   * summary batch to leave room for an answer nobody asked this request to give, and with the tool schemas
   * now in the request that reserve is most of a small window — no batch would ever fit one again.
   */
  const fitsSummary = (transcript: Message[]): boolean => {
    const predicted = forecastRequest({
      system: input.system,
      // The caller hands over a transcript that already carries the running summary (`summaryTranscript`).
      // Wrapping it again here priced a request nobody sends and refused batches that would have fitted.
      messages: transcript,
      tools: input.tools,
      maxOutputTokens: summaryOutputBudget(),
      maxContextTokens: input.maxContextTokens,
      ...(factors() ? { factors: factors()! } : { factor: messageWeight() }),
    });
    return predicted.problem === undefined && predicted.outputTokens >= SUMMARY_MIN_OUTPUT_TOKENS;
  };
  /** The same request against the character budget, the other ceiling a batch has to clear before it is sent. */
  const summaryCharsFit = (transcript: Message[]): boolean =>
    input.system.length + toolChars + contextMessageSize(transcript) <= limit;
  /**
   * Shorten old tool results, and say how much that bought.
   *
   * Only ever applied to a *copy*: the stored transcript keeps every character, and the session log stays the
   * one place the conversation is recorded. What the model sees is a view of it.
   */
  const shorten = (
    messages: Message[],
  ): { messages: Message[]; shortened: number; freed: number } => {
    if (!input.shrink) return { messages, shortened: 0, freed: 0 };
    const outcome = shortenMessages(
      messages,
      input.shrink.policy,
      input.shrink.spill,
      input.shrink.measure,
      toolResults.preserved,
    );
    return { messages: outcome.messages, shortened: outcome.shortened, freed: outcome.freedChars };
  };
  /**
   * Drop the middle of oversized old tool results, and say how much that bought.
   *
   * Runs after shortening rather than instead of it, because the two answer different failures: a result whose
   * full text is worth keeping somewhere is shortened, and one that is merely too long to keep reading is pruned.
   * A result shortening already replaced carries its marker and no longer has a 200,000-character middle, so the
   * second pass leaves it alone without needing to know the first ran.
   */
  const prune = (messages: Message[]): PruneOutcome => {
    if (!input.prune) return { messages, pruned: 0, prunedChars: 0 };
    assertPrunePolicy(input.prune.policy);
    return pruneMessages(
      messages,
      input.prune.policy,
      input.prune.keepRecent,
      toolResults.preserved,
    );
  };
  let forecast = forecastOf(current);
  let visible = current;
  let shortened = 0;
  let freedChars = 0;
  let pruned = 0;
  let prunedChars = 0;
  /** What the summary requests of this call cost, so a checkpoint records it instead of the cost vanishing. */
  const compactionUsage: Usage = { inputTokens: 0, outputTokens: 0 };
  /**
   * Whether this call is inside a compaction it announced, and whether it has announced how that ended.
   *
   * `compactionStarted` is what makes a failure reportable: the two refusals that happen before a summary
   * request is ever made — a tail with nothing left to compress, a window the conversation cannot fit — are
   * verdicts *about* the request rather than compactions that failed, and reporting them as failures would name
   * a compression that never began. `compactionSettled` is the other half of the pair: an announced compaction
   * ends exactly once, as a success or as a failure, and the paths that give up are reachable more than once in
   * one call (the batch loop can refuse at several points) while the hand-off to a retry has already reported
   * its own success.
   */
  let compactionStarted = false;
  let compactionSettled = false;
  const settleCompaction = (
    state: 'finished' | 'failed',
    coveredMessages?: number,
    usage?: Usage,
    reason?: string,
  ): void => {
    if (!compactionStarted || compactionSettled) return;
    compactionSettled = true;
    input.onCompaction(state, coveredMessages, usage, reason);
  };
  /**
   * The compaction did not happen: throw, or hand back the request as it stands.
   *
   * Everything this returns is the *uncompacted* view — the conversation as it would be sent without a summary —
   * and that is deliberately not a silent degradation: `compactionProblem` carries the reason, which the run
   * reports, and the endpoint is left to say whether the request really does not fit. The store is untouched on
   * every path that reaches here (the surface is written after all of this), except the convergence retry, whose
   * recursive call re-reads what the first attempt recorded and so returns a view of *that* surface.
   */
  const abandonCompaction = (failure: Error): PreparedContext => {
    /**
     * The surface this call started from, put back before anything is decided on it.
     *
     * A multi-batch compaction merges the conversation in pieces and replaces the running summary after each
     * one, so giving up after the second batch used to hand back a view built from the summary it had just
     * refused: the model was given a summary of messages that were all still in the request behind it, each of
     * them twice, while the version the session actually has was nowhere in it. Nothing is written to the store
     * on any of these paths, so the view has to describe what the store holds — the summary this call began
     * with, the tail it covers from, and a forecast recomputed for the two together (the summary is part of the
     * request, so restoring a different one is a different size).
     */
    summary = previousSummary;
    rawOutput = undefined;
    const restored = forecastOf(visible);
    settleCompaction('failed', previouslyCovered, compactionUsage, failure.message);
    /**
     * The operator's own character cap is not an estimate about the endpoint.
     *
     * `--max-context-chars` is a number somebody configured deliberately, so a request over it is refused whatever
     * the caller prefers; the token estimate is a heuristic about somebody else's window, which is the part that
     * is sent and left to the endpoint to judge.
     */
    if (!charsFit(visible) || (input.compactionFailure ?? 'throw') === 'throw') throw failure;
    return {
      system: input.system,
      messages: withSummary(visible, summary),
      forecast: restored,
      shortened,
      freedChars,
      pruned,
      prunedChars,
      compacted: false,
      compactionProblem: failure.message,
      ...policyNote,
    };
  };
  /**
   * The shared summary deadline ran out.
   *
   * Not a run cancellation, and not a compaction: a summary that took too long is exactly the failure a caller
   * that chose `compactionFailure: 'send'` wants to answer by sending the request without one. A run the caller
   * cancelled is the opposite — the request must *not* go out — so the two are separated here rather than at the
   * `AbortSignal.any` that cannot tell them apart.
   */
  const summaryDeadline = (): PreparedContext => {
    if (input.signal.aborted) throw input.signal.reason;
    return abandonCompaction(new Error('Context summary timeout; history was preserved'));
  };
  /**
   * Make the conversation smaller before deciding whether it has to be compressed.
   *
   * Shortening comes first because it is the cheaper answer to the same problem: it costs no model request, it
   * touches only text the model has already read, and it keeps the conversation's shape. Compression is what
   * remains when shortening is not enough.
   */
  /**
   * Whether the request fits as it stands, asked at most once per state of the conversation.
   *
   * The question is asked twice below — once to decide whether shortening is worth trying, once to decide whether
   * to compress — and it used to be computed twice with identical inputs. Each ask serialises every tool schema and
   * walks the conversation, so the answer is remembered here and dropped when shortening replaces either input.
   */
  let fitsAsIs: boolean | undefined;
  const fitsOnce = (): boolean => (fitsAsIs ??= fits(visible, forecast));
  if (
    input.shrink &&
    (!fitsOnce() || windowPressure(forecast, compactWindow, input.shrinkPercent ?? 100))
  ) {
    const applied = shorten(visible);
    if (applied.shortened) {
      visible = applied.messages;
      shortened += applied.shortened;
      freedChars += applied.freed;
      forecast = forecastOf(visible);
      fitsAsIs = undefined;
    }
  }
  /**
   * Drop the middle of what shortening could not help with.
   *
   * Asked under the same condition as shortening and for the same reason — this is work worth doing in good time
   * rather than under the pressure of a request that already failed its budget check — but gated on the answer
   * *after* shortening, so the two passes never both rewrite the same message and a conversation that shortening
   * already brought back under the window pays for nothing here.
   */
  if (
    input.prune &&
    (!fitsOnce() || windowPressure(forecast, compactWindow, input.prunePercent ?? 100))
  ) {
    const applied = prune(visible);
    if (applied.pruned) {
      visible = applied.messages;
      pruned += applied.pruned;
      prunedChars += applied.prunedChars;
      forecast = forecastOf(visible);
      fitsAsIs = undefined;
    }
  }
  toolResults.remember(visible);
  const fitsNow = fitsOnce();
  /**
   * Compress when the conversation reaches the threshold, when the request no longer fits, or when a person
   * asked.
   *
   * The threshold is the difference from "does it fit": it fires while the request would still be accepted, so
   * the compression happens on the side of the wall where the summary request itself still fits. Reaching the
   * window is the second trigger, not the only one — a conversation that grew past the threshold in one step
   * (a huge tool result) must be compressed even though the threshold check was never seen.
   */
  const compacting =
    input.forceCompact === true ||
    !fitsNow ||
    (aboveThreshold(forecast) && input.deferThresholdCompaction !== true);
  if (!compacting) {
    return {
      system: input.system,
      messages: withSummary(visible, summary),
      forecast,
      shortened,
      freedChars,
      pruned,
      prunedChars,
      compacted: false,
      ...policyNote,
    };
  }
  /**
   * Why the current turn cannot proceed: it does not fit the model's window, and there is nothing left to
   * compress at.
   *
   * This one message is deliberately about the request rather than about the conversation's size in general —
   * it is what the operator can act on — and it is the same verdict the run reports when the request is refused
   * before it is ever sent.
   */
  const turnFailure = () =>
    new ContextLimitError(
      'Current turn exceeds context budget; start a new session with a smaller task',
    );
  /**
   * A forced compression needs something that was already answered or executed.
   *
   * A fresh session can hold a prompt plus the runtime's machine-written announcements (the skills catalogue is
   * written as a user-role message). There is no completed turn to summarize there, but the extra user-role
   * message made the boundary scan find one and spend a summary request whose failure then displaced the
   * provider's own refusal in the reported error. The turn has nowhere to compact at, and saying so is the
   * answer the caller already expects.
   */
  if (
    input.forceCompact &&
    !history.some((message) => message.role === 'assistant' || message.role === 'tool')
  )
    return abandonCompaction(turnFailure());
  const cuts = contextBoundaries(history);
  /**
   * How much of the newest conversation stays verbatim.
   *
   * The policy's share of the message budget — or nothing at all when a person asked for a compression or an
   * overflow recovery forced one: those want the smallest conversation that can be sent, not a
   * policy-shaped one. Without a window there is no policy, and the older rule (keep from the last user turn)
   * still applies, because a run that declared no window is not measured against one.
   */
  const retainTokens = input.forceCompact ? 0 : (spec?.retainTokens ?? 0);
  /**
   * The budget is a share of a window, so it is spent in the tokens the endpoint bills rather than in the
   * estimator's own units: the tail is measured with this session's learned correction for this route
   * (`messageWeight()` — the tail is made of messages, so that is the weight it is priced with), which is what
   * keeps "16% of the message budget, verbatim" the same statement about the request the provider receives
   * whether the route's tokenizer runs heavy or light.
   */
  const retained =
    spec === undefined
      ? undefined
      : retentionStart(history, cuts, covered, retainTokens, messageWeight());
  let boundary = input.forceCompact ? (cuts.at(-1) ?? 0) : (retained ?? history.length - 1);
  if (input.forceCompact && boundary <= covered)
    return {
      system: input.system,
      messages: withSummary(visible, summary),
      forecast,
      shortened,
      freedChars,
      pruned,
      prunedChars,
      compacted: false,
      ...policyNote,
    };
  // Legacy boundary rule: without a policy the tail starts at a user turn, so the conversation keeps its shape.
  if (!input.forceCompact && retained === undefined)
    while (boundary >= covered && history[boundary]?.role !== 'user') boundary--;
  const overhead = input.system.length + toolChars;
  // Boundary selection is synchronous and precedes every summary/calibration update. Reuse a
  // boundary's view and prediction here; after summarizing, forecast the changed request anew.
  const boundaryViews = new Map<number, { messages: Message[]; forecast?: RequestForecast }>();
  const boundaryView = (cut: number) => {
    let view = boundaryViews.get(cut);
    if (!view) {
      view = { messages: toolResults.tail(cut) };
      boundaryViews.set(cut, view);
    }
    return view;
  };
  const boundaryForecast = (cut: number) => {
    const view = boundaryView(cut);
    return (view.forecast ??= forecastOf(view.messages));
  };
  if (
    boundary <= covered ||
    overhead + contextMessageSize(boundaryView(boundary).messages) > limit ||
    !fits(boundaryView(boundary).messages, boundaryForecast(boundary))
  ) {
    // A single long task can compact completed tool steps too. Keep its original
    // user request and prefer retaining the newest complete step when possible.
    // A later cut keeps a shorter tail, so "this tail fits" holds on a suffix of the candidates: the first one
    // is found by bisection rather than by measuring every tail on the way (see `./boundary-search.ts`).
    const candidates = cuts.filter((cut) => cut > covered && cut > 0);
    const first = firstHolding(
      candidates.length,
      (index) =>
        overhead + contextMessageSize(boundaryView(candidates[index]!).messages) < limit * 0.65 &&
        fits(boundaryView(candidates[index]!).messages, boundaryForecast(candidates[index]!)),
    );
    boundary = first < 0 ? -1 : candidates[first]!;
  }
  if (boundary < 1 || (boundary === history.length && history.length === 1))
    return abandonCompaction(turnFailure());
  const tail = boundaryView(boundary).messages;
  const tailForecast = boundaryForecast(boundary);
  if (!fits(tail, tailForecast)) {
    // Compression is not always the last word: a tail can still be over the ceiling while every message in it
    // is recent. Shortening what is eligible is strictly better than failing a run that has already paid for
    // this conversation.
    const applied = shorten(tail);
    if (applied.shortened) {
      shortened += applied.shortened;
      freedChars += applied.freed;
      const appliedForecast = forecastOf(applied.messages);
      if (fits(applied.messages, appliedForecast)) {
        toolResults.remember(applied.messages, tail);
        return {
          system: input.system,
          messages: withSummary(applied.messages, summary),
          forecast: appliedForecast,
          shortened,
          freedChars,
          pruned,
          prunedChars,
          compacted: false,
          ...policyNote,
        };
      }
    }
    /**
     * The same last word for a tail that shortening could not bring under — either because no result was
     * shortenworthy or because the spill that shortening needs was unavailable. Pruning asks nothing of the
     * host, so a run that already paid for this conversation gets one more chance to send it rather than
     * failing on a tail whose bulk is a middle nobody will read.
     */
    const dropped = prune(tail);
    if (dropped.pruned) {
      pruned += dropped.pruned;
      prunedChars += dropped.prunedChars;
      const droppedForecast = forecastOf(dropped.messages);
      if (fits(dropped.messages, droppedForecast)) {
        toolResults.remember(dropped.messages, tail);
        return {
          system: input.system,
          messages: withSummary(dropped.messages, summary),
          forecast: droppedForecast,
          shortened,
          freedChars,
          pruned,
          prunedChars,
          compacted: false,
          ...policyNote,
        };
      }
    }
    // The verdict is this tail's: after a compression the remaining messages are what has to fit, and saying
    // anything else would send the reader to compress a conversation that is already as small as it gets.
    return abandonCompaction(new ContextLimitError(WINDOW_EXHAUSTED));
  }
  /**
   * The compaction lock, taken before the first summary request.
   *
   * A compaction is the one write that rewrites what the model sees, so it is the one write that must not race
   * another writer: the lock is the session's own write lease (`SessionStore.claimCompaction`), taken here so
   * the run does not spend a summary request it would be refused at the write. Both halves of the rule live in
   * the store; this is only where the acquire happens.
   */
  store.claimCompaction(sessionId, input.runId);
  /**
   * Whether this invocation has handed its lock to its own retry.
   *
   * The retry re-enters `prepareContext`, and the first thing that function does — synchronously, before any
   * `await` — is take the lock again at the claim above. That happens *before* this invocation's `finally`
   * runs, because `return f()` finishes `f`'s synchronous prologue and only then processes the return; so the
   * unconditional release below used to clear the claim the retry had just made, and the retry went on to spend
   * two summary requests with no lock at all. The guarantee the lock exists for — this is the one write that
   * must not race another writer — therefore did not hold on the most expensive path. The retry releases it in
   * its own `finally`, so this one has to stay out of the way.
   */
  let handedOff = false;
  try {
    compactionStarted = true;
    input.onCompaction('started');
    // Summarize complete old user turns in bounded batches. Persist only after every
    // batch succeeds, so cancellation and errors cannot silently discard history.
    let summaryCacheKnown = true;
    const summarySignal = AbortSignal.any([
      input.signal,
      AbortSignal.timeout(input.summaryTimeoutMs),
    ]);
    let retriesLeft = 1;
    /**
     * Set after a summary answered with a tool call instead of text: the catalogue rides along only to share the
     * cache prefix, so a model that reaches for it is asked once more with tool calls forbidden.
     */
    let forbidTools = false;
    while (covered < boundary) {
      input.signal.throwIfAborted();
      let end = covered;
      let batch: Message[] = [];
      // `cuts` is ascending and unique (`contextBoundaries`), so these are every cut in range, in order. A longer
      // batch never fits where a shorter one did not, so the batch ends at the last cut of a fitting prefix, found
      // by bisection: each probe serialises one candidate batch, and a walk serialised every one of them.
      const range = cuts.filter((candidate) => candidate > covered && candidate <= boundary);
      const last = lastHolding(range.length, (index) => {
        /**
         * The batch, exactly as the main request would send it.
         *
         * No rewriting, and that is the point rather than an omission: an image replaced by a note, an opaque
         * continuation item dropped, a field forgotten — each one is a byte the summary request no longer shares
         * with the request whose cache it is trying to read, and the cache prefix ends at the first difference.
         * The summary is written from the preserved transcript, so a batch that silently loses "there was a
         * screenshot" would describe a different conversation; the instruction asks for the picture to be
         * mentioned rather than reproduced, which the verbatim batch makes possible instead of impossible.
         */
        const transcript = summaryTranscript(history.slice(covered, range[index]!), summary);
        return summaryCharsFit(transcript) && fitsSummary(transcript);
      });
      if (last >= 0) {
        end = range[last]!;
        batch = history.slice(covered, end);
      }
      if (end === covered)
        return abandonCompaction(
          new ContextLimitError(
            'An earlier turn is too large to summarize within the context budget; history was preserved',
          ),
        );
      let response: ModelResponse;
      for (;;) {
        if (summarySignal.aborted) return summaryDeadline();
        const transcript = summaryTranscript(batch, summary);
        /**
         * The prompt this summary request carries, held once.
         *
         * It is the caller's system prompt, which no longer changes between rounds or batches, and `summary` grows as
         * batches are merged so the *transcript* below has one shape per batch. Read once per batch so that the
         * estimate, the forecast, the request and the key that names it are all the same bytes, rather than a call
         * each that happen to agree today.
         */
        const summarySystem = input.system;
        const rawSummaryEstimate = estimateInputTokens(summarySystem, transcript, input.tools);
        /**
         * The summary request is a model request like any other, so it is predicted the same way: what has to fit
         * is the window, and `fitsSummary` above is what decides how much of the conversation goes into one batch.
         */
        const summaryForecast = forecastRequest({
          system: summarySystem,
          messages: transcript,
          tools: input.tools,
          maxOutputTokens: summaryOutputBudget(),
          maxContextTokens: input.maxContextTokens,
          ...(factors() ? { factors: factors()! } : { factor: messageWeight() }),
        });
        const summaryCacheKey = input.cacheKeyFor?.(summarySystem, input.tools);
        try {
          response = await input.provider.complete({
            // The main request's own prefix, replayed: same system, same tool schemas in the same order, same batch
            // bytes. Only the instruction at the end is new, which is what the cache is allowed to miss.
            system: summarySystem,
            messages: transcript,
            tools: input.tools,
            ...(summaryCacheKey === undefined ? {} : { cacheKey: summaryCacheKey }),
            ...(forbidTools ? { toolChoice: 'none' as const } : {}),
            maxOutputTokens: summaryForecast.outputTokens,
            signal: summarySignal,
            onText: () => {},
          });
        } catch (error) {
          /**
           * A summary request that failed is a compaction that did not happen, so the answer is the caller's own
           * (`compactionFailure`): throw, or hand the request back as it stands. Letting the provider's failure
           * out of here instead made the two most ordinary ways for a compression to fail — a request that was
           * refused and a request that took too long — the only two the run could not recover from. A *cancelled*
           * run is not a failed compaction: the caller asked for the work to stop, and sending the request anyway
           * because a summary could not be written would answer Stop with a request.
           */
          if (input.signal.aborted) throw error;
          /**
           * The deadline is this call's own fact, and it is named as such: an adapter that reports its
           * cancellation says only that a request was aborted, not that a summary could not be written or that
           * the conversation was kept.
           */
          if (summarySignal.aborted) return summaryDeadline();
          return abandonCompaction(error instanceof Error ? error : new Error(String(error)));
        }
        if (summarySignal.aborted) return summaryDeadline();
        compactionUsage.inputTokens += response.usage.inputTokens;
        compactionUsage.outputTokens += response.usage.outputTokens;
        if (response.usage.inputTokens > 0 && response.usage.cachedInputTokens === undefined)
          summaryCacheKnown = false;
        if (response.usage.cachedInputTokens !== undefined)
          compactionUsage.cachedInputTokens =
            (compactionUsage.cachedInputTokens ?? 0) + response.usage.cachedInputTokens;
        if (response.usage.cacheWriteInputTokens !== undefined)
          compactionUsage.cacheWriteInputTokens =
            (compactionUsage.cacheWriteInputTokens ?? 0) + response.usage.cacheWriteInputTokens;
        // Summary requests use the same model, so their reported usage calibrates the
        // estimate for the main loop as well.
        input.calibration?.observe(rawSummaryEstimate, response.usage.inputTokens);
        input.onUsage(response);
        if (response.finishReason === 'length' && retriesLeft > 0) {
          const smaller = cuts.filter((cut) => cut > covered && cut < end);
          const retryEnd = smaller
            .slice(0, Math.floor(smaller.length / 2) + 1)
            .reverse()
            .find((cut) => fitsSummary(summaryTranscript(history.slice(covered, cut), summary)));
          if (retryEnd !== undefined) {
            retriesLeft--;
            const details = {
              attempt: 1,
              fromMessages: batch.length,
              toMessages: retryEnd - covered,
              finishReason: response.finishReason,
              outputTokens: response.usage.outputTokens,
            };
            store.recordEvent(sessionId, 'context.summary.retry', {
              ...(input.runId ? { runId: input.runId } : {}),
              ...details,
            });
            input.onSummaryRetry?.(details);
            end = retryEnd;
            batch = history.slice(covered, end);
            continue;
          }
        }
        if (response.toolCalls.length && !forbidTools) {
          forbidTools = true;
          continue;
        }
        if (response.finishReason !== 'stop' || response.toolCalls.length || !response.text.trim())
          return abandonCompaction(
            new Error(
              'Context summary was incomplete (finish_reason=' +
                response.finishReason +
                ', output_tokens=' +
                response.usage.outputTokens +
                ', reasoning_tokens=' +
                (response.outputDiagnostics?.reasoningTokens ?? 'unknown') +
                ', tool_calls=' +
                response.toolCalls.length +
                '); history was preserved',
            ),
          );
        break;
      }
      const rawSummaryText = response.text;
      const merged = storedSummary(rawSummaryText);
      /**
       * The answer as it arrived, kept only when storing it changed something.
       *
       * `summary` is what the next request carries, so the two differ exactly when the wrapper above was taken
       * off — and a record that says "the model wrote this, and this is what is stored" is what a reader needs to
       * tell a normalised summary from a model that answered with something else. Absent is therefore a real
       * answer rather than a missing field: the stored summary is the model's own text, verbatim.
       */
      rawOutput = rawSummaryText === merged ? undefined : rawSummaryText;
      if (!merged)
        return abandonCompaction(
          new Error('Context summary was incomplete; history was preserved'),
        );
      summary = merged;
      if (summary.length > Math.floor(limit / 3))
        return abandonCompaction(
          new ContextLimitError(
            'Context summary is too large to stand in for the conversation; history was preserved',
          ),
        );
      covered = end;
    }
    /**
     * The price of the trade, before it is written down.
     *
     * Both sides are the same shape — the summary the model is given, plus the transcript from that cut — so
     * the comparison is between two surfaces rather than between a summary and "the rest". Compacting a
     * conversation into something that costs more is refused here, which is what keeps a degenerate summary
     * (one that restates more than it replaces) from being recorded as progress. It is checked *before* the
     * window is: a summary that made the conversation bigger and no longer fits is one defect, and naming the
     * cause is more use than naming the consequence.
     */
    const replacedChars =
      previousSummary.length + contextMessageSize(history.slice(previouslyCovered));
    const surfaceChars = summary.length + contextMessageSize(history.slice(covered));
    if (surfaceChars >= replacedChars)
      return abandonCompaction(
        new ContextLimitError(
          'Context summary did not shrink the conversation; history was preserved',
        ),
      );
    const finalForecast = forecastOf(tail);
    if (!fits(tail, finalForecast))
      return abandonCompaction(
        new ContextLimitError(
          'Summary and current turn exceed context budget; history was preserved',
        ),
      );
    store.applyCompaction(sessionId, {
      coveredMessages: covered,
      summary,
      usage: compactionUsage,
      cacheKnown: summaryCacheKnown,
      replacedChars,
      surfaceChars,
      ...(input.runId === undefined ? {} : { runId: input.runId }),
      // The envelope this summary ran under: which protocol and model answered, and the output budget the policy
      // allows a summary in this window. The prompt and catalogue it replayed are in the round's own
      // `context.envelope`, and `rawOutput` is present only when storing the answer changed it.
      ...(input.protocol === undefined ? {} : { protocol: input.protocol }),
      ...(input.model === undefined ? {} : { model: input.model }),
      maxTokens: summaryOutputBudget(),
      ...(rawOutput === undefined ? {} : { rawOutput }),
    });
    settleCompaction('finished', covered, compactionUsage);
    /**
     * Compress again when the conversation is still above the threshold and the policy allows another attempt.
     *
     * This is the convergence half: one compression whose retained tail is itself half the conversation leaves
     * the next round exactly where this one was, and paying for a second compression is cheaper than paying for a
     * window overflow on the round that follows. The re-entry re-reads the surface it just recorded, so the
     * second attempt compacts what is actually left rather than a remembered copy of it. A forced compression
     * (a person's `/compact`, an overflow recovery) never re-enters: it is already the most aggressive shape.
     *
     * The lock is released before the re-entry, which takes it again for its own summary: a lock held across
     * the recursive call would make the second attempt refuse itself. The `finally` below must then leave that
     * second claim alone — it is the retry's for the whole of its summary, and `handedOff` is what says so. The
     * comment here used to call the second release "a no-op by construction, because only the run that holds the
     * lock can release it": the release does match, because it is the *same* run, which is exactly the problem.
     */
    const attempt = input.compactionAttempt ?? 0;
    if (
      spec !== undefined &&
      input.forceCompact !== true &&
      finalForecast.inputTokens >= spec.thresholdTokens &&
      attempt < spec.compactionRetries
    ) {
      handedOff = true;
      store.releaseCompaction(sessionId, input.runId);
      return prepareContext({ ...input, compactionAttempt: attempt + 1 });
    }
    return {
      system: input.system,
      messages: withSummary(tail, summary),
      forecast: finalForecast,
      shortened,
      freedChars,
      pruned,
      prunedChars,
      compacted: true,
      ...policyNote,
    };
  } finally {
    /**
     * The lock is released on every exit, including the ones that throw: a run that gave up on a summary must
     * not leave the session looking like a compaction is still in flight, because the next attempt would then
     * be refused on its behalf. The one exit that does not release is the hand-off to a retry, whose own claim
     * this invocation would otherwise clear (`handedOff`).
     */
    if (!handedOff) store.releaseCompaction(sessionId, input.runId);
  }
}
