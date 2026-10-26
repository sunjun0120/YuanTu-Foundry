# Benchmark Provider Recovery Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans to implement this plan task-by-task. The user authorized incremental fixes in this chat; proceed in the current checkout and preserve existing staged and unstaged changes.

**Goal:** Recover the observed DeepSeek DSML tool turns through the normal tool pipeline, and prevent future benchmark runs from confusing response-header waits with stream stalls.

**Architecture / Spec:** OpenAI Chat may normalize a complete, terminal, unquoted DSML calls block only on DeepSeek routes (or explicit compatibility opt-in), with compatibility `off` disabling it. Parse the whole batch, validate names against the current request and arguments against their JSON schemas before returning any calls. Native calls, disabled tools, invalid/partial batches, output limits and content filtering must never lead to fallback execution. Quoted examples remain text. Ordinary text keeps streaming; buffer only a possible DSML marker and its suffix. Retain usage, reasoning and normalized native replay. Registry approval, restrictions and sandbox remain authoritative. Header and stream clocks stay separate; reuse existing zero-byte retries without changing product defaults or historical runs.

**Tech Stack:** TypeScript, Node test runner, local HTTP/SSE fixtures, Ajv.

## Global Constraints

- Preserve concurrent work and all frozen benchmark artifacts.
- Do not start paid model calls, initialize sandbox accounts, publish, or rerun benchmarks as part of this repair.
- A protocol normalization cannot authorize a tool or bypass its schema, approval or sandbox.
- New benchmark examples use explicit 120000 ms response-header wait, 60000 ms stream idle, one zero-byte retry, 16384 output tokens and 600000 ms request deadline; authorization remains false.

## Review Focus

- Fragmented markers and multiline strings must retain exact bytes and avoid displaying DSML as the answer.
- Quoted/fenced examples and non-DeepSeek responses must remain ordinary text.
- Invalid later calls must prevent the entire fallback batch from executing.
- Cancellation, partial streams and exhausted retries must not cause extra requests.
- Replayed normalized calls must retain reasoning and match the tool-result IDs.

### Task 1: Normalize observed DSML tool turns

**Files:** Create `packages/providers/deepseek-dsml.ts`, `tests/deepseek-dsml.test.ts`; modify `packages/providers/openai.ts`.

**Interfaces:** An internal parser returns `{ text: string; toolCalls: ToolCall[] } | undefined` for a final response using the current `ToolSpec[]`; a content buffer emits ordinary text while holding a possible DSML suffix. The OpenAI provider applies route, finish reason and tool-choice guards and wraps invalid DSML in a named non-retryable failure carrying usage.

- [x] Write provider regressions for fragmented read/edit calls, JSON parameters, multi-call atomic validation, ordinary examples, disabled/unknown tools, malformed/duplicate parameters, native-call conflicts, filtered/truncated turns and native replay. Assert end-to-end file effects and approval denial.
- [x] Run the new tests against unchanged production code; confirm the expected missing tool-call failures.
- [x] Implement the restricted parser and streaming integration; normalize replay into standard Chat tool calls.
- [x] Run the new tests plus provider/cache/tool regressions and replay all seven real terminal DSML messages offline.

### Task 2: Correct header-timeout diagnosis and future benchmark configuration

**Files:** Modify `packages/providers/http.ts`, `tests/provider-timeouts.test.ts`, `benchmarks/swe-bench/manifest.example.json`, `benchmarks/swe-bench/README.md`; add regression in `tests/swe-bench.test.ts` if needed for effective configuration.

**Interfaces:** Preserve failure code `timeout` and zero-byte counters; name the response-header phase in its message. Existing `controlledEnvironment` consumes explicit manifest fields and existing run logic owns the retry allowance.

- [x] Add a delayed-header fixture that recovers on exactly one zero-byte retry, plus bounded exhaustion/cancellation checks; verify the new diagnosis fails before implementation.
- [x] Correct the header diagnostic and update future-run example/documentation; retain old manifests' fallback semantics.
- [x] Run timeout/retry and SWE-bench harness regressions.

### Task 3: Verify and record

**Files:** Add `docs/2026-10-26-benchmark-provider-recovery.md` with evidence and remaining live-validation limits.

- [x] Review only this task's diff, including schema/approval boundaries and streaming consistency.
- [ ] Run format, docs/references/layers/cycles/i18n/typecheck/lint/isolation gates, full tests, build and compiled-client smoke.
- [ ] Record real results; report any unrelated failure by name. Do not infer a new benchmark score from offline replay.
