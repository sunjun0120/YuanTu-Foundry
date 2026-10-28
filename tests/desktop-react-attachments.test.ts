import test from 'node:test';
import assert from 'node:assert/strict';
import { setLocale } from '../apps/desktop/i18n.ts';
import type { DocumentAttachment } from '../apps/desktop/attachment-contract.ts';
import { MAX_DOCUMENT_BYTES } from '../apps/desktop/attachment-contract.ts';
import { MAX_IMAGE_BYTES } from '../packages/protocol/images.ts';
import {
  attachmentFailureLine,
  attachmentFailureText,
  createAttachmentsController,
  imageMimeType,
  MAX_ATTACHMENTS,
  type AttachmentContext,
} from '../apps/desktop/ui/composer/attachment-model.ts';

/**
 * The attachment strip's rules without the DOM.
 *
 * The legacy module decided all of this inside a closure over the strip; the rules that matter are independent of
 * where the cards are drawn: the count cap, the vision requirement, the size limits, the per-file error line, the
 * duplicate names kept apart by position, and the read that belongs to a window that has since switched sessions.
 */
setLocale('zh-CN');

/** A real 1×1 PNG body: the image validator checks the signature, not just the MIME claim. */
const PNG_BODY =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

function file(name: string, type = '', size = 100): File {
  return { name, type, size } as File;
}
const documentOf = (name: string, text = 'hello'): DocumentAttachment => ({
  name,
  text,
  size: text.length,
});

function fixture(
  overrides: { context?: Partial<AttachmentContext>; readImageDelay?: Promise<string> } = {},
) {
  const context: AttachmentContext = {
    sessionId: 's1',
    workspace: '/w1',
    supportsVision: true,
    disabled: false,
    promptText: 'hi',
    ...overrides.context,
  };
  const errors: (string | null)[] = [];
  const reads: string[] = [];
  const controller = createAttachmentsController({
    getContext: () => context,
    readImage: async (entry) => {
      reads.push(entry.name);
      return overrides.readImageDelay ?? PNG_BODY;
    },
    readDocument: async (entry) => documentOf(entry.name, `text of ${entry.name}`),
    setError: (message) => errors.push(message),
    onChange: () => {},
  });
  return { controller, context, errors, reads };
}

test('an image and a document attach into the two lists', async () => {
  const { controller } = fixture();
  await controller.attach([file('shot.png', 'image/png')]);
  assert.equal(controller.images().length, 1);
  assert.equal(controller.images()[0]?.mimeType, 'image/png');
  await controller.attach([file('notes.txt', 'text/plain')]);
  assert.equal(controller.documents().length, 1);
  assert.equal(controller.hasAny(), true);
  assert.equal(controller.store.getSnapshot().busy, false);
});

test('a file with no vision support is refused with its own name', async () => {
  const { controller, errors } = fixture({ context: { supportsVision: false } });
  await controller.attach([file('shot.png', 'image/png')]);
  assert.equal(controller.images().length, 0);
  assert.deepEqual(
    errors.at(-1),
    attachmentFailureLine('shot.png', attachmentFailureText('vision')),
  );
});

test('the size limits are the contract limits', async () => {
  const { controller, errors } = fixture();
  await controller.attach([file('big.png', 'image/png', MAX_IMAGE_BYTES + 1)]);
  assert.deepEqual(
    errors.at(-1),
    attachmentFailureLine('big.png', attachmentFailureText('imageBytes')),
  );
  await controller.attach([file('big.txt', 'text/plain', MAX_DOCUMENT_BYTES + 1)]);
  assert.deepEqual(
    errors.at(-1),
    attachmentFailureLine('big.txt', attachmentFailureText('documentBytes')),
  );
});

test('the count cap covers images and documents together', async () => {
  const { controller, errors } = fixture();
  const files = Array.from({ length: MAX_ATTACHMENTS + 1 }, (_, index) => file(`f${index}.txt`));
  await controller.attach(files);
  assert.equal(controller.documents().length, 0);
  assert.deepEqual(errors.at(-1), attachmentFailureText('count'));
});

