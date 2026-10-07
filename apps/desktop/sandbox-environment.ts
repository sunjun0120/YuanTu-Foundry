import { checkSandboxAvailability, resolveSandboxConfig } from '../../packages/tools/sandbox.ts';
import { defaultSandboxMode, type SandboxMode } from './sandbox-settings.ts';

/**
 * The sandbox facts a deployment owns, and a cache of whether a backend can actually run.
 *
 * What is *not* here is the more interesting half: there is no `save`, no file, and no "apply" — the mode a
 * session runs in belongs to the session (`apps/desktop/main.ts` keeps one per session id and tells the Host
 * over the carrier's `sandbox` command). This class answers the two questions the interface still has to ask a
 * deployment: which mode does a new session start from, and does the backend behind a mode work on this
 * machine.
 *
 * The availability answer costs a process (`docker --version`, the Sandboxes CLI), so it is asked once per mode
 * and remembered. `cached()` exists for the view, which must not block on a probe to draw a select; `probe()`
 * is what a caller awaits when it wants the answer to be there.
 */
export class SandboxEnvironment {
  /** What a new session starts in: `YUANTU_SANDBOX` when the launch environment names one, else `sbx`. */
  readonly defaultMode: SandboxMode;
  /** The image the container backends use; the deployment's, not the session's. */
  readonly image: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly answers = new Map<SandboxMode, string | null>();
  constructor(env: NodeJS.ProcessEnv = process.env) {
    this.env = env;
    this.defaultMode = defaultSandboxMode(env);
    this.image = resolveSandboxConfig({ ...env, YUANTU_SANDBOX: this.defaultMode }).image;
  }
  /** What the carrier is spawned with. The mode is the default; a session's own choice is sent afterwards. */
  environment(): NodeJS.ProcessEnv {
    return { YUANTU_SANDBOX: this.defaultMode, YUANTU_SANDBOX_IMAGE: this.image };
  }
  /** The last answer for a mode without asking again; `null` while nobody has asked. */
  cached(mode: SandboxMode): string | null {
    return this.answers.get(mode) ?? null;
  }
  /** Whether anyone has asked about this mode yet — `null` from {@link cached} means two different things. */
  known(mode: SandboxMode): boolean {
    return this.answers.has(mode);
  }
  /** Ask the backend that would run the command whether it can, and remember the answer. */
  async probe(mode: SandboxMode): Promise<string | null> {
    const answer = await checkSandboxAvailability(mode, this.env);
    this.answers.set(mode, answer);
    return answer;
  }
}
