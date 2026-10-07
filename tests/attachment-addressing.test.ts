/**
 * Attachments by content, not by copy.
 *
 * A picture used to be written once per mention: the message row's body, the `message.*` log entry, and again
 * whenever a compaction or a fork carried it. The same bytes were therefore on disk up to four times, and every
 * one of them was base64 text inside a JSON blob that every reader had to parse. Schema v21 moves the bytes into
 * `attachment_blobs`, keyed by the sha256 of the decoded image, and leaves a `{hash, mimeType}` reference where
 * the bytes used to be.
 *
 * The properties this file pins are the ones that make that trade honest:
 *
 * - the bytes are *stored once* even when the same image is mentioned twice, and what is stored is a reference;
 * - a message read back is the message that was written — byte for byte — through the transcript, through the
 *   log payload, and through the write-through table (invariant I8 compares those three);
 * - rows written before v21 keep working: hydration is idempotent, so an inline image is read as it is;
 * - a reference whose bytes are missing is an *error naming the hash*, never a message with fewer images in it;
 * - a deleted session takes its bytes with it, unless another session still names them.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { SCHEMA_VERSION, SessionStore } from '../packages/storage/sqlite.ts';
import type { ImageAttachment, Message } from '../packages/protocol/index.ts';

/** A real 1×1 PNG, so what is stored is what an endpoint would also accept. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);
const hashOf = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');
const HASH = hashOf(PNG);
const image = (name = 'shot.png'): ImageAttachment => ({
  mimeType: 'image/png',
  data: PNG.toString('base64'),
  name,
});

async function fixture(t: test.TestContext) {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-attachments-'));
  const file = path.join(root, 'sessions.sqlite');
  const store = new SessionStore(file);
  t.after(async () => {
    // A test is allowed to close the store itself (that is how "reopen after a restart" is written), so the
    // hook closes it only if it is still open, and the directory is removed with retries because Windows keeps
    // a file locked until its last connection is gone.
    try {
      store.close();
    } catch {
      /* already closed by the test */
    }
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });
  return { root, file, store, session: store.create(root) };
}
/** Read the file the way a person with sqlite3 would, bypassing every hydration path. */
function raw<T>(file: string, query: string): T[] {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    // node:sqlite hands back null-prototype objects; copying them keeps `deepEqual` honest about content.
    return db
      .prepare(query)
      .all()
      .map((row) => ({ ...row })) as T[];
  } finally {
    db.close();
  }
}

test('the schema names the version and the table this feature needs', async (t) => {
  const { file } = await fixture(t);
  // The exact number is not what this asserts: that the schema a file is written with is the one this build
  // declares, and that it is at least the version this feature needs.
  const version = raw<{ user_version: number }>(file, 'PRAGMA user_version')[0]!.user_version;
  assert.equal(version, SCHEMA_VERSION);
  assert.ok(SCHEMA_VERSION >= 22, 'this feature needs at least the v22 schema');
  const tables = raw<{ name: string }>(
    file,
    "SELECT name FROM sqlite_master WHERE type='table' AND name='attachment_blobs'",
  );
  assert.deepEqual(tables, [{ name: 'attachment_blobs' }]);
});

test('an image mentioned twice is one row of bytes and two references', async (t) => {
  const { store, file, session } = await fixture(t);
  // The size the design measured: a quarter-megabyte picture, where "once or four times" is not a rounding
  // difference. Stored through the same path as any other image.
  const big = Buffer.concat([PNG, Buffer.alloc(256 * 1024)]);
  const bigHash = hashOf(big);
  const shot: ImageAttachment = {
    mimeType: 'image/png',
    data: big.toString('base64'),
    name: 'big.png',
  };
  store.append(session.id, { role: 'user', content: 'Look at this.', images: [shot] });
  store.append(session.id, {
    role: 'tool',
    toolCallId: 'call-1',
    content: 'The same picture again.',
    isError: false,
    images: [shot],
  });
  store.flush(session.id);

  const blobs = raw<{ hash: string; mimeType: string; size: number; bytes: number }>(
    file,
    'SELECT hash,mime_type AS mimeType,size,length(bytes) AS bytes FROM attachment_blobs',
  );
  assert.deepEqual(blobs, [
    { hash: bigHash, mimeType: 'image/png', size: big.length, bytes: big.length },
  ]);

  // Both halves of the write store a reference: the row body and the log payload. Asserted on the raw text so
  // that "the bytes are stored once" is checked against the file rather than against a reader of it.
  const bodies = raw<{ json: string }>(file, 'SELECT body AS json FROM messages ORDER BY seq');
  const events = raw<{ json: string }>(
    file,
    "SELECT data AS json FROM session_events WHERE type LIKE 'message.%' ORDER BY seq",
  );
  assert.equal(bodies.length, 2);
  assert.equal(events.length, 2);
  for (const row of [...bodies, ...events]) {
    assert.doesNotMatch(row.json, /iVBORw0KGgo/, 'base64 must not be written into a row');
    const stored = JSON.parse(row.json) as { message?: { images?: unknown }; images?: unknown };
    const storedImages = (stored.message?.images ?? stored.images) as Record<string, unknown>[];
    assert.equal(storedImages.length, 1);
    assert.deepEqual(Object.keys(storedImages[0]!).sort(), ['hash', 'mimeType', 'name']);
    assert.equal(storedImages[0]!.hash, bigHash);
  }
  // The point of the reference, in the design's own unit: four mentions of one picture cost one copy of it.
  const base64 = shot.data.length;
  const storedText = [...bodies, ...events].reduce((total, row) => total + row.json.length, 0);
  assert.ok(
    storedText * 100 < base64,
    `four mentions stored ${storedText} chars; one base64 copy is ${base64} and the naive shape would be ${base64 * 4}`,
  );
});

