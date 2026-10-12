import { existsSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { SessionStore } from '../packages/storage/sqlite.ts';
import { KnowledgeStore } from '../packages/knowledge/store.ts';

const [kind, file, root, document, barrier] = process.argv.slice(2);
if (!kind || !file || !root || document === undefined || !barrier)
  throw new Error('Missing concurrency worker arguments');
const exec = DatabaseSync.prototype.exec;
let paused = false;
function pause(ready: string, release: string): void {
  writeFileSync(barrier + ready, 'ready');
  const deadline = Date.now() + 15_000;
  const wait = new Int32Array(new SharedArrayBuffer(4));
  while (!existsSync(barrier + release)) {
    if (Date.now() > deadline) throw new Error('Concurrency barrier timed out');
    Atomics.wait(wait, 0, 0, 10);
  }
}
DatabaseSync.prototype.exec = function (sql: string) {
  if (!paused && sql === 'BEGIN IMMEDIATE') {
    paused = true;
    pause(
      kind === 'migration' ? '.migrating' : '.ready',
      kind === 'migration' ? '.commit' : '.release',
    );
  }
  return exec.call(this, sql);
};
let store: SessionStore | KnowledgeStore | undefined;
try {
  if (kind === 'migration') {
    pause('.ready', '.release');
    store = new SessionStore(file);
  } else {
    store = new KnowledgeStore(file);
    store.pinDocument(root, document);
  }
  process.stdout.write(JSON.stringify({ ok: true }) + '\n');
} catch (error) {
  process.stdout.write(JSON.stringify({ ok: false, error: String(error) }) + '\n');
  process.exitCode = 1;
} finally {
  store?.close();
}
