/**
 * The per-workspace Host registry for the multi-workspace desktop.
 *
 * A Host is started on demand and kept for the workspace that owns it; switching views only changes which one is
 * active. Idle, non-active Hosts are released after a bounded wait, while the active workspace and any Host the
 * caller still considers running are never stopped here. The manager owns only lifecycle and epochs; snapshot and
 * command routing stay with the caller.
 */
export interface ManagedHost {
  start(): Promise<void>;
  stop(): Promise<void>;
}

export interface HostEntry<H> {
  workspaceId: string;
  workspacePath: string;
  host: H;
  epoch: number;
  lastUsed: number;
}

export interface WorkspaceHostManagerOptions<H extends ManagedHost = ManagedHost> {
  now?: () => number;
  /** An inactive Host unused for this long may be released. */
  idleMs?: number;
  /** How many idle Hosts to keep around for fast switching. */
  keepIdle?: number;
  isBusy?: (host: H) => boolean;
}

export const DEFAULT_HOST_IDLE_MS = 5 * 60_000;
export const DEFAULT_KEEP_IDLE_HOSTS = 3;

export class WorkspaceHostManager<H extends ManagedHost> {
  private readonly create: (workspaceId: string, workspacePath: string) => H;
  private readonly now: () => number;
  private readonly idleMs: number;
  private readonly keepIdle: number;
  private readonly entries = new Map<string, HostEntry<H>>();
  private readonly starting = new Map<string, { path: string; promise: Promise<HostEntry<H>> }>();
  private readonly startingHosts = new Set<H>();
  private readonly isBusy: (host: H) => boolean;
  private activeId: string | null = null;
  private epoch = 0;
  private disposed = false;

  constructor(
    create: (workspaceId: string, workspacePath: string) => H,
    options: WorkspaceHostManagerOptions<H> = {},
  ) {
    this.create = create;
    this.now = options.now ?? Date.now;
    this.idleMs = options.idleMs ?? DEFAULT_HOST_IDLE_MS;
    this.keepIdle = Math.max(0, options.keepIdle ?? DEFAULT_KEEP_IDLE_HOSTS);
    this.isBusy = options.isBusy ?? (() => false);
  }

  /** Start (or reuse) the Host for this workspace and make it the active one. */
  async ensure(workspaceId: string, workspacePath: string, activate = true): Promise<HostEntry<H>> {
    this.assertLive();
    const existing = this.entries.get(workspaceId);
    if (existing) {
      if (existing.workspacePath !== workspacePath)
        throw new Error('Workspace id is already bound to another directory');
      existing.lastUsed = this.now();
      if (activate) this.activeId = workspaceId;
      return existing;
    }
    const pending = this.starting.get(workspaceId);
    if (pending && pending.path !== workspacePath)
      throw new Error('Workspace id is already bound to another directory');
    const promise = pending?.promise ?? this.start(workspaceId, workspacePath);
    if (!pending) this.starting.set(workspaceId, { path: workspacePath, promise });
    try {
      const entry = await promise;
      if (activate) this.activeId = workspaceId;
      return entry;
    } finally {
      if (this.starting.get(workspaceId)?.promise === promise) this.starting.delete(workspaceId);
    }
  }
  private async start(workspaceId: string, workspacePath: string): Promise<HostEntry<H>> {
    const host = this.create(workspaceId, workspacePath);
    this.startingHosts.add(host);
    try {
      await host.start();
      if (this.disposed) throw new Error('Workspace Host manager is disposed');
    } catch (error) {
      await host.stop().catch(() => {});
      throw error;
    } finally {
      this.startingHosts.delete(host);
    }
    const entry: HostEntry<H> = {
      workspaceId,
      workspacePath,
      host,
      epoch: ++this.epoch,
      lastUsed: this.now(),
    };
    this.entries.set(workspaceId, entry);
    return entry;
  }

  get(workspaceId: string): HostEntry<H> | undefined {
    return this.entries.get(workspaceId);
  }
  isStarting(workspaceId: string): boolean {
    return this.starting.has(workspaceId);
  }

  /** Take ownership of a Host the caller already started (the startup Host, before the window was ready). */
  adopt(workspaceId: string, workspacePath: string, host: H): HostEntry<H> {
    this.assertLive();
    const existing = this.entries.get(workspaceId);
    if (existing) return existing;
    const entry: HostEntry<H> = {
      workspaceId,
      workspacePath,
      host,
      epoch: ++this.epoch,
      lastUsed: this.now(),
    };
    this.entries.set(workspaceId, entry);
    this.activeId = workspaceId;
    return entry;
  }

  get activeWorkspaceId(): string | null {
    return this.activeId;
  }

  values(): HostEntry<H>[] {
    return [...this.entries.values()];
  }

  /** Selecting a workspace touches its Host so an idle release does not race the switch. */
  activate(workspaceId: string): HostEntry<H> {
    const entry = this.entries.get(workspaceId);
    if (!entry) throw new Error('Workspace Host is not running');
    entry.lastUsed = this.now();
    this.activeId = workspaceId;
    return entry;
  }

  /** Release inactive Hosts past the idle window, keeping the newest `keepIdle` of them. */
  async releaseIdle(idle = this.idleMs): Promise<string[]> {
    this.assertLive();
    const cutoff = this.now() - idle;
    const idleEntries = [...this.entries.values()]
      .filter(
        (entry) =>
          entry.workspaceId !== this.activeId &&
          entry.lastUsed <= cutoff &&
          !this.isBusy(entry.host),
      )
      .sort((a, b) => b.lastUsed - a.lastUsed);
    const released: string[] = [];
    for (const entry of idleEntries.slice(this.keepIdle)) {
      if (
        this.entries.get(entry.workspaceId) !== entry ||
        entry.workspaceId === this.activeId ||
        this.isBusy(entry.host) ||
        entry.lastUsed > cutoff
      )
        continue;
      await this.stop(entry.workspaceId);
      released.push(entry.workspaceId);
    }
    return released;
  }

  async stop(workspaceId: string): Promise<void> {
    if (this.isStarting(workspaceId)) throw new Error('Workspace Host is still starting');
    const entry = this.entries.get(workspaceId);
    if (!entry) return;
    this.entries.delete(workspaceId);
    if (this.activeId === workspaceId) this.activeId = null;
    await entry.host.stop();
  }

  async stopAll(): Promise<void> {
    this.disposed = true;
    const entries = [...this.entries.values()];
    this.entries.clear();
    this.activeId = null;
    const hosts = new Set([...entries.map((entry) => entry.host), ...this.startingHosts]);
    const results = await Promise.allSettled([...hosts].map((host) => host.stop()));
    const failures = results
      .filter((result) => result.status === 'rejected')
      .map((result) => result.reason as unknown);
    if (failures.length) throw new AggregateError(failures, failures.map(String).join('; '));
  }

  private assertLive(): void {
    if (this.disposed) throw new Error('Workspace Host manager is disposed');
  }
}
