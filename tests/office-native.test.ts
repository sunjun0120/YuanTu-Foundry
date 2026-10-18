// @test-serial desktop-ui: Uses real Word and PowerPoint COM applications and their desktop state.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  OfficeUnavailableError,
  isOfficeUnavailable,
  isScriptAuthorizationFailure,
  runOfficeAutomation,
} from '../packages/office/automation.ts';
import { readPptxSlides } from '../packages/office/read.ts';
import { verifyFileDelivery } from '../packages/tools/file-delivery.ts';
import { ToolRegistry } from '../packages/tools/registry.ts';
import { officeTools } from '../packages/office/tools.ts';

// COM applications expect these standard folders even in a private test profile.
test.before(async () => {
  if (process.platform !== 'win32' || !process.env.FOUNDRY_TEST_ROOT) return;
  for (const directory of [
    path.join(process.env.USERPROFILE!, 'Desktop'),
    path.join(process.env.USERPROFILE!, 'Documents'),
    path.join(process.env.APPDATA!, 'Microsoft/Templates'),
    path.join(process.env.APPDATA!, 'Microsoft/Word'),
    path.join(process.env.APPDATA!, 'Microsoft/Office'),
    path.join(process.env.LOCALAPPDATA!, 'Microsoft/Windows/INetCache/Content.Word'),
  ])
    await mkdir(directory, { recursive: true });
});

test(
  'Word and PowerPoint files created and edited in JS convert to PDF through local Office',
  { skip: process.platform !== 'win32' && 'needs Windows', timeout: 240000 },
  async (t) => {
    try {
      const root = await mkdtemp(path.join(tmpdir(), 'yuantu-office-workflow-'));
      t.after(() => rm(root, { recursive: true, force: true }));
      const source = path.join(root, 'source.docx');
      const output = path.join(root, 'edited.docx');
      const preview = path.join(root, 'preview.pdf');
      const slides = path.join(root, 'source.pptx');
      const revised = path.join(root, 'revised.pptx');
      await runOfficeAutomation({
        operation: 'create',
        format: 'docx',
        outputPath: source,
        title: 'Quarterly Plan',
        paragraphs: ['Keep original detail', 'Replace marker 947'],
      });

      await runOfficeAutomation({
        operation: 'edit',
        format: 'docx',
        sourcePath: source,
        outputPath: output,
        replacements: [{ from: 'marker 947', to: 'marker 948' }],
      });
      await runOfficeAutomation({
        operation: 'preview',
        format: 'docx',
        sourcePath: output,
        outputPath: preview,
      });
      const mammoth = (await import('mammoth')).default;
      const text = (await mammoth.extractRawText({ buffer: await readFile(output) })).value;
      assert.match(text, /Quarterly Plan/);
      assert.match(text, /Keep original detail/);
      assert.match(text, /marker 948/);
      assert.doesNotMatch(text, /marker 947/);
      assert.equal(
        (await verifyFileDelivery(root, { path: 'preview.pdf', format: 'pdf' })).format,
        'pdf',
      );

      await runOfficeAutomation({
        operation: 'create',
        format: 'pptx',
        outputPath: slides,
        slides: [{ title: 'Quarterly Plan', body: ['Keep this point', 'Replace marker 947'] }],
      });
      await runOfficeAutomation({
        operation: 'edit',
        format: 'pptx',
        sourcePath: slides,
        outputPath: revised,
        replacements: [{ from: 'marker 947', to: 'marker 948' }],
      });
      await runOfficeAutomation({
        operation: 'preview',
        format: 'pptx',
        sourcePath: revised,
        outputPath: path.join(root, 'slides.pdf'),
      });
      const slideText = (await readPptxSlides(await readFile(revised))).join(' ');
      assert.match(slideText, /Quarterly Plan/);
      assert.match(slideText, /Keep this point/);
      assert.match(slideText, /marker 948/);
      await verifyFileDelivery(root, { path: 'slides.pdf', format: 'pdf' });
    } catch (error) {
      // Only the PDF conversions reach Office; creating and editing are JS and must not be what skips.
      if (!(error instanceof OfficeUnavailableError)) throw error;
      t.skip(error.message.slice(0, 260));
    }
  },
);

