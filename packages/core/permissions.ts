import { readFileSync, statSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import type { Approval } from '../protocol/index.ts';
import type {
  PermissionDecision,
  PermissionRule,
  PermissionPolicyView,
  PermissionPolicySource,
} from '../protocol/permissions.ts';
export type {
  PermissionDecision,
  PermissionRule,
  PermissionPolicySource,
  PermissionPolicyView,
} from '../protocol/permissions.ts';
function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
export class PermissionPolicy implements PermissionPolicyView {
  private rules: PermissionRule[];
  constructor(input: unknown) {
    if (
      !object(input) ||
      input.version !== 1 ||
      !Array.isArray(input.rules) ||
      input.rules.length > 128 ||
      Object.keys(input).some((k) => !['version', 'rules'].includes(k))
    )
      throw new Error('Invalid permission policy');
    for (const rule of input.rules) {
      if (
        !object(rule) ||
        typeof rule.effect !== 'string' ||
        !['allow', 'deny', 'ask'].includes(rule.effect) ||
        Object.keys(rule).some((k) => !['effect', 'kind', 'tool', 'arguments'].includes(k)) ||
        (rule.kind === undefined && rule.tool === undefined) ||
        (rule.kind !== undefined &&
          (typeof rule.kind !== 'string' ||
            !['write', 'command', 'external'].includes(rule.kind))) ||
        (rule.tool !== undefined &&
          (typeof rule.tool !== 'string' || !/^[a-z][a-z0-9_]{0,127}$/.test(rule.tool))) ||
        (rule.arguments !== undefined && !object(rule.arguments))
      )
        throw new Error('Invalid permission rule');
    }
    this.rules = structuredClone(input.rules) as PermissionRule[];
  }
  toJSON(): PermissionPolicySource {
    return { version: 1, rules: structuredClone(this.rules) };
  }
  decide(approval: Approval): PermissionDecision | undefined {
    const matching = this.rules.filter(
      (rule) =>
        (rule.kind === undefined || rule.kind === approval.kind) &&
        (rule.tool === undefined || rule.tool === approval.toolCall.name) &&
        (rule.arguments === undefined ||
          isDeepStrictEqual(rule.arguments, approval.toolCall.arguments)),
    );
    return (['deny', 'ask', 'allow'] as const).find((effect) =>
      matching.some((rule) => rule.effect === effect),
    );
  }
  /**
   * True when no call of this tool could ever be approved under this policy, which is what makes hiding it
   * from the model safe rather than merely quiet.
   *
   * Only a `deny` rule that matches by kind or by name *and does not pin the arguments* counts: a rule that
   * pins arguments denies exactly those calls. `allow` and `ask` decide one call at a time, so neither says
   * a tool is unusable. A tool that asks for no approval is never denied here — the policy is not consulted
   * for it at all — so a rule naming such a tool does not hide it either.
   */
  deniesEveryCall(tool: { name: string; permission?: Approval['kind'] }): boolean {
    if (!tool.permission) return false;
    return this.rules.some(
      (rule) =>
        rule.effect === 'deny' &&
        rule.arguments === undefined &&
        (rule.kind === undefined || rule.kind === tool.permission) &&
        (rule.tool === undefined || rule.tool === tool.name),
    );
  }
}
/** Explicit trusted startup configuration; never auto-discover policy from a project. */
export function readPermissionPolicy(file: string | undefined): PermissionPolicy | undefined {
  if (!file) return undefined;
  const stat = statSync(file);
  if (!stat.isFile() || stat.size > 32768)
    throw new Error('Permission policy must be a file <=32KB');
  const bytes = readFileSync(file);
  if (bytes.length > 32768) throw new Error('Permission policy exceeds 32KB');
  try {
    return new PermissionPolicy(
      JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)),
    );
  } catch {
    throw new Error('Invalid permission policy JSON or rules');
  }
}
