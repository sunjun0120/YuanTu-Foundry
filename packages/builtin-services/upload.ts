// packages/builtin-services/upload.ts
/**
 * `analysis_upload_source`: the one place code leaves this machine.
 *
 * An archive is sent as it is. A directory is zipped first, leaving out version control, dependency folders, the
 * internal `.yuantu` directory and every credential file name the file tools protect; the approval says how many
 * files and bytes go out and how many were left behind.
 */
import { lstat, readdir } from 'node:fs/promises';
import path from 'node:path';
import JSZip from 'jszip';
import { createHash } from 'node:crypto';
import { PathLease } from './path-lease.ts';
import type { PreparedTool, Tool, ToolContext, ToolResult } from '../protocol/index.ts';
import { isCredentialFileName } from '../platform/credential-paths.ts';
import { Workspace } from '../tools/files.ts';
import type { ServiceRequester } from './service-request.ts';

const ARCHIVE = /\.(zip|tar\.gz|tgz)$/i;
const PROJECT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SKIPPED_DIRECTORIES = new Set([
  '.git',
  '.hg',
  '.svn',
  'node_modules',
  '.yuantu',
  'analysis-inputs',
  'analysis-reports',
  '.venv',
  '__pycache__',
]);
const MAX_FILES = 100_000;

export interface PackPlan {
  files: {
    relative: string;
    absolute: string;
    size: number;
    digest: string;
    dev: number;
    ino: number;
  }[];
  bytes: number;
  skipped: number;
}

const excluded = (name: string): boolean => isCredentialFileName(name) || /^\.env/i.test(name);

export async function planDirectory(
  dir: string,
  maxBytes: number,
  signal: AbortSignal,
): Promise<PackPlan> {
  const lease = await PathLease.open(signal);
  const plan: PackPlan = { files: [], bytes: 0, skipped: 0 };
  const walk = async (current: string): Promise<void> => {
    signal.throwIfAborted();
    await lease.lockDirectory(current);
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const absolute = path.join(current, entry.name);
      if (entry.isSymbolicLink()) {
        plan.skipped++;
      } else if (entry.isDirectory()) {
        if (SKIPPED_DIRECTORIES.has(entry.name)) plan.skipped++;
        else await walk(absolute);
      } else if (entry.isFile()) {
        if (excluded(entry.name)) {
          plan.skipped++;
          continue;
        }
        await lease.lockFile(absolute);
        const { size, dev, ino } = await lstat(absolute);
        plan.bytes += size;
        if (plan.bytes > maxBytes)
          throw new Error(
            `Directory is larger than the ${Math.floor(maxBytes / 1048576)} MB upload limit`,
          );
        const digest = createHash('sha256')
          .update(await lease.readFile(absolute))
          .digest('hex');
        plan.files.push({
          relative: path.relative(dir, absolute),
          absolute,
          size,
          digest,
          dev,
          ino,
        });
        if (plan.files.length > MAX_FILES)
          throw new Error(`Directory has more than ${MAX_FILES} files`);
      }
    }
  };
  try {
    await walk(dir);
    return plan;
  } finally {
    await lease.close();
  }
}

