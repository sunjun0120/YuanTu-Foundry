/**
 * The last `capacity` characters a process printed, addressed by absolute position.
 *
 * Kept as the chunks they arrived in rather than one string: appending to a string ring copies the whole ring
 * on every chunk, which for a chatty build log is a 64 KB copy per line. Chunks are only joined for the window
 * a reader asks for. Positions are counted from the start of the output, so a cursor survives the ring moving.
 */
export class OutputRing {
  private chunks: string[] = [];
  /** Index of the oldest chunk still held; dropped chunks are compacted away in batches, not shifted one by one. */
  private head = 0;
  private held = 0;
  /** Characters the process has produced in all, including what the ring no longer holds. */
  total = 0;
  private readonly capacity: number;
  constructor(capacity: number) {
    this.capacity = capacity;
  }
  /** Absolute position of the oldest character still held. */
  get offset(): number {
    return this.total - this.held;
  }
  push(text: string): void {
    if (!text) return;
    this.total += text.length;
    if (text.length >= this.capacity) {
      this.chunks = [text.slice(-this.capacity)];
      this.head = 0;
      this.held = this.capacity;
      return;
    }
    this.chunks.push(text);
    this.held += text.length;
    while (this.held > this.capacity) {
      const oldest = this.chunks[this.head]!;
      const excess = this.held - this.capacity;
      if (oldest.length <= excess) {
        this.head++;
        this.held -= oldest.length;
      } else {
        this.chunks[this.head] = oldest.slice(excess);
        this.held -= excess;
      }
    }
    if (this.head > 64 && this.head * 2 > this.chunks.length) {
      this.chunks = this.chunks.slice(this.head);
      this.head = 0;
    }
  }
  /** Output that was lost before it reached the ring: everything held so far is now older than the gap. */
  skip(dropped: number): void {
    this.chunks = [];
    this.head = 0;
    this.held = 0;
    this.total += dropped;
  }
  /** Up to `max` characters starting at absolute position `start` (clamped to what is still held). */
  read(start: number, max: number): string {
    let skip = Math.max(start, this.offset) - this.offset;
    let want = Math.min(max, this.held - skip);
    if (want <= 0) return '';
    const parts: string[] = [];
    for (let i = this.head; i < this.chunks.length && want > 0; i++) {
      const chunk = this.chunks[i]!;
      if (skip >= chunk.length) {
        skip -= chunk.length;
        continue;
      }
      const part = chunk.slice(skip, skip + want);
      skip = 0;
      want -= part.length;
      parts.push(part);
    }
    return parts.join('');
  }
  /** The last `count` characters held. */
  tail(count: number): string {
    return this.read(this.total - count, count);
  }
}
