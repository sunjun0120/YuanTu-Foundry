/** Shared filename protection for file tools, repository outlines and container preflight.
 * Names are a conservative heuristic: ordinary source files may still contain secrets.
 * Container preflight permits the existing .env.example placeholder exception; file tools
 * retain their stricter rule that excludes every .env name.
 */
export function isCredentialFileName(name: string): boolean {
  return (
    name.toLowerCase() !== '.env.example' &&
    /^(\.env(?:\..*)?|\.npmrc|\.pypirc|\.netrc|credentials(?:\..*)?|id_(rsa|ed25519)|.*\.(pem|p12|pfx|key))$/i.test(
      name,
    )
  );
}
