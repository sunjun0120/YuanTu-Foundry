# MCP transcript cards

The user approved a separate presentation for MCP calls, then supplied a revised neutral gray reference. Consecutive MCP calls form a gray card with a capability heading, completed/total count, and bordered rows with status icons, tool name badges, and descriptions. The card starts collapsed. Each call also starts collapsed and expands to show its safe original result, with parameters in a separate collapsed disclosure. Built-in `scan_*` calls and configured MCP proxies use the existing `mcpTarget` classification. Local tools retain their existing rendering.

The entire consecutive execution interval containing MCP cards and reasoning has an outer “Execution process” disclosure, also collapsed by default. Replies, run endings, and generated-file cards stay outside it. Manual expansion survives results, context insertions, and older-history loading. Live reasoning joins the tail execution interval without opening it. Local-only process groups keep their existing presentation.

## Approaches

Styling individual existing tool rows would leave MCP mixed into the local process fold. Replacing all process rendering would unnecessarily change local tools. Use a dedicated MCP transcript segment and component, preserving the existing local process components and the original order of calls. A local tool or reply separates MCP cards; returned MCP results are paired into their call row rather than repeated as separate process steps.

## Constraints

- Reuse the existing safe result renderer, including images, structured cards, and extension slots.
- Show running, completed, failed, and unfinished states; preserve expanded rows when results arrive.
- Use localized descriptions for known capabilities and argument/server summaries for other tools. Do not invent server metadata.
- Respect light/dark themes, narrow columns, keyboard disclosure controls, and reduced motion.
- No protocol, execution, permission, or backend behavior changes.
