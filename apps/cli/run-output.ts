import type { AgentEvent, RunResult, TodoItem, Usage } from '../../packages/protocol/index.ts';
import { describeTodoChange, todoDiff } from '../../packages/protocol/todos.ts';
import type { Options } from '../shared/args.ts';
import { display } from '../shared/runtime.ts';

/**
 * How much *substantive* tool work the run in flight has done.
 *
 * The goal loop uses it to decide whether another automatic round is worth starting: a round that only
 * narrated, or only rewrote its own checklist and goal, has not moved the work, and continuing would spend a
 * model request per round to produce nothing. Recording state is not doing work, so `todo`-style, goal
 * lifecycle and completion progress/scope tools are excluded from the count deliberately.
 */
const NON_SUBSTANTIVE_TOOLS = new Set([
  'todo_write',
  'create_goal',
  'update_goal',
  'task_step',
  'completion_step',
  'completion_scope',
]);

/** What the event printer remembers between events, and what the run loop reads back from it. */
export interface RunProgress {
  substantiveToolCalls: number;
  /**
   * The plan as the last `todo_write` left it, so a plan change can be described rather than only listed.
   *
   * Seeded from the session's own log when this invocation resumes one, because "changed" is a statement
   * about two versions: a second `--session` run that starts from an empty list would report the whole plan
   * as newly added.
   */
  previousPlan: TodoItem[];
}

/** The run's event sink: JSONL on stdout with `--json`, otherwise the answer on stdout and progress on stderr. */
export function createEventPrinter(
  options: Options,
  progress: RunProgress,
): (event: AgentEvent) => void {
  return (event) => {
    if (options.json) process.stdout.write(JSON.stringify({ type: 'event', event }) + '\n');
    else if (event.type === 'message.delta') process.stdout.write(display(String(event.data.text)));
    else if (event.type === 'tool.started') {
      const toolName = (event.data.call as { name: string }).name;
      if (!NON_SUBSTANTIVE_TOOLS.has(toolName)) progress.substantiveToolCalls += 1;
      process.stderr.write(`\n[tool] ${display(toolName)}\n`);
    } else if (event.type === 'tool.finished' && event.data.isError)
      process.stderr.write(`[tool error] ${display(String(event.data.content))}\n`);
    else if (event.type === 'tool.finished' && Array.isArray(event.data.images))
      // A terminal cannot show the picture, but the person should know one was taken and looked at —
      // otherwise the answer's basis is invisible in a CLI session.
      process.stderr.write(
        `[tool image] ${(event.data.images as { name?: string }[]).map((image) => display(image.name ?? 'image')).join(', ')}\n`,
      );
    // Sub-agents run inside one parent run, so their progress is reported on stderr instead of
    // interleaving with the parent's streamed answer on stdout.
    else if (event.type === 'subagent.started')
      process.stderr.write(
        `\n[subagent ${Number(event.data.index) + 1}/${Number(event.data.total)}] ${display(String(event.data.role))}: ${display(String(event.data.objective))}\n`,
      );
    else if (event.type === 'subagent.finished' && event.data.status !== 'completed')
      process.stderr.write(
        `[subagent] ${display(String(event.data.status))}${event.data.error ? ': ' + display(String(event.data.error)) : ''}\n`,
      );
    else if (event.type === 'llm.request')
      // Only written when a round's model or effort *changes*, so this line is an event, not chatter: it
      // says which round stopped running on the model the operator configured.
      process.stderr.write(
        `[model] round ${Number(event.data.round) + 1}: ${display(String(event.data.model))}${event.data.reasoningEffort ? ` (effort ${display(String(event.data.reasoningEffort))})` : ''}\n`,
      );
    else if (event.type === 'llm.retry')
      // A retry is a wait with no visible progress, so the progress line says what it is waiting for and
      // how long — otherwise a run sitting out a 429 cooldown just looks stuck.
      process.stderr.write(
        `[retry] ${display(String(event.data.code))}, re-sending in ${Math.round(Number(event.data.waitMs))}ms (attempt ${Number(event.data.attempt)} of ${Number(event.data.max)})\n`,
      );
    else if (event.type === 'context.forecast') printForecast(event);
    // The checklist goes to stderr with the rest of the progress: it is state the user watches, not
    // part of the answer, and stdout stays clean for a caller that pipes the reply. The change line
    // comes first, because the list below it is the *result* of that change.
    else if (event.type === 'todo.written') {
      const todos = (event.data.todos ?? []) as TodoItem[];
      // Derived here rather than read off the event: consecutive `todo.written` events are the two
      // versions, and the shared fold is what the panel, a reload and this line all use.
      const summary = describeTodoChange(todoDiff(progress.previousPlan, todos));
      progress.previousPlan = todos;
      process.stderr.write(
        `\n[plan] ${todos.length} item(s)${summary ? ` (${summary})` : ''}\n` +
          todos
            .map(
              (todo) =>
                `  ${todo.status === 'completed' ? '[x]' : todo.status === 'in_progress' ? '[~]' : '[ ]'} ${display(todo.content)}\n`,
            )
            .join(''),
      );
    }
  };
}

