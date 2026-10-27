/**
 * The browser panel's wire vocabulary: what the renderer may ask and what the main process answers.
 *
 * Tab ids are renderer-owned and stable across a view rebuild; `viewId` is main-owned and may change. The state
 * objects are deliberately plain data — the guest's WebContents never crosses the bridge.
 */
export const BROWSER_PARTITION = 'persist:yuantu-browser';
export const MAX_BROWSER_TABS = 8;

export interface BrowserBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}
export interface BrowserError {
  code: number;
  description: string;
  url: string;
}
export interface BrowserState {
  id: string;
  url: string;
  title: string;
  loading: boolean;
  started: boolean;
  error: BrowserError | null;
  crashed: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  notice: 'popup-blocked' | 'download-blocked' | null;
}

export type BrowserCommand =
  | { type: 'list' }
  | { type: 'create'; id: string }
  | { type: 'navigate'; id: string; url: string }
  | { type: 'back'; id: string }
  | { type: 'forward'; id: string }
  | { type: 'reload'; id: string }
  | { type: 'stop'; id: string }
  | { type: 'focus'; id: string }
  | { type: 'open-external'; id: string; url: string }
  | { type: 'layout'; id: string; bounds: BrowserBounds; visible: boolean }
  | { type: 'destroy'; id: string };

export type BrowserReply =
  | { ok: true; state?: BrowserState; states?: BrowserState[]; viewId?: number }
  | { ok: false; error: string };

export type BrowserEvent =
  | { type: 'state'; state: BrowserState }
  | { type: 'open'; id: string; url: string }
  | { type: 'popup-blocked'; id: string }
  | { type: 'download-blocked'; id: string }
  | { type: 'layout-request' };

const ID = /^[\w-]{1,128}$/u;
const finite = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
function id(value: unknown): string {
  if (typeof value !== 'string' || !ID.test(value)) throw new Error('Invalid browser tab id');
  return value;
}
function bounds(value: unknown): BrowserBounds {
  if (!record(value) || !['x', 'y', 'width', 'height'].every((key) => finite(value[key])))
    throw new Error('Invalid browser bounds');
  return {
    x: value.x as number,
    y: value.y as number,
    width: value.width as number,
    height: value.height as number,
  };
}

/** Validate one renderer request; unknown shapes are refused before any view exists. */
export function parseBrowserCommand(input: unknown): BrowserCommand {
  if (!record(input) || typeof input.type !== 'string') throw new Error('Invalid browser command');
  const type = input.type;
  if (type === 'list') return { type };
  const tab = id(input.id);
  switch (type) {
    case 'create':
    case 'back':
    case 'forward':
    case 'reload':
    case 'stop':
    case 'focus':
    case 'destroy':
      return { type, id: tab };
    case 'navigate': {
      if (typeof input.url !== 'string' || input.url.length > 4096)
        throw new Error('Invalid browser URL');
      return { type, id: tab, url: input.url };
    }
    case 'open-external': {
      if (typeof input.url !== 'string' || input.url.length > 4096)
        throw new Error('Invalid browser URL');
      return { type, id: tab, url: input.url };
    }
    case 'layout': {
      if (typeof input.visible !== 'boolean') throw new Error('Invalid browser visibility');
      return { type, id: tab, bounds: bounds(input.bounds), visible: input.visible };
    }
    default:
      throw new Error('Unknown browser command');
  }
}
