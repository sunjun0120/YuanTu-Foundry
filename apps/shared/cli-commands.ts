/**
 * The CLI's command vocabulary, in one place because three readers ask about it.
 *
 * `apps/cli/main.ts` renders its `Usage:` block from this list, `scripts/docs-facts.mjs` counts it for the
 * README's generated facts, and `tests/cli.test.ts` checks that the rendered help and this list are the same
 * thing. Before it existed the count lived in two hand-written sentences — the reader was told "17 个运行型
 * 命令 + 四个不需密钥的命令" while the program's own help listed five — and nothing could fail when they
 * disagreed, which is exactly the defect the generated facts block exists to make impossible.
 *
 * `runs` is not decoration: it answers "does this command need model credentials", which is the sentence the
 * help's closing lines and the README both make, and it is the distinction that had drifted.
 */
export interface CliCommand {
  /** The word the user types after the program name. */
  name: string;
  /** Usage line without the program prefix; the help block indents it and the README quotes it verbatim. */
  usage: string;
  /** True when the command starts or resumes a run and therefore needs a configured model. */
  runs: boolean;
}
export const CLI_COMMANDS: readonly CliCommand[] = [
  { name: 'run', usage: 'run "task" [options]', runs: true },
  { name: 'resume', usage: 'resume <session-id> "follow-up" [options]', runs: true },
  { name: 'plan', usage: 'plan "task" [options]', runs: true },
  {
    name: 'plan-execute',
    usage: 'plan-execute <session-id> <plan-id> <hash> [options]',
    runs: true,
  },
  {
    name: 'task-retry',
    usage: 'task-retry <session-id> <task-id> ["prompt"] [options]',
    runs: true,
  },
  { name: 'sessions', usage: 'sessions [--db path] [--json]', runs: false },
  { name: 'show', usage: 'show <session-id> [--db path] [--json]', runs: false },
  { name: 'plan-show', usage: 'plan-show <session-id> [--db path] [--json]', runs: false },
  { name: 'task-create', usage: 'task-create <session-id> <spec.json> [--db path]', runs: false },
  { name: 'tasks', usage: 'tasks <session-id> [--db path] [--json]', runs: false },
  { name: 'task', usage: 'task <session-id> <task-id> [--db path] [--json]', runs: false },
  {
    name: 'task-attempts',
    usage: 'task-attempts <session-id> <task-id> [--db path] [--json]',
    runs: false,
  },
  {
    name: 'task-steps',
    usage: 'task-steps <session-id> <task-id> [--db path] [--json]',
    runs: false,
  },
  {
    name: 'task-trigger',
    usage: 'task-trigger <session-id> <task-id> <trigger.json|off> [--db path] [--json]',
    runs: false,
  },
  { name: 'task-schedule', usage: 'task-schedule [--db path] [--json]', runs: false },
  {
    name: 'task-approval',
    usage: 'task-approval <session-id> <task-id> <approval-id> <allow|deny> [--db path] [--json]',
    runs: false,
  },
  {
    name: 'task-verify',
    usage: 'task-verify <session-id> <task-id> [--db path] [--json]',
    runs: false,
  },
  { name: 'resources', usage: 'resources [--workspace directory]', runs: false },
  { name: 'env', usage: 'env [--json]', runs: false },
  { name: 'models', usage: 'models [--json]', runs: false },
  { name: 'mcp list', usage: 'mcp list [--workspace directory]', runs: false },
  {
    name: 'mcp authorize',
    usage: 'mcp authorize <server-id> [--workspace directory]',
    runs: false,
  },
  { name: 'mcp revoke', usage: 'mcp revoke <server-id> [--workspace directory]', runs: false },
  { name: 'credentials list', usage: 'credentials list', runs: false },
  {
    name: 'credentials set',
    usage: 'credentials set <protocol>   (the key is read from standard input)',
    runs: false,
  },
];
/**
 * Maintenance commands that exist and are dispatched, but are not part of the task vocabulary the `Usage:`
 * block teaches; they act on the database file rather than on a session.
 */
export const CLI_MAINTENANCE_COMMANDS: readonly CliCommand[] = [
  { name: 'db-backup', usage: 'db-backup --db <file> [--json]', runs: false },
  { name: 'db-verify', usage: 'db-verify <file> [--json]', runs: false },
  {
    name: 'db-restore',
    usage: 'db-restore <backup-file> --db <file> [--json]  (close Host/CLI first)',
    runs: false,
  },
  {
    name: 'db-recover',
    usage: 'db-recover --db <file> [--json]              (interrupted restore rollback)',
    runs: false,
  },
];
/** Every word the parser will dispatch, maintenance included. */
export const CLI_COMMAND_NAMES: readonly string[] = [
  ...CLI_COMMANDS.map((command) => command.name),
  ...CLI_MAINTENANCE_COMMANDS.map((command) => command.name),
];
/** How many commands a run needs a model for. */
export const countCliRunCommands = (): number =>
  CLI_COMMANDS.filter((command) => command.runs).length +
  CLI_MAINTENANCE_COMMANDS.filter((command) => command.runs).length;
