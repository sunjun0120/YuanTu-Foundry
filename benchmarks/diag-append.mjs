// Temporary diagnostic: distribution of the batched/unbatched round ratio and its decomposition.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { SessionStore } from '../packages/storage/sqlite.ts';

let commits = 0;
const origExec = DatabaseSync.prototype.exec;
DatabaseSync.prototype.exec = function (sql) {
  if (/^\s*COMMIT/i.test(sql)) commits++;
  return origExec.call(this, sql);
};
const root = await mkdtemp(path.join(tmpdir(), 'yuantu-diag-'));
const store = new SessionStore(path.join(root, 's.sqlite'));
const text = 'w'.repeat(200);
const rounds = 200;
const pass = (every) => {
  const s = store.create(root);
  const c0 = commits;
  const t = performance.now();
  for (let i = 0; i < rounds; i++) {
    store.append(s.id, { role: 'assistant', content: `round ${i}`, toolCalls: [] });
    store.flush(s.id);
    for (let k = 0; k < 3; k++) {
      store.append(s.id, { role: 'tool', toolCallId: `c${k}`, content: text, isError: false });
      if (every) store.flush(s.id);
    }
    store.flush(s.id);
  }
  return { ms: (performance.now() - t) / rounds, commits: (commits - c0) / rounds };
};
const med = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
pass(true); pass(false);
const U = [], B = [], R = [];
let cu, cb;
for (let i = 0; i < 15; i++) {
  const u = pass(true), b = pass(false);
  U.push(u.ms); B.push(b.ms); R.push(u.ms / b.ms); cu = u.commits; cb = b.commits;
}
// Commit cost alone: one tiny transaction against the same connection's file.
const raw = new DatabaseSync(path.join(root, 'raw.sqlite'));
raw.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; CREATE TABLE t(x)');
const ins = raw.prepare('INSERT INTO t VALUES(?)');
let t = performance.now();
for (let i = 0; i < 2000; i++) { raw.exec('BEGIN IMMEDIATE'); ins.run(i); raw.exec('COMMIT'); }
const commitMs = (performance.now() - t) / 2000;
t = performance.now();
raw.exec('BEGIN IMMEDIATE'); for (let i = 0; i < 2000; i++) ins.run(i); raw.exec('COMMIT');
const rowMs = (performance.now() - t) / 2000;
console.log(JSON.stringify({
  platform: process.platform, node: process.version,
  commitsPerRound: { unbatched: cu, batched: cb },
  unbatchedMs: med(U).toFixed(3), batchedMs: med(B).toFixed(3),
  ratioMedian: med(R).toFixed(2), ratioMin: Math.min(...R).toFixed(2), ratioMax: Math.max(...R).toFixed(2),
  ratioOfMedians: (med(U) / med(B)).toFixed(2),
  impliedCommitPerRowCost: (() => { const r = med(U) / med(B); return ((4 * r - 4) / (4 - 2 * r)).toFixed(2); })(),
  bareCommitMs: commitMs.toFixed(4), bareRowMs: rowMs.toFixed(4),
}));
store.close(); raw.close();
await rm(root, { recursive: true, force: true });
