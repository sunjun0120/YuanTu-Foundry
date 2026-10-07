import { DEFAULT_MAX_OUTPUT_TOKENS } from '../../packages/protocol/limits.ts';
import { ENVIRONMENT } from '../../packages/protocol/settings.ts';
export interface Options {
  images?: string[];
  permissionPolicy?: string;
  /** Path to a trusted hooks module. Must resolve outside the workspace. */
  hooks?: string;
  workspace?: string;
  db?: string;
  /**
   * `[host:]port` to serve the JSONL protocol on instead of stdin/stdout.
   *
   * A browser cannot spawn or pipe into a Host process, so a second carrier needs a way to reach one that is
   * already running. The wire format is unchanged — same protocol version, same framing — because only the
   * carrier changes.
   */
  listen?: string;
  json: boolean;
  allowWrite: boolean;
  allowCommand: boolean;
  maxContextChars?: number;
  maxContextTokens?: number;
  autoCompactTokens?: number;
  maxOutputTokens?: number;
  requestTimeoutMs?: number;
  /** How many times a round's model request may be re-sent after a transient failure. */
  maxModelRetries?: number;
  /** How many sibling tool calls from one assistant message may be in flight at once. */
  maxParallelToolCalls?: number;
  /** How long the Host waits for an answer to `ask_user_question` before settling it unanswered. */
  questionTimeoutMs?: number;
  /** Sub-agent delegation is on by default; `--no-subagents` or YUANTU_SUBAGENTS=off disables it. */
  subagents?: boolean;
  /** Maximum sub-agents running at once. Clamped to the runtime ceiling of 3. */
  subagentConcurrency?: number;
  /**
   * Wall-clock budget for one sub-agent, or `0` for none.
   *
   * The zero floor is the point of the option: a delegated investigation is bounded by the run that owns it and
   * by its own window, and a stopwatch on top of those only ever cut work that was still moving. `0` is how an
   * operator says "let the child finish"; any positive value restores the deadline.
   */
  subagentTimeoutMs?: number;
  /** Characters of this session's transcript a forked sub-agent inherits. */
  forkTranscriptChars?: number;
  /** Messages of this session's transcript a forked sub-agent inherits. */
  forkTranscriptMessages?: number;
  /** Newest tool results that are never shortened. Zero is allowed: shorten everything old. */
  toolResultKeepRecent?: number;
  /** Characters a shortened tool result keeps. */
  toolResultShrinkTokens?: number;
  /** Code points a tool result may reach before its middle is dropped. */
  toolResultPruneThresholdChars?: number;
  /** Code points a pruned result keeps at its head. */
  toolResultPruneHeadChars?: number;
  /** Code points a pruned result keeps at its tail. */
  toolResultPruneTailChars?: number;
  /** Share of the window at which old tool results start being shortened. */
  contextShrinkPercent?: number;
  taskId?: string;
  help: boolean;
}
/**
 * The one count where zero is a choice rather than a typo: shortening every old tool result is exactly what an
 * operator who wants the smallest possible conversation would ask for. Every other number here bounds a budget
 * or a count, where zero means the run cannot do anything at all.
 */
const ZERO_ALLOWED = new Set([
  'YUANTU_TOOL_RESULT_KEEP_RECENT',
  '--tool-result-keep-recent',
  // Zero retries is a policy ("a failed request is a failed run"), not a missing value.
  'YUANTU_MAX_RETRIES',
  '--max-retries',
  // Zero sub-agent timeout is a policy too: the child is bounded by the run that owns it, not by a stopwatch.
  'YUANTU_SUBAGENT_TIMEOUT_MS',
  '--subagent-timeout-ms',
]);
const floorFor = (name: string): number => (ZERO_ALLOWED.has(name) ? 0 : 1);
/**
 * Every number this parser reads, and the option it fills.
 *
 * A list rather than two parallel tables because the *range* of each number lives in `ENVIRONMENT`, and the
 * mapping is what lets both the environment and the flag form be checked against it.
 */
