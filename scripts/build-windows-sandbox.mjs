import { spawnSync } from 'node:child_process';
import { copyFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const project = fileURLToPath(new URL('..', import.meta.url));
const args = process.argv.slice(2);
let outputDirectory;
if (args.length) {
  if (args.length !== 1 || !args[0].startsWith('--output-directory='))
    throw new Error('Use --output-directory=project-scratch-directory or no arguments');
  outputDirectory = path.resolve(args[0].slice('--output-directory='.length));
  if (!outputDirectory.startsWith(path.join(project, '.scratch') + path.sep))
    throw new Error('Staged helper output must stay inside project scratch');
}
if (process.platform === 'win32') {
  const crate = path.join(project, 'packages/tools/windows-sandbox/appcontainer');
  const inheritedFlags = process.env.CARGO_ENCODED_RUSTFLAGS
    ? process.env.CARGO_ENCODED_RUSTFLAGS.split('\u001f')
    : (process.env.RUSTFLAGS ?? '').split(/\s+/).filter(Boolean);
  const result = spawnSync(
    'cargo',
    ['build', '--release', '--locked', '--manifest-path', path.join(crate, 'Cargo.toml')],
    {
      cwd: project,
      stdio: 'inherit',
      windowsHide: true,
      env: {
        ...process.env,
        CARGO_ENCODED_RUSTFLAGS: [...inheritedFlags, '-C', 'target-feature=+crt-static'].join(
          '\u001f',
        ),
      },
    },
  );
  if (result.status !== 0)
    throw new Error(
      result.error?.message ??
        'AppContainer helper compilation failed; inspect the Rust compiler diagnostics above',
    );
  const source = path.join(crate, 'target/release/yuantu-appcontainer.exe');
  for (const destination of outputDirectory
    ? [outputDirectory]
    : ['packages/tools/windows-sandbox', 'dist/packages/tools/windows-sandbox']) {
    const directory = path.resolve(project, destination);
    await mkdir(directory, { recursive: true });
    await copyFile(source, path.join(directory, 'yuantu-appcontainer.exe'));
  }
  console.log('Built native AppContainer helper (protocol 1).');
}
