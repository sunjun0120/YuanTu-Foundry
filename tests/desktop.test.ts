import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CarrierService } from '../packages/carrier/service.ts';
import { parseCarrierCommand } from '../packages/carrier/contract.ts';
import { FILE_PREVIEW_BYTES, FILE_TREE_ENTRY_LIMIT } from '../packages/protocol/rpc.ts';
import { MAX_IMAGE_BYTES } from '../packages/protocol/images.ts';
import { parseFilesCommand } from '../apps/desktop/files-contract.ts';
import { frames, httpFixture, sendFrames } from './http-fixture.ts';
import { projectRoot } from './process-fixture.ts';
import * as XLSX from 'xlsx';
import { extractAttachment } from '../apps/desktop/attachment-reader.ts';
import { docxFixture, pdfFixture } from './attachment-fixtures.ts';
import { attachmentPrompt, splitAttachmentPrompt } from '../apps/desktop/attachment-contract.ts';
import {
  DEFAULT_PRESET,
  PERMISSION_PRESETS,
  parsePermissionPresetCommand,
  permissionPreset,
  presetIdFor,
} from '../apps/desktop/permission-presets.ts';

// ---- merged from desktop.test.ts ----

test('desktop contract validates background task commands', () => {
  assert.deepEqual(
    parseCarrierCommand({ type: 'stopBackground', id: 'job', sessionId: 'session' }),
    { type: 'stopBackground', id: 'job', sessionId: 'session' },
  );
  assert.deepEqual(
    parseCarrierCommand({ type: 'pollBackground', id: 'job', sessionId: 'session', cursor: 4 }),
    { type: 'pollBackground', id: 'job', sessionId: 'session', cursor: 4 },
  );
  assert.throws(
    () => parseCarrierCommand({ type: 'stopBackground', id: '', sessionId: 'session' }),
    /Invalid carrier command/,
  );
});
test('desktop boundary rejects arbitrary methods, paths and invalid approval payloads', () => {
  for (const input of [
    null,
    { type: 'exec', command: 'x' },
    { type: 'send', prompt: '' },
    { type: 'approve', id: 'x', allow: 'yes' },
    { type: 'taskApproval', taskId: 'task', approvalId: 'approval', allow: 'yes' },
    { type: 'taskApproval', taskId: '', approvalId: 'approval', allow: true },
    { type: 'load', id: 1 },
    { type: 'chooseWorkspace', path: '../outside' },
    { type: 'openLink', url: 'javascript:alert(1)' },
    { type: 'openLink', url: 'file:///C:/Windows' },
    { type: 'openLink', url: 'https://user:secret@example.com/' },
    { type: 'openLogs', path: '../outside' },
    { type: 'copyText', text: 4 },
    { type: 'rename', id: 'x', title: '' },
    { type: 'rename', id: 'x', title: 'x'.repeat(121) },
    { type: 'deleteSession', id: 5 },
    { type: 'fork', id: 'x', messageCount: -1 },
    { type: 'fork', id: 'x', messageCount: 1.5 },
    { type: 'searchSessions', query: 'x'.repeat(201) },
  ]) {
    assert.throws(() => parseCarrierCommand(input), /Invalid carrier command/);
  }
  assert.deepEqual(parseCarrierCommand({ type: 'approve', id: 'x', allow: false }), {
    type: 'approve',
    id: 'x',
    allow: false,
  });
  assert.deepEqual(
    parseCarrierCommand({
      type: 'taskApproval',
      taskId: 'task',
      approvalId: 'approval',
      allow: false,
    }),
    {
      type: 'taskApproval',
      taskId: 'task',
      approvalId: 'approval',
      allow: false,
    },
  );
});

test('startup failure exposes its phase and an actionable Host error', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-startup-'));
  const service = new CarrierService({
    nodePath: process.execPath,
    hostPath: path.join(root, 'missing-host.js'),
    workspace: root,
  });
  t.after(async () => {
    await service.stop();
    await rm(root, { recursive: true, force: true });
  });
  await assert.rejects(service.start());
  assert.equal(service.snapshot.startupStage, 'failed');
  assert.equal(service.snapshot.ready, false);
  assert.ok(service.snapshot.error);
});

