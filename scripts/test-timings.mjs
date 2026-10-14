/**
 * A third node:test reporter that writes what happened as NDJSON, for measurement only.
 *
 * It is deliberately not a scheduler and not a summary: it observes the event stream and records
 * per-case and per-file durations plus the run totals. Nothing here decides which tests run or what
 * the exit code is, so an error in this file cannot turn a failure into a pass — a report that could
 * not be written is refused by the runner instead (it requires the terminal record written below).
 *
 * Configured through this module's own URL, because `--test-reporter` takes a module path and no
 * arguments:
 *
 *   --test-reporter=file:///…/test-timings.mjs?path=<file>&phase=serial
 *
 * The configuration must not travel in the environment: the tests under measurement start the Host,
 * the CLI and the sandbox as child processes that inherit it, and the Host validates it — an unknown
 * `YUANTU_*` variable is a configuration error that stops the Host from starting at all. A query
 * string reaches this module and nothing else.
 */
import { createWriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

export const SCHEMA_VERSION = 1;

const settings = new URL(import.meta.url).searchParams;
const target = settings.get('path') ?? null;
const phaseName = settings.get('phase');
const phase = ['parallel', 'serial'].includes(phaseName ?? '') ? phaseName : null;

/**
 * A reporter is an async generator. Anything thrown while the consumer is not pulling is turned
 * into an unhandled rejection, which would be reported as a crash of the test process rather than
 * as a missing report; so write failures are recorded and surfaced as a missing terminal record at
 * the end, which the runner turns into a non-zero exit.
 */
export default function timings(events) {
  return observeTimings(events);
}

export async function* observeTimings(events, { forward = false } = {}) {
  if (!target) return;
  await mkdir(path.dirname(path.resolve(target)), { recursive: true });
  const out = createWriteStream(target, { encoding: 'utf8', flags: 'a' });
  let broken = null;
  const write = (record) => {
    if (broken) return;
    try {
      out.write(`${JSON.stringify(record)}\n`);
    } catch (error) {
      broken = error;
    }
  };
  const started = performance.now();
  // Ordinary t.test()/suite children belong to this harness and must be recorded. A subprocess's
  // reporter output is stdout, not part of this event stream; nesting does not identify a harness.
  const fileSummarised = new Set();

  try {
    for await (const event of events) {
      if (forward) yield event;
      const data = event.data ?? {};
      const file = typeof data.file === 'string' ? data.file : null;
      if (event.type === 'test:pass' || event.type === 'test:fail') {
        write({
          schemaVersion: SCHEMA_VERSION,
          phase,
          kind: 'case',
          file,
          name: typeof data.name === 'string' ? data.name : null,
          status: statusOf(event),
          durationMs: durationOf(data),
          skipReason: typeof data.skip === 'string' ? data.skip : null,
        });
        continue;
      }
      if (event.type === 'test:summary') {
        if (file === null) {
          // The suite-wide summary. `counts` is Node's own; `duration_ms` is the harness's clock.
          write({
            schemaVersion: SCHEMA_VERSION,
            phase,
            kind: 'run-summary',
            file: null,
            durationMs: durationOf(data),
            counts: countsOf(data),
          });
        } else if (!fileSummarised.has(file)) {
          fileSummarised.add(file);
          write({
            schemaVersion: SCHEMA_VERSION,
            phase,
            kind: 'file-summary',
            file,
            durationMs: durationOf(data),
            counts: countsOf(data),
          });
        }
      }
    }
    // The last record the runner looks for. A report that could not be written must not look like a
    // report that was: the runner refuses a timings file without this terminal record, so a
    // truncated file can never be read as a complete one.
    write({
      schemaVersion: SCHEMA_VERSION,
      phase,
      kind: 'phase-summary',
      file: null,
      durationMs: Number((performance.now() - started).toFixed(3)),
      counts: null,
    });
  } finally {
    await new Promise((resolve) => out.end(resolve));
  }
  // A write failure is still a failed run: the runner sees an incomplete report, and this makes the
  // reporter's own process status non-zero as well.
  if (broken) throw broken;
  if (!forward) yield '';
}

function statusOf(event) {
  const data = event.data ?? {};
  if (data.skip) return 'skipped';
  if (data.todo) return 'todo';
  if (event.type === 'test:fail') {
    const failureType = data.details?.error?.failureType;
    return ['cancelledByParent', 'testAborted', 'testTimeoutFailure'].includes(failureType)
      ? 'cancelled'
      : 'failed';
  }
  return 'passed';
}

function durationOf(data) {
  // Where the value lives depends on the event: a case carries it in `details`, a summary at the
  // top level. Both are read; a caller that finds neither gets null rather than a guessed number.
  for (const value of [data.details?.duration_ms, data.duration_ms, data.durationMs])
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  return null;
}

function countsOf(data) {
  const counts = data.counts ?? {};
  const number = (key) => (typeof counts[key] === 'number' ? counts[key] : null);
  return {
    tests: number('tests'),
    passed: number('passed'),
    failed: number('failed'),
    skipped: number('skipped'),
    cancelled: number('cancelled'),
    todo: number('todo'),
  };
}
