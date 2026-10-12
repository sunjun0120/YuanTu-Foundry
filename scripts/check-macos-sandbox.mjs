import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// This acceptance entry cannot report a green collection of platform skips on
// Windows or Linux. It always runs the real local Darwin kernel under Node.
if (process.platform !== 'darwin') {
  console.error('macOS sandbox acceptance requires a real macOS host; no simulated acceptance.');
  process.exitCode = 1;
} else {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  console.log(
    `macOS sandbox acceptance: Darwin ${os.release()}, ${process.arch}, Node ${process.version}`,
  );
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const child = spawn(
    process.execPath,
    [
      'scripts/run-tests.mjs',
      'tests/sandbox-seatbelt.test.ts',
      'tests/seatbelt-scratch.test.ts',
      'tests/native-sandbox-lifecycle.test.ts',
      'tests/native-background-cleanup.test.ts',
      'tests/acceptance.test.ts',
      'tests/native-git.test.ts',
    ],
    { cwd: root, stdio: 'inherit', env },
  );
  child.once('error', (error) => {
    console.error(error);
    process.exitCode = 1;
  });
  child.once('exit', (code, signal) => {
    process.exitCode = code ?? (signal ? 1 : 0);
  });
}
