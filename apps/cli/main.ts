#!/usr/bin/env node
import { createInterface } from 'node:readline/promises';
import { SESSION_DATABASE_POLICY } from '../../packages/storage/sqlite.ts';
import {
  backupDatabase,
  inspectDatabase,
  restoreDatabase,
  recoverDatabase,
} from '../../packages/storage/database-maintenance.ts';
import { readPermissionPolicy } from '../../packages/core/permissions.ts';
import { parseArgs } from '../shared/args.ts';
import {
  openStore,
  sessionDatabasePath,
  createAgent,
  resolveWorkspace,
  safeError,
  display,
  applySandboxDefaults,
} from '../shared/runtime.ts';
import { runGoalRounds } from '../../packages/core/goal-driver.ts';
import {
  GOAL_CONTINUATIONS_PER_REQUEST,
  exhaustedGoalVerdict,
  goalLine,
} from '../../packages/protocol/goals.ts';
import { SUBAGENT_CEILINGS, SUBAGENT_DEFAULTS } from '../../packages/core/subagents.ts';
import { discoverModels, readConfig } from '../../packages/providers/index.ts';
import {
  credentialsPath,
  readCredentials,
  saveCredential,
} from '../../packages/providers/credentials.ts';
import type {
  Approver,
  ApprovalDecisionSource,
  Plan,
  QuestionAnswer,
  Questioner,
  QuestionOutcome,
  TodoItem,
  Usage,
} from '../../packages/protocol/index.ts';
import path from 'node:path';
import { readFileSync, statSync } from 'node:fs';
import { validateImages, MAX_IMAGE_BYTES } from '../../packages/protocol/images.ts';
import { describeTodoChange, todoDiff } from '../../packages/protocol/todos.ts';
import {
  ENVIRONMENT,
  RUN_DEFAULTS,
  assertEnvironment,
  isCredentialSetting,
  resolveRunLimits,
  settingShape,
} from '../../packages/protocol/settings.ts';
import { loadInstructions } from '../../packages/resources/instructions.ts';
import { discoverSkills } from '../../packages/resources/skills.ts';
import { extensionTools } from '../../packages/resources/extensions.ts';
import { loadHookRegistry } from '../shared/hooks.ts';
import { reconcilePendingFileChanges } from '../../packages/tools/file-undo.ts';
import { verifyTaskAcceptance, type TaskBaselines } from '../../packages/core/task-acceptance.ts';
import { SubAgentResidency } from '../../packages/core/residency.ts';
import { TerminalSessions } from '../../packages/tools/terminal.ts';
import { InvariantRegistry } from '../../packages/core/invariants.ts';
import { logTablesAgreeInvariant } from '../../packages/storage/invariants.ts';
import { emittedEventTypesInvariant } from '../../packages/protocol/invariants.ts';
import { pipelineStagesInvariant } from '../../packages/tools/pipeline.ts';
import { readMcpConfigs } from '../../packages/mcp/config.ts';
import {
  McpOAuthTokenStore,
  authorizeMcpServer,
  readMcpOAuthStatus,
  revokeMcpAuthorization,
} from '../../packages/mcp/oauth.ts';

