Scope: `packages/tools` (54 files) — catalog + execution pipeline, command sandbox (host/windows/seatbelt),
background commands, PTY terminals, file-edit log, `run_code`. Deliberate boundaries listed in `README.md`
715–736 (host mode is not a boundary, Windows basic sandbox is a partial write boundary, guest `run_code`
isolation, concurrency) and the documented reservation/scratch behaviours in
`packages/tools/windows-sandbox/README.md` were treated as given and are not reported as defects.

## CAPABILITIES

1. Tool output is capped at `MAX_TOOL_OUTPUT = 24_000` characters; overflow is written to the session spill
   file and the result carries a notice instead of the full text (`packages/tools/registry.ts:60`,
   `packages/tools/spill.ts`).
2. The spill directory is `.yuantu/spill` inside the workspace, created `0700` with `0600` files; at most
   `MAX_SPILL_FILES_PER_SESSION = 50` files and `MAX_SPILL_BYTES = 8_000_000` bytes each, truncated on a
   UTF-8 boundary (`packages/tools/spill.ts`).
3. Truncation and spill are decided in `materialize` **after** `finalizeContent` has run
   (`registry.ts` result stage), so the overflow test and the spill notice see the finalised text, and the
   notice is skipped when the tool itself already reported `truncated: true`.
4. `run_command` collects at most `COMMAND_OUTPUT_LIMIT = 2_000_000` characters across stdout+stderr as one
   partition (never two longer copies), defaults `timeout_ms` to `60_000` and accepts at most `300_000`
   (`packages/tools/command.ts:131-148,161-167`).
5. Background jobs: 8 live (`starting`/`running`/`finishing`) and 32 kept, a 65_536-character output ring per
   job, `SETTLED_TAIL = 3000` characters retained after settlement, a 5000 ms stdin acknowledgement
   (`write_command`) and `timeout_ms` up to `3_600_000` (`packages/tools/background.ts:212-224,296`).
6. A background job runs in its own Node process (`background-worker.<js|ts>`, `detached: true`, IPC stdio)
   that owns the spawn, the kill-tree and the sandbox stop; the Host only ships the prepared plan and
   re-checks the creation policy against its JSON snapshot before accepting stdin
   (`background.ts:227-231,441-447`).
7. Terminals: 8 live and 32 kept, 65_536-character ring, 3000-character reads, `MAX_INPUT_CHARS = 4000`,
   `MAX_ARGS = 16` of `MAX_ARG_CHARS = 500`, `MAX_WAIT_MS = 120_000`, 10 s join on close, and terminals are
   refused outright for any mode outside `host|native|windows|seatbelt`
   (`packages/tools/terminal.ts:163-197,226-232`).
8. `run_code` runs in a separate Node process started with `--permission --allow-worker` and
   `--allow-fs-read=` for exactly the runner files, guest code in a `node:vm` context without globals,
   256 MB V8 heap limits, RPC caps of `1_048_576` bytes per frame, `8_388_608` bytes total and 2048 calls,
   a 5000 ms handshake (`packages/tools/code-process.ts`, `packages/tools/code-worker.ts`,
   `packages/tools/environment.ts`).
9. Inner program calls take the same concurrency classification the model's batches use: an `exclusive` call
   takes the whole pool (`catalog.parallelLimit`), a parallel call one slot, and a call that settles while
   queued is dropped rather than executed (`packages/tools/run-code.ts:75-109,226-263`).
10. Pipeline order is enforced by `ToolPipelineInvariant`: validate → pre-execute → guards → prepare →
    approval → execute → post-execute → finalize → result, with `MAX_PIPELINE_HISTORY = 64`; hooks and guards
    are deny-only and `leave(execution, completed:false)` returns early, so an aborted call is not recorded as
    a violation (`packages/tools/pipeline.ts`).
11. Approval exists only when the tool declares a `permission`; `specs({readOnly: true})` keeps exactly the
    tools with no declared permission, and the read-only policy refusal only matches `permission === 'write'`
    (`packages/tools/registry.ts:414,662-669,704-705`).
12. Deadlines: default `600_000` ms, `run_command` override `330_000` ms, `run_code` cancellation grace
    `35_000` ms, with a `TOOL_TIMEOUT` marker on the failure path (`packages/tools/timeouts.ts`,
    `registry.ts` `runWithDeadline`).