test('a message read back is the message that was written, through all three readers', async (t) => {
  const { store, file, session } = await fixture(t);
  const written: Message = {
    role: 'user',
    content: 'What is in this picture?',
    images: [image()],
  };
  store.append(session.id, written);
  const fromLog = (await import('../packages/storage/events.ts')).foldMessages(
    store.events(session.id),
  );
  assert.deepEqual(store.messages(session.id), [written]);
  assert.deepEqual(fromLog, [written]);
  assert.deepEqual(store.messagesFromTable(session.id), [written]);
  const payload = store.events(session.id)[0]!.data.message as Message;
  assert.deepEqual(payload, written);

  // And a second connection — the reopen a desktop does after a restart — reads the same bytes.
  store.close();
  const reopened = new SessionStore(file);
  assert.deepEqual(reopened.messages(session.id), [written]);
  assert.deepEqual(reopened.messagesFromTable(session.id), [written]);
  reopened.close();
});

test('an image written before v21 is read as it is, with no blob row involved', async (t) => {
  const { store, file, session } = await fixture(t);
  // The row a v20 store would have written: the bytes inline, no reference, no blob.
  const inline: Message = { role: 'user', content: 'Legacy.', images: [image('legacy.png')] };
  const db = new DatabaseSync(file);
  db.prepare('INSERT INTO messages(session_id,body,search_text) VALUES(?,?,?)').run(
    session.id,
    JSON.stringify(inline),
    '',
  );
  db.prepare('INSERT INTO session_events(session_id,type,data,at) VALUES(?,?,?,?)').run(
    session.id,
    'message.user',
    JSON.stringify({ message: inline }),
    new Date().toISOString(),
  );
  db.close();

  assert.deepEqual(store.messages(session.id), [inline]);
  assert.deepEqual(store.messagesFromTable(session.id), [inline]);
  assert.deepEqual(raw(file, 'SELECT hash FROM attachment_blobs'), []);
});

test('a reference whose bytes are missing fails loudly instead of dropping the image', async (t) => {
  const { store, file, session } = await fixture(t);
  store.append(session.id, { role: 'user', content: 'Gone soon.', images: [image()] });
  store.flush(session.id);
  const db = new DatabaseSync(file);
  db.prepare('DELETE FROM attachment_blobs WHERE hash=?').run(HASH);
  db.close();

  // A fresh connection, because the store that wrote it still holds the folded transcript.
  const reopened = new SessionStore(file);
  assert.throws(
    () => reopened.messages(session.id),
    new RegExp(HASH),
    'the error must name the address, not return a message with fewer images',
  );
  assert.throws(() => reopened.events(session.id), new RegExp(HASH));
  reopened.close();
});

test('deleting a session takes the bytes only it named', async (t) => {
  const { root, store, file, session } = await fixture(t);
  const shared = image('shared.png');
  const own = image('own.png');
  const second = store.create(root);
  store.append(session.id, { role: 'user', content: 'First.', images: [shared, own] });
  store.append(second.id, { role: 'user', content: 'Second.', images: [shared] });
  store.flush();

  store.delete(session.id);
  const afterFirst = raw<{ hash: string }>(file, 'SELECT hash FROM attachment_blobs ORDER BY hash');
  assert.deepEqual(
    afterFirst.map((row) => row.hash),
    [hashOf(Buffer.from(shared.data, 'base64'))],
    'a blob another session still names must survive',
  );

  store.delete(second.id);
  assert.deepEqual(raw(file, 'SELECT hash FROM attachment_blobs'), []);
});
