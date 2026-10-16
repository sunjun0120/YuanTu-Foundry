### tools-sandbox-1 | refuted | none (was high)

**Title (as filed)** `write_command` declares no permission, so feeding stdin to a managed shell is neither approved nor removed by a read-only run.

**Checks:**

- `packages/tools/background.ts:402-418` — the factory `make(name, description, properties, required, action, permission?: 'command')`; the sixth parameter exists and `permission` is assigned to the tool at `:412`.
- `packages/tools/background.ts:432-477` — the `write_command` entry. The auditor's own cited range ends at `:476`; the factory call's **sixth argument is `'command'` on line 475**, immediately before the closing `),` at `:476`. The cited range is correct as a range and the claimed absence is inside it.
- `packages/tools/background.ts:420-431` — `start_command` passes `'command'` at `:430`; `write_command` is identical in this respect. The claimed asymmetry ("`start_command` passes `'command'` … `write_command` does not") does not exist.
- `git blame -L 470,477 -- packages/tools/background.ts` → line 475 is `'command'`, attributed to `296a09e` (initial commit), unmodified by the sandbox rewrite `ebcf581`; `git status --porcelain packages/tools/background.ts` is empty, so this is not a working-tree fix applied after the audit was written.
- `packages/tools/index.ts:70` — `for (const tool of background.tools(scope)) registry.register(tool)`; both tools are registered, i.e. shipped.
- `packages/tools/registry.ts:414`, `:662-669`, `:704-705` — the three downstream mechanisms the finding relies on. They are quoted accurately but their stated precondition (`permission === undefined`) is false, so `specs({readOnly: true})` drops `write_command`, the approval object at `:662` **is** built with `kind: 'command'`, and `:672-686` runs the approval and read-only refusal for it.
- `packages/tools/registry.ts:390` — `if (!entry || entry.tool.permission) return 'exclusive'`; a declared permission forces exclusive, contradicting the finding's premise that the missing permission is what exposes it.
- `tests/tool-concurrency-mode.test.ts:119-134` — the comment says "every file mutation, command and network call declares a permission and is therefore exclusive whatever it says", and `:126` is `assert.deepEqual(parallel.sort(), [...])`, an **exhaustive enumeration** of the parallel set, not "asserts only that _some_ call declares a permission" as the finding states. Any command tool dropping its permission would surface there.
- `README.md:148` and `README.md:174` — verified verbatim: `:148` states the 审批 column _is_ the declared permission, and `:174` lists `write_command` as 命令. The README is consistent with the code; the code is what the finding misread.

**Corrections:**

1. The central factual claim is simply wrong: `write_command` **does** declare `permission: 'command'` (`background.ts:475`, since the initial commit). The finding cites `:432-476` and then asserts the opposite of what `:475` says — this is a missed line inside the auditor's own quoted range, not a stale revision.
2. Consequently every derived consequence is void: the tool is not kept by `specs({readOnly: true})`, the approval object is built, and the read-only refusal path runs for it. There is no unapproved-execution hole and no read-only-policy escape.
3. The two test citations are also misdescribed. `tool-concurrency-mode.test.ts:126` exhaustively enumerates the parallel set via `deepEqual` (the cited `:120-124` is a comment explaining deliberate absences), and `tool-schema-trimming.test.ts:43/48/63` use `deepEqual` on named sets, not set-to-set comparison as claimed. Both would notice the regression the finding imagines.
4. Severity should be dropped from high to none — there is no defect, and nothing in the recommendation ("pass `'command'` as the sixth argument") is unimplemented; it is already there.

**Reasoning:** The finding is a single-line misread: the sixth factory argument `'command'` sits on `background.ts:475`, one line above the end of the very range the finding cites as its evidence of absence. Every security consequence in the Impact section is conditional on that argument being `undefined`, so with it present the approval gate, the read-only trim and the read-only dispatch refusal all apply to `write_command` exactly as they do to `start_command`. Nothing here is a documented-boundary dispute or a reachability question — the code and the tests both already implement the recommended fix, so the finding is refuted rather than merely downgraded.
