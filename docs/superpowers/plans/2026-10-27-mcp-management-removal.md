# MCP Management Removal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Remove the desktop MCP configuration surface while preserving remote MCP runtime and credentials.

**Architecture:** Delete management-only modules and references, preserve the credential path in the desktop Host environment, and retain the MCP package and session connection pool. Clean stale build outputs.

**Tech Stack:** TypeScript, React, Electron, esbuild, Node test runner.

**Spec:** `docs/superpowers/specs/2026-10-27-mcp-management-removal-design.md`

## Global Constraints

- Preserve concurrent changes and current runtime/CLI configuration behavior.
- Do not delete credential data or add endpoint provisioning before backend details are supplied.
- Work in the existing feature checkout; leave changes uncommitted.

## Review Focus

- Reusing an existing dist directory must not ship removed workers or modules.
- The Host must retain the same OAuth credential directory.
- Removing settings navigation must preserve the three remaining React settings sections.
- MCP runtime HTTP/SSE, permissions, OAuth and connection pooling must remain operational.
- Removal of management tests must not remove runtime coverage.

### Task 1: Remove the configuration surface

**Files:** desktop MCP management modules, main/preload/contract, React application/navigation/styles, dictionaries, build scripts, product-scope and related tests.

**Interfaces:** retain `mcpTools`, `acquireMcpTools`, MCP OAuth APIs and `YUANTU_MCP_OAUTH_DIR`; remove `DesktopBridge.mcp` and `PRODUCT_SCOPE.mcpManagement`.

- [x] Adapt the existing product-scope regression to require that the MCP bridge stays absent even with legacy flags enabled; observe failure before production changes.
- [x] Remove management modules and their references; preserve the OAuth directory directly in main.
- [x] Remove management-only unit/smoke cases and copy; retain runtime tests.
- [x] Extend existing stale-build cleanup to the removed generated files.

### Task 2: Verify and document

**Files:** README, this plan, existing relevant test suites.

- [x] Update README with the removed management surface and deferred backend integration.
- [x] Run targeted regressions, typecheck, lint/format, documentation/reference/layer/i18n checks, build and relevant Electron smoke tests.
- [x] Review the final diff, confirm runtime package preservation and record actual results.

## Verification results

- Existing bridge regression failed before implementation with the legacy MCP flag enabled, then passed after removal.
- Targeted protocol/OAuth/credentials/pooling/product-scope/i18n/copy tests: 79 passed. The final product-scope and i18n fixture recheck: 17 passed.
- Electron capabilities: 3 passed; layout: 4 passed; settings: 8 passed on final run. The initial settings run caught a shared screenshot helper removed with the MCP test; the helper was restored unchanged before retesting.
- Typecheck, build, ESLint, formatting, docs facts, references, layers, cycles and i18n checks passed; test isolation reports zero violations.
- Rebuilt output contains none of the removed management modules or test worker. Runtime MCP, catalog pooling and CLI sources have no diff.
- Restricted execution initially prevented temporary-file publication and loopback connections; local regressions passed outside those restrictions.
- Independent review identified the shared screenshot helper issue; it was corrected and verified. No other actionable findings.
- Full repository test suite was not run; validation focused on the affected surfaces. No commit was created.
