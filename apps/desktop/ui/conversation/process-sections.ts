import type { TranscriptSegment } from './transcript-model.ts';

export type ProcessSegment = Extract<TranscriptSegment, { kind: 'group' | 'mcp' }>;
export type ConversationSection =
  | TranscriptSegment
  | {
      kind: 'process';
      key: string;
      segments: ProcessSegment[];
    };

export function buildProcessSections(
  segments: readonly TranscriptSegment[],
  previous: ReadonlyMap<string, string> = new Map(),
): { sections: ConversationSection[]; keys: Map<string, string> } {
  const sections: ConversationSection[] = [];
  const keys = new Map<string, string>();
  const used = new Set<string>();
  let pending: ProcessSegment[] = [];
  const flush = (): void => {
    if (!pending.length) return;
    // A local-only process already has its own collapsed fold. Retain that component unchanged.
    if (!pending.some((segment) => segment.kind === 'mcp')) {
      sections.push(...pending);
      pending = [];
      return;
    }
    const inherited = pending
      .map((segment) => previous.get(segment.key))
      .find((key) => key !== undefined && !used.has(key));
    let key = inherited ?? `execution:${pending.find((segment) => segment.kind === 'mcp')!.key}`;
    while (used.has(key)) key += '~';
    used.add(key);
    for (const segment of pending) keys.set(segment.key, key);
    sections.push({ kind: 'process', key, segments: pending });
    pending = [];
  };
  for (const segment of segments) {
    if (segment.kind === 'group' || segment.kind === 'mcp') pending.push(segment);
    else {
      flush();
      sections.push(segment);
    }
  }
  flush();
  return { sections, keys };
}
