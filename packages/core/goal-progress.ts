import { createHash } from 'node:crypto';

/**
 * Whether a tool result taught the goal loop anything new, so a round that repeats itself stops the
 * loop.
 *
 * - A query is new only if the workspace may have changed since it was last asked (the workspace
 *   version moves whenever a result reports a file change).
 * - Anything else is new when its output differs after masking durations and timestamps.
 * - A result that changed a file is always progress.
 */
const QUERY_TOOLS = new Set([
  'read_file',
  'list_files',
  'search_files',
  'repo_map',
  'git_status',
  'git_diff',
  'git_log',
]);
const NOISE = [
  // ISO-8601 timestamps, with or without a zone.
  /\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?/g,
  // Durations: "12ms", "1.5 s", "3.2s".
  /\b\d+(?:\.\d+)?\s?(?:ms|s|sec|seconds)\b/g,
];
export function normalizedOutput(content: unknown): string {
  let text = typeof content === 'string' ? content : JSON.stringify(content ?? null);
  for (const pattern of NOISE) text = text.replace(pattern, '#');
  return text;
}
export class RoundEvidence {
  private seen = new Set<string>();
  private workspaceVersion = 0;
  /** Records one result and answers whether it is progress. */
  observe(
    name: string,
    args: unknown,
    result: { isError?: unknown; content?: unknown; change?: unknown },
  ): boolean {
    if (result.change) {
      this.workspaceVersion++;
      return true;
    }
    const key = createHash('sha256')
      .update(
        JSON.stringify(
          QUERY_TOOLS.has(name)
            ? ['query', name, args, this.workspaceVersion]
            : ['call', name, args, result.isError === true, normalizedOutput(result.content)],
        ),
      )
      .digest('hex');
    if (this.seen.has(key)) return false;
    this.seen.add(key);
    return true;
  }
}
