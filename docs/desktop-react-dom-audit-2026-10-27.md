# Desktop DOM audit after the React migration

Scope: T25b. Every remaining DOM API call under `apps/desktop` is listed here with its owner, so the next change does
not have to rediscover whether a `getElementById` belongs to the shell, a retained content island, or a legacy page
that should have been deleted.

Reproduce the inventory with:

```powershell
rg -c "document\.getElementById|document\.createElement|replaceChildren|new MutationObserver|document\.querySelector|addEventListener" apps/desktop
```

At the final checkpoint the renderer holds 56 `document.getElementById`, 22 `document.createElement`, 27
`replaceChildren`, 4 `document.querySelector`, 78 `addEventListener` and 1 `new MutationObserver` (58 of the listeners
live under `apps/desktop/ui`).

## 1. The one React root and the product skeleton

| Check                                                                  | Result                                                                             |
| ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `createRoot` calls in `apps/`                                          | 1 (`ui/App.tsx`, mounted into `#desktop-root`)                                     |
| `index.html` static product structure                                  | none; 21 lines, body holds only `<div id="desktop-root">` and the renderer script  |
| `renderer.ts`                                                          | 36-line runtime bootstrap: runtime, actions, one mount, one `pagehide` disposer    |
| Region adapters (`mountRegion`, `RegionHost`, portals to page regions) | gone; `ui/views.tsx` renders each `ViewSlot` as an ordinary child                  |
| Transitional id table                                                  | empty, `MIGRATION_COMPLETE = true` (`ui/legacy/compat-ids.ts`)                     |
| Global select upgrader / translation walker                            | removed (`2f5ef5d`); `i18n.ts` only owns the dictionary and `documentElement.lang` |

## 2. Host seats: `document.getElementById` inside the single tree

The shell (`ui/layout/ProductShell.tsx`) renders every product host id; a controller mount resolves its seat once and
registers a view there, and `null` means the shell did not render that seat (feature-gated or page not built yet). No
module writes the page structure itself.

| Owner                 | Seats                                                                                                                                                              |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| App bootstrap         | `#desktop-root` (`ui/App.tsx`)                                                                                                                                     |
| Conversation          | `#live`, `#live-reasoning` (`live-message-mount`, `transcript-mount`), `#messages`, `#conversation`                                                                |
| Panels                | `#tasks-panel`, `#task-list`, `#plan-root`, `#background-root`, `#composer-statistics`, `#todos-root`, `#goal-root`, `#deliverables-root` (`session-panels-mount`) |
| Composer              | `#composer`, `#prompt`, `#attachments-root`, `#image-input`, `#attach-image`, `#command-menu-root`                                                                 |
| Approvals / questions | `#approvals`, `#questions`                                                                                                                                         |
| Permissions / sandbox | `#permission-root`, `#full-access-root`, `#sandbox-prompt-root`                                                                                                    |
| Sessions              | `#session-sidebar-root`, `#session-dialog-root`, `#new-session`, `#choose-workspace`                                                                               |
| Settings              | `#general-settings-content`, `#model-settings-content`, `#workspace-maintenance-content`, `#settings-page`, `#mcp-panel` (dormant), `#mcp-settings`                |
| Workspace             | `#workspace-root`, `#open-workspace`, `#workspace-maintenance-settings`                                                                                            |
| Focus / geometry      | `ui/transitions.tsx` (focus restore), `ui/settings/model-selection.ts` (`#settings-url`), `ui/layout/ProductShell.tsx` (`#conversation` scroll restoration)        |

These are product ids rendered by React, not the transitional compatibility table: the mounts and the smoke suites read
the same ids, and both sides are React-owned.

## 3. Retained content islands

The plan allows security-sensitive content to stay a DOM island as long as React owns its position, key and metadata.
The islands and their hosts:

| Island                               | Builds                                                    | Hosted by                                                                                                   |
| ------------------------------------ | --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `renderer-messages.ts`               | message view, reasoning view, image gallery, process icon | `ui/conversation/BuiltMessage.tsx`, `MessageContributions.tsx` (React row owns key, anchor, collapse state) |
| `markdown.ts`                        | markdown nodes and the copy/selection actions             | same rows; `MarkdownView.tsx` for the live answer                                                           |
| `tool-cards.ts`                      | tool-call cards and their collapsed groups                | `renderer-messages.ts`                                                                                      |
| `diff-view.ts`                       | diff body and change previews                             | `ui/conversation/Approvals.tsx`, `TurnChanges.tsx`, `workspace/FilePreview.tsx`                             |
| `workspace-icons.ts`                 | SVG icon elements for the workspace tree                  | `ui/workspace/workspace-mount.tsx`                                                                          |
| `ui/conversation/completion-view.ts` | the completion-verdict block                              | `transcript-mount.tsx` (row keeps `data-completion-key`, so an expanded evidence fold survives a repaint)   |

`replaceChildren` outside these islands is React code replacing a ref's children with island nodes
(`Approvals.tsx`, `BuiltMessage.tsx`, `Conversation.tsx`, `Questions.tsx`, `Subagents.tsx`, `TurnChanges.tsx`,
`FilePreview.tsx`, `MessageContributions.tsx`, `model-mount.tsx`, `workspace-mount.tsx`).

## 4. Dormant legacy: MCP settings

`renderer-mcp.ts` is a complete old-style panel (1 `getElementById`, 3 `createElement`, 3 `replaceChildren`, 15
`addEventListener`). It is still mounted by `ui/application.tsx`, but only inside `if (PRODUCT_SCOPE.mcpManagement)`,
and the scope constant is `false`: no entry is rendered, `settings.smoke` skips the case, and the panel is not
reachable in the shipped window.

This is the one recorded deviation from "every region is React". It is kept rather than rewritten because the feature
is dormant: rewriting 478 unreachable lines would have no real-page verification. Removal condition: when
`PRODUCT_SCOPE.mcpManagement` becomes `true`, that panel is replaced by `ui/settings/McpSettings.tsx` before the scope
is flipped. Until then it is a dormant implementation, not a second active page.

## 5. Listeners and observers

All 57 `addEventListener` calls under `ui/` are owned by one of:

- a React effect that removes the same listener on cleanup (`application.tsx` window shortcuts, visibility and focus;
  `SessionSidebar.tsx` outside-click; `Statistics.tsx` and `BackgroundPanel.tsx` hover/outside-click; `PermissionChip.tsx`,
  `Subagents.tsx`, `WorkspacePanel.tsx`, `model-selection.ts`, `session-mount.tsx`, `mount.tsx`, `model-mount.tsx`,
  `attachment-mount.tsx`, `command-mount.tsx`, `bindings.ts`);
- a media-query subscription (`reduced-motion.ts`), plus one native `toggle` listener in `ui/conversation/Fold.tsx` that adopts an external `.open` write;
- the bootstrap's `pagehide` disposer (`renderer.ts`).

The single `MutationObserver` is `ui/providers.tsx`: it watches the `data-theme` / `data-font-size` attributes the
settings controller owns and rebuilds the theme from them. It is a read-only projection of an attribute that another
owner writes — not a second renderer.

## 6. What the audit rules out

- No module builds the product page: the page exists only as the React tree under `#desktop-root`.
- No second React root, portal region host, or parallel page renderer remains.
- No transitional id is rendered; no `compatId()` call exists (`tests/compat-ids.test.ts` keeps both).
- No translation walker or select upgrader remains; the only locale mechanism is `t()` during render.
- The remaining direct DOM work is: resolving seats React already rendered, hosting the retained content islands, and
  lifecycle listeners/observers.
