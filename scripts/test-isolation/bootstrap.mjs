import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import { inside, resolvedTarget } from './paths.mjs';
import { installFilesystemProbe } from './filesystem.mjs';
import { installSQLiteProbe } from './sqlite.mjs';
import { installNetworkProbe } from './network.mjs';
import { installProcessProbe } from './processes.mjs';
import { record } from './records.mjs';
// Capture controller-only lease primitives before worker filesystem instrumentation.
import '../test-resource-lease.mjs';

// The harness controller owns reports outside the worker; its per-file child installs the probes.
const controller = process.execArgv.includes('--test') && !process.env.NODE_TEST_CONTEXT;
const encoded = process.env.FOUNDRY_TEST_ISOLATION;
if (encoded && !controller) {
  const config = JSON.parse(encoded);
  const stat = fs.statSync;
  let violations = 0;
  const violate = (rule, message) => {
    violations++;
    record(config.violationPath, { rule, message, file: config.file, pid: process.pid });
    process.exitCode = 1;
    throw new Error(`[TEST_ISOLATION:${rule}] ${message}`);
  };
  const roots = [config.root];
  if (config.resources.includes('windows-sandbox'))
    roots.push(path.join(os.userInfo().homedir, '.yuantu', 'sandbox-state'));
  const checkWrite = (input) => {
    // node-pty allocates unique native ConPTY transports, owned by the serialized PTY resource.
    if (
      process.platform === 'win32' &&
      config.resources.includes('real-pty') &&
      /^\\\\\.\\pipe\\conpty-\d+\.\d+-(?:in|out)(?:-worker)?$/.test(String(input))
    )
      return;
    const target = resolvedTarget(input);
    if (!target || !roots.some((root) => inside(root, target)))
      violate('ownership', `write outside worker ownership: ${String(input)}`);
  };
  process.chdir = () => violate('cwd', 'process.chdir is prohibited; use an explicit child cwd');
  // cross-spawn honors Node worker threads' disabled flag and resolves absolute commands without chdir.
  process.chdir.disabled = true;
  const hasViolations = () => {
    if (violations) return true;
    try {
      return stat(config.violationPath).size > 0;
    } catch (error) {
      if (error.code === 'ENOENT') return false;
      throw error;
    }
  };
  const exit = process.exit;
  process.exit = (code) => exit(hasViolations() ? 1 : code);
  process.on('beforeExit', () => {
    if (hasViolations()) process.exitCode = 1;
  });
  installProcessProbe(config, violate);
  installFilesystemProbe(checkWrite, violate, {
    // On POSIX node-pty opens its master descriptor natively; the serialized PTY resource owns it, as it owns
    // the ConPTY pipes on Windows.
    nativeDescriptor: () => process.platform !== 'win32' && config.resources.includes('real-pty'),
  });
  installSQLiteProbe(checkWrite, violate);
  installNetworkProbe(checkWrite, violate);
  syncBuiltinESMExports();
}
