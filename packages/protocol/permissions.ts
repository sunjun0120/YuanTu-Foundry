import type { Approval } from './index.ts';
import type { NetworkEffect } from './execution.ts';
export type PermissionDecision = 'allow' | 'deny' | 'ask';
export interface PermissionRule {
  effect: PermissionDecision;
  kind?: Approval['kind'];
  tool?: string;
  arguments?: Record<string, unknown>;
  /**
   * Glob patterns (`*` any run, `?` one character, `\` escapes) per top-level string argument; every named
   * argument must match. Mutually exclusive with `arguments`. An `allow` rule never matches a value carrying
   * shell control characters or a `..` path segment; `deny` and `ask` also match the value's normalized path
   * form, case-insensitively.
   */
  match?: Record<string, string>;
  /**
   * The network the call's execution backend leaves open (`Approval.boundary.network`). A call without a
   * boundary has an unknown network: `deny` and `ask` rules match it, `allow` rules do not.
   */
  network?: NetworkEffect;
}
export interface PermissionPolicySource {
  version: 1;
  rules: PermissionRule[];
}

/** The policy operations consumers need; configuration and implementation are owned by the host. */
export interface PermissionPolicyView {
  decide(approval: Approval): PermissionDecision | undefined;
  deniesEveryCall(tool: { name: string; permission?: Approval['kind'] }): boolean;
}
