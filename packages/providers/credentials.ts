import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { RunFailure } from '../protocol/failure.ts';
/**
 * Characters an HTTP header value cannot carry, whatever the endpoint would make of them.
 *
 * The list is the control range rather than "whitespace" on purpose. A *line break* is the case that matters: a
 * key pasted from somewhere that wrapped it, or read from a file whose newline survived, makes `fetch` throw
 * `TypeError: ... is an invalid header value` before any request leaves the process — and the adapters wrap that
 * in "Model request failed; check endpoint and network configuration", which sends an operator to the network for
 * a defect in their credential. A *space* inside a key is deliberately allowed: it travels in the header
 * perfectly well, the endpoint answers 401, and "check credentials, model access and endpoint configuration" is
 * then the right thing to say.
 */
const UNUSABLE_CREDENTIAL = /[\u0000-\u001f\u007f]/;
/**
 * Refuse a credential that cannot be sent, where the connection is built rather than where it is used.
 *
 * Every adapter calls this beside its own base-URL check, for the same reason: a config that cannot work should
 * be refused by the thing that would have to work with it, whether it came from the environment, from the
 * desktop's settings or from an embedding host that built one by hand. `saveCredential` calls it too, so a key
 * that cannot travel in a header is refused at the moment somebody is typing it.
 *
 * `auth` is the honest code: the credential is the problem and every retry gets the same answer, which is exactly
 * what that code means everywhere else it is used.
 */
export function assertUsableCredential(apiKey: string): void {
  if (!UNUSABLE_CREDENTIAL.test(apiKey)) return;
  throw new RunFailure(
    'auth',
    'The API key contains a control character, such as a line break or a tab. It cannot travel in an HTTP header, so no request was sent; enter the key without it.',
  );
}

/**
 * A second place a credential may live, for the callers that have no keychain.
 *
 * The runtime read its credential from the environment and nowhere else, which is the right *first* source and a
 * poor only one: a shell profile, a service unit or a desktop launcher each have to carry a secret, and on a
 * machine where the desktop stores one through the OS keychain there is still no way to give the CLI or the Host
 * a key without exporting it. So the environment stays first and this file answers second.
 *
 * It is a *fallback*, never an override: a key in the environment wins, which is what keeps a per-invocation
 * `YUANTU_API_KEY` meaningful and keeps this file from silently shadowing it.
 *
 * The shape is one key per protocol, because that is what `readConfig` resolves:
 *
 * ```json
 * { "anthropic": "sk-ant-...", "openai": "sk-..." }
 * ```
 *
 * Nothing here is encrypted, and that is stated rather than implied: this is a plaintext file whose protection is
 * its permissions (`0600`, in a `0700` directory) and the user account it belongs to. The desktop's model settings
 * remain the place for a key protected by the OS keychain; this is for the callers that have none. The environment
 * variable `YUANTU_CREDENTIALS_FILE` names a different file, which is what tests and multi-profile setups use.
 */
export function credentialsPath(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.YUANTU_CREDENTIALS_FILE?.trim();
  if (configured) {
    if (!path.isAbsolute(configured))
      throw new Error('YUANTU_CREDENTIALS_FILE must be an absolute path');
    return configured;
  }
  return path.join(homedir(), '.yuantu', 'credentials.json');
}
/**
 * The credentials in the file, or none when there is no file.
 *
 * A missing file is the ordinary case rather than an error: most setups use the environment. A file that exists
 * and cannot be understood *is* an error, and it says which file without echoing it — a parse failure must not
 * put a secret into a message that goes to a terminal, a log or a model.
 */
export function readCredentials(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const file = credentialsPath(env);
  if (!existsSync(file)) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    throw new Error(
      `${file} is not valid JSON; fix it or remove it to fall back to the environment`,
    );
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    throw new Error(`${file} must contain an object mapping protocol names to API keys`);
  const credentials: Record<string, string> = {};
  for (const [protocol, value] of Object.entries(parsed as Record<string, unknown>)) {
    // An entry that is not a string is skipped rather than fatal: the file is hand-editable, and refusing every
    // key because one line is malformed would turn a typo in an unused protocol into "no credential at all".
    if (typeof value === 'string' && value.trim()) credentials[protocol] = value.trim();
  }
  return credentials;
}
/**
 * Write one protocol's key, keeping every other entry.
 *
 * The write is a temporary file renamed over the target, so a reader never sees a half-written document, and the
 * temporary is created with `0600` *at creation* rather than chmod-ed afterwards — the window between the two
 * would be exactly when the secret is unprotected. The directory is created `0700` for the same reason.
 *
 * Windows honours the mode only for the read-only bit, so on Windows the protection is the user profile's access
 * control rather than this number. That is a property of the platform, and it is written down here so nobody
 * reads the `0600` as a promise it cannot keep there.
 */
export function saveCredential(
  protocol: string,
  apiKey: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const trimmed = protocol.trim();
  if (!trimmed) throw new Error('A credential needs the protocol it belongs to');
  const key = apiKey.trim();
  if (!key) throw new Error('A credential needs a key');
  // The same rule the adapters apply: a key that cannot travel in a header is refused when it is written rather
  // than when it is used, which is the moment the person can still fix it.
  assertUsableCredential(key);
  const file = credentialsPath(env);
  const directory = path.dirname(file);
  const credentials = { ...readCredentials(env), [trimmed]: key };
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    // `chmodSync` on the directory as well, because `mkdirSync`'s mode is ignored for a directory that already
    // existed — the common case, and the one where a wider mode would otherwise survive every later write.
    if (process.platform !== 'win32') chmodSync(directory, 0o700);
    writeFileSync(temporary, `${JSON.stringify(credentials, null, 2)}\n`, {
      mode: 0o600,
      flag: 'wx',
    });
    renameSync(temporary, file);
    return file;
  } finally {
    // The temporary is gone either way: a failed write must not leave a second copy of a secret behind.
    rmSync(temporary, { force: true });
  }
}
