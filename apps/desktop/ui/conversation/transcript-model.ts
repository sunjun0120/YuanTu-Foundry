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
import type { Message, ToolCall } from '../../../../packages/protocol/index.ts';
import type { RunEnding } from '../../../../packages/protocol/run-cancellation.ts';
import { isRuntimeContext } from '../../../../packages/protocol/context.ts';
import type { PresentedFile } from '../../../../packages/protocol/deliverables.ts';
import { latestTurnStart, mcpTarget, type SummaryCallStatus } from '../panels/summary-model.ts';

export type StepKind = 'result' | 'reasoning' | 'call';

export interface TranscriptStep {
  kind: StepKind;
  key: string;
  index: number;
  /** The call's position within its assistant message, for `kind: 'call'`. */
  callIndex: number;
}

export interface TranscriptMcpCall {
  key: string;
  index: number;
  call: ToolCall;
  target: NonNullable<ReturnType<typeof mcpTarget>>;
  resultIndex: number | null;
  status: SummaryCallStatus;
}

export type TranscriptSegment =
  | { kind: 'message'; key: string; index: number; message: Message }
  | { kind: 'group'; key: string; steps: TranscriptStep[] }
  | { kind: 'mcp'; key: string; calls: TranscriptMcpCall[] }
  | {
      kind: 'ending';
      key: string;
      afterIndex: number;
      ending: RunEnding;
    }
  | { kind: 'card'; key: string; afterIndex: number; position: number }
  | { kind: 'deliverables'; key: string; afterIndex: number; files: PresentedFile[] };

