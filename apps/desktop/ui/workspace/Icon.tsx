/**
 * A workspace icon as inline SVG.
 *
 * The path set is the legacy `workspace-icons.ts` table; it is inlined here rather than appended through a wrapper
 * element so a toolbar control or a tab contains exactly one `<svg>` and nothing else (the workspace smoke counts
 * `svg[data-icon]` and reads the tab's name from its single label span).
 */
import type { ReactNode } from 'react';

const PATHS = {
  'chevron-down': 'm7 10 5 5 5-5',
  'chevron-right': 'm10 7 5 5-5 5',
  search: 'M17 10.5a6.5 6.5 0 1 1-13 0 6.5 6.5 0 0 1 13 0Zm-1.5 5 5 5',
  compose: 'M14 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8M19 3l2 2-9 9-4 1 1-4Z',
  home: 'm3 11 9-8 9 8M5 9v11h5v-6h4v6h5V9',
  folder: 'M3 7V5a2 2 0 0 1 2-2h5l3 3h6a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z',
  'folder-closed':
    'M3 10h18M3 10V6a2 2 0 0 1 2-2h5l3 3h6a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z',
  'folder-open': 'M3 17V5a2 2 0 0 1 2-2h5l3 3h6a2 2 0 0 1 2 2v2M3 20l3-9h16l-3 9Z',
  'folder-plus':
    'M3 7V5a2 2 0 0 1 2-2h5l3 3h3M3 7h10M3 7v12a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-6M20 3v6M17 6h6',
  file: 'M14 2H5v20h14V7Zm0 0v5h5M8 12h8M8 16h8',
  markdown: 'M14 2H5v20h14V7Zm0 0v5h5',
  close: 'm6 6 12 12M6 18 18 6',
  expand:
    'M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2ZM9 3v18m7-6-3-3 3-3',
  collapse:
    'M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2ZM9 3v18m5-12 3 3-3 3',
  fullscreen: 'M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5',
  restore: 'M3 8h5V3m13 5h-5V3M8 21v-5H3m13 5v-5h5',
  refresh: 'M20 7v5h-5M20 12a8 8 0 1 0-2 6M20 7l-3-3',
  plus: 'M12 5v14M5 12h14',
  'plus-circle': 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Zm0 5v8m-4-4h8',
  globe: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Zm0 0c3 3 3 15 0 18M3 12h18',
  // The following follow lucide's shapes, matching the reference workspace panel.
  maximize: 'M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7',
  minimize: 'M4 14h6v6M20 10h-6V4M14 10l7-7M3 21l7-7',
  'arrow-left': 'm12 19-7-7 7-7M19 12H5',
  'arrow-right': 'M5 12h14m-7-7 7 7-7 7',
  'rotate-cw': 'M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8m0-5v5h-5',
  lock: 'M5 10h14a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2Zm2 0V7a5 5 0 0 1 10 0v3m-5 5v2',
  external: 'M15 3h6v6M10 14 21 3M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6',
  copy: 'M10 8h10a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H10a2 2 0 0 1-2-2V10a2 2 0 0 1 2-2ZM4 16a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2',
  check: 'M20 6 9 17l-5-5',
  'square-plus':
    'M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Zm3 9h8m-4-4v8',
} as const;

export type IconKind = keyof typeof PATHS;

export function Icon({ kind }: { kind: IconKind }): ReactNode {
  return (
    <svg
      viewBox="0 0 24 24"
      width="20"
      height="20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      data-icon={kind}
    >
      <path d={PATHS[kind]} />
    </svg>
  );
}
