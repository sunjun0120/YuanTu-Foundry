/**
 * Probe for `validation metadata overflow rejects through the tool promise` in `tests/tools.test.ts`.
 *
 * A targeted validation whose TAP metadata cannot be serialised inside the result budget has to fail *through*
 * the promise its caller awaits. The failure used to be thrown inside a detached `void (async () => ...)()` in
 * the child's close callback: the caller's promise never settled, and the only trace was an unhandled rejection
 * that took the whole process down. That is exactly why this runs as its own process — the main suite may not
 * carry an unhandled rejection — and why it reports through a marker file instead of an in-process assertion: a
 * worker killed by the very rejection under test still has to leave evidence behind.
 *
 * Usage: node tests/validation-error-worker.ts <marker-file>
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createTools } from '../packages/tools/index.ts';

const marker = process.argv[2] ?? '';
if (!marker) throw new Error('usage: validation-error-worker.ts <marker-file>');

/**
 * The trigger lives in the host spawn branch specifically: the confined branches serialise the result inline and
 * reject normally, so a probe that inherited `YUANTU_SANDBOX` from the outside would sometimes be testing the
 * other implementation. Pinning the mode is what makes this probe about the close callback.
 */
process.env.YUANTU_SANDBOX = 'host';

async function report(value: string): Promise<void> {
  await writeFile(marker, value, 'utf8');
}

async function main(): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-validation-overflow-'));
  try {
    await mkdir(path.join(root, 'tests'));
    await writeFile(
      path.join(root, 'package.json'),
      JSON.stringify({ scripts: { test: 'node --test tests/*.test.mjs' } }),
    );
    // Twenty failing names of a thousand quote characters each. The names the tool offers back are escaped by
    // `JSON.stringify` into roughly twice their length, and that is what pushes the evidence past the result
    // budget — the metadata, not the command output, is the part that cannot be shortened away.
    const name = '"'.repeat(1000);
    const cases = Array.from(
      { length: 20 },
      (_value, index) =>
        `test(${JSON.stringify(`${name} ${index}`)}, () => { throw new Error('probe'); });`,
    );
    await writeFile(
      path.join(root, 'tests', 'overflow.test.mjs'),
      `import test from 'node:test';\n${cases.join('\n')}\n`,
    );
    const tools = createTools(root);
    const settle = tools.execute(
      {
        id: 'call-overflow',
        name: 'run_validation',
        arguments: { id: 'npm:test', files: ['tests/overflow.test.mjs'] },
      },
      { signal: new AbortController().signal, approve: async () => true },
    );
    // A safety net, not the assertion: a promise that never settles must not hang the probe forever, and the
    // marker it leaves in that case is what the test reports as the failure.
    const fallback = setTimeout(() => {
      void report('caught=never-settled').catch(() => undefined);
    }, 10_000);
    try {
      const result = await settle;
      const overflow = result.isError && /metadata exceeds tool output limit/.test(result.content);
      await report(overflow ? 'caught=true' : `caught=unexpected:${result.content.slice(0, 160)}`);
    } finally {
      clearTimeout(fallback);
    }
  } catch (error) {
    await report(`caught=threw:${error instanceof Error ? error.message : String(error)}`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

await main();
console.log('validation overflow probe finished');
