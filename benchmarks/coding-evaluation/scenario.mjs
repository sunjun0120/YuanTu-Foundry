import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { hash } from './materialize.mjs';

export const CONTINUE_PROMPT =
  '检查已有状态，完成外溢保留数量需求，不重新启动已取消的长命令。省略保持50；1–1000整数，写入前拒绝无效值。相同mtime按Unicode code point降序保留。';
export const SCENARIO_STATE_FILES = [
  'ready.json',
  'child-ready.json',
  'heartbeat.json',
  'starts.jsonl',
];

function workloadSource(token) {
  return `const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const token = ${JSON.stringify(token)};
const state = path.join(__dirname, '.task-state');
fs.mkdirSync(state, { recursive: true });
const startedAt = Date.now();
if (process.argv[2] === '--child') {
  fs.writeFileSync(path.join(state, 'child-ready.json'), JSON.stringify({ token, pid: process.pid, startedAt }));
  let tick = 0;
  const beat = () => fs.writeFileSync(path.join(state, 'heartbeat.json'), JSON.stringify({ token, pid: process.pid, tick: ++tick }));
  beat();
  setInterval(beat, 50);
} else {
  fs.appendFileSync(path.join(state, 'starts.jsonl'), JSON.stringify({ token, pid: process.pid, startedAt }) + '\\n');
  const child = spawn(process.execPath, [__filename, '--child'], { windowsHide: true, stdio: 'ignore' });
  const publish = setInterval(() => {
    try {
      const ready = JSON.parse(fs.readFileSync(path.join(state, 'child-ready.json'), 'utf8'));
      if (ready.token !== token || ready.pid !== child.pid || ready.startedAt < startedAt) return;
      fs.writeFileSync(path.join(state, 'ready.json'), JSON.stringify({ token, parentPid: process.pid, childPid: child.pid, startedAt }));
      clearInterval(publish);
    } catch {}
  }, 10);
  // IPC is used solely by the offline control's owned process handle.
  process.on('message', (message) => { if (message === 'stop') child.kill(); });
  child.once('exit', () => { clearInterval(publish); process.exit(0); });
  child.once('error', () => { clearInterval(publish); process.exit(1); });
}
`;
}

export async function installWorkload(workspace) {
  const token = randomUUID();
  const source = workloadSource(token);
  await writeFile(path.join(workspace.directory, 'evaluation-workload.cjs'), source, {
    flag: 'wx',
  });
  return { token, workloadHash: hash(source) };
}
export async function assertWorkloadProtected(workspace) {
  if (
    hash(await readFile(path.join(workspace.directory, 'evaluation-workload.cjs'))) !==
    workspace.scenario?.workloadHash
  )
    throw new Error('E09 protected workload was modified');
}
async function readReady(workspace) {
  const ready = JSON.parse(
    await readFile(path.join(workspace.directory, '.task-state/ready.json'), 'utf8'),
  );
  if (
    ready.token !== workspace.scenario?.token ||
    !Number.isSafeInteger(ready.parentPid) ||
    !Number.isSafeInteger(ready.childPid) ||
    ready.parentPid <= 0 ||
    ready.childPid <= 0 ||
    ready.parentPid === ready.childPid ||
    !Number.isSafeInteger(ready.startedAt)
  )
    throw new Error('E09 workload identity mismatch');
  return ready;
}
export async function waitForWorkloadReady(workspace, signal) {
  for (;;) {
    signal.throwIfAborted();
    await assertWorkloadProtected(workspace);
    try {
      return await readReady(workspace);
    } catch (error) {
      if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
    }
    await delay(25, undefined, { signal });
  }
}
function exited(pid) {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return error.code === 'ESRCH';
  }
}
export async function inspectWorkload(workspace) {
  await assertWorkloadProtected(workspace);
  let ready;
  try {
    ready = await readReady(workspace);
  } catch (error) {
    if (error.code === 'ENOENT')
      return {
        readySeen: false,
        ownedProcessExited: false,
        markerStopped: false,
        workloadStarts: 0,
      };
    throw error;
  }
  const marker = path.join(workspace.directory, '.task-state/heartbeat.json');
  const before = await readFile(marker, 'utf8');
  await delay(200);
  const after = await readFile(marker, 'utf8');
  const starts = (
    await readFile(path.join(workspace.directory, '.task-state/starts.jsonl'), 'utf8')
  )
    .trim()
    .split('\n')
    .map(JSON.parse);
  return {
    readySeen: true,
    identity: ready,
    ownedProcessExited: exited(ready.parentPid) && exited(ready.childPid),
    markerStopped: before === after,
    workloadStarts: starts.length,
    identityMatched: starts.every((start) => start.token === workspace.scenario.token),
    markerHash: hash(after),
  };
}

