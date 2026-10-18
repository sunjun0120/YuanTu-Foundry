import { parseSetting } from '../../packages/protocol/settings.ts';
import { RESIDENCY_DEFAULTS } from '../../packages/core/residency.ts';
import { underSessionPolicy, sessionLifecycleReadOnly } from './session-policy.ts';
import { safeError } from '../shared/runtime.ts';
import { settleInteraction } from './approvals.ts';
import type { HostContext } from './state.ts';
import { cancelSessionTitles } from './session-title.ts';

/** The one resident release started by shutdown, observed immediately and awaited before store close. */
const residentCleanup = new WeakMap<HostContext, Promise<void>>();

/**
 * Stopping the Host: idempotent, and in the one order that does not lose work.
 *
 * Everything here is a resource with a process behind it, and the order is what makes closing them safe. The
 * runs are aborted first, so nothing is still writing when the store closes; the interaction maps settle next,
 * so an approval or a question never leaves a promise nobody will resolve; the residents are disposed *after*
 * the aborts, because an activation's in-flight turn is stopped by its own run's abort and the disposal then
 * waits for it to unwind before releasing that child's tools; and the carrier goes last, so a run unwinding from
 * the abort still has somewhere to report to.
 */
export function createShutdown(ctx: HostContext): () => void {
  return () => {
    if (ctx.closing) return;
    ctx.closing = true;
    ctx.stopObservingBackground();
    ctx.scheduler.stop();
    cancelSessionTitles(ctx);
    for (const run of ctx.active.values()) run.controller.abort();
    ctx.manualOperation?.controller.abort();
    settleInteraction(ctx);
    // Unloading happens after the runs above were aborted: an activation's in-flight turn is stopped by its
    // own run's abort, and disposal then waits for it to unwind before releasing that child's tools.
    const cleanup = Promise.resolve().then(() => ctx.residency.disposeAll());
    residentCleanup.set(ctx, cleanup);
    void cleanup.catch((error: unknown) =>
      process.stderr.write(`Resident cleanup failed: ${safeError(error)}\n`),
    );
    ctx.carrier.close();
  };
}

/**
 * Install the Host's signal handlers, and return the function that removes exactly those references.
 *
 * Returned rather than re-derived at teardown: `process.off` only removes a listener it is handed the same
 * function object for, and a second `createShutdown` would be a different closure that leaves the first one
 * registered — a Host that ignores the second interrupt instead of the first.
 */
