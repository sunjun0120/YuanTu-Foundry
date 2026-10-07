import { resolveSandboxConfig } from './sandbox.ts';
import { commandTool } from './command.ts';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { open, lstat, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import type { Tool, ToolContext, ToolResult } from '../protocol/index.ts';
import { bounded, MAX_TOOL_OUTPUT } from './registry.ts';
import { killTree } from './process.ts';
import { toolEnvironment } from './environment.ts';

interface Validation {
  id: string;
  label: string;
  command: string;
  args: string[];
  cwd: string;
  detail?: string;
  supportsFiles?: boolean;
  targeted?: boolean;
}
const MAX_MANIFEST_BYTES = 256_000;
const TIMEOUT_MS = 300_000;
// The repository's quiet wrapper still runs node:test; targeted execution below
// uses the validated file list directly and retains TAP evidence and approval.
const NODE_TEST_SCRIPT =
  /^node(?:\.exe)?\s+(?:--test(?:\s|$)|(?:\.\/)?scripts\/run-tests\.mjs(?:\s|$))/;

async function readManifest(file: string): Promise<string | undefined> {
  try {
    if ((await lstat(file)).isSymbolicLink()) return undefined;
    const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const value = await handle.stat();
      if (!value.isFile() || value.size > MAX_MANIFEST_BYTES) return undefined;
      return await handle.readFile('utf8');
    } finally {
      await handle.close();
    }
  } catch {
    return undefined;
  }
}
async function parseJson(file: string): Promise<Record<string, unknown> | undefined> {
  try {
    const text = await readManifest(file);
    if (text === undefined) return undefined;
    const value: unknown = JSON.parse(text);
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}
async function discover(root: string): Promise<Validation[]> {
  const cwd = await realpath(root);
  const found: Validation[] = [];
  const pkg = await parseJson(path.join(cwd, 'package.json'));
  const scripts = pkg?.scripts;
  if (scripts && typeof scripts === 'object' && !Array.isArray(scripts)) {
    for (const name of ['test', 'typecheck', 'check', 'lint', 'build'])
      if (typeof (scripts as Record<string, unknown>)[name] === 'string')
        found.push(
          process.platform === 'win32' && resolveSandboxConfig().mode === 'host'
            ? {
                id: `npm:${name}`,
                label: `package.json script ${name}`,
                command: process.env.ComSpec ?? 'cmd.exe',
                args: ['/d', '/s', '/c', `npm run ${name}`],
                cwd,
                detail: String((scripts as Record<string, unknown>)[name]),
                ...(name === 'test' &&
                NODE_TEST_SCRIPT.test(String((scripts as Record<string, unknown>)[name]))
                  ? { supportsFiles: true }
                  : {}),
              }
            : {
                id: `npm:${name}`,
                label: `package.json script ${name}`,
                command: 'npm',
                args: ['run', name],
                cwd,
                detail: String((scripts as Record<string, unknown>)[name]),
                ...(name === 'test' &&
                NODE_TEST_SCRIPT.test(String((scripts as Record<string, unknown>)[name]))
                  ? { supportsFiles: true }
                  : {}),
              },
        );
  }
  if ((await readManifest(path.join(cwd, 'Cargo.toml'))) !== undefined)
    found.push({ id: 'cargo:test', label: 'Cargo tests', command: 'cargo', args: ['test'], cwd });
  if ((await readManifest(path.join(cwd, 'go.mod'))) !== undefined)
    found.push({ id: 'go:test', label: 'Go tests', command: 'go', args: ['test', './...'], cwd });
  const pyproject = path.join(cwd, 'pyproject.toml');
  const pyprojectText = await readManifest(pyproject);
  if (pyprojectText !== undefined) {
    if (/\[(?:tool\.pytest|pytest)\.|pytest\b|\bpytest\b/m.test(pyprojectText))
      found.push({
        id: 'python:pytest',
        label: 'Python pytest suite',
        command:
          process.platform === 'win32' && resolveSandboxConfig().mode === 'host'
            ? 'py.exe'
            : 'python3',
        args:
          process.platform === 'win32' && resolveSandboxConfig().mode === 'host'
            ? ['-m', 'pytest']
            : ['-m', 'pytest'],
        cwd,
      });
  }
  return found;
}
const TEST_FILE = /(?:^|\/)[^/]+\.(?:test|spec)\.(?:[cm]?[jt]s)$/i;
const EXCLUDED = new Set(['.git', '.yuantu', 'node_modules', 'dist', 'artifacts']);
function inside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return (
    relative === '' ||
    (relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative))
  );
}
async function testFile(root: string, value: unknown): Promise<string> {
  if (typeof value !== 'string' || !value || value.includes('\0') || path.isAbsolute(value))
    throw new Error('Test file must be a workspace-relative path');
  const normalized = value.replace(/\\/g, '/');
  const parts = normalized.split('/');
  if (
    parts.some(
      (part) => !part || part === '.' || part === '..' || part.includes(':') || EXCLUDED.has(part),
    ) ||
    !TEST_FILE.test(normalized)
  )
    throw new Error('Invalid test file path');
  const file = path.join(root, ...parts);
  const resolved = await realpath(file);
  const info = await lstat(file);
  if (!inside(root, resolved) || !info.isFile() || info.isSymbolicLink())
    throw new Error('Test file must be a regular file inside the workspace');
  return normalized;
}
function exactTestPattern(names: unknown): string {
  if (
    !Array.isArray(names) ||
    names.length < 1 ||
    names.length > 20 ||
    names.some(
      (name) =>
        typeof name !== 'string' || !name.trim() || name.length > 200 || /[\r\n\0]/.test(name),
    )
  )
    throw new Error('failed_test_names must contain 1-20 exact test names');
  const escaped = names.map((name: string) => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return `^(?:${escaped.join('|')})$`;
}
async function selectedValidation(
  root: string,
  args: Record<string, unknown>,
): Promise<Validation> {
  const validation = (await discover(root)).find((item) => item.id === String(args.id));
  if (!validation)
    throw new Error('Unknown or no longer available validation id; run discover_validations again');
  const files = args.files;
  const names = args.failed_test_names;
  if (files === undefined && names === undefined) return validation;
  if (validation.id !== 'npm:test' || !validation.supportsFiles)
    throw new Error('Targeted tests require a package.json test script using node --test');
  if (!Array.isArray(files) || files.length < 1 || files.length > 20)
    throw new Error('files must contain 1-20 test files');
  if (names !== undefined && files.length !== 1)
    throw new Error('Failed-case rerun requires exactly one test file');
  const rootPath = await realpath(root);
  const selected = await Promise.all(files.map((file) => testFile(rootPath, file)));
  if (selected.join('').length > 8000) throw new Error('Selected test paths are too long');
  const pattern = names === undefined ? undefined : exactTestPattern(names);
  return {
    ...validation,
    command: resolveSandboxConfig().mode === 'host' ? process.execPath : 'node',
    args: [
      '--test',
      '--test-reporter=tap',
      '--test-concurrency=1',
      ...(pattern ? [`--test-name-pattern=${pattern}`] : []),
      ...selected,
    ],
    targeted: true,
  };
}
function tapEvidence(output: string): { failedTests: string[]; counts: Record<string, number> } {
  const failedTests = [...output.matchAll(/^\s*not ok \d+ - (.+)$/gm)]
    .map((match) => match[1]!.replace(/ #.*$/, '').trim())
    .filter(Boolean)
    .slice(0, 20);
  const counts: Record<string, number> = {};
  for (const key of ['tests', 'pass', 'fail', 'skipped']) {
    const match = output.match(new RegExp(`^# ${key} (\\d+)$`, 'm'));
    if (match) counts[key] = Number(match[1]);
  }
  return { failedTests, counts };
}

function validationContent(evidence: Record<string, unknown> & { output: string }): string {
  const limit = MAX_TOOL_OUTPUT - 100;
  const whole = JSON.stringify(evidence);
  if (whole.length <= limit) return whole;
  // Keep the JSON valid even when escaping the command or output expands its size. The registry
  // imposes a second 24K character limit, so reserve room before it sees this result.
  let low = 0;
  let high = evidence.output.length;
  let fitting = '';
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const candidate = JSON.stringify({
      ...evidence,
      output: evidence.output.slice(0, middle) + '\n[output truncated]',
      outputTruncated: true,
    });
    if (candidate.length <= limit) {
      fitting = candidate;
      low = middle + 1;
    } else high = middle - 1;
  }
  if (!fitting) throw new Error('Validation metadata exceeds tool output limit');
  return fitting;
}
function display(validation: Validation): string {
  return [validation.command, ...validation.args]
    .map((part) => (/[\s"]/u.test(part) ? JSON.stringify(part) : part))
    .join(' ');
}
function cleanEnvironment(): NodeJS.ProcessEnv {
  return toolEnvironment();
}
async function execute(validation: Validation, ctx: ToolContext): Promise<ToolResult> {
  if (resolveSandboxConfig().mode !== 'host') {
    const quote = (value: string) => "'" + value.replaceAll("'", "'\"'\"'") + "'";
    const windows = resolveSandboxConfig().mode === 'windows';
    // npm is a .cmd shim, so fixed script invocations need cmd's resolution. Other Windows
    // validations use native argv, preserving literal test names without shell interpolation.
    const npm = windows && validation.command === 'npm';
    if (npm && !validation.args.every((argument) => /^[a-z0-9_-]+$/i.test(argument)))
      throw new Error('Unsafe npm validation arguments');
    const result = await commandTool(
      validation.cwd,
      windows && !npm ? { command: validation.command, argv: validation.args } : undefined,
    ).execute(
      {
        command: windows
          ? display(validation)
          : [validation.command, ...validation.args].map(quote).join(' '),
        timeout_ms: TIMEOUT_MS,
      },
      ctx,
    );
    if (!validation.targeted) return result;
    const executed = JSON.parse(result.content) as {
      exitCode: number | null;
      signal: string | null;
      timedOut: boolean;
      output: string;
    };
    return {
      isError: result.isError,
      content: validationContent({
        command: bounded(display(validation), 4000),
        exitCode: executed.exitCode,
        signal: executed.signal,
        timedOut: executed.timedOut,
        output: executed.output,
        outputTruncated: executed.output.endsWith('\n[output truncated]'),
        ...tapEvidence(executed.output),
      }),
    };
  }
  ctx.signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(validation.command, validation.args, {
      cwd: validation.cwd,
      env: cleanEnvironment(),
      shell: false,
      windowsHide: true,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '',
      outputTruncated = false,
      timedOut = false,
      settled = false,
      killing: Promise<void> | undefined;
    const collect = (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      const remaining = MAX_TOOL_OUTPUT * 2 - output.length;
      if (text.length > remaining) outputTruncated = true;
      if (remaining > 0) output += text.slice(0, remaining);
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    const stop = () => {
      if (child.pid && !killing)
        killing = killTree(child.pid).catch(() => {
          child.kill();
        });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, TIMEOUT_MS);
    const abort = () => stop();
    ctx.signal.addEventListener('abort', abort, { once: true });
    const cleanup = () => {
      clearTimeout(timer);
      ctx.signal.removeEventListener('abort', abort);
    };
    child.once('error', (error) => {
      if (!settled) {
        settled = true;
        cleanup();
        reject(error);
      }
    });
    child.once('close', (code, signal) => {
      if (settled) return;
      settled = true;
      cleanup();
      void (async () => {
        if (killing) await killing;
        if (ctx.signal.aborted) return reject(ctx.signal.reason);
        resolve({
          isError: timedOut || code !== 0,
          content: validationContent({
            command: bounded(display(validation), 4000),
            exitCode: code,
            signal,
            timedOut,
            output,
            outputTruncated,
            ...(validation.targeted ? tapEvidence(output) : {}),
          }),
        });
      })();
    });
  });
}

export function validationTools(root: string): Tool[] {
  return [
    {
      name: 'discover_validations',
      description:
        'Discover bounded validation commands from known workspace-root manifests only. Does not execute commands.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      async execute() {
        return { isError: false, content: JSON.stringify(await discover(root), null, 2) };
      },
    },
    {
      name: 'run_validation',
      permission: 'command',
      description:
        'Run a discovered validation with approval. For npm:test using node --test, files selects contained test files; failed_test_names reruns exact names from a previous targeted failure in one file. The full argv is shown before execution.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', minLength: 1, maxLength: 128 },
          files: {
            type: 'array',
            items: { type: 'string', minLength: 1, maxLength: 4096 },
            minItems: 1,
            maxItems: 20,
          },
          failed_test_names: {
            type: 'array',
            items: { type: 'string', minLength: 1, maxLength: 200 },
            minItems: 1,
            maxItems: 20,
          },
        },
        required: ['id'],
        additionalProperties: false,
      },
      async prepare(args) {
        const validation = await selectedValidation(root, args);
        return {
          approvalDescription: `Resolved command: ${display(validation)}\nWorking directory: ${validation.cwd}${validation.detail ? `\nManifest command: ${validation.detail}` : ''}`,
          execute: async (ctx) => execute(await selectedValidation(root, args), ctx),
        };
      },
      async execute(args, ctx) {
        return execute(await selectedValidation(root, args), ctx);
      },
    },
  ];
}
