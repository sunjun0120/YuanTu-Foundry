/**
 * The structured half of a tool result: a value a tool produced, and the name of the view that draws it.
 *
 * A tool result used to be text and nothing else, which is why every client could only print it: the desktop
 * `JSON.stringify`ed the *arguments* into a `<pre>` because there was no value to lay out and no vocabulary for
 * saying how one should be laid out. This module is the single place that defines what a structured result is:
 *
 * - a tool **declares** the shape of its result once, on the tool itself (`ToolSpec.output`), as a JSON Schema
 *   plus a renderer name — never once per call. Repeating the schema in every result would put the same object
 *   on the live channel and in the session log once per call, and the shape belongs to the tool rather than to
 *   the call, so a per-call copy could only ever disagree with the declaration;
 * - the **result** carries the value (`ToolResultOutput.value`) together with the renderer's *name*;
 * - the name is a member of `TOOL_RENDERERS` below, and that array is the only list of them — the tools that
 *   produce them, the carrier that draws them and the tests that check them all read it from here.
 *
 * The renderer travels as a **name** because a function cannot cross a process boundary: the protocol is JSON
 * over stdio or a socket, so the wire can say "the file-read view draws this" and no more, and the carrier
 * implements the pure function for that name. (DSH's tool declaration can carry the function itself because
 * both ends live in one process; ours cannot, and a protocol that pretended otherwise would carry a field
 * nothing could serialize.)
 */

/**
 * Every view a tool result may name.
 *
 * Closed, and closed in exactly one place. A carrier dispatches on these names, so a name it does not know is a
 * card nobody can draw; a free-form string would let a tool name a view that no carrier implements and fail at
 * the far end of the wire, in the client, with nothing there naming the tool that did it. Adding a view is
 * therefore a two-sided change — a name here and the function that draws it in the carrier — and the array is
 * what makes the first half of that visible from both sides.
 */
export const TOOL_RENDERERS = ['file-read', 'search-results', 'command-output'] as const;
export type ToolRenderer = (typeof TOOL_RENDERERS)[number];

/**
 * What a tool promises about the value in every result it returns.
 *
 * JSON Schema rather than a runtime validator, because that is what the tool *input* schemas already are
 * (`ToolSpec.inputSchema`, compiled by the registry's Ajv with `strict: true`): an author writes both halves of
 * a tool the same way, and a carrier or a test can check a payload with whatever JSON Schema implementation it
 * already has instead of importing ours. `schema` describes `ToolResultOutput.value` and nothing else — not the
 * text form, which exists for the model to read and is not part of the contract.
 */
export interface ToolOutputContract {
  schema: Record<string, unknown>;
  render: ToolRenderer;
}

/**
 * One instance of a tool's contract: the value, and which view draws it.
 *
 * The renderer's name rides on each result rather than being looked up from the tool catalogue, because nothing
 * ships that catalogue to a client: a window folds a session out of the log, where tool messages come from runs
 * whose tools an extension may since have unregistered, and a message has to be readable on its own. The name
 * is one short string, so repeating it per call costs nothing — the schema is the expensive half, and it stays
 * on the declaration.
 */
export interface ToolResultOutput {
  render: ToolRenderer;
  value: unknown;
}

/**
 * Binds a declared contract to one value.
 *
 * A tool that wrote `render: 'file-read'` into its own result would be repeating a literal its declaration
 * already holds, and the two copies could then disagree without the type system noticing — both are members of
 * the same union, so the mistake is only a wrong view rather than a type error. Going through the contract
 * makes a result's name the declaration's name, which leaves a tool one way to say it.
 */
export function toolOutput(contract: ToolOutputContract, value: unknown): ToolResultOutput {
  return { render: contract.render, value };
}
