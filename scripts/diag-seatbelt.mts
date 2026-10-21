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

function attempt(label: string, prof: string, args: string[], env: NodeJS.ProcessEnv = process.env) {
  const started = new Date();
  const r = spawnSync('/usr/bin/sandbox-exec', ['-p', prof, ...args], { cwd: root, env, encoding: 'utf8', timeout: 30000 });
  console.log(`== ${label}: status=${r.status} signal=${r.signal} error=${r.error}\nstdout=${r.stdout?.slice(0, 500)}\nstderr=${r.stderr?.slice(0, 2000)}`);
  const since = new Date(started.getTime() - 1000).toISOString().replace('T', ' ').slice(0, 19);
  const log = spawnSync('/usr/bin/log', ['show', '--style', 'compact', '--start', since, '--predicate', 'sender == "Sandbox" OR subsystem == "com.apple.sandbox.reporting" OR eventMessage CONTAINS "deny("'], { encoding: 'utf8' });
  console.log(`-- sandbox log for ${label}:\n${(log.stdout || '').split('\n').filter((l) => /deny/.test(l) && /\b(true|node|git|sandbox-exec|xcrun|xcode)[-\w]*\(\d+\)/.test(l)).slice(0, 80).join('\n')}`);
  const crash = spawnSync('/bin/sh', ['-c', 'ls -t ~/Library/Logs/DiagnosticReports 2>/dev/null | head -3'], { encoding: 'utf8' });
  console.log('-- crash reports:', crash.stdout);
}

const clt = '/Library/Developer/CommandLineTools';
console.log(spawnSync('/bin/ls', ['-la', clt, clt + '/usr/bin/git'], { encoding: 'utf8' }).stdout);
spawnSync('/usr/bin/git', ['init', '-q', root]);
const prod = seatbeltProfile({ root, scratch, runtimePaths: [node], developerTools: [clt + '/usr'], files: 'workspace-write', network: 'denied' });
const env = { ...process.env, DEVELOPER_DIR: clt, TMPDIR: scratch, HOME: scratch };
attempt('clt git usr only', prod, ['/usr/bin/git', 'status'], env);
const lit = prod + `
(allow file-read* (literal ${JSON.stringify(clt)}))`;
attempt('clt git +literal', lit, ['/usr/bin/git', 'status'], env);
attempt('clt git +literal no env', lit, ['/usr/bin/git', 'status'], { ...env, DEVELOPER_DIR: undefined });
