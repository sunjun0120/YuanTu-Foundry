import { writeFileSync } from 'node:fs';
import { SessionStore } from '../packages/storage/sqlite.ts';
const [db, root, marker] = process.argv.slice(2);
if (!db || !root || !marker) throw new Error('Expected db, root and marker');
const store = new SessionStore(db);
const session = store.create(root);
store.beginRun(session.id);
store.append(session.id, { role: 'user', content: 'create marker' });
store.append(session.id, {
  role: 'assistant',
  content: '',
  toolCalls: [
    { id: 'uncertain', name: 'write_file', arguments: { path: 'marker.txt', content: 'twice' } },
  ],
});
writeFileSync(marker, 'once');
// The run loop flushes the message that names a tool call before the tool runs, so this crash — after the
// effect, before its result — leaves exactly the record recovery is built from.
store.flush(session.id);
process.stdout.write(session.id + '\n');
// Simulates a process crash after the effect but before recording its result.
process.exit(73);
