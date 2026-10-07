import type { Approval } from './index.ts';
export type PermissionDecision = 'allow' | 'deny' | 'ask';
export interface PermissionRule {
  effect: PermissionDecision;
  kind?: Approval['kind'];
  tool?: string;
  arguments?: Record<string, unknown>;
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
