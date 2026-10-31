import type { ExecutionPolicy } from '../../protocol/execution.ts';
import type { ToolSpec } from '../../protocol/index.ts';
import type { PermissionPolicyView } from '../../protocol/permissions.ts';
import type { SessionStore } from '../../storage/sqlite.ts';
import type { ToolRegistry } from '../../tools/registry.ts';
import { LoadedDeferredTools, sameToolSet } from './catalog.ts';

/**
 * What one run's next request consists of on the model's side: the system prompt, the tool schema,
 * the program catalog, and the two policies they derive from. They must change together, so they
 * change through one `rebuild`. `readOnly` stays the run's own.
 */
export interface RunSurfaceOptions {
  store: Pick<SessionStore, 'messages' | 'goal'>;
  sessionId: string;
  tools: ToolRegistry;
  readOnly: () => boolean;
  /** A bounded act turn exposes every tool left by the registry restriction, including deferred editors. */
  nativeTools?: () => boolean;
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
   * Re-read both policies; rebuild and return `true` when either changed. Calls in flight keep
   * their approved policy.
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
   * Rebuild the catalog when a deferred tool was loaded or a goal changed. The prompt does not
   * include the tool list, so it is not rebuilt.
   */
  refreshLoaded(): void {
    if (!this.loaded) return;
    const next = this.loadedNow();
    if (next && !sameToolSet(next, this.loaded)) {
      this.loaded = next;
      this.rebuildCatalog();
    }
  }
  /** Run-owned tools can appear when automatic verification creates a contract. */
  refreshTools(): void {
    this.rebuildCatalog();
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
      ...(this.options.nativeTools?.() ? { mode: 'native' as const } : {}),
    });
    // Every tool the run has, loaded or not: what a `run_code` program may call — trimmed like `specs`, which is
    // what keeps a read-only child's program unable to reach the parent's tools.
    this.catalog = this.options.tools.specs({ readOnly, ...policy, mode: 'native' });
  }
}
