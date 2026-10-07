import { inspect } from 'node:util';

// The second (spec) reporter retains every event in the log. Keep model context small.
export default async function* summary(events) {
  for await (const { type, data } of events) {
    if (type === 'test:fail') {
      yield `FAIL ${data.file ?? ''}:${data.line ?? ''} ${data.name}\n`;
      yield `${inspect(data.details.error, { depth: 6, colors: false }).slice(0, 6000)}\n`;
    } else if (type === 'test:pass' && data.skip) {
      yield `SKIP ${data.name}: ${data.skip}\n`;
    } else if (type === 'test:summary' && !data.file) {
      const { passed, failed, skipped, cancelled, todo, tests } = data.counts;
      yield `Tests: ${tests} pass=${passed} fail=${failed} skip=${skipped} cancelled=${cancelled} todo=${todo} duration=${(data.duration_ms / 1000).toFixed(2)}s\n`;
    }
  }
}
