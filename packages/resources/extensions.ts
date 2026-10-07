import { resourceEntries, resourceText } from './files.ts';
import type { Tool } from '../protocol/index.ts';
import { commandTool } from '../tools/command.ts';
import type { ToolRegistry } from '../tools/registry.ts';
import type { ExtensionHooks } from '../protocol/tool-hooks.ts';

/** Trusted embedding API. Project files are never imported as JavaScript. */
export interface AgentExtension {
  apiVersion: 1;
  name: string;
  tools: Tool[];
  hooks?: ExtensionHooks;
}
export function registerExtension(registry: ToolRegistry, extension: AgentExtension): void {
  if (extension.apiVersion !== 1 || !extension.name || !Array.isArray(extension.tools))
    throw new Error('Invalid extension API version or tools');
  registry.registerExtension(extension.tools, extension.hooks);
}
export function extensionTools(workspace: string): Tool[] {
  return resourceEntries(workspace, '.yuantu/extensions')
    .filter((file) => file.endsWith('.json'))
    .map((file) => {
      const source = resourceText(workspace, `.yuantu/extensions/${file}`);
      // A bare SyntaxError from JSON.parse does not name the offending file, which is the first
      // thing the operator needs when a workspace declares several extension manifests. The read
      // itself stays outside the try so a real I/O failure is not misreported as malformed JSON.
      let value;
      try {
        value = JSON.parse(source);
      } catch (error) {
        throw new Error(
          `Invalid extension manifest ${file}: not valid JSON (${error instanceof Error ? error.message : String(error)})`,
        );
      }
      if (
        !value ||
        value.apiVersion !== 1 ||
        typeof value.name !== 'string' ||
        !/^[a-z][a-z0-9_]{0,47}$/.test(value.name) ||
        typeof value.description !== 'string' ||
        !value.description.trim() ||
        value.description.length > 512 ||
        typeof value.command !== 'string' ||
        !value.command.trim() ||
        value.command.length > 16000 ||
        Object.keys(value).some(
          (key) =>
            !['apiVersion', 'name', 'description', 'command', 'cwd', 'timeoutMs'].includes(key),
        )
      )
        throw new Error(`Invalid extension manifest: ${file}`);
      if (
        value.cwd !== undefined &&
        (typeof value.cwd !== 'string' || !value.cwd.trim() || value.cwd.length > 4096)
      )
        throw new Error('Invalid extension cwd');
      if (
        value.timeoutMs !== undefined &&
        (!Number.isSafeInteger(value.timeoutMs) ||
          value.timeoutMs < 100 ||
          value.timeoutMs > 300000)
      )
        throw new Error('Invalid extension timeout');
      const args = {
        command: value.command,
        cwd: value.cwd ?? '.',
        timeout_ms: value.timeoutMs ?? 60000,
      };
      return {
        name: `ext_${value.name}`,
        description: value.description,
        permission: 'command' as const,
        approvalDescription: `Extension command: ${JSON.stringify(args)}`,
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        execute: (_args, context) => commandTool(workspace).execute(args, context),
      };
    });
}
