/** Product surfaces that are temporarily paused. Their implementation is kept for later restoration. */
export const PRODUCT_SCOPE = {
  mcpManagement: false,
  backups: false,
  cli: true,
} as const;

export function requireProductEntry(entry: 'cli'): void {
  if (!PRODUCT_SCOPE[entry])
    throw new Error(`${entry} is temporarily disabled in the desktop-only product`);
}