test('desktop service loads persisted sessions after restart and blocks session changes during runs', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-desktop-'));
  let release!: () => void;
  let started!: () => void;
  const waiting = new Promise<void>((resolve) => {
    started = resolve;
  });
  const url = await httpFixture(t, async (_, res) => {
    started();
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    sendFrames(res, frames('Desktop answer'));
  });
  const options = {
    nodePath: process.execPath,
    hostPath: path.join(projectRoot, 'apps/agent-host/main.ts'),
    workspace: root,
    env: {
      YUANTU_API_KEY: 'desktop-secret',
      YUANTU_MODEL: 'fixture',
      YUANTU_MAX_CONTEXT_TOKENS: '128000',
      YUANTU_SESSION_TITLES: '0',
      YUANTU_BASE_URL: url,
    },
  };
  const service = new CarrierService(options);
  t.after(async () => {
    release?.();
    await service.stop();
    await rm(root, { recursive: true, force: true });
  });
  await service.start();
  const first = service.snapshot.session.sessionId;
  assert.ok(first);
  assert.equal(service.snapshot.configured, true);
  assert.doesNotMatch(JSON.stringify(service.snapshot), /desktop-secret/);
  const send = service.dispatch({ type: 'send', prompt: 'Hello' });
  await waiting;
  await assert.rejects(service.dispatch({ type: 'create' }), /running|loading/);
  release();
  await send;
  await service.dispatch({ type: 'create' });
  assert.equal(service.snapshot.sessions.length, 2);
  await service.dispatch({ type: 'load', id: first });
  assert.equal(service.snapshot.session.messages.at(-1)?.content, 'Desktop answer');
  await service.stop();
  const restarted = new CarrierService(options);
  try {
    await restarted.start();
    await restarted.dispatch({ type: 'load', id: first });
    assert.equal(restarted.snapshot.session.messages.at(-1)?.content, 'Desktop answer');
  } finally {
    await restarted.stop();
  }
});

test('the sub-agent transcript viewer refuses sessions this one did not delegate to', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-subagent-guard-'));
  const url = await httpFixture(t, (_, res) => sendFrames(res, frames('Answer')));
  const service = new CarrierService({
    nodePath: process.execPath,
    hostPath: path.join(projectRoot, 'apps/agent-host/main.ts'),
    workspace: root,
    env: {
      YUANTU_API_KEY: 'guard-secret',
      YUANTU_MODEL: 'fixture',
      YUANTU_MAX_CONTEXT_TOKENS: '128000',
      YUANTU_SESSION_TITLES: '0',
      YUANTU_BASE_URL: url,
    },
  });
  t.after(async () => {
    await service.stop();
    await rm(root, { recursive: true, force: true });
  });
  await service.start();
  const current = service.snapshot.session.sessionId;
  assert.ok(current);

  // The ids come from the renderer, so the viewer must only open what this session actually delegated.
  // Naming a real session in the same workspace is the case the guard exists for: without it the panel
  // would be a way to read any conversation in the workspace.
  await assert.rejects(
    service.dispatch({
      type: 'subagentTranscript',
      subagentId: 'made-up',
      childSessionId: current,
    }),
    /does not belong to this session/,
  );
  assert.equal(service.snapshot.subagentTranscript, null, 'a refusal must not leave state behind');
  assert.match(service.snapshot.error ?? '', /does not belong to this session/);

  const other = (await service.dispatch({ type: 'create' })).session.sessionId;
  assert.ok(other);
  await service.dispatch({ type: 'load', id: current });
  await assert.rejects(
    service.dispatch({ type: 'subagentTranscript', subagentId: 'made-up', childSessionId: other }),
    /does not belong to this session/,
  );
  assert.equal(service.snapshot.subagentTranscript, null);

  // Closing when nothing is open is a no-op rather than an error.
  await service.dispatch({ type: 'closeSubagentTranscript' });
  assert.equal(service.snapshot.subagentTranscript, null);
  assert.equal(service.snapshot.error, null);
});

