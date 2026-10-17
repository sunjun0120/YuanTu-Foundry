import { createHash } from 'node:crypto';
import type { ToolCall, ToolResult } from '../protocol/index.ts';

export interface ToolObservation {
  call: ToolCall;
  result: ToolResult & { additionalContext?: readonly string[] };
  /** Set only for a successful program whose actual inner tools are observed in the same batch. */
  kind?: 'program-output';
}
export type ToolProgress = 'continue' | 'warn' | 'conclude';
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
  reset(): void {
    this.seen.clear();
    this.repeatedRounds = 0;
  }
  observeRound(observations: readonly ToolObservation[]): ToolProgress {
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
      this.reset();
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
      : 'Further repeated queries produced no new information. This next request is for a conclusion only; no tools are available. Answer from existing evidence, distinguish confirmed facts from uncertainty, and state any unfinished work or missing information. Do not claim an unverified fix or completed task.') +
    '\n</runtime-context>'
  );
}
