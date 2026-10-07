import path from 'node:path';
import { mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import type { SpilledOutput } from '../protocol/index.ts';

/**
 * Tool output that does not fit in a tool result.
 *
 * A result is truncated at 24,000 characters. For a long build log, a wide search or a big diff that meant
 * the rest was gone: the model saw "[output truncated]" and could not ask for the part it needed, and the
 * user could not see it either — the output existed nowhere. The full text now goes to a file and the
 * result carries the path, the size and the line count, so both can page through it.
 *
 * Spills live under `.yuantu/spill/<session>/` in the workspace. `.yuantu` is the internal directory the
 * file tools exclude, so nothing can write here through a tool; reads opt in to this one subtree (see
 * `Workspace.resolve`), which is what makes a spilled output readable at all.
 */
export const SPILL_DIRECTORY = path.join('.yuantu', 'spill');
/**
 * The permissions a spill is written with, matching the MCP credential store (`packages/mcp/oauth.ts`).
 *
 * A spill is a copy of tool output, and tool output is whatever the tool read: file contents, environment
 * dumps, a command's stdout. It is under `.yuantu`, which the file tools exclude, so nothing in this runtime
 * exposes it — but the file sits in the user's workspace where every other process and every backup agent can
 * read it, and the default it used to get was world-readable (0644 in a 0755 directory). The directory is
 * created 0700 and the files 0600, which is the same pair the credential store already uses for the same
 * reason.
 */
const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;
/** Bounded so a runaway tool cannot fill the disk with one output: the rest is cut and said to be cut. */
const MAX_SPILL_BYTES = 8_000_000;
/**
 * How many spilled files one session keeps. Old ones are the least useful — the transcript already told the
 * model where they were and what they said — so the directory is trimmed rather than left to grow.
 */
const MAX_SPILL_FILES_PER_SESSION = 50;
const MAX_TOOL_NAME_CHARS = 40;

/** A file name that says which tool produced it, without letting the tool name escape the directory. */
function spillName(tool: string): string {
  const safe = tool.replace(/[^a-z0-9_-]+/gi, '-').slice(0, MAX_TOOL_NAME_CHARS) || 'tool';
  return `${safe}-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}.txt`;
}
/**
 * Write `content` to the session's spill directory.
 *
 * Synchronous on purpose: it runs inside the tool pipeline's result stage, which is not async, and it only
 * happens for output that is already too large to return. Failures are the caller's to handle — the pipeline
 * falls back to plain truncation, because losing the tail of a result is better than failing a tool that
 * already did its work.
 */
export function spillOutput(input: {
  workspace: string;
  sessionId: string;
  tool: string;
  content: string;
}): SpilledOutput | null {
  const directory = path.join(input.workspace, SPILL_DIRECTORY, input.sessionId);
  const file = path.join(directory, spillName(input.tool));
  const text =
    input.content.length > MAX_SPILL_BYTES
      ? input.content.slice(0, MAX_SPILL_BYTES)
      : input.content;
  mkdirSync(directory, { recursive: true, mode: DIRECTORY_MODE });
  // `wx` rather than `w`: the name carries a timestamp and a UUID, so a file already being there means
  // something else put it there, and clobbering it is not this function's business. The pipeline treats a
  // failed spill as plain truncation, which is the honest outcome.
  writeFileSync(file, text, { encoding: 'utf8', flag: 'wx', mode: FILE_MODE });
  trimSpills(directory);
  return {
    path: path.relative(input.workspace, file).split(path.sep).join('/'),
    bytes: Buffer.byteLength(text, 'utf8'),
    lines: text.split('\n').length,
  };
}
/** Keep the newest `MAX_SPILL_FILES_PER_SESSION` files. Not being able to trim is not a reason to fail. */
function trimSpills(directory: string): void {
  try {
    const files = readdirSync(directory)
      .filter((name) => name.endsWith('.txt'))
      .map((name) => ({ name, at: statSync(path.join(directory, name)).mtimeMs }))
      .sort((a, b) => b.at - a.at);
    for (const file of files.slice(MAX_SPILL_FILES_PER_SESSION))
      unlinkSync(path.join(directory, file.name));
  } catch {
    /* Trimming is housekeeping. */
  }
}
/**
 * Put the full text of a result somewhere the model can read it back, at a path derived from the result.
 *
 * Shortening an old tool result is a *projection*: it is recomputed from the transcript every round, so a
 * timestamped name would write a new file every round and the pointer in the model's view would change for no
 * reason. A name derived from the message's key means the same result always lands in the same file, and an
 * unchanged file is left alone rather than rewritten.
 */
export function spillResult(input: {
  workspace: string;
  sessionId: string;
  /** Stable identity of the message: its tool call id. */
  key: string;
  content: string;
}): SpilledOutput | null {
  const directory = path.join(input.workspace, SPILL_DIRECTORY, input.sessionId);
  const digest = createHash('sha1').update(`${input.sessionId}\u0000${input.key}`).digest('hex');
  const file = path.join(directory, `shortened-${digest.slice(0, 16)}.txt`);
  const text = input.content;
  const bytes = Buffer.byteLength(text, 'utf8');
  try {
    if (statSync(file).size === bytes) return describe(input.workspace, file, text, bytes);
  } catch {
    /* Not there yet, or unreadable: writing it is the answer either way. */
  }
  mkdirSync(directory, { recursive: true, mode: DIRECTORY_MODE });
  /**
   * `w`, not `wx`: this name is the message's identity, so rewriting an existing file is the intended repair
   * when the projection's output changed, and the early return above is what keeps the common case from
   * touching the disk at all. `mode` only applies to a file this call creates, which is exactly the case that
   * needs it — an older spill keeps whatever it was created with.
   */
  writeFileSync(file, text, { encoding: 'utf8', mode: FILE_MODE });
  trimSpills(directory);
  return describe(input.workspace, file, text, bytes);
}
function describe(workspace: string, file: string, text: string, bytes: number): SpilledOutput {
  return {
    path: path.relative(workspace, file).split(path.sep).join('/'),
    bytes,
    lines: text.split('\n').length,
  };
}
/**
 * The line a truncated result carries instead of the text that did not fit.
 *
 * It is part of the model-visible result, so it says what to do next rather than only what happened: the path, the
 * size, and the fact that `read_file` takes line ranges.
 *
 * `toolCut` is for the case where the text in the file is *itself* short of what the tool saw — a command whose
 * output was already bounded where it was produced. Then "the full N bytes" would be a promise about a tail that no
 * longer exists, and the notice says what the file actually is instead.
 */
export function spillNotice(spill: SpilledOutput, limit: number, toolCut = false): string {
  return (
    `\n[output truncated at ${limit} characters; the ${toolCut ? 'captured' : 'full'} ${spill.bytes} bytes / ${spill.lines} lines are in ` +
    `${spill.path}${toolCut ? ', and the tool had already cut its own output before that' : ''} — read it with read_file using start_line and end_line]`
  );
}
