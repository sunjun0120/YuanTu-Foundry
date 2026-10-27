# Live session model selection implementation plan

> **For agentic workers:** Use superpowers:executing-plans to implement this plan task by task. Execution was authorized in chat; preserve existing uncommitted work.

**Goal:** Select a model for a chat without restarting its Host or reloading its transcript, with no switching status copy.

**Architecture:** The desktop supplies an in-memory connection catalog to the persistent Host. A session stores only its chosen connection ID in its journal. Each model operation captures the complete connection and limits before its first await; active operations retain their snapshot. Connection credentials remain in the existing encrypted desktop store. The global default remains separate from session choices.

**Tech stack:** TypeScript, existing JSONL RPC, SQLite session journal, Electron/React.

**Spec:** Accepted implementation direction in this chat, including the explicit request to omit switching text.

## Global constraints

- Preserve concurrent edits and existing permission/sandbox behavior.
- Do not persist or broadcast plaintext credentials in session events or snapshots.
- Catalog changes must survive supervised Host recovery before automatic work resumes.
- Missing/deleted connections must not silently select a different route.
- Keep current desktop run-time selection lock; model operations still capture immutable snapshots.

## Review focus

- A retry/continuation must retain the admitted model after a configuration update.
- Two sessions must keep independent credentials, limits and calibration identities.
- Restarts and workspace changes must restore session choices from durable connection IDs.
- Settings persistence failures must not leave a different catalog active in the Host.
- Switching sessions must refresh the picker without reloading conversation history.

### Task 1: Host catalog, session selection and operation snapshots

Files: new protocol model configuration contract and Host model runtime; RPC/event contracts; Host state, system handlers, run start, compaction, task proposal and title generation; shared runtime configuration readers.

- [x] Add integration regressions for in-process switching, independent sessions, persisted selection, rejected invalid catalogs and active-run snapshot retention; run them red.
- [x] Implement validated catalog installation, session selection/get RPCs and journal IDs only. Pass captured model environment and connection limits explicitly to all model entry points. Separate resident activations when their route configuration changes.
- [x] Run Host regressions and typecheck.

### Task 2: Carrier and desktop settings integration

Files: carrier service; desktop settings store and main IPC handler; settings and carrier tests.

- [x] Add a regression asserting stable Host PID, selected session, history window and next-request route while another chat keeps its model; run red.
- [x] Install/replay the catalog before runtime readiness; expose session selection and current public metadata without a history load. Replace desktop model-driven service replacement with catalog updates and session selection. Roll back persisted settings on application failure.
- [x] Verify saving, deleting, startup and crash recovery alongside existing settings tests.

### Task 3: Picker synchronization and final verification

Files: model selection controller, application snapshot adapter, model settings controller, desktop smoke tests and documentation facts.

- [x] Exercise switching away/back and confirm no switching text, stable PID/session/history/draft and correct outgoing models.
- [x] Refresh picker on session/model changes and remove switching status assignment without hiding errors.
- [x] Run related tests, static checks, build and real Electron settings smoke; record results below.

## Execution record

- Initial checkout: feat/desktop-react-completion; existing UI, carrier and smoke-test changes are preserved. Work continues in the attached checkout as requested.
- Ruling: retain current desktop prohibition on switching during a running task; Host snapshots nevertheless support independent concurrent sessions and configuration updates safely.
- Ruling: keep the existing shared Host residency pool and cap. Before a session uses a different configuration, unload its idle descendants deepest-first using durable ancestry; never reuse their old Provider. Deleted unrelated ancestors end the ancestry search.
- Independent review: corrected same-model-name connection refresh, shared residency bounds, unloaded intermediary ancestry and deleted-session handling; reviewer confirmed no remaining actionable findings.
- Final related regression: 68 passed, 0 failed. Real Electron settings smoke: 8 passed, 1 product-scope skip, 0 failed.
- Typecheck, build, final Host bundle/handshake, ESLint, Prettier, docs, references, layers, cycles, i18n and isolation checks passed.
- Full `npm test` reached Office/WPS temporary-directory cleanup after 324 of 330 files reported results and stalled there. Stopped only this run's verified scheduler, retained cleanup evidence, and independently ran the remaining 6 files (3 passed, 11 CI-only skips, 0 failures). The initial run's SWE Host cancellation and workspace-authorization-budget failures both passed standalone retests. This is not a clean full-suite pass.
- Detailed verification record: `.scratch/test-logs/live-model-selection-20261027-verification.json`.
