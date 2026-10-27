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

export interface WorkspaceHostManagerOptions {
  now?: () => number;
  /** An inactive Host unused for this long may be released. */
  idleMs?: number;
  /** How many idle Hosts to keep around for fast switching. */
  keepIdle?: number;
}

export const DEFAULT_HOST_IDLE_MS = 5 * 60_000;
export const DEFAULT_KEEP_IDLE_HOSTS = 3;

export class WorkspaceHostManager<H extends ManagedHost> {
  private readonly create: (workspaceId: string, workspacePath: string) => H;
  private readonly now: () => number;
  private readonly idleMs: number;
  private readonly keepIdle: number;
  private readonly entries = new Map<string, HostEntry<H>>();
  private activeId: string | null = null;
  private epoch = 0;
  private disposed = false;

  constructor(
    create: (workspaceId: string, workspacePath: string) => H,
    options: WorkspaceHostManagerOptions = {},
  ) {
    this.create = create;
    this.now = options.now ?? Date.now;
    this.idleMs = options.idleMs ?? DEFAULT_HOST_IDLE_MS;
    this.keepIdle = Math.max(0, options.keepIdle ?? DEFAULT_KEEP_IDLE_HOSTS);
  }

  /** Start (or reuse) the Host for this workspace and make it the active one. */
  async ensure(workspaceId: string, workspacePath: string): Promise<HostEntry<H>> {
    this.assertLive();
    const existing = this.entries.get(workspaceId);
    if (existing) {
      if (existing.workspacePath !== workspacePath)
        throw new Error('Workspace id is already bound to another directory');
      existing.lastUsed = this.now();
      this.activeId = workspaceId;
      return existing;
    }
    const host = this.create(workspaceId, workspacePath);
    try {
      await host.start();
    } catch (error) {
      await host.stop().catch(() => {});
      throw error;
    }
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

  get(workspaceId: string): HostEntry<H> | undefined {
    return this.entries.get(workspaceId);
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
      .filter((entry) => entry.workspaceId !== this.activeId && entry.lastUsed <= cutoff)
      .sort((a, b) => b.lastUsed - a.lastUsed);
    const released = idleEntries.slice(this.keepIdle);
    for (const entry of released) await this.stop(entry.workspaceId);
    return released.map((entry) => entry.workspaceId);
  }

  async stop(workspaceId: string): Promise<void> {
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
    await Promise.allSettled(entries.map((entry) => entry.host.stop()));
  }

  private assertLive(): void {
    if (this.disposed) throw new Error('Workspace Host manager is disposed');
  }
}
