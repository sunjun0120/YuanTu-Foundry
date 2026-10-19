import { calibrationRoute, TokenCalibration } from '../../../packages/core/calibration.ts';
import { prepareContext, withoutSummarySection } from '../../../packages/core/context.ts';
import { contextSeams } from '../../../packages/core/run-context.ts';
import { contextBoundaries, foldContextEnvelopes } from '../../../packages/protocol/context.ts';
import { resolveRunLimits } from '../../../packages/protocol/settings.ts';
import { createProvider, readConfig } from '../../../packages/providers/index.ts';
import { modelInfoFor, resolveConnectionCapacities } from '../../shared/runtime.ts';
import { ownedSession, required } from '../params.ts';
import { assertUnlocked, executionRoot, hostClaim, sessionClaim, withLocks } from '../state.ts';
import type { Handler } from '../dispatch.ts';

/**
 * The summary a person asks for, priced and shaped like the rounds around it.
 *
 * Compaction is one extra model request that replaces the session's older turns with a summary of them, so the
 * two things that have to be right are the *envelope* it is sent in and the *measurement* it is sized against.
 * Both are taken from the session's own recorded state rather than from convenient defaults: the last request
 * envelope it actually sent, and the calibration its own route has observed. A summary request built on an empty
 * envelope shares neither the system prompt nor the tool schemas with anything, which costs the provider cache
 * and admits batches the real request could not send — so when no envelope is recorded, the honest answer is
 * `compacted: false` with the reason, not a request whose prefix is known not to match.
 */
export const compactionHandlers: Readonly<Record<string, Handler>> = {
  'context.compact': async (ctx, params) => {
    const sessionId = required(params, 'sessionId');
    ownedSession(ctx.store, ctx.workspace, sessionId);
    // A summary rewrites only this session's own context, so only this session has to be idle.
    const claims = [hostClaim('shared'), sessionClaim(sessionId)];
    const busy = 'Host is busy; wait before compacting';
    assertUnlocked(ctx, claims, busy);
    const history = ctx.store.messages(sessionId);
    const covered = ctx.store.contextSurface(sessionId)?.coveredMessages ?? 0;
    const boundary = contextBoundaries(history).at(-1) ?? 0;
    if (history.length < 2 || boundary <= covered)
      return { compacted: false, coveredMessages: covered };
    /**
     * The envelope this compaction will replay, which has to be the last round's *real* one.
     *
     * This path used to pass `system: ''` and `tools: []`, and the two things that follow from it are both
     * defects rather than simplifications. A summary request is the round's own prefix plus one instruction —
     * that is the whole reason its shape exists (see the note on `summaryInstruction`) — and a request built on
     * an empty envelope shares neither the system prompt nor the schemas with anything, so the provider caches
     * nothing: the user pays full price for a summary of a conversation that was just sent cached. The second
     * is the capacity check: the batch is measured against the request that will carry it, and measuring it
     * against an empty envelope admits batches the real request cannot send.
     *
     * So the record written by the run that produced this transcript is what gets replayed, and when there is
     * none the honest answer is to not summarise: `compacted: false` with the reason, rather than a request
     * whose prefix is known not to match. The prompt is stripped of its own `<conversation_summary>` section
     * because `prepareContext` appends that from the surface, and the recorded prompt already contains it.
     */
    const replay = foldContextEnvelopes(ctx.store.events(sessionId))
      .filter((entry) => entry.system !== undefined && entry.tools !== undefined)
      .at(-1);
    if (!replay || replay.systemTruncated)
      return {
        compacted: false,
        coveredMessages: covered,
        reason: replay
          ? 'the last request envelope was recorded with a truncated prompt, so a summary request could not replay it byte for byte'
          : 'no request envelope is recorded for this session, so a summary request could not replay the round it compresses',
      };
    return await withLocks(ctx, { claims, busy, operation: { sessionId } }, async (signal) => {
      // The same defaults the kernel uses, from the same owner (see `packages/protocol/settings.ts`).
      const limits = resolveRunLimits(ctx.options);
      const config = readConfig();
      /**
       * The session's own correction, and the shortening the run would have applied.
       *
       * Manual compaction used to be measured and priced as if it were the first request of a fresh session: no
       * calibration (so the batch was sized against a factor of one, however wrong this route's estimate had
       * proved to be) and no shrink seam (so old tool results were replayed in full, which is exactly what makes
       * a batch too large to summarise). Both are the run's own seams, built from the same values and the same
       * store, so the compaction a person asks for is priced like the rounds around it.
       */
      const route = calibrationRoute(modelInfoFor(config));
      const routeInfo = modelInfoFor(config);
      const calibration = TokenCalibration.from(
        ctx.store.newestPayload(sessionId, 'context.calibration'),
        route,
      );
      const provider = createProvider(config);
      const capacityFor = await resolveConnectionCapacities(ctx.options, config, signal);
      const capacity = capacityFor(config.model);
      await prepareContext({
        store: ctx.store,
        sessionId,
        system: withoutSummarySection(replay.system!),
        tools: replay.tools!,
        provider,
        // A manual compaction is a model answer like any other, so its record says which route produced it —
        // the same two facts the run's own compactions record, taken from the same place.
        protocol: routeInfo.protocol,
        model: routeInfo.model,
        limit: limits.maxContextChars,
        signal: signal,
        maxOutputTokens: capacity.maxOutputTokens ?? limits.maxOutputTokens,
        maxContextTokens: capacity.contextWindow,
        summaryTimeoutMs: limits.summaryTimeoutMs,
        // The recorded key, but only for the request that was recorded. A key names a cache entry, so handing
        // it to a prompt that is not the one behind it would ask the provider for somebody else's prefix — and
        // the prompt can differ: the surface's summary is appended fresh, and a compaction since this envelope
        // was written has moved it on. When it does differ, the honest answer is no key at all: the summary
        // request then caches nothing rather than reading an entry that is not its own.
        cacheKeyFor: (systemText) => (systemText === replay.system ? replay.cacheKey : undefined),
        calibration,
        // The run's own shortening and pruning seams, from the same factory: a copy here drifted once already.
        // The spill target is the directory the session works in, so a shortened result a later round reads is
        // reachable through the same workspace the tools resolve against.
        ...contextSeams({
          workspace: executionRoot(ctx, sessionId),
          sessionId,
          calibration,
          ...limits,
        }),
        onUsage: () => {},
        onCompaction: () => {},
        forceCompact: true,
      });
      /**
       * What the compaction's own request taught this route, recorded where the next run reads it.
       *
       * `prepareContext` folds the provider's reported usage into the calibration it was given; without this
       * write the measurement would die with the call, and the next run would size its requests against the
       * value that preceded it.
       */
      if (route !== undefined)
        ctx.store.recordEvent(sessionId, 'context.calibration', {
          route,
          factor: calibration.factor,
          samples: calibration.observed,
          parts: calibration.parts,
        });
      return {
        compacted: true,
        coveredMessages: ctx.store.contextSurface(sessionId)!.coveredMessages,
      };
    });
  },
};
