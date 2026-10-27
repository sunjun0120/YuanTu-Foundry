# Backup and Legacy Windows Removal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove desktop backup management and legacy token execution while preserving database maintenance, Windows helpers and ACL recovery.

**Architecture:** Delete backup presentation/lifecycle code. Extract shared Windows command helpers and a recovery-only ACL module before deleting the legacy provider; reject retired execution modes while migrating old app settings.

**Tech Stack:** TypeScript, Electron/React, Node tests, PowerShell ACL recovery.

**Spec:** `docs/superpowers/specs/2026-10-27-backup-and-legacy-windows-removal-design.md`

**Status (2026-10-27):** implemented in the working tree, uncommitted. All three tasks are complete. The affected-area batch, the two Electron regressions and every static gate pass; a full-suite green run is not claimed because of the pre-existing load-sensitive cases recorded under **Verification limits**.

## Global Constraints

- Preserve preexisting modifications and current MCP cleanup.
- Do not change database maintenance APIs or create sandbox accounts locally.
- No host fallback; preserve recovery for old ACL journals.
- Keep the existing checkout and leave work uncommitted.

## Review Focus

- Old app settings migrate to native but raw retired mode execution fails closed.
- Historical ACL journals remain recoverable without the old process launcher.
- Account backend command quoting preserves spaces, quotes and executable resolution.
- Backup removal preserves CLI backup/verify/restore/recover/compact behavior.
- Existing build directories cannot package deleted modules/workers.

### Task 1: Desktop backup removal

**Files:** desktop backup modules, integration, dictionaries, product scope and management tests.

- [x] Remove backup surface and lifecycle references; retain CLI/storage maintenance tests.
- [x] Replace paused-bridge tests with permanent-absence checks for backup and MCP bridges.

### Task 2: Extract Windows dependencies and retire the provider

**Files:** tools Windows helpers/recovery/provider registration/parser, desktop weak-sandbox UI, affected fixtures and acceptance scripts.

- [x] Add a failing retired-mode regression and preserve app migration expectations.
- [x] Extract command helpers and ACL recovery, update imports, preserve helper/recovery tests.
- [x] Delete token launcher/provider, weak-sandbox control and obsolete acceptance suites.
- [x] Update provider-agnostic fixtures to a supported backend and remove obsolete discovery exclusions.

### Task 3: Integrate and verify

**Files:** build scripts, README, this plan.

- [x] Remove obsolete build entries and clean stale output while retaining ACL helper assets.
- [x] Run related tests, static checks, build and Electron regressions; record limitations.
- [x] Obtain an independent review and resolve actionable findings.

## Verification

Run from this checkout on 2026-10-27 (Windows, no sandbox accounts provisioned locally).

**Static and build**

| Gate                                                                                   | Result                                                                                                                                                                                                                                         |
| -------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run typecheck`                                                                    | pass                                                                                                                                                                                                                                           |
| `npm run i18n:check`, `references:check`, `cycles:check`, `layers:check`, `docs:check` | pass                                                                                                                                                                                                                                           |
| `npm run format:check`, `eslint .`                                                     | pass                                                                                                                                                                                                                                           |
| `npm run build`                                                                        | pass                                                                                                                                                                                                                                           |
| stale output                                                                           | `dist/desktop/database-backup-worker.cjs`, `mcp-test-worker.cjs`, `dist/apps/desktop/renderer-backups.js` and `packages/tools/sandbox-windows.*` are removed by `clean-paused-builds.mjs`; `acl.ps1` and `yuantu-sandbox.exe` are still copied |

**Behaviour tests**

- Affected-area batch (51 files: sandbox/Windows backends, desktop, MCP, CLI, database maintenance, background authority): 460 tests, **0 failures**, 8 platform/account skips.
- `tests/native-sandbox-migration.test.ts`: 6/6 — `windows`/`docker`/`sbx` fail closed, app launch settings migrate to `native`.
- `tests/windows-sandbox-recovery.test.ts`: 6/6 — historical ACL journals restore, refuse real changes, and keep the legacy-DACL round trip.
- `tests/windows-command.test.ts`: 2/2 — quoting preserves spaces, quotes, and executable resolution.
- `tests/background-deliveries.test.ts`: 7/7 — a durable authority written by the retired backend migrates to `native` instead of failing the wake.
- `tests/host-execution-policy.test.ts`: 7/7 — the retired `windows` selection fails closed over the wire with the `select native` message.
- `tests/desktop.test.ts`, `tests/desktop-sandbox-probe.test.ts`, `tests/product-scope.test.ts`, `tests/mcp.test.ts`, `tests/cli.test.ts`: pass; the desktop bridge exposes neither `backups` nor `mcp` even when legacy flags are injected.

**Electron regressions**

- `tests/desktop-layout.smoke.mjs`: 4/4 — no `#mcp-settings` / `#mcp-panel` node and no backup navigation in the built app.
- `tests/settings.smoke.mjs`: 8/8 — permission presets and settings page round trips.
- The full `smoke:desktop` set was not run.

