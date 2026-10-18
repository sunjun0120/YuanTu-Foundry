import { createDocx, type DocumentBlock } from './document.ts';
import { createPptx, type SlideSpec } from './presentation.ts';
import { replaceOfficeText } from './replace.ts';
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
      blocks?: DocumentBlock[];
      sheets?: { name: string; rows: (string | number | boolean | null)[][] }[];
      slides?: SlideSpec[];
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
 * Raised when the local Microsoft Office COM automation cannot run here, so callers can tell "this machine
 * cannot do Word/PowerPoint" apart from a genuine failure of an operation that should have worked.
 *
 * The environment refuses in three different ways — Office is not installed, PowerShell cannot be started, or
 * Windows will not load the automation script — and each message names its own cause, because the remedies have
 * nothing to do with each other: install Office, fix the PATH, or settle the script-authorization policy with
 * whoever owns the machine. Only Office PDF previews of Word and PowerPoint need this path; creating, editing,
 * inspecting and HTML previews do not.
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

/**
 * Windows can also refuse to load the script at all, before a single Office call is made: an execution policy
 * that will not run unsigned files, a file marked as having come from another machine, or a machine that cannot
 * authorize the script (`AuthorizationManager check failed`). That is a different fact about the environment
 * from "Office is not installed", and reporting one as the other sends the reader to the wrong remedy — the
 * first is a policy question for whoever owns the machine, the second is an installation.
 *
 * Match PowerShell's structured security error record, rather than keywords that may occur in replacement
 * text or another operation error. Captured from a
 * machine that refuses the script: `AuthorizationManager check failed.` / `FullyQualifiedErrorId :
 * UnauthorizedAccess`.
 */
export function isScriptAuthorizationFailure(stderr: string): boolean {
  // automation.ps1 reports operation errors with its script stack: reaching that stack proves it loaded.
  if (/(?:^|\|\s*)at <ScriptBlock>,/m.test(stderr)) return false;
  return (
    /^\s*\+\s*CategoryInfo\s*:\s*SecurityError:/im.test(stderr) &&
    /^\s*\+\s*FullyQualifiedErrorId\s*:\s*(?:UnauthorizedAccess|PSSecurityException|AuthorizationManagerCheckFailed)\s*$/im.test(
      stderr,
    )
  );
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
  // Creating and editing Word and PowerPoint is pure JavaScript; only PDF conversion still needs local Office.
  if (operation.operation === 'create') {
    await (operation.format === 'docx' ? createDocx(operation) : createPptx(operation));
    return;
  }
  if (operation.operation === 'edit') {
    await replaceOfficeText({ ...operation, format: operation.format });
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
      'Converting Word and PowerPoint files to PDF through Microsoft Office needs Office on Windows. ' +
        'Creating, editing, inspecting and HTML previews work without Office.',
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
            'Windows PowerShell could not be started, so PDF conversion through Microsoft Office is unavailable. ' +
              'Creating, editing, inspecting and HTML previews still work without Office. Original error: ' +
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
      /**
       * Checked before the COM branch: when Windows refuses to load the script, the script never ran, so any
       * COM text in the output would be incidental and must not be reported as the cause.
       */
      if (isScriptAuthorizationFailure(stderr)) {
        reject(
          new OfficeUnavailableError(
            `Windows refused to load the Office automation script, so ${operation.format} ${operation.operation} cannot run here. ` +
              'This is a script-authorization limit of this machine — an execution policy that will not run the file, a copy marked as untrusted, or a blocked script host — not a missing installation and not a failure of the requested operation. ' +
              'Creating, editing, inspecting and HTML previews still work, because none of those paths loads this script. Original error: ' +
              detail,
          ),
        );
        return;
      }
      if (isOfficeUnavailable(stderr)) {
        reject(
          new OfficeUnavailableError(
            `Microsoft Office is not installed on this machine, so ${operation.format} ${operation.operation} cannot run. ` +
              'Creating, editing, inspecting and HTML previews still work, because those paths do not use Office. ' +
              'Install Microsoft Office or LibreOffice to convert Word and PowerPoint files to PDF. Original error: ' +
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
