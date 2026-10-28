// packages/builtin-services/schema.ts
import type { ValidateFunction } from 'ajv';
import { validateSchemaComplexity } from '../mcp/tools.ts';
import { compileToolSchema as compileRegisteredSchema } from '../tools/registry.ts';

/**
 * Compiles a backend tool's argument schema exactly as the registry will.
 *
 * Same Ajv, same strictness: a schema that fails here is one `registry.register` would throw on, and a throw there
 * fails the whole run. So a tool whose schema does not compile is skipped by `remoteTools`, with a log line. The
 * registry's Ajv is draft-07, so the backend contract says not to declare a 2020-12 `$schema` (it would fail here
 * rather than at registration, which is the point).
 */
export function compileToolSchema(schema: Record<string, unknown>): ValidateFunction {
  validateSchemaComplexity(schema);
  if (schema.type !== 'object') throw new Error('Tool schema must describe an object');
  if (schema.$async) throw new Error('Asynchronous tool schema');
  const validate = compileRegisteredSchema(schema);
  if ('$async' in validate && validate.$async) throw new Error('Asynchronous tool schema');
  return validate;
}

export function schemaErrors(validate: ValidateFunction): string {
  return (validate.errors ?? [])
    .slice(0, 5)
    .map((error) => `${error.instancePath || '/'} ${error.message ?? 'is invalid'}`)
    .join('; ');
}
