import path from 'node:path';
import type { AgentEvent, RunResult } from '../../packages/protocol/index.ts';
import type { SessionStatistics } from '../../packages/protocol/statistics.ts';

export type SourceSpec =
  | { kind: 'commit'; directory: string; revision: string }
  | { kind: 'snapshot'; directory: string; manifestSha256: string };
export type FileFingerprint = { path: string; size: number; sha256: string };
export interface FrozenInputs {
  runtimeDirectory: string;
  corpusDirectory: string;
  runtimeHash: string;
  corpusHash: string;
  runtimeFiles: FileFingerprint[];
  corpusFiles: FileFingerprint[];
}
export interface CaseWorkspace {
  directory: string;
  sampleId: string;
  baseHash: string;
  baseFiles: FileFingerprint[];
}
export interface CaseDefinition {
  id: string;
  category: 'coding' | 'operational';
  prompt: string;
  timeoutMs: number;
  allowedPaths: string[];
  publicCheck: string[];
  seed: { path: string; before: string; after: string } | null;
  oracle: string;
  reference: string;
  blockedReason?: string;
}
export interface PreparedCase {
  workspace: CaseWorkspace;
  prompt: string;
  promptHash: string;
  seedHash: string | null;
  allowedPaths: string[];
}
export interface RecordedEvent {
  atMs: number;
  event: AgentEvent;
}
export interface SessionRecord {
  sessionId: string;
  parentSessionId: string | null;
  runIds: string[];
  events: { type: string; data: Record<string, unknown> }[];
  statistics: SessionStatistics | undefined;
}
export interface SampleTiming {
  wallMs: number;
  setupMs: number;
  verificationMs: number;
  cleanupMs: number;
}
export interface AdapterResult {
  runs: RunResult[];
  events: RecordedEvent[];
  sessionRecords: SessionRecord[];
  exitCode: number | null;
  terminalSeen: boolean;
  timing: SampleTiming;
  cleanupConfirmed: boolean;
  failureClass?: string;
  timedOut?: boolean;
}
export interface VerificationResult {
  checks: { id: string; passed: boolean; evidence: string }[];
  passed: boolean;
  timedOut: boolean;
  tampered: boolean;
  regressionExitCode: number | null;
}
export interface PlannedSample {
  sampleId: string;
  caseId: string;
  variantId: string;
  repeat: number;
}
export interface EvaluationManifest {
  version: 1;
  suiteVersion: 'project-seeded-v1';
  batchId: string;
  runtimeSource: SourceSpec;
  corpusSource: SourceSpec;
  cases: string[];
  repeats: 1 | 3;
  model: string | null;
  protocol: string | null;
  endpointId: string | null;
  endpointUrl: string | null;
  maxContextTokens: number;
  maxOutputTokens: number;
  reasoning: string;
  promptCache: 'off';
  toolMode: 'deferred';
  sandbox: 'host';
  caseConcurrency: 1;
  caseTimeoutMs: Record<string, number>;
  requestTimeoutMs: number;
  streamIdleTimeoutMs: number;
  verificationTimeoutMs: number;
  maxLiveAttempts: number;
  maxObservedRequestsPerSample: number;
  maxKnownTokensPerSample: number;
  approvedLiveBudget: {
    authorized: boolean;
    maxAttempts: number;
    maxCurrency: number | null;
    currency: string | null;
    pricingSha256: string | null;
  };
  approvalMode: 'fixed-policy' | 'interactive';
}
export interface SampleInput {
  manifest: EvaluationManifest;
  prepared: PreparedCase;
  frozen: FrozenInputs;
  evidenceDirectory: string;
  offlineReceipt?: { runtimeHash: string; checksPassed: boolean };
}
export interface SampleMetrics extends SampleTiming {
  firstVisibleTextMs: number | null;
  requests: number | null;
  summaryRequests: number | null;
  toolCalls: number;
  /** Empty attempts this sample sent again, on the allowance its manifest asked for (`zeroByteRetries`). */
  zeroByteRetries: number;
  usage: {
    inputTokens: number | null;
    outputTokens: number | null;
    cachedInputTokens: number | null;
    cacheWriteInputTokens: number | null;
    complete: boolean;
  };
  cost: { amount: number | null; currency: string | null; source: string | null };
}
export type Outcome = 'passed' | 'failed' | 'timeout' | 'cancelled' | 'blocked' | 'invalid';
export interface SampleResult extends PlannedSample, SampleMetrics {
  version: 1;
  batchId: string;
  category: 'coding' | 'operational';
  live: boolean;
  runtimeHash: string;
  corpusHash: string;
  promptHash: string;
  oracleHash: string;
  configHash: string;
  outcome: Outcome;
  agentStatus: string | null;
  runIds: string[];
  sessionIds: string[];
  checks: VerificationResult['checks'];
  independentPass: boolean;
  unassistedPass: boolean;
  humanInterventions: { kind: string; atMs: number; note: string }[];
  cleanupConfirmed: boolean;
  failureClass: string | null;
  evidenceDirectory: string;
}
export interface GradeInput {
  sample: PlannedSample;
  manifest: EvaluationManifest;
  frozen: FrozenInputs;
  prepared: PreparedCase;
  oracleHash: string;
  configHash: string;
  adapter: AdapterResult;
  verification: VerificationResult;
  humanInterventions: SampleResult['humanInterventions'];
  live: boolean;
  evidenceDirectory: string;
}
export interface BatchSummary {
  plannedCount: number;
  recordedCount: number;
  complete: boolean;
  outcomes: Record<Outcome, number>;
  completionRate: number;
  unassistedRate: number;
  validStartedRate: number | null;
  usageComplete: boolean;
  cost: SampleMetrics['cost'];
  groups: Record<string, { planned: number; passed: number }>;
}
export interface BatchResult {
  planned: PlannedSample[];
  results: SampleResult[];
  summary: BatchSummary;
  evidenceDirectory: string;
  exitCode: number;
}