**Verification limits**

- A full `npm test` run does not reach a green summary in this environment. With `FOUNDRY_TEST_CONTINUE_ON_FAILURE=1` all remaining 327 files ran (3,272 parallel + 32 serial tests); the only failure was the pre-existing load-sensitive `tests/windows-shell.test.ts` cancellation case (it passes standalone, 7/7). A plain `npm test` aborts earlier at `tests/coding-evaluation.test.ts` (`ownedProcessExited` under 8-way load; passes standalone, 25/25) and at a leaked process from `tests/host-carrier-auth.test.ts` (`Incomplete run`; passes standalone, 25/25). None of these touch the removed surfaces.
- Real Windows account journeys (`sandbox-account-native`, `windows-sandbox-host`, `native-git-native`, `tools-native`, `restricted-consumers-native`) stay skipped locally by design; they run only on disposable GitHub Actions runners.

## Review Outcome

Independent read-only review of the working-tree diff (subagent) raised six findings; four were fixed here, two are documented as deliberate follow-ups:

- **Fixed — durable background authority:** `packages/core/background-deliveries.ts` no longer drops or crashes on a legacy `windows` authority; it migrates it to `native` and now accepts `windows-account`. Regression added in `tests/background-deliveries.test.ts`.
- **Fixed — formatting:** the eight files the review flagged were rewritten with Prettier; `format:check` passes.
- **Fixed — documentation:** `README.md` and `packages/tools/windows-sandbox/README.md` / `ENHANCED-DESIGN.md` no longer describe the removed token backend as available, no longer point at the deleted `check:windows-legacy-sandbox` entry, and say how historical journals recover.
- **Fixed — stale bundle:** `renderer-backups` is in `clean-paused-builds.mjs`, so its old `dist/apps/desktop` bundle cannot be packaged.
- **Documented — `ENVIRONMENT` keeps `windows`:** dropping it would turn old `YUANTU_SANDBOX=windows` values into a generic parse error, ahead of the explicit "removed; select native" message `resolveSandboxConfig` raises. The generated README table now marks the value as legacy-only.
- **Documented — type-level follow-ups:** `ExecutionMode` still lists `windows`, which keeps unreachable branches in `terminal.ts`, `validation.ts`, `command.ts` (`plan.backend === 'windows'`) and the `SANDBOX_CHILD_SPAWN_NOTE` path alive. Removing the union member is a separate, wider typing change.

## Changed Files (summary)

- Deleted: desktop backup modules and their bridge/IPC, MCP management bridge, `packages/tools/sandbox-windows.ts`, legacy Windows acceptance suites and their test fixtures, `check-windows-legacy-sandbox` script.
- Added: `packages/tools/windows-command.ts`, `packages/tools/windows-sandbox-recovery.ts`, `scripts/windows-acceptance-output.mjs`, and the tests for the two new modules.
- Updated: desktop contract/preload/navigation/UI copy, product scope, `clean-paused-builds` / `build-desktop`, README and the Windows sandbox docs.
