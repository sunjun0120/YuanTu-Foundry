# Audit — packages/core (agent kernel, 55 files)

Scope: agent loop, context budget and compaction, subagents, persistent tasks, goals, plan mode, session
projection, acceptance, retry/step boundaries. Read-only review of the source in `packages/core` (plus the
`packages/protocol`, `packages/storage` and `apps/agent-host` code it is wired to, where a claim had to be
checked across the seam). Documented deliberate boundaries (README "已知边界") are not reported as defects;
only code that fails to meet a boundary it claims is.

## CAPABILITIES

- **The round loop counts rounds without bounding them.** `Agent.run()` drives `for (let round = 0; ; round++)`
  (`packages/core/agent.ts:2048`); a run ends when the model stops asking for tools, when a person cancels it,
  when the provider refuses a request, or at a ceiling (output limit, window, tool wall clock) — never on a
  round count (`agent.ts:2036-2046`). Goal rounds are bounded separately, by the goal record.
- **Every round is a durable step with its own timing.** `step.started` is recorded before the round builds
  anything (`agent.ts:2106`), the lease is renewed once per boundary (`agent.ts:2115`), and every exit from the
  loop closes the step through `endStep`/`commitStepTiming` (`agent.ts:1245`, `agent.ts:2915`) carrying
  `firstTokenMs`/`decodeMs`. An abort that arrives after the provider's terminal event keeps the completed text
  and still refuses to execute pending tool calls (`agent.ts:2916-2918`).
- **Context budget arithmetic.** `COMPACTION_DEFAULTS = { thresholdRatio: 0.8, headroomTokens: 65_536,
retainRatio: 0.16, compactionRetries: 1, maxOverflowRetries: 1 }` (`packages/core/compaction-policy.ts:20`);
  thresholds are computed against window minus a 65,536-token headroom, the retained tail is ≥16% of the message
  budget, and `retentionStart` deliberately returns `undefined` (letting the legacy boundary rule decide) when the
  whole history is smaller than that tail (`compaction-policy.ts:158`).
- **Estimation is bytes/3 with an explicit protocol margin.** Per-request overhead is 256 tokens, each image is
  4096 tokens (`packages/core/budget.ts`), and per-part corrections come from `TokenCalibration`
  (`packages/core/calibration.ts:108`): first observation adopted whole, later ones blended with `WEIGHT = 0.4`,
  every weight clamped to 0.5–3. `estimateMessageTokens` omits the protocol margin by design; `measureRequest`
  reports parts plus overhead, which always sum to the total because the estimate is ≥1 token over overhead.
- **Overflow and retry budgets are per step and read back from the log.** `overflowAttempts` is declared inside
  the round (`agent.ts:2440`), so a provider-confirmed overflow can be recovered at most
  `context.maxOverflowRetries ?? 1` times per round (`agent.ts:2463`); a summary that fails to converge is
  retried `spec.compactionRetries` (1) times (`packages/core/context.ts:1071-1081`); model retries are counted by
  a SQL query over the run's own `llm.retry` rows — `store.retryCount(runId, round)`
  (`packages/storage/sqlite.ts:1774`) — so the count survives a restart and the attempt is written down before
  the wait.
- **Compaction is one durable write with a claimed lock.** `store.claimCompaction` is taken before the first
  summary request and re-checked at `applyCompaction` (`context.ts:824`, `context.ts:1039`), with a `handedOff`
  exception so a convergence retry cannot clear a claim it still needs (`context.ts:836`, `context.ts:1078`).
  Every failure path restores the pre-call summary and view and reports `compactionProblem` without writing
  (`context.ts:558-594`).
- **Two refusals protect the summary's honesty.** A summary larger than `floor(limit/3)` is refused
  (`context.ts:1005`) and so is one that did not shrink the surface it replaces (`surfaceChars >= replacedChars`,
  `context.ts:1026`). A manual compaction bypasses the affordability gate but not these checks.
- **The summary lives in the conversation, not beside it.** It is inserted as the first user message wrapped in
  `<compacted-summary>` with 8 fixed section headings (`context.ts:32-55`), which is what keeps the prompt prefix
  — and therefore the provider's cache — valid across compactions.
