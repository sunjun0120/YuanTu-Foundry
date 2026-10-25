# Workspace authorization implementation plan

> **For agentic workers:** Use superpowers:executing-plans to implement this plan task by task.

**Goal:** Complete large Windows workspace authorization without the ordinary helper's 60-second deadline, reuse completed grants safely, and expose preparation progress and actionable errors.

**Architecture:** Keep command execution deadlines unchanged. Share an abortable authorization flight among concurrent callers. Native grants use a durable completion record tied to directory identity and validate root ACLs before skipping propagation; always protect reserved names. Report preparation through the existing tool/session event path.

**Tech Stack:** TypeScript, Node child processes, Rust Windows ACL APIs, Electron renderer.

**Spec:** The user's accepted three-point proposal in this conversation (separate authorization timeout, avoid repeated ACL writes, distinguish failure stages).

## Constraints and review focus

- Preserve unrelated desktop edits; no local account provisioning or removal.
- Local ACL tests use disposable directories and synthetic SIDs only. Real-account acceptance remains GitHub Actions-only.
- Cancellation must not start a command or cancel another waiting caller.
- Missing, interrupted, legacy, changed-capability or replaced-directory records must not skip authorization.
- Existing grants must still protect newly created reserved names; no reduction in inherited isolation.
- Progress must clear on completion, failure, cancellation and session changes.

## Tasks

- [x] Add failing provider tests for timeout policy, detailed failures, retries and shared cancellation. Implement grant-specific waiting and preparation observation.
- [x] Add failing native tests for safe ACL reuse and incomplete records. Implement completion journaling, root identity and root permission checks; preserve protected-directory checks and contextual errors.
- [x] Add failing client/status tests. Wire preparation events into the run status with translated copy.
- [x] Run targeted TypeScript/native tests, typecheck, formatting/lint and builds. Review changes and record verification limits. Do not commit or push without a further request.

## What changed

- **Grant-specific waiting** (`packages/tools/sandbox-account.ts`): the `grant` helper runs with `timeout: 0` and an abort signal; concurrent callers share one flight, a caller's cancellation only leaves its own wait, and the helper is stopped when the last caller leaves. The status observer is delivered through the ambient preparation context.
- **Failure stages** (`packages/tools/sandbox-account.ts`): refusals name their stage. Account initialization keeps the helper path, the underlying `account-status` failure and the status details; workspace authorization names the root, the helper's JSON stage and path, and the exit code/signal.
- **Safe reuse** (`packages/tools/windows-sandbox/native/src/account/grants.rs`): `grants.json` records `complete` and the root's volume/file identity only after propagation _and_ reserved-name protection succeed. Reuse requires a complete record matching the directory identity and capability _and_ a matching explicit root DACL (inheritable grants, control denial before allows, no unrestricted DELETE_CHILD/WRITE_DAC). Reserved names are checked on every command, including a reused grant.
- **Contextual errors** (native): every authorization step reports a JSON `{version, stage, path, message}` on stderr, which the host turns into the refusal text.
- **Preparation visibility** (`packages/protocol/events.ts`, `packages/tools/registry.ts`, `packages/core/run-tools.ts`): a new live-only `tool.preparation` frame carries `callId`, `stage`, `root` and `active`; the registry establishes the ambient context with the call's own signal. `SessionSnapshot.sandboxPreparation` folds the pairs per call, and the run status shows `正在授权工作区…` / `Authorizing the workspace…` ahead of "running tools" while it waits.
- **Cancellation coverage** (`packages/core/acceptance.ts`, `packages/resources/hook-bridge.ts`): acceptance checks and hook commands now carry their signals into preparation, so Stop reaches a helper still propagating a first authorization.

## Verification

- `npm run typecheck`, `npm run lint`, `npm run format:check`, `npm run i18n:check`, `npm run cycles:check`, `npm run layers:check`, `npm run references:check`, `npm run docs:check`: pass. README event/test counts were regenerated with `npm run docs:generate`.
- Focused TypeScript suites: `tests/sandbox-account.test.ts`, `tests/tool-preparation.test.ts`, `tests/client.test.ts`, `tests/desktop-copy.test.ts`, `tests/acceptance.test.ts`, `tests/hook-bridge.test.ts`, `tests/execution-environment.test.ts`, `tests/tool-timeout.test.ts`, `tests/invariants.test.ts`, `tests/desktop.test.ts`, `tests/desktop-language.smoke.mjs`, plus the sandbox provider/started suites: pass.
- Native: `cargo test --lib` (68 tests, including the new reuse/interruption test) and `cargo fmt --check`: pass.
- `npm run build:windows-sandbox` (release helper with the changed Rust) and `npm run build`: pass.
- The full `npm test` suite was attempted twice and both attempts stopped early for environmental reasons, not assertion regressions: the fail-fast run reported two Host-startup timeouts in `tests/host-workflows.test.ts` and one cancellation-acknowledgement check in `tests/swe-bench.test.ts`; the continue-on-failure run reported the same `swe-bench` check and then stopped on a process leaked by `tests/host-carrier-auth.test.ts` (the scheduler treats an uncleaned process as unsafe for the rest of the run). Each involved file passes when rerun in isolation: `host-workflows` 18/18, `swe-bench` 19/19, `host-carrier-auth` 25/25. The complete suite was therefore not observed green in one pass.
- Limits: real-account acceptance (administrator account setup, ACLs naming the real sandbox group) was not run locally — the native suite exercises the same code with synthetic SIDs on disposable directories, and `tests/sandbox-account-native.test.ts` remains a GitHub Actions-only test. No commit or push was made.
