/** Redact configured credentials from diagnostics, not user transcript content. */
export function redactSecrets(message: string, env: NodeJS.ProcessEnv = process.env): string {
  for (const [name, value] of Object.entries(env)) {
    if (value && /(?:^|_)(?:API_KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)(?:$|_)/i.test(name))
      message = message.split(value).join('[redacted]');
  }
  return message;
}