- **Subagent defaults and their ceilings.** `SUBAGENT_DEFAULTS = { enabled: false, maxDepth: 1, maxFanout: 4,
maxConcurrency: 8, maxPerRun: 8, timeoutMs: 600_000, collectWaitMs: 5_000 }` (`packages/core/subagents.ts:110`);
  `resolveSubAgentOptions` clamps `maxFanout`/`maxConcurrency` to `SUBAGENT_CEILINGS` (4/8) and `collectWaitMs` to
  120,000 ms, and rejects any non-integer, non-positive cap except the two windows where 0 means "do not wait"
  (`subagents.ts:149-163`). A fan-out is admitted whole or refused (`subagents.ts:775`), and a blocking delegation
  stops waiting — without cancelling the children — when a correction arrives (`subagents.ts:731-749`).
- **Delegation is serial within a message.** A tool with no `isConcurrencySafe` reports `executionMode:
'exclusive'` (`packages/tools/registry.ts:391`), so `delegate_task`/`subagent_fork`/`workflow` calls in one
  assistant message run strictly one after another; admission against `maxPerRun` therefore has no check-then-act
  window.
- **Residency and follow-up delivery are journalled in two halves.** `RESIDENCY_DEFAULTS = { maxResident: 4,
idleTtlMs: 600_000 }` (`packages/core/residency.ts:33`); `send_message` records acceptance
  (`subagent.message.queued`) _before_ attempting the hand-off and records `subagent.message.handed` only if it
  happened (`packages/core/run-residency.ts:192-258`), so "queued with no handed" is exactly "accepted, never
  delivered" (`packages/core/subagent-jobs.ts`).
- **Task triggers are bounded and honest about lateness.** Intervals are 1…10080 minutes (`MIN_INTERVAL_MINUTES`
  at `packages/core/task-trigger.ts:11`); `normalizeTaskTrigger` rejects unknown fields; `dueTasks` skips
  `cancelled`/`in_progress` tasks, turns an approved pending-approval task into a `recovery` wake-up and a start
  more than 60,000 ms overdue into `missed`, and orders candidates oldest first; schedules are delivered at most
  once per (dueAt, task set) (`packages/core/task-deliveries.ts`).
- **Goals are budgets the runtime enforces.** `GOAL_DEFAULTS.maxGoalRounds = 256` with
  `GOAL_CEILINGS.maxGoalRounds = 4096` and `GOAL_CONTINUATIONS_PER_REQUEST = GOAL_DEFAULTS.maxGoalRounds`
  (`packages/protocol/goals.ts:54`, `:78`); `admitGoalRound`/`goalExhausted` decide continuation per round and
  `exhaustedGoalVerdict` writes a `blocked` verdict naming the spent budget (`packages/protocol/goals.ts:246-273`);
  `HUMAN_ONLY_GOAL_ACTIONS = ['edit','pause','resume']` (`:95`), so a model cannot pause or rewrite its own goal.
- **Acceptance cannot pass vacuously.** Checks are capped at `MAX_CHECKS = 64` (`packages/core/acceptance.ts:30`);
  a definition with no usable check is `invalid-definition`/`empty-acceptance` rather than a pass
  (`packages/core/task-acceptance.ts:29-34`), `definitionNonEmpty` gates the completion decision, and
  `verifyCompletionAcceptance` fingerprints the monitored input range before and after the checks and reports
  `needs_review` when the verification changed what it judged (`agent.ts:1668-1676`).
- **The event log is the only state.** Every change goes through `SessionStore.recordEvent`, which flushes buffered
  message appends first so a fact never overtakes them (`packages/storage/sqlite.ts:1583-1608`); `run.finished`
  carries `usage`, `statistics` and — only when a summary was committed — `compactionUsage`
  (`sqlite.ts:2402-2409`, `agent.ts:3652-3661`), and the statistics projection reconciles the summary's tokens so
  they are counted once (`packages/storage/projections.ts:248-276`).
- **Usage is marked incomplete rather than guessed.** `createProviderMeasurement` writes one
  `provider.request.finished` per attempt, adds usage only on success and sets `statistics.usageComplete = false`
  on any failure (`packages/core/run-provider.ts:82`); `addStatistics`/`addUsage` propagate that flag instead of
  inventing the missing part (`packages/protocol/statistics.ts:136-160`).
