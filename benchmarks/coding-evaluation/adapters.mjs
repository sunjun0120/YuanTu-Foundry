import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { StringDecoder } from 'node:string_decoder';
import { mkdir, writeFile, readFile, lstat } from 'node:fs/promises';
import { requireLiveAuthorization } from './schema.ts';
import { assertFrozen, inventory, hash } from './materialize.mjs';
import { collectMetrics } from './metrics.mjs';
import { assertOfflineReceipt } from './live-self-check.mjs';
import { runE09Sample, waitForWorkloadReady } from './scenario.mjs';

export function redact(text, secrets = []) {
  let result = String(text);
  for (const secret of secrets.filter((value) => typeof value === 'string' && value.length))
    result = result.split(secret).join('[REDACTED]');
  return result
    .replace(/Bearer\s+\S+/gi, 'Bearer [REDACTED]')
    .replace(/\bsk-[A-Za-z0-9_-]+/g, '[REDACTED]')
    .replace(
      /((?:api[-_]?key|authorization|password|secret)\s*[=:]\s*)[^\s,;}]+/gi,
      '$1[REDACTED]',
    );
}
export function controlledEnvironment(manifest, source = process.env, { subagents = false } = {}) {
  const env = {};
  for (const key of [
    'SystemRoot',
    'SYSTEMROOT',
    'WINDIR',
    'windir',
    'ComSpec',
    'COMSPEC',
    'PATH',
    'Path',
    'PATHEXT',
    'TEMP',
    'TMP',
    'TMPDIR',
    'LANG',
  ])
    if (source[key]) env[key] = source[key];
  // `YUANTU_SUBAGENTS` is a *boolean* setting: `off` is refused by the startup environment check and takes the
  // whole Host down, so the disabled value here has to be the one the product parses.
  return {
    ...env,
    YUANTU_API_KEY: source.YUANTU_API_KEY ?? '',
    YUANTU_MODEL: manifest.model ?? '',
    YUANTU_PROTOCOL: manifest.protocol ?? 'openai',
    YUANTU_BASE_URL: manifest.endpointUrl ?? '',
    YUANTU_MAX_CONTEXT_TOKENS: String(manifest.maxContextTokens),
    YUANTU_MAX_OUTPUT_TOKENS: String(manifest.maxOutputTokens),
    YUANTU_REQUEST_TIMEOUT_MS: String(manifest.requestTimeoutMs),
    YUANTU_STREAM_IDLE_TIMEOUT_MS: String(manifest.streamIdleTimeoutMs),
    YUANTU_TOOL_MODE: manifest.toolMode,
    YUANTU_PROMPT_CACHE: 'off',
    YUANTU_SANDBOX: 'host',
    YUANTU_SANDBOX_HOOK: 'host',
    YUANTU_SUBAGENTS: subagents ? '1' : '0',
    YUANTU_HOOK_BRIDGE: 'false',
    YUANTU_MAX_RETRIES: '0',
  };
}
export class JsonlRunCollector {
  constructor(expected = {}) {
    this.expected = expected;
    this.decoder = new StringDecoder('utf8');
    this.buffer = '';
    this.events = [];
    this.runs = [];
  }
  write(buffer) {
    this.buffer += this.decoder.write(buffer);
    if (Buffer.byteLength(this.buffer) > 16_000_000) throw new Error('JSONL frame exceeds limit');
    let end;
    while ((end = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, end);
      this.buffer = this.buffer.slice(end + 1);
      if (!line.trim()) continue;
      const value = JSON.parse(line);
      if (value.type === 'event') this.events.push({ atMs: performance.now(), event: value.event });
      else if (value.type === 'result') {
        if (this.runs.length) throw new Error('Duplicate terminal result');
        if (
          !value.result?.sessionId ||
          !value.result?.runId ||
          (this.expected.sessionId && value.result.sessionId !== this.expected.sessionId) ||
          (this.expected.runId && value.result.runId !== this.expected.runId)
        )
          throw new Error('Terminal identity mismatch');
        this.runs.push(value.result);
      } else throw new Error('Unrecognized JSONL frame');
    }
  }
  finish(exitCode) {
    this.buffer += this.decoder.end();
    if (this.buffer.trim()) throw new Error('Partial JSONL terminal line');
    if (this.runs.length !== 1) throw new Error('Missing terminal result');
    if (exitCode !== 0) throw new Error('Nonzero process exit');
    const terminal = this.runs[0];
    if (
      this.events.some(
        ({ event }) => event.sessionId !== terminal.sessionId || event.runId !== terminal.runId,
      )
    )
      throw new Error('Event identity mismatch');
    return { events: this.events, runs: this.runs, terminalSeen: true, exitCode };
  }
}
export function approvalAllowed(approval, prepared, caseDef) {
  const tool = approval?.toolCall?.name;
  const args = approval?.toolCall?.arguments ?? {};
  if (approval?.kind === 'write' && ['write_file', 'edit_file'].includes(tool)) {
    if (typeof args.path !== 'string' || path.isAbsolute(args.path)) return false;
    const relative = path
      .relative(prepared.workspace.directory, path.resolve(prepared.workspace.directory, args.path))
      .split(path.sep)
      .join('/');
    return (
      caseDef.allowedPaths.includes(relative) ||
      (/^tests\/[a-zA-Z0-9_-]+\.test\.ts$/.test(relative) &&
        !prepared.workspace.baseFiles.some((file) => file.path === relative))
    );
  }
  if (approval?.kind === 'command' && tool === 'run_command') {
    if (args.background || args.workdir || args.cwd) return false;
    if (
      caseDef.id === 'E09' &&
      prepared.workspace.scenario &&
      args.command === 'node evaluation-workload.cjs'
    )
      return true;
    return caseDef.publicCheck.some((test) => args.command === `node --test ${test}`);
  }
  return false;
}
async function dependenciesReady(directory, lockDirectory = directory) {
  const receipt = JSON.parse(
    await readFile(path.join(directory, '.evaluation-dependencies.json'), 'utf8'),
  );
  if (
    !receipt.private ||
    receipt.lockHash !== hash(await readFile(path.join(lockDirectory, 'package-lock.json')))
  )
    throw new Error('Private dependency lock mismatch');
  if ((await lstat(path.join(directory, 'node_modules'))).isSymbolicLink())
    throw new Error('Shared/linked node_modules forbidden');
  if (hash(await inventory(path.join(directory, 'node_modules'))) !== receipt.filesHash)
    throw new Error('Private dependency content changed');
  return receipt;
}
export async function runCliSample(input, _signal) {
  requireLiveAuthorization(input.manifest);
  throw new Error(
    'CLI adapter blocked: PRODUCT_SCOPE.cli=false; retained JSONL decoder is offline only',
  );
}
export async function runHostSample(input, signal) {
  const offlineProbe = input.offlineProbe === true;
  const manifest = offlineProbe ? input.manifest : requireLiveAuthorization(input.manifest);
  if (offlineProbe) {
    const endpoint = new URL(manifest.endpointUrl);
    if (
      endpoint.protocol !== 'http:' ||
      endpoint.hostname !== '127.0.0.1' ||
      manifest.model !== 'coding-evaluation-fixture' ||
      input.providerKey !== 'coding-evaluation-fake-key'
    )
      throw new Error(
        'Offline Host probe requires a numeric loopback fixture endpoint and fake identity',
      );
  } else assertOfflineReceipt(input.offlineReceipt, input.frozen.runtimeHash);
  signal.throwIfAborted();
  await assertFrozen(input.frozen);
  await dependenciesReady(input.frozen.runtimeDirectory);
  if (!offlineProbe)
    await dependenciesReady(input.prepared.workspace.directory, input.frozen.corpusDirectory);
  const key = offlineProbe ? input.providerKey : process.env.YUANTU_API_KEY;
  if (!key)
    throw new Error(
      'Explicit YUANTU_API_KEY credential is required; no user credential-store fallback',
    );
  /**
   * Which cases this adapter can drive.
   *
   * Every case is sampled through the Agent Host, which is the product's real entry for a task that edits a
   * workspace. The paused surfaces are a different matter: `PRODUCT_SCOPE.cli` is false, so a task whose
   * requirement is a CLI flag cannot be completed by the product at all. That is a product fact the report has to
   * state, not a harness defect — so those cases are graded from the workspace the Host produces (which will not
   * contain the flag) rather than being refused here. E09's cancellation and restart lifecycle is the one
   * exception: without an owned workload script and a two-phase Host restart it cannot be triggered at all, and a
   * refusal is the honest answer.
   */
  if (input.caseDef.id === 'E09' && !input.scenarioPhase)
    return runE09Sample(input, signal, runHostSample);
  const subagents = input.caseDef.id === 'E10';
  const { AgentHostClient } = await import(
    pathToFileURL(path.join(input.frozen.runtimeDirectory, 'packages/client/host-client.ts')).href
  );
  const { PermissionPolicy } = await import(
    pathToFileURL(path.join(input.frozen.runtimeDirectory, 'packages/core/permissions.ts')).href
  );
  const policy = {
    version: 1,
    rules: [
      { kind: 'external', effect: 'deny' },
      { kind: 'write', effect: 'ask' },
      { kind: 'command', effect: 'ask' },
    ],
  };
  new PermissionPolicy(policy);
  await mkdir(input.evidenceDirectory, { recursive: true });
  await writeFile(
    path.join(input.evidenceDirectory, 'approval-policy.json'),
    JSON.stringify(
      {
        policy,
        responderSourceHash: hash(await readFile(new URL(import.meta.url))),
        allowedPaths: input.caseDef.allowedPaths,
        commands: input.caseDef.publicCheck.map((test) => `node --test ${test}`),
      },
      null,
      2,
    ),
  );
  const env = controlledEnvironment(
    manifest,
    { ...process.env, YUANTU_API_KEY: key },
    { subagents },
  );
  const home = path.join(input.evidenceDirectory, 'private-home');
  await mkdir(home, { recursive: true });
  env.HOME = env.USERPROFILE = env.APPDATA = env.LOCALAPPDATA = home;
  env.TEMP = env.TMP = home;
  const client = new AgentHostClient({
    nodePath: process.execPath,
    hostPath: path.join(input.frozen.runtimeDirectory, 'apps/agent-host/main.ts'),
    workspace: input.prepared.workspace.directory,
    db: input.databasePath ?? path.join(input.evidenceDirectory, 'session.sqlite'),
    env,
    requestTimeoutMs: manifest.requestTimeoutMs,
    shutdownTimeoutMs: 15_000,
    deferAutomatic: true,
  });
  const events = [],
    runs = [],
    sessionRecords = [],
    interactionPromises = [],
    interactions = [];
  let startedAt = null,
    session = null,
    pid = null,
    terminalSeen = false,
    cleanupConfirmed = false,
    failureClass = null,
    timedOut = false,
    runStartError = null;
  const controller = new AbortController();
  const combined = AbortSignal.any([signal, controller.signal]);
  const zeroTiming = { wallMs: 0, setupMs: 0, verificationMs: 0, cleanupMs: 0 };
  const unsubscribe = client.subscribe((event) => {
    const atMs = startedAt === null ? 0 : Math.max(0, performance.now() - startedAt);
    const sanitized = JSON.parse(redact(JSON.stringify(event), [key]));
    events.push({ atMs, event: sanitized });
    if (event.type === 'approval.required') {
      const approval = event.data.approval;
      const approvalId = event.data.approvalId;
      const allow = approvalAllowed(approval, input.prepared, input.caseDef);
      interactions.push({ type: 'fixed-approval', atMs, approvalId, allow });
      interactionPromises.push(
        client.request('approval.respond', { approvalId, allow }).catch(() => {
          failureClass ??= 'approval-response';
          controller.abort();
        }),
      );
    }
    if (event.type === 'question.required') {
      const request = event.data.request;
      const questionId = event.data.questionId;
      interactions.push({ type: 'unanswered-question', atMs, questionId });
      interactionPromises.push(
        client.request('question.respond', { questionId, cancelled: true }).catch(() => {
          failureClass ??= 'question-response';
          controller.abort();
        }),
      );
    }
    if (event.type === 'provider.request.finished') {
      const metrics = collectMetrics({ events, runs: [], sessionRecords: [], timing: zeroTiming });
      if (metrics.requests >= manifest.maxObservedRequestsPerSample) {
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
  let timer;
  /**
   * The request the run is settled by, and the cancellation that may settle it instead.
   *
   * `run.start` is what carries the reply, so it is also the frame a cancellation replaces: the Host aborts the
   * run and answers `run.start` with an aborted-request error rather than resolving a `cancelled` RunResult. A
   * case that is cancelled therefore has no result to record — but it does have evidence (the cancel request was
   * answered, the run slot was released) and the difference matters, because "cancelled with evidence" and
   * "the Host died" must not be graded the same way.
   */
  let cancellation = null;
  let cancellationPromise = null;
  const watcherController = new AbortController();
  let watcherPromise = null,
    resumedHistoryReadable = false,
    historyHash = null;
  let delegation = null;
  try {
    await client.start();
    pid = client.pid;
    await client.request('permission.update', { policy });
    if (input.resumeSessionId) {
      const previous = await client.request('session.get', { sessionId: input.resumeSessionId });
      session = previous.session;
      resumedHistoryReadable =
        session.id === input.resumeSessionId &&
        Array.isArray(previous.messages) &&
        previous.messages.length > 0 &&
        hash(previous.messages) === input.expectedHistoryHash;
      if (!resumedHistoryReadable)
        throw new Error('E09 durable history changed across the normal Host restart');
    } else session = await client.request('session.create', {});
    startedAt = performance.now();
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, manifest.caseTimeoutMs[input.caseDef.id]);
    const cancelWhenAborted = () => {
      const atMs = performance.now();
      cancellation = { acknowledged: false, requestedAtMs: atMs };
      cancellationPromise = client.request('run.cancel', { sessionId: session.id }).then(
        (answer) => {
          cancellation = {
            acknowledged: answer?.cancelled === true,
            requestedAtMs: atMs,
            settledAtMs: performance.now(),
          };
        },
        (error) => {
          cancellation = {
            acknowledged: false,
            requestedAtMs: atMs,
            settledAtMs: performance.now(),
            error: redact(error instanceof Error ? error.message : String(error), [key]),
          };
        },
      );
    };
    combined.throwIfAborted();
    combined.addEventListener('abort', cancelWhenAborted, { once: true });
    if (input.scenarioPhase === 'cancel') {
      watcherPromise = waitForWorkloadReady(
        input.prepared.workspace,
        AbortSignal.any([combined, watcherController.signal]),
      ).then(
        () => controller.abort('scheduled-E09-cancellation'),
        (error) => {
          if (!combined.aborted && !watcherController.signal.aborted) {
            failureClass ??= 'E09-workload-ready';
            controller.abort(error);
          }
        },
      );
    }
    try {
      // The adapter owns the one cancel RPC and its settlement; do not issue a second cancel via client.run.
      const run = await client.run(session.id, input.prepared.prompt);
      runs.push(JSON.parse(redact(JSON.stringify(run), [key])));
      terminalSeen =
        run.sessionId === session.id &&
        typeof run.runId === 'string' &&
        events.some(
          (item) =>
            item.event.type === 'run.finished' &&
            item.event.runId === run.runId &&
            item.event.sessionId === session.id,
        );
      if (!terminalSeen) failureClass = 'identity';
    } catch (error) {
      if (!cancellation) throw error;
      const message = error instanceof Error ? error.message : String(error);
      runStartError = redact(message, [key]);
      if (!/abort/i.test(message)) failureClass ??= 'cancelled-run-nonabort-error';
    } finally {
      combined.removeEventListener('abort', cancelWhenAborted);
      watcherController.abort();
      if (watcherPromise) await watcherPromise;
      if (cancellationPromise) await cancellationPromise;
    }
    if (cancellation) {
      // Settle the answer before reading state: a cancel that was never acknowledged cannot prove the run ended.
      let state;
      for (let attempt = 0; attempt < 100; attempt++) {
        state = await client.request('session.get', { sessionId: session.id });
        if ((state.session?.activeRun ?? null) === null) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      cancellation.runSlotReleased = (state.session?.activeRun ?? null) === null;
      cancellation.terminalSettled =
        cancellation.acknowledged === true && cancellation.runSlotReleased;
    }
    const sessions = await client.request('session.list', {});
    const own = sessions.filter(
      (candidate) => candidate.id === session.id || candidate.parentSessionId === session.id,
    );
    /**
     * E10 is the one case whose *scenario* is delegation, so the harness has to be able to say whether a real
     * delegation happened. A parent's own report is not evidence: what is counted is child sessions the Host
     * actually created under this one, together with their settlements. E01–E09 run with delegation disabled, so
     * this check stays absent there rather than silently passing.
     */
    if (input.caseDef.id === 'E10') {
      const children = own.filter((candidate) => candidate.parentSessionId === session.id);
      const settledChildren = new Set(
        events
          .filter((item) => item.event.type === 'subagent.finished')
          .map((item) => item.event.data?.sessionId)
          .filter(Boolean),
      );
      delegation = {
        childSessionIds: children.map((child) => child.id),
        childSessions: children.length,
        settledChildren: children.filter((child) => settledChildren.has(child.id)).length,
      };
    }
    for (const candidate of own) {
      const state = await client.request('session.get', { sessionId: candidate.id });
      if (candidate.id === session.id) historyHash = hash(state.messages);
      const durable = [];
      let afterSeq = 0;
      for (;;) {
        // The Host reads pages of at most 500 entries, so this collector pages at that size.
        const page = await client.request('session.events', {
          sessionId: candidate.id,
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
          redact(
            JSON.stringify({
              sessionId: candidate.id,
              parentSessionId: candidate.parentSessionId ?? null,
              runIds: [...new Set(durable.map((event) => event.data.runId).filter(Boolean))],
              events: durable,
              statistics: state.statistics,
            }),
            [key],
          ),
        ),
      );
    }
  } catch (error) {
    failureClass ??=
      cancellation || (error instanceof Error && error.name === 'AbortError')
        ? 'cancelled'
        : 'host-or-environment';
    await writeFile(
      path.join(input.evidenceDirectory, 'adapter-error.txt'),
      redact(error instanceof Error ? error.message : String(error), [key]),
    );
  } finally {
    clearTimeout(timer);
    watcherController.abort();
    if (watcherPromise) await watcherPromise;
    if (cancellationPromise) await cancellationPromise;
    await Promise.allSettled(interactionPromises);
    const cleanupStart = performance.now();
    try {
      await client.stop();
      cleanupConfirmed = client.status === 'stopped' && client.pid === undefined;
    } catch {
      failureClass ??= 'host-cleanup';
    }
    zeroTiming.cleanupMs = Math.max(0, performance.now() - cleanupStart);
    zeroTiming.wallMs = startedAt === null ? 0 : Math.max(0, cleanupStart - startedAt);
    unsubscribe();
    await writeFile(
      path.join(input.evidenceDirectory, 'host-cleanup.json'),
      JSON.stringify(
        { ownedPid: pid, cleanupConfirmed, status: client.status, live: !offlineProbe },
        null,
        2,
      ),
    );
  }
  const result = {
    runs,
    events,
    sessionRecords,
    exitCode: failureClass ? 1 : 0,
    terminalSeen,
    timing: zeroTiming,
    cleanupConfirmed,
    failureClass,
    timedOut,
    interactions,
    cancellation,
    delegation,
    runStartError,
    resumedHistoryReadable,
    historyHash,
    live: !offlineProbe,
  };
  await writeFile(
    path.join(input.evidenceDirectory, 'adapter.json'),
    JSON.stringify(result, null, 2),
  );
  await assertFrozen(input.frozen);
  return result;
}
