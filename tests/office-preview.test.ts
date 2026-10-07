import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createLibreOfficePreview } from '../packages/office/preview.ts';
import { officeTools } from '../packages/office/tools.ts';
import { ToolRegistry } from '../packages/tools/registry.ts';

async function fixture(t: { after(fn: () => Promise<void>): void }, mode = 'ok') {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-preview-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = path.join(root, '中文 source.xlsx');
  await writeFile(source, 'unchanged fixture');
  const script = path.join(root, 'renderer.mjs');
  await writeFile(
    script,
    `
    import { writeFile } from 'node:fs/promises';
    import path from 'node:path';
    const args = process.argv.slice(2);
    const output = args[args.indexOf('--outdir') + 1];
    const input = args.at(-1);
    if (${JSON.stringify(mode)} === 'hang') setInterval(() => {}, 1000);
    else if (${JSON.stringify(mode)} !== 'missing') {
      await writeFile(input, 'converter changed its copy');
      await writeFile(path.join(output, path.basename(input, path.extname(input)) + '.pdf'),
        ${JSON.stringify(mode)} === 'invalid' ? 'bad' : '%PDF-1.4\\nfixture\\n%%EOF');
    }
  `,
  );
  return {
    root,
    source,
    renderer: createLibreOfficePreview({
      executable: process.execPath,
      prefixArgs: [script],
      timeoutMs: mode === 'hang' ? 300 : 5000,
    }),
  };
}

test('optional renderer uses a source copy, verifies PDF and removes conversion directories', async (t) => {
  const { root, source, renderer } = await fixture(t);
  const output = path.join(root, 'preview.pdf');
  await renderer.render({ format: 'xlsx', sourcePath: source, outputPath: output });
  assert.match(await readFile(output, 'utf8'), /^%PDF-/);
  assert.equal(await readFile(source, 'utf8'), 'unchanged fixture');
  assert.deepEqual(
    (await readdir(root)).filter((name) => name.startsWith('.yuantu-preview-')),
    [],
  );
});

for (const mode of ['missing', 'invalid', 'hang']) {
  test(`renderer rejects ${mode} output and cleans temporary files`, async (t) => {
    const { root, source, renderer } = await fixture(t, mode);
    await assert.rejects(
      renderer.render({
        format: 'xlsx',
        sourcePath: source,
        outputPath: path.join(root, 'preview.pdf'),
      }),
      mode === 'hang' ? /timed out/ : /PDF/,
    );
    assert.deepEqual(
      (await readdir(root)).filter((name) => name.startsWith('.yuantu-preview-')),
      [],
    );
    await assert.rejects(readFile(path.join(root, 'preview.pdf')));
  });
}

test('tool captures backend before approval and preserves default Excel extension', async (t) => {
  const { root, renderer } = await fixture(t);
  const tool = officeTools(root, renderer).find((tool) => tool.name === 'office_preview')!;
  const args = {
    source_path: '中文 source.xlsx',
    output_path: 'preview.pdf',
    backend: 'libreoffice',
  };
  const prepared = await tool.prepare!(args, {
    signal: new AbortController().signal,
    approve: async () => true,
  });
  args.backend = 'native';
  await assert.rejects(
    tool.prepare!(
      { source_path: args.source_path, output_path: 'native.pdf' },
      { signal: new AbortController().signal, approve: async () => true },
    ),
    /html/,
  );
  // Backend selection is retained in the prepared operation, even if caller arguments change.
  const result = await prepared.execute({
    signal: new AbortController().signal,
    approve: async () => true,
  });
  // Transport fixture checks delivery markers; actual pagination needs the real engine.
  assert.equal(result.isError, false);
  assert.equal(JSON.parse(result.content).previewType, 'libreoffice-pdf');
});

test('bounded queue rejects overflow and removes cancelled waiting jobs', async (t) => {
  const { root, source, renderer } = await fixture(t, 'hang');
  const input = (i: number) => ({
    format: 'xlsx' as const,
    sourcePath: source,
    outputPath: path.join(root, `${i}.pdf`),
  });
  const active = renderer.render(input(0)).catch((error: Error) => error);
  const controller = new AbortController();
  const waiting = renderer.render(input(1), controller.signal).catch((error: Error) => error);
  const rest = [2, 3, 4].map((i) => renderer.render(input(i)).catch((error: Error) => error));
  await assert.rejects(renderer.render(input(5)), /queue is full/);
  controller.abort(new Error('cancel waiting'));
  const cancelled = await waiting;
  assert.ok(cancelled instanceof Error);
  assert.match(cancelled.message, /cancel waiting/);
  await Promise.all([active, ...rest]);
  assert.deepEqual(
    (await readdir(root)).filter((name) => name.startsWith('.yuantu-preview-')),
    [],
  );
});

test('preview refusal leaves no output and never starts converter', async (t) => {
  const { root } = await fixture(t);
  let called = false;
  const registry = new ToolRegistry();
  officeTools(root, {
    async render() {
      called = true;
    },
  }).forEach((tool) => registry.register(tool));
  const result = await registry.execute(
    {
      id: 'deny',
      name: 'office_preview',
      arguments: {
        source_path: '中文 source.xlsx',
        output_path: 'preview.pdf',
        backend: 'libreoffice',
      },
    },
    { signal: new AbortController().signal, approve: async () => false },
  );
  assert.equal(result.isError, true);
  assert.equal(called, false);
  await assert.rejects(readFile(path.join(root, 'preview.pdf')));
});

test('converter refuses oversized input and never overwrites an existing output', async (t) => {
  const { root, source, renderer } = await fixture(t);
  const outputPath = path.join(root, 'preview.pdf');
  await writeFile(outputPath, 'keep');
  await assert.rejects(renderer.render({ format: 'xlsx', sourcePath: source, outputPath }));
  assert.equal(await readFile(outputPath, 'utf8'), 'keep');
  await writeFile(source, Buffer.alloc(20_000_001));
  await assert.rejects(
    renderer.render({ format: 'xlsx', sourcePath: source, outputPath }),
    /20 MB/,
  );
});
