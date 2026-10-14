import { hash } from './materialize.mjs';

const usageKeys = ['inputTokens', 'outputTokens', 'cachedInputTokens', 'cacheWriteInputTokens'];
const number = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0;
export function collectMetrics({ events, runs: _runs, sessionRecords, timing }) {
  const requests = new Map();
  const tools = new Set();
  const settlements = new Map();
  let firstVisibleTextMs = null;
  function consume(event, atMs) {
    const data = event.data ?? {};
    const runId = event.runId ?? data.runId;
    const key = `${event.sessionId}\0${runId}\0`;
    if (event.type === 'provider.request.finished') {
      if (!event.sessionId || !runId || !Number.isSafeInteger(data.requestId))
        throw new Error('Request identity missing');
      const id = key + data.requestId;
      const normalized = Object.fromEntries(
        Object.entries(data).filter(([key]) => key !== 'runId'),
      );
      if (requests.has(id) && hash(requests.get(id)) !== hash(normalized))
        throw new Error('Conflicting request replay');
      requests.set(id, normalized);
    }
    // `tool.execution.started` carries `callId`, while `tool.started` carries `id`. Counting only the latter
    // reported zero tool calls for every live sample — a number the report is supposed to show.
    if (
      (event.type === 'tool.started' && data.id) ||
      (event.type === 'tool.execution.started' && data.callId)
    )
      tools.add(key + (data.id ?? data.callId));
    if (event.type === 'subagent.finished') {
      if (!data.sessionId || !data.id) throw new Error('Subagent settlement identity missing');
      const id = `${event.sessionId}\0${data.id}\0${data.childRunId ?? runId}`;
      const value = {
        parentSessionId: event.sessionId,
        sessionId: data.sessionId,
        usage: data.usage,
      };
      if (settlements.has(id) && hash(settlements.get(id)) !== hash(value))
        throw new Error('Conflicting subagent settlement');
      settlements.set(id, value);
    }
    if (
      event.type === 'message.delta' &&
      typeof data.text === 'string' &&
      data.text.trim() &&
      number(atMs)
    )
      firstVisibleTextMs = firstVisibleTextMs === null ? atMs : Math.min(firstVisibleTextMs, atMs);
  }
  for (const item of events) consume(item.event, item.atMs);
  const records = new Map();
  for (const record of sessionRecords) {
    if (records.has(record.sessionId)) throw new Error('Duplicate session record');
    records.set(record.sessionId, record);
    for (const event of record.events ?? [])
      consume({ ...event, sessionId: record.sessionId }, undefined);
  }
  let complete = records.size > 0;
  for (const record of records.values()) {
    const seen = new Set([record.sessionId]);
    let current = record;
    while (current.parentSessionId) {
      if (seen.has(current.parentSessionId) || !records.has(current.parentSessionId))
        throw new Error('Invalid session lineage');
      seen.add(current.parentSessionId);
      current = records.get(current.parentSessionId);
    }
    complete &&=
      record.statistics?.usageComplete === true && record.statistics?.cacheKnown === true;
  }
  const usage = Object.fromEntries(
    usageKeys.map((key) => [
      key,
      records.size && [...records.values()].every((r) => number(r.statistics?.[key]))
        ? [...records.values()].reduce((sum, r) => sum + r.statistics[key], 0)
        : null,
    ]),
  );
  // Current coordinator folds each settled child into parent statistics. Subtract that
  // exact settlement once, then keep every child's durable statistics once.
  for (const settlement of settlements.values()) {
    const child = records.get(settlement.sessionId);
    if (!child || child.parentSessionId !== settlement.parentSessionId) complete = false;
    for (const key of usageKeys) {
      if (usage[key] !== null && number(settlement.usage?.[key]))
        usage[key] -= settlement.usage[key];
      else {
        usage[key] = null;
        complete = false;
      }
      if (usage[key] !== null && usage[key] < 0)
        throw new Error('Subagent rollup exceeds recorded usage');
    }
  }
  for (const record of records.values())
    if (
      record.parentSessionId &&
      ![...settlements.values()].some((s) => s.sessionId === record.sessionId)
    )
      complete = false;
  if ([...requests.values()].some((r) => r.failed)) complete = false;
  if (usageKeys.some((key) => usage[key] === null)) complete = false;
  return {
    ...timing,
    firstVisibleTextMs,
    requests: requests.size || null,
    summaryRequests: requests.size
      ? [...requests.values()].filter((r) => r.purpose === 'summary').length
      : null,
    toolCalls: tools.size,
    usage: { ...usage, complete },
    cost: { amount: null, currency: null, source: null },
  };
}
export function gradeSample({
  sample,
  manifest,
  frozen,
  prepared,
  oracleHash,
  configHash,
  adapter,
  verification,
  humanInterventions,
  live,
  evidenceDirectory,
}) {
  const metrics = collectMetrics({
    events: adapter.events,
    runs: adapter.runs,
    sessionRecords: adapter.sessionRecords,
    timing: adapter.timing,
  });
  const agentStatus = adapter.runs.at(-1)?.status ?? null;
  const independentPass = verification.passed && !verification.timedOut && !verification.tampered;
  /**
   * A cancelled sample is not an invalid one.
   *
   * The Host answers a cancellation by aborting the run, so `run.start` never resolves a final result and there
   * is no terminal frame to match. Treating that as `invalid` would erase a real, evidenced cancellation from the
   * report and blame the harness for a product behaviour; the plan pays for cancellation only in E09's scheduled
   * phase, so this is a `cancelled` outcome — recorded, never a pass.
   */
  const cancelled = adapter.cancellation !== null && adapter.cancellation !== undefined;
  const cancellationSettled =
    !cancelled ||
    (adapter.cancellation.acknowledged === true &&
      adapter.cancellation.terminalSettled === true &&
      adapter.cancellation.runSlotReleased === true &&
      adapter.cleanupConfirmed === true);
  /**
   * E10 fails without a real delegation. The plan is explicit that "no sub-agent call" is a scenario failure and
   * that a parent's own report is not evidence — so what decides it is the adapter's count of child sessions the
   * Host actually created under this one, together with their settlements.
   */
  const delegationMissing =
    sample.caseId === 'E10' &&
    !(adapter.delegation?.childSessions >= 2 && adapter.delegation?.settledChildren >= 2);
  let outcome = 'failed';
  if (
    verification.tampered ||
    !cancellationSettled ||
    (!cancelled && !adapter.terminalSeen) ||
    adapter.failureClass === 'identity'
  )
    outcome = 'invalid';
  else if (adapter.timedOut) outcome = 'timeout';
  else if (cancelled || agentStatus === 'cancelled') outcome = 'cancelled';
  else if (
    live &&
    independentPass &&
    !delegationMissing &&
    adapter.exitCode === 0 &&
    agentStatus === 'completed' &&
    adapter.cleanupConfirmed
  )
    outcome = 'passed';
  return {
    version: 1,
    ...sample,
    batchId: manifest.batchId,
    category: Number(sample.caseId.slice(1)) <= 8 ? 'coding' : 'operational',
    live,
    runtimeHash: frozen.runtimeHash,
    corpusHash: frozen.corpusHash,
    promptHash: prepared.promptHash,
    oracleHash,
    configHash,
    outcome,
    agentStatus,
    runIds: adapter.runs.map((r) => r.runId),
    sessionIds: adapter.sessionRecords.map((r) => r.sessionId),
    checks: verification.checks,
    independentPass,
    unassistedPass: outcome === 'passed' && humanInterventions.length === 0,
    humanInterventions,
    ...metrics,
    cleanupConfirmed: adapter.cleanupConfirmed,
    failureClass:
      adapter.failureClass ??
      (!cancellationSettled ? 'cancellation-unconfirmed' : null) ??
      (outcome === 'passed'
        ? null
        : delegationMissing
          ? 'delegation-missing'
          : 'independent-verification'),
    evidenceDirectory,
  };
}
export function aggregateResults(results, planned) {
  const expected = new Map(planned.map((p) => [p.sampleId, p]));
  if (expected.size !== planned.length) throw new Error('Duplicate planned sample ID');
  const actual = new Set();
  const comparable = new Map();
  const prompts = new Map();
  const outcomes = Object.fromEntries(
    ['passed', 'failed', 'timeout', 'cancelled', 'blocked', 'invalid'].map((id) => [id, 0]),
  );
  const groups = { coding: { planned: 0, passed: 0 }, operational: { planned: 0, passed: 0 } };
  for (const result of results) {
    if (actual.has(result.sampleId)) throw new Error('Duplicate result sample ID');
    actual.add(result.sampleId);
    const plan = expected.get(result.sampleId);
    if (
      !plan ||
      plan.caseId !== result.caseId ||
      plan.repeat !== result.repeat ||
      plan.variantId !== result.variantId
    )
      throw new Error('Unexpected sample identity');
    if (!Object.hasOwn(outcomes, result.outcome)) throw new Error('Unknown result outcome');
    if (result.unassistedPass && (result.outcome !== 'passed' || result.humanInterventions.length))
      throw new Error('Unassisted result includes assistance');
    if (
      result.outcome === 'passed' &&
      (!result.live || !result.independentPass || !result.cleanupConfirmed)
    )
      throw new Error('Unverified/fixture success cannot count');
    const signature = JSON.stringify([
      result.batchId,
      result.live,
      result.corpusHash,
      result.oracleHash,
      result.configHash,
      result.runtimeHash,
    ]);
    const prior = comparable.get(result.variantId);
    if (prior && prior !== signature)
      throw new Error('Incomparable runtime/corpus/oracle/config inputs');
    comparable.set(result.variantId, signature);
    const promptKey = `${result.caseId}:${result.variantId}`;
    if (prompts.has(promptKey) && prompts.get(promptKey) !== result.promptHash)
      throw new Error('Incomparable prompt inputs');
    prompts.set(promptKey, result.promptHash);
    outcomes[result.outcome]++;
    groups[result.category].planned++;
    groups[result.category].passed += Number(result.outcome === 'passed');
  }
  if (actual.size !== expected.size) throw new Error('Missing planned sample result');
  const validStarted = results.filter(
    (r) => r.live && !['blocked', 'invalid'].includes(r.outcome),
  ).length;
  const complete = outcomes.blocked === 0 && outcomes.invalid === 0;
  const costsKnown =
    results.length > 0 &&
    results.every((r) => number(r.cost.amount) && r.cost.currency && r.usage.complete);
  const currencies = new Set(results.map((r) => r.cost.currency).filter(Boolean));
  if (currencies.size > 1) throw new Error('Incomparable cost currencies');
  return {
    plannedCount: planned.length,
    recordedCount: results.length,
    complete,
    outcomes,
    completionRate: planned.length ? outcomes.passed / planned.length : 0,
    unassistedRate: planned.length
      ? results.filter((r) => r.unassistedPass).length / planned.length
      : 0,
    validStartedRate: validStarted ? outcomes.passed / validStarted : null,
    usageComplete: results.length > 0 && results.every((r) => r.usage.complete),
    cost: {
      amount: costsKnown ? results.reduce((sum, r) => sum + r.cost.amount, 0) : null,
      currency: costsKnown ? [...currencies][0] : null,
      source: costsKnown ? 'recorded-provider-billing' : null,
    },
    groups,
  };
}
export function distribution(values) {
  const sorted = values.filter(number).sort((a, b) => a - b);
  if (!sorted.length) return { median: null, min: null, max: null, count: 0 };
  const middle = Math.floor(sorted.length / 2);
  return {
    median: sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2,
    min: sorted[0],
    max: sorted.at(-1),
    count: sorted.length,
  };
}
