import { PRODUCT_SCOPE } from '../packages/protocol/product-scope.ts';

const PRODUCT_SCOPE_LABELS: Record<keyof typeof PRODUCT_SCOPE, string> = {
  cli: 'CLI',
};

export function pausedSkip(surface: keyof typeof PRODUCT_SCOPE): false | string {
  return PRODUCT_SCOPE[surface]
    ? false
    : `${PRODUCT_SCOPE_LABELS[surface]} is outside the current product scope`;
}
