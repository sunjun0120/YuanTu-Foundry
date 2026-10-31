/**
 * How the deferred tools (`packages/tools/deferred-tools.ts`) are used in real sessions.
 *
 * Opens a session database through `SessionStore` (it only reads) and prints, per deferred tool, how often it was loaded, called, called
 * without a load, and in how many sessions. It is the evidence for moving a tool between the deferred and the
 * always-sent set: a tool most sessions load costs a round each time and should be sent; a deferred tool nobody
 * touches is correctly deferred.
 *
 *   node scripts/deferred-tool-usage.mjs [path/to/sessions.sqlite] [--json]
 *
 * The default database is the current workspace's `.yuantu/sessions.sqlite`. Only tool names and counts are
 * printed — no message content leaves the database.
 */
import path from 'node:path';
import { existsSync } from 'node:fs';
import { SessionStore } from '../packages/storage/sqlite.ts';
import { deferredToolUsage } from '../packages/tools/deferred-tools.ts';

const args = process.argv.slice(2);
const json = args.includes('--json');
const file = path.resolve(
  args.find((arg) => !arg.startsWith('--')) ?? path.join('.yuantu', 'sessions.sqlite'),
);
if (!existsSync(file)) {
  console.error(`No session database at ${file}`);
  process.exit(1);
}
const store = new SessionStore(file);
try {
  const sessions = store.list();
  const report = deferredToolUsage(
    (function* () {
      for (const session of sessions) yield store.messages(session.id);
    })(),
  );
  if (json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(
      `${report.sessions} sessions, ${report.loadCalls} load_tools calls (${report.loadMisses} missed), ${report.unknownCalls} calls to unknown tools`,
    );
    console.log('sessions  loads  calls  direct  tool');
    for (const tool of report.tools)
      console.log(
        `${String(tool.sessions).padStart(8)}  ${String(tool.loads).padStart(5)}  ${String(tool.calls).padStart(5)}  ${String(tool.direct).padStart(6)}  ${tool.name}`,
      );
    if (!report.tools.length) console.log('(no deferred tool was loaded or called)');
  }
} finally {
  store.close();
}