- **Read-side queries are bounded.** `MAX_SCAN_EVENTS = 20_000`, `MAX_READ_CHARS = 12_000`,
  `MAX_EVENT_CHARS = 600`, `MAX_MATCHES = 40`, `MAX_HIT_CHARS = 300`, `MAX_LINEAGE_CHILDREN = 10`,
  `MAX_TYPES = 8`, `MAX_TRACED_RUNS = 20` (`packages/core/session-query.ts:67` and the constants around it);
  a caller-supplied answer schema is capped at `MAX_TASK_SCHEMA_CHARS = 4_000` (`subagents.ts:148`).
- **Input queueing preserves the user's intent.** `MAX_QUEUED_INPUTS = 16` with prompts of 1…100,000 characters
  (`packages/core/run-queue.ts:20`); a `steer` aborts the steering controller, which is what makes an in-flight
  approval or question wait end as `cancelled` instead of being misrecorded as `denied`
  (`packages/core/run-interaction.ts:100-107`); dropped inputs are recorded as `input.discarded` with their ids
  (`sqlite.ts:1332-1333`).
- **Workspace isolation is explicit about what it is.** Children either share the parent's directory or get a
  worktree/frozen snapshot per call, and `batchWorkspace` memoizes the _pending_ freeze promise so two tasks of
  one call cannot freeze the source twice and trip `WORKSPACE_INTEGRITY`
  (`packages/core/run-coordinator.ts:171-189`); a read-only run may only delegate `explore` tasks
  (`subagents.ts:782`), and a read-only run refuses every effect at the approver without asking a person
  (`run-interaction.ts:65-75`).

## FINDINGS

### core-kernel-1 | medium | correctness

**Title:** A message folded into a child turn that is already running settles that turn a second time, so the
child's tokens are counted twice in the parent run's statistics
**Evidence:** `packages/core/residency.ts:214-227` — `deliver(message, { wait: false })` returns
`{ delivered: true, done: inflight }`, where `inflight` is the promise of the turn currently running (set at
`residency.ts:182`, cleared at `:192`), i.e. a turn some _other_ caller started; the same value is returned as
`result: await inflight` for a waiting call. `packages/core/run-residency.ts:237-241` binds that as
`const turn = delivery.done ?? …`, and then either `void turn.then(settle)` (`run-residency.ts:263`, background)
or `await waitUnlessCancelled(turn, signal)` followed by `settle(outcome)` (`run-residency.ts:281`, `:291`,
blocking). `settle` (`run-residency.ts:205-218`) both emits `subagent.finished` and calls
`addUsage(statistics, outcome.usage)`. The caller that started that turn folds the very same outcome:
`packages/core/subagents.ts:1159-1160` calls `this.deps.onUsage(outcome.usage)` and emits `subagent.finished` for
the turn it awaited from `provider.start`, and `onUsage` adds to _both_ accumulators —
`packages/core/run-coordinator.ts:101-113` (`options.usage.inputTokens += …` and `addUsage(options.statistics,
used)`). Both paths are handed the _same_ object: `agent.ts:1445-1456` passes `usage` and `statistics` to
`createCoordinator`, and `agent.ts:1507-1519` passes the same `statistics` to `createResidentMessageTool`.
Reachable through the documented workflow: `delegate_task { wait: false }` returns while the child's first turn
is in flight (`subagents.ts:725-729`), so a `send_message` in the next round reaches `deliver` with a live
`inflight` and takes the `done` branch.
**Impact:** Each correction delivered into a running child adds that turn's input/output tokens to the parent
run's `statistics` twice, and writes a second `subagent.finished` for one turn. `statistics` is the number the
session projection folds when `run.finished` carries it (`packages/storage/projections.ts:248-276`), so the token
total a person reads for a session that used background children is inflated by the whole of the corrected turn;
the same result's `usage` is not inflated, so the two numbers in one `RunResult` disagree about the same
spending.
**Recommendation:** Give the fold a single owner. Either skip `addUsage` in `settle` when the outcome came from
`delivery.done` (keeping the `subagent.finished` notice for the parent) or make `onUsage` idempotent per child
turn id, so a turn can be folded exactly once no matter how many calls observe it.
**Confidence:** high