// ---- merged from attachments.test.ts ----

test('reads UTF-8 text and rejects binary, unsupported, empty and oversized files', async () => {
  /**
   * The messages are asserted in the default language, which is the language these calls are made in: nothing sets
   * the main process's language in this test, so it is the default `mainText` starts from. Three of these used to
   * be bilingual strings (`'Unsupported file / 不支持此格式…'`), which is why the assertions used to look for the
   * English half — the half that now changes with the interface, asserted in `tests/settings.test.ts`.
   */
  const read = (name: string, text: string) => extractAttachment(name, Buffer.from(text));
  assert.equal((await read('notes.txt', 'attachment secret 42')).text, 'attachment secret 42');
  await assert.rejects(read('program.exe', 'binary'), /不支持此格式/);
  await assert.rejects(read('notes.txt', '\u0000binary'), /不是可读取的文本/);
  await assert.rejects(read('empty.txt', ''), /文件为空/);
  await assert.rejects(read('large.txt', 'a'.repeat(60001)), /60000/);
});
test('extracts all Excel sheets and preserves cell values for xlsx and xls', async () => {
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    book,
    XLSX.utils.aoa_to_sheet([
      ['Item', 'Amount'],
      ['Widget', 42],
    ]),
    'Sales',
  );
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([['second sheet content']]), 'Notes');
  for (const bookType of ['xlsx', 'xls'] as const) {
    const bytes = XLSX.write(book, { type: 'buffer', bookType });
    const result = await extractAttachment('report.' + bookType, bytes);
    assert.match(result.text, /Sales/);
    assert.match(result.text, /Widget.*42/);
    assert.match(result.text, /second sheet content/);
  }
});

test('reads real PDF and DOCX text including Word table cells', async () => {
  const pdf = await extractAttachment('report.pdf', pdfFixture());
  assert.match(pdf.text, /PDF document secret 529/);
  const word = await extractAttachment('report.docx', await docxFixture());
  assert.match(word.text, /Word document secret 731/);
  assert.match(word.text, /Table cell 984/);
  await assert.rejects(extractAttachment('scan.pdf', pdfFixture('')), /OCR/);
  await assert.rejects(extractAttachment('broken.pdf', Buffer.from('not a pdf')));
  await assert.rejects(extractAttachment('broken.docx', Buffer.from('not a zip')));
});
test('composed message carries file content and rejects aggregate overflow', () => {
  const file = { name: 'readme.md', text: 'hidden content 135', size: 18 };
  assert.match(attachmentPrompt('', [file]), /hidden content 135/);
  assert.match(attachmentPrompt('', [file]), /readme.md/);
  assert.throws(
    () => attachmentPrompt('a'.repeat(50000), [{ ...file, text: 'b'.repeat(60000) }]),
    /100000/,
  );
});

test('attachment display round trips newlines and quotes without hiding malformed content', () => {
  const file = { name: 'code.ts', text: 'const name = "quoted";\nsecond line', size: 40 };
  const sent = attachmentPrompt('Read this', [file]);
  assert.deepEqual(splitAttachmentPrompt(sent), {
    prompt: 'Read this',
    files: [{ file: file.name, content: file.text }],
  });
  assert.deepEqual(splitAttachmentPrompt('ordinary message'), {
    prompt: 'ordinary message',
    files: [],
  });
});
test('rejects oversized Excel sheets rather than silently truncating them', async () => {
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    book,
    XLSX.utils.aoa_to_sheet(Array.from({ length: 1001 }, () => ['row'])),
    'Rows',
  );
  await assert.rejects(
    extractAttachment('large.xlsx', XLSX.write(book, { type: 'buffer', bookType: 'xlsx' })),
    /1000/,
  );
});

