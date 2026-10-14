import { createWriteStream } from 'node:fs';
import { once } from 'node:events';
import { Readable } from 'node:stream';
import { finished } from 'node:stream/promises';
import { spec } from 'node:test/reporters';
import summary from './test-summary.mjs';

const settings = new URL(import.meta.url).searchParams;

/** One subscription to Node's test stream; spec, summary and timings all see the same events. */
export default async function* reporter(events) {
  const target = settings.get('log');
  if (!target) throw new Error('The test reporter requires a spec log path');
  const log = createWriteStream(target, { encoding: 'utf8' });
  const logFinished = finished(log);
  // Observe failures immediately, including a path refused before any spec chunk was written.
  logFinished.catch(() => {});
  const logFailure = logFinished.then(
    () => new Promise(() => {}),
    (error) => {
      throw error;
    },
  );
  logFailure.catch(() => {});
  let observed = events;
  if (settings.get('timings')) {
    const moduleURL = new URL('./test-timings.mjs', import.meta.url);
    moduleURL.searchParams.set('path', settings.get('timings'));
    moduleURL.searchParams.set('phase', settings.get('phase'));
    observed = (await import(moduleURL.href)).observeTimings(events, { forward: true });
  }
  const summaries = [];
  async function* source() {
    for await (const event of observed) {
      for await (const line of summary([event])) summaries.push(line);
      yield event;
    }
  }
  const rendered = Readable.from(source()).compose(new spec());
  const reader = rendered[Symbol.asyncIterator]();
  try {
    for (;;) {
      const { value: chunk, done } = await Promise.race([reader.next(), logFailure]);
      if (done) break;
      if (log.errored) throw log.errored;
      if (!log.write(chunk)) await Promise.race([once(log, 'drain'), logFailure]);
      while (summaries.length) yield summaries.shift();
    }
    while (summaries.length) yield summaries.shift();
    log.end();
    await logFinished;
  } finally {
    rendered.destroy();
    log.destroy();
  }
}
