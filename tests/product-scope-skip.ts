import { PRODUCT_SCOPE } from '../packages/protocol/product-scope.ts';

const PRODUCT_SCOPE_LABELS: Record<keyof typeof PRODUCT_SCOPE, string> = {
  mcpManagement: 'MCP management',
  backups: 'backup management',
  cli: 'CLI',
  web: 'web',
  acp: 'ACP',
  sdk: 'SDK',
};

export function pausedSkip(surface: keyof typeof PRODUCT_SCOPE): false | string {
  return PRODUCT_SCOPE[surface]
    ? false
    : `${PRODUCT_SCOPE_LABELS[surface]} is outside the current product scope`;
}
