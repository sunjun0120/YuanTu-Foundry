import { resourceEntries, resourceText } from './files.ts';
import { RUN_DEFAULTS, parseSetting, resolveRunLimits } from '../protocol/settings.ts';
/**
 * The Claude Code hook contract, as a declaration file.
 *
 * This is deliberately *not* one of our own formats. Claude Code's hook JSON is the de-facto shape other
 * agent tooling already writes, so reading it means a project's existing hooks work here without being
 * rewritten — and it means the contract is documented by somebody other than us. The one thing we add is a
 * second, identical location under our own directory for projects that do not want a `.claude` folder.
 */
export const CLAUDE_HOOK_EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'Stop',
  'SessionEnd',
] as const;
export type ClaudeHookEvent = (typeof CLAUDE_HOOK_EVENTS)[number];
/**
 * Where declarations are looked for. Both may exist: later files append, they never replace.
 *
 * `owned` decides how strict the parse is, and it is the interesting part. `.yuantu/hooks.json` exists only
 * for us, so anything in it that we do not understand is a typo and is an error. `.claude/settings.json`
 * belongs to Claude Code: it holds permissions, a model, environment variables and hook events this build
 * does not implement, and refusing to start in a workspace that Claude Code is already configured in would
 * make the bridge useless in exactly the projects that have hooks to bridge. So we read the one key we
 * consume and leave the rest of somebody else's file alone.
 */
export const HOOK_CONFIG_FILES = [
  { path: '.claude/settings.json', owned: false },
  { path: '.yuantu/hooks.json', owned: true },
] as const;
/** Bounded like every other workspace-supplied list: a runaway file must not become unbounded work. */
export const MAX_HOOK_COMMANDS = 64;
/** The same bound the extension manifest uses for a command, for the same reason. */
export const MAX_HOOK_COMMAND_LENGTH = 16_000;
/** Each declaration's file, event, optional matcher and the commands it runs. */
export interface HookDeclaration {
  /** The file it came from, so a failure at run time can say where the hook was declared. */
  file: string;
  event: ClaudeHookEvent;
  /** `|`-separated subject patterns. Absent means "every subject this event has". */
  matcher?: string;
  command: string;
  timeoutMs: number;
}
export interface HookBridgeSettings {
  /** Opt-out, not opt-in: a workspace that declares hooks gets them unless an operator says no. */
  enabled: boolean;
  timeoutMs: number;
  /**
   * Where a hook that misbehaved is reported.
   *
   * Part of the settings rather than hard-wired to stderr because it is a seam, not a policy: the CLI and the
   * Host both want stderr, an embedder wants its own log, and a test wants to read it.
   */
  onFailure?: (message: string) => void;
}
/**
 * The bridge's two settings, read through the one table.
 *
 * They are read here rather than being threaded through the run options because a tool registry is built
 * without them (`createTools` has no `Options`), and inventing a second place for the defaults is exactly
 * what `packages/protocol/settings.ts` exists to prevent.
 */
export function hookBridgeSettings(env: NodeJS.ProcessEnv = process.env): HookBridgeSettings {
  return {
    enabled: parseSetting(env, 'YUANTU_HOOK_BRIDGE') !== false,
    timeoutMs: resolveRunLimits({
      hookTimeoutMs: parseSetting(env, 'YUANTU_HOOK_TIMEOUT_MS') as number | undefined,
    }).hookTimeoutMs,
  };
}
/**
 * A `|`-separated pattern list against one subject, with `*` allowed.
 *
 * Translation rather than a glob library: the pattern language is two characters wide (`|` and `*`), and a
 * dependency for that would be the only one in the project. An absent matcher matches everything; an event
 * with no subject only matches `*` or nothing at all, which is how a matcher written for another event
 * degrades to "never runs" instead of "always runs".
 */
