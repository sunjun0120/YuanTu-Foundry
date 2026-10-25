import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import ts from 'typescript';
import { assertFrozen, copyFiles, inventory, hash } from './materialize.mjs';
import { applyReference, prepareCase, casePreparationBlock, getCase, CASE_IDS } from './cases.mjs';
import { preparePrivateDependencies } from './dependencies.mjs';
import { assertWorkloadProtected, SCENARIO_STATE_FILES } from './scenario.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
export async function oracleFingerprint() {
  const files = (await inventory(root)).filter(
    (file) => /\.(?:mjs|ts|json)$/.test(file.path) && !file.path.startsWith('local/'),
  );
  return { files, hash: hash(files) };
}
export function runProcess(
  command,
  args,
  { cwd, timeoutMs = 180_000, env = process.env, maxBytes = 4_000_000 } = {},
) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '',
      stderr = '',
      timedOut = false,
      overflow = false;
    const collect = (target, buffer) => {
      if (target === 'stdout') stdout += buffer.toString('utf8');
      else stderr += buffer.toString('utf8');
      if (Buffer.byteLength(stdout) + Buffer.byteLength(stderr) > maxBytes) {
        overflow = true;
        child.kill();
      }
    };
    child.stdout.on('data', (chunk) => collect('stdout', chunk));
    child.stderr.on('data', (chunk) => collect('stderr', chunk));
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (exitCode, signal) => {
      clearTimeout(timer);
      resolve({
        command,
        args,
        exitCode,
        signal,
        stdout,
        stderr,
        timedOut,
        overflow,
        processClosed: true,
      });
    });
  });
}
/**
 * Read a TAP summary, and refuse anything that is not an honest pass.
 *
 * An empty run, a missing summary, a failure, a cancellation, a todo and a timed-out run are all failures here.
 *
 * `SKIP` is the one case that needs judgement rather than a blanket rule. A skip with no stated reason can hide a
 * disabled assertion, so a bare `# SKIP` always fails. A skip that names its reason is only accepted when the
 * case declares that reason for this platform: the frozen corpora legitimately contain tests that cannot run on
 * Windows at all (POSIX permission bits), and treating those as failures would make every Windows batch red for a
 * reason that has nothing to do with the candidate.
 */
