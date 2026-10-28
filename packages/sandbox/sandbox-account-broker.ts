/**
 * The Host's brokers for the sandbox account backend: one `yuantu-sandbox broker --account X` per account, started
 * the first time a command needs it and restarted after it exits.
 *
 * A broker lives exactly as long as its pipe to this process: it ends when its stdin closes, which is what
 * happens when the Host exits for any reason, and ending it ends every command its runner started. A broker that
 * lost its runner exits with code 3; the next command simply starts a fresh one.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { toolEnvironment } from '../platform/child-environment.ts';

export type SandboxAccount = 'offline' | 'online';

/** How a broker is started; replaced in tests. */
export type BrokerLauncher = (helper: string, account: SandboxAccount) => ChildProcess;

const STARTUP_TIMEOUT_MS = 20_000;
const PIPE_PREFIX = '\\\\.\\pipe\\yuantu-sbx-broker-';

const launch: BrokerLauncher = (helper, account) =>
  spawn(helper, ['broker', '--account', account], {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    env: toolEnvironment(),
  });

interface Running {
  pipe: string;
  child: ChildProcess;
}

const brokers = new Map<SandboxAccount, Promise<Running>>();

/** Reads the broker's one-line announcement: `{"version":1,"pipe":"\\\\.\\pipe\\yuantu-sbx-broker-…"}`. */
export function parseBrokerAnnouncement(line: string): string {
  let reply: unknown;
  try {
    reply = JSON.parse(line);
  } catch {
    throw new Error('The sandbox broker did not announce its pipe');
  }
  const value = reply as { version?: unknown; pipe?: unknown };
  if (
    !value ||
    typeof value !== 'object' ||
    value.version !== 1 ||
    typeof value.pipe !== 'string' ||
    !value.pipe.startsWith(PIPE_PREFIX) ||
    !/^[0-9a-f]{32}$/.test(value.pipe.slice(PIPE_PREFIX.length)) ||
    Object.keys(value).length !== 2
  )
    throw new Error('The sandbox broker announced an invalid pipe');
  return value.pipe;
}

function start(
  helper: string,
  account: SandboxAccount,
  launcher: BrokerLauncher,
): Promise<Running> {
  return new Promise<Running>((resolve, reject) => {
    const child = launcher(helper, account);
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (error?: Error, pipe?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) {
        child.kill();
        reject(error);
      } else resolve({ pipe: pipe!, child });
    };
    const timer = setTimeout(
      () => finish(new Error('The sandbox broker did not start in time')),
      STARTUP_TIMEOUT_MS,
    );
    child.stdout?.on('data', (chunk: Buffer) => {
      if (settled) return;
      stdout += chunk.toString('utf8');
      const end = stdout.indexOf('\n');
      if (end < 0) return;
      try {
        finish(undefined, parseBrokerAnnouncement(stdout.slice(0, end).trim()));
      } catch (error) {
        finish(error as Error);
      }
    });
    // Diagnostics only, and only a tail: never surface more than the reason the broker gave.
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString('utf8')).slice(-2000);
    });
    child.once('error', (error) =>
      finish(new Error(`Unable to start the sandbox broker: ${error.message}`)),
    );
    child.once('exit', (code) => {
      finish(
        new Error(
          `The sandbox broker exited before it was ready (code ${code})${stderr.trim() ? `: ${stderr.trim()}` : ''}`,
        ),
      );
    });
    // The broker must not keep the Host alive, and the Host leaving must end the broker: its stdin stays open
    // (an unreferenced pipe), and closes with this process.
    child.unref();
    for (const stream of [child.stdin, child.stdout, child.stderr])
      (stream as { unref?: () => void } | null)?.unref?.();
  });
}

/** The pipe of a running broker for `account`, starting one if none is running. */
export async function brokerPipe(
  helper: string,
  account: SandboxAccount,
  launcher: BrokerLauncher = launch,
): Promise<string> {
  let pending = brokers.get(account);
  if (!pending) {
    pending = start(helper, account, launcher);
    brokers.set(account, pending);
    const current = pending;
    pending.then(
      ({ child }) =>
        child.once('exit', () => {
          if (brokers.get(account) === current) brokers.delete(account);
        }),
      () => {
        if (brokers.get(account) === current) brokers.delete(account);
      },
    );
  }
  return (await pending).pipe;
}

/** Ends every broker this process started (their runners and commands with them). */
export async function stopBrokers(): Promise<void> {
  const running = [...brokers.values()];
  brokers.clear();
  for (const pending of running) {
    const broker = await pending.catch(() => undefined);
    if (broker && broker.child.exitCode === null) {
      const exited = new Promise((resolve) => broker.child.once('exit', resolve));
      broker.child.stdin?.end();
      await exited;
    }
  }
}
