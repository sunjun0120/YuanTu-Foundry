import { createHash } from 'node:crypto';
import type { ToolCall, ToolResult } from '../protocol/index.ts';
import { environmentBlockedCode } from '../protocol/environment-blocked.ts';
import type { FileStateDigest } from '../tools/file-state-digest.ts';
import { projectChangedPaths } from './completion/work-evidence.ts';
import { classifyTool } from '../tools/tool-categories.ts';

export interface ToolObservation {
  call: ToolCall;
  result: ToolResult & { additionalContext?: readonly string[] };
  /** Set only for a successful program whose actual inner tools are observed in the same batch. */
  kind?: 'program-output';
  /**
   * What a successful write did to each file, as hashes (`file-state-digest.ts`).
   *
   * Taken at the write boundary, where both sides of the bytes still exist. It is internal run evidence: the
   * observation it rides on is not stored or sent anywhere, and `RunToolBatch` keeps it off the tool result.
   */
  fileStates?: readonly FileStateDigest[];
}
export type ToolProgress =
  | 'continue'
  | 'warn'
  | 'repeat-failure'
  | 'environment-blocked'
  | 'conclude'
  | 'investigation-warn'
  | 'investigation-conclude'
  | 'act-final'
  | 'act-conclude'
  | 'edit-oscillation-warn'
  | 'edit-oscillation-warn-final';
/** One write that undid an earlier one, as the guard counted it. */
export interface EditOscillation {
  count: number;
  /** `full` when the whole file returned to a state it already had; `local` when only a block did. */
  signal: 'full' | 'local';
}
/**
 * How often one call may fail the same way before the run is told so, and before it is stopped.
 *
 * The query check above only sees rounds made entirely of reads, and any edit resets it — which is exactly the
 * shape of the loop it could not see: edit, run the same test, get the same failure, edit again. A failure is the
 * same when the call (name and arguments) and its output are byte-identical, so a test whose failure changes is
 * progress however many times it runs.
 */
const FAILURE_WARN = 3;
const FAILURE_CONCLUDE = 5;
/**
 * The same counts for a refusal by one environment blocker (`EnvironmentBlockedError`), whatever the call was.
 *
 * Lower, and keyed by the blocker rather than the call, because a blocker refuses `npm test` and `node --test` alike:
 * counting per call would let the model walk through every variant of a command before anything noticed, and no
 * variant can succeed until a person changes the machine.
 */
const BLOCKED_WARN = 2;
const BLOCKED_CONCLUDE = 3;
/**
 * How many writes that undo an earlier one before the run is told, and how many before it is told again.
 *
 * Two levels rather than a hard stop, because the official result says the oscillation is a cost problem and
 * not a correctness one: three of the four samples that oscillated still ended `resolved`, and the state each
 * was in when a threshold would have fired was *not* the state its final patch came from. So the guard only
 * ever injects a prompt; the run budget stays the thing that stops a run that ignores it.
 */
const OSCILLATION_WARN = 2;
const OSCILLATION_FINAL = 4;
/** Bounds on what the guard remembers about writes, so a very long run cannot grow it without limit. */
const OSCILLATION_MAX_PATHS = 512;
const OSCILLATION_MAX_HUNKS = 4_096;
/**
 * The investigation allowance's two round thresholds, and the clock default used when a caller passes none.
 *
 * The round count was not changed by the measurement that moved the clock: it is the rounds that are hard to
 * bound honestly, and 12/20 was never the branch that fired (`RunDefaults.investigationMs`).
 */
const INVESTIGATION_WARN_ROUNDS = 12;
const INVESTIGATION_CONCLUDE_ROUNDS = 20;
const INVESTIGATION_DEFAULT_MS = 240_000;
/**
 * Calls that only read, so a round of them repeating unchanged is a model asking the same question again.
 *
 * Any tool that is not a query resets the comparison, which is why every read a model reaches for while
 * investigating has to be one: one `web_search` in a round of repeated reads used to hide the repetition entirely,
 * back when this was a list of its own. Which tools are queries is now the tool classification's answer
 * (`Tool.query`, `tools/tool-categories.ts`); `job_output` is not one on purpose — polling a running job is
 * supposed to return the same thing until it moves.
 */
