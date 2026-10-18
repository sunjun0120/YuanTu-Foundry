import { validateImages } from '../protocol/images.ts';
import type { ToolContext, ToolResult } from '../protocol/index.ts';
import type { ToolExecutionResult } from './pipeline.ts';
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

/** The text a model reads for arguments that failed schema validation. */
export function invalidArgumentsMessage(
  errorsText: string,
  properties: unknown,
  additional: boolean,
): string {
  const hint =
    additional && properties && typeof properties === 'object'
      ? ` Allowed top-level arguments: ${Object.keys(properties).slice(0, 20).join(', ') || '(none)'}.`
      : '';
  return `Invalid arguments: ${errorsText}.${hint}`;
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