const NUMBERS = [
  ['YUANTU_MAX_CONTEXT_TOKENS', 'maxContextTokens'],
  ['YUANTU_MAX_RETRIES', 'maxModelRetries'],
  ['YUANTU_AUTO_COMPACT_TOKENS', 'autoCompactTokens'],
  ['YUANTU_MAX_OUTPUT_TOKENS', 'maxOutputTokens'],
  ['YUANTU_REQUEST_TIMEOUT_MS', 'requestTimeoutMs'],
  ['YUANTU_MAX_PARALLEL_TOOLS', 'maxParallelToolCalls'],
  ['YUANTU_QUESTION_TIMEOUT_MS', 'questionTimeoutMs'],
  ['YUANTU_SUBAGENT_CONCURRENCY', 'subagentConcurrency'],
  ['YUANTU_SUBAGENT_TIMEOUT_MS', 'subagentTimeoutMs'],
  ['YUANTU_FORK_TRANSCRIPT_CHARS', 'forkTranscriptChars'],
  ['YUANTU_FORK_TRANSCRIPT_MESSAGES', 'forkTranscriptMessages'],
  ['YUANTU_TOOL_RESULT_KEEP_RECENT', 'toolResultKeepRecent'],
  ['YUANTU_TOOL_RESULT_SHRINK_TOKENS', 'toolResultShrinkTokens'],
  ['YUANTU_TOOL_RESULT_PRUNE_THRESHOLD_CHARS', 'toolResultPruneThresholdChars'],
  ['YUANTU_TOOL_RESULT_PRUNE_HEAD_CHARS', 'toolResultPruneHeadChars'],
  ['YUANTU_TOOL_RESULT_PRUNE_TAIL_CHARS', 'toolResultPruneTailChars'],
  ['YUANTU_CONTEXT_SHRINK_PERCENT', 'contextShrinkPercent'],
] as const satisfies readonly (readonly [string, keyof Options])[];
/**
 * The declared bound of each number, read from the settings table rather than repeated here.
 *
 * `ENVIRONMENT` says what shape a setting has to have; until now this parser checked only the floor, so a value
 * the table called invalid — `YUANTU_MAX_CONTEXT_TOKENS=999999999`, `--max-retries 99` — was accepted by the
 * runtime and reported only by the doctor. Two statements of one bound is exactly how the retry range drifted
 * before, so there is one statement and this reads it.
 */
