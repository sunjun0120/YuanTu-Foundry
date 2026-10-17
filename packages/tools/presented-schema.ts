/**
 * The input schema as the model is sent it: the registered schema minus bounds that only the validator needs.
 *
 * Every call is still validated against the *registered* schema (`ToolRegistry`'s Ajv instance compiles
 * `tool.inputSchema`, not this), so nothing here loosens what a call may contain. What is dropped is the noise a
 * model never acts on: `minLength: 1` (an empty string is refused with a clear error either way) and string
 * length ceilings so large they only stop runaway input (`maxLength` ≥ 200). Numeric bounds all stay — a `maximum`
 * can be a budget the model plans with (`job_output`'s `wait_ms` is the call's deadline). Bounds a model
 * does plan around stay — enums, item counts, small limits, patterns, `required` and `additionalProperties`
 * (which keeps a model from inventing parameters).
 */
const presented = new WeakMap<object, Record<string, unknown>>();

export function presentedSchema(schema: Record<string, unknown>): Record<string, unknown> {
  let found = presented.get(schema);
  if (!found) presented.set(schema, (found = strip(schema) as Record<string, unknown>));
  return found;
}

function strip(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(strip);
  if (!node || typeof node !== 'object') return node;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node)) {
    if (key === 'minLength' && value === 1) continue;
    if (key === 'maxLength' && typeof value === 'number' && value >= 200) continue;
    // `properties` maps names to schemas, so its keys are parameter names, never keywords to drop.
    out[key] =
      key === 'properties' && value && typeof value === 'object'
        ? Object.fromEntries(Object.entries(value).map(([name, child]) => [name, strip(child)]))
        : strip(value);
  }
  return out;
}
