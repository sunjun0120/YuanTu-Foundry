import type { ReactNode } from 'react';
import { useReadable } from './context.tsx';
import { createViewRegistry } from './view-registry.ts';

export const desktopViews = createViewRegistry<ReactNode>();
export const registerView = desktopViews.register;

/** No portal or additional root: the component occupies its declared place in AppShell. */
export function ViewSlot({ name }: { name: string }): ReactNode {
  return useReadable(desktopViews.view(name));
}
