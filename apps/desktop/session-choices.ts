import type { BrowserWindow } from 'electron';
import type { CarrierService } from '../../packages/carrier/index.ts';
import { permissionPolicyForMode, type PermissionMode } from './permission-settings.ts';
import {
  DEFAULT_PRESET,
  permissionPreset,
  presetIdFor,
  type PermissionPresetView,
} from './permission-presets.ts';
import type { SandboxEnvironment } from './sandbox-environment.ts';
import type { SandboxMode } from './sandbox-settings.ts';

/** One session's pair: where its commands run, and how much it may do without asking. */
export interface SessionChoice {
  sandbox: SandboxMode;
  permission: PermissionMode;
}

/**
 * The pair a session is in, and the pair the live carrier is actually enforcing.
 *
 * Two facts rather than one, because they can differ for as long as it takes to move — and because the carrier
 * is *one process serving every session* (`packages/tools/sandbox-provider.ts` reads the mode per command), so
 * "which pair is session X in" is knowledge only the desktop has. `sessions` remembers a choice for as long as
 * the window is open; a session nobody has chosen for starts at the default, which is the whole of "a new
 * session resets": there is nothing to clear, because the choice was never kept anywhere else.
 */
export class SessionChoices {
  private readonly sessions = new Map<string, SessionChoice>();
  private live: SessionChoice | undefined;
  /**
   * What the Host was last told for each session. The Host keeps both halves per session, so whether a switch can
   * skip a half depends on what *that* session already has, not on what the previous session was in.
   */
  private applied = new Map<string, SessionChoice>();
  private showing: string | undefined;
  /** A move in flight for a session; a second state update carrying the same id must not start a second one. */
  private moving: string | undefined;
  private current: Promise<void> | undefined;
  private readonly deps: {
    service(): CarrierService | null;
    window(): BrowserWindow | null;
    sandbox(): SandboxEnvironment;
  };
  constructor(deps: SessionChoices['deps']) {
    this.deps = deps;
  }
  /** The move in flight, if any. */
  get following(): Promise<void> | undefined {
    return this.current;
  }
  /** A replacement Host starts with launch defaults, even when it loads the same session. */
  reset(): void {
    this.live = undefined;
    this.applied = new Map();
    this.showing = undefined;
    this.moving = undefined;
    this.current = undefined;
  }
  remember(sessionId: string, choice: SessionChoice): void {
    this.sessions.set(sessionId, choice);
  }
  private defaultChoice(): SessionChoice {
    return {
      sandbox: this.deps.sandbox().defaultMode,
      permission: permissionPreset(DEFAULT_PRESET).permission,
    };
  }
  private choiceFor(sessionId: string | undefined): SessionChoice {
    return (sessionId ? this.sessions.get(sessionId) : undefined) ?? this.defaultChoice();
  }
  /**
   * Moves the live carrier onto one pair: the sandbox over the carrier's own command (the Host enforces it from
   * the next command on), the approval floor through the service handle.
   *
   * The cached pair is committed only after both settings succeed. Invalidate it on a failure so a retry
   * reapplies both halves instead of assuming a partly completed update left enforcement unchanged.
   */
  async apply(choice: SessionChoice, sessionId: string | undefined): Promise<void> {
    const target = this.deps.service();
    if (!target) throw new Error('The desktop is not connected to a carrier yet.');
    const prior = sessionId ? this.applied.get(sessionId) : undefined;
    try {
      if (!prior || prior.sandbox !== choice.sandbox)
        await target.dispatch({ type: 'sandbox', mode: choice.sandbox });
      if (!prior || prior.permission !== choice.permission)
        await target.updatePermissionPolicy(permissionPolicyForMode(choice.permission));
    } catch (error) {
      this.live = undefined;
      if (sessionId) this.applied.delete(sessionId);
      throw error;
    }
    this.live = { ...choice };
    if (sessionId) this.applied.set(sessionId, { ...choice });
    /**
     * The availability of the backend is asked for *after* the switch and never awaited: the answer costs a
     * native enforcement probe, and what a person is waiting for is the switch — a chip that froze for a
     * second and a half before redrawing would be the interface paying for a footnote. The window is told when the
     * answer lands, which is what the push channel is for.
     */
    const sandbox = this.deps.sandbox();
    if (!sandbox.known(choice.sandbox)) {
      void sandbox
        .probe(choice.sandbox)
        .then(() => this.push())
        .catch((error: unknown) =>
          console.error('desktop: could not probe the sandbox backend', error),
        );
    }
  }
  /**
   * Follows the session the window is showing, and answers the one question this feature has: when the session
   * changes, what should the sandbox be? A session with a remembered choice gets it back; a session nobody has
   * chosen for — including every newly created one — gets the default.
   */
  follow(sessionId: string): void {
    if ((sessionId === this.showing && this.live !== undefined) || sessionId === this.moving)
      return;
    this.moving = sessionId;
    const following = this.apply(this.choiceFor(sessionId), sessionId)
      .then(() => {
        this.showing = sessionId;
        this.push();
      })
      .finally(() => {
        if (this.moving === sessionId) this.moving = undefined;
      });
    this.current = following;
    void following.catch((error: unknown) => {
      // Leave `showing` unchanged after a failure so a later ready snapshot can retry the session's choice.
      console.error('desktop: could not apply the session sandbox', error);
    });
  }
  /** Tell the window which pair its session is in, once it is actually in it. */
  push(): void {
    const window = this.deps.window();
    if (window && !window.isDestroyed() && !window.webContents.isDestroyed())
      window.webContents.send('yuantu:presets-view', this.view());
  }
  /** Both knobs as the chip renders them, and which preset (if any) that pair currently is. */
  view(): PermissionPresetView {
    const sandbox = this.deps.sandbox();
    const choice =
      this.live ??
      this.choiceFor(this.showing ?? this.deps.service()?.snapshot.session.sessionId ?? undefined);
    return {
      current: presetIdFor(choice.sandbox, choice.permission),
      sandbox: {
        mode: choice.sandbox,
        image: sandbox.image,
        availability: sandbox.cached(choice.sandbox),
      },
      permission: choice.permission,
    };
  }
}
