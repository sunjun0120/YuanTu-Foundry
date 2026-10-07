import { runSpreadsheetOperation } from './spreadsheet.ts';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export type OfficeFormat = 'docx' | 'xlsx' | 'pptx';
export type OfficeOperation =
  | {
      operation: 'create';
      format: OfficeFormat;
      outputPath: string;
      title?: string;
      paragraphs?: string[];
      sheets?: { name: string; rows: (string | number | boolean | null)[][] }[];
      slides?: { title: string; body: string[] }[];
    }
  | {
      operation: 'edit';
      format: OfficeFormat;
      sourcePath: string;
      outputPath: string;
      replacements?: { from: string; to: string }[];
      cells?: { sheet: string; cell: string; value: string | number | boolean | null }[];
    }
  | {
      operation: 'preview';
      format: OfficeFormat;
      sourcePath: string;
      outputPath: string;
    };

/**
 * Raised when the local Microsoft Office COM automation is unavailable, so
 * callers can tell "this machine cannot do Word/PowerPoint" apart from a
 * genuine failure of an operation that should have worked.
 */
export class OfficeUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OfficeUnavailableError';
  }
}

/**
 * Windows reports a missing COM registration as HRESULT 0x80040154. The text
 * around it is localized — a Chinese Windows says "没有注册类" — so only the
 * language-neutral HRESULT and its symbolic name are matched.
 */
export function isOfficeUnavailable(stderr: string): boolean {
  return /80040154|REGDB_E_CLASSNOTREG/i.test(stderr);
}

export async function runOfficeAutomation(
  operation: OfficeOperation,
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted();
  if (operation.format === 'xlsx') {
    await runSpreadsheetOperation(operation as OfficeOperation & { format: 'xlsx' });
    return;
  }
  await runOfficePowerShell(operation, signal);
}
async function runOfficePowerShell(
  operation: OfficeOperation,
  signal?: AbortSignal,
): Promise<void> {
  if (process.platform !== 'win32')
    throw new OfficeUnavailableError(
      'Word and PowerPoint automation needs Microsoft Office on Windows. ' +
        'office_inspect reads DOCX, XLSX and PPTX anywhere, and the Excel tools work without Office.',
    );
  const script = path.join(
    typeof __dirname === 'string' ? __dirname : path.dirname(fileURLToPath(import.meta.url)),
    'automation.ps1',
  );
  if (!existsSync(script))
    throw new Error('Office automation script is missing from the runtime build');
  signal?.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', script], {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    };
    const abort = () => {
      child.kill();
      fail(new Error('Office operation cancelled'));
    };
    const timer = setTimeout(() => {
      child.kill();
      fail(new Error('Office operation timed out after 120 seconds; last stage: ' + stderr.trim()));
    }, 120_000);
    signal?.addEventListener('abort', abort, { once: true });
    child.stdout.on('data', (chunk: Buffer) => {
      stdout = (stdout + chunk.toString('utf8')).slice(-4096);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString('utf8')).slice(-4096);
    });
    child.once('error', (error: NodeJS.ErrnoException) => {
      // A missing or blocked powershell.exe is an environment limit, not a bug
      // in the requested operation, so report it the same way as a missing Office.
      if (error.code === 'ENOENT')
        fail(
          new OfficeUnavailableError(
            'Windows PowerShell could not be started, so Word and PowerPoint automation is unavailable. ' +
              'office_inspect still reads DOCX, XLSX and PPTX, and the Excel tools work without Office. Original error: ' +
              error.message,
          ),
        );
      else fail(error);
    });
    child.once('close', (code) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (code === 0 && stdout.includes('"ok":true')) {
        resolve();
        return;
      }
      const detail = stderr.trim() || stdout.trim() || String(code);
      if (isOfficeUnavailable(stderr)) {
        reject(
          new OfficeUnavailableError(
            `Microsoft Office is not installed on this machine, so ${operation.format} ${operation.operation} cannot run. ` +
              'office_inspect still reads DOCX, XLSX and PPTX, and office_create/office_edit/office_preview still handle XLSX, because those paths do not use Office. ' +
              'Install Microsoft Office to create or convert Word and PowerPoint files. Original error: ' +
              detail,
          ),
        );
        return;
      }
      reject(new Error('Office operation failed: ' + detail));
    });
    child.stdin.on('error', (error) => fail(error));
    child.stdin.end(JSON.stringify(operation));
  });
}