const help = `YuanTu Agent — independent coding agent (Node.js >=24)

Usage:
  npm run dev -- run "task" [options]
  npm run dev -- resume <session-id> "follow-up" [options]
  npm run dev -- sessions [--db path] [--json]
  npm run dev -- db-backup --db <file> [--json]
  npm run dev -- db-verify <file> [--json]
  npm run dev -- db-restore <backup-file> --db <file> [--json]  (close Host/CLI first)
  npm run dev -- db-recover --db <file> [--json]              (interrupted restore rollback)
  npm run dev -- show <session-id> [--db path] [--json]
  npm run dev -- task-create <session-id> <spec.json> [--db path]
  npm run dev -- tasks <session-id> [--db path] [--json]
  npm run dev -- task <session-id> <task-id> [--db path] [--json]
  npm run dev -- task-attempts <session-id> <task-id> [--db path] [--json]
  npm run dev -- task-steps <session-id> <task-id> [--db path] [--json]
  npm run dev -- task-trigger <session-id> <task-id> <trigger.json|off> [--db path] [--json]
  npm run dev -- task-schedule [--db path] [--json]
  npm run dev -- task-approval <session-id> <task-id> <approval-id> <allow|deny> [--db path] [--json]
  npm run dev -- task-verify <session-id> <task-id> [--db path] [--json]
  npm run dev -- task-retry <session-id> <task-id> ["prompt"] [options]
  npm run dev -- plan "task" [options]
  npm run dev -- plan-show <session-id> [--db path] [--json]
  npm run dev -- plan-execute <session-id> <plan-id> <hash> [options]
  npm run dev -- resources [--workspace directory]
  npm run dev -- env [--json]                Every YUANTU_* setting this program reads
  npm run dev -- models [--json]
  npm run dev -- mcp list [--workspace directory]
  npm run dev -- mcp authorize <server-id> [--workspace directory]
  npm run dev -- mcp revoke <server-id> [--workspace directory]
  npm run dev -- credentials list
  npm run dev -- credentials set <protocol>   (the key is read from standard input)

Options:
  --workspace <directory>    Existing project directory (default: cwd)
  --db <file>                SQLite file (default: <workspace>/.yuantu/sessions.sqlite)
  --permission-policy <file> Explicit trusted JSON approval rules, fixed at startup
  --hooks <module>           Trusted JS hooks module; must resolve outside the workspace
  --allow-write              Allow file edits/creation without per-call prompts
  --allow-command            Allow host shell commands without per-call prompts (not sandboxed)
  --json                     JSONL events and final result; noninteractive approval denies by default
  --image <path>             Attach a PNG/JPEG/GIF/WebP image (repeat up to 4 times)
  --max-context-tokens <n>   Model context window (required for a run; read it from your endpoint with \`models\`)
  --auto-compact-tokens <n>  Compact before the configured context window fills
  --max-context-chars <n>    Additional context character guard (default: ${RUN_DEFAULTS.maxContextChars})
  --max-output-tokens <n>    Per-request output limit (default: ${RUN_DEFAULTS.maxOutputTokens})
  --request-timeout-ms <n>   Optional total model request timeout; active streams use idle timeout
  --max-parallel-tools <n>   Sibling tool calls running at once, 1 = strictly serial (default: ${RUN_DEFAULTS.maxParallelToolCalls}; only tools that promise it overlap)
  --no-subagents             Disable sub-agent delegation (also YUANTU_SUBAGENTS=off)
  --subagent-concurrency <n> Sub-agents running at once, 1-16 (capped at ${SUBAGENT_CEILINGS.maxConcurrency}; default: ${SUBAGENT_DEFAULTS.maxConcurrency})
  --subagent-timeout-ms <n>  Stop a sub-agent after this long with no progress; 0 = no watchdog (default: ${Math.round(SUBAGENT_DEFAULTS.timeoutMs / 1000)}s)
  --fork-transcript-chars <n>    Characters of this conversation a forked sub-agent inherits (default: ${RUN_DEFAULTS.forkTranscriptChars})
  --fork-transcript-messages <n> Messages of this conversation a forked sub-agent inherits (default: ${RUN_DEFAULTS.forkTranscriptMessages})
  --tool-result-keep-recent <n>  Newest tool results never shortened (default: ${RUN_DEFAULTS.toolResultKeepRecent}; 0 shortens all old ones)
  --tool-result-shrink-tokens <n> Tokens a shortened tool result keeps (default: ${RUN_DEFAULTS.toolResultShrinkTokens})
  --context-shrink-percent <n>   Window share at which old tool results are shortened (default: ${RUN_DEFAULTS.contextShrinkPercent})
  --tool-result-prune-threshold-chars <n> Characters a tool result may reach before its middle is dropped (default: ${RUN_DEFAULTS.toolResultPruneThresholdChars})
  --tool-result-prune-head-chars <n>      Characters a pruned result keeps at its head (default: ${RUN_DEFAULTS.toolResultPruneHeadChars})
  --tool-result-prune-tail-chars <n>      Characters a pruned result keeps at its tail (default: ${RUN_DEFAULTS.toolResultPruneTailChars})
  --task-id <id>             Run and verify a persisted task

Environment:
  ANTHROPIC_API_KEY or YUANTU_API_KEY    API credential
  YUANTU_MODEL                         Your endpoint's model ID (required for runs)
  YUANTU_BASE_URL                      Optional endpoint URL matching the selected protocol
  YUANTU_PROTOCOL                      anthropic (default), openai (Chat Completions), openai-responses
  OPENAI_API_KEY                       Credential when using the openai protocol
  YUANTU_MAX_RETRIES                   Transient HTTP retries, 0 to 5 (default: 5)
  YUANTU_MAX_CONTEXT_TOKENS / YUANTU_AUTO_COMPACT_TOKENS  Model window and compaction threshold
  YUANTU_MAX_OUTPUT_TOKENS             Per-request output limit
  YUANTU_STREAM_IDLE_TIMEOUT_MS        Stream idle timeout (default: 300000)
  YUANTU_REQUEST_TIMEOUT_MS            Optional wall-clock request cap
  YUANTU_SUBAGENT_MODELS               Extra model ids list_subagent_models may offer (comma separated)
  YUANTU_SUBAGENT_TIMEOUT_MS           Stop a sub-agent after this long with no progress; 0 disables it
  YUANTU_CONTEXT_SHRINK_PERCENT / YUANTU_TOOL_RESULT_KEEP_RECENT / YUANTU_TOOL_RESULT_SHRINK_TOKENS
                                       When and how much old tool results are shortened for the model
  YUANTU_MCP_OAUTH_DIR                 MCP credential directory (default: ~/.yuantu/mcp-oauth)
  YUANTU_CREDENTIALS_FILE              File "credentials set" writes to (default: ~/.yuantu/credentials.json)

The names above are the common ones; \`env\` lists every setting this program reads, with its shape and the
value in this process, straight from the table the program uses.

Ctrl+C cancels the model request or foreground command. Existing side effects remain.
No API key is needed for help, sessions, show, resources, mcp or credentials.
MCP authorization happens outside a run: "mcp authorize" prints a browser URL and waits for the
loopback callback, and tokens never touch .yuantu/mcp.json. Commands use cmd.exe on Windows.
`;

/** One-shot TTY question, used only for the plan approval gate. */
async function ask(question: string): Promise<string> {
  const readline = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await readline.question(question);
  } finally {
    readline.close();
  }
}
/**
 * Everything on standard input, for the one command that takes a secret.
 *
 * Reading the stream directly rather than asking a question: `credentials set` is meant to be usable as
 * `... | yuantu credentials set anthropic`, and a pipe has nobody to prompt. The bound is a sanity limit on a
 * value that is a few hundred characters at most, so a mistyped pipe (`cat bigfile | ...`) fails instead of
 * buffering.
 */