/**
 * Why this environment cannot run the Office COM automation, or `undefined` when it can.
 *
 * Word and PowerPoint need local Office *and* a machine willing to load `automation.ps1`. Both refusals are
 * facts about the environment rather than evidence about the product, so they skip with their own reason — and
 * nothing else does, because only the classified markers count. "Any error means skip" would quietly turn a
 * broken operation into a green run, which is the failure mode the explicit rule exists to prevent.
 *
 * The tool path flattens the typed error into the result text (the registry reports `error.message`, which
 * keeps the `Original error:` tail), so the markers are matched there; the direct `runOfficeAutomation` path
 * skips on `OfficeUnavailableError` itself.
 */
function officeEnvironmentReason(text: string): string | undefined {
  if (isScriptAuthorizationFailure(text))
    return 'Windows refused to load the Office automation script on this machine';
  if (isOfficeUnavailable(text)) return 'Microsoft Office is not installed on this machine';
  return undefined;
}

test(
  'office_preview converts a JS-created PowerPoint file to PDF through local Office',
  { skip: process.platform !== 'win32' && 'needs Windows', timeout: 120000 },
  async (t) => {
    const root = await mkdtemp(path.join(tmpdir(), 'yuantu-ppt-tools-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const registry = new ToolRegistry();
    officeTools(root).forEach((tool) => registry.register(tool));
    const run = (id: string, name: string, args: Record<string, unknown>) =>
      registry.execute(
        { id, name, arguments: args },
        { signal: new AbortController().signal, approve: async () => true },
      );
    // Creation needs no Office, so it must succeed here whatever the machine has installed.
    const created = await run('ppt', 'office_create', {
      format: 'pptx',
      path: 'presentation.pptx',
      slides: [{ title: 'Delivery', body: ['Verified slide'] }],
    });
    assert.equal(created.isError, false, created.content);
    const preview = await run('preview', 'office_preview', {
      source_path: 'presentation.pptx',
      output_path: 'presentation.pdf',
      backend: 'office',
    });
    const environment = preview.isError ? officeEnvironmentReason(preview.content) : undefined;
    if (environment) {
      t.skip(`${environment}; an Office PDF of PPTX needs local Office`);
      return;
    }
    assert.equal(preview.isError, false, preview.content);
    assert.equal(JSON.parse(preview.content).previewType, 'office-pdf');
    await verifyFileDelivery(root, { path: 'presentation.pdf', format: 'pdf' });
  },
);

async function runOfficeOperation(
  tool: ReturnType<typeof officeTools>[number],
  args: Record<string, unknown>,
): Promise<void> {
  const registry = new ToolRegistry();
  registry.register(tool);
  const result = await registry.execute(
    { id: 'create', name: tool.name, arguments: args },
    {
      signal: new AbortController().signal,
      approve: async () => true,
      fileJournal: { prepare: () => 'journal-id', applied() {} },
    },
  );
  if (result.isError) throw new Error(result.content);
}

test('a .pdf preview falls back to LibreOffice only when Office is unavailable', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-office-pdf-fallback-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  let rendered = 0;
  const tools = officeTools(root, {
    async render(input) {
      rendered++;
      await writeFile(input.outputPath, '%PDF-1.4\nfixture\n%%EOF');
    },
  });
  const tool = (name: string) => tools.find((item) => item.name === name)!;
  await runOfficeOperation(tool('office_create'), {
    format: 'docx',
    path: 'report.docx',
    paragraphs: ['Body'],
  });
  const registry = new ToolRegistry();
  registry.register(tool('office_preview'));
  const result = await registry.execute(
    {
      id: 'pdf',
      name: 'office_preview',
      arguments: { source_path: 'report.docx', output_path: 'report.pdf' },
    },
    { signal: new AbortController().signal, approve: async () => true },
  );
  assert.equal(result.isError, false, result.content);
  const type = JSON.parse(result.content).previewType;
  // Which engine answers depends on the machine; that the fallback ran exactly when Office could not does not.
  assert.equal(type, rendered ? 'libreoffice-pdf' : 'office-pdf');
  if (process.platform !== 'win32') assert.equal(type, 'libreoffice-pdf');
});
