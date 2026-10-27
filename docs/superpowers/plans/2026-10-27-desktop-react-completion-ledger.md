# Desktop React completion ledger

Plan: `docs/superpowers/plans/2026-10-26-desktop-react-typescript-migration.md`

Baseline: `34a8ace`, clean worktree, branch `feat/desktop-react-completion`.
Baseline typecheck: `npm run typecheck`, exit 0 (2026-10-27).

## Scope and sequence

- [x] T24a: React owns the product skeleton and one AppShell; preserve drafts, scroll and region state.
- [x] T24b: Product page/settings-category transitions and legacy CSS retirement by selector ownership.
- [x] T25 chrome: React owns dynamic window chrome; remove the old page renderer and finish bootstrap/lifetime cleanup.
- [x] T25a: Replace region portals with ordinary React children; independent view lifecycle.
- [x] T25 slots: React slot ordering, dynamic registration, unload and type contracts.
- [x] T19 follow-up A: React task-definition editor, keyed criteria, draft and conflict protection.
- [ ] T19 follow-up B: React trigger editor; retire remaining task-editor DOM builder.
- [ ] T25b: Remove legacy page rendering, select/walker dependencies and compatibility-only selectors; audit retained DOM islands.
- [ ] T20/T21 follow-up: Live DOM identity and transcript animation evidence.
- [ ] T26: Full checks, Electron behavior/visual/motion/resource/performance evidence and accurate delivery record.

## Decisions

- Ruling: Continue in the existing clean checkout on a dedicated branch. The user explicitly asked to take over this migration; branch creation preserves the existing workspace/dependencies and avoids changing main. No push or merge is authorized by this decision.
- Ruling: The existing approved migration specification remains binding; do not restart design discovery. Split T24/T25 into reviewable steps because their combined remaining scope exceeds the plan's 1,200-line task limit.
- Pre-flight T24/T25: Region adapters require synchronously available host elements and transcript commits before scroll reads. Preserve this ordering while moving hosts into React; do not add a second root or drop anchor/draft behavior.
- Pre-flight T24/T26: Earlier status documents contain stale CSS totals and completion labels. Current source and fresh test evidence determine completion; an empty compatibility registry alone does not prove selector retirement.
- Ruling: Controller view composition uses independently subscribed named values rendered as ordinary React children. This removes the DOM-region portal registry without recreating existing controller state or synchronizing a second snapshot. Overlay/diff portals remain separate from page-region mounting.
- Ruling: Smoke tests must wait for DOMContentLoaded before reading React-created product nodes. Static HTML previously made those nodes available before the renderer ran; keep all subsequent behavioral assertions.

## Evidence so far

