import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createMcpSecretCipher, type SecretVaultFactory } from '../packages/mcp/secret-cipher.ts';

function fixture(t: test.TestContext) {
  const directory = mkdtempSync(path.join(tmpdir(), 'yuantu-mcp-cipher-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const passwords = new Map<string, string>();
  let onSet: (() => void) | undefined;
  const vaultFactory: SecretVaultFactory = (service, username) => {
    const id = `${service}/${username}`;
    return {
      getPassword: () => passwords.get(id) ?? null,
      setPassword: (password) => {
        passwords.set(id, password);
        const hook = onSet;
        onSet = undefined;
        hook?.();
      },
      deletePassword: () => passwords.delete(id),
    };
  };
  return {
    directory,
    manifest: path.join(directory, '.secret-key-id'),
    passwords,
    cipher: () => createMcpSecretCipher(directory, { vaultFactory }),
    beforePublish: (hook: () => void) => {
      onSet = hook;
    },
  };
}

test('MCP secret cipher lazily roundtrips with only a public key id on disk', (t) => {
  const f = fixture(t);
  const cipher = f.cipher();
  assert.equal(f.passwords.size, 0);
  assert.deepEqual(readdirSync(f.directory), []);
  const text = 'fixture access token 中文';
  const first = cipher.encrypt(text);
  const second = cipher.encrypt(text);
  assert.equal(cipher.decrypt(first), text);
  assert.equal(cipher.decrypt(cipher.encrypt('')), '');
  assert.notDeepEqual(first, second, 'each encryption needs a fresh nonce');
  assert.equal(first.includes(Buffer.from(text)), false);
  assert.equal(f.passwords.size, 1);
  const metadata = readFileSync(f.manifest, 'utf8');
  assert.match(metadata, /^[a-f0-9-]{36}\n$/);
  assert.deepEqual(readdirSync(f.directory), ['.secret-key-id']);
  assert.equal(metadata.includes([...f.passwords.values()][0]!), false);
});

test('a second MCP cipher instance reads the same system-vault key', (t) => {
  const f = fixture(t);
  const bytes = f.cipher().encrypt('fixture persisted token');
  assert.equal(f.cipher().decrypt(bytes), 'fixture persisted token');
  assert.equal(f.passwords.size, 1);
});

test('MCP ciphertext authenticates its version, nonce, tag, and contents', (t) => {
  const f = fixture(t);
  const cipher = f.cipher();
  const bytes = cipher.encrypt('fixture token');
  for (const offset of [0, 1, 13, bytes.length - 1]) {
    const corrupted = Buffer.from(bytes);
    corrupted[offset] = corrupted[offset]! ^ 1;
    assert.throws(() => cipher.decrypt(corrupted), /MCP credential.*(invalid|decrypt)/i);
  }
  assert.throws(() => cipher.decrypt(Buffer.alloc(0)), /MCP credential.*invalid/i);
});

test('missing existing vault keys refuse encryption and decryption without replacement', (t) => {
  const f = fixture(t);
  const bytes = f.cipher().encrypt('fixture token');
  const metadata = readFileSync(f.manifest, 'utf8');
  f.passwords.clear();
  assert.throws(() => f.cipher().decrypt(bytes), /MCP credential.*key.*missing/i);
  assert.throws(() => f.cipher().encrypt('new fixture token'), /MCP credential.*key.*missing/i);
  assert.equal(f.passwords.size, 0);
  assert.equal(readFileSync(f.manifest, 'utf8'), metadata);
});

test('decrypting with missing key metadata never generates a new vault key', (t) => {
  const f = fixture(t);
  const bytes = f.cipher().encrypt('fixture token');
  rmSync(f.manifest);
  f.passwords.clear();
  assert.throws(() => f.cipher().decrypt(bytes), /MCP credential.*key.*missing/i);
  assert.equal(f.passwords.size, 0);
  assert.deepEqual(readdirSync(f.directory), []);
});

test('MCP key metadata refuses symbolic links before accessing the vault', (t) => {
  const f = fixture(t);
  const target = path.join(f.directory, 'target');
  writeFileSync(target, '00000000-0000-4000-8000-000000000000\n');
  try {
    symlinkSync(target, f.manifest, 'file');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EPERM') {
      t.skip('Windows file symbolic links require local privileges');
      return;
    }
    throw error;
  }
  assert.throws(() => f.cipher().encrypt('fixture token'), /MCP credential.*regular file/i);
  assert.equal(f.passwords.size, 0);
});

test('MCP key metadata refuses malformed ids and oversized files', (t) => {
  const f = fixture(t);
  for (const metadata of ['not-a-uuid', 'x'.repeat(1024)]) {
    writeFileSync(f.manifest, metadata);
    assert.throws(() => f.cipher().encrypt('fixture token'), /MCP credential.*key.*invalid/i);
    assert.equal(f.passwords.size, 0);
  }
});

test('unavailable system vaults fail closed with sanitized errors and no plaintext fallback', (t) => {
  const f = fixture(t);
  const cipher = createMcpSecretCipher(f.directory, {
    vaultFactory: () => {
      throw new Error('fixture secret credential from native backend');
    },
  });
  assert.throws(
    () => cipher.encrypt('fixture token'),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /MCP credential.*system vault.*unavailable/i);
      assert.doesNotMatch(error.message, /fixture secret/);
      return true;
    },
  );
  assert.deepEqual(readdirSync(f.directory), []);
});

