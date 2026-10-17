import { createHash } from 'node:crypto';
import type { ToolCall, ToolResult } from '../protocol/index.ts';

export interface ToolObservation {
  call: ToolCall;
  result: ToolResult & { additionalContext?: readonly string[] };
  /** Set only for a successful program whose actual inner tools are observed in the same batch. */
  kind?: 'program-output';
}
export type ToolProgress = 'continue' | 'warn' | 'repeat-failure' | 'conclude';
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
  private seen = new Map<string, string>();
  private repeatedRounds = 0;
  /** Identical failures by call and output, across edits; cleared only when a person or policy intervenes. */
  private failures = new Map<string, number>();
  reset(): void {
    this.resetQueries();
    this.failures.clear();
  }
  private resetQueries(): void {
    this.seen.clear();
    this.repeatedRounds = 0;
  }
  observeRound(observations: readonly ToolObservation[]): ToolProgress {
    const failing = this.observeFailures(observations);
    const queries = this.observeQueries(observations);
    if (failing >= FAILURE_CONCLUDE || queries === 'conclude') return 'conclude';
    if (queries === 'warn') return 'warn';
    return failing === FAILURE_WARN ? 'repeat-failure' : 'continue';
  }
  /** The highest count any identical failure in this round has reached. */
  private observeFailures(observations: readonly ToolObservation[]): number {
    let highest = 0;
    for (const { call, result } of observations) {
      if (!result.isError) continue;
      const key = digest([call.name, call.arguments, result.content, result.output]);
      const count = (this.failures.get(key) ?? 0) + 1;
      this.failures.delete(key);
      this.failures.set(key, count);
      while (this.failures.size > 256) this.failures.delete(this.failures.keys().next().value!);
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
    (action === 'warn'
      ? 'Repeated queries with identical arguments returned unchanged results. Do not repeat those queries. Answer the question from the evidence already collected, or make one materially different, narrowly scoped check if a specific missing fact requires it.'
      : action === 'repeat-failure'
        ? 'The same call has now failed with identical output several times, including after changes in between. Repeating the same approach is not converging. Step back: re-read the failure, question the assumption behind the last changes, and try a materially different approach — or stop and report what blocks you.'
        : 'Further repeated tool calls produced no new information. This next request is for a conclusion only; no tools are available. Answer from existing evidence, distinguish confirmed facts from uncertainty, and state any unfinished work or missing information. Do not claim an unverified fix or completed task.') +
    '\n</runtime-context>'
  );
}
