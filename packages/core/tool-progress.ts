import { createHash } from 'node:crypto';
import type { ToolCall, ToolResult } from '../protocol/index.ts';
import { environmentBlockedCode } from '../tools/environment-blocked.ts';
import { projectChangedPaths } from './work-evidence.ts';

export interface ToolObservation {
  call: ToolCall;
  result: ToolResult & { additionalContext?: readonly string[] };
  /** Set only for a successful program whose actual inner tools are observed in the same batch. */
  kind?: 'program-output';
}
export type ToolProgress =
  | 'continue'
  | 'warn'
  | 'repeat-failure'
  | 'environment-blocked'
  | 'conclude'
  | 'investigation-warn'
  | 'investigation-conclude';
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
const queries = new Set(['read_file', 'list_files', 'search_files', 'git_status', 'git_diff']);
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
  private options: { now?: () => number; investigate?: () => boolean; workspace?: string };
  constructor(
    options: { now?: () => number; investigate?: () => boolean; workspace?: string } = {},
  ) {
    this.options = options;
    this.investigationStarted = (options.now ?? Date.now)();
  }
  private seen = new Map<string, string>();
  private repeatedRounds = 0;
  /** Identical failures by call and output, across edits; cleared only when a person or policy intervenes. */
  private failures = new Map<string, number>();
  /** Refusals per environment blocker, cleared with `failures`: a person acting is what may have changed it. */
  private blocked = new Map<string, number>();
  reset(): void {
    this.resetQueries();
    this.failures.clear();
    this.blocked.clear();
    this.investigationRounds = 0;
    this.investigationStarted = (this.options.now ?? Date.now)();
    this.investigationWarned = false;
  }
  private resetQueries(): void {
    this.seen.clear();
    this.repeatedRounds = 0;
  }
  observeRound(observations: readonly ToolObservation[]): ToolProgress {
    const failing = this.observeFailures(observations);
    const blocked = this.observeBlocked(observations);
    const queries = this.observeQueries(observations);
    if (failing >= FAILURE_CONCLUDE || blocked >= BLOCKED_CONCLUDE || queries === 'conclude')
      return 'conclude';
    const investigation = this.observeInvestigation(observations);
    if (investigation) return investigation;
    if (blocked === BLOCKED_WARN) return 'environment-blocked';
    if (queries === 'warn') return 'warn';
    return failing === FAILURE_WARN ? 'repeat-failure' : 'continue';
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
    if (
      !observations.length ||
      observations.every(({ call }) =>
        ['job_output', 'wait_job', 'collect_command'].includes(call.name),
      )
    )
      return;
    this.investigationRounds++;
    const elapsed = (this.options.now ?? Date.now)() - this.investigationStarted;
    if (this.investigationRounds >= 20 || elapsed >= 120_000) return 'investigation-conclude';
    if (!this.investigationWarned && (this.investigationRounds >= 12 || elapsed >= 60_000)) {
      this.investigationWarned = true;
      return 'investigation-warn';
    }
  }
  /** The highest count any identical failure in this round has reached. */
  private observeFailures(observations: readonly ToolObservation[]): number {
    let highest = 0;
    for (const { call, result } of observations) {
      if (!result.isError || environmentBlockedCode(result.content)) continue;
      const key = digest([call.name, call.arguments, result.content, result.output]);
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
            queries.has(call.name) ||
            (call.name === 'run_code' && kind === 'program-output' && !result.isError)
          ) ||
          result.change ||
          result.images?.length ||
          result.additionalContext?.length,
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
              : 'Further repeated tool calls produced no new information. This next request is for a conclusion only; no tools are available. Answer from existing evidence, distinguish confirmed facts from uncertainty, and state any unfinished work or missing information. Do not claim an unverified fix or completed task.') +
    '\n</runtime-context>'
  );
}