13. Credential names are matched case-insensitively per path segment on `/`-normalised labels by
    `isCredentialFileName` (`.env*` except `.env.example`, `.npmrc`, `.pypirc`, `.netrc`, `credentials*`,
    `id_rsa`/`id_ed25519`, `*.pem|p12|pfx|key`) plus a `.env` hidden-name rule, and `Workspace.resolve`
    additionally refuses escapes, NUL, foreign roots and links, permitting only `.yuantu/spill` for reads
    (`packages/tools/credential-paths.ts`, `packages/tools/files.ts`).
14. The Windows backend declares `processFiles`, `network: 'restricted'`, `pathKind` and `links: 'refused'`;
    it uses the `WRITE_RESTRICTED` token (`0x1|0x4|0x8`), a per-workspace SID (sha256 prefix) plus a
    per-command scratch SID in the restricting list, job-object tree containment, a journaled DACL change
    behind a cross-process `workspace-owner.lock`, a Low integrity label, and a real write-refusal probe as
    its availability test (`packages/tools/sandbox-windows.ts`, `packages/tools/windows-sandbox/acl.ps1`).
15. The macOS backend builds a `(deny default)` SBPL profile executed via `sandbox-exec -p`, denies writes to
    `.git/.yuantu/.agents/.codex/.aws/.ssh/.gnupg` by regex, places scratch outside the workspace, refuses
    workspace hardlinks, and proves availability by running a real probe
    (`packages/tools/sandbox-seatbelt.ts:440-495`).
16. Sandbox mode is resolved per call: `YUANTU_SANDBOX_HOOK` overrides `YUANTU_SANDBOX` for hooks, a runtime
    `setSandboxMode` overrides the environment for the `command` category only, and file/network
    requirements stay independent of the backend selection
    (`packages/tools/sandbox-provider.ts:108-149`).
17. Git runs with `GIT_CONFIG_GLOBAL=NUL|/dev/null`, `GIT_CONFIG_NOSYSTEM=1`, `GIT_OPTIONAL_LOCKS=0`,
    `GIT_TIMEOUT_MS = 15_000` and `MAX_CAPTURE_BYTES = 48_000`, and every metadata write calls
    `requireMetadataWrites()` (host mode only) before it reads repository configuration
    (`packages/tools/git.ts:109,185-188,347`).
18. `run_validation` declares `permission: 'command'` and caps manifests at 256_000 bytes with a 300_000 ms
    timeout, selecting `process.execPath` on host and a shim-safe `node`/`npm` spelling inside a sandbox
    (`packages/tools/validation.ts:384`).

## FINDINGS

### tools-sandbox-1 | high | security

**Title** `write_command` declares no permission, so feeding stdin to a managed shell is neither approved nor
removed by a read-only run.

