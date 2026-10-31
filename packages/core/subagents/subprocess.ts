import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import type { Usage } from '../../protocol/index.ts';
import type { SubAgentOutcome, SubAgentProvider } from './providers.ts';
import { normalizeReport } from './contract.ts';

/** Combined stdout/stderr budget, measured before UTF-8 decoding. */
const OUTPUT_BYTES = 8 * 1024 * 1024;

/**
 * A sub-agent provider that runs the child in a separate process. Capabilities are what such a
 * child can honestly promise:
 *
 * - The child owns its world: a fresh scratch workspace and database, so it can research but not
 *   edit the parent's files. `role: 'general'` is therefore refused.
 * - The report is composed from the child's answer: there is no `submit_report`, so `outputSchema`
 *   is not declared and tasks asking for their own shape are refused.
 * - Stopping is killing: an abort terminates the process and reports the task as cancelled.
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
  /** The child's context window, required because `YUANTU_MAX_CONTEXT_TOKENS` has no default. */
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
 * Read the `{"type":"result"}` line from a CLI run's JSONL. Malformed lines are skipped; a stream
 * with no result is a failure.
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
    // The last result wins (one per goal continuation round).
    result = record.result as ChildResult;
  }
  return { result, malformed };
}

/**
 * The standard report composed from the child's answer, quoted as evidence. `unverified` marks it
 * as unverified.
 */
export function reportFromChild(text: string, sessionId: string) {
  const answer = text.trim() || '(the child produced no answer)';
  // Same bounds as a submitted report.
  return normalizeReport({
    summary: answer.length > 400 ? `${answer.slice(0, 400)}…` : answer,
    findings: [{ statement: 'Reported by a subprocess child', evidence: answer }],
    // Kept under the 200-character bound of an `unverified` entry, so the session id at its end survives it.
    unverified: [
      `Ran in its own process and workspace, so this is quoted, not verified against this session's files (child session ${sessionId}).`,
    ],
  });
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
     * What this provider can actually promise:
     *
     * - `depthLimit`: the child runs with delegation off (`YUANTU_SUBAGENTS=false`), so any cap is
     *   met.
     * - `toolFilter`: passed as `YUANTU_TOOL_ALLOWLIST`, a real restriction; the permission policy
     *   is withheld, so permission-requiring operations are refused.
     *
     * No `persona` or `contextFork`: there is no way to hand over this session's prompt or
     * transcript.
     */
    capabilities: ['depthLimit', 'toolFilter'],
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
            'somewhere it cannot affect your files. Use the default provider for work that edits the workspace.',
        };
      const workspace = await mkdtemp(path.join(tmpdir(), 'yuantu-subprocess-'));
      const prompt = request.task.context
        ? `${request.task.objective}\n\nContext you cannot rediscover cheaply:\n${request.task.context}`
        : request.task.objective;
      /**
       * Pass both `--workspace` and the database explicitly as the scratch directory; otherwise the
       * child would open the parent's workspace and database.
       */
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        ...options.env,
        YUANTU_WORKSPACE: workspace,
        YUANTU_MAX_CONTEXT_TOKENS: String(options.maxContextTokens),
        // Naming sessions and scheduling work are the parent's business.
        YUANTU_WORKFLOWS: 'false',
        // `'false'`, not `'off'`: this key accepts `0|1|true|false`, and anything else rejects the
        // whole environment.
        YUANTU_SUBAGENTS: 'false',
        // Point memory at the delegator's project; the child can only read it (writes need approval
        // it cannot get).
        YUANTU_MEMORY_ROOT: request.parent.project ?? request.parent.workspace,
        ...(request.options.toolFilter?.length
          ? { YUANTU_TOOL_ALLOWLIST: request.options.toolFilter.join(',') }
          : {}),
      };
      // No permission policy: the child is read-only and its non-interactive run refuses every
      // permission request.
      delete env.YUANTU_PERMISSION_POLICY;
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
          env,
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
        },
      );
      let stdout = '';
      let stderr = '';
      const stdoutDecoder = new StringDecoder('utf8');
      const stderrDecoder = new StringDecoder('utf8');
      let outputBytes = 0;
      let outputExceeded = false;
      let settled = false;
      /** Distinct from an abort: "you stopped me" and "you ran out of budget" are different facts to report. */
      let timedOut = false;
      const stop = (): void => {
        if (!settled) child.kill('SIGKILL');
      };
      const receive = (chunk: Buffer, stream: 'stdout' | 'stderr'): void => {
        if (outputExceeded) return;
        outputBytes += chunk.length;
        if (outputBytes > OUTPUT_BYTES) {
          outputExceeded = true;
          stop();
          return;
        }
        if (stream === 'stdout') stdout += stdoutDecoder.write(chunk);
        else stderr += stderrDecoder.write(chunk);
      };
      request.signal.addEventListener('abort', stop, { once: true });
      /**
       * A signal aborted before registration never fires its listener, so check it explicitly.
       * `stop()` only kills a still-running child.
       */
      if (request.signal.aborted) stop();
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGKILL');
      }, timeoutMs);
      try {
        const code = await new Promise<number | null>((resolve, reject) => {
          child.stdout?.on('data', (chunk: Buffer) => receive(chunk, 'stdout'));
          child.stderr?.on('data', (chunk: Buffer) => receive(chunk, 'stderr'));
          child.once('error', reject);
          child.once('close', resolve);
        });
        settled = true;
        stdout += stdoutDecoder.end();
        stderr += stderrDecoder.end();
        const { result } = outputExceeded ? { result: undefined } : readChildResult(stdout);
        const sessionId = result?.sessionId ?? '';
        /** Report cancellation as cancellation, not as a child failure. */
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
        if (outputExceeded)
          return {
            sessionId: '',
            status: 'failed' as const,
            text: '',
            rounds: 0,
            toolCalls: 0,
            usage: { inputTokens: 0, outputTokens: 0 },
            error: `Subprocess output exceeded ${OUTPUT_BYTES} bytes; the child was stopped before its result could be accepted.`,
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
          // A child that did not complete is reported as failed with its own reason.
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
