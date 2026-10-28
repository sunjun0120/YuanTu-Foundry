import { checkSandboxAvailability, resolveSandboxConfig } from '../../packages/sandbox/sandbox.ts';
import { defaultSandboxMode, type SandboxMode } from './sandbox-settings.ts';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { toolEnvironment } from '../../packages/platform/child-environment.ts';

const executeFile = promisify(execFile);

/**
 * The sandbox facts a deployment owns, and a cache of whether a backend can actually run.
 *
 * What is *not* here is the more interesting half: there is no `save`, no file, and no "apply" — the mode a
 * session runs in belongs to the session (`apps/desktop/session-choices.ts` keeps one per session id and tells the Host
 * over the carrier's `sandbox` command). This class answers the two questions the interface still has to ask a
 * deployment: which mode does a new session start from, and does the backend behind a mode work on this
 * machine.
 *
 * Availability uses functional native runner probes, so it is asked once per mode
 * and remembered. `cached()` exists for the view, which must not block on a probe to draw a select; `probe()`
 * is what a caller awaits when it wants the answer to be there.
 */
export class SandboxEnvironment {
  /** New sessions use the launch environment's backend, defaulting to native. */
  readonly defaultMode: SandboxMode;
  /** Deprecated compatibility field; native backends do not consume a container image. */
  readonly image: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly runner?: { nodePath: string; workerPath: string };
  private readonly answers = new Map<SandboxMode, string | null>();
  constructor(
    env: NodeJS.ProcessEnv = process.env,
    runner?: { nodePath: string; workerPath: string },
  ) {
    this.env = env;
    this.runner = runner;
    this.defaultMode = defaultSandboxMode(env);
    this.image = resolveSandboxConfig({ ...env, YUANTU_SANDBOX: this.defaultMode }).image;
  }
  /** What the carrier is spawned with. The mode is the default; a session's own choice is sent afterwards. */
  environment(): NodeJS.ProcessEnv {
    return {
      YUANTU_SANDBOX: this.defaultMode,
      ...(this.env.YUANTU_SANDBOX_FILES
        ? { YUANTU_SANDBOX_FILES: this.env.YUANTU_SANDBOX_FILES }
        : {}),
      ...(this.env.YUANTU_SANDBOX_NETWORK
        ? { YUANTU_SANDBOX_NETWORK: this.env.YUANTU_SANDBOX_NETWORK }
        : {}),
    };
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
    let answer: string | null;
    if (this.runner) {
      try {
        const { stdout } = await executeFile(this.runner.nodePath, [this.runner.workerPath, mode], {
          env: toolEnvironment(this.env),
          windowsHide: true,
          maxBuffer: 65536,
        });
        const reply: unknown = JSON.parse(stdout);
        if (
          !reply ||
          typeof reply !== 'object' ||
          !('availability' in reply) ||
          (reply.availability !== null && typeof reply.availability !== 'string')
        )
          throw new Error('Invalid sandbox probe reply');
        answer = reply.availability;
      } catch (error) {
        answer = `Native sandbox probe failed: ${String(error).slice(0, 2048)}`;
      }
    } else {
      answer = await checkSandboxAvailability(mode, this.env);
    }
    this.answers.set(mode, answer);
    return answer;
  }
}
