/**
 * How often tool calls went wrong in avoidable ways in real sessions (`packages/core/tool-misuse.ts`).
 *
 * Opens a session database through `SessionStore` (it only reads) and prints the rates of unknown tool names,
 * schema failures, refusals, a failed call repeated unchanged, and `run_command` used to read files — overall and
 * per tool. Run it before and after changing a tool description, the prompt's tool rules or a refusal message.
 *
 *   node scripts/tool-misuse.mjs [path/to/sessions.sqlite] [--json]
 *
 * The default database is the current workspace's `.yuantu/sessions.sqlite`. Only tool names and counts are
 * printed — no message content leaves the database.
 */
import path from 'node:path';
import { existsSync } from 'node:fs';
import { SessionStore } from '../packages/storage/sqlite.ts';
import { toolMisuse } from '../packages/core/tool-misuse.ts';

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
  const report = toolMisuse(
    (function* () {
      for (const session of sessions) yield store.messages(session.id);
    })(),
  );
  if (json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    const rate = (count) =>
      report.calls ? `${count} (${((count / report.calls) * 100).toFixed(1)}%)` : String(count);
    console.log(`${report.sessions} sessions, ${report.calls} tool calls`);
    console.log(`unknown tool          ${rate(report.unknownTool)}`);
    console.log(`invalid arguments     ${rate(report.invalidArguments)}`);
    console.log(`denied                ${rate(report.denied)}`);
    console.log(`repeated after error  ${rate(report.repeatedAfterError)}`);
    console.log(`run_command reads     ${rate(report.shellReads)}`);
    console.log('\n   calls  avoidable  category');
    for (const category of report.categories)
      console.log(
        `${String(category.calls).padStart(8)}  ${String(category.failures).padStart(9)}  ${category.category}`,
      );
    console.log('\n   calls  avoidable  tool');
    for (const tool of report.tools.filter((tool) => tool.failures).slice(0, 20))
      console.log(
        `${String(tool.calls).padStart(8)}  ${String(tool.failures).padStart(9)}  ${tool.name}`,
      );
    if (!report.tools.some((tool) => tool.failures)) console.log('(no avoidable failure recorded)');
  }
} finally {
  store.close();
}
