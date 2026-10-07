/**
 * The credential seam: the environment first, a user file second.
 *
 * The file is a second place a secret lives at rest, so what is asserted here is mostly about not making that
 * worse: it is only consulted when the environment has nothing, it is written `0600` in a `0700` directory
 * *at creation*, it is replaced by a rename so a reader never sees half a document, and a failure to read it
 * never puts a key into a message. The environment override is what makes all of this testable without touching
 * the real home directory.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import path from 'node:path';
import {
  credentialsPath,
  readCredentials,
  saveCredential,
} from '../packages/providers/credentials.ts';
import { readConfig } from '../packages/providers/config.ts';

async function root(t: test.TestContext): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'yuantu-credentials-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
const at = (dir: string): NodeJS.ProcessEnv => ({
  YUANTU_CREDENTIALS_FILE: path.join(dir, 'keys.json'),
});

test('the credentials file is named by the environment, and a relative name is refused', () => {
  /**
   * The override exists for tests and for multi-profile setups, which is why it is validated rather than trusted:
   * a relative path would resolve against whatever directory the process happens to be in, so two invocations
   * would read two different files and neither would be the one the user meant.
   */
  assert.equal(
    credentialsPath({}),
    path.join(homedir(), '.yuantu', 'credentials.json'),
    'the default is the user-level directory the other user-level state already uses',
  );
  assert.equal(
    credentialsPath({ YUANTU_CREDENTIALS_FILE: path.resolve('keys.json') }),
    path.resolve('keys.json'),
  );
  assert.throws(
    () => credentialsPath({ YUANTU_CREDENTIALS_FILE: 'keys.json' }),
    /must be an absolute path/,
  );
});

test('an absent file is no credentials, and a malformed one is an error that names the file', async (t) => {
  const dir = await root(t);
  const env = at(dir);
  assert.deepEqual(readCredentials(env), {});
  await writeFile(path.join(dir, 'keys.json'), '{ not json');
  assert.throws(
    () => readCredentials(env),
    (error: unknown) =>
      error instanceof Error &&
      error.message.includes('keys.json') &&
      // The message must never quote the file's contents: a parse failure is the one moment the text may be a
      // secret, and this message goes to a terminal, a log and possibly a model.
      !error.message.includes('not json'),
  );
  await writeFile(path.join(dir, 'keys.json'), '["not", "an", "object"]');
  assert.throws(() => readCredentials(env), /mapping protocol names/);
  // An entry that is not a string is skipped rather than fatal: the file is hand-editable, and one typo in an
  // unused protocol must not mean "no credential at all".
  await writeFile(
    path.join(dir, 'keys.json'),
    JSON.stringify({ anthropic: 'sk-a', openai: 42, other: '  ' }),
  );
  assert.deepEqual(readCredentials(env), { anthropic: 'sk-a' });
});

test('a stored key is written 0600 in a 0700 directory and replaces the file atomically', async (t) => {
  const dir = await root(t);
  const env = at(dir);
  const file = saveCredential('anthropic', 'sk-ant-one', env);
  assert.equal(file, credentialsPath(env));
  await saveCredential('openai', 'sk-openai-two', env);
  // Both keys, one file: writing one protocol keeps the other, which is the whole difference between a credential
  // store and a last-write-wins file.
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), {
    anthropic: 'sk-ant-one',
    openai: 'sk-openai-two',
  });
  await saveCredential('anthropic', 'sk-ant-three', env);
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), {
    anthropic: 'sk-ant-three',
    openai: 'sk-openai-two',
  });
  // No temporary files left behind: a failed or finished write must not leave a second copy of a secret.
  const { readdir } = await import('node:fs/promises');
  assert.deepEqual(
    (await readdir(dir)).filter((name) => name.endsWith('.tmp')),
    [],
  );
  if (process.platform !== 'win32') {
    // Windows honours only the read-only bit of a mode, so the assertion is POSIX-only rather than a promise the
    // platform cannot keep. The directory is checked too: `mkdirSync`'s mode is ignored when it already exists,
    // which is the common case and the one where a wider mode would otherwise survive.
    assert.equal((await stat(file)).mode & 0o777, 0o600);
    assert.equal((await stat(dir)).mode & 0o777, 0o700);
  }
});

test('a stored key is refused when it cannot travel in a header', async (t) => {
  // The same rule the adapters apply, at the moment somebody is typing the key rather than at the moment a run
  // fails: a line break is what a wrapped paste or a file's trailing newline produces.
  const dir = await root(t);
  assert.throws(() => saveCredential('anthropic', 'sk-a\nb', at(dir)), /control character/);
  await assert.rejects(readFile(path.join(dir, 'keys.json'), 'utf8'), { code: 'ENOENT' });
});

test('the environment wins, the file answers when it is empty, and neither is read otherwise', async (t) => {
  const dir = await root(t);
  const env = at(dir);
  saveCredential('openai', 'sk-from-file', env);
  const base = { YUANTU_MODEL: 'm', YUANTU_PROTOCOL: 'openai', ...env };
  // The file alone is enough: this is the caller that has no keychain and no exported key.
  assert.equal(readConfig(base).apiKey, 'sk-from-file');
  // The environment wins, because a per-invocation value has to mean something.
  assert.equal(readConfig({ ...base, YUANTU_API_KEY: 'sk-from-env' }).apiKey, 'sk-from-env');
  assert.equal(readConfig({ ...base, OPENAI_API_KEY: 'sk-openai-env' }).apiKey, 'sk-openai-env');
  /**
   * The file is keyed by protocol, and a protocol with no entry is refused by naming both sources rather than
   * reporting an unset variable — which is what sends a user looking in the wrong place.
   */
  assert.throws(
    () => readConfig({ ...base, YUANTU_PROTOCOL: 'openai-responses' }),
    /store a key for "openai-responses"/,
  );
  // A malformed file is not consulted at all when the environment already answered, so exporting a key keeps a
  // broken file from failing every run.
  await writeFile(credentialsPath(env), '{ not json');
  assert.equal(readConfig({ ...base, YUANTU_API_KEY: 'sk-from-env' }).apiKey, 'sk-from-env');
});
