/**
 * Markdown split into top-level blocks at blank lines, the way a streaming answer grows.
 *
 * A live answer only ever changes at its end, so every block before the last is finished: re-parsing and
 * re-building those on each 100 ms paint was the cost of a long answer, not the new text. The split happens at a
 * blank line outside a fenced code block, which is where CommonMark itself ends a paragraph, a heading or a
 * table; a fence's blank lines belong to the fence. Joining the blocks with "\n\n" gives the text back up to
 * runs of blank lines, which Markdown does not distinguish.
 *
 * This is for the *preview*. A list whose items are separated by blank lines becomes one list per block here,
 * which reads the same; the finished message is rendered whole, as before.
 */
export function markdownBlocks(text: string): string[] {
  const blocks: string[] = [];
  let current: string[] = [];
  let fence: string | null = null;
  for (const line of text.split('\n')) {
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (fence === null && marker) fence = marker;
    else if (fence !== null && marker && marker[0] === fence[0] && marker.length >= fence.length)
      fence = null;
    else if (fence === null && !line.trim()) {
      if (current.length) blocks.push(current.join('\n'));
      current = [];
      continue;
    }
    current.push(line);
  }
  if (current.length) blocks.push(current.join('\n'));
  return blocks;
}
