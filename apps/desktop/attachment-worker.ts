import { parentPort, workerData } from 'node:worker_threads';
import { extractAttachment } from './attachment-reader.ts';
import { mainText, setMainLocale } from './i18n.ts';
/**
 * The language comes in with the work, because a worker thread is not this process's module state.
 *
 * `mainText` reads the language the main process was told about, and a worker gets a fresh copy of every module:
 * without this line the one message this file can produce would be in the default language whatever the
 * interface is in — which is exactly the defect the extraction above exists to remove.
 */
setMainLocale(workerData?.language ?? 'zh-CN');
void extractAttachment(workerData.name, Buffer.from(workerData.data)).then(
  (file) => parentPort?.postMessage({ ok: true, file }),
  (error) =>
    parentPort?.postMessage({
      ok: false,
      error: error instanceof Error ? error.message : mainText('attach.failed'),
    }),
);
