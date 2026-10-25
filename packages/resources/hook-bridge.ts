import { spawn } from 'node:child_process';
import type { HookRegistry, ExtensionHooks } from '../tools/hooks.ts';
import type { ToolCall, ToolResult } from '../protocol/index.ts';
import type { Disposer } from '../tools/dispatch.ts';
import {
  prepareSandbox,
  resolveSandboxConfig,
  stopSandbox,
  markSandboxStarted,
  withSandboxPreparation,
} from '../tools/sandbox.ts';
import type { ClaudeHookEvent, HookDeclaration } from './hook-config.ts';
import { hookMatcherMatches } from './hook-config.ts';
/**
 * The external hook bridge.
 *
 * It installs workspace-declared commands as *ordinary hooks* in the existing `HookRegistry`, so this is a
 * publisher rather than a second hook mechanism: the pipeline, its ordering guarantees, its timeouts and its
 * observer-failure handling all apply to an external hook exactly as they do to an in-process one.
 *
 * What it adds is a boundary, and the boundary is the risk. A hook command is arbitrary code execution
 * inside the agent's process tree, so it is gated five ways, and each gate is a decision rather than a
 * default:
 *
 *  - it is installed only when the operator trusted exactly these declarations for this workspace
 *    (`hook-trust.ts`, checked by `createTools` before this function is called);
 *  - the environment is the same allow-list `run_command` gets (`toolEnvironment`), so a hook cannot read
 *    the model's API key or any other `YUANTU_*` value;
 *  - it runs through `prepareSandbox`, inheriting the call's execution policy; an explicit hook backend
 *    override preserves the call's file/network requirements, and unsupported policies refuse execution;
 *  - a planning or read-only run does not run them, because that run's promise is that nothing outside the
 *    process is affected;
 *  - an operator can turn the whole thing off with `YUANTU_HOOK_BRIDGE=0`.
 */
/** How much of a hook's output is kept. A decision is a small JSON object; anything larger is a bug. */
const HOOK_OUTPUT_LIMIT = 64_000;
/** Where a hook that misbehaved is reported. The bridge never throws: a broken hook is not a broken run. */
export type HookFailureReporter = (message: string) => void;
export interface HookBridgeOptions {
  workspace: string;
  hooks: HookRegistry;
  declarations: readonly HookDeclaration[];
  /** Called for a hook that failed for a reason that is not a decision. Never for a clean decision. */
  onFailure?: HookFailureReporter;
}
/** What one command decided, after the exit code and stdout have been read. */
type Verdict =
  { kind: 'allow' } | { kind: 'block'; reason: string } | { kind: 'failed'; reason: string };
/** Extra model-visible context a hook asked for, alongside its verdict. */
interface Outcome {
  verdict: Verdict;
  context: string[];
}
/**
 * A verdict that may also carry `hookSpecificOutput.additionalContext`.
 *
 * `allow` is the only kind that can: a hook that blocked is not also adding a note, and conflating the two
 * would put a refused call's words in front of the model as if the call had been accepted.
 */
type Decided = Verdict & { context?: string };
/**
 * Installs every declaration, grouped so that one Claude event costs one hook registration.
 *
 * Grouping is not cosmetic: `HookRegistry` bounds how many hook *sets* it holds, and one registration per
 * declaration would exhaust that budget on a workspace with a dozen hooks while changing nothing about the
 * order they run in.
 */
