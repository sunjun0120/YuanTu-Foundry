#!/usr/bin/env node
/**
 * Bundles the Host into one file.
 *
 * Why: measured on this machine, `node dist/apps/agent-host/main.js --help` spends most of its ~1.0–1.6 s resolving
 * a module graph across `node_modules` (a CPU profile put ~74% in the loader); the same entry bundled starts in
 * ~0.5 s. The Host is started on every desktop launch, on every model-connection switch and after every crash, so
 * that difference is paid over and over.
 *
 * Where: the bundle is written beside the worker entry points tsc emits, `dist/packages/tools/`, and not under
 * `dist/apps/agent-host/`. The tools spawn their workers and read the Windows sandbox asset relative to
 * `import.meta.url`; for a bundle in that directory those paths are exactly the ones the unbundled modules use, so
 * replacing the module graph with one file changes no asset path. `apps/desktop/install-paths.ts` prefers this file
 * when the build produced one and keeps `dist/apps/agent-host/main.js` as the fallback a partial build leaves
 * usable.
 *
 * Externals are the things that must stay real files: native addons, Playwright (an optional, very large dependency
 * loaded only by the browser tool), and TypeScript (a compiler in its own right, not a library to inline).
 */
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { build } from 'esbuild';

const output = 'dist/packages/tools/host.bundle.js';

await mkdir(path.dirname(output), { recursive: true });
await build({
  entryPoints: ['apps/agent-host/main.ts'],
  outfile: output,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  // A CommonJS dependency inside an ESM bundle calls `require` (mammoth does, through its file reader), which the
  // ESM output does not provide. This is the shim esbuild's documentation prescribes for exactly that case.
  banner: {
    js:
      "import{createRequire as __yuantuCreateRequire}from'node:module';" +
      'const require=__yuantuCreateRequire(import.meta.url);',
  },
  external: ['@lydell/node-pty', '@napi-rs/keyring', 'playwright', 'playwright-core', 'typescript'],
  logLevel: 'warning',
});
const { size } = await stat(output);

/**
 * One real request, not only `--help`.
 *
 * `--help` proves the entry loads; `host.info` proves the process opens its store, serves the JSONL protocol and
 * answers. A bundle that got either wrong must fail this build rather than the first desktop launch.
 */
async function smoke() {
  const workspace = await mkdtemp(path.join(tmpdir(), 'yuantu-host-bundle-'));
  const child = spawn(process.execPath, [output, '--workspace', workspace], {
    cwd: process.cwd(),
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  try {
    const answer = await new Promise((resolve, reject) => {
      let buffer = '';
      const timer = setTimeout(
        () => reject(new Error(`no host.info answer within 30 s\n${stderr}`)),
        30_000,
      );
      child.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once('exit', (code) => {
        clearTimeout(timer);
        reject(new Error(`the bundled Host exited ${String(code)} before answering\n${stderr}`));
      });
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk) => {
        buffer += chunk;
        for (const line of buffer.split('\n')) {
          if (!line.trim()) continue;
          let packet;
          try {
            packet = JSON.parse(line);
          } catch {
            continue;
          }
          if (packet.id === '1') {
            clearTimeout(timer);
            resolve(packet);
          }
        }
      });
      child.stdin.write(`${JSON.stringify({ id: '1', method: 'host.info', params: {} })}\n`);
    });
    if (answer.error) throw new Error(`host.info refused: ${JSON.stringify(answer.error)}`);
    if (answer.result?.runtime !== 'yuantu' || typeof answer.result?.workspace !== 'string')
      throw new Error(`host.info answered something else: ${JSON.stringify(answer.result)}`);
  } finally {
    child.kill();
    await rm(workspace, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
}

await smoke();
console.log(`[build] Host bundle ${(size / 1024 / 1024).toFixed(2)} MB; host.info answered.`);