const productQuery = (name: string): boolean => classifyTool({ name }).query;
/** Calls that collect a job already running: waiting on one is not a new investigation round. */
const collections = new Set(['job_list', 'job_output']);
/** Fields of a structured result that differ on every run of the same call, and so say nothing about it. */
const volatileFields = new Set(['durationMs', 'elapsedMs', 'startedAt', 'finishedAt']);
/**
 * A failure's text with the parts that change on every run masked out.
 *
 * Test runners print how long they took, and a command result carries its own duration, so two runs of the same
 * test that fail the same way were never byte-identical — the repeated-failure check could not fire for the
 * loop it exists for. Durations and timestamps are masked; everything else, the assertion included, still has to
 * match.
 */
const stableFailureText = (value: string): string =>
  value
    .replace(/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?/g, '<time>')
    .replace(/\b(duration(?:_ms)?|elapsed|time)([:=\s]+)\d+(?:\.\d+)?/gi, '$1$2<n>')
    .replace(/\b\d+(?:\.\d+)?\s?(?:ms|s|sec|secs|seconds|µs|μs|ns)\b/g, '<duration>');
const stableFailureOutput = (value: unknown): unknown =>
  value === undefined
    ? undefined
    : stableFailureText(
        JSON.stringify(value, (key, item) => (volatileFields.has(key) ? undefined : item)),
      );