export function installHookBridge(options: HookBridgeOptions): Disposer[] {
  const { workspace, hooks, declarations, onFailure = () => {} } = options;
  if (!declarations.length) return [];
  // Validate the category without creating a plan or granting workspace permissions at installation.
  resolveSandboxConfig(process.env, 'hook');
  const events = new Set(declarations.map((declaration) => declaration.event));
  const disposers: Disposer[] = [];
  try {
    for (const event of events) {
      const forEvent = declarations.filter((declaration) => declaration.event === event);
      disposers.push(hooks.register(hooksFor(event, forEvent, workspace, onFailure)));
    }
  } catch (error) {
    /**
     * A registration that fails part-way through — the registration ceiling is the reachable case — must take
     * back the ones it already made. `installOnce` deliberately does not record the key on failure, so the next
     * attempt runs this function again, and leaving the earlier hooks registered would register them twice.
     */
    for (const dispose of disposers.reverse()) dispose();
    throw error;
  }
  return disposers;
}
/** The one hook set that serves every declaration of one Claude event. */
function hooksFor(
  event: ClaudeHookEvent,
  declarations: readonly HookDeclaration[],
  workspace: string,
  onFailure: HookFailureReporter,
): ExtensionHooks {
  const run = (
    subject: string | undefined,
    payload: Record<string, unknown>,
    signal: AbortSignal,
  ) => dispatch(declarations, subject, payload, workspace, signal, onFailure);
  switch (event) {
    case 'PreToolUse':
      /**
       * A guard, not `beforeTool`.
       *
       * Both run at the pre-execute end of the pipeline, but only a guard can deny *with a reason the model
       * reads*, and only `beforeTool` can report a non-blocking failure — by returning `'failed'`, which
       * refuses the call outright. A hook that exits 1 for an unrelated reason must not refuse the call, so
       * it is reported through `onFailure` instead, and the guard simply allows.
       */
      return {
        guard: async (execution, signal) => {
          if (execution.readOnly) return undefined;
          const outcome = await run(
            execution.tool,
            toolPayload('PreToolUse', execution.sessionId, workspace, execution.call),
            signal,
          );
          return outcome.verdict.kind === 'block' ? { deny: outcome.verdict.reason } : undefined;
        },
      };
    case 'PostToolUse':
      /**
       * `postExecute` with `replace-content`, not `afterTool`, and deliberately not `block`.
       *
       * The Claude contract for a blocked PostToolUse is "the tool already ran; this is feedback". Our
       * `afterTool` is observe-only, so it cannot carry the feedback, and `block` would report a completed
       * effect as an error — which is the one outcome that makes a model retry it. Replacing the content
       * keeps the result truthful and still puts the hook's words in front of the model.
       */
      return {
        postExecute: async (execution, result, signal) => {
          if (execution.readOnly) return undefined;
          const outcome = await run(
            execution.tool,
            {
              ...toolPayload('PostToolUse', execution.sessionId, workspace, execution.call),
              tool_response: { content: result.content, isError: result.isError },
            },
            signal,
          );
          if (outcome.verdict.kind !== 'block') return undefined;
          return {
            action: 'replace-content',
            content: withFeedback(result, outcome.verdict.reason),
          };
        },
      };
    case 'UserPromptSubmit':
      return {
        promptSubmit: async (context, signal) => {
          if (context.readOnly) return undefined;
          const outcome = await run(
            undefined,
            basePayload('UserPromptSubmit', context.sessionId, workspace, {
              prompt: context.prompt,
            }),
            signal,
          );
          if (outcome.verdict.kind === 'block') return { block: outcome.verdict.reason };
          // The prompt hook can rewrite the prompt but has no inject channel, and Claude's "additional
          // context" is exactly a rewrite from the model's point of view. Appending it is the closest
          // existing expression; inventing a second, unlogged injection path is not an option (I7).
          if (outcome.context.length)
            return { prompt: `${context.prompt}\n\n${outcome.context.join('\n')}` };
          return undefined;
        },
      };
    case 'Stop':
      return {
        stop: async (context, signal) => {
          if (context.readOnly) return undefined;
          const outcome = await run(
            undefined,
            basePayload('Stop', context.sessionId, workspace, {
              stop_hook_active: false,
              status: context.status,
            }),
            signal,
          );
          // Reported as a reason, never as a veto: the run is already finished and persisted, which is the
          // promise this project's own `stop` hook makes and the bridge inherits rather than relaxes.
          return outcome.verdict.kind === 'block' ? { block: outcome.verdict.reason } : undefined;
        },
      };
    case 'SessionStart':
      return {
        sessionStart: async (context, signal) => {
          if (context.readOnly) return;
          await run(
            context.resumed ? 'resume' : 'startup',
            basePayload('SessionStart', context.sessionId, workspace, {
              source: context.resumed ? 'resume' : 'startup',
            }),
            signal,
          );
        },
      };
    case 'SessionEnd':
      return {
        sessionEnd: async (context, signal) => {
          if (context.readOnly) return;
          await run(
            context.reason,
            basePayload('SessionEnd', context.sessionId, workspace, { reason: context.reason }),
            signal,
          );
        },
      };
  }
}
function basePayload(
  hookEventName: ClaudeHookEvent,
  sessionId: string,
  workspace: string,
  extra: Record<string, unknown>,
): Record<string, unknown> {
  // The common fields Claude Code sends, as a projection of what this runtime already has. `session_id`
  // and `cwd` are the two a hook branches on; the rest of Claude's payload (a transcript path) is not
  // something this runtime has, and inventing one would be worse than omitting it.
  return { session_id: sessionId, cwd: workspace, hook_event_name: hookEventName, ...extra };
}
function toolPayload(
  hookEventName: ClaudeHookEvent,
  sessionId: string | undefined,
  workspace: string,
  call: ToolCall,
): Record<string, unknown> {
  return basePayload(hookEventName, sessionId ?? '', workspace, {
    tool_name: call.name,
    tool_input: call.arguments,
  });
}
function withFeedback(result: ToolResult, reason: string): string {
  return `${result.content}\n\n[PostToolUse hook] ${reason}\n[The tool call already completed; the effect above stands. Do not repeat it.]`;
}
/**
 * Runs every declaration whose matcher matches, in declaration order, and stops at the first block.
 *
 * A hook that failed does not stop the others: "this hook is broken" and "this hook refused" are different
 * facts, and reporting the first as if it were the second would let a typo in one hook veto every call.
 */
