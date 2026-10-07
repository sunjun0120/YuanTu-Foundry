import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Usage } from '../protocol/index.ts';
import type { SubAgentOutcome, SubAgentProvider } from './subagent-providers.ts';

/**
 * A sub-agent provider that runs the child in a **separate process**.
 *
 * The design question this answers is not "how do we spawn something" but "what can a child that is not in this
 * process honestly promise", and every capability below is decided by that rather than by convenience. The five
 * decisions were settled before this was implemented; this is what they resolve to.
 *
 * **The child owns its world.** It runs the CLI in a fresh scratch workspace with its own database, so a delegated
 * task here is *research*, not editing: the parent's files are not reachable from the child at all. That is a real
 * guarantee rather than a limitation dressed up — but it also means the promise the in-process provider makes
 * ("your file changes are journalled against the parent session, and undoable there") **cannot** be made here, so
 * `role: 'general'` is refused instead of quietly running somewhere it cannot affect anything. A model that asks
 * for a write-capable child out of process is told so, in those words.
 *
 * **The report is composed, not submitted.** The child is a normal one-shot run, so it has no `submit_report`
 * tool and no way to be held to a JSON Schema; `outputSchema` is therefore *not* declared, which is what makes the
 * capability check refuse a task that asked for its own shape rather than returning something that only looks
 * like it. The standard report is assembled from what the child actually said, and says so.
 *
 * **Stopping is killing.** Nothing here can ask the child to wind down cooperatively, so the provider does not
 * pretend otherwise: an abort terminates the process and reports the task as cancelled with that reason.
 */
export interface SubprocessProviderOptions {
  /** Registry name. Defaults to `subprocess`. */
  name?: string;
  /** Executable to run the child with. Defaults to this process's own, so a Node checkout runs a Node child. */
  command?: string;
  /** Environment for the child. Must carry whatever the endpoint needs — this provider adds nothing. */
  env?: NodeJS.ProcessEnv;
  /** The child's entrypoint: an absolute path to a script, or an executable name. */
  script: string;
  /** Arguments before the prompt — the CLI's own subcommand and flags, without a workspace or a database. */
  scriptArgs?: readonly string[];
  /** Cap on how long a child may run, since a killed process is the only stop this provider has. */
  timeoutMs?: number;
  /**
   * The child's context window, which the CLI refuses to start without.
   *
   * `YUANTU_MAX_CONTEXT_TOKENS` has no default *by design* — it is a property of the endpoint, not a preference —
   * so a deployment that wants this provider has to state it, exactly as it does for `run`.
   */
  maxContextTokens: number;
}

/** What the child printed as its result, as much of it as this provider uses. */
interface ChildResult {
  sessionId?: string;
  status?: string;
  text?: string;
  usage?: Usage;
  error?: string;
}

/**
 * Read the one `{"type":"result"}` line out of a CLI run's JSONL.
 *
 * Tolerant of the frames around it on purpose: the CLI narrates events, retries and rounds on the same stream, and
 * this provider's contract is "the child's final answer", not "the whole transcript". A malformed line is skipped
 * rather than thrown on — one bad frame should not lose a completed run — while a stream with *no* result is a
 * failure, because a child that exited without one did not answer.
 */
export function readChildResult(stdout: string): { result?: ChildResult; malformed: number } {
  let result: ChildResult | undefined;
  let malformed = 0;
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    let frame: unknown;
    try {
      frame = JSON.parse(trimmed);
    } catch {
      malformed++;
      continue;
    }
    if (typeof frame !== 'object' || frame === null) continue;
    const record = frame as { type?: unknown; result?: unknown };
    if (record.type !== 'result' || typeof record.result !== 'object' || record.result === null)
      continue;
    // The last result wins: the CLI can print one per goal continuation round, and the parent wants where the
    // session arrived, not where it started.
    result = record.result as ChildResult;
  }
  return { result, malformed };
}

/**
 * The standard report, composed from what the child said.
 *
 * `evidence` is the child's own answer rather than a citation of it, because that is the only evidence available:
 * a subprocess child cannot point at a line in the parent's transcript the way an in-process one can, and inventing
 * a citation would be worse than quoting. `unverified` says the boundary out loud so the parent does not read this
 * as a verified finding.
 */
export function reportFromChild(text: string, sessionId: string) {
  const answer = text.trim() || '(the child produced no answer)';
  return {
    summary: answer.length > 400 ? `${answer.slice(0, 400)}…` : answer,
    findings: [{ statement: 'Reported by a subprocess child', evidence: answer }],
    unverified: [
      `This child ran in its own process and workspace, so it could not inspect or change this session's files; its answer is quoted rather than verified against them (child session ${sessionId}).`,
    ],
  };
}

