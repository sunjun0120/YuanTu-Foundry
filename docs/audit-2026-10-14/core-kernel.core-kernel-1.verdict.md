### core-kernel-1 | confirmed | medium

**Checks:** (every cited line opened, plus a live reproduction)

- `packages/core/residency.ts:214-228` — `deliver` is exactly as described: `:222` refuses when not `running` or no `steer`;
  `:226` returns `{ delivered: true, done: inflight }` for `wait: false`; `:224` reads `this.inflight`, which `run()`
  sets at `:182` and clears in the `finally` at `:192`. `:227`'s `result: await inflight` exists but is dead for the
  shipped tool, because `run-residency.ts:227` always passes `wait: false`.
- `packages/core/run-residency.ts:237-241` — `const turn = delivery.done ?? (delivery.delivered ? undefined : activation.run(...))`;
  `:259-263` `void turn.then(settle)`; `:281` `await waitUnlessCancelled(turn, signal)`; `:291` `settle(outcome)`.
  `settle` at `:205-218` emits `subagent.finished` and calls `addUsage(statistics, outcome.usage)` at `:217`.
- `packages/core/subagents.ts:1090` + `:1159-1167` — `SubAgentCoordinator.execute` awaits `scheduled.provider.start`
  and then folds the outcome: `this.deps.onUsage(outcome.usage)` at `:1159` and a second `subagent.finished` at `:1160`.
- `packages/core/run-coordinator.ts:101-113` — `onUsage` adds to **both** `options.usage` and `options.statistics`.
- `packages/core/agent.ts:837-838` — one `const usage` and one `const statistics` per run; `:1445-1456` hands the pair to
  `createCoordinator`, `:1505-1520` hands the same `statistics` object to `createResidentMessageTool`. Same instance.
- `packages/core/run-subagents.ts:235-246` — a residency-backed delegation's first turn is `activation.run(prompt, true)`
  and its `ResidentTurnResult.usage` is copied straight into the `SubAgentOutcome` the coordinator folds above.
- `packages/core/run-child-turns.ts:303-321` / `:382-391` — `handle.attach` is called synchronously, so `steer` is live
  for the whole turn, and the turn resolves to the `usage` both folds see.
- Reachability in the shipped product: `apps/agent-host/state.ts:197` creates the `SubAgentResidency`, `apps/shared/runtime.ts:348`
  passes it to the kernel, and `subagents.ts:725-729` is the documented `delegate_task { wait: false }` hand-off.
- Downstream path: `packages/storage/sqlite.ts:2402-2409` puts `statistics` in `run.finished`;
  `packages/storage/projections.ts:248-276` folds it into the session statistics; `sqlite.ts:2386-2388` reads that
  projection; `apps/desktop/renderer-statistics.ts:178-182` renders it as the token pill.
- `README.md:713-737` (已知边界) documents nothing about this; `tests/subagents-seams.test.ts:710-714` states the rule the
  duplicate breaks ("each turn is recorded as its own durable outcome", asserting exactly 2 `subagent.finished` for 2 turns);
  `tests/subagent-inbox.test.ts:593-696` and `:707-819` walk the very workflow but assert nothing about `usage`/`statistics`.
- Reproduction (`.scratch/verify/core-kernel-1.repro.test.ts`, real `Agent` + real residency + real store, modelled on
  `tests/subagent-inbox.test.ts:593`): `delegate_task { wait: false }`, child's first request parked, then
  `send_message` (default wait) folded into it → `handedHow: "correction"`, `childActivationTurns: 1` (so no second turn
  was started), `parentRounds: 3`, child spend 2000: **`result.usage.inputTokens = 2030` but
  `result.statistics.inputTokens = 4030`** (`statistics - usage = 2000`, exactly the child turn), **two
  `subagent.finished` events with the same id and the same `usage {inputTokens: 2000}`**, and
  `store.statistics(session.id).inputTokens = 4030`.

**Corrections:**

- The mechanism, every line number and the accumulator identity are right; the finding is not misread. Two parts are
  overstated. First, `residency.ts:227` (`result: await inflight`) is presented as part of the mechanism, but the shipped
  tool always calls `deliver(..., { wait: false })` (`run-residency.ts:219-227`), so the waiting branch of `deliver` is
  never taken — only `done` is.
- Second, the extra `subagent.finished` is more harmless than implied: `settlements.ts:54,73` keys `settled` by id and
  `projections.ts:351-369` _assigns_ the card's usage per child, so no duplicate settlement notice or doubled card
  results. Its measurable cost is a redundant durable record and a doubled fold for any reader that sums the event
  payloads — which is exactly what the project's own evaluation harness compensates for by de-duplicating settlement on
  `(sessionId, id, childRunId)` and rolling child usage back out of the parent statistics
  (`benchmarks/coding-evaluation/README.md:54`).
- `settle`'s `addUsage(statistics, …)` is not simply "the buggy one": for a follow-up turn the residency itself starts
  (`delivery.delivered === false`), it is the only fold, and its missing counterpart is core-kernel-2's subject. The two
  findings are the two halves of one missing owner for the fold, not contradictions.
- Severity kept at **medium, at the low end**: a user-visible accounting number is wrong and disagrees with `usage` in the
  same result, but no admission, budget or completion decision reads `statistics`, and nothing is lost or corrupted.

**Reasoning:** The code folds the _same_ `ResidentTurnResult.usage` object into the _same_ `SessionStatistics` instance
from two places whenever a `send_message` is folded into a turn another caller started and will itself settle — once in
`subagents.ts:1159` via `run-coordinator.ts:101-113`, once in `run-residency.ts:217` — and `addUsage` is a plain
non-idempotent accumulator (`protocol/statistics.ts:147-168`). A real run of the documented workflow produced
`usage 2030` against `statistics 4030` with two identical `subagent.finished` events and the inflated number reaching
`store.statistics(sessionId)` and therefore the desktop token pill. Not documented in 已知边界, and it contradicts the
per-turn record rule the project's own test asserts.
