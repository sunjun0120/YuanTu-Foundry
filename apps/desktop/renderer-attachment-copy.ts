import { format, t } from './i18n.ts';

/**
 * The refusals the renderer makes itself while files are being attached, in the interface's language.
 *
 * These are the renderer's own copy, not the reader's: the worker beside it reports `attach.*` codes which the
 * main process translates, and the two used to drift — the same situation worded twice, one of them translated
 * and one of them not. `vision` deliberately reuses the entry the kernel's message is keyed by, so the two
 * wordings cannot disagree.
 *
 * `attachmentFailureLine` puts the file's own name in front. The separator lives in the pattern rather than in a
 * concatenation here, because which punctuation joins a name to a sentence is a decision each language makes —
 * and the concatenation is also what broke the walker's whole-string lookup for these messages.
 */
export type AttachmentFailure = 'count' | 'vision' | 'imageBytes' | 'imageRead' | 'documentBytes';
const KEYS: Record<AttachmentFailure, string> = {
  count: 'attach.rendererCount',
  vision: 'attach.visionModelRequired',
  imageBytes: 'attach.rendererImageBytes',
  imageRead: 'attach.rendererImageRead',
  documentBytes: 'attach.rendererDocumentBytes',
};
export function attachmentFailureText(kind: AttachmentFailure): string {
  return t(KEYS[kind]);
}
export function attachmentFailureLine(name: string, message: string): string {
  return format(t('attach.rendererFailure'), { name, message });
}
