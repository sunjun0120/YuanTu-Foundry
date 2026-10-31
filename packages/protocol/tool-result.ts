/**
 * The structured half of a tool result: a value a tool produced, and the name of the view that
 * draws it.
 *
 * A tool declares its result shape once (`ToolSpec.output`), and each result carries the value plus
 * the renderer's name. The renderer travels as a name, not a function, because the protocol is JSON
 * across a process boundary; the carrier implements the view for each name.
 */

/**
 * Every view a tool result may name. Closed so a tool cannot name a view no carrier draws; adding
 * one means a name here plus its renderer in the carrier.
 */
export const TOOL_RENDERERS = ['file-read', 'search-results', 'command-output'] as const;
export type ToolRenderer = (typeof TOOL_RENDERERS)[number];

/**
 * What a tool promises about the value in every result. JSON Schema, like `ToolSpec.inputSchema`,
 * so any validator can check it. `schema` describes `ToolResultOutput.value` only, not the text
 * form.
 */
export interface ToolOutputContract {
  schema: Record<string, unknown>;
  render: ToolRenderer;
}

/**
 * One result under a tool's contract. The renderer name rides on each result because a message
 * folded out of the log must be readable without the tool catalogue.
 */
export interface ToolResultOutput {
  render: ToolRenderer;
  value: unknown;
}

/**
 * Binds a declared contract to one value, so a result's renderer name always comes from the
 * declaration.
 */
export function toolOutput(contract: ToolOutputContract, value: unknown): ToolResultOutput {
  return { render: contract.render, value };
}