test('extracts slide text from PPTX attachments in slide order', async () => {
  const JSZip = (await import('jszip')).default;
  const zip = new JSZip();
  zip.file(
    'ppt/presentation.xml',
    '<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:sldIdLst><p:sldId r:id="rId2"/><p:sldId r:id="rId1"/></p:sldIdLst></p:presentation>',
  );
  zip.file(
    'ppt/_rels/presentation.xml.rels',
    '<Relationships><Relationship Id="rId1" Target="slides/slide1.xml"/><Relationship Id="rId2" Target="slides/slide2.xml"/></Relationships>',
  );
  zip.file(
    'ppt/slides/slide1.xml',
    '<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:t>Quarterly result</a:t><a:t>Revenue 947</a:t></p:sld>',
  );
  zip.file(
    'ppt/slides/slide2.xml',
    '<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:t>Next steps</a:t></p:sld>',
  );
  const extracted = await extractAttachment(
    'deck.pptx',
    await zip.generateAsync({ type: 'nodebuffer' }),
  );
  assert.match(extracted.text, /Quarterly result/);
  assert.match(extracted.text, /Revenue 947/);
  assert.ok(extracted.text.indexOf('Next steps') < extracted.text.indexOf('Quarterly result'));
});

/**
 * The isolation/approval preset: one choice that writes both security knobs.
 *
 * What is pinned here is the *rule*, not the wiring: the two switches could be left in combinations nobody
 * intended (`host` + `ask` reads as "no isolation, but ask me"), so the preset set has to be a set of pairs
 * whose only host member is the one that stops asking, and a pair outside the set has to be recognisable as
 * custom rather than rounded to the nearest preset.
 */
test('a preset pairs a sandbox with an approval floor, and only the full-access one leaves the sandbox', () => {
  const pairs = PERMISSION_PRESETS.map((preset) => `${preset.sandbox}+${preset.permission}`);
  assert.equal(new Set(pairs).size, pairs.length, 'no two presets describe the same pair');
  assert.deepEqual(
    PERMISSION_PRESETS.map((preset) => preset.id),
    ['observe', 'guarded', 'unconfined'],
    'three rungs, in the order the chip reads them',
  );
  assert.equal(
    PERMISSION_PRESETS.find((preset) => preset.id === DEFAULT_PRESET)?.sandbox,
    'sbx',
    'a new session starts confined',
  );
  assert.equal(
    permissionPreset(DEFAULT_PRESET).permission,
    'ask',
    'and it starts by asking: a default that auto-approved writes would be promising something else',
  );
  assert.equal(
    PERMISSION_PRESETS.find((preset) => preset.sandbox === 'host')?.permission,
    'full-access',
    'the only preset that gives up isolation is the one whose point is that it stops asking',
  );
  assert.equal(
    PERMISSION_PRESETS.filter((preset) => preset.sandbox === 'docker').length,
    0,
    'docker is a compatibility backend an operator names in the launch environment; a preset must not choose it',
  );
  for (const preset of PERMISSION_PRESETS)
    assert.deepEqual(permissionPreset(preset.id), preset, `${preset.id} resolves to itself`);
});

test('a pair no preset declares reads as custom rather than as the nearest preset', () => {
  for (const preset of PERMISSION_PRESETS)
    assert.equal(presetIdFor(preset.sandbox, preset.permission), preset.id);
  // The combination that motivated the feature: no isolation, but the approval floor still looks guarded.
  assert.equal(presetIdFor('host', 'ask'), null);
  assert.equal(presetIdFor('docker', 'ask'), null);
  assert.equal(presetIdFor('sbx', 'full-access'), null);
  assert.throws(() => permissionPreset('trusted' as never), /Unknown permission preset: trusted/);
});