export function installSignals(shutdown: () => void): () => void {
  /**
   * The last line behind every callback nobody awaits (a timer, a microtask, a store observer).
   *
   * Node's default for an uncaught error is to terminate on the spot, which leaves every in-flight run marked
   * running, its pty and children orphaned, and the reason nowhere but a stack trace the carrier may never read.
   * The error is reported and the Host takes its ordinary way down instead, so runs are aborted and settled and
   * the carrier sees an exit with a non-zero code rather than a vanished process.
   */
  const fault = (error: unknown) => {
    process.stderr.write(`[host] uncaught failure, shutting down: ${safeError(error)}\n`);
    process.exitCode = 1;
    shutdown();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  process.on('uncaughtException', fault);
  process.on('unhandledRejection', fault);
  return () => {
    process.off('SIGINT', shutdown);
    process.off('SIGTERM', shutdown);
    process.off('uncaughtException', fault);
    process.off('unhandledRejection', fault);
  };
}

/**
 * Own a carrier for as long as it lasts, and unwind everything when it goes away.
 *
 * The Host is owned by the carrier that started it: stdin EOF, a socket that dropped, and a signal all end the
 * same way, which is why the shutdown path is entered from a `finally` rather than from each of them. The
 * signal handlers are installed *before* the carrier is attached, because with `--listen` the wait for a client
 * is unbounded and an interrupt during it has to unwind gracefully rather than kill a process that already
 * holds a database and a pty.
 *
 * The teardown order is the rest of the contract and must not be rearranged. In-flight requests are awaited
 * before anything they are using closes; the signal listeners are removed before the long unwinding starts, so a
 * second interrupt kills a Host that is already closing; every still-announced session gets its `sessionEnd`
 * hook and its last `session-close` invariant check, because this is the final moment at which the store holding
 * that session's log is still open; and the terminals are closed before the background commands and the store,
 * because a pty is the only one of the three holding a live process.
 */
export async function serveHost(ctx: HostContext): Promise<void> {
  const shutdown = createShutdown(ctx);
  const removeSignals = installSignals(shutdown);
  const failures: unknown[] = [];
  let residentFailed = false;
  /** Idle sub-agents past their TTL are unloaded on a timer, not only when the next run starts. */
  let reaper: ReturnType<typeof setInterval> | undefined;
  const release = async (action: () => unknown): Promise<void> => {
    try {
      await action();
    } catch (error) {
      failures.push(error);
    }
  };
  try {
    // Started only once the read loop is live, so a trigger that fires immediately can dispatch
    // through the same path as any other request.
    const input = await ctx.carrier.attach();
    // Read through the one reader of environment settings, and compare against the boolean it returns:
    // `YUANTU_WORKFLOWS` is declared a boolean, so testing for the *string* `'off'` (which the environment
    // validator rejects outright) meant `YUANTU_WORKFLOWS=false` started the scheduler rather than stopping it.
    if (parseSetting(process.env, 'YUANTU_WORKFLOWS') !== false) ctx.scheduler.start();
    ctx.queueWake();
    reaper = setInterval(() => {
      try {
        ctx.residency.reapIdle();
      } catch (error) {
        process.stderr.write(`[host] idle sub-agent sweep failed: ${safeError(error)}
`);
      }
    }, RESIDENCY_DEFAULTS.reapIntervalMs);
    reaper.unref();
    for await (const line of input) {
      if (ctx.closing) break;
      if (!line.trim()) continue;
      const task = ctx.handle(line);
      ctx.tasks.add(task);
      void task.then(
        () => ctx.tasks.delete(task),
        (error: unknown) => {
          ctx.tasks.delete(task);
          failures.push(error);
          try {
            shutdown();
          } catch (shutdownError) {
            failures.push(shutdownError);
          }
        },
      );
    }
  } catch (error) {
    failures.push(error);
  } finally {
    // Removed before the long unwinding starts, which is what the contract above promises: while these listeners
    // are installed, a second interrupt is swallowed by the idempotent shutdown, so a Host waiting on a
    // minutes-long in-flight request could not be stopped from the console at all.
    removeSignals();
    clearInterval(reaper);
    await release(shutdown);
    await Promise.allSettled([...ctx.tasks]);
    // Every answer is written now, including those of the runs the shutdown aborted; a socket peer gets them
    // before the connection ends (stdout is flushed by the exit itself).
    await release(() => ctx.carrier.drain());
    // A failed release must not skip the remaining resources, but it must not turn shutdown into success.
    await residentCleanup.get(ctx)?.catch((error: unknown) => {
      residentFailed = true;
      failures.push(error);
    });
    // Every still-announced session ends with the host, so a hook can flush state it opened.
    for (const sessionId of ctx.announced) {
      const failures = await Promise.resolve()
        .then(() =>
          underSessionPolicy(ctx, sessionId, () =>
            ctx.hooks.sessionEnd(
              { sessionId, reason: 'shutdown', readOnly: sessionLifecycleReadOnly(ctx, sessionId) },
              new AbortController().signal,
            ),
          ),
        )
        .catch((error: unknown) => [safeError(error)]);
      for (const failure of failures) process.stderr.write(`sessionEnd hook failed: ${failure}\n`);
      // The last chance to check a promise about a session, before the store that holds its log closes.
      await release(async () => {
        const violations = await ctx.invariants.run('session-close', { sessionId });
        for (const violation of violations)
          process.stderr.write(
            `invariant violated on session close: ${violation.name} (${violation.owner}): ${violation.detail}\n`,
          );
      });
    }
    ctx.announced.clear();
    ctx.sessionLifecyclePhases?.clear();
    // Every release is attempted, in order, even when another resource refuses to close.
    await release(() => ctx.terminals.closeAllAndWait());
    await release(() => ctx.background.close());
    await release(() => ctx.store.close());
    await release(() => ctx.hooks.close());
  }
  if (failures.length === 1 && !residentFailed) throw failures[0];
  if (failures.length)
    throw new AggregateError(failures, 'Host shutdown failed', { cause: failures[0] });
}