const normalizedPath = (value: string): string => value.replaceAll('\\', '/').replace(/^\.\//, '');
const digest = (value: unknown): string =>
  createHash('sha256')
    .update(
      JSON.stringify(value, (_key, item) =>
        item && typeof item === 'object' && !Array.isArray(item)
          ? Object.fromEntries(
              Object.keys(item)
                .sort()
                .map((key) => [key, item[key]]),
            )
          : item,
      ),
    )
    .digest('hex');

/** Per-run query evidence only. Effects, polling, and unknown tools invalidate the comparison. */
export class ToolProgressGuard {
  private investigationRounds = 0;
  private investigationStarted: number;
  private investigationWarned = false;
  private options: {
    now?: () => number;
    investigate?: () => boolean;
    workspace?: string;
    /** Model time the investigation may take; the nudge fires at half of it. */
    investigationMs?: number;
    /**
     * Whether a tool is a query. The run passes its registry's answer, so a tool that classifies itself
     * (`Tool.query`) is counted too; without it the product table decides.
     */
    isQuery?: (name: string) => boolean;
  };
  /** The configured allowance, never below a second: a zero here would withdraw the tools immediately. */
  private investigationMs: number;
  constructor(
    options: {
      now?: () => number;
      investigate?: () => boolean;
      workspace?: string;
      investigationMs?: number;
      isQuery?: (name: string) => boolean;
    } = {},
  ) {
    this.options = options;
    this.investigationMs = Math.max(1_000, options.investigationMs ?? INVESTIGATION_DEFAULT_MS);
    this.investigationStarted = (options.now ?? Date.now)();
  }
  private seen = new Map<string, string>();
  private repeatedRounds = 0;
  /** Identical failures by call and output, across edits; cleared only when a person or policy intervenes. */
  private failures = new Map<string, number>();
  /** Refusals per environment blocker, cleared with `failures`: a person acting is what may have changed it. */
  private blocked = new Map<string, number>();
  /**
   * The whole-file states each path has been in, and every changed block a write has produced, by digest.
   *
   * Deliberately *not* cleared by `reset()`. The other counters are cleared whenever new evidence arrives,
   * because a new round of queries or a fresh failure may be progress; this one is the state that says the
   * model is going in circles, and a successful edit in between is exactly what it must survive. Only an
   * intervention that could plausibly change the plan clears it (`resetOscillation`).
   */
  private fileStates = new Map<string, Set<string>>();
  private reverseHunks = new Set<string>();
  private oscillationWrites = 0;
  private oscillationPrompted: 0 | 1 | 2 = 0;
  private oscillationEvents: EditOscillation[] = [];
  /** Notes policies have already injected in this run, by digest (`newIntervention`). */
  private interventions = new Set<string>();
  reset(): void {
    this.resetQueries();
    this.failures.clear();
    this.blocked.clear();
    this.investigationRounds = 0;
    this.investigationStarted = (this.options.now ?? Date.now)();
    this.investigationWarned = false;
  }
  /**
   * Whether context a policy injected after a round is something the run has not been told before.
   *
   * A policy speaking is an intervention, and an intervention clears the counters. But a post-execute hook that
   * attaches the same note to every round is not a new one each time: treating it as such reset the failure and
   * query counts every round, so a run with such a hook could repeat itself until its budget ran out.
   */
  newIntervention(notes: readonly string[]): boolean {
    let fresh = false;
    for (const note of notes) {
      const key = digest(note);
      if (this.interventions.has(key)) continue;
      fresh = true;
      this.interventions.add(key);
      while (this.interventions.size > 256)
        this.interventions.delete(this.interventions.values().next().value!);
    }
    return fresh;
  }
  /** What a person or a policy speaking resets: the oscillation evidence, and only that. */
  resetOscillation(): void {
    this.fileStates.clear();
    this.reverseHunks.clear();
    this.oscillationWrites = 0;
    this.oscillationPrompted = 0;
    this.oscillationEvents = [];
  }
  /** The hits counted so far and not yet read, for the run to record as events. */
  takeOscillationEvents(): EditOscillation[] {
    const events = this.oscillationEvents;
    this.oscillationEvents = [];
    return events;
  }
  private resetQueries(): void {
    this.seen.clear();
    this.repeatedRounds = 0;
  }
  observeRound(observations: readonly ToolObservation[]): ToolProgress {
    const failing = this.observeFailures(observations);
    const blocked = this.observeBlocked(observations);
    const queries = this.observeQueries(observations);
    // Counted before the early return below: a hit is recorded as an event even in a round whose own notice is
    // the conclusion, because the log is what a later review reads the cost of the run from.
    this.recordOscillation(observations);
    if (failing >= FAILURE_CONCLUDE || blocked >= BLOCKED_CONCLUDE || queries === 'conclude')
      return 'conclude';
    const investigation = this.observeInvestigation(observations);
    if (investigation) return investigation;
    if (blocked === BLOCKED_WARN) return 'environment-blocked';
    // Before the query and failure notices: those two re-arm themselves on the next round, while each level of
    // the oscillation notice is said once and would otherwise be dropped for good by a round that happened to
    // end in a repeated query.
    const oscillation = this.oscillationNotice();
    if (oscillation) return oscillation;
    if (queries === 'warn') return 'warn';
    return failing === FAILURE_WARN ? 'repeat-failure' : 'continue';
  }
  /** New context resets query counters, but does not erase the writes that just happened. */
  observeWrites(observations: readonly ToolObservation[]): ToolProgress {
    this.recordOscillation(observations);
    return this.oscillationNotice() ?? 'continue';
  }
  /**
   * Counts each write that undid an earlier one, recording one hit per write.
   *
   * Two signals, either one enough, because a whole-file comparison alone misses the shape that actually
   * appeared in the sample: the model alternated edits across several places in one file and never repeated
   * the complete file. One write counts once however many of its blocks reversed — it is one decision to go
   * back.
   */
  private recordOscillation(observations: readonly ToolObservation[]): void {
    for (const { result, fileStates } of observations) {
      if (result.isError || !fileStates?.length) continue;
      const projectPaths = new Set(
        result.change
          ? projectChangedPaths(result.change, this.options.workspace).map(normalizedPath)
          : [],
      );
      let signal: EditOscillation['signal'] | undefined;
      const newHunks: string[] = [];
      for (const file of fileStates) {
        if (!projectPaths.has(normalizedPath(file.path))) continue;
        // A write that changes nothing says nothing about the plan, and must not become a state either: a
        // reported "written" with identical bytes is not evidence the model went anywhere.
        const before = file.before ?? '';
        const after = file.after ?? '';
        if (before === after) continue;
        let states = this.fileStates.get(file.path);
        if (!states) {
          // The state the file was in before the first write this guard saw: a later return to it is a revert
          // even though this run never wrote that state.
          states = new Set([before]);
          this.fileStates.set(file.path, states);
          while (this.fileStates.size > OSCILLATION_MAX_PATHS)
            this.fileStates.delete(this.fileStates.keys().next().value!);
        } else if (states.has(after)) signal = 'full';
        states.add(after);
        for (const hunk of file.hunks) {
          const reverse = digest([file.path, hunk.added, hunk.deleted]);
          if (this.reverseHunks.has(reverse) && signal === undefined) signal = 'local';
          newHunks.push(digest([file.path, hunk.deleted, hunk.added]));
        }
      }
      // Only earlier writes are evidence of a reversal, never another hunk of this write.
      for (const hunk of newHunks) this.reverseHunks.add(hunk);
      while (this.reverseHunks.size > OSCILLATION_MAX_HUNKS)
        this.reverseHunks.delete(this.reverseHunks.values().next().value!);
      if (!signal) continue;
      this.oscillationWrites++;
      this.oscillationEvents.push({ count: this.oscillationWrites, signal });
    }
  }
  /** The next level of the oscillation notice this run has earned, marking it said so it is said once. */
  private oscillationNotice(): ToolProgress | undefined {
    if (this.oscillationPrompted < 2 && this.oscillationWrites >= OSCILLATION_FINAL) {
      this.oscillationPrompted = 2;
      return 'edit-oscillation-warn-final';
    }
    if (this.oscillationPrompted < 1 && this.oscillationWrites >= OSCILLATION_WARN) {
      this.oscillationPrompted = 1;
      return 'edit-oscillation-warn';
    }
    return undefined;
  }
  private observeInvestigation(observations: readonly ToolObservation[]): ToolProgress | undefined {
    if (
      this.options.investigate?.() === false ||
      observations.some(
        ({ result }) =>
          result.change && projectChangedPaths(result.change, this.options.workspace).length > 0,
      )
    ) {
      this.investigationRounds = 0;
      this.investigationStarted = (this.options.now ?? Date.now)();
      this.investigationWarned = false;
      return;
    }
    // Collecting an already-running job is not a new investigation round.
    if (!observations.length || observations.every(({ call }) => collections.has(call.name)))
      return;
    this.investigationRounds++;
    const elapsed = (this.options.now ?? Date.now)() - this.investigationStarted;
    if (
      this.investigationRounds >= INVESTIGATION_CONCLUDE_ROUNDS ||
      elapsed >= this.investigationMs
    )
      return 'investigation-conclude';
    if (
      !this.investigationWarned &&
      (this.investigationRounds >= INVESTIGATION_WARN_ROUNDS || elapsed >= this.investigationMs / 2)
    ) {
      this.investigationWarned = true;
      return 'investigation-warn';
    }
  }
  /** The highest count any identical failure in this round has reached. */
  private observeFailures(observations: readonly ToolObservation[]): number {
    let highest = 0;
    for (const { call, result } of observations) {
      if (!result.isError || environmentBlockedCode(result.content)) continue;
      const key = digest([
        call.name,
        call.arguments,
        stableFailureText(result.content),
        stableFailureOutput(result.output),
      ]);
      const count = (this.failures.get(key) ?? 0) + 1;
      this.failures.delete(key);
      this.failures.set(key, count);
      while (this.failures.size > 256) this.failures.delete(this.failures.keys().next().value!);
      highest = Math.max(highest, count);
    }
    return highest;
  }
  /** The highest count any environment blocker has reached, counting each blocker once per round. */
  private observeBlocked(observations: readonly ToolObservation[]): number {
    const codes = new Set<string>();
    for (const { result } of observations) {
      const code = result.isError ? environmentBlockedCode(result.content) : undefined;
      if (code) codes.add(code);
    }
    let highest = 0;
    for (const code of codes) {
      const count = (this.blocked.get(code) ?? 0) + 1;
      this.blocked.set(code, count);
      highest = Math.max(highest, count);
    }
    return highest;
  }
  private observeQueries(observations: readonly ToolObservation[]): ToolProgress {
    if (
      !observations.length ||
      observations.some(
        ({ call, result, kind }) =>
          !(
            (this.options.isQuery ?? productQuery)(call.name) ||
            (call.name === 'run_code' && kind === 'program-output' && !result.isError)
          ) ||
          result.change ||
          result.images?.length ||
          // Policy context is new evidence only the first time it is said; a repeat of it is not (see
          // `newIntervention`), and the run resets this comparison itself when it is new.
          (result.additionalContext?.length &&
            result.additionalContext.some((note) => !this.interventions.has(digest(note)))),
      )
    ) {
      this.resetQueries();
      return 'continue';
    }
    let changed = false;
    for (const { call, result, kind } of observations) {
      // The program's value and console output are evidence too; its elapsed-time footer is not.
      const content =
        kind === 'program-output'
          ? result.content.replace(/\n\n\[tools\] \d+ call\(s\) in \d+ms: [^\n]*$/, '')
          : result.content;
      const value = digest([result.isError, content, result.output]);
      const key =
        kind === 'program-output'
          ? digest(['program-output', value])
          : digest([call.name, call.arguments]);
      if (this.seen.get(key) !== value) changed = true;
      this.seen.delete(key);
      this.seen.set(key, value);
      while (this.seen.size > 256) this.seen.delete(this.seen.keys().next().value!);
    }
    this.repeatedRounds = changed ? 0 : this.repeatedRounds + 1;
    return this.repeatedRounds >= 3 ? 'conclude' : this.repeatedRounds === 2 ? 'warn' : 'continue';
  }
}

export function toolProgressNotice(action: Exclude<ToolProgress, 'continue'>): string {
  return (
    '<runtime-context source="tool-progress">\n' +
    (action === 'investigation-warn'
      ? 'This investigation has used its initial time or tool-round allowance. Stop widening the search. Answer from the evidence already collected, or make only the essential remaining check. State uncertainty instead of auditing unrelated subsystems. Diagnostic scratch scripts do not require project verification checks.'
      : action === 'investigation-conclude'
        ? 'The investigation reached its time or tool-round allowance. Searching and other investigation tools are no longer available. Edit only a specific location supported by the collected evidence; do not reconstruct code from memory. If exact source is needed, use read_file with an explicit line range to read only the lines you intend to change, then edit immediately. Otherwise answer from the evidence already collected and name any uncertainty. Do not claim unfinished work is complete.'
        : action === 'warn'
          ? 'Repeated queries with identical arguments returned unchanged results. Do not repeat those queries. Answer the question from the evidence already collected, or make one materially different, narrowly scoped check if a specific missing fact requires it.'
          : action === 'repeat-failure'
            ? 'The same call has now failed with identical output several times, including after changes in between. Repeating the same approach is not converging. Step back: re-read the failure, question the assumption behind the last changes, and try a materially different approach — or stop and report what blocks you.'
            : action === 'environment-blocked'
              ? 'The same environment blocker has now refused more than one call (the "Environment blocked" results above). No call that needs it can succeed until a person changes the environment, so do not call such tools again in this run. Finish only what does not need it, then tell the user what is blocked, the remedy the result names, and what remains unverified.'
              : action === 'edit-oscillation-warn'
                ? 'You are undoing edits you made earlier in this run. Pick the version the evidence supports best, keep only that one, and stop switching between implementations. If the evidence does not settle the difference between them, state what is uncertain and finish instead of rewriting the same code again.'
                : action === 'edit-oscillation-warn-final'
                  ? 'Going back and forth over the same code has stopped producing new evidence. Choose the version best supported by what you have already read, say plainly what remains uncertain, and end the work. Do not rewrite that region again.'
                  : action === 'act-final'
                    ? 'The rounds allowed after the investigation cutoff are used up and the project is still unchanged. This is the last round with tools: only the file editors remain. Make the edit now, using the exact source you have already read, or answer without tools and say what is unfinished.'
                    : action === 'act-conclude'
                      ? 'The rounds allowed after the investigation cutoff are used up. This next request is for a conclusion only; no tools are available. Answer from existing evidence, distinguish confirmed facts from uncertainty, and state any unfinished work or missing information. Do not claim an unverified fix or completed task.'
                      : 'Further repeated tool calls produced no new information. This next request is for a conclusion only; no tools are available. Answer from existing evidence, distinguish confirmed facts from uncertainty, and state any unfinished work or missing information. Do not claim an unverified fix or completed task.') +
    '\n</runtime-context>'
  );
}