test('a preset command is validated, including the host acknowledgement it must not bypass', () => {
  assert.deepEqual(parsePermissionPresetCommand({ type: 'get' }), { type: 'get' });
  assert.deepEqual(parsePermissionPresetCommand({ type: 'set', preset: 'guarded' }), {
    type: 'set',
    preset: 'guarded',
  });
  assert.deepEqual(
    parsePermissionPresetCommand({ type: 'set', preset: 'unconfined', acknowledgeHost: true }),
    { type: 'set', preset: 'unconfined', acknowledgeHost: true },
  );
  for (const invalid of [
    null,
    [],
    { type: 'get', extra: 1 },
    { type: 'set' },
    { type: 'set', preset: 'trusted' },
    { type: 'set', preset: 'guarded', acknowledgeHost: 'yes' },
    { type: 'set', preset: 'guarded', mode: 'sbx' },
  ])
    assert.throws(() => parsePermissionPresetCommand(invalid), /Invalid permission preset request/);
  // The rule comes from the sandbox command's own parser, so the preset cannot be a way past the confirmation
  // the mode selector still asks for — and the message is the one that rule already produces.
  assert.throws(
    () => parsePermissionPresetCommand({ type: 'set', preset: 'unconfined' }),
    /Confirm that host commands have no operating-system isolation/,
  );
  assert.throws(
    () =>
      parsePermissionPresetCommand({ type: 'set', preset: 'unconfined', acknowledgeHost: false }),
    /Confirm that host commands have no operating-system isolation/,
  );
  // A sandbox that needs no confirmation needs none here either.
  assert.doesNotThrow(() => parsePermissionPresetCommand({ type: 'set', preset: 'observe' }));
});

// ---- the read-only workspace file surface ----

test('the desktop file channel accepts only a list or a read of one path', () => {
  assert.deepEqual(parseFilesCommand({ type: 'list' }), { type: 'list' });
  assert.deepEqual(parseFilesCommand({ type: 'read', path: 'src/main.ts' }), {
    type: 'read',
    path: 'src/main.ts',
  });
  // Shape only. Whether a path may be opened is the Host's answer, and answering it here would be a second
  // copy of the containment rule on the side of the boundary that cannot enforce it.
  for (const invalid of [
    null,
    {},
    { type: 'write', path: 'a' },
    { type: 'delete', path: 'a' },
    { type: 'read' },
    { type: 'read', path: 5 },
    { type: 'read', path: 'a', extra: 1 },
    { type: 'list', path: 5 },
    { type: 'read', path: 'a\0b' },
    { type: 'read', path: 'x'.repeat(4097) },
  ])
    assert.throws(() => parseFilesCommand(invalid), /Invalid workspace file request/);
});