async function readStandardInput(limit = 65_536): Promise<string> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of process.stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    length += buffer.length;
    if (length > limit) throw new Error('Standard input is larger than a credential can be');
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}
async function main(): Promise<void> {
  // The environment is checked before anything is read from it: a mistyped YUANTU_* name is refused with the
  // name it probably meant, instead of being ignored while the run quietly uses a different budget.
  assertEnvironment();
  // ...and the command sandbox is chosen before anything reads it, so the default is this platform's real
  // backend rather than "no isolation" (see `applySandboxDefaults`).
  applySandboxDefaults();
  const { positionals, options } = parseArgs(process.argv.slice(2));
  if (options.help || !positionals.length) {
    process.stdout.write(help);
    return;
  }
  const [command, ...args] = positionals;
  // Refused rather than ignored: the CLI is a carrier, not a Host — it runs the kernel in-process and never
  // serves a socket (the desktop is the carrier that spawns a Host) — so `--listen` could only ever be a
  // mistake about which program serves one. Silently accepting it would look like the CLI was reachable over
  // the network when it is not.
  if (options.listen !== undefined)
    throw new Error(
      'The CLI does not serve a socket; start the Agent Host with --listen [host:]port instead',
    );
  if (['db-backup', 'db-verify', 'db-restore', 'db-recover'].includes(command!)) {
    const takesFile = command === 'db-verify' || command === 'db-restore';
    if (args.length !== (takesFile ? 1 : 0) || (command !== 'db-verify' && !options.db))
      throw new Error(
        `Usage: ${command}${takesFile ? ' <file>' : ''}${command === 'db-verify' ? '' : ' --db <file>'} [--json]`,
      );
    const result =
      command === 'db-backup'
        ? backupDatabase(options.db!, SESSION_DATABASE_POLICY)
        : command === 'db-verify'
          ? inspectDatabase(args[0]!, SESSION_DATABASE_POLICY)
          : command === 'db-restore'
            ? restoreDatabase(options.db!, args[0]!, SESSION_DATABASE_POLICY)
            : recoverDatabase(options.db!);
    process.stdout.write(JSON.stringify(result, null, options.json ? undefined : 2) + '\n');
    return;
  }
  if (command === 'resources') {
    if (args.length) throw new Error('Usage: resources [--workspace directory]');
    const root = resolveWorkspace(options.workspace ?? process.cwd());
    console.log(
      JSON.stringify(
        {
          instructions: loadInstructions(root).files,
          skills: discoverSkills(root),
          extensions: extensionTools(root).map((t) => t.name),
        },
        null,
        2,
      ),
    );
    return;
  }
  if (command === 'env') {
    /**
     * Every setting this program reads, from the table the program itself uses.
     *
     * The help text carries a hand-picked handful of names, and the full list lived only in the generated README
     * table — so the answer to "which `YUANTU_*` variables exist, and what does this one do?" was outside the
     * program that reads them. This prints `ENVIRONMENT` itself, with the shape the parser enforces and the value
     * in this process, so a name that exists cannot be missing here and a name that does not exist cannot appear.
     *
     * The descriptions are the code's own strings, which are Chinese, exactly as the generated settings table in
     * the README prints them. Translating them is a separate decision (the desktop's settings UI is where that
     * matters), and inventing an English paraphrase here would be a second description to keep in step.
     */
    if (args.length) throw new Error('Usage: env [--json]');
    /**
     * A credential is reported as present or absent, never as itself.
     *
     * The same rule `credentials list` follows, and for the same reason: a command that can print a secret puts it
     * in scrollback, in the shell's history and in whatever collects a terminal's output. The rule itself lives in
     * `isCredentialSetting`, shared with the desktop's settings page, because two readers showing values must not
     * disagree about which ones are secrets.
     */
    const rows = Object.entries(ENVIRONMENT).map(([name, spec]) => ({
      name,
      shape: settingShape(spec),
      value:
        process.env[name] === undefined
          ? null
          : isCredentialSetting(name)
            ? '[redacted]'
            : process.env[name]!,
      description: spec.description,
    }));
    if (options.json) {
      process.stdout.write(`${JSON.stringify(rows)}\n`);
      return;
    }
    process.stdout.write(`${rows.length} setting(s) this program reads:\n`);
    for (const row of rows)
      process.stdout.write(
        `  ${row.name}\n    ${row.shape}${row.value === null ? ' · unset' : ` · now: ${row.value}`}\n    ${row.description}\n`,
      );
    return;
  }
  if (command === 'models') {
    /**
     * What the endpoint says its models can take.
     *
     * The point of this command is the number a run needs and this runtime refuses to invent: the context
     * window. It is an operator action rather than a startup step because it is a network call, and a run must
     * still work when the catalogue endpoint is unreachable — in that case the operator declares the window by
     * hand. Requires neither a model id nor a workspace: choosing the model is what this answers.
     */
    if (args.length) throw new Error('Usage: models [--json]');
    const config = readConfig(process.env, { model: 'optional' });
    const discovered = await discoverModels(config);
    if (options.json) {
      process.stdout.write(`${JSON.stringify(discovered)}\n`);
      return;
    }
    process.stdout.write(
      `${discovered.endpoint} (${discovered.protocol}) lists ${discovered.models.length} model(s):\n`,
    );
    for (const model of discovered.models) {
      const window =
        model.contextWindow === undefined ? 'window not declared' : `window ${model.contextWindow}`;
      const output =
        model.maxOutputTokens === undefined ? '' : `, max output ${model.maxOutputTokens}`;
      const active = config.model && model.id === config.model ? '   ← YUANTU_MODEL' : '';
      process.stdout.write(`  ${model.id}  (${window}${output})${active}\n`);
    }
    process.stdout.write(
      '\nDeclare the window with --max-context-tokens <n> or YUANTU_MAX_CONTEXT_TOKENS; a run without one is refused.\n',
    );
    return;
  }
  if (command === 'credentials') {
    /**
     * The key is read from standard input, never from an argument.
     *
     * An argument is visible to every process on the machine (`ps`, the shell's own history, a container's
     * inspect output), so a command that took a secret as one would be a command that leaks it to whoever can
     * look at the process table. Standard input is the one channel this program already owns.
     *
     * `set` writes; `list` says which protocols have a key and never the key itself, because a command that can
     * print a secret is a command that puts it in scrollback and in whatever collects that.
     */
    const [action, protocol] = args;
    const file = credentialsPath(process.env);
    if (action === 'list') {
      if (protocol) throw new Error('Usage: credentials list');
      const stored = Object.keys(readCredentials(process.env)).sort();
      process.stdout.write(
        `${file}\n${stored.length ? stored.map((name) => `  ${name}\n`).join('') : '  (no stored credentials)\n'}`,
      );
      return;
    }
    if (action !== 'set') throw new Error(`Unknown credentials action: ${action ?? '(none)'}`);
    if (!protocol || args.length !== 2) throw new Error('Usage: credentials set <protocol>');
    const key = (await readStandardInput()).trim();
    if (!key) throw new Error('No key on standard input');
    saveCredential(protocol, key, process.env);
    process.stderr.write(`Stored a key for ${protocol} in ${file}\n`);
    return;
  }
  if (command === 'mcp') {
    const root = resolveWorkspace(options.workspace ?? process.cwd());
    const configs = readMcpConfigs(root);
    const store = new McpOAuthTokenStore();
    const [action, id] = args;
    if (!action || action === 'list') {
      if (id) throw new Error('Usage: mcp list [--workspace directory]');
      const rows = configs.map((config) => ({
        id: config.id,
        transport: config.transport,
        ...(config.url ? { url: config.url } : {}),
        ...(config.oauth ? { oauth: readMcpOAuthStatus(config, store) } : {}),
      }));
      process.stdout.write(JSON.stringify(rows, null, options.json ? undefined : 2) + '\n');
      return;
    }
    if (action !== 'authorize' && action !== 'revoke')
      throw new Error(`Unknown mcp action: ${action}`);
    if (!id || args.length !== 2)
      throw new Error(`Usage: mcp ${action} <server-id> [--workspace directory]`);
    const config = configs.find((candidate) => candidate.id === id);
    if (!config) throw new Error(`Unknown MCP server: ${id}`);
    if (action === 'revoke') {
      await revokeMcpAuthorization(config, store);
      process.stderr.write(`MCP authorization for ${id} was removed.\n`);
      return;
    }
    if (!config.oauth) throw new Error(`MCP server ${id} has no oauth block in .yuantu/mcp.json`);
    const controller = new AbortController();
    const abort = () => controller.abort();
    process.on('SIGINT', abort);
    process.on('SIGTERM', abort);
    try {
      await authorizeMcpServer({
        config,
        store,
        signal: controller.signal,
        openUrl: (url) => {
          process.stderr.write(
            `Open this URL in a browser to authorize MCP server ${id}:\n${url.href}\n`,
          );
        },
      });
      process.stderr.write(`MCP server ${id} is authorized.\n`);
    } finally {
      process.off('SIGINT', abort);
      process.off('SIGTERM', abort);
    }
    return;
  }
  if (
    ![
      'run',
      'resume',
      'sessions',
      'show',
      'plan',
      'plan-execute',
      'plan-show',
      'task-create',
      'tasks',
      'task',
      'task-attempts',
      'task-steps',
      'task-trigger',
      'task-schedule',
      'task-approval',
      'task-verify',
      'task-retry',
    ].includes(command!)
  )
    throw new Error(`Unknown command: ${command}`);
  if (command === 'run' && args.length !== 1) throw new Error('Usage: run "task"');
  if (command === 'plan' && args.length !== 1) throw new Error('Usage: plan "task"');
  if (command === 'plan-execute' && args.length !== 3)
    throw new Error('Usage: plan-execute <session-id> <plan-id> <hash>');
  if (command === 'resume' && args.length !== 2)
    throw new Error('Usage: resume <session-id> "follow-up"');
  if (command === 'show' && args.length !== 1) throw new Error('Usage: show <session-id>');
  if (command === 'task-create' && args.length !== 2)
    throw new Error('Usage: task-create <session-id> <spec.json>');
  if (command === 'tasks' && args.length !== 1) throw new Error('Usage: tasks <session-id>');
  if (command === 'task' && args.length !== 2)
    throw new Error('Usage: task <session-id> <task-id>');
  if (
    (command === 'task-attempts' || command === 'task-verify' || command === 'task-steps') &&
    args.length !== 2
  )
    throw new Error(`Usage: ${command} <session-id> <task-id>`);
  if (command === 'task-trigger' && args.length !== 3)
    throw new Error('Usage: task-trigger <session-id> <task-id> <trigger.json|off>');
  if (command === 'task-schedule' && args.length) throw new Error('Usage: task-schedule');
  if (command === 'task-approval' && (args.length !== 4 || !['allow', 'deny'].includes(args[3]!)))
    throw new Error('Usage: task-approval <session-id> <task-id> <approval-id> <allow|deny>');
  if (command === 'task-retry' && (args.length < 2 || args.length > 3))
    throw new Error('Usage: task-retry <session-id> <task-id> ["prompt"]');
  if (command === 'sessions' && args.length) throw new Error('Usage: sessions');
  const permissionPolicy = readPermissionPolicy(
    options.permissionPolicy ?? process.env.YUANTU_PERMISSION_POLICY,
  );
  const store = openStore(options);
  try {
    // A sub-agent session is hidden from the session list and has no tasks, so a `running` run an
    // earlier crashed invocation left behind would never be looked at again — by anything. The Host does
    // this at startup; the CLI is one-shot, so it converges its workspace on every invocation instead.
    store.reconcileChildRuns(resolveWorkspace(options.workspace ?? process.cwd()));
    // The same convergence for ordinary sessions, which is also what makes `sessions`, `--json` and delete
    // usable after a crash rather than showing a conversation that is stuck "in flight" forever.
    store.reconcileInterruptedRuns(resolveWorkspace(options.workspace ?? process.cwd()));
    if (command === 'plan-show') {
      if (args.length !== 1) throw new Error('Usage: plan-show <session-id>');
      const plan = store.latestPlan(store.get(args[0]!).id);
      if (options.json) process.stdout.write(JSON.stringify({ type: 'plan', plan }) + '\n');
      else if (!plan) process.stdout.write('No plan recorded for this session.\n');
      else {
        process.stdout.write(`${plan.status.toUpperCase()}: ${plan.title}\n`);
        if (plan.summary) process.stdout.write(`${plan.summary}\n`);
        for (const [index, step] of plan.steps.entries())
          process.stdout.write(`  ${index + 1}. ${step.description}\n`);
        if (plan.reason) process.stdout.write(`Reason: ${plan.reason}\n`);
        // The hash is the approval witness: pass it back to plan-execute unchanged.
        process.stdout.write(`plan-id: ${plan.id}\nhash: ${plan.hash}\n`);
      }
      return;
    }
    const approvalSources = new WeakMap<object, ApprovalDecisionSource>();
    const approve: Approver = async (approval, signal) => {
      signal.throwIfAborted();
      const decision = permissionPolicy?.decide(approval);
      if (decision === 'deny' || decision === 'allow') {
        approvalSources.set(approval.toolCall, 'policy');
        return decision === 'allow';
      }
      if (
        decision !== 'ask' &&
        ((approval.kind === 'write' && options.allowWrite) ||
          (approval.kind === 'command' && options.allowCommand))
      ) {
        approvalSources.set(approval.toolCall, 'launch-options');
        return true;
      }
      if (!process.stdin.isTTY || options.json) {
        approvalSources.set(approval.toolCall, 'unavailable');
        return false;
      }
      approvalSources.set(approval.toolCall, 'user');
      const terminal = createInterface({ input: process.stdin, output: process.stderr });
      // A sub-agent's approval would otherwise look exactly like the parent's own request, and the user
      // cannot tell whose work they are authorising.
      const attribution = approval.subagent
        ? `\n[subagent ${display(approval.subagent.role)}] ${display(approval.subagent.objective)}`
        : '';
      try {
        const answer = await terminal.question(
          `${attribution}\n${display(approval.description)}\nAllow this ${approval.kind === 'external' ? 'external service access' : approval.kind === 'command' ? 'host command' : 'file change'}? [y/N] `,
          { signal },
        );
        return answer.trim().toLowerCase() === 'y';
      } finally {
        terminal.close();
      }
    };
    approve.decisionSource = (approval) => approvalSources.get(approval.toolCall);
    /**
     * Answering the model's structured question on the same terminal the approval prompt uses.
     *
     * A non-interactive invocation answers "unavailable" rather than blocking: `--json` is read by a program
     * and a piped stdin has nobody behind it, so waiting would hold the run open for an answer that cannot
     * come. The model is told the answer is missing and proceeds on a stated assumption, which is the same
     * outcome as a host with no questioner at all.
     */
    const question: Questioner = async (request, signal): Promise<QuestionOutcome> => {
      signal.throwIfAborted();
      if (!process.stdin.isTTY || options.json)
        return { answered: false, answers: [], reason: 'unavailable' };
      const terminal = createInterface({ input: process.stdin, output: process.stderr });
      try {
        // A sub-agent's question would otherwise look like the parent's own, and the user cannot tell whose
        // work they are answering for.
        if (request.subagent)
          process.stderr.write(
            `\n[subagent ${display(request.subagent.role)}] ${display(request.subagent.objective)}\n`,
          );
        const answers: QuestionAnswer[] = [];
        for (const item of request.questions) {
          signal.throwIfAborted();
          const options_ = item.options ?? [];
          process.stderr.write(
            `\n${display(item.header ? `${item.header}: ` : '')}${display(item.question)}\n`,
          );
          options_.forEach((option, index) => {
            process.stderr.write(
              `  ${index + 1}) ${display(option.label)}${option.description ? ` — ${display(option.description)}` : ''}\n`,
            );
          });
          const hint = options_.length
            ? item.multiSelect
              ? 'Choose one or more numbers (comma separated), or type an answer: '
              : 'Choose a number, or type an answer: '
            : 'Answer: ';
          const raw = (await terminal.question(hint, { signal })).trim();
          const parts = raw
            .split(',')
            .map((part) => part.trim())
            .filter(Boolean);
          const selected: string[] = [];
          let freeText: string | undefined;
          // Digits are a selection; anything else is the answer itself, which is what makes a free-text
          // question and a numbered one the same prompt.
          if (options_.length && parts.length && parts.every((part) => /^\d+$/.test(part))) {
            for (const part of parts) {
              const option = options_[Number(part) - 1];
              if (option) selected.push(option.label);
            }
            if (!item.multiSelect && selected.length > 1) selected.length = 1;
          } else if (raw) freeText = raw;
          answers.push({
            id: item.id,
            selected,
            ...(freeText === undefined ? {} : { freeText }),
          });
        }
        return { answered: true, answers };
      } catch (error) {
        if (signal.aborted) return { answered: false, answers: [], reason: 'cancelled' };
        throw error;
      } finally {
        terminal.close();
      }
    };
    if (command === 'sessions') {
      const sessions = store.list();
      process.stdout.write(
        options.json
          ? JSON.stringify(sessions) + '\n'
          : sessions
              .map(
                (s) =>
                  // `[active]`, not `[active/interrupted]`: the startup pass converges a run whose owner is
                  // gone and records the interruption in the session's own log, so a marker here means a live
                  // process is running this session, and the interrupted case is read from the log instead.
                  `${s.id}  ${display(s.title || '新会话')}  ${s.workspace}${s.activeRun ? '  [active]' : ''}`,
              )
              .join('\n') + '\n',
      );
      return;
    }
    if (command === 'show') {
      const result = { session: store.get(args[0]!), messages: store.messages(args[0]!) };
      process.stdout.write(JSON.stringify(result, null, options.json ? undefined : 2) + '\n');
      return;
    }
    if (command === 'tasks') {
      process.stdout.write(
        JSON.stringify(store.listTasks(args[0]!), null, options.json ? undefined : 2) + '\n',
      );
      return;
    }
    if (command === 'task') {
      process.stdout.write(
        JSON.stringify(store.getTask(args[0]!, args[1]!), null, options.json ? undefined : 2) +
          '\n',
      );
      return;
    }
    if (command === 'task-attempts') {
      process.stdout.write(
        JSON.stringify(
          store.listTaskAttempts(args[0]!, args[1]!),
          null,
          options.json ? undefined : 2,
        ) + '\n',
      );
      return;
    }
    if (command === 'task-steps') {
      process.stdout.write(
        JSON.stringify(
          store.taskStepCheckpoints(args[0]!, args[1]!),
          null,
          options.json ? undefined : 2,
        ) + '\n',
      );
      return;
    }
    if (command === 'task-trigger') {
      const spec = args[2]!;
      const cleared = spec === 'off' || spec === 'none';
      let trigger: unknown = null;
      if (!cleared) {
        const file = path.resolve(spec);
        const stat = statSync(file);
        if (!stat.isFile() || stat.size > 16_000)
          throw new Error('Trigger spec must be a JSON file <=16KB, or "off" to clear it');
        trigger = JSON.parse(readFileSync(file, 'utf8'));
      }
      process.stdout.write(
        JSON.stringify(
          store.updateTask(args[0]!, args[1]!, { trigger: trigger as never }),
          null,
          options.json ? undefined : 2,
        ) + '\n',
      );
      return;
    }
    if (command === 'task-approval') {
      process.stdout.write(
        JSON.stringify(
          store.resolveTaskApproval(args[0]!, args[1]!, args[3] === 'allow', args[2]!),
          null,
          options.json ? undefined : 2,
        ) + '\n',
      );
      return;
    }
    if (command === 'task-schedule') {
      // Every workspace the store knows about, so an operator can see what will run unattended.
      const scheduled = store
        .list()
        .flatMap((session) => store.listScheduledTasks(resolveWorkspace(session.workspace)));
      const unique = [...new Map(scheduled.map((task) => [task.id, task])).values()];
      unique.sort((left, right) => (left.nextRunAt ?? '').localeCompare(right.nextRunAt ?? ''));
      process.stdout.write(JSON.stringify(unique, null, options.json ? undefined : 2) + '\n');
      return;
    }
    if (command === 'task-verify') {
      const session = store.get(args[0]!);
      const workspace = resolveWorkspace(session.workspace);
      const task = store.getTask(session.id, args[1]!);
      const baselines = store.latestRunAttemptBaselines(session.id, task.id) as TaskBaselines;
      const attempt = store.startTaskAttempt(session.id, task.id, {
        kind: 'verify',
        baselines,
      });
      try {
        const acceptanceEffects = new Map<string, string>();
        const verified = await verifyTaskAcceptance(
          workspace,
          task,
          baselines,
          undefined,
          async (approval, signal) => {
            const allowed = await approve(approval, signal);
            if (allowed)
              acceptanceEffects.set(
                approval.toolCall.id.slice('acceptance:'.length),
                store.beginTaskEffect(session.id, task.id, attempt.id, approval.toolCall.name),
              );
            return allowed;
          },
        );
        const updated = store.finishTaskAttempt(session.id, task.id, attempt.id, {
          resolvedEffectIds: verified.evidence.checks.flatMap((check) =>
            check.command && !check.command.timedOut
              ? [acceptanceEffects.get(check.id)].filter((id): id is string => Boolean(id))
              : [],
          ),
          status: verified.passed ? 'completed' : 'needs_review',
          verification: verified.evidence,
          ...(verified.error ? { error: verified.error } : {}),
          acceptance: verified.acceptance,
          steps: verified.steps,
        });
        process.stdout.write(
          JSON.stringify(
            { task: updated, attempt: store.getTaskAttempt(session.id, task.id, attempt.id) },
            null,
            options.json ? undefined : 2,
          ) + '\n',
        );
        process.exitCode = updated.status === 'completed' ? 0 : 1;
      } catch (error) {
        store.finishTaskAttempt(session.id, task.id, attempt.id, {
          status: 'blocked',
          error: safeError(error),
        });
        throw error;
      }
      return;
    }
    if (command === 'task-create') {
      const specFile = path.resolve(args[1]!);
      const stat = statSync(specFile);
      if (!stat.isFile() || stat.size > 256_000)
        throw new Error('Task spec must be a JSON file <=256KB');
      const spec = JSON.parse(
        readFileSync(specFile, 'utf8'),
      ) as import('../../packages/storage/sqlite.ts').TaskCreate;
      process.stdout.write(
        JSON.stringify(store.createTask(args[0]!, spec), null, options.json ? undefined : 2) + '\n',
      );
      return;
    }
    const existing =
      command === 'resume' || command === 'task-retry' || command === 'plan-execute'
        ? store.get(args[0]!)
        : undefined;
    const workspace = resolveWorkspace(existing?.workspace ?? options.workspace ?? process.cwd());
    if (existing && options.workspace && resolveWorkspace(options.workspace) !== workspace)
      throw new Error('Session belongs to a different workspace');
    const controller = new AbortController();
    const abort = () => controller.abort();
    process.on('SIGINT', abort);
    process.on('SIGTERM', abort);
    // Hooks are loaded once per invocation and shared with the agent's tool registry, so session,
    // prompt, stop and tool hooks all see the same state.
    const hooks = await loadHookRegistry(
      options.hooks ?? process.env.YUANTU_HOOKS_MODULE,
      workspace,
    );
    /**
     * The CLI's own runtime invariant registry, built the same way the Host builds one.
     *
     * A one-shot invocation has no long-lived process to report into, so the point here is different: the
     * promises are checked before this invocation's result is printed, and a broken one turns the run into a
     * `failed` run rather than a `completed` one nobody can trust.
     */
    const invariants = new InvariantRegistry({
      timeoutMs: resolveRunLimits(options).invariantTimeoutMs,
    });
    invariants.register(logTablesAgreeInvariant(store));
    invariants.register(emittedEventTypesInvariant());
    invariants.register(pipelineStagesInvariant());
    let sessionId: string | undefined;
    /**
     * The plan as the last `todo_write` left it, so a plan change can be described rather than only listed.
     *
     * Seeded from the session's own log when this invocation resumes one, because "changed" is a statement
     * about two versions: a second `--session` run that starts from an empty list would report the whole plan
     * as newly added.
     */
    let previousPlan: TodoItem[] = [];
    /**
     * Resident sub-agents live as long as this invocation does.
     *
     * The CLI is one-shot, so residency buys exactly one thing here: a run can ask a child it delegated to
     * for a follow-up without delegating the same ground again. Disposal is child-first and happens before
     * the store closes, so a child's tools are released while its session can still be written to.
     */
    const residency = new SubAgentResidency();
    /**
     * The invocation's terminals.
     *
     * The CLI is one-shot, so "the process owns them" and "this invocation owns them" are the same statement; the
     * scope they are opened under is this process's, because the CLI never passes a per-session scope to
     * `createAgent`. A terminal only helps here while the process lives, which is exactly one command.
     */
    const terminals = new TerminalSessions(workspace);
    try {
      const agent = createAgent(
        store,
        workspace,
        options,
        approve,
        // Read at request time: `--permission-policy` is fixed for this invocation, but keeping it a getter
        // means a host that can change the policy mid-session needs no separate wiring.
        () => permissionPolicy,
        (event) => {
          if (options.json) process.stdout.write(JSON.stringify({ type: 'event', event }) + '\n');
          else if (event.type === 'message.delta')
            process.stdout.write(display(String(event.data.text)));
          else if (event.type === 'tool.started')
            process.stderr.write(
              `\n[tool] ${display(String((event.data.call as { name: string }).name))}\n`,
            );
          else if (event.type === 'tool.finished' && event.data.isError)
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
          // The checklist goes to stderr with the rest of the progress: it is state the user watches, not
          // part of the answer, and stdout stays clean for a caller that pipes the reply. The change line
          // comes first, because the list below it is the *result* of that change.
          else if (event.type === 'context.forecast') {
            /**
             * What this round's window is being spent on — printed when that answer *changes something*.
             *
             * Not every round: a line per round in a fifty-round run is a ticker nobody reads. The numbers that
             * matter are the fixed cost (the tool schemas, which do not move once a run starts) and the moments
             * the budget was acted on — a compaction, a shortening, a problem — so the first round is printed as
             * the baseline the rest are read against, and `--json` carries every round for a caller that wants
             * the series. The same reasoning as the `[model]` line above, which is also an event, not a ticker.
             */
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
            if (round === 0 || acted) {
              const total = breakdown?.total ?? Number(event.data.inputTokens ?? 0);
              const raw = Number(event.data.rawInputTokens ?? total);
              const notes = [
                event.data.compacted === true ? 'compacted' : '',
                Number(event.data.shortened ?? 0) > 0
                  ? `${Number(event.data.shortened)} shortened`
                  : '',
                Number(event.data.pruned ?? 0) > 0 ? `${Number(event.data.pruned)} pruned` : '',
                event.data.problem ? `problem: ${display(String(event.data.problem))}` : '',
                event.data.policyProblem
                  ? `policy: ${display(String(event.data.policyProblem))}`
                  : '',
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
          }
          // The checklist goes to stderr with the rest of the progress: it is state the user watches, not
          // part of the answer, and stdout stays clean for a caller that pipes the reply. The change line
          // comes first, because the list below it is the *result* of that change.
          else if (event.type === 'todo.written') {
            const todos = (event.data.todos ?? []) as TodoItem[];
            // Derived here rather than read off the event: consecutive `todo.written` events are the two
            // versions, and the shared fold is what the panel, a reload and this line all use.
            const summary = describeTodoChange(todoDiff(previousPlan, todos));
            previousPlan = todos;
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
        },
        undefined,
        undefined,
        hooks,
        residency,
        question,
        invariants,
        terminals,
      );
      const session = existing ?? store.create(workspace);
      sessionId = session.id;
      if (existing) previousPlan = store.todos(session.id);
      const retryTaskId = command === 'task-retry' ? args[1]! : undefined;
      /**
       * `plan-execute` re-checks the approval the same way the Host does — one implementation of the
       * gate, in the store — before anything runs. `plan` is the read-only planning phase, and it
       * ends by asking a human; without a TTY it stops and prints the hash to approve with.
       */
      const planCommand = command === 'plan' || command === 'plan-execute';
      let executingPlan: Plan | undefined;
      if (command === 'plan-execute') {
        const current = store.getPlan(session.id, args[1]!);
        // The hash proves the human approved the text that is on the row now, so it is compared
        // before the approval is recorded rather than after.
        if (current.hash !== args[2]!)
          throw new Error('The supplied hash does not match this plan; re-read it with plan-show');
        if (current.status === 'proposed') store.approvePlan(session.id, current.id, args[2]!);
        // Then the same gate the Host uses, so approval and execution cannot disagree.
        executingPlan = store.executablePlan(session.id, current.id);
      }
      const latestRun = retryTaskId
        ? store
            .listTaskAttempts(session.id, retryTaskId)
            .filter((attempt) => attempt.kind === 'run')
            .at(-1)
        : undefined;
      const prompt =
        command === 'task-retry'
          ? args[2]?.trim() || latestRun?.prompt
          : planCommand
            ? command === 'plan-execute'
              ? `${executingPlan!.title}\n\n${executingPlan!.summary}`.trim()
              : args[0]!
            : args[existing ? 1 : 0]!;
      if (!prompt) throw new Error('Task has no prior run prompt; provide prompt');
      await reconcilePendingFileChanges(store, session.id, workspace);
      if (!options.json) process.stderr.write(`Session: ${session.id}\nWorkspace: ${workspace}\n`);
      for (const failure of await hooks.sessionStart(
        { sessionId: session.id, workspace, resumed: Boolean(existing) },
        controller.signal,
      ))
        process.stderr.write(`sessionStart hook failed: ${failure}\n`);
      /**
       * A session that was planning when it stopped is still planning.
       *
       * Plan mode is a promise that this run cannot change anything, and it lived only in the request that started
       * it: `plan` created the row and passed `planPhase`, and `resume` passed neither, so a session whose
       * planning run ended without submitting — the user's Stop, a crash, a lost terminal — came back as an
       * ordinary run with the full tool set. The write it then made would have been refused a moment earlier.
       *
       * The rule itself lives in `store.planMode`, because the Host asks the same question and the two answers
       * have to agree.
       */
      const resumed = command === 'resume' ? store.planMode(session.id) : null;
      const plan =
        command === 'plan'
          ? store.createPlan(session.id)
          : resumed?.planId
            ? { id: resumed.planId }
            : undefined;
      let result = await agent.run({
        sessionId: session.id,
        prompt,
        ...(plan ? { planPhase: true, planId: plan.id } : {}),
        ...(executingPlan ? { approvedPlan: executingPlan } : {}),
        images: validateImages(
          (options.images ?? []).map((file) => {
            const absolute = path.resolve(file);
            const stat = statSync(absolute);
            if (!stat.isFile() || stat.size > MAX_IMAGE_BYTES)
              throw new Error('Image must be a regular file <=5MB');
            const extension = path.extname(file).toLowerCase();
            const types: Record<string, string> = {
              '.png': 'image/png',
              '.jpg': 'image/jpeg',
              '.jpeg': 'image/jpeg',
              '.gif': 'image/gif',
              '.webp': 'image/webp',
            };
            return {
              mimeType: types[extension],
              data: readFileSync(absolute).toString('base64'),
              name: path.basename(file),
            };
          }),
        ),
        signal: controller.signal,
        ...(retryTaskId
          ? { taskId: retryTaskId }
          : options.taskId
            ? { taskId: options.taskId }
            : {}),
      });
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
      const cacheNote = (usage: Usage): string => {
        const read = usage.cachedInputTokens;
        const written = usage.cacheWriteInputTokens ?? 0;
        const parts: string[] = [];
        if (read !== undefined && usage.inputTokens > 0)
          parts.push(`${Math.round((read / usage.inputTokens) * 100)}% hit`);
        if (read !== undefined) parts.push(`${read} of ${usage.inputTokens} read`);
        if (written > 0) parts.push(`${written} written`);
        return parts.length ? ` (cache: ${parts.join(', ')})` : '';
      };
      const report = (outcome: typeof result): void => {
        if (options.json)
          process.stdout.write(JSON.stringify({ type: 'result', result: outcome }) + '\n');
        else {
          process.stdout.write('\n');
          process.stderr.write(
            `[${outcome.status}] tokens: ${outcome.usage.inputTokens} in / ${outcome.usage.outputTokens} out${cacheNote(outcome.usage)}${outcome.error ? ' — ' + display(outcome.error) : ''}${outcome.code ? ` (${outcome.code})` : ''}\n`,
          );
        }
      };
      const exitCodeFor = (outcome: typeof result): number =>
        outcome.status === 'completed'
          ? 0
          : outcome.status === 'cancelled'
            ? 130
            : outcome.status === 'limited'
              ? 2
              : 1;
      report(result);
      process.exitCode = exitCodeFor(result);
      /**
       * Rounds a goal starts on its own.
       *
       * A goal is the session's own statement of what it is trying to achieve, and until now nothing ever
       * started the run that would continue it — the next command did. With a goal active, this invocation
       * keeps going: each round is an ordinary run (its own step, tool and time limits), the goal's own round
       * budget bounds how many, and the loop stops on a terminal goal, a spent budget, a round that did not
       * finish, or the user's interrupt. Only `run` and `resume` continue, and only when this invocation is not
       * a planning run: a task retry is a deliberate single attempt, a plan ends by handing a decision to a
       * human, and a planning run may not touch the goal at all — the goal tools are not registered in that
       * phase (`ownWork` excludes it), so a round started for one would be spent on work the run cannot do.
       * `resume` *is* a planning run when the session stopped mid-plan, and there the continuation would be
       * worse than idle: it is an ordinary run, which is the escape resuming mid-plan exists to close. The Host
       * draws the same line for the same three kinds of run (`!plan && !plannedTaskId && !approvedPlan`), so
       * this is the two carriers agreeing rather than a rule invented here.
       */
      if ((command === 'run' || command === 'resume') && !plan) {
        const rounds = await runGoalRounds({
          // The same second bound the Host uses, and not the goal's own ceiling: `max_goal_rounds` is a record
          // the model may raise, and a loop bounded only by it is a loop the thing it bounds can extend.
          maxContinuations: GOAL_CONTINUATIONS_PER_REQUEST,
          signal: controller.signal,
          goalOf: () => store.goal(session.id),
          /**
           * The continuation is narrated on stderr in every mode, json included: it is an event like
           * `[model]` and `[retry]`, and a machine-readable run that silently sat through four rounds
           * would be the hardest one to explain afterwards.
           */
          onRound: (continuation) => {
            process.stderr.write(`[goal] round ${continuation.round}\n`);
          },
          // A spent budget leaves the goal `active`, which reads as "more rounds are coming" when none are.
          // The verdict is written through the same durable event every other goal change uses.
          onExhausted: (goal) => {
            const verdict = exhaustedGoalVerdict(goal, new Date().toISOString());
            if (!verdict) return;
            store.recordEvent(session.id, 'goal.changed', { action: 'blocked', goal: verdict });
            process.stderr.write(`[goal] ${goalLine(verdict)}\n`);
          },
          runOnce: async (prompt) => {
            result = await agent.run({
              sessionId: session.id,
              prompt,
              signal: controller.signal,
              // Started by the runtime to carry the goal forward, not by the user: it may report on the goal but
              // not change who is in charge of it (see `HUMAN_ONLY_GOAL_ACTIONS`).
              authority: 'automatic',
            });
            report(result);
            return { status: result.status };
          },
        });
        if (rounds.continuations > 0) {
          process.stderr.write(
            `[goal] stopped after ${rounds.continuations} round(s): ${rounds.stopped}\n`,
          );
          process.exitCode = exitCodeFor(result);
        }
      }
      /**
       * A planning run ends by handing the decision to a human. With a TTY we can ask; without one we
       * stop and print the exact approval command, because a non-interactive run must never approve
       * its own plan.
       */
      if (plan) {
        const proposed = store.latestPlan(session.id)!;
        if (!options.json) {
          process.stdout.write(`\n${proposed.title}\n`);
          if (proposed.summary) process.stdout.write(`${proposed.summary}\n`);
          for (const [index, step] of proposed.steps.entries())
            process.stdout.write(`  ${index + 1}. ${step.description}\n`);
        }
        // These commands must reopen the store that actually contains the reviewed plan, including
        // --db/--workspace invocations. Quote for the operator's PowerShell or POSIX shell.
        const quote = (value: string) =>
          "'" + value.replaceAll("'", process.platform === 'win32' ? "''" : "'\\''") + "'";
        const route = `--db ${quote(sessionDatabasePath(options))} --workspace ${quote(workspace)}`;
        const reviewCommand = `npm run dev -- plan-show ${session.id} ${route}`;
        const approveCommand = `npm run dev -- plan-execute ${session.id} ${proposed.id} ${proposed.hash} ${route}`;
        if (options.json) {
          process.stdout.write(
            JSON.stringify({ type: 'plan', plan: proposed, reviewCommand, approveCommand }) + '\n',
          );
        } else if (process.stdin.isTTY && process.stdout.isTTY) {
          const answer = await ask(`\nApprove and execute this plan? [y/N] `);
          if (answer.trim().toLowerCase() === 'y') {
            store.approvePlan(session.id, proposed.id, proposed.hash);
            const executed = await agent.run({
              sessionId: session.id,
              prompt: `${proposed.title}\n\n${proposed.summary}`.trim(),
              approvedPlan: store.executablePlan(session.id, proposed.id),
              signal: controller.signal,
            });
            process.stdout.write(`\n[${executed.status}] ${display(executed.text)}\n`);
            process.exitCode = executed.status === 'completed' ? 0 : 1;
          } else {
            process.stderr.write(`\nPlan left unapproved.\n`);
          }
        } else {
          process.stderr.write(
            `\nReview, then run (${process.platform === 'win32' ? 'PowerShell' : 'POSIX shell'}):\n  ${reviewCommand}\n  ${approveCommand}\n`,
          );
        }
      }
    } finally {
      process.off('SIGINT', abort);
      process.off('SIGTERM', abort);
      // The CLI is one-shot, so the host-shutdown path is simply the end of this invocation. Resident
      // children are released before the store closes, deepest first, and any terminal this run opened is
      // closed with them: the pty holds a real process, and nothing would outlive this invocation to close it.
      try {
        await terminals.closeAllAndWait();
      } finally {
        await residency.disposeAll().catch(() => undefined);
        if (sessionId) {
          const failures = await hooks
            .sessionEnd({ sessionId, reason: 'shutdown' }, new AbortController().signal)
            .catch(() => []);
          for (const failure of failures)
            process.stderr.write(`sessionEnd hook failed: ${failure}\n`);
        }
        await hooks.close().catch(() => undefined);
      }
    }
  } finally {
    store.close();
  }
}
await main().catch((error) => {
  process.stderr.write(display(safeError(error)) + '\n');
  process.exitCode = 1;
});