export interface TranscriptModel {
  /** Messages that survive filtering, with their absolute source index. */
  rows: { index: number; message: Message; position: number }[];
  segments: TranscriptSegment[];
  /** The message count the live-thought key is derived from (`startIndex + messages.length`). */
  messageCount: number;
  /** The fold the next live thought joins: the last group, or none. */
  tail: number | null;
  /**
   * Every step key to the group key that currently holds it, fed back on the next call so a group that gains steps
   * above keeps the same key — and therefore the same DOM node, open state and scroll position.
   */
  groupKeys: Map<string, string>;
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

/** Keep known occurrences anchored before assigning keys to newly loaded or appended calls. */
function mcpCallKeys(
  positions: ReadonlyMap<ToolCall, number>,
  previous: readonly TranscriptMcpCall[],
): Map<ToolCall, string> {
  const keys = new Map<ToolCall, string>();
  const reserved = new Set(previous.map((item) => item.key));
  const reused = new Set<string>();
  const signature = (call: ToolCall): string =>
    JSON.stringify([call.id, call.name, call.arguments]);
  const previousAt = new Map(
    previous.map((item) => [`${item.index}:${signature(item.call)}`, item]),
  );
  const signatures = new Map([...positions.keys()].map((call) => [call, signature(call)]));
  const bySignature = new Map<string, TranscriptMcpCall[]>();
  for (const item of previous) {
    const key = signature(item.call);
    const pool = bySignature.get(key) ?? [];
    pool.push(item);
    bySignature.set(key, pool);
  }
  // Match absolute positions first: prepending an identical older call must not take an existing row's key.
  for (const [call, index] of positions) {
    const prior = previousAt.get(`${index}:${signatures.get(call)}`);
    if (prior) {
      keys.set(call, prior.key);
      reused.add(prior.key);
    }
  }
  // Approval refreshes can shift indices. Reconcile the remaining unchanged call values in their old order.
  for (const call of positions.keys()) {
    if (keys.has(call)) continue;
    const pool = bySignature.get(signatures.get(call)!);
    while (pool?.length && reused.has(pool[0]!.key)) pool.shift();
    const prior = pool?.shift();
    if (prior) {
      keys.set(call, prior.key);
      reused.add(prior.key);
      continue;
    }
    let ordinal = 0;
    while (reserved.has(`mcp-call:${call.id}:${ordinal}`)) ordinal++;
    const key = `mcp-call:${call.id}:${ordinal}`;
    keys.set(call, key);
    reserved.add(key);
  }
  return keys;
}

export function transcriptModel(
  snapshot: CarrierSnapshot | null,
  messages: Message[],
  startIndex: number,
  turnChanges: Map<number, unknown> = new Map(),
  previousGroups: ReadonlyMap<string, string> = new Map(),
  turnDeliverables: ReadonlyMap<number, PresentedFile[]> = new Map(),
  previousMcpCalls: readonly TranscriptMcpCall[] = [],
): TranscriptModel {
  const rows = transcriptRows(messages, startIndex);
  const endings = [...(snapshot?.session.runEndings ?? [])]
    .filter((ending) => ending.afterIndex >= startIndex)
    .sort((a, b) => a.afterIndex - b.afterIndex);
  const cards = [...turnChanges.keys()].sort((a, b) => a - b);
  const deliveries = [...turnDeliverables.keys()].sort((a, b) => a - b);
  const segments: TranscriptSegment[] = [];
  type Group = Extract<TranscriptSegment, { kind: 'group' | 'mcp' }>;
  const groups: Group[] = [];
  let group: Group | null = null;
  // Only absorb a result when its call is visible. A paginated orphan stays a normal result row until
  // loading older history reveals the call, so an important return value can never disappear.
  const results = new Map<ToolCall, { index: number; isError: boolean }>();
  const foldedResults = new Set<number>();
  const pendingCalls = new Map<string, ToolCall>();
  const callPositions = new Map<ToolCall, number>();
  for (const { index, message } of rows) {
    if (message.role === 'tool') {
      const call = pendingCalls.get(message.toolCallId);
      if (call && callPositions.has(call)) {
        results.set(call, { index, isError: message.isError });
        foldedResults.add(index);
      }
      pendingCalls.delete(message.toolCallId);
    }
    if (message.role === 'assistant') {
      for (const call of message.toolCalls ?? []) {
        // IDs need only be unique within one response. Include local calls in the pending map so a
        // later read_file reusing an MCP ID cannot steal that earlier call's result or be hidden.
        pendingCalls.set(call.id, call);
        if (mcpTarget(call)) callPositions.set(call, index);
      }
    }
  }
  const callKeys = mcpCallKeys(callPositions, previousMcpCalls);
  const turnStart = latestTurnStart(messages) + startIndex;
  const endedThrough = endings.at(-1)?.afterIndex ?? -1;
  let nextEnding = 0;
  let nextCard = 0;
  let nextDelivery = 0;
  const closeGroup = (): void => {
    group = null;
  };
  const addStep = (step: TranscriptStep): void => {
    if (!group || group.kind !== 'group') {
      group = { kind: 'group', key: '', steps: [] };
      groups.push(group);
      segments.push(group);
    }
    group.steps.push(step);
  };
  const addMcpCall = (item: TranscriptMcpCall): void => {
    if (!group || group.kind !== 'mcp') {
      group = { kind: 'mcp', key: '', calls: [] };
      groups.push(group);
      segments.push(group);
    }
    group.calls.push(item);
  };
  for (const [position, { index, message }] of rows.entries()) {
    const key = (suffix: string): string => `${index}:${suffix}`;
    if (message.role === 'tool') {
      if (!foldedResults.has(index))
        addStep({ kind: 'result', key: key('result'), index, callIndex: 0 });
    } else if (message.role === 'assistant') {
      if (message.reasoning && message.reasoning.trim())
        addStep({ kind: 'reasoning', key: key('reasoning'), index, callIndex: 0 });
      if (message.content.trim() || message.interrupted) {
        closeGroup();
        segments.push({ kind: 'message', key: key('message'), index, message });
      }
      for (const [callIndex, call] of (message.toolCalls ?? []).entries()) {
        const target = mcpTarget(call);
        if (!target) {
          addStep({ kind: 'call', key: key(`call:${callIndex}`), index, callIndex });
          continue;
        }
        const result = results.get(call);
        addMcpCall({
          // Approval/context refreshes may insert messages above a call. Its protocol ID survives
          // that index shift, keeping the card and its open row mounted when the result arrives.
          key: callKeys.get(call)!,
          index,
          call,
          target,
          resultIndex: result?.index ?? null,
          status: result
            ? result.isError
              ? 'failed'
              : 'succeeded'
            : snapshot?.session.running && index >= turnStart && index > endedThrough
              ? 'running'
              : 'interrupted',
        });
      }
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
    while (nextDelivery < deliveries.length && deliveries[nextDelivery]! < nextIndex) {
      const afterIndex = deliveries[nextDelivery++]!;
      if (afterIndex >= index) {
        closeGroup();
        segments.push({
          kind: 'deliverables',
          key: `deliverables:${afterIndex}`,
          afterIndex,
          files: turnDeliverables.get(afterIndex)!,
        });
      }
    }
  }
  /**
   * A group key is inherited from any step it already held. Consecutive tool results have no stable first step when
   * history is prepended above them, but they do have stable later ones; keeping the old key is what lets React reuse
   * the group (and the reader's open fold and scroll position) instead of replacing it with a new node.
   */
  const used = new Set<string>();
  const groupKeys = new Map<string, string>();
  for (const entry of groups) {
    const members = entry.kind === 'group' ? entry.steps : entry.calls;
    const inherited = members
      .map((step) => previousGroups.get(step.key))
      .find((key): key is string => key !== undefined);
    let key = inherited ?? `${entry.kind === 'group' ? 'group' : 'mcp'}:${members[0]!.key}`;
    // A boundary revealed inside a previously contiguous interval divides one old group into two: only the first
    // keeps the inherited key, the later ones must stay distinct or React would see duplicate list keys.
    while (used.has(key)) key = `${key}~`;
    used.add(key);
    entry.key = key;
    for (const step of members) groupKeys.set(step.key, key);
  }
  return {
    rows,
    segments,
    messageCount: startIndex + messages.length,
    tail: group === null || (group as Group).kind !== 'group' ? null : segments.indexOf(group),
    groupKeys,
  };
}
