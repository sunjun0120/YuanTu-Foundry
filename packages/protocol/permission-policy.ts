import { readFileSync, statSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import type { Approval } from './index.ts';
import type {
  PermissionDecision,
  PermissionRule,
  PermissionPolicyView,
  PermissionPolicySource,
} from './permissions.ts';
export type {
  PermissionDecision,
  PermissionRule,
  PermissionPolicySource,
  PermissionPolicyView,
} from './permissions.ts';
function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
const MAX_MATCH_KEYS = 16;
const MAX_PATTERN_LENGTH = 1024;
/**
 * Values an `allow` pattern may never match: shell control characters or a `..` segment. Such calls
 * fall through to ordinary approval, so `npm test*` cannot approve `npm test; curl ... | sh`.
 */
const UNSAFE_FOR_ALLOW = /[;&|`$<>(){}\r\n]|(^|[\\/])\.\.([\\/]|$)/;
/** The path form a deny/ask pattern is also compared against, so `.\src\secret` cannot dodge `src/secret*`. */
function normalizedPath(value: string): string {
  return value
    .replace(/\\/g, '/')
    .replace(/\/{2,}/g, '/')
    .replace(/^(\.\/)+/, '');
}
/**
 * Values longer than this are never matched: they never satisfy `allow` and always satisfy
 * `deny`/`ask`.
 */
const MAX_MATCHED_VALUE = 64 * 1024;
/** One glob element: a literal character, `?` (one character) or `*` (any run). */
type GlobToken = { kind: 'char'; char: string } | { kind: 'one' } | { kind: 'any' };
function parseGlob(pattern: string, fold: boolean): GlobToken[] {
  const tokens: GlobToken[] = [];
  for (let index = 0; index < pattern.length; index++) {
    const char = pattern[index]!;
    if (char === '\\' && index + 1 < pattern.length) {
      const next = pattern[++index]!;
      tokens.push({ kind: 'char', char: fold ? next.toLowerCase() : next });
    } else if (char === '*') {
      if (tokens.at(-1)?.kind !== 'any') tokens.push({ kind: 'any' });
    } else if (char === '?') tokens.push({ kind: 'one' });
    else tokens.push({ kind: 'char', char: fold ? char.toLowerCase() : char });
  }
  return tokens;
}
/**
 * Greedy wildcard matching with a single backtrack point, bounded by pattern length x value length
 * (no catastrophic backtracking).
 */
function globMatches(tokens: readonly GlobToken[], value: string): boolean {
  let t = 0;
  let v = 0;
  let star = -1;
  let resume = 0;
  while (v < value.length) {
    const token = tokens[t];
    if (token && (token.kind === 'one' || (token.kind === 'char' && token.char === value[v]))) {
      t++;
      v++;
    } else if (token?.kind === 'any') {
      star = t++;
      resume = v;
    } else if (star >= 0) {
      t = star + 1;
      v = ++resume;
    } else return false;
  }
  while (tokens[t]?.kind === 'any') t++;
  return t === tokens.length;
}
type CompiledMatch = { name: string; tokens: GlobToken[] }[];
function compileMatch(rule: PermissionRule): CompiledMatch | undefined {
  if (!rule.match) return undefined;
  const fold = rule.effect !== 'allow';
  return Object.entries(rule.match).map(([name, pattern]) => ({
    name,
    tokens: parseGlob(pattern, fold),
  }));
}
function matches(
  rule: PermissionRule,
  compiled: CompiledMatch | undefined,
  args: Record<string, unknown>,
) {
  if (!compiled) return true;
  return compiled.every(({ name, tokens }) => {
    if (!Object.hasOwn(args, name)) return false;
    const value = args[name];
    if (typeof value !== 'string') return false;
    if (rule.effect === 'allow')
      return (
        value.length <= MAX_MATCHED_VALUE &&
        !UNSAFE_FOR_ALLOW.test(value) &&
        globMatches(tokens, value)
      );
    if (value.length > MAX_MATCHED_VALUE) return true;
    const folded = value.toLowerCase();
    return globMatches(tokens, folded) || globMatches(tokens, normalizedPath(folded));
  });
}
export class PermissionPolicy implements PermissionPolicyView {
  private rules: PermissionRule[];
  private compiled: (CompiledMatch | undefined)[];
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
        Object.keys(rule).some(
          (k) => !['effect', 'kind', 'tool', 'arguments', 'match', 'network'].includes(k),
        ) ||
        (rule.network !== undefined &&
          rule.network !== 'denied' &&
          rule.network !== 'unrestricted') ||
        (rule.match !== undefined &&
          (rule.arguments !== undefined ||
            !object(rule.match) ||
            Object.keys(rule.match).length < 1 ||
            Object.keys(rule.match).length > MAX_MATCH_KEYS ||
            Object.entries(rule.match).some(
              ([name, pattern]) =>
                !/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(name) ||
                typeof pattern !== 'string' ||
                pattern.length < 1 ||
                pattern.length > MAX_PATTERN_LENGTH,
            ))) ||
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
    this.compiled = this.rules.map(compileMatch);
  }
  toJSON(): PermissionPolicySource {
    return { version: 1, rules: structuredClone(this.rules) };
  }
  decide(approval: Approval): PermissionDecision | undefined {
    const matching = this.rules.filter(
      (rule, index) =>
        (rule.kind === undefined || rule.kind === approval.kind) &&
        (rule.tool === undefined || rule.tool === approval.toolCall.name) &&
        (rule.arguments === undefined ||
          isDeepStrictEqual(rule.arguments, approval.toolCall.arguments)) &&
        (rule.network === undefined ||
          (approval.boundary
            ? approval.boundary.network === rule.network
            : rule.effect !== 'allow')) &&
        matches(rule, this.compiled[index], approval.toolCall.arguments),
    );
    return (['deny', 'ask', 'allow'] as const).find((effect) =>
      matching.some((rule) => rule.effect === effect),
    );
  }
  /**
   * True when no call of this tool could ever be approved, which makes hiding it from the model
   * safe. Only a kind or name `deny` without argument pins counts. Tools needing no approval are
   * never denied here.
   */
  deniesEveryCall(tool: { name: string; permission?: Approval['kind'] }): boolean {
    if (!tool.permission) return false;
    return this.rules.some(
      (rule) =>
        rule.effect === 'deny' &&
        rule.arguments === undefined &&
        rule.match === undefined &&
        rule.network === undefined &&
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
