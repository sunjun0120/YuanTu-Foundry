### tools-sandbox-3 | refuted | informational (below low)

**Checks**

- `packages/tools/fs-observation.ts:108-116` — the missing `await` is real: line 111 is
  `this.remember(await this.workspace.resolve(input, false, true));` inside a `try`/`catch` that only covers
  `resolve`, so `record` resolves while `remember`'s promise is live. Lines 162-164 confirm `seen.set` happens
  only after `statFile` resolves, and `117-139` confirms `assertRead` throws when `seen.get(file)` is empty. The
  auditor's line citations are accurate.
- `packages/tools/files.ts:654-716` — `record` is awaited at line 668, and read_file then does **real filesystem
  I/O** before returning: line 676 `workspace.resolve` (files.ts:140 `realpath(root)`, 152-166 one `lstat` per path
  segment, 167 `realpath(target)`), then line 680 `canonicalRelative` (`realpath(root)`, files.ts:82) or line 682
  `guidance` (files.ts:572 another full `resolve`). That is ≥4 threadpool requests queued _after_ the un-awaited
  `remember` lstat, on the same path.
- `packages/tools/registry.ts:388-398` — decisive guard: line 390 returns `'exclusive'` for **any** tool that
  declares a permission, so `edit_file`/`apply_patch`/`batch_edit` (`files.ts:948-951, 980-983, 1016-1019`, all
  `permission: 'write'`, none declaring `isConcurrencySafe`) can never share a group with a sibling read; the
  gated tools are always an ordering barrier of their own.
- `packages/core/tool-schedule.ts:11-34, 62-101` with `packages/core/agent.ts:3344-3361` and `3249` — `runBounded`
  awaits `start(...)` in full (`value: await start(...)`, line 77), and `start` is `runToolCall`, which awaits the
  entire pipeline result at agent.ts:3249. So the read's `execute` — including all of the post-`record` I/O above —
  has returned before the edit group's first call is dispatched.
- `packages/tools/fs-observation.ts:117-139` — `assertRead` itself awaits `workspace.resolve` (≥3 more threadpool
  ops: `files.ts:140/152-166/167`) and then `await statFile(file)` at line 125 _before_ the map is read at line 130.
- `packages/tools/files.ts:566` and `packages/tools/index.ts:126-133` — the gate is on by default in the desktop
  product (`fileObservationEnabled({}) === true`, fs-observation.ts:88-89; README.md:636 documents the flag), so
  the feature is live; only the reported ordering failure is not reachable.
- `tests/fs-observation.test.ts:67-78, 93-98` — read-then-edit in one run is an existing green test; the barrier
  behaviour the finding depends on is exercised here.
- `packages/tools/file-change.ts:78-98` — `write_file` takes the `kind === 'create'` branch and never calls
  `assertRead`; also documented at fs-observation.ts:19-21.

**Corrections**

1. The evidence is right; the **consequence is not reachable**. For the edit to see an empty map, the read's
   `remember` lstat must still be pending after (a) ≥4 later same-path threadpool requests issued by read_file
   itself, (b) the whole result/finalize pipeline, and (c) `assertRead`'s own resolve plus its own `statFile`
   (fs-observation.ts:121-130). The libuv threadpool dispatches FIFO and all these requests are on the same file,
   so a later request on that inode cannot complete while the earlier `lstat` on it is still outstanding; an
   `ENOENT`/type-change for the read's `lstat` means the file is gone or replaced, in which case the edit's own
   `resolve`/`statFile` sees the same thing and no "has not been read" refusal is produced. "Load-dependent flake"
   understates how structural this is: it is not a scheduling race, only a same-inode callback-inversion that the
   FIFO threadpool does not produce.
2. `write_file` should be dropped from the claim (it is never gated — file-change.ts:90-98), leaving
   `edit_file`, `apply_patch`, `batch_edit`.
3. `settle` has the same un-awaited `remember` (fs-observation.ts:147) and was not mentioned; the same barrier
   argument applies to it.
4. Secondary, not reported: because the `remember` promise is discarded, a _rejecting_ `statFile` escapes the
   `try`/`catch` at fs-observation.ts:110-115 as an unhandled rejection (a sync throw cannot happen inside an
   `async` function; the `catch` can only ever see `resolve` failures, which is what
   tests/fs-observation.test.ts:269-276 exercises). I found no product-level `unhandledRejection` handler
   (repo-wide grep: only three test files), but reachability again needs the file to vanish between `readRange`'s
   own regular-file check (`packages/search/lines.ts:83-86`) and the immediately following `lstat`, so this does
   not restore the finding and was not verified to terminate the Host.
5. Documented intent: fs-observation.ts:92-98 says recording is best-effort on purpose and that "the worst case is
   one extra read later — the same direction every other failure in this module errs toward"; the whole module
   header (lines 15-32) frames the gate as a heuristic nudge, not the guarantee. An extra read round trip is the
   project's stated accepted cost for a missed record.

**Reasoning**

The code genuinely does what is cited — `record` does not await `remember` — but the claimed failure mode needs an
interleaving the product cannot produce: gated tools are unconditionally exclusive (registry.ts:390) and the group
scheduler awaits the read's complete execution, which performs at least four further filesystem round trips after
the un-awaited store, before `assertRead` consults the map behind its own `resolve` + `statFile`. Since every one
of those requests is on the same inode and queued after the read's `lstat`, the store cannot lose that race while
the file still exists; when it does lose it, the file is gone and the refusal the finding describes is not what the
caller sees. Combined with the module's explicit best-effort framing, this is an unobservable ordering artifact,
not a correctness defect worth a severity.