- Baseline Electron: layout + React + motion, 13/13 pass.
- Shell ownership assertion: failed against baseline (AppShell count 0), then product AppShell assertion passed.
- Product layout: first complete use case passed, including languages, themes, permissions, drafts and compact windows. Complete layout file: 4/4 pass.
- Model picker: replaced native select/upgrader dependency with the visible Mantine combobox. Settings regression: 8 pass / 0 fail / 1 existing MCP skip.
- View registry lifecycle tests: replacement disposer cannot unregister its successor; independent subscriptions and idempotent clear, 2/2 pass.
- React child composition: locale/plan card tests 5/5, motion 5/5; one isolated shell fixture revealed a missing collapsed-aside rule, now being verified.
- Session menus: existing real click regression caught a stacking conflict with fixed AppShell navigation; menu z-index corrected, original rename/delete/draft use case passed. A direct Host-recovery test timed out waiting for durable `run.interrupted`; rerun with the normal harness before classifying it.
- Final T24a/T25a regression: view registry 2/2; desktop-language 7/7; desktop-layout 4/4; desktop-react 4/4; desktop-sessions 6/6 (including Host recovery), 23/23 total. Separate settings 8 pass / 1 existing MCP skip; locale/plan-card 5/5; motion 5/5.
- Checkpoint gates: typecheck, lint, layers, cycles, i18n, format, docs, references, isolation all exit 0. Full suite/release acceptance is still pending T26.
- CSS retirement: six legacy files now contain one retirement comment each (5,983 -> 6 lines); `ui/styles.css` owns component and DOM-island styling through classes, not migrated ids. This relocates needed styles; it is not a claim that total CSS shrank by 5,977 lines. Removed 26 superseded declarations, obsolete select-upgrader rules and a conflicting old dark palette. Existing `!important` count decreased (29 legacy + 4 UI before, 25 UI after).
- Locale retirement: global DOM walker and native select upgrader removed. Locale subscribers own text/attributes; raw user content is not rewritten. A real Electron test now exercises dynamic React attributes instead of preserving the retired walker's behavior.
- CSS/DOM-retirement checkpoint: typecheck/lint/layers/cycles/i18n/format/docs/references/isolation all exit 0; final desktop build passes. Style budget 2/2 and full locale/plan-card file 5/5 pass. Layout 4/4, React layer 4/4, language 7/7 and sessions 6/6 passed on the class-based stylesheet; the old-palette regression was fixed and layout rerun green. Product page transitions are the next T24 subtask.
- Product navigation: normal/reduced motion use cases pass with recorded compositor frames and rAF timelines. Conversation/prompt DOM identity, draft, document attachment and exact scroll position survive page changes; fast cross-frame reversals finish on the latest target. Existing motion fixture 5/5 passes. Layout/settings regressions caught an end-of-animation focus steal; focus recovery now skips an actively used control/popup. Corrected layout and full-page/model-switch cases both pass. The other seven settings cases passed (one existing MCP skip).
- Navigation checkpoint: typecheck/lint/layers/cycles/i18n/format/docs/references/isolation all exit 0. Delayed exit affects when final geometry can be measured, so layout assertions now wait for settled animation and still enforce exactly one final visible panel.
- Ruling: Opening settings refreshes the model reading without locking navigation; save/model-switch locks remain. A read-only refresh must not prevent the rapid navigation reversals required by the specification. Request ordering/lifetime cleanup is part of T25.

## Verification

- Task-definition editor checkpoint: replaced the DOM form with controlled Mantine fields and keyed acceptance rows; invalid command-argument JSON stays visible and cannot be submitted. Background task refresh preserves the draft; stale revision and late save replies are checked against the current editor/session, not the frozen list snapshot. The real workflow's old native-select assertion failed first, then full workflows 4/4, confirmation drafts 5/5 and UI i18n coverage 2/2 passed. The schedule editor is still pending the next checkpoint.

- React Slot checkpoint: `ui/slots.tsx` renders typed, keyed React contributions in all five positions; `ui/slot-registry.ts` publishes per-slot revisions. Duplicate contribution ids are rejected, frozen snapshots retain identities, and old disposers cannot remove replacements. Retired the DOM slot mount. Message metadata is React; security-sensitive message bodies remain explicit ref islands, with React-owned extension positions beside them. Registry/type contracts 6/6; React layer including dynamic order/draft/focus/unmount 6/6. Latest product build: language/subagent/copy 7/7 and paged-history 2/2.

- Bootstrap/chrome checkpoint: `renderer.ts` is a ~40-line runtime/root bootstrap. Application composition runs after committed hosts, cleans controllers, IPC/locale subscriptions, listeners, timers and observers on unmount/retry, and ignores late model-selection replies. Composer/live/model bindings now live under `ui/`. Chrome/model status/locks are React projections. All nine static gates pass. Real Electron language 7/7, React 5/5, settings 8 pass/1 existing MCP skip; the lifecycle test verifies initialization ordering, idempotent cleanup and ticker cancellation. Language navigation now waits for the outgoing page to hide instead of trying to click a hidden back button during its exit animation.

Test and screenshot scratch: `.scratch/react-completion/`. This ledger records results as work proceeds; unchecked tasks remain unfinished.
