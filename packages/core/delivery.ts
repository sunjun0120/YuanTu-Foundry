import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import path from 'node:path';
import { Workspace } from '../tools/files.ts';

export const deliveryFormats = [
  'auto',
  'binary',
  'text',
  'pdf',
  'docx',
  'xlsx',
  'pptx',
  'xls',
  'png',
  'jpeg',
  'zip',
] as const;
export type DeliveryFormat = (typeof deliveryFormats)[number];
export interface FileDeliverySpec {
  path: string;
  format?: DeliveryFormat;
  minBytes?: number;
  sha256?: string;
}
export interface FileDeliveryEvidence {
  path: string;
  bytes: number;
  sha256: string;
  format: Exclude<DeliveryFormat, 'auto'>;
  validation: string;
}

function detectedFormat(file: string): Exclude<DeliveryFormat, 'auto'> {
  const ext = path.extname(file).toLowerCase();
  if (
    [
      '.txt',
      '.md',
      '.json',
      '.csv',
      '.ts',
      '.js',
      '.py',
      '.html',
      '.css',
      '.xml',
      '.yaml',
      '.yml',
    ].includes(ext)
  )
    return 'text';
  if (ext === '.jpg' || ext === '.jpeg') return 'jpeg';
  if (['.pdf', '.docx', '.xlsx', '.pptx', '.xls', '.png', '.zip'].includes(ext))
    return ext.slice(1) as Exclude<DeliveryFormat, 'auto'>;
  return 'binary';
}

export async function verifyFileDelivery(
  root: string,
  spec: FileDeliverySpec,
): Promise<FileDeliveryEvidence> {
  if (typeof spec.path !== 'string' || !spec.path.trim() || spec.path.length > 4096)
    throw new Error('Invalid delivery path');
  if (spec.format !== undefined && !deliveryFormats.includes(spec.format))
    throw new Error('Invalid delivery format');
  const minBytes = spec.minBytes ?? 1;
  if (!Number.isSafeInteger(minBytes) || minBytes < 1 || minBytes > 100_000_000)
    throw new Error('Invalid delivery minimum bytes');
  if (spec.sha256 !== undefined && !/^[a-f0-9]{64}$/i.test(spec.sha256))
    throw new Error('Invalid delivery SHA-256');
  const target = await new Workspace(root).resolve(spec.path);
  const handle = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error('Delivery path is not a regular file');
    if (stat.size < minBytes) throw new Error('Delivered file is missing or too small');
    if (stat.size > 100_000_000)
      throw new Error('Delivered file exceeds 100 MB verification limit');
    const hash = createHash('sha256');
    const format =
      spec.format === undefined || spec.format === 'auto' ? detectedFormat(spec.path) : spec.format;
    const decoder = format === 'text' ? new TextDecoder('utf-8', { fatal: true }) : undefined;
    const first = Buffer.alloc(Math.min(stat.size, 32));
    const tail = Buffer.alloc(Math.min(stat.size, 65557));
    const buffer = Buffer.alloc(65536);
    let offset = 0;
    let sawNul = false;
    while (offset < stat.size) {
      const { bytesRead } = await handle.read(
        buffer,
        0,
        Math.min(buffer.length, stat.size - offset),
        offset,
      );
      if (!bytesRead) throw new Error('Delivered file changed during verification');
      const chunk = buffer.subarray(0, bytesRead);
      hash.update(chunk);
      if (decoder) {
        if (chunk.includes(0)) sawNul = true;
        decoder.decode(chunk, { stream: true });
      }
      if (offset < first.length)
        chunk.copy(first, offset, 0, Math.min(bytesRead, first.length - offset));
      offset += bytesRead;
    }
    decoder?.decode();
    if (sawNul) throw new Error('Delivered text contains NUL bytes');
    if (offset !== stat.size || (await handle.stat()).size !== stat.size)
      throw new Error('Delivered file changed during verification');
    if (tail.length) {
      const { bytesRead } = await handle.read(tail, 0, tail.length, stat.size - tail.length);
      if (bytesRead !== tail.length) throw new Error('Delivered file changed during verification');
    }
    const starts = (magic: number[]) => first.subarray(0, magic.length).equals(Buffer.from(magic));
    const last = tail.toString('latin1');
    if (
      format === 'pdf' &&
      (!first.toString('latin1').startsWith('%PDF-') || !last.includes('%%EOF'))
    )
      throw new Error('Delivered PDF has an invalid header or EOF marker');
    if (
      format === 'png' &&
      (!starts([137, 80, 78, 71, 13, 10, 26, 10]) ||
        !tail.subarray(-8).equals(Buffer.from([73, 69, 78, 68, 174, 66, 96, 130])))
    )
      throw new Error('Delivered PNG has an invalid signature or ending');
    if (
      format === 'jpeg' &&
      (!starts([255, 216, 255]) || !tail.subarray(-2).equals(Buffer.from([255, 217])))
    )
      throw new Error('Delivered JPEG has an invalid signature or ending');
    if (
      ['zip', 'docx', 'xlsx', 'pptx'].includes(format) &&
      (!starts([80, 75, 3, 4]) || !last.includes('PK\x05\x06'))
    )
      throw new Error('Delivered ZIP document has an invalid archive structure');
    if (format === 'docx' && !last.includes('word/document.xml'))
      throw new Error('Delivered DOCX is missing word/document.xml');
    if (format === 'xlsx' && !last.includes('xl/workbook.xml'))
      throw new Error('Delivered XLSX is missing xl/workbook.xml');
    if (format === 'pptx' && !last.includes('ppt/presentation.xml'))
      throw new Error('Delivered PPTX is missing ppt/presentation.xml');
    if (format === 'xls' && !starts([208, 207, 17, 224, 161, 177, 26, 225]))
      throw new Error('Delivered XLS has an invalid compound-file signature');
    const digest = hash.digest('hex');
    if (spec.sha256 && digest.toLowerCase() !== spec.sha256.toLowerCase())
      throw new Error('Delivered file SHA-256 does not match');
    return {
      path: path.relative(new Workspace(root).root, target).split(path.sep).join('/'),
      bytes: stat.size,
      sha256: digest,
      format,
      validation:
        format === 'binary'
          ? 'regular file, nonempty, bounded size and SHA-256 verified'
          : 'regular file, nonempty, bounded size, SHA-256 and basic format structure verified',
    };
  } finally {
    await handle.close();
  }
}