async function dispatch(
  declarations: readonly HookDeclaration[],
  subject: string | undefined,
  payload: Record<string, unknown>,
  workspace: string,
  signal: AbortSignal,
  onFailure: HookFailureReporter,
): Promise<Outcome> {
  const context: string[] = [];
  for (const declaration of declarations) {
    if (!hookMatcherMatches(declaration.matcher, subject)) continue;
    const verdict = await runCommand(declaration, payload, workspace, signal, onFailure);
    if (verdict.kind === 'block') return { verdict, context };
    if (verdict.kind === 'failed') onFailure(`${declaration.file}: ${verdict.reason}`);
    else context.push(...additionalContextOf(verdict));
  }
  return { verdict: { kind: 'allow' }, context };
}
/** Whatever `hookSpecificOutput.additionalContext` the hook asked to add, if any. */
function additionalContextOf(verdict: Verdict): string[] {
  const extra = (verdict as Decided).context;
  return typeof extra === 'string' && extra.trim() ? [extra] : [];
}
/**
 * Runs one hook command and reads its answer out of the Claude Code contract.
 *
 * The three outcomes are the contract's: exit 0 allows (and stdout may carry a decision), exit 2 blocks with
 * stderr as the reason, and anything else is a hook that misbehaved — logged, never treated as a decision.
 */