### core-kernel-2 | medium | correctness

**Title:** A resident child's follow-up turns spend tokens that can never reach `RunResult.usage`
**Evidence:** `packages/core/run-residency.ts:24-39` — `ResidentToolOptions` carries `statistics` and has no
`usage` field at all, so the run's usage accumulator is structurally unreachable from this path;
`packages/core/run-residency.ts:217` — the one settlement does `addUsage(statistics, outcome.usage)` only;
`packages/core/agent.ts:1507-1519` — the tool is constructed with `statistics` but not `usage`, in contrast with
`agent.ts:1445-1456`, which passes both to the coordinator, whose comment states the intent: "Child usage is
folded into this run's totals … a child's tokens reach `RunResult.usage` and `statistics`"
(`packages/core/run-coordinator.ts:57-59`, `:99-113`). `RunResult` reports `usage` and `statistics` side by side
and names exactly one exception to their agreement — `compactionUsage`, and only when a summary was committed
(`agent.ts:3645-3661`) — with no field for follow-up spending; `sqlite.ts:2402-2409` persists the same pair into
`run.finished`.
**Impact:** After _n_ `send_message` follow-ups that each run a turn, `RunResult.usage` — the run row, the
`run.finished.usage` payload, and what a CLI/SDK caller reads as `--json` usage — under-reports by exactly those
turns' tokens, while `RunResult.statistics` (and the session total derived from it) includes them. The
under-report is silent and unbounded in the number of follow-ups: a caller that sums run usage for cost
accounting is wrong by the follow-up work it paid for, and no field in the result says so.
**Recommendation:** Add a `usage` accumulator to `ResidentToolOptions`, pass `usage` at `agent.ts:1515`, and have
`settle` do both `addUsage(statistics, …)` and `addUsage(usage, …)` — or derive `RunResult.usage` from the
statistics at finish so the two cannot diverge at all.
**Confidence:** high

### core-kernel-3 | low | correctness

**Title:** A summary's calibration observation is normalised against a number made of the weights themselves,
so a request that was estimated exactly right still moves every weight
**Evidence:** `packages/core/context.ts:946` calls `input.calibration?.observe(rawSummaryEstimate,
response.usage.inputTokens)` with no third argument, unlike the answer path, which passes the request's part
bytes (`agent.ts:2793-2797`). That lands in the parts-less branch of `observe`
(`packages/core/calibration.ts:172-186`), whose first statement is
`const current = this.factorFor(parts ?? this.weights);` — inside a branch guarded by `if (!parts)`, so `parts`
is provably `undefined` and `current` is `this.factorFor(this.weights)`. `factorFor` is
`blendFactors(this.weights, parts)` (`calibration.ts:224-226`), i.e. a blend of the weights over **byte shares**,
so feeding it the weights yields `Σw²/Σw`: a function of the weights alone, not of the request that was measured.
The divergence this file is explicitly built for (`calibration.ts:149-158`, "two weights pointing in opposite
directions") is exactly what makes that number wrong: with weights `{ system: 3, tools: 0.5, messages: 1 }`,
`current = 2.28` while the request's own correction is ≈1, so an observation that measured the estimate
perfectly (`sample = 1`) computes `move = 1 + 0.4·(1/2.28 − 1) = 0.775` and pushes all three weights down by
22%.
**Impact:** Compaction in a long session is the only production caller that observes without part sizes, so every
compaction after the first applies a correction whose magnitude is set by how far the weights have drifted apart
rather than by whether the summary request was mis-estimated — and the correction is applied to all three weights
at once. The learned factor (which prices the retained tail, the shrink cut sizes and the "does this fit"
verdict) drifts on evidence nobody measured, in a kernel whose accounting rule is that these numbers are
measured, not guessed.
**Recommendation:** Pass the summary request's own part sizes at `context.ts:946` — they are already computed for
that request's forecast — or, until then, derive the request-wide move from the single weight `adjust` uses
(`this.factor`, the messages weight) instead of a blend of the weights with themselves.
**Confidence:** high
