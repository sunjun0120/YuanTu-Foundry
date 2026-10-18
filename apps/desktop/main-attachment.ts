import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { ipcMain } from 'electron';
import { MAX_DOCUMENT_BYTES, type AttachmentReply } from './attachment-contract.ts';
import { mainText } from './i18n.ts';
import type { MainContext } from './main-context.ts';

/** Reads one attached document at a time in a bounded worker thread; never touches the carrier. */
export function registerAttachmentIpc(
  ctx: Pick<MainContext, 'assertSender'>,
  language: () => string,
): void {
  let readingAttachment = false;
  ipcMain.handle('yuantu:attachment', async (event, input): Promise<AttachmentReply> => {
    try {
      ctx.assertSender(event);
      if (readingAttachment) throw new Error(mainText('attach.busy'));
      if (
        !input ||
        typeof input.name !== 'string' ||
        !(input.data instanceof Uint8Array) ||
        input.data.byteLength > MAX_DOCUMENT_BYTES
      )
        throw new Error(mainText('attach.invalid'));
      readingAttachment = true;
      try {
        return await new Promise<AttachmentReply>((resolve) => {
          const worker = new Worker(path.join(__dirname, 'attachment-worker.cjs'), {
            // The language travels with the work: a worker thread has its own copy of every module, so the one
            // message it can produce would otherwise be in the default language.
            workerData: { ...input, language: language() },
            resourceLimits: { maxOldGenerationSizeMb: 256 },
          });
          let settled = false;
          const finish = (reply: AttachmentReply) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            void worker.terminate();
            resolve(reply);
          };
          const timer = setTimeout(
            () => finish({ ok: false, error: mainText('attach.timeout') }),
            20000,
          );
          worker.once('message', finish);
          worker.once('error', () => finish({ ok: false, error: mainText('attach.readFailed') }));
          worker.once('exit', () => finish({ ok: false, error: mainText('attach.workerExited') }));
        });
      } finally {
        readingAttachment = false;
      }
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : mainText('attach.failed'),
      };
    }
  });
}
