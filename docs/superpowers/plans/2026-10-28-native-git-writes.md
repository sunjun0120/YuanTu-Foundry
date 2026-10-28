# Native Git Writes Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans in this checkout. Track steps with checkboxes.

**Goal:** Enable approved stage/unstage, commit and managed worktree creation in native mode without granting ordinary commands metadata writes.

**Architecture:** Keep native read commands on the existing owned runner. Introduce a narrowly scoped Host metadata broker with pinned repository identity, sanitized executable/configuration, policy checks and serialized writes.

**Tech Stack:** TypeScript, Node 24, existing Git CLI and node:test.

**Spec:** `docs/superpowers/specs/2026-10-28-native-git-writes-design.md`

## Global Constraints

- Preserve the dirty checkout and earlier documentation cleanup; no commit/push requested.
- No sandbox-account provisioning, ACL relaxation, host-mode fallback or stdio MCP changes.
- Host-mode Git hooks/filter behavior stays intact. Native broker never runs repository programs.

## Review Focus

- Same-name staged content or HEAD changes during approval must refuse a commit.
- Repository metadata links, shared worktrees and executable search must not escape the proven scope.
- Filters must not silently change the committed representation.
- Denied/read-only requests must not write, even when approval callbacks allow them.
- Cancellation and failed cleanup must not report a completed mutation.

## Tasks

- [x] Add native write integration regressions and observe expected failures on the existing host-only guard.
- [x] Implement the scoped metadata broker and wire the three write tools, preserving native read execution.
- [x] Verify refusal, filter/hook, identity, worktree and host compatibility regressions; add CI-only native acceptance coverage.
- [x] Update README/tool descriptions, run relevant tests and repository checks, and obtain independent review.

## Decisions and evidence

- Ruling: reuse the current checkout under the app's default workspace preference; preserve unrelated dirty changes.
- Ruling: the user's request accepts the preceding controlled-Git recommendation; implementation proceeds without repeating approval of the same scope.
- Builder check: independent read-only review required pinned metadata, index/HEAD comparison, filter refusal, trusted executable resolution, serialization and explicit broker semantics; incorporated above.
- Ruling: native staging/checkout refuses any configured executable or required filter, even if attributes currently do not match; mutable attributes cannot safely select a transformation at the approval boundary. Cost: repositories with LFS/custom filters need a separately designed filter path. Commit from an existing index and unstage remain available.
- Ruling: config include/includeIf is refused for native writes, rather than trusting mutable external configuration. Cost: such repositories must simplify their local configuration or retain their existing manual Git workflow.
- Independent final review identified six actionable issues: native Git read executable spoofing, mutable includes, selected-workspace executable trust, literal path mismatch, mutable attributes, misleading isolation copy. Fixed with trusted absolute programs for all native reads, root equality, strict config/filter refusal, and a tool-owned approval isolation explanation checked during refresh.
- Additional deterministic regression reproduced replacement of the worktree parent during the final native preparation; destination ancestors and absence are now checked after that preparation and before the Host checkout.
- RED: initial native write run had seven expected failures on the old host-only guard. Review regressions reproduced three unsafe accepts before their fixes. The worktree parent race also reproduced an unintended checkout before its fix.
- Intermediate full `npm run check`: exit 0, 348 files, 3440 passed / 34 skipped / 0 failures, build and compiled-client smoke 3/3. This run overlapped review fixes; it is not claimed as a frozen-source final full-suite run.
- Final focused verification after all code fixes: run `1793177187693-13588-d2e4ae03-eb05-47e4-8925-68d96e839e8c`, 72 passed / 2 CI-only real-account skips / 0 failures. Covers native Git, host Git, execution policy, approval boundaries, file policy, snapshots, and native acceptance discovery.
- Final format/docs/references/typecheck/lint/layers/cycles/isolation gates passed. Real Windows account and macOS Seatbelt acceptance require the planned disposable platform runners; no account was provisioned or changed locally.
- Final rebuild after the worktree-parent fix passed; compiled-client smoke 3/3, run `1793177329851-14724-f6fa6017-7dcb-4b77-ac85-aa7ba9473803`. No commit or push was made by this task. Concurrent unrelated commits advanced HEAD to `5679839`; their changes were retained.