export function hookMatcherMatches(
  matcher: string | undefined,
  subject: string | undefined,
): boolean {
  if (matcher === undefined || matcher === '*' || matcher.trim() === '') return true;
  if (subject === undefined) return false;
  return matcher.split('|').some((pattern) => {
    const trimmed = pattern.trim();
    if (!trimmed) return false;
    if (trimmed === '*') return true;
    const expression = new RegExp(
      '^' + trimmed.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\\\*/g, '.*') + '$',
    );
    return expression.test(subject);
  });
}
function parseFile(
  workspace: string,
  relative: string,
  owned: boolean,
  defaultTimeoutMs: number,
): HookDeclaration[] {
  const source = resourceText(workspace, relative);
  // A bare SyntaxError from JSON.parse does not name the offending file, which is the first thing an
  // operator needs when a workspace declares several hook files. The read stays outside the try so a real
  // I/O failure is not misreported as malformed JSON.
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch (error) {
    throw new Error(
      `Invalid hook config ${relative}: not valid JSON (${error instanceof Error ? error.message : String(error)})`,
    );
  }
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error(`Invalid hook config ${relative}: expected a JSON object`);
  const root = value as Record<string, unknown>;
  if (owned)
    for (const key of Object.keys(root))
      if (key !== 'hooks')
        throw new Error(
          `Invalid hook config ${relative}: unknown key "${key}" (only "hooks" is read)`,
        );
  const hooks = root.hooks;
  if (hooks === undefined) return [];
  if (!hooks || typeof hooks !== 'object' || Array.isArray(hooks))
    throw new Error(`Invalid hook config ${relative}: "hooks" must be an object`);
  const declarations: HookDeclaration[] = [];
  for (const [event, entries] of Object.entries(hooks as Record<string, unknown>)) {
    // An event this build does not implement is skipped in somebody else's file and refused in ours: see
    // `HOOK_CONFIG_FILES`. Half-running a policy the operator believes is installed is the failure mode
    // both halves of that rule exist to avoid.
    if (!(CLAUDE_HOOK_EVENTS as readonly string[]).includes(event)) {
      if (!owned) continue;
      throw new Error(
        `Invalid hook config ${relative}: unknown hook event "${event}"; known events are ${CLAUDE_HOOK_EVENTS.join(', ')}`,
      );
    }
    if (!Array.isArray(entries))
      throw new Error(`Invalid hook config ${relative}: "${event}" must be an array`);
    for (const entry of entries) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry))
        throw new Error(
          `Invalid hook config ${relative}: every "${event}" entry must be an object`,
        );
      const declaration = entry as Record<string, unknown>;
      for (const key of Object.keys(declaration))
        if (!['matcher', 'hooks'].includes(key))
          throw new Error(
            `Invalid hook config ${relative}: unknown key "${key}" in a "${event}" entry`,
          );
      const matcher = declaration.matcher;
      if (matcher !== undefined && (typeof matcher !== 'string' || matcher.length > 512))
        throw new Error(`Invalid hook config ${relative}: "${event}" matcher must be a string`);
      if (!Array.isArray(declaration.hooks) || !declaration.hooks.length)
        throw new Error(
          `Invalid hook config ${relative}: "${event}" needs a non-empty "hooks" array`,
        );
      for (const hook of declaration.hooks) {
        if (!hook || typeof hook !== 'object' || Array.isArray(hook))
          throw new Error(`Invalid hook config ${relative}: every hook must be an object`);
        const command = hook as Record<string, unknown>;
        for (const key of Object.keys(command))
          if (!['type', 'command', 'timeout'].includes(key))
            throw new Error(
              `Invalid hook config ${relative}: unknown key "${key}" in a hook (only type, command and timeout are read)`,
            );
        // `type` is present in every Claude Code hook and is always "command" today. Refusing anything
        // else is honest: this build runs commands, and silently ignoring a `type` it does not implement
        // would skip a hook the operator believes is installed.
        if (command.type !== undefined && command.type !== 'command')
          throw new Error(
            `Invalid hook config ${relative}: unsupported hook type "${String(command.type)}" (only "command" is implemented)`,
          );
        if (
          typeof command.command !== 'string' ||
          !command.command.trim() ||
          command.command.length > MAX_HOOK_COMMAND_LENGTH
        )
          throw new Error(
            `Invalid hook config ${relative}: "command" must be a non-empty string of at most ${MAX_HOOK_COMMAND_LENGTH} characters`,
          );
        const timeout = command.timeout;
        if (
          timeout !== undefined &&
          (!Number.isSafeInteger(timeout) || (timeout as number) < 1 || (timeout as number) > 600)
        )
          throw new Error(
            `Invalid hook config ${relative}: "timeout" is seconds, between 1 and 600`,
          );
        declarations.push({
          file: relative,
          event: event as ClaudeHookEvent,
          ...(matcher === undefined ? {} : { matcher: matcher as string }),
          command: command.command,
          // Claude Code writes `timeout` in **seconds**; ours are milliseconds everywhere else. Converting
          // here, at the one boundary where the other format's unit is known, is what keeps that from
          // leaking into the rest of the runtime.
          timeoutMs: timeout === undefined ? defaultTimeoutMs : (timeout as number) * 1000,
        });
      }
    }
  }
  if (declarations.length > MAX_HOOK_COMMANDS)
    throw new Error(
      `Invalid hook config ${relative}: ${declarations.length} hooks exceeds the limit of ${MAX_HOOK_COMMANDS}`,
    );
  return declarations;
}
/**
 * Every hook declaration the workspace makes, in load order.
 *
 * A missing file or directory is not an error — most workspaces declare none, and "no hooks" must cost
 * nothing. A file that exists but is malformed is an error that names it: silently ignoring a broken hook
 * config would leave an operator believing a policy is in force when it is not.
 */
export function loadHookDeclarations(
  workspace: string,
  defaultTimeoutMs: number = RUN_DEFAULTS.hookTimeoutMs,
): HookDeclaration[] {
  const declarations: HookDeclaration[] = [];
  for (const file of HOOK_CONFIG_FILES) {
    const [directory, name] = [
      file.path.slice(0, file.path.lastIndexOf('/')),
      file.path.slice(file.path.lastIndexOf('/') + 1),
    ];
    if (!resourceEntries(workspace, directory).includes(name)) continue;
    declarations.push(...parseFile(workspace, file.path, file.owned, defaultTimeoutMs));
    if (declarations.length > MAX_HOOK_COMMANDS)
      throw new Error(
        `Hook config declares ${declarations.length} hooks; the limit is ${MAX_HOOK_COMMANDS}`,
      );
  }
  return declarations;
}
