# MCP Transcript Cards Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans to implement this plan task by task. Execution is authorized by the user's request to apply the preceding recommendation.

**Goal:** Display MCP calls in separate cards while retaining local tool presentation.

**Architecture:** Add MCP segments to the transcript model, pairing results by call ID. Render these through a dedicated React component using the existing result builder, with scoped styles and localized copy.

**Tech Stack:** TypeScript, React, existing Fold disclosure, CSS, Node tests, Electron/Playwright smoke checks.

**Spec:** `docs/superpowers/specs/2026-10-30-mcp-transcript-design.md`

## Global Constraints

- Local tools retain their existing rendering.
- No protocol, execution, permission, or backend behavior changes.
- Reuse the existing safe result renderer, including images, structured cards, and extension slots.

## Review Focus

- Mixed local/MCP batches retain call order and show every result exactly once.
- Out-of-order results pair by ID; paginated orphan results stay visible.
- A stopped or historical call without a result reads unfinished.
- Appending results preserves disclosure identity; live reasoning stays outside MCP cards.
- Long tool names, narrow columns, and dark themes remain readable.

## Task 1: Model and presentation

- [x] Extend `tests/desktop-react-transcript.test.ts` with mixed-batch, result pairing, interrupted/historical call, and stable key cases; observe failure.
- [x] Add MCP segments and result pairing in `apps/desktop/ui/conversation/transcript-model.ts`.
- [x] Add `McpCalls.tsx`, safe result body reuse in `BuiltMessage.tsx`, and the segment dispatch in `Conversation.tsx`.
- [x] Synchronize run completion without rebuilding local tools in `transcript-mount.tsx`.
- [x] Add scoped responsive/theme styles and Chinese/English strings.

## Task 2: Verification

- [x] Run transcript/summary model tests, typecheck, lint, formatting, i18n and architecture gates.
- [x] Build desktop and run affected Electron smoke tests, including a real MCP approval/result journey.
- [x] Inspect light/dark and narrow-column screenshots; review diff for changes to local tool rendering.

## Results

- Final focused run: 24 unit tests and 6 real Electron smoke tests passed, with no skips or failures. Files: transcript model, summary model, desktop capabilities, React identity, and history.
- Full build passed; desktop rebuilt after final model fixes. Typecheck, changed-file ESLint/Prettier, i18n, import cycles, layers, documentation facts, references, and diff whitespace checks passed.
- Offscreen Electron component preview checked light/dark, a 420px window, English copy, long names, keyboard disclosure, running/failed/interrupted states, and horizontal overflow. The preview uses fixture data.
- Review fixes cover reused provider call IDs, correct local/MCP result placement, and stable disclosure identity when approval inserts context or older history is loaded.
- These are local checks for the affected UI, not full-suite or release acceptance.

## Revised card and process disclosures

- [x] Replace violet header tags and compact stripes with neutral gray cards, completed/total counts, bordered rows, and semantic status icons.
- [x] Default MCP cards and individual calls to collapsed; keep safe results visible on expansion and parameters in their own collapsed disclosure.
- [x] Add a collapsed outer process around consecutive MCP cards and reasoning, keeping replies, run endings, generated files, and local-only rendering unchanged.
- [x] Preserve process identities and manual expansion across updates; attach live reasoning to the tail process and include nested local folds in scroll bookkeeping.
- [x] Verify the revised model and desktop behavior: 27 unit tests and 6 Electron tests passed. Inspect light, dark, narrow, and long-name previews, default collapse, keyboard disclosure, and status updates.