const CEILING = new Map<string, number>(
  NUMBERS.flatMap(([key, field]) => {
    const spec = ENVIRONMENT[key as keyof typeof ENVIRONMENT] as
      { range?: readonly [number, number] } | undefined;
    return spec?.range ? [[field as string, spec.range[1]] as [string, number]] : [];
  }),
);
function checkNumber(name: string, field: string, value: number): number {
  if (!Number.isSafeInteger(value) || value < floorFor(name))
    throw new Error(
      `${name} must be a ${floorFor(name) === 0 ? 'non-negative' : 'positive'} integer`,
    );
  const ceiling = CEILING.get(field);
  if (ceiling !== undefined && value > ceiling)
    throw new Error(`${name} must be at most ${ceiling}`);
  return value;
}
export function parseArgs(
  argv: string[],
  env: NodeJS.ProcessEnv = process.env,
): { positionals: string[]; options: Options } {
  const options: Options = {
    json: false,
    allowWrite: false,
    allowCommand: false,
    help: false,
    /**
     * No default window.
     *
     * A window is a fact about somebody else's endpoint, not a preference: this used to default to 1,000,000
     * for every protocol, which meant a gateway serving 128k was measured against a number nobody had checked,
     * and the run that failed was blamed on the conversation. The run is refused instead, and the refusal names
     * the two ways to declare it.
     */
    maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS,
  };
  if (env.YUANTU_HOOKS_MODULE) options.hooks = env.YUANTU_HOOKS_MODULE;
  if (env.YUANTU_SUBAGENTS) {
    const value = env.YUANTU_SUBAGENTS.trim().toLowerCase();
    if (['off', 'false', '0', 'no'].includes(value)) options.subagents = false;
    else if (['on', 'true', '1', 'yes'].includes(value)) options.subagents = true;
    else throw new Error('YUANTU_SUBAGENTS must be on or off');
  }
  const positionals: string[] = [];
  for (const [key, name] of NUMBERS) {
    const raw = env[key];
    if (raw === undefined || raw === '') continue;
    options[name] = checkNumber(key, name, Number(raw)) as never;
  }
  const strings: Record<
    string,
    'workspace' | 'db' | 'permissionPolicy' | 'taskId' | 'hooks' | 'listen'
  > = {
    '--workspace': 'workspace',
    '--db': 'db',
    '--permission-policy': 'permissionPolicy',
    '--task-id': 'taskId',
    '--hooks': 'hooks',
    '--listen': 'listen',
  };
  const numbers: Record<
    string,
    | 'maxContextChars'
    | 'maxContextTokens'
    | 'autoCompactTokens'
    | 'maxOutputTokens'
    | 'requestTimeoutMs'
    | 'maxModelRetries'
    | 'maxParallelToolCalls'
    | 'questionTimeoutMs'
    | 'subagentConcurrency'
    | 'subagentTimeoutMs'
    | 'forkTranscriptChars'
    | 'forkTranscriptMessages'
    | 'toolResultKeepRecent'
    | 'toolResultShrinkTokens'
    | 'toolResultPruneThresholdChars'
    | 'toolResultPruneHeadChars'
    | 'toolResultPruneTailChars'
    | 'contextShrinkPercent'
  > = {
    '--max-context-chars': 'maxContextChars',
    '--max-context-tokens': 'maxContextTokens',
    '--auto-compact-tokens': 'autoCompactTokens',
    '--max-output-tokens': 'maxOutputTokens',
    '--request-timeout-ms': 'requestTimeoutMs',
    '--max-retries': 'maxModelRetries',
    '--max-parallel-tools': 'maxParallelToolCalls',
    '--question-timeout-ms': 'questionTimeoutMs',
    '--subagent-concurrency': 'subagentConcurrency',
    '--subagent-timeout-ms': 'subagentTimeoutMs',
    '--fork-transcript-chars': 'forkTranscriptChars',
    '--fork-transcript-messages': 'forkTranscriptMessages',
    '--tool-result-keep-recent': 'toolResultKeepRecent',
    '--tool-result-shrink-tokens': 'toolResultShrinkTokens',
    '--tool-result-prune-threshold-chars': 'toolResultPruneThresholdChars',
    '--tool-result-prune-head-chars': 'toolResultPruneHeadChars',
    '--tool-result-prune-tail-chars': 'toolResultPruneTailChars',
    '--context-shrink-percent': 'contextShrinkPercent',
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--') {
      positionals.push(...argv.slice(i + 1));
      break;
    }
    if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--json') options.json = true;
    else if (arg === '--allow-write') options.allowWrite = true;
    else if (arg === '--allow-command') options.allowCommand = true;
    else if (arg === '--no-subagents') options.subagents = false;
    else if (arg === '--image') {
      const value = argv[++i];
      if (!value || value.startsWith('--')) throw new Error('Missing value for --image');
      options.images ??= [];
      options.images.push(value);
      if (options.images.length > 4) throw new Error('At most 4 images are allowed');
    } else if (strings[arg] || numbers[arg]) {
      const value = argv[++i];
      if (!value || value.startsWith('--')) throw new Error(`Missing value for ${arg}`);
      if (strings[arg]) options[strings[arg]!] = value;
      else options[numbers[arg]!] = checkNumber(arg, numbers[arg]!, Number(value)) as never;
    } else if (arg.startsWith('-')) throw new Error(`Unknown option: ${arg}`);
    else positionals.push(arg);
  }
  if (options.listen !== undefined) {
    // Parsed here rather than passed through, so a mistyped address fails at startup instead of the first
    // time a carrier tries to connect. Port 0 asks the OS for a free port, which is what a test or a
    // per-user desktop wants; the chosen port is reported on stdout.
    const raw = options.listen.trim();
    const match = /^(?:([^:]*):)?(\d{1,5})$/.exec(raw);
    const port = match ? Number(match[2]) : -1;
    if (!match || !Number.isSafeInteger(port) || port < 0 || port > 65_535)
      throw new Error('--listen must be [host:]port');
  }
  if (options.autoCompactTokens !== undefined && options.maxContextTokens === undefined)
    throw new Error('Auto-compact threshold requires a context window');
  if (
    options.autoCompactTokens !== undefined &&
    options.maxContextTokens !== undefined &&
    options.autoCompactTokens >= options.maxContextTokens
  )
    throw new Error('Auto-compact threshold must be below context window');
  return { positionals, options };
}
