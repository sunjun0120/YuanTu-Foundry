/** Temporarily paused product surfaces. Keep their implementation for later restoration. */
export const PRODUCT_SCOPE = {
  mcpManagement: false,
  backups: false,
  cli: false,
  web: false,
  acp: false,
  sdk: false,
} as const;

export function requireProductEntry(entry: 'cli' | 'web' | 'acp'): void {
  if (!PRODUCT_SCOPE[entry])
    throw new Error(`${entry} is temporarily disabled in the desktop-only product`);
}
