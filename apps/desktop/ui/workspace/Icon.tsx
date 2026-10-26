/**
 * A workspace icon as inline SVG.
 *
 * The path set is the legacy `workspace-icons.ts` table; it is inlined here rather than appended through a wrapper
 * element so a toolbar control or a tab contains exactly one `<svg>` and nothing else (the workspace smoke counts
 * `svg[data-icon]` and reads the tab's name from its single label span).
 */
import type { ReactNode } from 'react';

const PATHS = {
  folder: 'M3 7V5a2 2 0 0 1 2-2h5l3 3h6a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z',
  'folder-open': 'M3 17V5a2 2 0 0 1 2-2h5l3 3h6a2 2 0 0 1 2 2v2M3 20l3-9h16l-3 9Z',
  file: 'M14 2H5v20h14V7Zm0 0v5h5M8 12h8M8 16h8',
  markdown: 'M14 2H5v20h14V7Zm0 0v5h5',
  close: 'm6 6 12 12M6 18 18 6',
  expand: 'M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Zm3 0v18',
  collapse: 'M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Zm11 0v18',
  fullscreen: 'M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5',
  restore: 'M3 8h5V3m13 5h-5V3M8 21v-5H3m13 5v-5h5',
  refresh: 'M20 7v5h-5M20 12a8 8 0 1 0-2 6M20 7l-3-3',
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