/**
 * What this round's window is being spent on — printed when that answer *changes something*.
 *
 * Not every round: a line per round in a fifty-round run is a ticker nobody reads. The numbers that
 * matter are the fixed cost (the tool schemas, which do not move once a run starts) and the moments
 * the budget was acted on — a compaction, a shortening, a problem — so the first round is printed as
 * the baseline the rest are read against, and `--json` carries every round for a caller that wants
 * the series. The same reasoning as the `[model]` line above, which is also an event, not a ticker.
 */
function printForecast(event: AgentEvent): void {
  const round = Number(event.data.round ?? 0);
  const breakdown = event.data.breakdown as
    | {
        system?: number;
        tools?: number;
        messages?: number;
        overhead?: number;
        total?: number;
      }
    | undefined;
  const acted =
    event.data.compacted === true ||
    Number(event.data.shortened ?? 0) > 0 ||
    Number(event.data.pruned ?? 0) > 0 ||
    Boolean(event.data.problem) ||
    Boolean(event.data.policyProblem);
  if (round !== 0 && !acted) return;
  const total = breakdown?.total ?? Number(event.data.inputTokens ?? 0);
  const raw = Number(event.data.rawInputTokens ?? total);
  const notes = [
    event.data.compacted === true ? 'compacted' : '',
    Number(event.data.shortened ?? 0) > 0 ? `${Number(event.data.shortened)} shortened` : '',
    Number(event.data.pruned ?? 0) > 0 ? `${Number(event.data.pruned)} pruned` : '',
    event.data.problem ? `problem: ${display(String(event.data.problem))}` : '',
    event.data.policyProblem ? `policy: ${display(String(event.data.policyProblem))}` : '',
  ].filter(Boolean);
  process.stderr.write(
    `[budget] round ${round + 1}: ` +
      (breakdown
        ? `system ${breakdown.system ?? 0} · tools ${breakdown.tools ?? 0} · messages ${breakdown.messages ?? 0} · overhead ${breakdown.overhead ?? 0} = ${total}`
        : `input ${total} tokens`) +
      // The estimate is calibrated against measured usage, so the raw number is only worth a
      // mention when it differs — otherwise it is the same figure twice.
      (raw !== total ? ` (raw ${raw})` : '') +
      (notes.length ? ` [${notes.join(' · ')}]` : '') +
      '\n',
  );
}

/**
 * What the provider said about prompt caching, appended to the usage line.
 *
 * It is part of the usage line rather than the `[budget]` line because they answer different questions:
 * `[budget]` is what the *request* was made of, this is what the provider *charged* for it. A cache read
 * is input the run did not pay full price for; a cache write is the cost the next call's hit pays for — so
 * the write is shown even though it is already inside the input total, because hiding it made a hit look
 * free. Nothing appears when the provider reported no such field: "unreported" and "zero" are different
 * facts, the same distinction `packages/protocol/statistics.ts` keeps with `cacheKnown`.
 */
function cacheNote(usage: Usage): string {
  const read = usage.cachedInputTokens;
  const written = usage.cacheWriteInputTokens ?? 0;
  const parts: string[] = [];
  if (read !== undefined && usage.inputTokens > 0)
    parts.push(`${Math.round((read / usage.inputTokens) * 100)}% hit`);
  if (read !== undefined) parts.push(`${read} of ${usage.inputTokens} read`);
  if (written > 0) parts.push(`${written} written`);
  return parts.length ? ` (cache: ${parts.join(', ')})` : '';
}

/** One run's result: a JSONL line with `--json`, otherwise the status and usage line on stderr. */
export function reportResult(options: Options, outcome: RunResult): void {
  if (options.json)
    process.stdout.write(JSON.stringify({ type: 'result', result: outcome }) + '\n');
  else {
    process.stdout.write('\n');
    process.stderr.write(
      `[${outcome.status}] tokens: ${outcome.usage.inputTokens} in / ${outcome.usage.outputTokens} out${cacheNote(outcome.usage)}${outcome.error ? ' — ' + display(outcome.error) : ''}${outcome.code ? ` (${outcome.code})` : ''}\n`,
    );
  }
}

export function exitCodeFor(outcome: RunResult): number {
  return outcome.status === 'completed'
    ? 0
    : outcome.status === 'cancelled'
      ? 130
      : outcome.status === 'limited'
        ? 2
        : 1;
}
