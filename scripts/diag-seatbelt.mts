// TEMPORARY diagnostic for macOS runner Seatbelt probe failures. Remove before merge.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { seatbeltProfile } from '../packages/tools/sandbox-seatbelt.ts';

const base = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'diag-')));
const root = path.join(base, 'root');
const scratch = path.join(base, 'scratch');
mkdirSync(root);
mkdirSync(scratch);
const node = realpathSync(process.execPath);
console.log('execPath', process.execPath, '->', node, 'sw_vers', spawnSync('sw_vers').stdout.toString());
const repo = realpathSync(path.resolve(import.meta.dirname, '..'));
const profile =
  seatbeltProfile({ root, scratch, runtimePaths: [node], files: 'workspace-write', network: 'denied' }) +
  `\n(allow file-read* file-map-executable (subpath ${JSON.stringify(path.join(repo, 'packages'))}) (subpath ${JSON.stringify(path.join(repo, 'node_modules'))}))`;

function attempt(label: string, prof: string, args: string[]) {
  const started = new Date();
  const r = spawnSync('/usr/bin/sandbox-exec', ['-p', prof, ...args], { cwd: root, encoding: 'utf8', timeout: 15000 });
  console.log(`== ${label}: status=${r.status} signal=${r.signal} error=${r.error}\nstdout=${r.stdout?.slice(0, 500)}\nstderr=${r.stderr?.slice(0, 2000)}`);
  const since = new Date(started.getTime() - 1000).toISOString().replace('T', ' ').slice(0, 19);
  const log = spawnSync('/usr/bin/log', ['show', '--style', 'compact', '--start', since, '--predicate', 'sender == "Sandbox" OR subsystem == "com.apple.sandbox.reporting" OR eventMessage CONTAINS "deny("'], { encoding: 'utf8' });
  console.log(`-- sandbox log for ${label}:\n${(log.stdout || '').split('\n').filter((l) => /deny|kill|Sandbox/i.test(l)).slice(0, 80).join('\n')}`);
  const crash = spawnSync('/bin/sh', ['-c', 'ls -t ~/Library/Logs/DiagnosticReports 2>/dev/null | head -3'], { encoding: 'utf8' });
  console.log('-- crash reports:', crash.stdout);
}

attempt('allow-default /usr/bin/true', '(version 1)(allow default)', ['/usr/bin/true']);
attempt('allow-default node', '(version 1)(allow default)', [node, '-e', 'console.log("ok")']);
attempt('product /usr/bin/true', profile, ['/usr/bin/true']);
attempt('product node', profile, [node, '-e', 'console.log("ok")']);
for (const extra of ['(allow file-read*)', '(allow mach-lookup)', '(allow file-read-metadata)', '(allow ipc-posix-shm*)', '(allow iokit-open)', '(allow process-codesigning*)', '(allow file-read*)(allow mach*)(allow ipc*)(allow iokit*)(allow system*)'])
  attempt('product+' + extra, profile + '
' + extra, [node, '-e', 'console.log("ok")']);
console.log('PROFILE\n' + profile);
