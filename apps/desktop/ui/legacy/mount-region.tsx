/**
 * The migration's mounting seam: a React root that owns a container the legacy UI built, one region at a time.
 *
 * A region is a DOM element the old renderer already laid out (a panel, a settings body, the composer). The old
 * `setup*` function for it is stopped, the element is handed to `mountRegion`, and the React tree draws into it
 * through a portal. Two consequences drive the design:
 *
 * - **One root.** Portals keep the single provider, the single Mantine theme and the single motion configuration;
 *   a root per region would multiply all three. So the registry lives outside React, the host subscribes to it, and
 *   mounting or unmounting a region never re-creates the provider.
 * - **One owner.** The container is marked `data-react-owned` for as long as a region is mounted. The translation
 *   walker and the native-select upgrader both skip that marker, so neither rewrites what React owns, and the
 *   legacy renderer must stop writing to the container in the same change that mounts it.
 */
import { useSyncExternalStore, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

interface Region {
  readonly container: HTMLElement;
  readonly element: ReactNode;
}

const regions = new Map<string, Region>();
const listeners = new Set<() => void>();
let version = 0;

function notify(): void {
  version += 1;
  for (const listener of [...listeners]) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

const snapshot = (): number => version;

/**
 * Mount one React region into an existing container; the returned disposer is idempotent.
 *
 * The key identifies the region rather than the element, so re-mounting the same region replaces its element
 * without leaving the previous one attached.
 */
export function mountRegion(key: string, container: HTMLElement, element: ReactNode): () => void {
  container.dataset.reactOwned = '';
  regions.set(key, { container, element });
  notify();
  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    regions.delete(key);
    delete container.dataset.reactOwned;
    notify();
  };
}

/** Renders every mounted region through a portal; rendered once, under the single provider. */
export function RegionHost(): ReactNode {
  useSyncExternalStore(subscribe, snapshot);
  return (
    <>{[...regions].map(([key, region]) => createPortal(region.element, region.container, key))}</>
  );
}
