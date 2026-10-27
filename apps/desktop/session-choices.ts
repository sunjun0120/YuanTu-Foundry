import type { BrowserWindow } from 'electron';
import type { CarrierService } from '../../packages/carrier/index.ts';
import { permissionPolicyForMode, type PermissionMode } from './permission-settings.ts';
import {
  DEFAULT_PRESET,
  permissionPreset,
  presetIdFor,
  type PermissionPreset,
  type PermissionPresetView,
} from './permission-presets.ts';
import type { SandboxEnvironment } from './sandbox-environment.ts';
import type { SandboxMode } from './sandbox-settings.ts';

/** One session's pair: where its commands run, and how much it may do without asking. */
export interface SessionChoice {
  sandbox: SandboxMode;
  permission: PermissionMode;
}

/** Presets select the current platform backend, including after leaving an old or host session. */
export function choiceForPreset(preset: PermissionPreset): SessionChoice {
  return {
    sandbox: preset.sandbox,
    permission: preset.permission,
  };
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
  /**
   * A switch failed half way and the first half could not be put back, so nothing here knows the pair in force.
   *
   * `view()` refuses while this is set rather than answering with the session's remembered pair: after a sandbox
   * that moved and an approval policy that did not, that answer is exactly the pair *not* being enforced.
   */
  private uncertain = false;
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
    this.uncertain = false;
  }
  remember(sessionId: string, choice: SessionChoice): void {
    this.sessions.set(sessionId, choice);
  }
  private defaultChoice(): SessionChoice {
    const mode = this.deps.sandbox().defaultMode;
    return {
      sandbox: mode,
      permission: permissionPreset(DEFAULT_PRESET).permission,
    };
  }
  /** The session's pair as the window last chose or would get it, for a switch that keeps one half. */
  chosen(sessionId: string | undefined): SessionChoice {
    return { ...this.choiceFor(sessionId) };
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
   *
   * Both halves or neither: when the approval half fails after the sandbox has already moved, the sandbox is put
   * back to the pair that was in force before. Left as it was, the carrier enforced the new sandbox with the old
   * approval floor while the chip drew the old preset — from `guarded` to `unconfined`, isolation already gone
   * under a chip that still said otherwise. When there is nothing known to put back, or putting it back fails too,
   * the pair is marked unknown (see `uncertain`) and stays so until a later switch succeeds.
   */
  async apply(choice: SessionChoice, sessionId: string | undefined): Promise<void> {
    const target = this.deps.service();
    if (!target) throw new Error('The desktop is not connected to a carrier yet.');
    const prior = sessionId ? this.applied.get(sessionId) : undefined;
    const before = this.live;
    let sandboxMoved = false;
    try {
      if (!prior || prior.sandbox !== choice.sandbox) {
        await target.dispatch({ type: 'sandbox', mode: choice.sandbox });
        sandboxMoved = true;
      }
      if (!prior || prior.permission !== choice.permission)
        await target.updatePermissionPolicy(permissionPolicyForMode(choice.permission));
    } catch (error) {
      this.live = undefined;
      if (sessionId) this.applied.delete(sessionId);
      if (sandboxMoved) {
        let restored = false;
        if (before)
          try {
            await target.dispatch({ type: 'sandbox', mode: before.sandbox });
            restored = true;
          } catch (rollback) {
            console.error(
              'desktop: could not put the sandbox back after a failed switch',
              rollback,
            );
          }
        if (restored) this.live = { ...before! };
        else this.uncertain = true;
      }
      throw error;
    }
    this.uncertain = false;
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
    /**
     * A state published while a session command holds the carrier's gate is a progress report, not a settled
     * session. Deleting or archiving the open session moves to another one *inside* that command, so its
     * mid-flight publish already carries the new id — acting on it dispatches the preset into
     * `sessionOperationBusy` and logs a switch that never had a chance to run. The command's own last publish
     * comes after the gate is released and applies the choice then.
     */
    if (this.deps.service()?.sessionOperation) return;
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
  /** Whether a failed switch left the pair in force unknown; see `uncertain`. */
  get unknown(): boolean {
    return this.uncertain;
  }
  /**
   * Leaves the unknown state by applying the session's own pair again, both halves.
   *
   * This is what the chip's "read again" means after a failed switch: reading cannot learn which pair the carrier
   * holds, but writing one known pair makes it known.
   */
  async recover(sessionId: string | undefined): Promise<void> {
    if (!this.uncertain) return;
    await this.apply(this.choiceFor(sessionId), sessionId);
  }
  /** Tell the window which pair its session is in, once it is actually in it. */
  push(): void {
    if (this.uncertain) return;
    const window = this.deps.window();
    if (window && !window.isDestroyed() && !window.webContents.isDestroyed())
      window.webContents.send('yuantu:presets-view', this.view());
  }
  /** Both knobs as the chip renders them, and which preset (if any) that pair currently is. */
  view(): PermissionPresetView {
    if (this.uncertain)
      throw new Error(
        'A preset switch failed half way and could not be undone, so the sandbox and approval settings in force are unknown. Read them again to reapply this session’s preset.',
      );
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