export function subprocessProvider(options: SubprocessProviderOptions): SubAgentProvider {
  const command = options.command ?? process.execPath;
  const script = options.script;
  const timeoutMs = options.timeoutMs ?? 600_000;
  return {
    name: options.name ?? 'subprocess',
    description:
      'Runs the child as a separate process in its own scratch workspace and database. Read-only by nature: it cannot reach this session’s files.',
    /**
     * `depthLimit` is declared because the child is a *root* run in its own world — it has no parent lineage to
     * count against, so the nesting cap the coordinator passes has nothing to bind and cannot be honoured. The
     * capability is therefore left off, and a request that needs it is refused instead of silently unbounded.
     *
     * `persona`, `toolFilter` and `contextFork` are absent for the same kind of reason: the child's prompt and tool
     * set are the child's own deployment's business, and there is no mechanism here to hand it this session's
     * transcript.
     */
    capabilities: [],
    async start(request) {
      if (request.task.role === 'general')
        return {
          sessionId: '',
          status: 'failed' as const,
          text: '',
          rounds: 0,
          toolCalls: 0,
          usage: { inputTokens: 0, outputTokens: 0 },
          error:
            'This provider runs the child in its own workspace, so a write-capable task is refused rather than run ' +
            'somewhere it cannot affect your files. Use the default provider for work that edits the workspace, or ' +
            'ask for an `explore` task here.',
        };
      const workspace = await mkdtemp(path.join(tmpdir(), 'yuantu-subprocess-'));
      const prompt = request.task.context
        ? `${request.task.objective}\n\nContext you cannot rediscover cheaply:\n${request.task.context}`
        : request.task.objective;
      /**
       * The child is given the workspace **and the database explicitly**, and both are the scratch directory.
       *
       * This is the difference between claiming isolation and having it. The CLI resolves its workspace from
       * `--workspace` — an environment variable is not read for it — and its database defaults to
       * `<workspace>/.yuantu/sessions.sqlite`, so a child spawned with neither inherits the *parent's* workspace and
       * opens the parent's database. Observed, not theorised: the first version of this provider did exactly that
       * and died on a database format its own build did not write. Passing both leaves the child's world wholly its
       * own, which is the property the `general` refusal below is built on.
       */
      const child = spawn(
        command,
        [
          script,
          ...(options.scriptArgs ?? []),
          '--workspace',
          workspace,
          '--db',
          path.join(workspace, '.yuantu', 'sessions.sqlite'),
          '--json',
          prompt,
        ],
        {
          cwd: workspace,
          env: {
            ...process.env,
            ...options.env,
            YUANTU_WORKSPACE: workspace,
            YUANTU_MAX_CONTEXT_TOKENS: String(options.maxContextTokens),
            // The child is a one-shot run in its own world: naming its session and scheduling work are the parent's
            // business, and either one would make a delegated child spend its rounds on bookkeeping nobody reads.
            YUANTU_WORKFLOWS: 'false',
            // `'false'` and not `'off'`: this key is parsed as `0|1|true|false`, and any other spelling refuses the
            // *whole* environment — which costs a spawned child its life before it reads a single byte.
            YUANTU_SUBAGENTS: 'false',
          },
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
        },
      );
      let stdout = '';
      let stderr = '';
      let settled = false;
      /** Distinct from an abort: "you stopped me" and "you ran out of budget" are different facts to report. */
      let timedOut = false;
      const stop = (): void => {
        if (!settled) child.kill('SIGKILL');
      };
      request.signal.addEventListener('abort', stop, { once: true });
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGKILL');
      }, timeoutMs);
      try {
        const code = await new Promise<number | null>((resolve, reject) => {
          child.stdout?.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')));
          child.stderr?.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));
          child.once('error', reject);
          child.once('close', resolve);
        });
        settled = true;
        const { result } = readChildResult(stdout);
        const sessionId = result?.sessionId ?? '';
        /**
         * Cancellation is reported as cancellation, not as a failed child.
         *
         * The process was killed because this call was aborted, and a parent that cancelled the work must not read
         * its own decision back as the child's fault.
         */
        if (request.signal.aborted)
          return {
            sessionId,
            status: 'cancelled' as const,
            text: result?.text ?? '',
            rounds: 0,
            toolCalls: 0,
            usage: { inputTokens: 0, outputTokens: 0 },
            error:
              'Cancelled: the call that started this child was aborted, which kills the process',
          };
        if (!result)
          return {
            sessionId,
            status: 'failed' as const,
            text: '',
            rounds: 0,
            toolCalls: 0,
            usage: { inputTokens: 0, outputTokens: 0 },
            error: timedOut
              ? `The child was killed after ${timeoutMs}ms without reporting a result. A separate process can only be stopped, not asked to wind down, so the budget is a hard limit rather than a cooperative one.`
              : `The child process exited (code=${String(code)}) without reporting a result.${
                  stderr.trim() ? ` stderr: ${stderr.trim().slice(0, 800)}` : ''
                }`,
          };
        const text = result.text ?? '';
        return {
          sessionId,
          // A child that ran but did not complete is reported as failed with its own reason, rather than as a
          // success carrying an apology.
          status: result.status === 'completed' ? ('completed' as const) : ('failed' as const),
          text,
          rounds: 0,
          toolCalls: 0,
          usage: result.usage ?? { inputTokens: 0, outputTokens: 0 },
          ...(result.status === 'completed'
            ? { report: reportFromChild(text, sessionId) }
            : { error: result.error ?? `the child finished with status ${String(result.status)}` }),
        } satisfies SubAgentOutcome;
      } finally {
        clearTimeout(timer);
        request.signal.removeEventListener('abort', stop);
        settled = true;
        await rm(workspace, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }).catch(
          () => undefined,
        );
      }
    },
  };
}