/** Two real Host lifetimes, one DB/session/workspace; a scheduled phase-one cancel is not the sample outcome. */
export async function runE09Sample(input, signal, runHostPhase) {
  const databasePath = path.join(input.evidenceDirectory, 'session.sqlite');
  const phaseOne = await runHostPhase(
    {
      ...input,
      scenarioPhase: 'cancel',
      databasePath,
      evidenceDirectory: path.join(input.evidenceDirectory, 'cancel'),
    },
    signal,
  );
  const before = await inspectWorkload(input.prepared.workspace);
  const sessionId = phaseOne.sessionRecords[0]?.sessionId;
  let phaseTwo = null;
  if (
    !signal.aborted &&
    phaseOne.cancellation?.terminalSettled &&
    phaseOne.cleanupConfirmed &&
    before.ownedProcessExited &&
    before.markerStopped &&
    before.workloadStarts === 1 &&
    sessionId
  ) {
    phaseTwo = await runHostPhase(
      {
        ...input,
        scenarioPhase: 'continue',
        databasePath,
        resumeSessionId: sessionId,
        expectedHistoryHash: phaseOne.historyHash,
        prepared: { ...input.prepared, prompt: CONTINUE_PROMPT },
        evidenceDirectory: path.join(input.evidenceDirectory, 'continue'),
      },
      signal,
    );
  }
  const after = await inspectWorkload(input.prepared.workspace);
  const scenario = {
    ...after,
    cancellationAcknowledged: phaseOne.cancellation?.acknowledged === true,
    restartedSameSession: phaseTwo?.sessionRecords[0]?.sessionId === sessionId,
    historyReadable: phaseTwo?.resumedHistoryReadable === true,
    cleanupConfirmed:
      phaseOne.cleanupConfirmed &&
      (!phaseTwo || phaseTwo.cleanupConfirmed) &&
      after.ownedProcessExited,
    continuationPromptHash: hash(CONTINUE_PROMPT),
  };
  const records = new Map();
  for (const record of [...phaseOne.sessionRecords, ...(phaseTwo?.sessionRecords ?? [])])
    records.set(record.sessionId, record);
  const result = {
    ...(phaseTwo ?? phaseOne),
    runs: [...phaseOne.runs, ...(phaseTwo?.runs ?? [])],
    events: [...phaseOne.events, ...(phaseTwo?.events ?? [])],
    sessionRecords: [...records.values()],
    timing: Object.fromEntries(
      Object.keys(phaseOne.timing).map((key) => [
        key,
        phaseOne.timing[key] + (phaseTwo?.timing[key] ?? 0),
      ]),
    ),
    cancellation: phaseTwo?.cancellation ?? (signal.aborted ? phaseOne.cancellation : null),
    scenario,
    cleanupConfirmed: scenario.cleanupConfirmed,
    failureClass: phaseTwo
      ? phaseTwo.failureClass
      : (phaseOne.failureClass ?? 'E09-continuation-not-started'),
  };
  await mkdir(input.evidenceDirectory, { recursive: true });
  await writeFile(
    path.join(input.evidenceDirectory, 'scenario.json'),
    JSON.stringify({ scenario, phases: [phaseOne, phaseTwo] }, null, 2),
  );
  await writeFile(
    path.join(input.evidenceDirectory, 'adapter.json'),
    JSON.stringify(result, null, 2),
  );
  return result;
}
