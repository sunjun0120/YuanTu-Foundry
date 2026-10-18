/**
 * Bounds one step of the quit sequence.
 *
 * Quitting is the one flow that must finish: the window's close has already been turned into `app.quit()`, so a
 * step that never settles leaves a process with no window that cannot be closed again. Each awaited step gets a
 * deadline; when one expires the caller is told which step it was, and the quit continues instead of waiting.
 *
 * The number is deliberately larger than the components' own timeouts: the Host client gives a Host ten seconds to
 * exit before killing it, so an ordinary slow shutdown finishes on its own terms and only a stuck one reaches this.
 */
export const QUIT_DEADLINE_MS = 15_000;

/** Which step missed its deadline. The message is shown in the quit failure dialog, so it names the step. */
export class QuitDeadlineError extends Error {
  constructor(what: string, ms: number) {
    super(`${what} did not finish within ${ms}ms`);
    this.name = 'QuitDeadlineError';
  }
}

/**
 * Resolves or rejects like `work`, but never waits longer than `ms`.
 *
 * An absent step is not a step: `undefined` resolves immediately, which is what an optional service's `stop()`
 * returns when there is nothing to stop. A rejection is passed through unchanged — only a deadline is a deadline.
 */
export function withinQuitDeadline<T>(
  work: Promise<T> | undefined,
  what: string,
  ms = QUIT_DEADLINE_MS,
): Promise<T | undefined> {
  if (!work) return Promise.resolve(undefined);
  return new Promise<T | undefined>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new QuitDeadlineError(what, ms));
    }, ms);
    // A pending quit step must not be the reason a process stays alive after the deadline has been reported.
    timer.unref?.();
    work.then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}