test('a read that finishes after a session switch is discarded', async () => {
  let release: ((data: string) => void) | undefined;
  const { controller, context } = fixture({
    readImageDelay: new Promise<string>((resolve) => {
      release = resolve;
    }),
  });
  const pending = controller.attach([file('shot.png', 'image/png')]);
  context.sessionId = 's2';
  release?.(PNG_BODY);
  await pending;
  assert.equal(controller.images().length, 0);
});

test('a workspace switch discards the same way', async () => {
  let release: ((data: string) => void) | undefined;
  const { controller, context } = fixture({
    readImageDelay: new Promise<string>((resolve) => {
      release = resolve;
    }),
  });
  const pending = controller.attach([file('shot.png', 'image/png')]);
  context.workspace = '/w2';
  release?.(PNG_BODY);
  await pending;
  assert.equal(controller.images().length, 0);
});

test('two files with the same name are two entries, not one', async () => {
  const { controller } = fixture();
  await controller.attach([file('notes.txt'), file('notes.txt')]);
  assert.equal(controller.documents().length, 2);
});

test('remove, clear and restore are positional', async () => {
  const { controller } = fixture();
  await controller.attach([file('a.txt'), file('b.txt')]);
  controller.removeDocument(0);
  assert.deepEqual(
    controller.documents().map((entry) => entry.name),
    ['b.txt'],
  );
  const kept = controller.documents();
  controller.clear();
  assert.equal(controller.hasAny(), false);
  controller.restore([], kept);
  assert.equal(controller.documents().length, 1);
});

test('a second attach while a read is in flight is ignored', async () => {
  let release: ((data: string) => void) | undefined;
  const { controller, reads } = fixture({
    readImageDelay: new Promise<string>((resolve) => {
      release = resolve;
    }),
  });
  const first = controller.attach([file('one.png', 'image/png')]);
  const second = controller.attach([file('two.png', 'image/png')]);
  release?.(PNG_BODY);
  await Promise.all([first, second]);
  assert.deepEqual(reads, ['one.png']);
});

test('the MIME type comes from the extension first and the claimed type second', () => {
  assert.equal(imageMimeType({ name: 'a.JPG', type: '' }), 'image/jpeg');
  assert.equal(imageMimeType({ name: 'a.bin', type: 'image/webp' }), 'image/webp');
  assert.equal(imageMimeType({ name: 'a.txt', type: 'text/plain' }), undefined);
});

test('a source archive is staged into the workspace and attached as a note', async () => {
  const staged: string[] = [];
  const errors: (string | null)[] = [];
  const controller = createAttachmentsController({
    getContext: () => ({
      sessionId: 's',
      workspace: '/w',
      supportsVision: false,
      disabled: false,
      promptText: '',
    }),
    readImage: async () => '',
    readDocument: async (entry) => documentOf(entry.name, 'should not be read'),
    stageSource: async (entry, workspace) => {
      staged.push(`${workspace}:${entry.name}`);
      return { path: `analysis-inputs/${entry.name}`, size: entry.size };
    },
    setError: (message) => errors.push(message),
    onChange: () => {},
  });
  await controller.attach([file('repo.zip', 'application/zip', 30 * 1024 * 1024)]);
  assert.deepEqual(staged, ['/w:repo.zip']);
  assert.equal(controller.documents().length, 1);
  assert.match(controller.documents()[0]!.text, /analysis-inputs\/repo\.zip/);
  assert.match(controller.documents()[0]!.text, /analysis_upload_source/);
  assert.deepEqual(errors.filter(Boolean), []);
});

test('without a staging path an archive goes through the document reader as before', async () => {
  const read: string[] = [];
  const controller = createAttachmentsController({
    getContext: () => ({
      sessionId: 's',
      workspace: '/w',
      supportsVision: false,
      disabled: false,
      promptText: '',
    }),
    readImage: async () => '',
    readDocument: async (entry) => (read.push(entry.name), documentOf(entry.name, 'x')),
    setError: () => {},
    onChange: () => {},
  });
  await controller.attach([file('repo.zip')]);
  assert.deepEqual(read, ['repo.zip']);
});