**Evidence** `packages/tools/background.ts:402-418` passes `permission` as an optional sixth argument of
`make`; `start_command` passes `'command'` (`background.ts:420-431`), `write_command` does not
(`background.ts:432-476`). `README.md:174` lists `write_command` in the command-approval group (审批 = 命令)
and `README.md:148` states that column _is_ each tool's declared permission. The same pattern is used
everywhere else a shell is touched: `run_validation` (`validation.ts:384`), `terminal_send`/`signal`/`close`
(`terminal.ts`), `start_command`. `packages/core/agent-notices.ts:5` states the rule ("Shell commands require
permission"). Because the permission is `undefined`, `specs({readOnly: true})` keeps the tool
(`registry.ts:414`), the approval object is never built (`registry.ts:662-669`) and the read-only refusal
(`registry.ts:704-705`, `permission === 'write'`) cannot match. Impact: (a) arbitrary command execution
without an approval — the model starts an interactive shell (`start_command({command: "cmd.exe"})`, `bash`,
`powershell -Command -`) under the one approval that call legitimately requires, then sends any command line
through a tool that never asks; (b) under a read-only or deny-command policy the tool is still advertised and
still dispatches, so a run that is forbidden to run commands can drive another session's live shell.
`tests/tool-schema-trimming.test.ts` compares read-only name sets rather than enumerating them and
`tests/tool-concurrency-mode.test.ts:120-124` asserts only that _some_ call declares a permission, so nothing
fails.

**Impact** The declared permission is the only thing separating "the user approved starting this shell" from
"the model may type into it forever"; with it missing, the approval gate and the read-only filter both have a
hole that yields unapproved code execution on the host (and inside the sandbox the same shell runs, so the
hole is not limited to `host` mode).

**Recommendation** Pass `'command'` as the sixth argument of the `write_command` factory call, exactly as
`start_command` and the terminal input tools do, and extend the trimming/concurrency tests to enumerate the
tools that carry `permission: 'command'` instead of comparing sets or sampling one call.

**Confidence** high

### tools-sandbox-2 | medium | reliability

**Title** Seatbelt scratch directories are never reclaimed by the running product, not even for commands whose
process tree is long gone.

**Evidence** `prepare` creates `mkdtemp(path.join(os.tmpdir(), 'yuantu-seatbelt-'))`
(`packages/tools/sandbox-seatbelt.ts:448`), records it as `cleanupPath` (`:469`) and registers it
(`:471`); `cleanup` delegates to `ownedPlans.cleanup(plan)` (`:494`), which removes the directory only when
the plan was never started, and deliberately keeps it once `started` (`packages/tools/seatbelt-scratch.ts`;
asserted as intended by `tests/seatbelt-scratch.test.ts:25-39`, "executed Seatbelt scratch survives normal
cleanup until a real descendant reaper exists"). The scratch is the command's `HOME`, `TMPDIR`, `TMP`,
`XDG_CACHE_HOME` and `XDG_CONFIG_HOME` (`sandbox-seatbelt.ts:149-158`), so anything a build or package
manager writes there lands in that directory. Nothing in the runtime ever removes them: a repository-wide
search for `cleanupPath` finds only the two writers (`sandbox-seatbelt.ts:469`, `sandbox-windows.ts:879`) and
test teardown, and a search for `yuantu-seatbelt` finds no sweep in any package or script.

**Impact** Every command, background job and terminal started under the seatbelt backend (the darwin default)
leaves one directory behind for the lifetime of the boot, holding whatever the command treated as its home
and temp space; a session that runs `npm install` or a compiler a few dozen times accumulates that data
without bound and without any way for the operator to reclaim it short of deleting by hand. The stated reason
for retention (a detached descendant may still be confined and able to reach the scratch) only applies while
a process from _this_ Host could still exist.

**Recommendation** Keep the retention decision, but add a reclamation path that cannot race a live process:
sweep `yuantu-seatbelt-*` under `os.tmpdir()` (age-thresholded) once at Host startup, before any sandbox plan
of this process can exist, and record the sweep as an internal event. Alternatively drop the `cleanupPath`
field from seatbelt plans if no caller is ever meant to consume it.

**Confidence** high

### tools-sandbox-3 | low | correctness

**Title** `FileObservations.record` returns before the observation is stored, so the read-first gate can refuse
an edit of a file the same batch just read.

**Evidence** `record` calls `this.remember(...)` without awaiting it
(`packages/tools/fs-observation.ts:108-116`) while `remember` stores only after its `statFile` resolves, and
`assertRead` throws `${FS_NOT_OBSERVED}: … has not been read in this run` when `this.seen.get(file)` is empty
(`fs-observation.ts:117-139`). `read_file` awaits `record` and then continues with further I/O
(`packages/tools/files.ts:666-682`), so the tool call settles while the storing `lstat` may still be in
flight; the _next_ tool call (`edit_file`/`write_file`, which run after a permission-bearing sibling settles)
re-enters `assertRead` and can observe the map before that continuation runs.

**Impact** A read that succeeded is reported to the model as "has not been read in this run", which costs a
whole extra read/edit round trip and, worse, teaches the model that the gate is unreliable. The window is
narrow — `read_file` performs two more awaits after `record` — so this is a load-dependent flake rather than a
routine failure, but the ordering itself is unconditional: the awaited `record` genuinely does not guarantee
the observation exists when it resolves.

**Recommendation** `await this.remember(...)` inside `record` (the resolve/stat is already best-effort inside
`remember`), or set a placeholder entry for the resolved path before returning so the gate sees the write
immediately.

**Confidence** medium
