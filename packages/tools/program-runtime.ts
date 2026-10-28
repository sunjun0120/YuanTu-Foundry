/**
 * The program runner's protocol and limits.
 *
 * This module must stay inside `packages/tools` and free of imports: `code-process-entry.ts` runs under Node's
 * permission model with read access to this directory only, so anything it imports from another package is a
 * file it is not allowed to open.
 */

/** Owned broker protocol and deployment runtime floor. */
export const PROGRAM_PROTOCOL = 1;
export const PROGRAM_NODE_MAJOR = 24;

/**
 * The heap a guest worker may use, and why there has to be a number.
 *
 * `run_code` and `workflow` run a model's JavaScript in a worker thread. A worker created without
 * `resourceLimits` inherits the process's own heap, so a program that allocates without bound does not fail — it
 * takes down the *host*: the session store, the run that is in flight, every other session in the process. The
 * isolation these tools promise for guest code has always been termination rather than a sandbox (see the note on
 * `workerExecArgv` in `packages/platform/child-environment.ts`), and a ceiling is what makes "the guest dies" true
 * instead of "everything dies".
 *
 * Generous on purpose. A program gets its data through tools whose results are bounded in the kilobytes, so a
 * quarter of a gigabyte is far more than any script this runtime hands over needs: this is a wall for a runaway
 * allocation, not a budget for real work, and a limit tight enough to refuse legitimate work would be the worse
 * failure of the two.
 */
export const GUEST_HEAP_MB = 256;

/**
 * The worker options that bound a guest, in one place because two runners have to agree about them.
 *
 * A function rather than a shared object because Node reads the limits when the worker starts; handing the same
 * mutable object to two workers would let a later change reach a worker that has already been created.
 */
export function guestResourceLimits(): { maxOldGenerationSizeMb: number } {
  return { maxOldGenerationSizeMb: GUEST_HEAP_MB };
}
