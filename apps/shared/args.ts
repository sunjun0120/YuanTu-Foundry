import { ENVIRONMENT } from '../../packages/protocol/settings.ts';
export interface Options {
  images?: string[];
  permissionPolicy?: string;
  /** Path to a trusted hooks module. Must resolve outside the workspace. */
  hooks?: string;
  workspace?: string;
  db?: string;
  /** Path to a JSON completion contract, read and normalized before any model request is made. */
  completionSpec?: string;
  json: boolean;
  /** Report what a maintenance command would do without doing it (`workspace-gc`, `sandbox-recover`). */
  dryRun?: boolean;
  allowWrite: boolean;
  allowCommand: boolean;
  maxContextChars?: number;
  maxContextTokens?: number;
  autoCompactTokens?: number;
  maxOutputTokens?: number;
  requestTimeoutMs?: number;
  /** How many times a round's model request may be re-sent after a transient failure. */
  maxModelRetries?: number;
  /** How many times an attempt that produced no bytes at all may be re-sent, on top of that allowance. */
  zeroByteRetries?: number;
  /** Model time a run may investigate before it is nudged to edit (the tool cutoff is twice that). */
  investigationMs?: number;
  /** How many sibling tool calls from one assistant message may be in flight at once. */
  maxParallelToolCalls?: number;
  /** How long the Host waits for an answer to `ask_user_question` before settling it unanswered. */
  questionTimeoutMs?: number;
  /** A run's total budget, `0` = that one off (see `RunDefaults.maxRunRounds`). */
  maxRunRounds?: number;
  maxRunMs?: number;
  maxRunTokens?: number;
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
  /**
   * Where a write-capable sub-agent executes: `auto` (its own worktree), `shared` (the delegator's
   * directory, the pre-isolation behaviour) or `worktree` (isolate read-only children too).
   *
   * `auto` is the product default; `shared` exists so an operator can ask for the old behaviour deliberately,
   * and a host that cannot manage Git metadata fails the task rather than quietly falling back to it.
   */
  subagentWorkspace?: string;
  taskId?: string;
  help: boolean;
}
/**
 * The numbers where zero is a choice rather than a typo. Every other number here bounds a budget or a count,
 * where zero means the run cannot do anything at all.
 */
const ZERO_ALLOWED = new Set([
  // Zero retries is a policy ("a failed request is a failed run"), not a missing value.
  'YUANTU_MAX_RETRIES',
  '--max-retries',
  // Zero re-sends of an empty attempt is the product default, not a typo.
  'YUANTU_ZERO_BYTE_RETRIES',
  '--zero-byte-retries',
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
  ['YUANTU_ZERO_BYTE_RETRIES', 'zeroByteRetries'],
  ['YUANTU_INVESTIGATION_MS', 'investigationMs'],
  ['YUANTU_AUTO_COMPACT_TOKENS', 'autoCompactTokens'],
  ['YUANTU_MAX_OUTPUT_TOKENS', 'maxOutputTokens'],
  ['YUANTU_REQUEST_TIMEOUT_MS', 'requestTimeoutMs'],
  ['YUANTU_MAX_PARALLEL_TOOLS', 'maxParallelToolCalls'],
  ['YUANTU_QUESTION_TIMEOUT_MS', 'questionTimeoutMs'],
  ['YUANTU_MAX_RUN_ROUNDS', 'maxRunRounds'],
  ['YUANTU_MAX_RUN_MS', 'maxRunMs'],
  ['YUANTU_MAX_RUN_TOKENS', 'maxRunTokens'],
  ['YUANTU_SUBAGENT_CONCURRENCY', 'subagentConcurrency'],
  ['YUANTU_SUBAGENT_TIMEOUT_MS', 'subagentTimeoutMs'],
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
  };
  if (env.YUANTU_HOOKS_MODULE) options.hooks = env.YUANTU_HOOKS_MODULE;
  if (env.YUANTU_SUBAGENT_WORKSPACE) options.subagentWorkspace = env.YUANTU_SUBAGENT_WORKSPACE;
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
    | 'workspace'
    | 'db'
    | 'permissionPolicy'
    | 'taskId'
    | 'hooks'
    | 'completionSpec'
    | 'subagentWorkspace'
  > = {
    '--workspace': 'workspace',
    '--db': 'db',
    '--permission-policy': 'permissionPolicy',
    '--task-id': 'taskId',
    '--hooks': 'hooks',
    /**
     * A completion contract, as a path to a JSON file.
     *
     * A file rather than inline JSON because the contract is a definition a person writes once and reuses, and
     * because a shell-quoted JSON body on the command line is a quoting problem nobody should have to solve twice.
     * There is deliberately no environment variable for it: the contract is what makes a run *verified*, and an
     * inherited variable that silently turned every run in a shell into a verified one is not a convenience.
     */
    '--completion-spec': 'completionSpec',
    /**
     * Where a write-capable sub-agent executes.
     *
     * A flag as well as an environment variable because it is a per-invocation decision as often as a machine-wide
     * one: a person running the CLI against their own checkout wants the default, and a script that must not create
     * worktrees says so on the command line.
     */
    '--subagent-workspace': 'subagentWorkspace',
  };
  const numbers: Record<
    string,
    | 'maxContextChars'
    | 'maxContextTokens'
    | 'autoCompactTokens'
    | 'maxOutputTokens'
    | 'requestTimeoutMs'
    | 'maxModelRetries'
    | 'zeroByteRetries'
    | 'investigationMs'
    | 'maxParallelToolCalls'
    | 'questionTimeoutMs'
    | 'maxRunRounds'
    | 'maxRunMs'
    | 'maxRunTokens'
    | 'subagentConcurrency'
    | 'subagentTimeoutMs'
  > = {
    '--max-context-chars': 'maxContextChars',
    '--max-context-tokens': 'maxContextTokens',
    '--auto-compact-tokens': 'autoCompactTokens',
    '--max-output-tokens': 'maxOutputTokens',
    '--request-timeout-ms': 'requestTimeoutMs',
    '--max-retries': 'maxModelRetries',
    '--zero-byte-retries': 'zeroByteRetries',
    '--investigation-ms': 'investigationMs',
    '--max-parallel-tools': 'maxParallelToolCalls',
    '--question-timeout-ms': 'questionTimeoutMs',
    '--max-run-rounds': 'maxRunRounds',
    '--max-run-ms': 'maxRunMs',
    '--max-run-tokens': 'maxRunTokens',
    '--subagent-concurrency': 'subagentConcurrency',
    '--subagent-timeout-ms': 'subagentTimeoutMs',
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--') {
      positionals.push(...argv.slice(i + 1));
      break;
    }
    if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--json') options.json = true;
    else if (arg === '--dry-run') options.dryRun = true;
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
