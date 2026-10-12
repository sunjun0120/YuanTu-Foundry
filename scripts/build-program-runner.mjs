import { build } from 'esbuild';
import { mkdir, readdir, lstat, writeFile, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PROGRAM_PROTOCOL, PROGRAM_NODE_MAJOR } from '../packages/tools/environment.ts';

const project = fileURLToPath(new URL('..', import.meta.url));
const expected = new Set([
  'code-process-entry.js',
  'code-worker.js',
  'package.json',
  'manifest.json',
  'Dockerfile',
]);

/** Build the native program runner. Legacy generated container recipes are removed from this output. */
export async function buildProgramRunner(output) {
  const directory = path.resolve(output);
  await mkdir(directory, { recursive: true });
  if ((await lstat(directory)).isSymbolicLink()) throw new Error('Unexpected runner output link');
  for (const name of await readdir(directory)) {
    const stat = await lstat(path.join(directory, name));
    if (!expected.has(name) || !stat.isFile() || stat.isSymbolicLink())
      throw new Error(`Unexpected runner output: ${name}`);
  }
  const result = await build({
    absWorkingDir: project,
    entryPoints: ['packages/tools/code-process-entry.ts', 'packages/tools/code-worker.ts'],
    outdir: directory,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node24',
    write: false,
    metafile: true,
    logLevel: 'silent',
  });
  for (const info of Object.values(result.metafile.outputs))
    if (info.imports.some((item) => item.external && !item.path.startsWith('node:')))
      throw new Error('Runner has an external runtime dependency');
  const files = new Map(
    result.outputFiles.map((file) => [path.basename(file.path), file.contents]),
  );
  files.set(
    'package.json',
    Buffer.from(
      JSON.stringify({ private: true, type: 'module', engines: { node: '>=24' } }, null, 2) + '\n',
    ),
  );
  const manifest = {
    protocol: PROGRAM_PROTOCOL,
    minimumNodeMajor: PROGRAM_NODE_MAJOR,
    files: Object.fromEntries(
      [...files].map(([name, bytes]) => [name, createHash('sha256').update(bytes).digest('hex')]),
    ),
  };
  files.set('manifest.json', Buffer.from(JSON.stringify(manifest, null, 2) + '\n'));
  await rm(path.join(directory, 'Dockerfile'), { force: true });
  for (const [name, bytes] of files) await writeFile(path.join(directory, name), bytes);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await buildProgramRunner(path.join(project, 'dist/program-runner'));
  process.stdout.write('Built standalone native program runner (protocol 1).\n');
}
