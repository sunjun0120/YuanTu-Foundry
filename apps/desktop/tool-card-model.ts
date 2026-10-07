/**
 * The pure half of the tool-result cards: one payload in, one view model out, no DOM.
 *
 * Split from the drawing code for the same reason the statistics view is split from its formatter — this is the
 * half with the decisions in it (which fields are load-bearing, what a version skew looks like, what is a missing
 * value versus an empty one), and it is the half a test can call without a browser. The drawing module is a
 * transcription of whatever this returns.
 *
 * Every check below answers the same question: *is this the shape the contract declared?* The payload crosses a
 * process boundary and a session log, so `value` is `unknown` by construction (`ToolResultOutput.value`), and the
 * only honest way to read it is to verify each field it needs. A missing field yields `null` — the caller then
 * prints the result's text form. Throwing would turn "a log written by an older build" into a broken window.
 */
import type { ToolResultOutput } from '../../packages/protocol/tool-result.ts';

/** One match of a `search_files` result. */
export interface ToolCardMatch {
  path: string;
  line: number;
  text: string;
}
/** What a card needs, per renderer name. Anything not exactly this shape produces no card. */
export type ToolCardModel =
  | {
      kind: 'file-read';
      path: string;
      language?: string;
      startLine: number;
      endLine: number;
      totalLines: number;
      text: string;
      truncated: boolean;
    }
  | {
      kind: 'search-results';
      query: string;
      mode: 'literal' | 'regex';
      matches: ToolCardMatch[];
      limited: boolean;
    }
  | {
      kind: 'command-output';
      command: string;
      exitCode: number | null;
      signal: string | null;
      timedOut: boolean;
      durationMs: number;
      stdout: string;
      stderr: string;
      truncated: boolean;
    };
function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
function text(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}
/** A number the card will render as a count or an index: integral and non-negative, like the schema says. */
function count(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;
}
function flag(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}
/** The nested arrays (search matches) get the same treatment as the outer object, one level down. */
function matches(value: unknown): ToolCardMatch[] | null {
  if (!Array.isArray(value)) return null;
  const list: ToolCardMatch[] = [];
  for (const entry of value) {
    const row = record(entry);
    const path = row && text(row.path);
    const line = row && count(row.line);
    const body = row && text(row.text);
    if (!path || !line || body === null) return null;
    list.push({ path, line, text: body });
  }
  return list;
}
/**
 * The view model for a result, or `null` when this build has no card for it.
 *
 * `undefined` (a result with no payload), an unknown renderer name, a value that is not an object, and a value
 * missing any required field all answer `null` — one answer for "print the text", because the caller has exactly
 * one fallback and four reasons to take it would be four places to keep in step.
 */
export function toolCardModel(output: ToolResultOutput | undefined): ToolCardModel | null {
  if (!output) return null;
  const value = record(output.value);
  if (!value) return null;
  if (output.render === 'file-read') {
    const path = text(value.path);
    const startLine = count(value.startLine);
    const endLine = count(value.endLine);
    const totalLines = count(value.totalLines);
    const body = text(value.text);
    const truncated = flag(value.truncated);
    // `startLine` is one-based, so zero is only valid as "the range is empty" — the schema's own floor is 1, and
    // a card that printed "lines 0–0" would be repeating a lie the payload never told.
    if (
      !path ||
      !startLine ||
      endLine === null ||
      totalLines === null ||
      body === null ||
      truncated === null
    )
      return null;
    // An absent language is a fact (the extension is unknown); a present non-string one is a skew.
    if (value.language !== undefined && text(value.language) === null) return null;
    return {
      kind: 'file-read',
      path,
      ...(value.language ? { language: value.language as string } : {}),
      startLine,
      endLine,
      totalLines,
      text: body,
      truncated,
    };
  }
  if (output.render === 'search-results') {
    const query = text(value.query);
    const mode = value.mode === 'literal' || value.mode === 'regex' ? value.mode : null;
    const list = matches(value.matches);
    const limited = flag(value.limited);
    if (query === null || !mode || !list || limited === null) return null;
    return { kind: 'search-results', query, mode, matches: list, limited };
  }
  if (output.render === 'command-output') {
    const command = text(value.command);
    // Both of these are *legitimately* null (a killed child has no exit code, a normal one no signal), so the
    // check cannot be "is it a number" — a field present with the wrong type must be told apart from a field
    // that is allowed to be null, or a skew would quietly render as "exit code unknown" forever.
    const exitCode = value.exitCode === null ? null : count(value.exitCode);
    if (value.exitCode !== null && exitCode === null) return null;
    const killed = value.signal === null ? null : text(value.signal);
    if (value.signal !== null && killed === null) return null;
    const timedOut = flag(value.timedOut);
    const durationMs = count(value.durationMs);
    const stdout = text(value.stdout);
    const stderr = text(value.stderr);
    const truncated = flag(value.truncated);
    if (
      !command ||
      timedOut === null ||
      durationMs === null ||
      stdout === null ||
      stderr === null ||
      truncated === null
    )
      return null;
    return {
      kind: 'command-output',
      command,
      exitCode,
      signal: killed,
      timedOut,
      durationMs,
      stdout,
      stderr,
      truncated,
    };
  }
  return null;
}
