import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  linkSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

export interface SecretVaultEntry {
  getPassword(): string | null;
  setPassword(value: string): void;
  deletePassword(): boolean;
}
export type SecretVaultFactory = (service: string, username: string) => SecretVaultEntry;

const KEY_ID_FILE = '.secret-key-id';
const KEY_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const VERSION = 1;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const HEADER_BYTES = 1 + NONCE_BYTES + TAG_BYTES;

const systemVault: SecretVaultFactory = (service, username) => {
  // Loading the native platform binding is deferred until a credential actually needs protection.
  const { Entry } = createRequire(import.meta.url)('@napi-rs/keyring') as {
    Entry: new (
      service: string,
      username: string,
      options?: { linux: { store: 'secret-service' } },
    ) => SecretVaultEntry;
  };
  return new Entry(
    service,
    username,
    process.platform === 'linux' ? { linux: { store: 'secret-service' } } : undefined,
  );
};

function keyId(file: string): string | undefined {
  let stat;
  try {
    stat = lstatSync(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new Error('MCP credential key metadata unavailable');
  }
  if (stat.isSymbolicLink() || !stat.isFile())
    throw new Error('MCP credential key metadata must be a regular file');
  if (stat.size >= 1024) throw new Error('MCP credential key metadata invalid');
  let descriptor: number | undefined;
  try {
    descriptor = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const opened = fstatSync(descriptor);
    if (!opened.isFile() || opened.ino !== stat.ino || opened.dev !== stat.dev)
      throw new Error('Invalid metadata');
    const bytes = Buffer.alloc(1024);
    const count = readSync(descriptor, bytes, 0, bytes.length, 0);
    if (count >= 1024) throw new Error('Invalid metadata');
    const id = bytes.subarray(0, count).toString('utf8').trim();
    if (!KEY_ID.test(id)) throw new Error('Invalid metadata');
    return id;
  } catch {
    throw new Error('MCP credential key metadata invalid');
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

/** The only on-disk key material is a public identifier; the AES key belongs to the system vault. */
export function createMcpSecretCipher(
  directory: string,
  options: { vaultFactory?: SecretVaultFactory } = {},
): { encrypt(text: string): Buffer; decrypt(bytes: Buffer): string } {
  const vaultFactory = options.vaultFactory ?? systemVault;
  let cached: { key: Buffer; aad: Buffer } | undefined;
  const vault = (service: string, id: string) => {
    try {
      return vaultFactory(service, id);
    } catch {
      throw new Error('MCP credential system vault unavailable');
    }
  };
  const readKey = (service: string, id: string): Buffer => {
    let password: string | null;
    try {
      password = vault(service, id).getPassword();
    } catch {
      throw new Error('MCP credential system vault unavailable');
    }
    if (password === null) throw new Error('MCP credential system-vault key missing');
    if (password.length !== 44) throw new Error('MCP credential system-vault key invalid');
    const key = Buffer.from(password, 'base64');
    if (key.length !== 32 || key.toString('base64') !== password)
      throw new Error('MCP credential system-vault key invalid');
    return key;
  };
  const load = (create: boolean): { key: Buffer; aad: Buffer } => {
    if (cached) return cached;
    let canonical: string;
    try {
      canonical = realpathSync(path.resolve(directory));
    } catch {
      throw new Error('MCP credential key metadata missing or unavailable');
    }
    const scope = createHash('sha256')
      .update(process.platform === 'win32' ? canonical.toLowerCase() : canonical)
      .digest('hex');
    const service = `YuanTu MCP OAuth:${scope}`;
    const aad = Buffer.from(`YuanTu MCP OAuth secret v1:${scope}`, 'utf8');
    const file = path.join(canonical, KEY_ID_FILE);
    const existing = keyId(file);
    if (existing) {
      cached = { key: readKey(service, existing), aad };
      return cached;
    }
    if (!create) throw new Error('MCP credential key metadata missing');
    const id = randomUUID();
    const key = randomBytes(32);
    const entry = vault(service, id);
    const temporary = path.join(canonical, `${KEY_ID_FILE}.${id}.tmp`);
    let published = false;
    let temporaryOwned = false;
    try {
      try {
        entry.setPassword(key.toString('base64'));
      } catch {
        throw new Error('MCP credential system vault unavailable');
      }
      try {
        writeFileSync(temporary, `${id}\n`, { flag: 'wx', mode: 0o600 });
        temporaryOwned = true;
      } catch {
        throw new Error('MCP credential key metadata publication failed');
      }
      try {
        linkSync(temporary, file);
        published = true;
        cached = { key, aad };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST')
          throw new Error('MCP credential key metadata publication failed');
        const winner = keyId(file);
        if (!winner) throw new Error('MCP credential key metadata missing');
        cached = { key: readKey(service, winner), aad };
      }
      return cached;
    } finally {
      try {
        if (!published) entry.deletePassword();
      } catch {
        cached = undefined;
        throw new Error('MCP credential system vault cleanup unavailable');
      } finally {
        try {
          if (temporaryOwned) unlinkSync(temporary);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
            throw new Error('MCP credential key metadata cleanup failed');
        }
      }
    }
  };
  return {
    encrypt: (text) => {
      const { key, aad } = load(true);
      const nonce = randomBytes(NONCE_BYTES);
      const cipher = createCipheriv('aes-256-gcm', key, nonce);
      cipher.setAAD(aad);
      const encrypted = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
      return Buffer.concat([Buffer.from([VERSION]), nonce, cipher.getAuthTag(), encrypted]);
    },
    decrypt: (bytes) => {
      if (bytes.length < HEADER_BYTES || bytes[0] !== VERSION)
        throw new Error('MCP credential ciphertext invalid');
      const { key, aad } = load(false);
      try {
        const decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(1, 1 + NONCE_BYTES));
        decipher.setAAD(aad);
        decipher.setAuthTag(bytes.subarray(1 + NONCE_BYTES, HEADER_BYTES));
        return Buffer.concat([
          decipher.update(bytes.subarray(HEADER_BYTES)),
          decipher.final(),
        ]).toString('utf8');
      } catch {
        throw new Error('MCP credential decryption failed');
      }
    },
  };
}
