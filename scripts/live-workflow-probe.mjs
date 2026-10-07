import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AgentHostClient } from '../packages/client/host-client.ts';
import { SessionStore } from '../packages/storage/sqlite.ts';

function readSecret() {
  return new Promise((resolve, reject) => {
    if (!process.stdin.isTTY || !process.stdin.setRawMode)
      return reject(new Error('Private TTY required'));
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.once('data', (chunk) => {
      process.stdin.pause();
      const key = chunk.toString('utf8').trim();
      key ? resolve(key) : reject(new Error('Empty credential'));
    });
  });
}

async function poll(action, predicate, timeoutMs = 150000) {
  const deadline = Date.now() + timeoutMs;
  let value;
  while (Date.now() < deadline) {
    value = await action();
    if (predicate(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return value;
}

function host(root, key) {
  const client = new AgentHostClient({
    nodePath: process.execPath,
    hostPath: path.resolve('apps/agent-host/main.ts'),
    workspace: root,
    env: {
      YUANTU_API_KEY: key,
      YUANTU_BASE_URL: 'https://llmapi.isrc.ac.cn/v1/chat/completions',
      YUANTU_MODEL: 'DeepSeek-V4.1-Flash',
      YUANTU_PROTOCOL: 'openai',
      YUANTU_MAX_RETRIES: '0',
      YUANTU_REQUEST_TIMEOUT_MS: '90000',
      YUANTU_MAX_OUTPUT_TOKENS: '2048',
      YUANTU_WORKFLOW_INTERVAL_MS: '1000',
    },
  });
  return client;
}

const key = await readSecret();
const root = await mkdtemp(path.join(os.tmpdir(), 'yuantu-live-workflow-'));
const output = { scenarios: [] };
try {
  if (process.argv[2] !== 'scheduled-only') {
    const compactRoot = path.join(root, 'compact');
    await mkdir(compactRoot);
    const compactDb = path.join(compactRoot, '.yuantu', 'sessions.sqlite');
    const seed = new SessionStore(compactDb);
    const session = seed.create(compactRoot);
    seed.append(session.id, {
      role: 'user',
      content: 'Remember this exact test passphrase: cobalt-lantern-42.',
    });
    seed.append(session.id, {
      role: 'assistant',
      content: 'I will remember cobalt-lantern-42.',
      toolCalls: [],
    });
    seed.append(session.id, {
      role: 'user',
      content: 'Also remember the launch window: Friday 09:30 UTC.',
    });
    seed.append(session.id, {
      role: 'assistant',
      content: 'The passphrase is cobalt-lantern-42 and the window is Friday 09:30 UTC.',
      toolCalls: [],
    });
    seed.close();
    const compactClient = host(compactRoot, key);
    try {
      await compactClient.start();
      const compacted = await compactClient.request('context.compact', { sessionId: session.id });
      const answer = await compactClient.run(
        session.id,
        'What is the exact test passphrase and launch window from before the compaction? Answer concisely.',
      );
      await compactClient.stop();
      const check = new SessionStore(compactDb);
      const checkpoint = check.contextCheckpoint(session.id);
      check.close();
      output.scenarios.push({
        name: 'manual-compaction',
        compacted: compacted.compacted,
        coveredMessages: checkpoint?.coveredMessages,
        summaryKeepsPassphrase: checkpoint?.summary.includes('cobalt-lantern-42'),
        summaryKeepsWindow: checkpoint?.summary.includes('Friday 09:30 UTC'),
        followupStatus: answer.status,
        followupRetainsFacts:
          answer.text.includes('cobalt-lantern-42') && answer.text.includes('Friday 09:30 UTC'),
        error: answer.error,
        passed:
          compacted.compacted &&
          checkpoint?.coveredMessages === 4 &&
          checkpoint.summary.includes('cobalt-lantern-42') &&
          checkpoint.summary.includes('Friday 09:30 UTC') &&
          answer.status === 'completed' &&
          answer.text.includes('cobalt-lantern-42') &&
          answer.text.includes('Friday 09:30 UTC'),
      });
    } catch (error) {
      output.scenarios.push({ name: 'manual-compaction', passed: false, error: error.message });
    } finally {
      await compactClient.stop();
    }
  }
  const scheduleRoot = path.join(root, 'scheduled');
  await mkdir(scheduleRoot);
  const scheduleDb = path.join(scheduleRoot, '.yuantu', 'sessions.sqlite');
  const taskSeed = new SessionStore(scheduleDb);
  const scheduledSession = taskSeed.create(scheduleRoot);
  const task = taskSeed.createTask(scheduledSession.id, {
    title: 'Write reviewed fixture',
    description:
      'Use write_file to create approved.txt containing exactly reviewed and no newline. Do not use run_command. If approval is needed, wait for review and continue after approval.',
    steps: [{ description: 'Create approved.txt with exact text reviewed', status: 'pending' }],
    trigger: { kind: 'interval', enabled: true, everyMinutes: 60 },
  });
  taskSeed.scheduleImmediateRun(scheduledSession.id, task.id);
  taskSeed.close();
  const scheduleClient = host(scheduleRoot, key);
  const tools = [];
  scheduleClient.subscribe((event) => {
    if (event.type === 'tool.started') tools.push(event.data.call?.name);
  });
  try {
    await scheduleClient.start();
    const getTask = () =>
      scheduleClient.request('task.get', { sessionId: scheduledSession.id, taskId: task.id });
    const waiting = await poll(
      getTask,
      (value) =>
        value.pendingApproval?.state === 'pending' ||
        ['completed', 'blocked'].includes(value.status),
    );
    let beforeContent = null;
    try {
      beforeContent = await readFile(path.join(scheduleRoot, 'approved.txt'), 'utf8');
    } catch {}
    const approvalId = waiting?.pendingApproval?.id;
    const firstApproval = waiting?.pendingApproval;
    const waitingState = waiting?.pendingApproval?.state;
    const waitingStatus = waiting?.status;
    const waitingError = waiting?.lastTriggerError;
    const attemptCount = waiting?.attemptCount;
    let unchangedAfterRestart = false;
    let final;
    let finalContent = null;
    let secondApproval;
    if (approvalId && waitingState === 'pending') {
      await scheduleClient.stop();
      await scheduleClient.start();
      await new Promise((resolve) => setTimeout(resolve, 1700));
      const restarted = await getTask();
      unchangedAfterRestart =
        restarted.pendingApproval?.id === approvalId && restarted.attemptCount === attemptCount;
      await scheduleClient.request('task.approval.respond', {
        sessionId: scheduledSession.id,
        taskId: task.id,
        approvalId,
        allow: true,
      });
      final = await poll(
        getTask,
        (value) => value.status === 'completed' && !value.pendingApproval,
      );
      secondApproval = final?.pendingApproval;
      try {
        finalContent = await readFile(path.join(scheduleRoot, 'approved.txt'), 'utf8');
      } catch {}
    }
    output.scenarios.push({
      name: 'scheduled-approval-recovery',
      waitingStatus,
      waitingState,
      firstApproval,
      waitingError,
      fileAbsentBeforeApproval: beforeContent === null,
      unchangedAfterRestart,
      finalStatus: final?.status,
      secondApproval,
      finalError: final?.lastTriggerError,
      finalContent,
      attempts: final?.attemptCount,
      tools,
      passed:
        waitingStatus === 'needs_review' &&
        waitingState === 'pending' &&
        beforeContent === null &&
        unchangedAfterRestart &&
        final?.status === 'completed' &&
        finalContent === 'reviewed',
    });
  } catch (error) {
    output.scenarios.push({
      name: 'scheduled-approval-recovery',
      passed: false,
      error: error.message,
      tools,
    });
  } finally {
    await scheduleClient.stop();
  }
  console.log(JSON.stringify(output));
} finally {
  const resolvedRoot = path.resolve(root);
  if (!resolvedRoot.startsWith(path.resolve(os.tmpdir()) + path.sep))
    throw new Error('Unexpected temporary path');
  await rm(resolvedRoot, { recursive: true, force: true });
}