async function packDirectory(
  plan: PackPlan,
  signal: AbortSignal,
  lease: PathLease,
): Promise<Buffer> {
  const zip = new JSZip();
  for (const file of plan.files) {
    signal.throwIfAborted();
    await lease.lockFile(file.absolute);
    const info = await lstat(file.absolute);
    if (!info.isFile() || info.size !== file.size || info.dev !== file.dev || info.ino !== file.ino)
      throw new Error('Source changed after approval');
    const bytes = await lease.readFile(file.absolute);
    if (createHash('sha256').update(bytes).digest('hex') !== file.digest)
      throw new Error('Source changed after approval');
    zip.file(file.relative.split(path.sep).join('/'), bytes);
  }
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

export function uploadSourceTool(deps: { root: string; requester: ServiceRequester }): Tool {
  const { manifest } = deps.requester;
  const limitMb = Math.floor(manifest.maxUploadBytes / 1048576);
  const send = async (blob: Blob, filename: string, ctx: ToolContext): Promise<ToolResult> => {
    const form = new FormData();
    form.append('file', blob, filename);
    const response = await deps.requester.fetch(deps.requester.url(manifest.uploadPath), {
      method: 'POST',
      body: form,
      signal: ctx.signal,
    });
    const text = await response.text();
    if (!response.ok) {
      process.stderr.write(
        `[builtin-services] upload failed: HTTP ${response.status} ${text.slice(0, 300)}\n`,
      );
      return { isError: true, content: `Upload failed with HTTP ${response.status}` };
    }
    let projectId: unknown;
    try {
      projectId = JSON.parse(text).project_id;
    } catch {
      projectId = undefined;
    }
    if (typeof projectId !== 'string' || !PROJECT_ID.test(projectId) || projectId.includes('..'))
      return { isError: true, content: 'The upload reply did not contain a valid project_id' };
    return {
      isError: false,
      content: JSON.stringify({ project_id: projectId, filename, bytes: blob.size }),
    };
  };
  const prepare = async (
    args: Record<string, unknown>,
    ctx: ToolContext,
  ): Promise<PreparedTool> => {
    const requested = String(args.path);
    const lease = await PathLease.open(ctx.signal);
    try {
      await lease.lockDirectory(deps.root);
      const absolute = await new Workspace(deps.root).resolve(requested);
      const info = await lstat(absolute);
      if (info.isFile()) {
        if (!ARCHIVE.test(absolute))
          throw new Error('Only .zip, .tar.gz and .tgz archives or directories can be uploaded');
        if (info.size > manifest.maxUploadBytes)
          throw new Error(`Archive is larger than the ${limitMb} MB upload limit`);
        await lease.lockFile(absolute);
        const digest = createHash('sha256')
          .update(await lease.readFile(absolute))
          .digest('hex');
        return {
          approvalDescription: `Uploads ${requested} (${info.size} bytes) to ${manifest.baseUrl}`,
          execute: async (run) => {
            const held = await PathLease.open(run.signal);
            try {
              await held.lockDirectory(deps.root);
              await held.lockFile(absolute);
              const now = await new Workspace(deps.root).resolve(requested);
              if (now !== absolute) throw new Error('Source changed after approval');
              const stat = await lstat(absolute);
              if (
                !stat.isFile() ||
                stat.size !== info.size ||
                stat.dev !== info.dev ||
                stat.ino !== info.ino ||
                stat.size > manifest.maxUploadBytes
              )
                throw new Error('Source changed after approval');
              const bytes = await held.readFile(absolute);
              if (createHash('sha256').update(bytes).digest('hex') !== digest)
                throw new Error('Source changed after approval');
              return await send(new Blob([new Uint8Array(bytes)]), path.basename(absolute), run);
            } finally {
              await held.close();
            }
          },
        };
      }
      if (!info.isDirectory())
        throw new Error('Only .zip, .tar.gz and .tgz archives or directories can be uploaded');
      await lease.lockDirectory(absolute);
      const plan = await planDirectory(absolute, manifest.maxUploadBytes, ctx.signal);
      const name = `${path.basename(absolute) || 'workspace'}.zip`;
      return {
        approvalDescription: `Zips ${plan.files.length} files (${plan.bytes} bytes) from ${requested} and uploads them to ${manifest.baseUrl}; ${plan.skipped} version-control, dependency, link or credential entries are left out`,
        execute: async (run) => {
          const held = await PathLease.open(run.signal);
          try {
            await held.lockDirectory(deps.root);
            await held.lockDirectory(absolute);
            const now = await new Workspace(deps.root).resolve(requested);
            if (now !== absolute) throw new Error('Source changed after approval');
            const zip = await packDirectory(plan, run.signal, held);
            if (zip.length > manifest.maxUploadBytes)
              return {
                isError: true,
                content: `Packed archive is larger than the ${limitMb} MB upload limit`,
              };
            return await send(new Blob([new Uint8Array(zip)]), name, run);
          } finally {
            await held.close();
          }
        },
      };
    } finally {
      await lease.close();
    }
  };
  return {
    name: 'analysis_upload_source',
    description:
      'Upload a source archive (.zip, .tar.gz, .tgz) or a directory inside the workspace to the built-in code analysis service, and get the project_id the analysis tools take. A directory is zipped first without version control, dependency folders, .yuantu or credential files. A GitHub repository needs no upload: give its URL to the service import tool instead.',
    permission: 'external',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string', minLength: 1, maxLength: 1024 } },
      required: ['path'],
      additionalProperties: false,
    },
    prepare,
    async execute(args, ctx) {
      return (await prepare(args, ctx)).execute(ctx);
    },
  };
}
