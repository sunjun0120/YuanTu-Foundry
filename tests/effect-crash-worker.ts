import { SessionStore } from '../packages/storage/sqlite.ts';
import { createTools } from '../packages/tools/index.ts';
const [db, root] = process.argv.slice(2);
if (!db || !root) throw new Error('Expected db and workspace');
const store = new SessionStore(db);
const session = store.create(root);
store.beginRun(session.id);
const call = {
  id: 'effect-before-crash',
  name: 'edit_file',
  arguments: { path: 'theme.txt', old_text: 'red\n', new_text: 'blue\n' },
};
store.append(session.id, { role: 'user', content: 'Change theme to blue' });
store.append(session.id, { role: 'assistant', content: '', toolCalls: [call] });
// The run loop flushes the message naming a tool call before the tool runs (see `Agent`), which is what
// makes the crash below leave a pending call the next run has to report as an unknown outcome.
store.flush(session.id);
process.stdout.write(session.id + '\n');
// One tool set for both calls: the read-before-write gate's record belongs to a run's tools, so reading through a
// different set would not count as having read. This fixture exists to crash *after* a real write has landed.
const tools = createTools(root);
await tools.execute(
  { id: 'read-before-crash', name: 'read_file', arguments: { path: 'theme.txt' } },
  { signal: new AbortController().signal, approve: async () => true },
);
await tools.execute(call, {
  signal: new AbortController().signal,
  approve: async () => true,
  fileJournal: {
    prepare: (change, before, after) => store.prepareFileChange(session.id, change, before, after),
    applied: (id) => {
      store.markFileChange(id, 'applied');
      process.exit(73);
    },
  },
});
throw new Error('Crash boundary was not reached');