const ids = Array.from({ length: 10 }, (_, i) => `E${String(i + 1).padStart(2, '0')}`);
const fail = (message: string): never => {
  throw new Error(`Invalid evaluation manifest: ${message}`);
};
const integer = (value: unknown, key: string, low = 1, high = Number.MAX_SAFE_INTEGER): number => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < low || value > high)
    fail(key);
  return value as number;
};
function source(value: any): void {
  if (!value || !['commit', 'snapshot'].includes(value.kind)) fail('source kind');
  if (typeof value.directory !== 'string' || !path.isAbsolute(value.directory))
    fail('source directory must be absolute');
  const keys =
    value.kind === 'commit'
      ? ['kind', 'directory', 'revision']
      : ['kind', 'directory', 'manifestSha256'];
  if (Object.keys(value).some((key) => !keys.includes(key))) fail('unknown source key');
  if (value.kind === 'commit' && !/^[a-f0-9]{40}$/.test(value.revision))
    fail('commit must be a full immutable revision');
  if (value.kind === 'snapshot' && !/^[a-f0-9]{64}$/.test(value.manifestSha256))
    fail('snapshot hash');
}
export function validateManifest(value: unknown): EvaluationManifest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('object required');
  const v = value as Record<string, any>;
  const keys = [
    'version',
    'suiteVersion',
    'batchId',
    'runtimeSource',
    'corpusSource',
    'cases',
    'repeats',
    'model',
    'protocol',
    'endpointId',
    'endpointUrl',
    'maxContextTokens',
    'maxOutputTokens',
    'reasoning',
    'promptCache',
    'toolMode',
    'sandbox',
    'caseConcurrency',
    'caseTimeoutMs',
    'requestTimeoutMs',
    'streamIdleTimeoutMs',
    'verificationTimeoutMs',
    'maxLiveAttempts',
    'maxObservedRequestsPerSample',
    'maxKnownTokensPerSample',
    'approvedLiveBudget',
    'approvalMode',
  ];
  if (Object.keys(v).some((key) => !keys.includes(key))) fail('unknown or credential key');
  if (keys.some((key) => !(key in v))) fail('missing field');
  if (v.version !== 1 || v.suiteVersion !== 'project-seeded-v1') fail('version');
  if (!/^[a-zA-Z0-9_-]{1,80}$/.test(v.batchId)) fail('batchId');
  source(v.runtimeSource);
  source(v.corpusSource);
  if (
    !Array.isArray(v.cases) ||
    !v.cases.length ||
    v.cases.some((id: string) => !ids.includes(id)) ||
    new Set(v.cases).size !== v.cases.length
  )
    fail('cases');
  if (![1, 3].includes(v.repeats) || v.caseConcurrency !== 1) fail('repeats or concurrency');
  if (v.sandbox !== 'host' || v.toolMode !== 'deferred' || v.promptCache !== 'off')
    fail('fixed mode');
  if (!['fixed-policy', 'interactive'].includes(v.approvalMode)) fail('approvalMode');
  if (typeof v.reasoning !== 'string' || !v.reasoning.length) fail('reasoning must be explicit');
  for (const key of ['model', 'protocol', 'endpointId', 'endpointUrl'])
    if (v[key] !== null && (typeof v[key] !== 'string' || !v[key].trim())) fail(key);
  if (v.protocol !== null && !['anthropic', 'openai', 'openai-responses'].includes(v.protocol))
    fail('protocol');
  if (v.endpointUrl !== null) {
    const u = new URL(v.endpointUrl);
    if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password || u.search || u.hash)
      fail('endpoint URL must not include credentials/query');
  }
  integer(v.maxContextTokens, 'context', 1);
  integer(v.maxOutputTokens, 'output', 1, 8192);
  for (const key of [
    'requestTimeoutMs',
    'streamIdleTimeoutMs',
    'verificationTimeoutMs',
    'maxLiveAttempts',
    'maxObservedRequestsPerSample',
    'maxKnownTokensPerSample',
  ])
    integer(v[key], key);
  if (!v.caseTimeoutMs || Object.keys(v.caseTimeoutMs).length !== 10)
    fail('all case timeouts required');
  for (const id of ids) integer(v.caseTimeoutMs[id], `timeout ${id}`);
  const b = v.approvedLiveBudget;
  if (
    !b ||
    Object.keys(b).sort().join(',') !==
      'authorized,currency,maxAttempts,maxCurrency,pricingSha256' ||
    typeof b.authorized !== 'boolean'
  )
    fail('budget');
  integer(b.maxAttempts, 'budget attempts', 0);
  if (
    b.maxCurrency !== null &&
    (typeof b.maxCurrency !== 'number' || !Number.isFinite(b.maxCurrency) || b.maxCurrency <= 0)
  )
    fail('currency budget');
  if (b.currency !== null && !/^[A-Z]{3}$/.test(b.currency)) fail('currency');
  if (b.pricingSha256 !== null && !/^[a-f0-9]{64}$/.test(b.pricingSha256)) fail('pricing hash');
  return structuredClone(value) as EvaluationManifest;
}
export function requireLiveAuthorization(value: unknown): EvaluationManifest {
  const v = validateManifest(value);
  if (!v.approvedLiveBudget.authorized || !v.approvedLiveBudget.maxAttempts)
    throw new Error('Live model requests are not authorized');
  if (!v.model || !v.protocol || !v.endpointId || !v.endpointUrl)
    throw new Error('Live model/endpoint identity is missing');
  if (v.reasoning !== 'off')
    throw new Error('Reasoning configuration has not been validated against this frozen runtime');
  if (v.approvalMode !== 'fixed-policy') throw new Error('Interactive responder not configured');
  if (v.approvedLiveBudget.maxCurrency !== null)
    throw new Error(
      'Hard currency control requires a verified provider gateway; local observation cannot enforce it',
    );
  return v;
}
