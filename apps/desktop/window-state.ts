import { readFileSync } from 'node:fs';
import { rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * Where the main window was, so the next launch opens it there instead of at a fixed 1220×860 in the middle.
 *
 * Kept free of Electron so the decision is testable: the shell passes the displays' work areas in, and a saved
 * position that no longer lands on any of them (a monitor unplugged, a scale factor changed) falls back to the
 * default size centred by the window manager rather than opening a window nobody can see.
 */
export interface WindowBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}
export interface WindowState {
  bounds: WindowBounds;
  maximized: boolean;
}
export const DEFAULT_WINDOW_SIZE = { width: 1220, height: 860 } as const;
export const MIN_WINDOW_SIZE = { width: 820, height: 620 } as const;
/** How much of the title bar must be on a display for the saved position to count as reachable. */
const VISIBLE_EDGE = 80;

function isBounds(value: unknown): value is WindowBounds {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return ['x', 'y', 'width', 'height'].every(
    (key) => typeof record[key] === 'number' && Number.isSafeInteger(record[key]),
  );
}

export function parseWindowState(value: unknown): WindowState | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  if (!isBounds(record.bounds)) return null;
  const { bounds } = record;
  if (bounds.width < MIN_WINDOW_SIZE.width || bounds.height < MIN_WINDOW_SIZE.height) return null;
  return { bounds, maximized: record.maximized === true };
}

/**
 * The saved state, if its top edge is still reachable on one of `workAreas`.
 *
 * The test is the title bar rather than the whole rectangle: a window larger than a newly attached small screen is
 * still usable if it can be grabbed and moved, while one whose title bar is off every display cannot be.
 */
export function restorableWindowState(
  saved: WindowState | null,
  workAreas: readonly WindowBounds[],
): WindowState | null {
  if (!saved) return null;
  const { x, y, width } = saved.bounds;
  const reachable = workAreas.some(
    (area) =>
      y >= area.y &&
      y < area.y + area.height - VISIBLE_EDGE / 2 &&
      x + width > area.x + VISIBLE_EDGE &&
      x < area.x + area.width - VISIBLE_EDGE,
  );
  return reachable ? saved : null;
}

export class WindowStateStore {
  private readonly file: string;
  constructor(file: string) {
    this.file = file;
  }
  /** Read once at launch; a missing or malformed file is simply "no saved state". */
  load(): WindowState | null {
    try {
      return parseWindowState(JSON.parse(readFileSync(this.file, 'utf8')));
    } catch {
      return null;
    }
  }
  /** Written through a temporary file so a quit mid-write leaves the previous state rather than half of one. */
  async save(state: WindowState): Promise<void> {
    const temporary = path.join(
      path.dirname(this.file),
      `.${path.basename(this.file)}.${process.pid}.tmp`,
    );
    await writeFile(temporary, JSON.stringify(state), 'utf8');
    await rename(temporary, this.file);
  }
}

/**
 * The file name a save dialog may start from.
 *
 * `suggestedName` comes from the renderer, so it is reduced to a bare name here: no directory part (an absolute
 * path or `..` would otherwise move the dialog's starting folder), none of the characters Windows refuses, no
 * trailing dots or spaces, and a Markdown or text extension. The dialog still decides where the file is written —
 * this only keeps its *starting point* inside the workspace the person is looking at.
 */
export function safeExportName(
  suggested: string | undefined,
  fallback = 'yuantu-session.md',
): string {
  const base = (suggested ?? '').split(/[\\/]/).pop() ?? '';
  let name = base
    .replace(/[<>:"|?*\u0000-\u001f]/g, '_')
    .replace(/[. ]+$/, '')
    .trim()
    .slice(0, 120);
  if (!name || /^\.+$/.test(name)) return fallback;
  if (/^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i.test(name)) name = `_${name}`;
  if (!/\.(md|txt)$/i.test(name)) name = `${name}.md`;
  return name;
}
