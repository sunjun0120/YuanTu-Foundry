import path from 'node:path';
import { hookBridgeSettings, loadHookDeclarations } from '../../packages/resources/hook-config.ts';
import type { HookDeclaration } from '../../packages/resources/hook-config.ts';
import {
  hookDeclarationsDigest,
  trustWorkspaceHooks,
  workspaceHookTrust,
} from '../../packages/resources/hook-trust.ts';

/** What the operator is asked about: every command, where it was declared, and why it is being asked now. */
export interface HookTrustQuestion {
  workspace: string;
  declarations: readonly HookDeclaration[];
  /** `changed` when an earlier trust record exists for different declarations. */
  reason: 'untrusted' | 'changed' | 'unavailable';
  detail?: string;
}
export type HookTrustAnswer = 'trust' | 'skip';
export type HookTrustOutcome = 'none' | 'trusted' | 'skipped' | 'error';
/**
 * Asks once per workspace and declaration set before the desktop starts a Host for it.
 *
 * The Host enforces trust on its own (`createTools` installs only trusted declarations), so this is the half
 * that *grants* it: it is the one place in the product with a human in front of it. "Not now" is remembered
 * for this desktop process only, so restarting the Host for a settings change does not ask again, while the
 * next launch — or any change to the declarations — does.
 */
export class HookTrustReview {
  private readonly skipped = new Set<string>();
  private readonly ask: (question: HookTrustQuestion) => Promise<HookTrustAnswer>;
  private readonly env: NodeJS.ProcessEnv;
  constructor(
    ask: (question: HookTrustQuestion) => Promise<HookTrustAnswer>,
    env: NodeJS.ProcessEnv = process.env,
  ) {
    this.ask = ask;
    this.env = env;
  }
  async review(workspace: string): Promise<HookTrustOutcome> {
    const settings = hookBridgeSettings(this.env);
    if (!settings.enabled || settings.trustAll) return 'none';
    let declarations: HookDeclaration[];
    try {
      declarations = loadHookDeclarations(workspace, settings.timeoutMs);
    } catch {
      // A malformed hook file is reported by the Host when a run starts, naming the file; there is nothing
      // trustworthy to show here.
      return 'error';
    }
    if (!declarations.length) return 'none';
    const state = settings.trustFile
      ? workspaceHookTrust(workspace, declarations, settings.trustFile)
      : ({ trusted: false, reason: 'unavailable', detail: 'no user state directory' } as const);
    if (state.trusted) return 'trusted';
    let digest: string;
    try {
      digest = hookDeclarationsDigest(workspace, declarations);
    } catch {
      return 'error';
    }
    const key = `${path.resolve(workspace)}\0${digest}`;
    if (this.skipped.has(key)) return 'skipped';
    const answer = await this.ask({
      workspace,
      declarations,
      reason: state.reason,
      ...(state.detail === undefined ? {} : { detail: state.detail }),
    });
    if (answer === 'trust' && settings.trustFile && state.reason !== 'unavailable') {
      try {
        if (
          hookDeclarationsDigest(workspace, loadHookDeclarations(workspace, settings.timeoutMs)) !==
          digest
        )
          return 'error';
        trustWorkspaceHooks(workspace, declarations, settings.trustFile);
      } catch {
        return 'error';
      }
      return 'trusted';
    }
    this.skipped.add(key);
    return 'skipped';
  }
}
