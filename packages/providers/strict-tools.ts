import type { ToolSpec } from '../protocol/index.ts';

/**
 * Anthropic strict tool use (`strict: true` on a tool): the endpoint constrains the call's arguments to the schema,
 * so a model cannot send an argument the schema does not allow or leave out a required one.
 *
 * Three rules from the API decide what this module does, and each one fails the *whole request* with a 400 when
 * broken, which is why strictness is chosen per tool here rather than switched on for the catalog:
 *
 * - **A narrower schema language.** No `minLength`/`maxLength`, no numeric bounds, no array bounds beyond
 *   `minItems` 0 or 1, no recursion, and every object must say `additionalProperties: false`. Bounds are dropped from
 *   the copy sent with `strict` — the registry still validates every call against the registered schema, so a bound
 *   the endpoint no longer enforces is still enforced — and a tool whose schema cannot be expressed is sent as it is.
 * - **A budget per request**: at most 20 strict tools, 24 optional parameters and 16 parameters with union types,
 *   summed over every strict tool. Tools are taken in priority order until the next one would overrun a budget.
 * - **Model support.** Older models and Anthropic-compatible gateways may reject the field, so the whole feature is
 *   opt-in per connection (`YUANTU_STRICT_TOOLS`).
 */
const MAX_STRICT_TOOLS = 20;
const MAX_OPTIONAL = 24;
const MAX_UNIONS = 16;

/**
 * The tools strictness is spent on first: the ones a coding turn calls most and whose malformed arguments cost the
 * most (an edit that does not apply, a command run with a stray field). The rest follow in catalog order.
 */
export const STRICT_PRIORITY: readonly string[] = [
  'edit_file',
  'write_file',
  'run_command',
  'read_file',
  'search_files',
  'list_files',
  'apply_patch',
  'batch_edit',
  'load_tools',
];

/** Keywords the strict grammar does not accept; the registry keeps enforcing them. */
const DROPPED = new Set([
  'minLength',
  'maxLength',
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf',
  'maxItems',
  'uniqueItems',
  'minProperties',
  'maxProperties',
  // Only simple patterns are supported, and which ones is the endpoint's call: dropping them all keeps one bad
  // regex from failing every request.
  'pattern',
]);
/** Keywords whose meaning cannot be kept by dropping them: a schema that uses one is not sent as strict. */
const UNSUPPORTED = new Set([
  '$ref',
  '$defs',
  'definitions',
  'oneOf',
  'not',
  'if',
  'then',
  'else',
  'patternProperties',
  'propertyNames',
  'dependentRequired',
  'dependentSchemas',
  'prefixItems',
  'contains',
]);
const FORMATS = new Set([
  'date-time',
  'time',
  'date',
  'duration',
  'email',
  'hostname',
  'uri',
  'ipv4',
  'ipv6',
  'uuid',
]);

interface Converted {
  schema: Record<string, unknown>;
  optional: number;
  unions: number;
}

class Inexpressible extends Error {}

function isUnion(node: Record<string, unknown>): boolean {
  return Array.isArray(node.anyOf) || Array.isArray(node.type);
}

function convert(node: unknown, counts: { optional: number; unions: number }): unknown {
  if (Array.isArray(node)) return node.map((item) => convert(item, counts));
  if (!node || typeof node !== 'object') return node;
  const source = node as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(source)) {
    if (UNSUPPORTED.has(key)) throw new Inexpressible(key);
    if (DROPPED.has(key)) continue;
    if (key === 'minItems') {
      if (value === 0 || value === 1) out[key] = value;
      continue;
    }
    if (key === 'format') {
      if (typeof value === 'string' && FORMATS.has(value)) out[key] = value;
      continue;
    }
    if (
      key === 'enum' &&
      Array.isArray(value) &&
      value.some((item) => item && typeof item === 'object')
    )
      throw new Inexpressible('enum');
    if (key === 'properties' && value && typeof value === 'object') {
      const required = new Set(Array.isArray(source.required) ? (source.required as string[]) : []);
      const properties: Record<string, unknown> = {};
      for (const [name, child] of Object.entries(value)) {
        if (!required.has(name)) counts.optional++;
        if (child && typeof child === 'object' && isUnion(child as Record<string, unknown>))
          counts.unions++;
        properties[name] = convert(child, counts);
      }
      out[key] = properties;
      continue;
    }
    out[key] = convert(value, counts);
  }
  const isObject = source.type === 'object' || source.properties !== undefined;
  if (isObject && source.additionalProperties !== false)
    throw new Inexpressible('additionalProperties');
  return out;
}

/**
 * Conversions by schema object. The presented schemas are themselves cached per tool (`presentedSchema`), so a
 * request after the first converts nothing, and the same object yields the same strict copy every time.
 */
const converted = new WeakMap<object, Converted | null>();

/** The schema as strict tool use accepts it, with its budget cost; nothing when it cannot be expressed. */
export function strictSchema(schema: Record<string, unknown>): Converted | undefined {
  const known = converted.get(schema);
  if (known !== undefined) return known ?? undefined;
  const counts = { optional: 0, unions: 0 };
  let result: Converted | null;
  try {
    result = { schema: convert(schema, counts) as Record<string, unknown>, ...counts };
  } catch (error) {
    if (!(error instanceof Inexpressible)) throw error;
    result = null;
  }
  converted.set(schema, result);
  return result ?? undefined;
}

/**
 * The strict schemas to send, by tool name, chosen within the per-request budget.
 *
 * Deterministic for a given tool list, so the request prefix — and the provider's prompt cache — only changes when
 * the tool list does.
 */
export function strictTools(tools: readonly ToolSpec[]): Map<string, Record<string, unknown>> {
  const rank = (name: string) => {
    const index = STRICT_PRIORITY.indexOf(name);
    return index < 0 ? STRICT_PRIORITY.length : index;
  };
  const ordered = tools
    .map((tool, index) => ({ tool, index }))
    .sort((a, b) => rank(a.tool.name) - rank(b.tool.name) || a.index - b.index);
  const chosen = new Map<string, Record<string, unknown>>();
  let optional = 0;
  let unions = 0;
  for (const { tool } of ordered) {
    if (chosen.size >= MAX_STRICT_TOOLS) break;
    const strict = strictSchema(tool.inputSchema);
    if (!strict) continue;
    if (optional + strict.optional > MAX_OPTIONAL || unions + strict.unions > MAX_UNIONS) continue;
    optional += strict.optional;
    unions += strict.unions;
    chosen.set(tool.name, strict.schema);
  }
  return chosen;
}
