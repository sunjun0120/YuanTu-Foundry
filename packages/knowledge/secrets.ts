/**
 * What a saved memory must not carry: credentials, recognised by their shape.
 *
 * A memory is announced to every later session and the workspace ones are committed with the repository, so a key
 * that reaches one is copied far beyond the conversation it came from. Telling the model not to save secrets is a
 * request; this is the check behind it.
 *
 * The patterns are the formats that are unambiguous on their own (a provider's key prefix, a PEM header, a URL with
 * a password in it) plus a `name = value` assignment whose value looks generated. They are deliberately narrow: a
 * memory is prose, and a check that refused ordinary sentences about tokens and passwords would be switched off,
 * not obeyed. Values the deployment itself was configured with are matched exactly, whatever their shape.
 */
const patterns: readonly { kind: string; pattern: RegExp }[] = [
  { kind: 'private key', pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { kind: 'Anthropic API key', pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}/ },
  { kind: 'OpenAI API key', pattern: /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{32,}/ },
  {
    kind: 'GitHub token',
    pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{40,})/,
  },
  { kind: 'AWS access key', pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { kind: 'Slack token', pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}/ },
  { kind: 'Google API key', pattern: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  {
    kind: 'JSON web token',
    pattern: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/,
  },
  { kind: 'URL with a password', pattern: /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]+@/i },
  {
    kind: 'credential assignment',
    // A generated-looking value: long, without spaces, and with a digit in it, so `password: see the vault` passes.
    pattern:
      /\b(?:api[_-]?key|secret|token|password|passwd|access[_-]?key)\b["']?\s*[:=]\s*["']?(?=[^\s"']*\d)[A-Za-z0-9_\-+/=.]{16,}/i,
  },
];
/** The environment names whose values are credentials; the same rule diagnostics redaction uses. */
const credentialName = /(?:^|_)(?:API_KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)(?:$|_)/i;

/** The kind of credential `text` appears to contain, or undefined. The value itself is never returned. */
export function credentialIn(
  text: string,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  for (const { kind, pattern } of patterns) if (pattern.test(text)) return kind;
  for (const [name, value] of Object.entries(env))
    if (value && value.length >= 8 && credentialName.test(name) && text.includes(value))
      return `value of ${name}`;
  return undefined;
}
