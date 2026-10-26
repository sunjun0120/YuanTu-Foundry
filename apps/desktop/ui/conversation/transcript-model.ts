/**
 * The transcript as data: which messages are shown, where consecutive operations fold together, and where run endings
 * and turn-change cards sit between them.
 *
 * A run writes a tool call at a time, and drawing each one as its own row makes a transcript unreadable; consecutive
 * operations therefore share one fold while actual replies keep their own place. This module decides that shape and
 * gives every row a key derived from its absolute source index, so a React list can keep a node (and an open fold)
 * across a rebuild.
 */
import type { CarrierSnapshot } from '../../../../packages/carrier/contract.ts';
import type { Message } from '../../../../packages/protocol/index.ts';
import type { RunEnding } from '../../../../packages/protocol/run-cancellation.ts';
import { isRuntimeContext } from '../../../../packages/protocol/context.ts';

export type StepKind = 'result' | 'reasoning' | 'call';

export interface TranscriptStep {
  kind: StepKind;
  key: string;
  index: number;
  /** The call's position within its assistant message, for `kind: 'call'`. */
  callIndex: number;
}

export type TranscriptSegment =
  | { kind: 'message'; key: string; index: number; message: Message }
  | { kind: 'group'; key: string; steps: TranscriptStep[] }
  | {
      kind: 'ending';
      key: string;
      afterIndex: number;
      ending: RunEnding;
    }
  | { kind: 'card'; key: string; afterIndex: number; position: number };

export interface TranscriptModel {
  /** Messages that survive filtering, with their absolute source index. */
  rows: { index: number; message: Message; position: number }[];
  segments: TranscriptSegment[];
  /** The message count the live-thought key is derived from (`startIndex + messages.length`). */
  messageCount: number;
  /** The fold the next live thought joins: the last group, or none. */
  tail: number | null;
}

/**
 * Legacy's visibility rules: machine context is not a message a person wrote, and a provisional answer is dropped when
 * a later answer exists — a verification nudge produces both, and the person reads the conclusion once.
 */
export function transcriptRows(
  messages: Message[],
  startIndex = 0,
): { index: number; message: Message; position: number }[] {
  const answerAfter = messages.map(() => false);
  let laterAnswer = false;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    answerAfter[index] = laterAnswer;
    const message = messages[index]!;
    if (message.role === 'assistant' && message.content.trim()) laterAnswer = true;
  }
  return messages
    .map((message, position) => ({ index: startIndex + position, message, position }))
    .filter(({ message, position }) => {
      if (message.role === 'user' && isRuntimeContext(message.content)) return false;
      if (message.role === 'assistant' && message.provisional && answerAfter[position])
        return false;
      return true;
    });
}

export function transcriptModel(
  snapshot: CarrierSnapshot | null,
  messages: Message[],
  startIndex: number,
  turnChanges: Map<number, unknown> = new Map(),
): TranscriptModel {
  const rows = transcriptRows(messages, startIndex);
  const endings = [...(snapshot?.session.runEndings ?? [])]
    .filter((ending) => ending.afterIndex >= startIndex)
    .sort((a, b) => a.afterIndex - b.afterIndex);
  const cards = [...turnChanges.keys()].sort((a, b) => a - b);
  const segments: TranscriptSegment[] = [];
  let group: Extract<TranscriptSegment, { kind: 'group' }> | null = null;
  let nextEnding = 0;
  let nextCard = 0;
  const closeGroup = (): void => {
    group = null;
  };
  const addStep = (step: TranscriptStep): void => {
    if (!group) {
      group = { kind: 'group', key: `group:${step.key}`, steps: [] };
      segments.push(group);
    }
    group.steps.push(step);
  };
  for (const [position, { index, message }] of rows.entries()) {
    const key = (suffix: string): string => `${index}:${suffix}`;
    if (message.role === 'tool')
      addStep({ kind: 'result', key: key('result'), index, callIndex: 0 });
    else if (message.role === 'assistant') {
      if (message.reasoning && message.reasoning.trim())
        addStep({ kind: 'reasoning', key: key('reasoning'), index, callIndex: 0 });
      if (message.content.trim() || message.interrupted) {
        closeGroup();
        segments.push({ kind: 'message', key: key('message'), index, message });
      }
      for (const [callIndex] of (message.toolCalls ?? []).entries())
        addStep({ kind: 'call', key: key(`call:${callIndex}`), index, callIndex });
    } else {
      closeGroup();
      segments.push({ kind: 'message', key: key('message'), index, message });
    }
    const nextIndex = rows[position + 1]?.index ?? startIndex + messages.length;
    while (nextEnding < endings.length && endings[nextEnding]!.afterIndex < nextIndex) {
      const ending = endings[nextEnding++]!;
      if (ending.afterIndex < index) continue;
      closeGroup();
      segments.push({
        kind: 'ending',
        key: `ending:${ending.afterIndex}:${nextEnding}`,
        afterIndex: ending.afterIndex,
        ending,
      });
    }
    while (nextCard < cards.length && cards[nextCard]! < nextIndex) {
      const afterIndex = cards[nextCard++]!;
      if (afterIndex >= index) {
        closeGroup();
        segments.push({
          kind: 'card',
          key: `card:${afterIndex}`,
          afterIndex,
          position: afterIndex,
        });
      }
    }
  }
  return {
    rows,
    segments,
    messageCount: startIndex + messages.length,
    tail: group === null ? null : segments.indexOf(group),
  };
}
