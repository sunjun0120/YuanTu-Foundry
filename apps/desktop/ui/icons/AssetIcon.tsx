import type { ReactNode } from 'react';

export type AssetIconName =
  | 'settings'
  | 'sidebar-collapse'
  | 'folder'
  | 'sidebar-entry-more'
  | 'sidebar-rename'
  | 'sidebar-delete'
  | 'sliders-horizontal'
  | 'cpu'
  | 'sun'
  | 'moon'
  | 'monitor'
  | 'x'
  | 'new-task'
  | 'attach'
  | 'send';

/** Local SVG masks follow the current text color in both appearance modes. */
export function AssetIcon({ name, size = 18 }: { name: AssetIconName; size?: number }): ReactNode {
  const source = `url("./assets/icons/${name}.svg")`;
  return (
    <span
      className="desktop-asset-icon"
      aria-hidden="true"
      style={{ width: size, height: size, maskImage: source, WebkitMaskImage: source }}
    />
  );
}
