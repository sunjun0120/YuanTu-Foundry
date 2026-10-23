import test from 'node:test';
import assert from 'node:assert/strict';
import { OutputRing } from '../packages/tools/output-ring.ts';

/** The string ring this replaced, kept as the oracle: the chunked ring must answer exactly what it did. */
class StringRing {
  output = '';
  total = 0;
  offset = 0;
  private capacity: number;
  constructor(capacity: number) {
    this.capacity = capacity;
  }
  push(text: string): void {
    this.total += text.length;
    this.output = (this.output + text).slice(-this.capacity);
    this.offset = this.total - this.output.length;
  }
  skip(dropped: number): void {
    this.output = '';
    this.total += dropped;
    this.offset = this.total;
  }
  read(start: number, max: number): string {
    const from = Math.max(start, this.offset) - this.offset;
    return this.output.slice(from, from + max);
  }
}

test('the chunked ring answers every read the string ring did', () => {
  let seed = 7;
  const random = (n: number) => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed % n;
  };
  for (const capacity of [1, 5, 64, 1000]) {
    const ring = new OutputRing(capacity);
    const oracle = new StringRing(capacity);
    for (let step = 0; step < 2000; step++) {
      if (random(50) === 0) {
        const dropped = random(30) + 1;
        ring.skip(dropped);
        oracle.skip(dropped);
      } else {
        const text = String.fromCharCode(97 + (step % 26)).repeat(random(capacity * 2) + 1);
        ring.push(text);
        oracle.push(text);
      }
      assert.equal(ring.total, oracle.total);
      assert.equal(ring.offset, oracle.offset);
      const start = random(ring.total + 1);
      const max = random(capacity + 10);
      assert.equal(
        ring.read(start, max),
        oracle.read(start, max),
        `capacity ${capacity}, step ${step}`,
      );
      assert.equal(ring.tail(capacity), oracle.output);
    }
  }
});

test('many tiny chunks keep the ring bounded and reads cheap', () => {
  const ring = new OutputRing(65_536);
  for (let i = 0; i < 500_000; i++) ring.push('x');
  assert.equal(ring.total, 500_000);
  assert.equal(ring.offset, 500_000 - 65_536);
  assert.equal(ring.tail(10), 'x'.repeat(10));
  assert.equal(ring.read(0, 3).length, 3);
});
