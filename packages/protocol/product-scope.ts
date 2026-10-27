/** Product entry availability. */
export const PRODUCT_SCOPE = {
  cli: true,
} as const;

export function requireProductEntry(entry: 'cli'): void {
  if (!PRODUCT_SCOPE[entry])
    throw new Error(`${entry} is temporarily disabled in the desktop-only product`);
}