test('competing first MCP writers adopt the winner and remove only their own losing key', (t) => {
  const f = fixture(t);
  const first = f.cipher();
  const second = f.cipher();
  let competingBytes: Buffer | undefined;
  f.beforePublish(() => {
    competingBytes = second.encrypt('second fixture');
  });
  const firstBytes = first.encrypt('first fixture');
  assert.equal(first.decrypt(competingBytes!), 'second fixture');
  assert.equal(second.decrypt(firstBytes), 'first fixture');
  assert.equal(f.cipher().decrypt(firstBytes), 'first fixture');
  assert.equal(f.passwords.size, 1, 'the losing unpublished key must be deleted');
  assert.deepEqual(readdirSync(f.directory), ['.secret-key-id']);
});

test('copied key ids cannot resolve another directory system-vault key', (t) => {
  const first = fixture(t);
  const second = fixture(t);
  const encrypted = first.cipher().encrypt('fixture token');
  writeFileSync(second.manifest, readFileSync(first.manifest));
  const passwords = first.passwords;
  const cipher = createMcpSecretCipher(second.directory, {
    vaultFactory: (service, username) => ({
      getPassword: () => passwords.get(`${service}/${username}`) ?? null,
      setPassword: () => assert.fail('copied metadata must not create a key'),
      deletePassword: () => assert.fail('copied metadata must not delete a key'),
    }),
  });
  assert.throws(() => cipher.decrypt(encrypted), /MCP credential.*key.*missing/i);
});

test('MCP ciphertext authenticates its directory even if the same vault key is supplied', (t) => {
  const first = fixture(t);
  const second = fixture(t);
  const encrypted = first.cipher().encrypt('fixture token');
  writeFileSync(second.manifest, readFileSync(first.manifest));
  const password = [...first.passwords.values()][0]!;
  const cipher = createMcpSecretCipher(second.directory, {
    vaultFactory: () => ({
      getPassword: () => password,
      setPassword: () => assert.fail('existing metadata must not create a key'),
      deletePassword: () => assert.fail('existing metadata must not delete a key'),
    }),
  });
  assert.throws(() => cipher.decrypt(encrypted), /MCP credential decryption failed/i);
});

test('malformed system-vault keys cannot silently replace an existing key', (t) => {
  const f = fixture(t);
  const bytes = f.cipher().encrypt('fixture token');
  const entry = [...f.passwords.keys()][0]!;
  for (const value of ['invalid-base64', Buffer.alloc(31).toString('base64')]) {
    f.passwords.set(entry, value);
    assert.throws(() => f.cipher().decrypt(bytes), /MCP credential.*key.*invalid/i);
    assert.throws(() => f.cipher().encrypt('fixture token'), /MCP credential.*key.*invalid/i);
    assert.equal(f.passwords.get(entry), value);
  }
});

test('a first-writer temporary-file collision preserves that file and removes the unpublished vault key', (t) => {
  const f = fixture(t);
  let collision = '';
  f.beforePublish(() => {
    const id = [...f.passwords.keys()][0]!.split('/').at(-1)!;
    collision = path.join(f.directory, `.secret-key-id.${id}.tmp`);
    writeFileSync(collision, 'unrelated fixture');
  });
  assert.throws(() => f.cipher().encrypt('fixture token'), /MCP credential.*publication failed/i);
  assert.equal(readFileSync(collision, 'utf8'), 'unrelated fixture');
  assert.equal(f.passwords.size, 0);
  assert.equal(readdirSync(f.directory).includes('.secret-key-id'), false);
});
