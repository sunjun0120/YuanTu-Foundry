import type { ErrorObject } from 'ajv';
import { validateImages } from '../protocol/images.ts';
import type { ToolContext, ToolResult } from '../protocol/index.ts';
import { similarNames } from '../protocol/similar-names.ts';
import type { ToolExecutionResult } from './pipeline.ts';
import { presentedSchema } from './presented-schema.ts';
import { spillNotice } from './spill.ts';
import {
  MAX_TOOL_OUTPUT,
  OBSERVER_FAILURE_NOTICE,
  TRUNCATION_MARKER,
  bounded,
  safeSpill,
} from './tool-output.ts';

/** A failed result carrying the error's message, the shape every refusal and thrown body ends up as. */
export function errorResult(error: unknown): ToolResult {
  return {
    isError: true,
    content: error instanceof Error ? error.message : String(error),
  };
}

/** The result with its attachments validated; invalid attachments turn the whole result into a failure. */
export function normalizeImages(result: ToolResult): ToolResult {
  if (result.images === undefined) return result;
  try {
    return { ...result, images: validateImages(result.images) };
  } catch (error) {
    return errorResult(
      `Invalid tool result images: ${
        error instanceof Error ? bounded(error.message, 256) : 'image validation failed'
      }`,
    );
  }
}

/**
 * The text a model reads for a tool name nothing in this run answers to.
 *
 * `offered` is what the run may call, so a suggestion never names a tool a restriction keeps from it. A bare
 * "Unknown tool" sent the model guessing again; the near names are what turns a typo into one more round.
 */
export function unknownToolMessage(name: string, offered: Iterable<string>): string {
  const near = similarNames(name, offered);
  return (
    `Unknown tool: ${name}.` +
    (near.length ? ` Did you mean: ${near.join(', ')}?` : '') +
    ' Call a tool by its exact name from your tool list.'
  );
}

/** How much of one argument's schema an argument error may quote. */
const MAX_ARGUMENT_SCHEMA = 400;
const MAX_ARGUMENTS_QUOTED = 8;

/**
 * The text a model reads for arguments that failed schema validation.
 *
 * Ajv's text says *what* is wrong; it does not say what would be right. So the arguments the errors involve are
 * quoted with their schema (as the model is sent it), and an unknown argument close to an allowed one is named as
 * the likely rename. That matters most for a deferred tool called before it was loaded: the model never saw its
 * schema, and the error is the first place it can.
 */
export function invalidArgumentsMessage(
  errorsText: string,
  errors: readonly ErrorObject[] | null | undefined,
  schema: Record<string, unknown>,
): string {
  const properties =
    schema.properties && typeof schema.properties === 'object'
      ? (schema.properties as Record<string, unknown>)
      : {};
  const names = Object.keys(properties);
  const involved = new Set<string>();
  const renames: string[] = [];
  let additional = false;
  for (const error of errors ?? []) {
    if (error.instancePath === '' && error.keyword === 'required')
      involved.add(String(error.params.missingProperty));
    else if (error.instancePath === '' && error.keyword === 'additionalProperties') {
      additional = true;
      const extra = String(error.params.additionalProperty);
      const [near] = similarNames(extra, names, 1);
      if (near) {
        renames.push(`${extra} → ${near}`);
        involved.add(near);
      }
    } else if (error.instancePath) {
      // `/files/0` is an error in `files`: the top-level argument is the one the model can find and fix.
      const top = error.instancePath.split('/')[1]!;
      involved.add(top.replaceAll('~1', '/').replaceAll('~0', '~'));
    }
  }
  const hint = additional
    ? ` Allowed top-level arguments: ${names.slice(0, 20).join(', ') || '(none)'}.`
    : '';
  const rename = renames.length ? ` Did you mean: ${renames.join(', ')}?` : '';
  const expected = [...involved]
    .filter((name) => Object.hasOwn(properties, name))
    .slice(0, MAX_ARGUMENTS_QUOTED)
    .map((name) => {
      const value = properties[name];
      const text = JSON.stringify(
        value && typeof value === 'object'
          ? presentedSchema(value as Record<string, unknown>)
          : value,
      );
      return `${name}: ${text.length > MAX_ARGUMENT_SCHEMA ? text.slice(0, MAX_ARGUMENT_SCHEMA) + '…' : text}`;
    });
  return (
    `Invalid arguments: ${errorsText}.${hint}${rename}` +
    (expected.length ? ` Expected: ${expected.join('; ')}.` : '')
  );
}

/**
 * The result as it is persisted and shown to the model: attachments re-validated, output bounded or spilled, and
 * any observer failure noted.
 */
export function finalResult(
  result: ToolResult,
  toolName: string,
  spill: ToolContext['spill'],
  extra: { notice?: boolean; additionalContext?: string[] } = {},
): ToolExecutionResult {
  // Post-execute policies may replace attachments, so validate the final persistence boundary too.
  result = normalizeImages(result);
  /**
   * Output that does not fit is written somewhere the model can still read it, and the truncation notice
   * says where. Without a host-provided spill this is the plain truncation it always was.
   *
   * A result that already ends in `TRUNCATION_MARKER` is one a tool cut before handing it over, and it must
   * not be spilled: the copy would be the same text under a notice promising "the full N bytes / N lines",
   * so the prompt would assert a completeness the file does not have — exactly in the cases that matter
   * most, where the missing tail is the failing build or the stack. `bounded` is what cuts, and the marker
   * is what it leaves, so the marker is the test for "was this truncated" rather than a length comparison
   * against a budget the marker sits outside of.
   */
  const truncated = result.content.endsWith(TRUNCATION_MARKER);
  /**
   * A tool that already cut its own output still gets its captured text spilled — that text is the only copy —
   * but the notice says what the copy is instead of promising a tail the tool never had. Without this the
   * prompt asserted a completeness the file does not have, in exactly the case that matters most: a command
   * whose output is long enough to be bounded is a command whose tail was the failing build or the stack.
   */
  const overflow =
    !truncated && result.content.length > MAX_TOOL_OUTPUT && spill
      ? safeSpill(spill, toolName, result.content)
      : null;
  return {
    ...result,
    content:
      (overflow
        ? result.content.slice(0, MAX_TOOL_OUTPUT) +
          spillNotice(overflow, MAX_TOOL_OUTPUT, result.truncated === true)
        : bounded(result.content)) + (extra.notice ? OBSERVER_FAILURE_NOTICE : ''),
    ...(extra.additionalContext?.length ? { additionalContext: extra.additionalContext } : {}),
  };
}
