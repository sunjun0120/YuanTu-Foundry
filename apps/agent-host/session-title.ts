import { generateSessionTitle } from '../../packages/core/session-title.ts';
import { createProvider, readConfig } from '../../packages/providers/index.ts';
import type { HostContext } from './state.ts';
import { failureCodeOf } from '../../packages/protocol/failure.ts';

const pending = new WeakMap<HostContext, Map<string, AbortController>>();

/** Optional naming belongs to the Host, not to the answer's critical path. */
export function startSessionTitle(
  ctx: HostContext,
  sessionId: string,
  prompt: string,
  runSignal: AbortSignal,
  modelEnvironment: NodeJS.ProcessEnv = ctx.models.capture(sessionId).env,
): void {
  if (ctx.closing) return;
  let titles = pending.get(ctx);
  if (!titles) pending.set(ctx, (titles = new Map()));
  if (titles.has(sessionId)) return;
  const controller = new AbortController();
  titles.set(sessionId, controller);
  const signal = AbortSignal.any([controller.signal, runSignal]);
  const task = Promise.resolve()
    .then(async () => {
      signal.throwIfAborted();
      const generated = await generateSessionTitle(
        createProvider(readConfig(modelEnvironment)),
        prompt,
        signal,
      );
      if (signal.aborted || ctx.closing) return;
      if (!generated) {
        process.stderr.write(
          `[session-title] No usable title for ${sessionId}; keeping fallback\n`,
        );
        return;
      }
      if (!ctx.store.setGeneratedTitle(sessionId, generated.title, generated.usage)) return;
      ctx.carrier.send({
        event: {
          type: 'session.title.updated',
          sessionId,
          runId: '',
          seq: ctx.store.lastSeq(sessionId),
          data: { title: generated.title, usage: generated.usage },
        },
      });
    })
    .catch((error: unknown) => {
      // Naming may fail, be cancelled, or lose to a manual rename/deletion. The answer is independent.
      if (!signal.aborted && !ctx.closing) {
        const reason =
          failureCodeOf(error) ??
          (error instanceof DOMException && error.name === 'TimeoutError'
            ? 'timeout'
            : 'unavailable');
        process.stderr.write(
          `[session-title] Generation ${reason} for ${sessionId}; keeping fallback\n`,
        );
      }
    });
  ctx.tasks.add(task);
  void task.then(() => {
    titles.delete(sessionId);
    ctx.tasks.delete(task);
  });
}

/** The normal Host drain awaits these tasks before closing their store. */
export function cancelSessionTitles(ctx: HostContext): void {
  for (const controller of pending.get(ctx)?.values() ?? []) controller.abort();
}
