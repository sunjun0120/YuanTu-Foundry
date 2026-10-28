import { CLI_COMMANDS, CLI_MAINTENANCE_COMMANDS } from '../shared/cli-commands.ts';
import { SUBAGENT_CEILINGS, SUBAGENT_DEFAULTS } from '../../packages/core/subagents/delegation.ts';
import { RUN_DEFAULTS } from '../../packages/protocol/settings.ts';

export const HELP = `YuanTu Agent — independent coding agent (Node.js >=24)

Usage:
${CLI_COMMANDS.map((command) => `  npm run dev -- ${command.usage}`).join('\n')}

Maintenance (acts on the database file, not on a session):
${CLI_MAINTENANCE_COMMANDS.map((command) => `  npm run dev -- ${command.usage}`).join('\n')}

Options:
  --workspace <directory>    Existing project directory (default: cwd)
  --db <file>                SQLite file (default: <workspace>/.yuantu/sessions.sqlite)
  --permission-policy <file> Explicit trusted JSON approval rules, fixed at startup
  --hooks <module>           Trusted JS hooks module; must resolve outside the workspace
  --allow-write              Allow file edits/creation without per-call prompts
  --allow-command            Allow host shell commands without per-call prompts (not sandboxed)
  --json                     JSONL events and final result; noninteractive approval denies by default
  --image <path>             Attach a PNG/JPEG/GIF/WebP image (repeat up to 4 times)
  --max-context-tokens <n>   Model context window; omit to let the budget be resolved automatically
  --auto-compact-tokens <n>  Compact before the configured context window fills
  --max-context-chars <n>    Additional context character guard (default: ${RUN_DEFAULTS.maxContextChars})
  --max-output-tokens <n>    Per-request output limit (default: ${RUN_DEFAULTS.maxOutputTokens})
  --request-timeout-ms <n>   Optional total model request timeout; active streams use idle timeout
  --max-parallel-tools <n>   Sibling tool calls running at once, 1 = strictly serial (default: ${RUN_DEFAULTS.maxParallelToolCalls}; only tools that promise it overlap)
  --max-run-rounds <n>       Model rounds one run may take, 0 = no cap (default: no cap)
  --max-run-ms <n>           Wall clock one run may take, 0 = no cap (default: ${RUN_DEFAULTS.maxRunMs / 3_600_000}h)
  --max-run-tokens <n>       Model tokens (input + output, all rounds) one run may use, 0 = no cap (default: ${RUN_DEFAULTS.maxRunTokens})
  --no-subagents             Disable sub-agent delegation (also YUANTU_SUBAGENTS=off)
  --subagent-concurrency <n> Sub-agents running at once, 1-16 (capped at ${SUBAGENT_CEILINGS.maxConcurrency}; default: ${SUBAGENT_DEFAULTS.maxConcurrency})
  --subagent-timeout-ms <n>  Stop a sub-agent after this long with no progress; 0 = no watchdog (default: ${Math.round(SUBAGENT_DEFAULTS.timeoutMs / 1000)}s)
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
  YUANTU_MCP_OAUTH_DIR                 MCP credential directory (default: ~/.yuantu/mcp-oauth)
  YUANTU_CREDENTIALS_FILE              File "credentials set" writes to (default: ~/.yuantu/credentials.json)

The names above are the common ones; \`env\` lists every setting this program reads, with its shape and the
value in this process, straight from the table the program uses.

Ctrl+C cancels the model request or foreground command. Existing side effects remain.
No API key is needed for help, maintenance, sessions, show, resources, env, models, mcp or credentials.
MCP authorization happens outside a run: "mcp authorize" prints a browser URL and waits for the
loopback callback, and tokens never touch .yuantu/mcp.json. Commands use cmd.exe on Windows.
`;
