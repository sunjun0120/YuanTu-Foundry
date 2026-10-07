import { spawn, type ChildProcess } from 'node:child_process';
import { connect, type Socket } from 'node:net';
import { createInterface } from 'node:readline';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { TestContext } from 'node:test';
import { AgentHostClient } from '../packages/client/host-client.ts';
import { socketTransport } from '../packages/client/host-transport.ts';

/**
 * A Host serving JSONL on a loopback socket, with the port read from the banner it prints.
 *
 * This is the shape a carrier meets when it did not start the Host itself: port 0 is the request ("any free
 * port") and the banner is how the answer gets back, because a carrier does not get to choose the Host's port.
 * `seed` runs before the Host starts, because the point of a Host is that it owns its database.
 *
 * Shared by the transport tests (`host-carrier.test.ts`) and the carrier-service tests (`carrier.test.ts`) so
 * that "a Host that only listens" means one thing in this suite.
 */
const hostPath = path.resolve('apps/agent-host/main.ts');

export interface ListeningHost {
  port: number;
  child: ChildProcess;
  root: string;
  dbPath: string;
  stderr: () => string;
}

export async function listeningHost(
  t: TestContext,
  env: NodeJS.ProcessEnv,
  seed?: (dbPath: string) => void,
): Promise<ListeningHost> {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-carrier-'));
  const dbPath = path.join(root, 'sessions.sqlite');
  seed?.(dbPath);
  const child = spawn(
    process.execPath,
    [hostPath, '--workspace', root, '--db', dbPath, '--listen', '127.0.0.1:0'],
    {
      cwd: root,
      env: {
        ...process.env,
        YUANTU_WORKFLOWS: 'false',
        YUANTU_PROTOCOL: 'anthropic',
        YUANTU_API_KEY: 'fixture',
        YUANTU_MODEL: 'fixture',
        YUANTU_MAX_CONTEXT_TOKENS: '128000',
        /**
         * A listening Host is spawned for tests that script one response per request, and the session-naming call
         * is a real request to the endpoint — it would take the first fixture response and shift every later
         * assertion by one. It belongs in the defaults here rather than in each caller's `env` for the same reason
         * `YUANTU_WORKFLOWS: 'false'` does: this fixture exists to give tests a *quiet* Host, and the one test
         * whose subject is the naming call (`session-title.test.ts`) starts its Host itself.
         */
        YUANTU_SESSION_TITLES: '0',
        ...env,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let stderr = '';
  child.stderr!.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));
  const lines = createInterface({ input: child.stdout! });
  const port = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Host did not report a port. stderr: ${stderr}`)),
      20_000,
    );
    lines.on('line', (line) => {
      const match = /listening on .*:(\d+)/.exec(line);
      if (match) {
        clearTimeout(timer);
        resolve(Number(match[1]));
      }
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`Host exited (code=${code}) before listening. stderr: ${stderr}`));
    });
  });
  t.after(async () => {
    lines.close();
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    // The killed Host may hold the database file for a moment after the signal, and a Windows temp directory
    // cannot be removed while it does.
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  return { port, child, root, dbPath, stderr: () => stderr };
}

/**
 * Wait until the Host's own stderr matches, instead of reading it once and hoping.
 *
 * The Host writes its progress line *before* it answers the request that is being awaited, but the two travel on
 * different pipes: a single read right after the reply is a race the test process can lose even though the Host's
 * own order is deterministic. Polling makes the assertion about the Host rather than about the scheduler, and it
 * fails with the stderr it did see instead of a bare match error.
 */
export async function waitForStderr(
  host: ListeningHost,
  pattern: RegExp,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!pattern.test(host.stderr())) {
    if (Date.now() > deadline)
      throw new Error(`Host stderr never matched ${pattern}; it said:\n${host.stderr()}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** Open a socket to a listening Host and hand it to the client as its transport. */ export async function connectSocket(
  port: number,
): Promise<Socket> {
  const socket = connect({ host: '127.0.0.1', port });
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', () => resolve());
    socket.once('error', reject);
  });
  return socket;
}

/** Connect a socket to the Host and hand it to the client as its transport. */
export async function connectClient(
  port: number,
  env: NodeJS.ProcessEnv = {},
): Promise<{ client: AgentHostClient; socket: Socket }> {
  const socket = await connectSocket(port);
  return { client: new AgentHostClient({ transport: socketTransport(socket), env }), socket };
}
