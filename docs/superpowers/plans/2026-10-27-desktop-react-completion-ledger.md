# Desktop React completion ledger

Plan: `docs/superpowers/plans/2026-10-26-desktop-react-typescript-migration.md`

Baseline: `34a8ace`, clean worktree, branch `feat/desktop-react-completion`.
Baseline typecheck: `npm run typecheck`, exit 0 (2026-10-27).

## Scope and sequence

- [x] T24a: React owns the product skeleton and one AppShell; preserve drafts, scroll and region state.
- [ ] T24b: Product page/panel transitions and locale-owned chrome; retire legacy CSS by selector ownership.
- [x] T25a: Replace region portals with ordinary React children; independent view lifecycle.
- [ ] T25 slots: React slot ordering, dynamic registration, unload and type contracts.
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

## Verification

Test and screenshot scratch: `.scratch/react-completion/`. This ledger records results as work proceeds; unchecked tasks remain unfinished.