test('the workspace file surface is bounded by the file tools own rules', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-files-'));
  const outside = await mkdtemp(path.join(tmpdir(), 'yuantu-outside-'));
  await writeFile(path.join(outside, 'secret.txt'), 'outside\n', 'utf8');
  await mkdir(path.join(root, 'src'));
  await mkdir(path.join(root, '.git'));
  await mkdir(path.join(root, 'node_modules'));
  await writeFile(path.join(root, '.git', 'config'), '[core]\n', 'utf8');
  await writeFile(path.join(root, '.env'), 'SECRET=1\n', 'utf8');
  await writeFile(path.join(root, 'src', 'main.ts'), 'export const value = 1;\n', 'utf8');
  await writeFile(path.join(root, 'README.md'), '# 项目\n\n说明\n', 'utf8');
  // The extension says text; the bytes say otherwise. The preview has to answer from the bytes.
  await writeFile(path.join(root, 'notes.txt'), Buffer.from([0x00, 0x01, 0x02, 0xff]));
  const png = await readFile(path.join(projectRoot, 'apps/desktop/img/logo-dark.png'));
  await writeFile(path.join(root, 'logo.png'), png);
  await writeFile(
    path.join(root, 'huge.png'),
    Buffer.concat([png.subarray(0, 32), Buffer.alloc(MAX_IMAGE_BYTES)]),
  );
  await writeFile(path.join(root, 'long.txt'), Buffer.alloc(FILE_PREVIEW_BYTES + 1, 0x61));
  await mkdir(path.join(root, 'many'));
  // One more file than the tree will show, so the cap is answered by the listing rather than by the reader
  // noticing that a directory stopped halfway.
  for (let start = 0; start <= FILE_TREE_ENTRY_LIMIT; start += 200)
    await Promise.all(
      Array.from({ length: Math.min(200, FILE_TREE_ENTRY_LIMIT + 1 - start) }, (_, offset) =>
        writeFile(path.join(root, 'many', `f${start + offset}.txt`), ''),
      ),
    );

  const service = new CarrierService({
    nodePath: process.execPath,
    hostPath: path.join(projectRoot, 'apps/agent-host/main.ts'),
    workspace: root,
    env: {
      YUANTU_API_KEY: 'files-secret',
      YUANTU_MODEL: 'fixture',
      YUANTU_BASE_URL: 'http://127.0.0.1:9',
      YUANTU_MAX_CONTEXT_TOKENS: '128000',
      YUANTU_SESSION_TITLES: '0',
    },
  });
  t.after(async () => {
    await service.stop();
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  });
  await service.start();

  const rootListing = await service.listWorkspaceFiles();
  assert.equal(rootListing.path, '');
  assert.equal(rootListing.truncated, false);
  assert.deepEqual(
    rootListing.entries.map((entry) => entry.name),
    ['many', 'src', 'huge.png', 'logo.png', 'long.txt', 'notes.txt', 'README.md'],
  );
  assert.deepEqual(
    rootListing.entries.filter((entry) => entry.kind === 'directory').map((entry) => entry.path),
    ['many', 'src'],
  );
  // A nested directory is listed by its own path, so the tree is built from answers about one level rather
  // than from a walk that would have to guess how much of the workspace to read.
  const srcListing = await service.listWorkspaceFiles({ path: 'src' });
  assert.equal(srcListing.path, 'src');
  assert.deepEqual(srcListing.entries, [{ name: 'main.ts', path: 'src/main.ts', kind: 'file' }]);

  // The same refusals the file tools produce, because it is the same rule answering.
  await assert.rejects(
    service.readWorkspaceFile({ path: '../outside/secret.txt' }),
    /outside workspace/,
  );
  await assert.rejects(
    service.readWorkspaceFile({ path: `${outside}/secret.txt` }),
    /outside workspace/,
  );
  await assert.rejects(service.readWorkspaceFile({ path: '.env' }), /blocked/);
  await assert.rejects(service.listWorkspaceFiles({ path: 'node_modules' }), /blocked/);
  await assert.rejects(service.listWorkspaceFiles({ path: '.git' }), /blocked/);

  const markdown = await service.readWorkspaceFile({ path: 'README.md' });
  assert.equal(markdown.kind, 'text');
  // Compared as characters the Host decoded from the file's bytes: the panel must not re-encode them through
  // the console's code page on the way here.
  assert.equal(markdown.text, '# 项目\n\n说明\n');
  assert.equal(markdown.bytes, Buffer.byteLength('# 项目\n\n说明\n'));

  const long = await service.readWorkspaceFile({ path: 'long.txt' });
  assert.equal(long.kind, 'text');
  assert.equal(long.truncated, true);
  assert.equal(long.text?.length, FILE_PREVIEW_BYTES);

  const image = await service.readWorkspaceFile({ path: 'logo.png' });
  assert.equal(image.kind, 'image');
  assert.equal(image.mimeType, 'image/png');
  assert.deepEqual(Buffer.from(image.data ?? '', 'base64'), png);

  const binary = await service.readWorkspaceFile({ path: 'notes.txt' });
  assert.equal(binary.kind, 'unsupported');
  assert.equal(binary.reason, 'binary');
  const oversized = await service.readWorkspaceFile({ path: 'huge.png' });
  assert.equal(oversized.kind, 'unsupported');
  assert.equal(oversized.reason, 'too-large');
  // A directory is not a file and says so, rather than being read as one.
  assert.equal((await service.readWorkspaceFile({ path: 'src' })).reason, 'not-a-file');

  const many = await service.listWorkspaceFiles({ path: 'many' });
  assert.equal(many.truncated, true);
  assert.equal(many.entries.length, FILE_TREE_ENTRY_LIMIT);
  assert.deepEqual(
    many.entries.slice(0, 4).map((entry) => entry.name),
    ['f0.txt', 'f1.txt', 'f2.txt', 'f3.txt'],
  );
  assert.equal(many.entries.at(-1)?.name, `f${FILE_TREE_ENTRY_LIMIT - 1}.txt`);
});
