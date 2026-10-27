import { useCallback, useSyncExternalStore, type ReactNode } from 'react';
import type { CarrierSnapshot } from '../../../packages/carrier/contract.ts';
import type { Message } from '../../../packages/protocol/index.ts';
import { useReadable } from './context.tsx';
import { createStore } from './stores.ts';
import { SlotRegistry, type SlotContexts, type SlotName } from './slot-registry.ts';
export { SlotRegistry } from './slot-registry.ts';
export type { SlotContribution as ReactSlotContribution } from './slot-registry.ts';

export interface PanelSlotContext {
  readonly session: CarrierSnapshot['session'];
  readonly workspace: string;
}
export interface DesktopSlotContexts {
  'composer.above': PanelSlotContext;
  'sidebar.right': PanelSlotContext;
  'message.actions': { readonly message: Message };
  'message.footer': { readonly message: Message };
  'tool.result.extra': { readonly message: Message };
}

/** Keyed ordinary children: adding a contribution never recreates a surviving component. */
export function SlotOutlet<Contexts extends SlotContexts, K extends SlotName>({
  registry,
  name,
  context,
}: {
  registry: SlotRegistry<Contexts, ReactNode>;
  name: K;
  context: Contexts[K];
}): ReactNode {
  useSyncExternalStore(
    useCallback((listener) => registry.subscribe(name, listener), [registry, name]),
    useCallback(() => registry.revision(name), [registry, name]),
  );
  return registry.contributions(name).map((entry) => (
    <div key={entry.id} className={`slot slot-${name.replace(/\./g, '-')}`}>
      {entry.render(context)}
    </div>
  ));
}

export const desktopSlots = createStore<{
  registry: SlotRegistry<DesktopSlotContexts, ReactNode>;
  context: PanelSlotContext | null;
} | null>(null);

const registryStore = {
  subscribe: desktopSlots.subscribe,
  getSnapshot: () => desktopSlots.getSnapshot()?.registry ?? null,
};

export function PanelSlot({ name }: { name: 'composer.above' | 'sidebar.right' }): ReactNode {
  const state = useReadable(desktopSlots);
  return state?.context ? (
    <SlotOutlet registry={state.registry} name={name} context={state.context} />
  ) : null;
}

export function MessageSlot({
  name,
  message,
}: {
  name: 'message.actions' | 'message.footer' | 'tool.result.extra';
  message: Message;
}): ReactNode {
  const state = useReadable(registryStore);
  return state ? <SlotOutlet registry={state} name={name} context={{ message }} /> : null;
}
