# Backup surface and legacy Windows backend retirement

The user approved removing desktop backup management and retiring the restricted-token Windows backend after extracting shared helpers. Preserve existing dirty changes, CLI database maintenance, MCP runtime cleanup, and the current account sandbox.

## Approach

Delete the paused desktop backup UI/IPC/scheduler/worker and its management-only tests. Keep storage maintenance and CLI commands. Remove stale generated outputs from rebuilt packages.

Extract Windows command-line quoting and executable resolution into a focused shared module. Preserve old ACL journal inspection/recovery in a recovery-only module and keep `windows-sandbox/acl.ps1` bundled. Delete the old token launcher/provider and its dedicated execution/acceptance suites; retain helper tests and real journal recovery coverage. Reject explicit low-level `windows` execution; migrate existing shipped-app settings to `native` as before. Remove the weaker-sandbox UI/command/default. Retain the historical protocol tag only for interpreting saved records; it is not an executable provider.

## Constraints and acceptance

- Never fall back to host execution or initialize/remove sandbox accounts locally; real account isolation acceptance remains CI-only.
- Preserve old credential, database and sandbox-state files; ACL recovery must remain available after the provider is gone.
- Keep backup cleanup, Windows runtime changes and Windows UI changes on disjoint file ownership; root integrates build/docs/main references.
- Existing helper, recovery, provider, migration, permissions and CLI regressions plus relevant Electron smoke must pass. Run static/build gates and inspect stale outputs.
- Keep work uncommitted. Backend remote MCP provisioning remains deferred.
