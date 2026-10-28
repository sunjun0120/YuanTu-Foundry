// packages/builtin-services/report.ts
/**
 * `analysis_download_report`: saves a report or SBOM the service linked into the workspace.
 *
 * Only a link on the service's own origin is fetched, only document and SBOM types are kept, the file name has to
 * agree with the type, and an existing file is never replaced. The write goes through the file journal like any
 * other new file, so the change list shows it and undo can remove it.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import type { FileChange, PreparedTool, Tool, ToolContext } from '../protocol/index.ts';
import { Workspace } from '../tools/files.ts';
import { PathLease } from './path-lease.ts';
import type { ServiceRequester } from './service-request.ts';

const PROJECT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const TYPES: Record<string, string> = {
  'application/pdf': '.pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
  'text/html': '.html',
  'application/json': '.json',
  'application/vnd.cyclonedx+json': '.json',
  'application/spdx+json': '.json',
  'application/xml': '.xml',
  'text/xml': '.xml',
  'application/vnd.cyclonedx+xml': '.xml',
};

function fileName(url: URL): string {
  let base = path.posix.basename(url.pathname);
  try {
    base = decodeURIComponent(base);
  } catch {
    // An undecodable name is sanitised as it is.
  }
  const safe = base
    .replace(/[^A-Za-z0-9._-]/g, '_')
    .replace(/^\.+/, '')
    .slice(0, 100);
  return safe || 'report';
}

async function readCapped(response: Response, max: number): Promise<Buffer> {
  const tooLarge = () => new Error(`Report is larger than ${Math.floor(max / 1048576)} MB`);
  if (Number(response.headers.get('content-length') ?? '0') > max) throw tooLarge();
  const reader = response.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > max) {
      await reader.cancel();
      throw tooLarge();
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

export function downloadReportTool(deps: { root: string; requester: ServiceRequester }): Tool {
  const prepare = async (args: Record<string, unknown>): Promise<PreparedTool> => {
    const raw = String(args.url);
    if (!deps.requester.sameOrigin(raw))
      throw new Error('Only reports on the built-in analysis service address can be downloaded');
    const projectId = String(args.project_id);
    if (!PROJECT_ID.test(projectId) || projectId.includes('..'))
      throw new Error('Invalid project_id');
    const name = fileName(new URL(raw));
    const relative = `analysis-reports/${projectId}/${name}`;
    const change: FileChange = {
      path: relative,
      kind: 'create',
      patch: `+ report downloaded from ${deps.requester.manifest.baseUrl}`,
      added: 1,
      removed: 0,
      truncated: false,
    };
    return {
      change,
      approvalDescription: `Downloads ${raw} into ${relative}`,
      async execute(ctx: ToolContext) {
        const response = await deps.requester.fetch(raw, { signal: ctx.signal });
        if (!response.ok)
          return { isError: true, content: `Report download failed with HTTP ${response.status}` };
        const type = (response.headers.get('content-type') ?? '')
          .split(';')[0]!
          .trim()
          .toLowerCase();
        const extension = TYPES[type];
        if (!extension)
          return { isError: true, content: `Report type ${type || 'unknown'} is not accepted` };
        if (!name.toLowerCase().endsWith(extension))
          return {
            isError: true,
            content: `Report type ${type} does not match the file name ${name}`,
          };
        let bytes: Buffer;
        try {
          bytes = await readCapped(response, deps.requester.manifest.maxReportBytes);
        } catch (error) {
          return { isError: true, content: error instanceof Error ? error.message : String(error) };
        }
        const lease = await PathLease.open(ctx.signal);
        try {
          await lease.lockDirectory(deps.root);
          let directory = path.resolve(deps.root);
          for (const part of ['analysis-reports', projectId]) {
            directory = path.join(directory, part);
            await lease.mkdir(directory);
            await lease.lockDirectory(directory);
          }
          const absolute = await new Workspace(deps.root).resolve(relative, true);
          // Refused before the journal hears of it; the exclusive write below still guards a race.
          if (existsSync(absolute))
            return {
              isError: true,
              content: `${relative} already exists; rename or delete it first`,
            };
          ctx.signal.throwIfAborted();
          const journalId = ctx.fileJournal?.prepare(change, null, bytes);
          try {
            await lease.createFile(absolute, bytes);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'EEXIST')
              return {
                isError: true,
                content: `${relative} already exists; rename or delete it first`,
              };
            throw error;
          }
          if (journalId) ctx.fileJournal!.applied(journalId);
          return {
            isError: false,
            change: { ...change, ...(journalId ? { id: journalId } : {}) },
            content: JSON.stringify({ path: relative, bytes: bytes.length, type }),
          };
        } finally {
          await lease.close();
        }
      },
    };
  };
  return {
    name: 'analysis_download_report',
    description:
      "Save a report or SBOM file that the built-in analysis service linked in a result into analysis-reports/<project_id>/ in the workspace, then hand it over with present. Only links on the service's own address are accepted.",
    permission: 'write',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', minLength: 1, maxLength: 2048 },
        project_id: { type: 'string', minLength: 1, maxLength: 128 },
      },
      required: ['url', 'project_id'],
      additionalProperties: false,
    },
    prepare: (args) => prepare(args),
    async execute(args, ctx) {
      return (await prepare(args)).execute(ctx);
    },
  };
}
