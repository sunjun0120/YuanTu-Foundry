import type { ExecutionPolicy } from '../protocol/execution.ts';
import type { ToolSpec } from '../protocol/index.ts';
import type { PermissionPolicyView } from '../protocol/permissions.ts';
import type { SessionStore } from '../storage/sqlite.ts';
import type { ToolRegistry } from '../tools/registry.ts';
import { LoadedDeferredTools, sameToolSet } from './run-catalog.ts';

/**
 * What one run's next request is made of on the model's side: the system prompt, the tool schema it is sent, the
 * catalog a program may call, and the two policies both are derived from.
 *
 * These used to be six `let`s in `Agent.run`, each rebuilt by hand at three different places — a policy switched
 * mid-run, a plan approved mid-run, a deferred tool loaded — and every one of those places had to remember to
 * rebuild all of them together. They change together or the run tells the model something untrue (a prompt that
 * says read-only beside a schema that can write, or the reverse), so they live together and change through one
 * `rebuild`.
 *
 * `readOnly` stays the run's own: the approver, the delegation guard and the tool batch read it per call, and this
 * only needs to *see* it when a schema is built.
 */
export interface RunSurfaceOptions {
  store: Pick<SessionStore, 'messages' | 'goal'>;
  sessionId: string;
  tools: ToolRegistry;
  readOnly: () => boolean;
  /** The policies the run started under; the run reads them before the prompt hooks, so they are handed in. */
  policy: PermissionPolicyView | undefined;
  executionPolicy: ExecutionPolicy | undefined;
  /** The host's live view of each policy, re-read at every round boundary. */
  currentPolicy?: () => PermissionPolicyView | undefined;
  currentExecutionPolicy?: () => ExecutionPolicy;
  /** The plan-phase paragraph the run starts with; empty outside a plan run. */
  planNotice: string;
  /** Assemble the system prompt for this plan notice (and record its trace). */
  composeSystem: (planNotice: string) => string;
}
export class RunSurface {
  policy: PermissionPolicyView | undefined;
  executionPolicy: ExecutionPolicy | undefined;
  planNotice: string;
  system = '';
  /** The schema the next request carries. */
  specs: ToolSpec[] = [];
  /** The same trimmed set, never folded: what a `run_code` program may call. */
  catalog: ToolSpec[] = [];
  /** The deferred tools the transcript has loaded, or `undefined` outside the deferred tool mode. */
  private loaded: Set<string> | undefined;
  private readonly options: RunSurfaceOptions;
  private readonly loadedTracker: LoadedDeferredTools;
  constructor(options: RunSurfaceOptions) {
    this.options = options;
    this.loadedTracker = new LoadedDeferredTools(options.store, options.sessionId, options.tools);
    this.policy = options.policy;
    this.executionPolicy = options.executionPolicy;
    this.planNotice = options.planNotice;
    this.loaded = this.loadedNow();
    this.rebuild();
  }
  /**
   * Re-read both policies; rebuild and answer `true` when either changed.
   *
   * The desktop can switch the permission preset or the sandbox while a run is in flight, and a run that kept the
   * snapshot it started with would keep offering tools the policy now denies and describing an environment it is no
   * longer in. A call already in flight keeps the policy it was approved under — the tool layer rechecks that.
   */
  refreshPolicies(): boolean {
    const policy = this.options.currentPolicy?.();
    const executionPolicy = this.options.currentExecutionPolicy?.();
    if (
      policy === this.policy &&
      JSON.stringify(executionPolicy) === JSON.stringify(this.executionPolicy)
    )
      return false;
    this.policy = policy;
    this.executionPolicy = executionPolicy;
    this.rebuild();
    return true;
  }
  /** A new plan paragraph (a plan approved mid-run), and the prompt and schema rebuilt around it. */
  setPlanNotice(planNotice: string): void {
    this.planNotice = planNotice;
    this.rebuild();
  }
  /**
   * Widen (or narrow) the catalog when the transcript loaded a deferred tool or a goal changed.
   *
   * The transcript part only grows, so this rebuilds once per load or goal transition rather than per round. The
   * prompt is not rebuilt: the tool list is not part of it.
   */
  refreshLoaded(): void {
    if (!this.loaded) return;
    const next = this.loadedNow();
    if (next && !sameToolSet(next, this.loaded)) {
      this.loaded = next;
      this.rebuildCatalog();
    }
  }
  private loadedNow(): Set<string> | undefined {
    return this.loadedTracker.current();
  }
  private rebuild(): void {
    this.system = this.options.composeSystem(this.planNotice);
    this.rebuildCatalog();
  }
  private rebuildCatalog(): void {
    const readOnly = this.options.readOnly();
    const policy = this.policy ? { policy: this.policy } : {};
    this.specs = this.options.tools.specs({
      readOnly,
      ...policy,
      ...(this.loaded ? { loaded: this.loaded } : {}),
    });
    // Differs from `specs` only under `YUANTU_TOOL_MODE=ptc`: what the model is *sent* may be one tool with a
    // declaration list, while what the run *has* is unchanged — which is what keeps a read-only child's program
    // unable to reach the parent's tools.
    this.catalog = this.options.tools.specs({ readOnly, ...policy, mode: 'native' });
  }
}
