import { createServer } from 'node:http';
import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { materializeCase } from './materialize.mjs';
import { getCase, prepareCase } from './cases.mjs';
import { runHostSample, redact } from './adapters.mjs';

export function assertOfflineReceipt(receipt, runtimeHash) {
  const completion = receipt?.observed?.completion;
  const cancellation = receipt?.observed?.cancellation;
  if (
    receipt?.version !== 2 ||
    receipt?.kind !== 'fake-endpoint-self-check' ||
    receipt.runtimeHash !== runtimeHash ||
    receipt.checksPassed !== true ||
    receipt.observed?.credentialLeaked !== false ||
    completion?.terminalSeen !== true ||
    completion.cleanupConfirmed !== true ||
    completion.status !== 'completed' ||
    !(completion.requests > 0) ||
    cancellation?.acknowledged !== true ||
    cancellation.terminalSettled !== true ||
    cancellation.runSlotReleased !== true ||
    cancellation.cleanupConfirmed !== true ||
    !(cancellation.requests > 0)
  )
    throw new Error('Frozen runtime fake-endpoint self-check receipt missing or incomplete');
}

/**
 * The fake-endpoint self-check that has to pass before a live batch may spend anything.
 *
 * `runHostSample` refuses a live sample without a receipt for *this* frozen runtime, and that refusal is the point
 * of the plan's task 3: a live batch is only allowed to create a real provider after the same adapter path has
 * been driven end to end against a loopback fixture. So the receipt cannot be a constant — something has to earn
 * it. This runs one full sample (materialize, prepare, Host, model round, cancel-free cleanup) against a local
 * server that answers with a fixed completion, and reports exactly what it observed.
 *
 * It is deliberately not a dry-run substitute: no case is graded, no result is recorded, and the fixture identity
 * (`coding-evaluation-fixture` plus a fake key) is the one the adapter's offline branch requires.
 */
export async function fakeEndpointSelfCheck({
  frozen,
  manifest,
  directory,
  providerKey = 'coding-evaluation-fake-key',
  signal = new AbortController().signal,
}) {
  signal.throwIfAborted();
  await mkdir(directory, { recursive: true });
  const caseDef = getCase('E02');
  const requests = [];
  let variant = 'completion',
    cancelController;
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const payload = JSON.parse(Buffer.concat(chunks).toString());
    requests.push({ variant, model: payload.model, messages: payload.messages?.length ?? 0 });
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    if (variant === 'cancellation' && JSON.stringify(payload.messages).includes(caseDef.prompt)) {
      response.write(': fixture waiting for cancellation\n\n');
      cancelController.abort();
      return;
    }
    for (const data of [
      {
        id: 'fixture',
        object: 'chat.completion.chunk',
        model: payload.model,
        choices: [
          { index: 0, delta: { content: 'The self-check completed.' }, finish_reason: null },
        ],
      },
      {
        id: 'fixture',
        object: 'chat.completion.chunk',
        model: payload.model,
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        usage: {
          prompt_tokens: 20,
          completion_tokens: 10,
          prompt_tokens_details: { cached_tokens: 0 },
        },
      },
    ])
      response.write(`data: ${JSON.stringify(data)}\n\n`);
    response.end('data: [DONE]\n\n');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : null;
  if (!port) throw new Error('Self-check fixture did not bind a loopback port');

  const probeManifest = {
    ...manifest,
    model: 'coding-evaluation-fixture',
    protocol: 'openai',
    endpointId: 'numeric-loopback-fixture',
    endpointUrl: `http://127.0.0.1:${port}/v1`,
    caseTimeoutMs: {
      ...manifest.caseTimeoutMs,
      E02: Math.min(manifest.caseTimeoutMs.E02, 120_000),
    },
  };
  const detail = { checksPassed: false, observed: { credentialLeaked: false }, error: null };
  try {
    for (variant of ['completion', 'cancellation']) {
      signal.throwIfAborted();
      cancelController = new AbortController();
      const workspace = await materializeCase({
        frozen,
        caseId: 'E02',
        sampleId: `self-check-${variant}`,
        outputDirectory: path.join(directory, variant, 'workspace'),
      });
      const prepared = await prepareCase(caseDef, workspace);
      const evidenceDirectory = path.join(directory, variant, 'evidence');
      await mkdir(evidenceDirectory, { recursive: true });
      const result = await runHostSample(
        {
          manifest: probeManifest,
          prepared,
          caseDef,
          frozen,
          evidenceDirectory,
          offlineProbe: true,
          providerKey,
        },
        AbortSignal.any([signal, cancelController.signal]),
      );
      const leaks = JSON.stringify(result).includes(providerKey);
      detail.observed.credentialLeaked ||= leaks;
      detail.observed[variant] = {
        terminalSeen: result.terminalSeen,
        cleanupConfirmed: result.cleanupConfirmed,
        status: result.runs[0]?.status ?? null,
        requests: requests.filter((request) => request.variant === variant).length,
        ...(result.cancellation ?? {}),
      };
      if (result.live !== false) throw new Error('Fixture unexpectedly marked live');
    }
    detail.checksPassed = true;
    try {
      assertOfflineReceipt(
        {
          version: 2,
          kind: 'fake-endpoint-self-check',
          runtimeHash: frozen.runtimeHash,
          ...detail,
        },
        frozen.runtimeHash,
      );
    } catch {
      detail.checksPassed = false;
    }
  } catch (error) {
    detail.error = redact(error instanceof Error ? error.message : String(error), [providerKey]);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }

  const receipt = {
    version: 2,
    kind: 'fake-endpoint-self-check',
    runtimeHash: frozen.runtimeHash,
    checksPassed: detail.checksPassed,
    observed: detail.observed,
    error: detail.error,
    recordedAt: new Date().toISOString(),
  };
  await writeFile(path.join(directory, 'self-check.json'), `${JSON.stringify(receipt, null, 2)}\n`);
  return receipt;
}
