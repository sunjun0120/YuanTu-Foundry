import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { TestContext } from 'node:test';
import { AgentHostClient } from '../packages/client/host-client.ts';
import { processTransport, type HostTransport } from '../packages/client/host-transport.ts';

/**
 * A Host this suite starts itself and reaches through its stdio.
 *
 * This is the shape a carrier meets when it did not start the Host: the test holds the child — its stderr, its
 * exit, a seeded database — and hands the client only the link. `seed` runs before the Host starts, because the
 * point of a Host is that it owns its database.
 *
 * Shared by the Host integration tests and the carrier-service tests (`carrier.test.ts`) so that "a Host somebody
 * else started" means one thing in this suite.
 */
const hostPath = path.resolve('apps/agent-host/main.ts');

export interface HostProcess {
  child: ChildProcessWithoutNullStreams;
  root: string;
  dbPath: string;
  stderr: () => string;
  /** The link to this Host. A Host serves one carrier, so there is exactly one. */
  transport: () => HostTransport;
  /** Close attached clients before this fixture's fallback process kill and directory removal. */
  beforeStop: (cleanup: () => Promise<void>) => void;
}

export async function startHost(
  t: TestContext,
  env: NodeJS.ProcessEnv,
  seed?: (dbPath: string) => void,
): Promise<HostProcess> {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-carrier-'));
  const dbPath = path.join(root, 'sessions.sqlite');
  seed?.(dbPath);
  const child = spawn(process.execPath, [hostPath, '--workspace', root, '--db', dbPath], {
    cwd: root,
    env: {
      ...process.env,
      // Protocol fixtures use owned local processes; native backend tests override this explicitly.
      YUANTU_SANDBOX: 'host',
      YUANTU_WORKFLOWS: 'false',
      YUANTU_PROTOCOL: 'anthropic',
      YUANTU_API_KEY: 'fixture',
      YUANTU_MODEL: 'fixture',
      YUANTU_MAX_CONTEXT_TOKENS: '128000',
      /**
       * This Host is spawned for tests that script one response per request, and the session-naming call is a
       * real request to the endpoint — it would take the first fixture response and shift every later assertion
       * by one. It belongs in the defaults here rather than in each caller's `env` for the same reason
       * `YUANTU_WORKFLOWS: 'false'` does: this fixture exists to give tests a *quiet* Host, and the one test
       * whose subject is the naming call (`session-title.test.ts`) starts its Host itself.
       */
      YUANTU_SESSION_TITLES: '0',
      ...env,
    },
    // As `stdioTransport` does: on POSIX the Host leads its own process group, so a forced stop ends everything
    // it started.
    detached: process.platform !== 'win32',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));
  let link: HostTransport | undefined;
  const beforeStop: (() => Promise<void>)[] = [];
  t.after(async () => {
    try {
      for (const cleanup of beforeStop) await cleanup();
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = new Promise((resolve) => child.once('exit', resolve));
        if (link) link.kill();
        else child.kill('SIGKILL');
        await exited;
      }
      // The killed Host may hold the database file for a moment after the signal, and a Windows temp directory
      // cannot be removed while it does.
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });
  return {
    child,
    root,
    dbPath,
    stderr: () => stderr,
    transport: () => {
      if (link) throw new Error('this Host already has its carrier');
      return (link = processTransport(child));
    },
    beforeStop: (cleanup) => {
      beforeStop.push(cleanup);
    },
  };
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
  host: HostProcess,
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

/** Hand the Host's link to a client that does not own the process. */
export async function connectClient(
  host: Pick<HostProcess, 'transport'>,
  env: NodeJS.ProcessEnv = {},
): Promise<{ client: AgentHostClient; transport: HostTransport }> {
  const transport = host.transport();
  return { client: new AgentHostClient({ transport, env }), transport };
}
