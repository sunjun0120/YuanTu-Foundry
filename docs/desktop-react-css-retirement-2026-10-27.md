# Desktop CSS retirement

The product links Mantine `renderer.css` followed by application `ui.css`. The six old sheets are no longer loaded or copied by the build. They retain one comment each so historical file references remain understandable.

| Legacy file          | Before lines | After lines | Before important | After important |
| -------------------- | -----------: | ----------: | ---------------: | --------------: |
| styles.css           |         1403 |           1 |               12 |               0 |
| styles-subagents.css |         1005 |           1 |                0 |               0 |
| styles-panels.css    |          452 |           1 |                0 |               0 |
| layout.css           |         1371 |           1 |                0 |               0 |
| layout-surfaces.css  |         1339 |           1 |               14 |               0 |
| layout-workspace.css |          413 |           1 |                3 |               0 |
| Total                |         5983 |           6 |               29 |               0 |

Needed component and DOM-island rules now live in `apps/desktop/ui/styles.css`. Migrated id selectors have become component classes. Markdown, syntax highlighting, tool cards, diff bodies and task-editor content retain their styles; the AppShell owns window layout. Body grid declarations, the obsolete select upgrader styles, 26 superseded declarations and an old conflicting dark palette were removed.

This is an ownership migration, not a 5,977-line reduction in total CSS. The application sheet remains substantial and retains rules needed by existing cards and editors. Its 25 `!important` declarations are below the previous combined total of 33. No new important override was added for the shell.

`tests/desktop-style-budget.test.ts` checks the legacy line budget and absence of migrated id selectors. Real Electron layout/language/session/plan-card tests validate the resulting behavior. Full final acceptance is recorded separately after the remaining migration work.
