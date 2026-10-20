# Prompt cache compatibility and observability

The user approved implementing the five recommendations from the source comparison with DeepSeek Harness. Work in the current checkout; preserve unrelated work. Implement and verify the changes here without another approval round. No publishing, merging, or paid API calls are included.

## Design

- Reuse `ProviderState` for native assistant replay, scoped to the exact protocol, endpoint, model, and visible assistant content. DeepSeek compatibility defaults to known models on the official endpoint. Gateways require explicit opt-in; other providers keep their existing behavior.
- Preserve DeepSeek Chat Completions reasoning and Messages thinking/signatures. Do not replay interrupted or modified assistants. Responses keeps its existing encrypted-state handling.
- Capable routes retain an initial system snapshot and append subsequent complete system updates at their historical positions. Snapshots are recorded only when changed. Missing initial snapshots, model/endpoint switches, changed tools, and cleared prompts start a new series with the current system prompt. Native state already participates in context sizing.
- Add token usage and transport fingerprints to `provider.request.finished`. Compare actual serialized input with the previous attempt, separately for answer/summary. Report observed prefix changes, never an assumed server-side cache miss. Persist hashes/counts, not prompt text or credentials. Unknown cache usage stays unknown.
- Canonicalize tool ordering and schema property ordering; keep the deferred catalogue description stable during partial loads. Preserve execution permissions and on-demand schemas. Native tool activation is not assumed for generic gateways.
- Accept DeepSeek's dedicated cache-hit fields as fallback; prefer the standard field when both are present, validate counts, and preserve unknowns.

## Tasks and verification

1. Add focused provider fixtures for reasoning replay and route isolation. Watch failures, implement native state and compatibility resolution, then verify provider/session/context sizing behavior.
2. Add request measurements for usage, cache hit/write/miss, and serialized-prefix changes. Cover retries, failed requests, summaries, unknown usage, and restored baselines.
3. Add system snapshot projection and fixtures proving old input remains unchanged, new instructions apply in serialization, and compaction/route/tool/empty-prompt boundaries reset safely. Verify persistence and reconstruction.
4. Add tool determinism fixtures across registration order and partial loads; implement canonical ordering while preserving policy filtering and schema semantics.
5. Add usage fallback fixtures, malformed-value cases and standard-field precedence; implement compatibility and update documentation.

Run the focused tests after each task. Final gates: formatting on changed files, typecheck, documentation/reference/layer/i18n checks, the complete test runner, build, and compiled-client smoke. Report infrastructure or unrelated failures explicitly; do not modify unrelated functionality to silence them. Real cache-hit improvements require a separate live API measurement and are not claimed by fixture tests.

## Review focus

- No reasoning or system snapshots cross protocol/endpoint/model boundaries.
- Missing, modified, truncated, and interrupted historical state cannot restore stale instructions.
- Tool replies remain immediately paired with their calls; system updates follow complete tool-result batches.
- Fingerprints describe actual transport input, strip cache-control annotations, and contain no plaintext.
- Usage is per attempt, distinguishes unknown from zero, and uses input totals consistently.

## Progress

- Baseline: clean checkout on `main`, HEAD `67829c7`. Reusing the user-selected checkout under the session's workspace instructions. No commits or branch operations requested.
- Design accepted through the user's instruction to implement the preceding recommendations. Execution: inline, with focused regression tests and a final independent review.
- Tasks 1–5 implemented. Each new regression failed before its implementation; latest provider/usage focused run: 69 passed. System reconstruction, tool ordering and envelope run: 31 passed.
- Sandbox loopback `EACCES` and file-rename `EPERM` reproduced; unchanged focused tests passed outside the sandbox. Do not change product code for these restrictions.
- Typecheck found one test fixture missing `ToolResult.isError`; corrected before the final passing check.
- Independent review completed: two P2 findings (raw Chat argument preservation and answer/summary baseline restoration) reproduced with failing tests and fixed; 13 dedicated cache tests now pass, including interrupted replies, the official capability matrix, Messages multi-update restoration, and transport fingerprint normalization.
- Typecheck, build, compiled-client smoke (3 passed), reference/cycle/layer/i18n/isolation gates and scoped formatting passed. README generated facts refreshed after concurrent additions; documentation check passed.
- Two stale `run-code` assertions depended on property insertion order; updated them to retain parameter-name/type/optionality checks with canonical ordering. The complete `run-code` and deferred-tool files then passed all 55 tests.
- Shared-checkout boundary: unrelated host/desktop/workspace edits appeared during execution and are preserved. Existing coding-evaluation fixture failures were traced to a missing copy of `packages/platform/runtime-directory.ts`, already imported by `spill.ts` at baseline HEAD; do not fold unrelated evaluation changes into this cache task.
- Added a RED→GREEN legacy-history regression: DeepSeek Chat sends an empty native reasoning field for assistants without trusted replay state, without sending display-only thought text. Final provider/cache/budget run: 86 passed (14 dedicated cache tests included).
- Updated the four whole-turn snapshots after structural review. Differences were limited to tool ordering/digests, cache keys and newly recorded request usage; scenario answers, transcript content and outcomes did not change. Independent snapshot replay: 4 passed.
- Final build and typecheck passed after the last production change. Latest compiled-client smoke: 3 passed, run `1792400225709-11344-cf46c363-803a-43bc-927b-971ec59dca41`. README and scoped formatting, generated documentation and `git diff --check` passed.

## Complete regression result

`node scripts/run-tests.mjs --continue-on-failure`, run `1792399547982-21332-e6c52673-8c98-4c8a-a6c0-ea2603d8a5b8`, completed all 275 discovered test files: 2,890 tests, 2,851 passed, 11 failed, 28 skipped. Parallel: 2,796 passed / 10 failed / 24 skipped. Serial: 55 passed / 1 failed / 4 skipped. The shared checkout continued receiving unrelated changes during this run; this is not an isolated final-source acceptance claim.

Six cache-task-related initial failures (two declaration assertions and four snapshots) were corrected and independently rerun successfully as described above. The following five failures remain outside this task's changes:

- `coding-evaluation.test.ts`: `external oracle detects byte-cap regression and cannot trust a rewritten public test` and `E09 retention oracle and reference preserve the full E05 behavioral contract`. The fixture omits `packages/platform/runtime-directory.ts` imported by the copied `spill.ts`. A standalone reproduction confirmed `ERR_MODULE_NOT_FOUND` and cleaned its temporary directory. Evidence: this run's parallel coding-evaluation log.
- `product-scope.test.ts`: paused backups and MCP bridge cases. The concurrently edited preload now uses `process.platform`, but the test VM does not provide `process`. Evidence: this run's parallel product-scope log.
- `sandbox-windows.test.ts`: `another Host cannot lease a nested workspace concurrently`. Its error-message regex does not match the current `another YuanTu process` wording. Evidence: this run's serial sandbox-windows log.

Platform skips include unavailable language servers, paused product surfaces, local Office authorization, and AppContainer WFP/child-stdio acceptance limits. No live provider request, cache-hit performance benchmark, full desktop smoke, or coverage gate is claimed. Gateway opt-in remains an environment/ProviderConfig setting. Native-state budget estimates remain conservative, as documented in `docs/prompt-cache.md`. No unrelated source changes were reverted, and no commits or branch operations were performed.