export function parseTestSummary(stdout, exitCode, timedOut, caseDefinition) {
  const fields = Object.fromEntries(
    ['tests', 'pass', 'fail', 'cancelled', 'skipped', 'todo'].map((key) => [
      key,
      Number(new RegExp(`^# ${key} (\\d+)$`, 'm').exec(stdout)?.[1] ?? NaN),
    ]),
  );
  fields.skipped = Number.isNaN(fields.skipped) ? NaN : fields.skipped;
  const declared = caseDefinition?.platformSkips?.[process.platform] ?? [];
  const skips = [...stdout.matchAll(/^ok \d+ - .*? # SKIP(?: (.*))?$/gm)].map((match) =>
    (match[1] ?? '').trim(),
  );
  const unexplained = skips.filter((reason) => !reason || !declared.includes(reason));
  fields.skips = skips;
  fields.unexplainedSkips = unexplained;
  return {
    ...fields,
    passed:
      exitCode === 0 &&
      !timedOut &&
      fields.tests > 0 &&
      /**
       * A test that ran and a test that was skipped are not the same thing, so the counts have to add up rather
       * than `pass` having to equal `tests`. Every skip must additionally be one this case declared for this
       * platform *with a stated reason*: an undeclared or bare skip can still hide a disabled assertion, and that
       * is exactly what this check exists to catch.
       */
      fields.pass + fields.skipped === fields.tests &&
      fields.skipped === skips.length &&
      unexplained.length === 0 &&
      fields.fail === 0 &&
      fields.cancelled === 0 &&
      fields.todo === 0,
  };
}
function publicApi(content, fileName) {
  const source = ts.createSourceFile(
    fileName,
    content,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  return source.statements
    .filter((node) =>
      node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword),
    )
    .map((node) => {
      if (ts.isFunctionDeclaration(node))
        return {
          kind: 'function',
          name: node.name?.text,
          signature: node
            .getText(source)
            .slice(0, node.body ? node.body.getStart(source) - node.getStart(source) : undefined)
            .replace(/\s+/g, ' ')
            .trim(),
        };
      return {
        kind: ts.SyntaxKind[node.kind],
        text: node.getText(source).replace(/\s+/g, ' ').trim(),
      };
    });
}
export async function executeOracle(
  caseDef,
  workspace,
  evidenceDirectory,
  timeoutMs = 180_000,
  originalDirectory,
) {
  await mkdir(evidenceDirectory, { recursive: true });
  const before = await oracleFingerprint();
  const processResult = await runProcess(
    process.execPath,
    [path.join(root, 'oracle/behavior.mjs'), caseDef.id, workspace.directory],
    { cwd: workspace.directory, timeoutMs },
  );
  let parsed;
  try {
    parsed = JSON.parse(processResult.stdout.trim());
  } catch {
    parsed = {
      checks: [
        {
          id: 'oracle-output',
          passed: false,
          evidence: 'Missing or malformed independent oracle output',
        },
      ],
      passed: false,
    };
  }
  const checks = parsed.checks ?? [];
  const tampered = (await oracleFingerprint()).hash !== before.hash;
  checks.push({
    id: 'oracle-identity',
    passed: !tampered && parsed.version === 1 && parsed.caseId === caseDef.id && checks.length > 0,
    evidence: before.hash,
  });
  if (caseDef.id === 'E07') {
    let structuralPass = false,
      evidence = 'format module or baseline API missing';
    try {
      if (!originalDirectory) throw new Error('Original corpus required for AST comparison');
      const candidate = await readFile(
        path.join(workspace.directory, 'packages/tools/spill.ts'),
        'utf8',
      );
      const original = await readFile(
        path.join(originalDirectory, 'packages/tools/spill.ts'),
        'utf8',
      );
      const format = await readFile(
        path.join(workspace.directory, 'packages/tools/spill-format.ts'),
        'utf8',
      );
      const ast = ts.createSourceFile('spill-format.ts', format, ts.ScriptTarget.Latest, true);
      const imports = ast.statements
        .filter(ts.isImportDeclaration)
        .map((node) => node.moduleSpecifier.text);
      const signatures = publicApi(format, 'spill-format.ts');
      structuralPass =
        JSON.stringify(publicApi(candidate, 'spill.ts')) ===
          JSON.stringify(publicApi(original, 'spill.ts')) &&
        !imports.some((name) => /(?:^node:fs|^fs|^node:path|^path|^\.)/.test(name)) &&
        !/\brequire\s*\(|\bimport\s*\(|\bprocess\b|\b(?:readFile|writeFile|mkdir|unlink|readdir)\b/.test(
          format,
        ) &&
        signatures.length === 2 &&
        signatures.every(
          (node) => node.kind === 'function' && ['truncateUtf8', 'spillName'].includes(node.name),
        );
      evidence =
        'TypeScript AST compares original exports/signatures and the two format exports; disk I/O imports and access rejected';
    } catch (error) {
      evidence = String(error);
    }
    checks.push({ id: 'refactor-api-and-no-disk-io', passed: structuralPass, evidence });
  }
  const result = {
    checks,
    passed:
      parsed.passed === true &&
      processResult.exitCode === 0 &&
      !processResult.timedOut &&
      !processResult.overflow &&
      !tampered &&
      checks.every((check) => check.passed),
    timedOut: processResult.timedOut,
    tampered,
    regressionExitCode: null,
  };
  await writeFile(
    path.join(evidenceDirectory, 'oracle.json'),
    JSON.stringify({ fingerprint: before, process: processResult, ...result }, null, 2),
  );
  return result;
}
export function verifyScenario(id, evidence) {
  const conditions =
    id === 'E09'
      ? {
          ready: evidence.readySeen === true,
          cancel: evidence.cancellationAcknowledged === true,
          ownedProcessExit: evidence.ownedProcessExited === true,
          markerStopped: evidence.markerStopped === true,
          resume: evidence.restartedSameSession === true && evidence.historyReadable === true,
          noReplay: evidence.workloadStarts === 1,
          retention: evidence.retentionVerified === true,
          cleanup: evidence.cleanupConfirmed === true,
        }
      : {
          delegation:
            Array.isArray(evidence.delegatedSessions) &&
            new Set(evidence.delegatedSessions.map((session) => session.sessionId)).size === 2 &&
            evidence.delegatedSessions.every(
              (session) =>
                session.actualStarted === true &&
                session.settled === true &&
                session.parentSessionId === evidence.parentSessionId &&
                session.model === evidence.model,
            ),
          retention: evidence.retentionVerified === true,
          cli: evidence.cliVerified === true,
          integration:
            evidence.parentIntegrated === true && evidence.fileOwnershipRespected === true,
          metering: evidence.lineageUsageComplete === true,
          cleanup: evidence.cleanupConfirmed === true,
        };
  const checks = Object.entries(conditions).map(([id, passed]) => ({
    id,
    passed,
    evidence: 'scenario evidence contract; offline records are never live product passes',
  }));
  return {
    checks,
    passed: checks.every((check) => check.passed),
    timedOut: false,
    tampered: false,
    regressionExitCode: null,
  };
}
export function scenarioContractControls() {
  const reference = {
    readySeen: true,
    cancellationAcknowledged: true,
    ownedProcessExited: true,
    markerStopped: true,
    restartedSameSession: true,
    historyReadable: true,
    workloadStarts: 1,
    retentionVerified: true,
    cleanupConfirmed: true,
  };
  const variants = [
    { variant: 'reference-contract', evidence: reference, expectedPass: true },
    ...Object.keys(reference).map((key) => ({
      variant: `negative-${key}`,
      expectedPass: false,
      evidence: { ...reference, [key]: key === 'workloadStarts' ? 2 : false },
    })),
  ];
  return variants.map(({ evidence, ...variant }) => ({
    ...variant,
    ...verifyScenario('E09', evidence),
    live: false,
  }));
}
export async function verifyScope(caseDef, workspace, frozen) {
  const candidate = await inventory(workspace.directory);
  const base = new Map(frozen.corpusFiles.map((file) => [file.path, file]));
  const after = new Map(candidate.map((file) => [file.path, file]));
  const changed = [...new Set([...base.keys(), ...after.keys()])].filter(
    (p) => base.get(p)?.sha256 !== after.get(p)?.sha256,
  );
  let workloadTampered = false;
  if (caseDef.id === 'E09' && workspace.scenario)
    try {
      await assertWorkloadProtected(workspace);
    } catch {
      workloadTampered = true;
    }
  const allowed = (p) =>
    (caseDef.id === 'E09' &&
      workspace.scenario &&
      (p === 'evaluation-workload.cjs' ||
        SCENARIO_STATE_FILES.some((name) => p === `.task-state/${name}`))) ||
    caseDef.allowedPaths.includes(p) ||
    (p.startsWith('tests/') && !base.has(p) && /\.(?:test\.ts|mjs|ts)$/.test(p)) ||
    (['E01', 'E04', 'E05'].includes(caseDef.id) &&
      p.startsWith('packages/tools/spill-') &&
      p.endsWith('.ts') &&
      !base.has(p));
  const forbidden = changed.filter((p) => !allowed(p));
  if (workloadTampered && !forbidden.includes('evaluation-workload.cjs'))
    forbidden.push('evaluation-workload.cjs');
  return { changed, forbidden, passed: forbidden.length === 0 };
}
export async function verifyCase({
  caseDef,
  workspace,
  frozen,
  evidenceDirectory,
  timeoutMs = 180_000,
  runRegressions = true,
  scenarioEvidence,
}) {
  const fingerprint = await oracleFingerprint();
  await assertFrozen(frozen);
  const scope = await verifyScope(caseDef, workspace, frozen);
  await mkdir(evidenceDirectory, { recursive: true });
  await writeFile(path.join(evidenceDirectory, 'scope.json'), JSON.stringify(scope, null, 2));
  if (!scope.passed)
    return {
      checks: [{ id: 'scope', passed: false, evidence: scope.forbidden.join(', ') }],
      passed: false,
      timedOut: false,
      tampered: true,
      regressionExitCode: null,
    };
  const validation = path.join(evidenceDirectory, 'validation');
  await copyFiles(frozen.corpusDirectory, validation, frozen.corpusFiles);
  for (const relative of scope.changed) {
    try {
      const bytes = await readFile(path.join(workspace.directory, relative));
      await mkdir(path.dirname(path.join(validation, relative)), { recursive: true });
      await writeFile(path.join(validation, relative), bytes);
    } catch (error) {
      if (error.code === 'ENOENT') await rm(path.join(validation, relative));
      else throw error;
    }
  }
  const result = await executeOracle(
    caseDef,
    { ...workspace, directory: validation },
    evidenceDirectory,
    timeoutMs,
    frozen.corpusDirectory,
  );
  result.checks.push({ id: 'scope', passed: true, evidence: scope.changed.join(', ') });
  if (caseDef.id === 'E09' && scenarioEvidence) {
    const scenario = verifyScenario('E09', {
      ...scenarioEvidence,
      retentionVerified: result.passed,
    });
    result.checks.push(
      ...scenario.checks.map((check) => ({ ...check, id: `scenario-${check.id}` })),
    );
    result.passed &&= scenario.passed;
  }
  if (runRegressions && caseDef.publicCheck.length) {
    // Independent, private dependency installation is required. Ancestor node_modules
    // must never silently supply the grader/runtime dependencies.
    let dependencies;
    try {
      dependencies = JSON.parse(
        await readFile(path.join(workspace.directory, '.evaluation-dependencies.json'), 'utf8'),
      );
    } catch {
      /* explicit preparation blocker */
    }
    if (
      !dependencies?.private ||
      dependencies.lockHash !==
        hash(await readFile(path.join(frozen.corpusDirectory, 'package-lock.json')))
    ) {
      result.checks.push({
        id: 'trusted-regressions',
        passed: false,
        evidence:
          'Private lockfile-bound dependencies not prepared; public regressions were not executed',
      });
      result.passed = false;
    } else {
      /**
       * The validation copy gets the *verified* private installation, taken from the frozen runtime rather than
       * from the task workspace: the frozen old tests must execute against dependencies the candidate cannot
       * rewrite while the grader is reading them.
       */
      await preparePrivateDependencies({
        targetDirectory: validation,
        sourceDirectory: frozen.runtimeDirectory,
        verifyContent: false,
      });
      const processResult = await runProcess(
        process.execPath,
        [
          '--test',
          '--test-reporter=tap',
          '--test-concurrency=1',
          ...caseDef.publicCheck.map((file) => path.join(validation, file)),
        ],
        { cwd: validation, timeoutMs },
      );
      const summary = parseTestSummary(
        processResult.stdout,
        processResult.exitCode,
        processResult.timedOut,
        caseDef,
      );
      result.regressionExitCode = processResult.exitCode;
      result.timedOut ||= processResult.timedOut;
      /**
       * A fully paused regression file is a declared property of the *input*, not a pass.
       *
       * A frozen corpus may declare the CLI surface disabled, and then `tests/cli.test.ts` is paused upstream
       * (every case a literal `test.skip` retaining its body). That file can never produce an executed
       * assertion, and saying nothing would let a batch look as though the CLI had been regression-checked when
       * it never was. The check below is recorded as passing-but-inert with the counts in its evidence, and it
       * still fails the moment a test in the file actually runs and fails — the exemption widens what "paused"
       * covers, it does not stop the file from being executed. When the frozen input enables the CLI, the file
       * runs and this branch simply does not apply.
       */
      const fullyPaused =
        caseDef.publicCheckFullyPaused === true &&
        summary.tests > 0 &&
        summary.pass === 0 &&
        summary.skipped === summary.tests &&
        summary.fail === 0 &&
        summary.cancelled === 0;
      result.checks.push({
        id: 'trusted-regressions',
        passed: (summary.passed || fullyPaused) && !processResult.overflow,
        evidence: fullyPaused
          ? JSON.stringify({
              ...summary,
              inert: true,
              note: 'the frozen regression file is paused upstream; no assertion executed, so it is recorded as inert rather than as evidence of health',
            })
          : JSON.stringify(summary),
      });
      result.passed &&= (summary.passed || fullyPaused) && !processResult.overflow;
      await writeFile(
        path.join(evidenceDirectory, 'regressions.json'),
        JSON.stringify({ ...processResult, summary }, null, 2),
      );
    }
  }
  await assertFrozen(frozen);
  result.tampered ||= (await oracleFingerprint()).hash !== fingerprint.hash;
  result.passed &&= !result.tampered;
  await writeFile(
    path.join(evidenceDirectory, 'verification.json'),
    JSON.stringify(result, null, 2),
  );
  // The immutable source and complete oracle/regression logs remain; this rebuild is disposable.
  const validationRelative = path.relative(
    path.resolve(evidenceDirectory),
    path.resolve(validation),
  );
  if (validationRelative !== 'validation')
    throw new Error('Validation cleanup escaped its evidence directory');
  await rm(validation, { recursive: true, force: true });
  return result;
}
/**
 * The three controls every case must show before it may score a paid sample.
 *
 * The variants are three *different* inputs, not three readings of one:
 *
 * - `original` — the upstream, unmodified frozen source. It is the case's positive source control: the behaviour
 *   the task must not break is present here, and for a repair task the defect is not.
 * - `degraded` — what the model is actually handed. For a repair task this is the seeded (broken) input; for a
 *   feature, refactor or investigation task it is the same unmodified source, because the requirement is simply
 *   not implemented yet and no artificial defect is needed to say so.
 * - `reference` — the harness author's own change applied on top of `degraded`, which is what makes it a fix
 *   rather than a diff against an unrelated baseline.
 *
 * A control only counts once `verifyCase` has run it, so the oracle, the scope rule and the frozen old
 * regressions all have to agree; a control that merely compiles is not evidence.
 */
async function certifyBehaviorControls(caseDef, frozen, directory) {
  const controls = [];
  for (const variant of ['original', 'degraded', 'reference']) {
    const workspaceDirectory = path.join(directory, variant, 'workspace');
    await copyFiles(frozen.corpusDirectory, workspaceDirectory, frozen.corpusFiles);
    const workspace = {
      directory: workspaceDirectory,
      sampleId: `${caseDef.id}-${variant}`,
      baseHash: frozen.corpusHash,
      baseFiles: frozen.corpusFiles,
    };
    if (variant !== 'original' && caseDef.seed) await prepareCase(caseDef, workspace);
    if (variant === 'reference') await applyReference(caseDef, workspace);
    if (caseDef.publicCheck.length)
      await preparePrivateDependencies({
        targetDirectory: workspaceDirectory,
        sourceDirectory: frozen.runtimeDirectory,
        verifyContent: false,
      });
    const result = await verifyCase({
      caseDef,
      workspace,
      frozen,
      evidenceDirectory: path.join(directory, variant),
      timeoutMs: 180_000,
    });
    controls.push({ variant, ...result });
    if (
      path
        .relative(path.resolve(directory), path.resolve(workspaceDirectory))
        .split(path.sep)
        .at(-1) !== 'workspace'
    )
      throw new Error('Control cleanup escaped its evidence directory');
    await rm(workspaceDirectory, { recursive: true, force: true });
  }
  return controls;
}
export async function selfCheckCorpus(frozen, evidenceDirectory, { signal } = {}) {
  const results = [];
  for (const id of CASE_IDS) {
    if (signal?.aborted) {
      results.push({
        caseId: id,
        status: 'blocked',
        reason: 'external-cancelled-during-controls',
        controls: [],
      });
      continue;
    }
    const caseDef = getCase(id);
    const blocked = await casePreparationBlock(caseDef, frozen);
    if (blocked) {
      results.push({ caseId: id, status: 'blocked', reason: blocked, controls: [] });
      continue;
    }
    const controls = [];
    try {
      controls.push(
        ...(await certifyBehaviorControls(caseDef, frozen, path.join(evidenceDirectory, id))),
      );
      const [original, degraded, reference] = controls;
      /**
       * The three readings have to disagree in exactly the right places, and the rule is not the same for both
       * kinds of task.
       *
       * A *repair* task has a source control: the upstream, unseeded input is behaviour that works, so
       * `original` must pass. That is what stops a case from being scored on a corpus that already fails the
       * oracle — a "pass" there would mean nothing. Its seeded `degraded` input must then fail.
       *
       * A *feature*, *refactor* or *investigation* task has no such source control, because the requirement is
       * simply absent from the source: `original` and `degraded` are the same input and both must fail, which is
       * how the harness proves the task is not already solved. Requiring `original` to pass there would demand
       * that the feature exist before it is implemented, and would block every one of those cases.
       *
       * In both shapes the reference must pass, and the failure in `degraded` must be a real assertion rather
       * than the oracle failing to load — otherwise "the input fails" would be satisfied by a broken grader.
       */
      const scenarioControls = id === 'E09' ? scenarioContractControls() : [];
      const valid =
        (caseDef.seed
          ? original.passed && !degraded.passed
          : !original.passed && !degraded.passed) &&
        reference.passed &&
        degraded.checks.some((check) => !check.passed && check.id !== 'oracle-load-or-execution') &&
        scenarioControls.every((control) => control.passed === control.expectedPass);
      results.push({
        caseId: id,
        status: valid ? 'full-controls-certified' : 'blocked',
        reason: valid
          ? null
          : `Positive/negative/reference control mismatch: ${controls.map((control) => `${control.variant}=${control.passed}`).join(' ')}`,
        controls,
        scenarioControls,
      });
    } catch (error) {
      results.push({ caseId: id, status: 'blocked', reason: String(error), controls });
    }
  }
  await mkdir(evidenceDirectory, { recursive: true });
  await writeFile(
    path.join(evidenceDirectory, 'controls.json'),
    JSON.stringify({ version: 1, live: false, requests: 0, results }, null, 2),
  );
  return results;
}
