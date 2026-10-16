# Core and storage responsibility split

Goal: Continue the approved decomposition of Agent and SessionStore while preserving public APIs, event order, transactions, cancellation and recovery.

User approved the in-chat design and requested implementation in this checkout after the other agent stopped. Existing uncommitted changes are the baseline; do not reset, stage or commit unrelated changes.

- [x] Baseline: preserve source snapshots and run core/storage behavioral regressions.
- [x] Storage: extract task definitions and completion reads into narrow-port collaborators.
- [x] Storage: extract context persistence and run/lease/recovery operations, sharing the existing transaction owner.
- [x] Core: extract task setup, model request/stream/retry handling and finalization; preserve per-round live policy reads.
- [x] Review and verify: typecheck, focused and full tests, static gates, build/client smoke, final review.

Transaction depth, buffered appends, pending events and cache publication remain one unit. New modules must not create independent connections or transactions. Agent retains the round loop and owns run state; collaborators receive explicit state and operation ports. No schema or protocol change.

Validation focuses on rollback visibility, observer ordering, cross-connection caches, run/compaction ownership, stream recovery, bounded retry, cancellation, child settlement and final verdict persistence.

Ruling: Work in the current checkout, per session context and desktop instructions. No new worktree or commit is needed for this continuation.

Execution notes:

- Baseline in the restricted execution environment failed on local model endpoints and SQLite backup rename. The unchanged baseline in the ordinary local environment passed 123/123.
- First storage extraction: typecheck and baseline 123/123 passed.
- First core extraction: 159 passed, 3 skipped, 0 failed across 15 files.
- Unified event journal extraction: 74/74 passed across 8 existing files, including buffered append ordering, commit observers, projections, leases and streaming. The command also named a nonexistent transcript-cache.test.ts; Node ignored that path. The actual log-cache.test.ts is separately covered by the full suite.
- Preserved the bodies of 53 moved storage methods after normalizing port access and formatting.
- Ruling: Move transaction nesting, buffered writes, pending events and caches together into SessionEventJournal, because they have one commit/rollback lifecycle. The facade and all collaborators still share one DatabaseSync and transaction owner.
- Ruling: Extract per-run delegation/report assembly as well as request/task/finalization, because provider construction and report-tool replacement are one cohesive child lifecycle. Keep child creation and the message-id counter with Agent through callbacks.
- Existing behavior coverage is reused for this behavior-preserving refactor; no new tests that merely assert forwarding or file layout.
- Final full serial result: 2427 tests, 2312 passed, 1 failed, 114 skipped. The only failure was an obsolete private readEvents interception in storage-audit-repairs.test.ts; independently reproduced and adapted to journal.readEvents without changing product code. Related six-file rerun: 51 passed, 1 skipped, 0 failed. The original full run remains recorded as failed; no second full run.
- Final typecheck, static gates, build and compiled client smoke (3/3) passed. Reviewer found no product regression and confirmed the adapted cache test preserves the interleaving and assertions.
- Hash verification: only the intended test adaptation changed after full validation started; no product source or unrelated pre-existing dirty file changed.
- Ruling: After the sole test interception adaptation, rerun all six relevant storage files and typecheck; reuse the completed full run for unchanged product source rather than repeat the 25-minute suite. Keep the failed full-run status explicit.
