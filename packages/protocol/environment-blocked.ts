/**
 * A failure that belongs to the machine, not the call (e.g. a stale Windows sandbox lease, a
 * missing Office script): every call fails the same until a person fixes the environment. The
 * prefix lets the run loop recognise the class and stop retrying.
 */
export const ENVIRONMENT_BLOCKED_PREFIX = 'Environment blocked';

/**
 * The text of an environment blocker, for an error class that has to stay its own (callers catch
 * `OfficeUnavailableError` to try another engine) but should still be recognised as one.
 *
 * @param code A stable reason, the same for every call the blocker refuses (`windows-sandbox-stale-lease`).
 * @param detail What is wrong, in one or two sentences.
 * @param remedy What to do instead, or what a person has to do; the model can only relay the latter.
 */
export function environmentBlockedMessage(code: string, detail: string, remedy: string): string {
  return (
    `${ENVIRONMENT_BLOCKED_PREFIX} [${code}]: ${detail} ${remedy} ` +
    'This is a property of the environment, not of this call: retrying it or a variation of it will fail the ' +
    'same way until a person resolves it. Do not retry; continue with what does not need it, and report the ' +
    'blocker and what remains unverified.'
  );
}

export class EnvironmentBlockedError extends Error {
  readonly code: string;
  constructor(code: string, detail: string, remedy: string) {
    super(environmentBlockedMessage(code, detail, remedy));
    this.name = 'EnvironmentBlockedError';
    this.code = code;
  }
}

/** The blocker's code when `content` is an environment-blocked tool result, otherwise undefined. */
export function environmentBlockedCode(content: string): string | undefined {
  if (!content.startsWith(ENVIRONMENT_BLOCKED_PREFIX)) return undefined;
  return /^Environment blocked \[([a-z0-9-]+)\]:/.exec(content)?.[1];
}
