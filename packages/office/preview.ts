import { spawn } from 'node:child_process';
import { link, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { killTree } from '../tools/process.ts';
import type { OfficeFormat } from './automation.ts';

export interface OfficePreview {
  render(
    input: { format: OfficeFormat; sourcePath: string; outputPath: string },
    signal?: AbortSignal,
  ): Promise<void>;
}

const maximum = 20_000_000;
type Job = { start(): Promise<void> };

/** Trusted deployment configuration, never model-supplied command arguments. */
export function createLibreOfficePreview(
  options: { executable?: string; prefixArgs?: string[]; timeoutMs?: number } = {},
): OfficePreview {
  const executable =
    options.executable ??
    process.env.YUANTU_LIBREOFFICE_PATH ??
    (process.platform === 'win32' ? 'soffice.com' : 'soffice');
  const timeoutMs = options.timeoutMs ?? 120_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new Error('Invalid preview timeout');
  let active = false;
  const queue: Job[] = [];
  const drain = () => {
    if (active) return;
    const job = queue.shift();
    if (!job) return;
    active = true;
    void job.start().finally(() => {
      active = false;
      drain();
    });
  };
  return {
    render(input, signal) {
      signal?.throwIfAborted();
      if (queue.length >= 4) return Promise.reject(new Error('Office preview queue is full'));
      return new Promise<void>((resolve, reject) => {
        const controller = new AbortController();
        const abort = () =>
          controller.abort(signal?.reason ?? new Error('Office preview cancelled'));
        const timer = setTimeout(
          () => controller.abort(new Error('Office preview timed out')),
          timeoutMs,
        );
        let started = false;
        const cleanup = () => {
          clearTimeout(timer);
          signal?.removeEventListener('abort', abort);
          controller.signal.removeEventListener('abort', queuedAbort);
        };
        const queuedAbort = () => {
          if (started) return;
          const index = queue.indexOf(job);
          if (index >= 0) queue.splice(index, 1);
          cleanup();
          reject(controller.signal.reason);
        };
        const job: Job = {
          async start() {
            started = true;
            try {
              await convert(executable, options.prefixArgs ?? [], input, controller.signal);
              resolve();
            } catch (error) {
              reject(error);
            } finally {
              cleanup();
            }
          },
        };
        signal?.addEventListener('abort', abort, { once: true });
        controller.signal.addEventListener('abort', queuedAbort, { once: true });
        queue.push(job);
        if (signal?.aborted) abort();
        drain();
      });
    },
  };
}

async function convert(
  executable: string,
  prefixArgs: string[],
  input: { format: OfficeFormat; sourcePath: string; outputPath: string },
  signal: AbortSignal,
): Promise<void> {
  signal.throwIfAborted();
  if (!['docx', 'xlsx', 'pptx'].includes(input.format))
    throw new Error('Unsupported preview format');
  const sourceStat = await stat(input.sourcePath);
  if (!sourceStat.isFile() || sourceStat.size < 1 || sourceStat.size > maximum)
    throw new Error('Office source must be 1 byte to 20 MB');
  const bytes = await readFile(input.sourcePath);
  if (!bytes.length || bytes.length > maximum)
    throw new Error('Office source must be 1 byte to 20 MB');
  const temp = await mkdtemp(path.join(path.dirname(input.outputPath), '.yuantu-preview-'));
  try {
    const profile = path.join(temp, 'profile');
    const output = path.join(temp, 'output');
    await mkdir(profile);
    await mkdir(output);
    // Fresh profiles do not inherit deployment/user macros or an existing GUI process.
    await writeFile(
      path.join(profile, 'registrymodifications.xcu'),
      '<?xml version="1.0"?><oor:items xmlns:oor="http://openoffice.org/2001/registry"><item oor:path="/org.openoffice.Office.Common/Security/Scripting"><prop oor:name="MacroSecurityLevel" oor:op="fuse"><value>3</value></prop></item></oor:items>',
    );
    const source = path.join(temp, `source.${input.format}`);
    await writeFile(source, bytes);
    signal.throwIfAborted();
    const pdf = path.join(output, 'source.pdf');
    await runConverter(
      executable,
      [
        ...prefixArgs,
        `-env:UserInstallation=${pathToFileURL(profile).href}`,
        '--headless',
        '--nologo',
        '--nodefault',
        '--norestore',
        '--convert-to',
        'pdf',
        '--outdir',
        output,
        source,
      ],
      pdf,
      signal,
    );
    signal.throwIfAborted();
    const size = await stat(pdf).catch(() => {
      throw new Error('Office converter produced no PDF');
    });
    if (!size.isFile() || size.size < 1 || size.size > maximum)
      throw new Error('Office PDF must be 1 byte to 20 MB');
    const result = await readFile(pdf);
    if (
      !result.subarray(0, 8).toString('ascii').startsWith('%PDF-') ||
      !result.subarray(-1024).includes('%%EOF')
    )
      throw new Error('Office converter produced an invalid PDF');
    signal.throwIfAborted();
    await link(pdf, input.outputPath);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

async function runConverter(
  executable: string,
  args: string[],
  pdf: string,
  signal: AbortSignal,
): Promise<void> {
  signal.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const child = spawn(executable, args, {
      windowsHide: true,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let detail = '';
    let failure: unknown;
    let closed = false;
    let termination: Promise<void> | undefined;
    const stop = (reason: unknown) => {
      failure ??= reason;
      if (closed || termination || !child.pid) return;
      termination = killTree(child.pid).catch((error) => {
        failure = new Error(`Office preview cleanup failed: ${String(error)}`);
        child.kill();
      });
    };
    const abort = () => stop(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    const monitor = setInterval(() => {
      void stat(pdf)
        .then((info) => {
          if (info.size > maximum) stop(new Error('Office PDF exceeds 20 MB'));
        })
        .catch(() => {});
    }, 100);
    child.stderr.on('data', (chunk: Buffer) => {
      detail = (detail + chunk.toString('utf8')).slice(-4096);
    });
    child.once('error', (error: NodeJS.ErrnoException) => {
      failure =
        error.code === 'ENOENT'
          ? new Error('LibreOffice is unavailable; install it or configure YUANTU_LIBREOFFICE_PATH')
          : error;
    });
    child.once('close', (code) => {
      closed = true;
      clearInterval(monitor);
      signal.removeEventListener('abort', abort);
      void (async () => {
        await termination;
        if (failure) reject(failure);
        else if (code !== 0)
          reject(new Error(`Office preview conversion failed (${code}): ${detail}`));
        else resolve();
      })();
    });
  });
}

export const libreOfficePreview = createLibreOfficePreview();
