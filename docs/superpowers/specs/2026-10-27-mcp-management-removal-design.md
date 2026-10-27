# MCP management removal

The desktop will use remote MCP services supplied by the backend team. Users do not need a server configuration page. The user approved cleaning up the management surface first; remote endpoint provisioning follows when backend connection details are available.

## Approach

Remove the paused management renderer, configuration IPC, configuration store, connection-test worker, bridge types, navigation, styles and translations. Keeping a feature flag would retain unused code; removing MCP entirely would break the future integration. Preserve `packages/mcp`, catalog registration, session resource pooling, CLI configuration and all runtime/OAuth regression coverage.

The desktop and Host must continue sharing the existing profile-level `mcp-oauth` directory. Inline its path in the desktop Host environment before deleting `main-mcp.ts`. Do not delete credentials or workspace configuration files.

## Scope and acceptance

- No MCP configuration panel, bridge method, IPC handler or test worker remains in the desktop build.
- Remove management-only tests; keep runtime protocol, permissions, OAuth and credential tests.
- Clean stale generated management modules on rebuild so existing build directories cannot ship them.
- Backend endpoint manifests, login integration and changes to runtime configuration sources are deferred until backend details are available.
- Preserve concurrent changes and use the current feature checkout; do not commit unrelated work.
