import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { mkdir, writeFile, readFile, lstat } from 'node:fs/promises';
import {
  controlledEnvironment,
  JsonlRunCollector,
  redact,
} from '../coding-evaluation/adapters.mjs';
import { captureSourceManifest, hash, inventory } from '../coding-evaluation/materialize.mjs';
import { collectMetrics } from '../coding-evaluation/metrics.mjs';
import { requireSweLiveAuthorization, validateSweManifest } from './schema.ts';
import { problemPrompt } from './prompt.mjs';
import { git } from './repos.mjs';
import { safeModelPatch } from './predictions.mjs';

export function stringifyEvidence(value, secrets = [], space) {
  return JSON.stringify(
    value,
    (_name, item) => (typeof item === 'string' ? redact(item, secrets) : item),
    space,
  );
}

export const APPROVAL_POLICY = {
  version: 1,
  rules: [
    { kind: 'command', effect: 'deny' },
    { kind: 'external', effect: 'deny' },
    { kind: 'write', effect: 'ask' },
  ],
};
async function safeWritePath(root, name) {
  if (
    typeof name !== 'string' ||
    !name ||
    /[:\x00-\x1f]/.test(name) ||
    path.isAbsolute(name) ||
    /^[\\/]/.test(name)
  )
    return false;
  const parts = name.replaceAll('\\', '/').split('/');
  if (
    parts.some(
      (part) =>
        part !== '.' &&
        (part === '..' ||
          /[. ]$/.test(part) ||
          /^(?:\.git|\.yuantu|node_modules|\.scratch)$/i.test(part)),
    )
  )
    return false;
  let current = root;
  for (const part of parts.filter((part) => part !== '.' && part !== '')) {
    current = path.join(current, part);
    try {
      if ((await lstat(current)).isSymbolicLink()) return false;
    } catch (error) {
      if (error.code !== 'ENOENT') return false;
    }
  }
  const relative = path.relative(root, current);
  return !!relative && !relative.startsWith('..') && !path.isAbsolute(relative);
}
export async function approvalAllowed(approval, directory) {
  if (approval?.kind !== 'write') return false;
  const tool = approval.toolCall?.name,
    args = approval.toolCall?.arguments ?? {};
  let paths;
  if (['edit_file', 'write_file', 'apply_patch', 'delete_file'].includes(tool)) paths = [args.path];
  else if (tool === 'move_file') paths = [args.from, args.to];
  else if (tool === 'batch_edit' && Array.isArray(args.edits) && args.edits.length)
    paths = args.edits.map((edit) => edit.path);
  else return false;
  return (await Promise.all(paths.map((name) => safeWritePath(directory, name)))).every(Boolean);
}
const patchPaths = ['.', ':(exclude).yuantu', ':(exclude).scratch', ':(exclude)node_modules'];
export async function collectPatch(directory, baseCommit) {
  if (
    !/^[a-f0-9]{40}$/.test(baseCommit) ||
    (await git(directory, ['rev-parse', 'HEAD'])).trim() !== baseCommit
  )
    throw new Error('Workspace HEAD changed');
  await git(directory, ['add', '-A', '-N', '--', ...patchPaths]);
  const patch = await git(directory, [
    'diff',
    '--no-ext-diff',
    '--no-textconv',
    '--binary',
    baseCommit,
    '--',
    ...patchPaths,
  ]);
  const names = (
    await git(directory, [
      'diff',
      '--no-ext-diff',
      '--no-textconv',
      '--name-only',
      '-z',
      baseCommit,
      '--',
      ...patchPaths,
    ])
  )
    .split('\0')
    .filter(Boolean);
  return {
    patch,
    files: names.length,
    changedFiles: names,
    changedTests: names.some((name) =>
      /(^|\/)(tests?|testing)(\/|$)|(^|\/)(test_[^/]*|[^/]*_test)\.py$/i.test(name),
    ),
    bytes: Buffer.byteLength(patch),
    sha256: hash(patch),
    failureClass: patch ? null : 'empty-patch',
  };
}
export async function assertSweRuntime(frozen, dependencies = false) {
  if ((await captureSourceManifest(frozen.runtimeDirectory)).hash !== frozen.runtimeHash)
    throw new Error('Frozen runtime changed');
  if (dependencies) {
    const receipt = JSON.parse(
      await readFile(path.join(frozen.runtimeDirectory, '.evaluation-dependencies.json'), 'utf8'),
    );
    const modules = path.join(frozen.runtimeDirectory, 'node_modules');
    if (
      !receipt.private ||
      receipt.lockHash !==
        hash(await readFile(path.join(frozen.runtimeDirectory, 'package-lock.json'))) ||
      (await lstat(modules)).isSymbolicLink() ||
      hash(await inventory(modules, { includeExcluded: true })) !== receipt.filesHash
    )
      throw new Error('Private dependency receipt mismatch');
  }
}
export async function runSweSample(input, signal = new AbortController().signal) {
  const { frozen, record, directory, evidenceDirectory } = input;
  const manifest = validateSweManifest(input.manifest);
  const offline = input.offlineProbe === true;
  if (offline) {
    const endpoint = new URL(manifest.endpointUrl);
    if (
      endpoint.protocol !== 'http:' ||
      endpoint.hostname !== '127.0.0.1' ||
      manifest.model !== 'swe-bench-fixture' ||
      input.providerKey !== 'swe-bench-fake-key'
    )
      throw new Error('Offline probe requires numeric loopback and fake identity');
  } else requireSweLiveAuthorization(manifest, 1);
  const key = offline ? input.providerKey : process.env.YUANTU_API_KEY;
  if (!key) throw new Error('Explicit YUANTU_API_KEY required; no personal credential fallback');
  signal.throwIfAborted();
  await assertSweRuntime(frozen, true);
  await mkdir(evidenceDirectory, { recursive: true });
  const save = (file, value) =>
    writeFile(
      path.join(evidenceDirectory, file),
      typeof value === 'string' ? redact(value, [key]) : stringifyEvidence(value, [key], 2),
      { flag: 'wx' },
    );
  await save('approval-policy.json', {
    policy: APPROVAL_POLICY,
    responderSourceHash: hash(await readFile(new URL(import.meta.url))),
    directory,
    allowedWrites: [
      'edit_file',
      'write_file',
      'apply_patch',
      'delete_file',
      'move_file',
      'batch_edit',
    ],
    commands: [],
    external: false,
  });
  const env = controlledEnvironment(manifest, { ...process.env, YUANTU_API_KEY: key });
  const home = path.join(evidenceDirectory, 'private-home');
  await mkdir(home);
  env.HOME =
    env.USERPROFILE =
    env.APPDATA =
    env.LOCALAPPDATA =
    env.TEMP =
    env.TMP =
    env.TMPDIR =
      home;
  env.YUANTU_PROMPT_CACHE = manifest.promptCache;
  env.YUANTU_SESSION_TITLES = '0';
  env.GIT_TERMINAL_PROMPT = '0';
  const { AgentHostClient } = await import(
    pathToFileURL(path.join(frozen.runtimeDirectory, 'packages/client/host-client.ts')).href
  );
  const client = new AgentHostClient({
    nodePath: process.execPath,
    hostPath: path.join(frozen.runtimeDirectory, 'apps/agent-host/main.ts'),
    workspace: directory,
    db: path.join(evidenceDirectory, 'session.sqlite'),
    env,
    requestTimeoutMs: manifest.requestTimeoutMs,
    shutdownTimeoutMs: 15000,
    deferAutomatic: true,
  });
  const start = performance.now(),
    events = [],
    runs = [],
    sessionRecords = [],
    pending = [],
    interactions = [];
  const controller = new AbortController(),
    combined = AbortSignal.any([signal, controller.signal]);
  let failureClass = null,
    timedOut = false,
    cleanupConfirmed = false,
    session = null,
    cancellation = null,
    cancelPromise = null,
    ownedPid = null,
    cancelDeadline;
  const collector = new JsonlRunCollector();
  const timing = { wallMs: 0, setupMs: 0, verificationMs: 0, cleanupMs: 0 };
  const cancel = () => {
    if (!session || cancelPromise) return;
    cancelDeadline = setTimeout(() => {
      failureClass ??= 'cancellation-deadline';
      void client.stop().catch(() => {});
    }, 15000);
    cancelPromise = client.request('run.cancel', { sessionId: session.id }).then(
      (answer) => {
        cancellation = { acknowledged: answer?.cancelled === true };
      },
      () => {
        cancellation = { acknowledged: false };
      },
    );
    // A dead transport must not leave run.start waiting indefinitely after its budget expired.
    cancelPromise.then(() => {
      if (!cancellation?.acknowledged) void client.stop().catch(() => {});
    });
  };
  const unsubscribe = client.subscribe((event) => {
    const atMs = performance.now() - start;
    const sanitized = JSON.parse(stringifyEvidence(event, [key]));
    events.push({ atMs, event: sanitized });
    if (sanitized.sessionId && sanitized.runId)
      collector.write(Buffer.from(JSON.stringify({ type: 'event', event: sanitized }) + '\n'));
    if (event.type === 'approval.required') {
      const { approvalId, approval } = event.data;
      pending.push(
        approvalAllowed(approval, directory)
          .then(async (allow) => {
            interactions.push({ approvalId, tool: approval.toolCall?.name, allow });
            await client.request('approval.respond', { approvalId, allow });
          })
          .catch(() => {
            failureClass ??= 'approval-response';
            controller.abort();
          }),
      );
    }
    if (event.type === 'question.required')
      pending.push(
        client
          .request('question.respond', { questionId: event.data.questionId, cancelled: true })
          .catch(() => {
            failureClass ??= 'question-response';
            controller.abort();
          }),
      );
    if (event.type === 'provider.request.finished') {
      const count = new Set(
        events
          .filter((e) => e.event.type === 'provider.request.finished')
          .map((e) => `${e.event.runId}:${e.event.data.requestId}`),
      ).size;
      if (count >= manifest.maxObservedRequestsPerSample) {
        failureClass ??= 'observed-request-budget';
        controller.abort();
      }
    }
    if (event.type === 'statistics.updated') {
      const stats = event.data.statistics;
      if (stats && stats.inputTokens + stats.outputTokens >= manifest.maxKnownTokensPerSample) {
        failureClass ??= 'observed-token-budget';
        controller.abort();
      }
    }
  });
  const timer = setTimeout(() => {
    timedOut = true;
    failureClass ??= 'instance-timeout';
    controller.abort();
  }, manifest.instanceTimeoutMs);
  combined.addEventListener('abort', cancel, { once: true });
  let terminalSeen = false;
  try {
    await client.start();
    ownedPid = client.pid;
    await client.request('permission.update', { policy: APPROVAL_POLICY });
    session = await client.request('session.create', {});
    timing.setupMs = performance.now() - start;
    combined.throwIfAborted();
    try {
      const run = await client.run(session.id, problemPrompt(record));
      const safeRun = JSON.parse(stringifyEvidence(run, [key]));
      runs.push(safeRun);
      collector.write(Buffer.from(JSON.stringify({ type: 'result', result: safeRun }) + '\n'));
      collector.expected = { sessionId: session.id, runId: run.runId };
      terminalSeen = collector.finish(0).terminalSeen;
      if (
        !events.some(
          (item) =>
            item.event.type === 'run.finished' &&
            item.event.sessionId === run.sessionId &&
            item.event.runId === run.runId,
        )
      )
        throw new Error('Missing matching run.finished');
    } catch (error) {
      if (!combined.aborted) throw error;
    }
    if (cancelPromise) await cancelPromise;
    if (combined.aborted) failureClass ??= 'cancelled';
    const state = await client.request('session.get', { sessionId: session.id });
    if (cancellation) {
      cancellation.runSlotReleased = state.session?.activeRun == null;
      if (!cancellation.acknowledged || !cancellation.runSlotReleased)
        failureClass ??= 'cancellation-unconfirmed';
    }
    const durable = [];
    let afterSeq = 0;
    for (;;) {
      const page = await client.request('session.events', {
        sessionId: session.id,
        afterSeq,
        limit: 500,
      });
      durable.push(...page.entries);
      if (!page.more) break;
      if (page.nextSeq <= afterSeq) throw new Error('Nonprogressing durable event cursor');
      afterSeq = page.nextSeq;
    }
    sessionRecords.push(
      JSON.parse(
        stringifyEvidence(
          {
            sessionId: session.id,
            parentSessionId: null,
            statistics: state.statistics,
            events: durable,
          },
          [key],
        ),
      ),
    );
  } catch (error) {
    failureClass ??= combined.aborted ? 'cancelled' : 'host-or-environment';
    await save('adapter-error.txt', error instanceof Error ? error.message : String(error));
  } finally {
    clearTimeout(timer);
    combined.removeEventListener('abort', cancel);
    if (cancelPromise) await cancelPromise;
    clearTimeout(cancelDeadline);
    await Promise.allSettled(pending);
    const cleanupStart = performance.now();
    try {
      await client.stop();
      cleanupConfirmed = client.status === 'stopped' && client.pid === undefined;
    } catch {
      failureClass ??= 'host-cleanup';
    }
    timing.cleanupMs = performance.now() - cleanupStart;
    timing.wallMs = performance.now() - start;
    unsubscribe();
    await save('host-cleanup.json', {
      ownedPid,
      cleanupConfirmed,
      status: client.status,
      cancellation,
      live: !offline,
    });
  }
  await assertSweRuntime(frozen);
  const patch = await collectPatch(directory, record.base_commit);
  patch.patch = safeModelPatch(patch.patch, [key]);
  patch.bytes = Buffer.byteLength(patch.patch);
  patch.sha256 = hash(patch.patch);
  await writeFile(path.join(evidenceDirectory, 'patch.diff'), patch.patch, { flag: 'wx' });
  const metrics = collectMetrics({ events, runs, sessionRecords, timing });
  const result = {
    live: !offline,
    events,
    runs,
    sessionRecords,
    metrics,
    timing,
    terminalSeen,
    cleanupConfirmed,
    timedOut,
    cancellation,
    interactions,
    failureClass,
    rounds: sessionRecords[0]?.statistics?.steps ?? 0,
    patch,
  };
  await save('adapter.json', { ...result, patch: { ...patch, patch: undefined } });
  return result;
}