async function runCommand(
  declaration: HookDeclaration,
  payload: Record<string, unknown>,
  workspace: string,
  signal: AbortSignal,
  onFailure: HookFailureReporter,
): Promise<Decided> {
  if (signal.aborted) return { kind: 'allow' };
  // Resolve the live policy for each event; never retry a failed native launch on the host.
  const plan = await withSandboxPreparation({ signal }, () =>
    prepareSandbox(
      workspace,
      workspace,
      declaration.command,
      undefined,
      resolveSandboxConfig(process.env, 'hook'),
      'hook',
    ),
  );
  return new Promise<Decided>((resolve, reject) => {
    markSandboxStarted(plan);
    const child = spawn(plan.executable, plan.args, {
      cwd: plan.cwd,
      env: plan.env,
      shell: false,
      windowsHide: true,
      windowsVerbatimArguments: plan.windowsVerbatimArguments,
      detached: process.platform !== 'win32',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '',
      stderr = '',
      timedOut = false,
      settled = false,
      killing: Promise<void> | undefined;
    let cleanupError: unknown;
    const collect = (chunk: Buffer, into: 'stdout' | 'stderr') => {
      if (into === 'stdout') stdout = (stdout + chunk.toString('utf8')).slice(0, HOOK_OUTPUT_LIMIT);
      else stderr = (stderr + chunk.toString('utf8')).slice(-4096);
    };
    child.stdout.on('data', (chunk: Buffer) => collect(chunk, 'stdout'));
    child.stderr.on('data', (chunk: Buffer) => collect(chunk, 'stderr'));
    const stop = () => {
      if (child.pid && !killing)
        killing = stopSandbox(child, plan).catch((error) => {
          cleanupError = error;
          child.kill();
        });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, declaration.timeoutMs);
    const abort = () => stop();
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) stop();
    const finish = (verdict: Decided) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      void (async () => {
        try {
          await (killing ?? stopSandbox(child, plan));
          if (cleanupError) throw cleanupError;
          resolve(verdict);
        } catch (error) {
          onFailure(`${declaration.file}: hook cleanup failed: ${String(error)}`);
          reject(error);
        }
      })();
    };
    child.on('error', (error) => {
      onFailure(`${declaration.file}: could not run hook: ${error.message}`);
      finish({ kind: 'allow' });
    });
    child.on('close', (code) => {
      if (timedOut) {
        onFailure(`${declaration.file}: hook timed out after ${declaration.timeoutMs}ms`);
        finish({ kind: 'allow' });
        return;
      }
      // Cancellation is not a hook decision: a cancelled run must end as cancelled, and the pipeline
      // checks the signal itself on the way past.
      if (signal.aborted) {
        finish({ kind: 'allow' });
        return;
      }
      finish(classify(declaration, code, stdout, stderr));
    });
    // A hook that closes stdin early (or never reads it) is normal; EPIPE here is not a hook failure.
    child.stdin.on('error', () => undefined);
    child.stdin.end(JSON.stringify(payload));
  });
}
function classify(
  declaration: HookDeclaration,
  code: number | null,
  stdout: string,
  stderr: string,
): Decided {
  const detail = stderr.trim();
  if (code === 2)
    return {
      kind: 'block',
      reason: detail || `${declaration.file} blocked the operation (exit 2)`,
    };
  if (code !== 0)
    return { kind: 'failed', reason: `hook failed: ${detail || `exit code ${code}`}` };
  const parsed = parseDecision(stdout);
  if (!parsed) return { kind: 'allow' };
  const reason =
    typeof parsed.reason === 'string' && parsed.reason.trim()
      ? parsed.reason.trim()
      : detail || 'blocked by hook';
  if (parsed.decision === 'block') return { kind: 'block', reason };
  const specific = parsed.hookSpecificOutput;
  if (specific && typeof specific === 'object') {
    const output = specific as Record<string, unknown>;
    if (output.permissionDecision === 'deny')
      return {
        kind: 'block',
        reason:
          typeof output.permissionDecisionReason === 'string' &&
          output.permissionDecisionReason.trim()
            ? output.permissionDecisionReason.trim()
            : reason,
      };
    // `ask` means "put this to the human". This runtime has no way to ask on a hook's behalf from inside a
    // tool call, and choosing for the hook — either way — would be inventing an answer it did not give.
    if (output.permissionDecision === 'ask')
      return {
        kind: 'block',
        reason: `${reason} (the hook asked for confirmation; this runtime cannot ask on its behalf, so the call is refused)`,
      };
    const additional = output.additionalContext;
    if (typeof additional === 'string' && additional.trim())
      return { kind: 'allow', context: additional };
  }
  return { kind: 'allow' };
}
/** The decision object a hook put on stdout, or `undefined` when stdout is not a JSON object. */
function parseDecision(stdout: string): Record<string, unknown> | undefined {
  const text = stdout.trim();
  if (!text || text[0] !== '{') return undefined;
  try {
    const value: unknown = JSON.parse(text);
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}
