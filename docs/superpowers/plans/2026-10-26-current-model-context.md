# Current Model Context Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans. The user approved injecting the current model into runtime context; implement in the current checkout and preserve other changes.

**Goal:** Let YuanTu answer which API model the current request uses from host-supplied context.

**Architecture / Spec:** Add a `model` runtime snapshot after the round's model overrides are resolved. Reuse snapshot persistence, last-wins semantics, deduplication and restoration after compaction. Prefer the effective round model, falling back to the provider's declared route. Include only the model ID and protocol; redact credentials and omit connection IDs and endpoints. An unknown model must supersede any stale model identity. Identify this as API configuration rather than verified gateway internals. Keep the system prompt stable.

**Approaches:** The user selected runtime context injection. A system-prompt section would invalidate its cached prefix on switches; a new query tool would require the model to discover and call it.

**Tech Stack:** TypeScript, Node test runner, existing SQLite session log and runtime snapshots.

## Global Constraints

- Preserve existing work; no commits, publication, benchmark runs or paid model calls are required.
- Use the effective model after pre-step hooks, including a switch back to the configured model.
- Reuse the current checkout and existing dependencies.

## Review Focus

- Unchanged rounds and resumed sessions retain one snapshot.
- Model switches and missing metadata supersede stale identities.
- Compaction restores the model identity in the visible conversation.
- Provider routes work for embedders without `modelInfo`.
- Model labels are redacted; credentials, endpoints and connection IDs are excluded.

### Task 1: Add model context and regression coverage

**Files:** Modify `packages/core/runtime-context.ts`, `packages/core/run-snapshots.ts`, `packages/core/agent.ts`, `tests/runtime-context.test.ts`, `tests/request-override.test.ts`.

**Interfaces:** Extend `RunAnnouncements.snapshots(round, route?)` with `{ model: string | null; protocol?: string }`. Pass the resolved round model and protocol from `Agent.run`. Register `model` as a runtime snapshot source.

- [ ] Add regressions for model visibility, redaction, unchanged rounds, switching, resume, compaction, unknown metadata and provider fallback.
- [ ] Run the regressions before implementation and confirm missing model context fails.
- [ ] Implement the snapshot and round integration without altering provider requests or routing.
- [ ] Run runtime-context and model-override regressions.
- [ ] Review the diff and run format, typecheck, lint, full tests and build; report real outcomes.
