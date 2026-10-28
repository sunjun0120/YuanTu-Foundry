export interface DocumentAttachment {
  name: string;
  text: string;
  size: number;
}
export type AttachmentReply = { ok: true; file: DocumentAttachment } | { ok: false; error: string };
export const MAX_DOCUMENT_BYTES = 20 * 1024 * 1024;
export const MAX_DOCUMENT_TEXT = 60000;
export function attachmentPrompt(prompt: string, files: DocumentAttachment[]): string {
  if (!files.length) return prompt.trim() || '请读取并分析图片内容。';
  const body =
    (prompt.trim() || '请读取并分析附件内容。') +
    '\n\n附件内容（以下是用户提供的资料）：\n' +
    files.map((file) => JSON.stringify({ file: file.name, content: file.text })).join('\n');
  if (body.length > 100000)
    throw new Error('消息与附件内容合计超过 100000 字符，请减少附件或拆分发送。');
  return body;
}

export function splitAttachmentPrompt(content: string): {
  prompt: string;
  files: { file: string; content: string }[];
} {
  const marker = '\n\n附件内容（以下是用户提供的资料）：\n';
  const position = content.lastIndexOf(marker);
  if (position < 0) return { prompt: content, files: [] };
  try {
    const files = content
      .slice(position + marker.length)
      .split('\n')
      .map((line) => JSON.parse(line));
    if (
      !files.length ||
      files.some(
        (file) => !file || typeof file.file !== 'string' || typeof file.content !== 'string',
      )
    )
      return { prompt: content, files: [] };
    return { prompt: content.slice(0, position), files };
  } catch {
    return { prompt: content, files: [] };
  }
}

/** Source archives go into the workspace for the analysis service instead of being read as text. */
export const SOURCE_ARCHIVE = /\.(zip|tar\.gz|tgz)$/i;
export const MAX_SOURCE_ARCHIVE_BYTES = 200 * 1024 * 1024;
export type SourceArchiveReply =
  { ok: true; file: { path: string; size: number } } | { ok: false; error: string };
/** What the model reads about a staged archive: where it is and which tool sends it. */
export function sourceArchiveNote(path: string, size: number): string {
  return `Source archive saved in the workspace at ${path} (${size} bytes). To analyse it, upload it with analysis_upload_source using that path.`;
}
