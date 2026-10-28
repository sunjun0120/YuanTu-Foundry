import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  quoteWindowsArgument,
  windowsProgramNeedsShell,
} from '../packages/sandbox/windows-command.ts';

test('the quoting rule is the one Windows de-parses', () => {
  // Not a style check: the launcher hands `CreateProcessAsUser` one string that the child parses back into
  // arguments, so every quote and backslash here is a chance to change what a command *means*. The vectors are
  // the documented rules — a quote is escaped as `\"`, and backslashes are doubled only when they precede one
  // or the closing quote. The end-to-end proof is the argv test above, which runs a real process.
  assert.equal(quoteWindowsArgument('plain'), 'plain');
  assert.equal(quoteWindowsArgument(''), '""');
  assert.equal(quoteWindowsArgument('a b'), '"a b"');
  assert.equal(quoteWindowsArgument('q"q'), '"q\\"q"');
  // Unquoted, a trailing backslash is literal; inside quotes it has to be doubled or it would escape the quote.
  assert.equal(quoteWindowsArgument('trail\\'), 'trail\\');
  assert.equal(quoteWindowsArgument('a b\\'), '"a b\\\\"');
  assert.equal(quoteWindowsArgument('a\\"b'), '"a\\\\\\"b"');
  assert.equal(quoteWindowsArgument('back\\\\slash'), 'back\\\\slash');
});

test('a program is routed through the shell exactly when CreateProcess cannot start it', async (t) => {
  const empty = await mkdtemp(path.join(os.tmpdir(), 'yuantu-shim-empty-'));
  const images = await mkdtemp(path.join(os.tmpdir(), 'yuantu-shim-images-'));
  t.after(async () => {
    await rm(empty, { recursive: true, force: true });
    await rm(images, { recursive: true, force: true });
  });
  const withPath = (directories: string): NodeJS.ProcessEnv => ({ Path: directories });
  // No image anywhere: `npm` resolves to npm.cmd, which only the shell can start.
  for (const program of ['npm', 'pnpm', 'yarn', 'tsc'])
    assert.equal(windowsProgramNeedsShell(program, withPath(empty)), true, program);
  // An explicit script extension is never an image.
  for (const program of ['npm.cmd', 'build.bat', 'tool.ps1'])
    assert.equal(windowsProgramNeedsShell(program, withPath(images)), true, program);
  // An existing image is started directly, with the exact argument boundary.
  await writeFile(path.join(images, 'tool.exe'), '');
  await writeFile(path.join(images, 'plain.com'), '');
  assert.equal(windowsProgramNeedsShell('tool', withPath(images)), false);
  assert.equal(windowsProgramNeedsShell('plain', withPath(images)), false);
  assert.equal(windowsProgramNeedsShell('tool.exe', withPath(empty)), false);
  // A PATH with several entries: one hit is enough, and an empty entry is skipped rather than searched as cwd.
  assert.equal(
    windowsProgramNeedsShell('tool', withPath([empty, images].join(path.delimiter))),
    false,
  );
  assert.equal(
    windowsProgramNeedsShell('missing', withPath([empty, images].join(path.delimiter))),
    true,
  );
});
