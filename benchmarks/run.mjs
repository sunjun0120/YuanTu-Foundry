/**
 * Benchmarks for the paths the DSH comparison identified as hot:
 * tool schemas per request, durable write cost, transcript reads, and the desktop's snapshot publishing.
 *
 * Run with `npm run bench`. Numbers are machine-relative; the point is to compare this commit with the next
 * one, which is what the validation records cite.
 *
 * `npm run bench:check` turns the same run into a gate. Absolute timings cannot be gated across machines, so
 * the rules are either *deterministic* quantities (schema bytes, records per message, publish counts) or
 * *ratios measured inside this one run* (batched against per-message commits, cached reads against cold
 * folds). Both hold on any machine, which is what makes the gate meaningful in CI rather than decorative.
 */
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { SessionStore } from '../packages/storage/sqlite.ts';
import { createTools } from '../packages/tools/index.ts';
import { forecastRequest } from '../packages/core/forecast.ts';
import { SessionController } from '../packages/client/session-controller.ts';
import { PermissionPolicy } from '../packages/core/permissions.ts';
import { permissionPolicyForMode } from '../apps/desktop/permission-settings.ts';

const results = [];
const record = (name, value, unit, note = '') => {
  results.push({ name, value, unit, note });
  console.log(`${name.padEnd(34)} ${String(value).padStart(10)} ${unit.padEnd(8)} ${note}`);
};
const time = (fn) => {
  const started = performance.now();
  const value = fn();
  return { ms: performance.now() - started, value };
};
/** Medians over `runs` repetitions: single timings on Windows swing by 2-3x between runs. */
const median = (fn, runs = 3) => {
  fn(); // warm-up: first touch of a file pays for the page cache
  const samples = [];
  let value;
  for (let index = 0; index < runs; index++) {
    const measured = time(fn);
    samples.push(measured.ms);
    value = measured.value;
  }
  samples.sort((a, b) => a - b);
  return { ms: samples[Math.floor(samples.length / 2)], value };
};

async function workspace() {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-bench-'));
  await mkdir(path.join(root, 'packages'), { recursive: true });
  for (let index = 0; index < 30; index++)
    await writeFile(
      path.join(root, 'packages', `f${index}.ts`),
      `export const v${index} = ${index};\n`,
    );
  return root;
}

// 1. Tool schemas the provider receives on every request, and what trimming them saves.
{
  const root = await workspace();
  const tools = createTools(root);
  const policy = (rules) => new PermissionPolicy({ version: 1, rules });
  record('tools.count.all', tools.specs().length, 'tools');
  record('tools.schema.all', JSON.stringify(tools.specs()).length, 'bytes');
  record('tools.count.readOnly', tools.specs({ readOnly: true }).length, 'tools');
  record('tools.schema.readOnly', JSON.stringify(tools.specs({ readOnly: true })).length, 'bytes');
  // A permission policy that denies a whole kind hides it too, which is what a desktop session in
  // read-only mode now sends instead of every schema it will refuse one call at a time.
  const readOnly = tools.specs({
    policy: new PermissionPolicy(permissionPolicyForMode('read-only')),
  });
  record('tools.count.readOnlyMode', readOnly.length, 'tools');
  record(
    'tools.schema.readOnlyMode',
    JSON.stringify(readOnly).length,
    'bytes',
    'permission mode read-only (the schema it will allow)',
  );
  const noExternal = tools.specs({ policy: policy([{ effect: 'deny', kind: 'external' }]) });
  record('tools.count.noExternalPolicy', noExternal.length, 'tools', 'policy: deny external');
  record(
    'tools.schema.noExternalPolicy',
    JSON.stringify(noExternal).length,
    'bytes',
    'policy: deny external',
  );
  await rm(root, { recursive: true, force: true });
}

// 2. Durable write cost: one message per commit, the round's batch, and the records each message costs.
{
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-bench-append-'));
  const file = path.join(root, 'sessions.sqlite');
  const store = new SessionStore(file);
  // `flush` is what promises an append to disk; before batched appends it did not exist and every append
  // was already durable, so calling it here keeps the same logical work on both sides of the comparison.
  const flush = (id) => (typeof store.flush === 'function' ? store.flush(id) : undefined);
  const session = store.create(root);
  const text = 'w'.repeat(200);
  const count = 2000;
  const { ms } = median(() => {
    for (let index = 0; index < count / 4; index++) {
      store.append(session.id, { role: 'user', content: `${index}: ${text}` });
      flush(session.id);
    }
  });
  record(
    'append.durablePerMessage',
    (ms / (count / 4)).toFixed(3),
    'ms',
    `median of 3 x ${count / 4} append+flush (${ms.toFixed(0)}ms each)`,
  );
  flush(session.id);
  const reader = new DatabaseSync(file);
  const rows = Number(
    reader.prepare('SELECT COUNT(*) AS n FROM messages WHERE session_id=?').get(session.id).n,
  );
  const events = Number(
    reader.prepare('SELECT COUNT(*) AS n FROM session_events WHERE session_id=?').get(session.id).n,
  );
  record(
    'append.durableRecordsPerMessage',
    ((rows + events) / rows).toFixed(2),
    'x',
    `${rows} rows + ${events} events`,
  );
  reader.close();

  // A round as the run loop writes it: the assistant message that names the tool calls is flushed before
  // the tools run (a crash mid-tool must leave that record), then three results are appended, then the
  // round boundary flushes them together. The same shape is measured twice in one run: with a flush after
  // every append — which is exactly what a per-message commit did — and batched.
  const rounds = 200;
  const measureRounds = (flushEveryMessage) => {
    const samples = [];
    for (let pass = 0; pass < 3; pass++) {
      const round = store.create(root);
      const measured = time(() => {
        for (let index = 0; index < rounds; index++) {
          store.append(round.id, {
            role: 'assistant',
            content: `round ${index}`,
            toolCalls: [],
          });
          flush(round.id);
          for (let tool = 0; tool < 3; tool++) {
            store.append(round.id, {
              role: 'tool',
              toolCallId: `call-${tool}`,
              content: text,
              isError: false,
            });
            if (flushEveryMessage) flush(round.id);
          }
          flush(round.id);
        }
      });
      samples.push(measured.ms / rounds);
    }
    samples.sort((a, b) => a - b);
    return samples[1];
  };
  const unbatched = measureRounds(true);
  const batched = measureRounds(false);
  record(
    'append.perRoundUnbatched',
    unbatched.toFixed(3),
    'ms',
    `median of 3 x ${rounds} rounds, one commit per message (4 commits)`,
  );
  record(
    'append.perRound',
    batched.toFixed(3),
    'ms',
    `same round, batched: 4 messages in 2 commits (${(unbatched / batched).toFixed(2)}x)`,
  );
  record(
    'append.durablePerMessageInRound',
    (batched / 4).toFixed(3),
    'ms',
    'per message at four messages per round, batched',
  );
  store.close();
  await rm(root, { recursive: true, force: true });
}

// 3. Transcript read: the fold, against the row scan it replaced, on a cold and on a warm store.
{
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-bench-read-'));
  const file = path.join(root, 'sessions.sqlite');
  const store = new SessionStore(file);
  for (const count of [1000, 10000]) {
    const session = store.create(root);
    const text = 'r'.repeat(200);
    for (let index = 0; index < count; index++)
      store.append(session.id, { role: 'user', content: `${index}: ${text}` });
    // A cold read is a store that has never folded this session, so each sample opens its own connection:
    // timing a warm store would measure the cache instead of the fold.
    const coldSamples = [];
    for (let pass = 0; pass < 3; pass++) {
      const fresh = new SessionStore(file);
      coldSamples.push(time(() => fresh.messages(session.id)).ms);
      fresh.close();
    }
    coldSamples.sort((a, b) => a - b);
    const fold = coldSamples[1];
    const warmed = new SessionStore(file);
    warmed.messages(session.id); // one read, so the store is holding whatever a cache would hold
    const warm = median(() => warmed.messages(session.id));
    warmed.close();
    const reader = new DatabaseSync(file);
    reader.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    const scan = median(() =>
      reader
        .prepare('SELECT body FROM messages WHERE session_id=? ORDER BY seq')
        .all(session.id)
        .map((row) => JSON.parse(String(row.body))),
    );
    reader.close();
    record(
      `read.messages.${count}`,
      fold.toFixed(1),
      'ms',
      `cold fold; cached read ${warm.ms.toFixed(1)}ms; row scan ${scan.ms.toFixed(1)}ms`,
    );
    // Three reads per round is what the run loop does (context builder + pre-step + title path).
    record(
      `read.threePerRound.${count}`,
      (fold * 3).toFixed(1),
      'ms',
      `per agent round, cold each time; cached ${(warm.ms * 3).toFixed(1)}ms`,
    );
    record(
      `read.threePerRoundCached.${count}`,
      (warm.ms * 3).toFixed(1),
      'ms',
      'the same round with the fold kept, which is the shape a long run is in',
    );
  }
  // The run loop interleaves writes and reads, so a fold per read is quadratic in the round count:
  // every round re-reads the whole log this run has already grown. Three timed passes, median.
  const rounds = 500;
  const loopSamples = [];
  for (let pass = 0; pass < 3; pass++) {
    const session = store.create(root);
    const measured = time(() => {
      for (let index = 0; index < rounds; index++) {
        store.append(session.id, { role: 'user', content: `${index}: ${'x'.repeat(200)}` });
        for (let read = 0; read < 3; read++) store.messages(session.id).length;
      }
    });
    loopSamples.push(measured.ms);
  }
  loopSamples.sort((a, b) => a - b);
  record(
    'read.roundLoop.500',
    loopSamples[1].toFixed(1),
    'ms',
    `median of 3 x ${rounds} rounds of 1 append + 3 reads`,
  );
  store.close();
  await rm(root, { recursive: true, force: true });
}

// 3a. What one round's *measurement* serialises.
//
// The estimator walks the conversation to price it, and a round asks it several times about overlapping
// conversations: does the request fit, what is the forecast it acts on, what would the retained tail cost, would
// this summary batch fit. The quantity that matters is therefore not milliseconds (they swing by 2-3x between
// runs) but **how many times a message is serialised**, which is deterministic and is what the two rules below
// pin: once per message per forecast, and none at all for a message the same process has already measured.
//
// `JSON.stringify` is wrapped rather than the estimator instrumented: a counter inside `packages/core/budget.ts`
// would exist only for this file, and what is being counted — the serialisation of a message — is exactly what
// the wrapper can see. The wrapper is installed for the duration of the measurement and restored by `finally`.
{
  const original = JSON.stringify;
  let messageSerialisations = 0;
  JSON.stringify = function (value, ...rest) {
    // A message is the object with a `role`; the system prompt is a string and the catalogue is an array, and
    // neither of those is what a long session's cost is proportional to.
    if (value && typeof value === 'object' && typeof value.role === 'string')
      messageSerialisations++;
    return original.call(JSON, value, ...rest);
  };
  try {
    const messages = Array.from({ length: 400 }, (_, index) =>
      index % 2 === 0
        ? { role: 'user', content: `turn ${index} ${'x'.repeat(200)}` }
        : { role: 'assistant', content: 'noted', toolCalls: [] },
    );
    const system = 'You are YuanTu.';
    const tools = createTools(await workspace()).specs();
    const forecast = { system, messages, tools, maxOutputTokens: 4_000, factor: 1.2 };
    messageSerialisations = 0;
    const first = forecastRequest(forecast);
    const cold = messageSerialisations;
    messageSerialisations = 0;
    const second = forecastRequest(forecast);
    const warm = messageSerialisations;
    // Two more questions a round asks about a *slice* of the same conversation (the retained tail), which is
    // where the cache pays twice over: the slice holds messages the first measurement already priced.
    messageSerialisations = 0;
    forecastRequest({ ...forecast, messages: messages.slice(200) });
    const tail = messageSerialisations;
    if (first.inputTokens !== second.inputTokens)
      throw new Error('the same conversation measured twice answered differently');
    record('context.messages', messages.length, 'count', 'messages in the measured conversation');
    record(
      'context.messageSerialisations.cold',
      cold,
      'count',
      'first forecast of a conversation this process has not measured',
    );
    record('context.messageSerialisations.repeat', warm, 'count', 'the same forecast again');
    record(
      'context.messageSerialisations.tail',
      tail,
      'count',
      'a 200-message slice of the same conversation, all of it already measured',
    );
  } finally {
    JSON.stringify = original;
  }
}

// 3b. Cold start with projection checkpoints: what a restart pays, and what the transcript would cost on disk.
//     The two numbers are the ones the "should the transcript be persisted too" decision needs: a checkpoint
//     turns a cold fold into a read, so the question is only whether the bytes it saves are worth the bytes a
//     persisted transcript would add. Nothing here asserts a millisecond value; what is pinned is that a
//     checkpoint makes a cold read fold *zero* events (the rule below), which is the property, not the speed.
{
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-bench-checkpoint-'));
  const file = path.join(root, 'sessions.sqlite');
  const count = 10000;
  const store = new SessionStore(file);
  const session = store.create(root);
  for (let index = 0; index < count; index++)
    store.append(session.id, { role: 'user', content: `${index}: ${'c'.repeat(200)}` });
  store.recordEvent(session.id, 'subagent.message.queued', {
    id: 'bench-message',
    childId: 'bench-child',
    childSessionId: 'bench-child-session',
    message: 'a correction the parent is waiting to see delivered',
  });
  // One write point persists every projection checkpoint, which is the shape a restart sees.
  store.saveProjectionCheckpoints(session.id);
  const bytes = (() => {
    const reader = new DatabaseSync(file);
    reader.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    const row = reader
      .prepare(
        'SELECT SUM(LENGTH(body)) AS body, SUM(LENGTH(search_text)) AS search FROM messages WHERE session_id=?',
      )
      .get(session.id);
    const pages = reader.prepare('PRAGMA page_count').get().page_count;
    const pageSize = reader.prepare('PRAGMA page_size').get().page_size;
    reader.close();
    return {
      rows: Number(row.body ?? 0) + Number(row.search ?? 0),
      file: Number(pages) * Number(pageSize),
    };
  })();
  store.close();

  // A restart: a store that has never folded this session reads the checkpoint instead of the log.
  const restarted = new SessionStore(file);
  restarted.resetFoldCounters();
  const cold = time(() => restarted.stateOf('subagentInbox', session.id));
  const stats = restarted.foldStats();
  record(
    'checkpoint.small.10000',
    cold.ms.toFixed(1),
    'ms',
    `cold read of one projection after a restart (${stats.checkpointHits} checkpoint hit, ${stats.events} events folded)`,
  );
  record(
    'checkpoint.foldedEvents.10000',
    stats.events,
    'events',
    'zero means the restart read its checkpoint instead of re-folding the log',
  );
  // What the same transcript would cost as rows: the disk side of the trade (the fold side is read.messages.*).
  record(
    'store.messages.bytes.10000',
    bytes.rows,
    'bytes',
    `transcript rows + search text for ${count} messages (whole file ${bytes.file} bytes)`,
  );
  record(
    'store.bytesPerMessage.10000',
    Math.round(bytes.rows / count),
    'bytes',
    'per message, which is what persisting a transcript would add',
  );
  restarted.close();
  await rm(root, { recursive: true, force: true });
}

// 4. Desktop snapshot: how much is serialised per publish, and how often it is published.
{
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-bench-snapshot-'));
  const store = new SessionStore(path.join(root, 'sessions.sqlite'));
  const session = store.create(root);
  const count = 2000;
  for (let index = 0; index < count; index++)
    store.append(session.id, { role: 'user', content: `message ${index} ${'s'.repeat(150)}` });
  const messages = store.messages(session.id);
  record('snapshot.payload', JSON.stringify({ messages }).length, 'bytes', `${count} messages`);

  // Drive a real SessionController with a stub client, and count how often it republishes the snapshot.
  const listeners = { event: [], status: [] };
  let release;
  const runInFlight = new Promise((resolve) => {
    release = resolve;
  });
  const client = {
    status: 'ready',
    subscribe: (listener) => {
      listeners.event.push(listener);
      return () => {};
    },
    subscribeStatus: (listener) => {
      listeners.status.push(listener);
      return () => {};
    },
    request: async (method) => {
      if (method === 'session.get')
        return {
          session: {
            id: session.id,
            workspace: root,
            createdAt: new Date().toISOString(),
            activeRun: null,
          },
          messages,
          statistics: undefined,
        };
      if (method === 'subagents.list') return [];
      if (method === 'plan.get') return null;
      if (method === 'changes.list') return [];
      if (method === 'background.list') return [];
      if (method === 'task.list') return [];
      return {};
    },
    // The run stays in flight while the events below are emitted: that is when the desktop publishes.
    run: async () => runInFlight,
  };
  const controller = new SessionController(client);
  await controller.load(session.id);
  const sending = controller.send('go');
  await new Promise((resolve) => setTimeout(resolve, 0));
  let publishes = 0;
  let bytes = 0;
  controller.subscribe((state) => {
    publishes++;
    bytes += JSON.stringify({ messages: state.messages }).length;
  });
  // The progress channel: how many updates arrive, and what each one costs to deliver.
  let statisticsDeltas = 0;
  let statisticsBytes = 0;
  controller.subscribeStatisticsDelta((delta) => {
    statisticsDeltas++;
    statisticsBytes += JSON.stringify(delta).length;
  });
  const emit = (type, data) => {
    for (const listener of listeners.event)
      listener({ type, sessionId: session.id, runId: 'bench-run', data });
  };
  // A run that is in flight: `run.started` first (it binds the run id every later event is matched against),
  // then one minute of a busy model call — progress statistics once a second — plus a tool call.
  emit('run.started', {});
  for (let second = 0; second < 60; second++)
    emit('statistics.updated', {
      statistics: undefined,
      activity: { kind: 'model', startedAt: 0, phase: `p${second}` },
    });
  emit('tool.started', { call: { id: 'c1', name: 'read_file', arguments: { path: 'a' } } });
  emit('tool.finished', { callId: 'c1', content: 'ok', isError: false });
  record('snapshot.publishes', publishes, 'count', 'for 60 progress events + 1 tool call');
  record(
    'snapshot.publishedBytes',
    Math.round(bytes / 1024),
    'KB',
    'total serialised across publishes',
  );
  record('snapshot.statisticsDeltas', statisticsDeltas, 'count', 'the 60 progress updates');
  record(
    'snapshot.statisticsDeltaBytes',
    statisticsBytes,
    'bytes',
    `total for ${statisticsDeltas} progress updates`,
  );
  release({ status: 'completed' });
  await sending;
  controller.dispose();
  store.close();
  await rm(root, { recursive: true, force: true });
}

console.log('\n' + JSON.stringify({ results }, null, 2));

/**
 * The gate. Every rule is either deterministic or a ratio from this run, with the reason it is a rule: a
 * threshold nobody can explain is a threshold somebody deletes.
 */
const value = (name) => results.find((result) => result.name === name)?.value;
const RULES = [
  [
    'tools.schema.all',
    (v) => v <= 40_000,
    '每个请求都带全部工具 schema：这是一条**预算**而不是不变式（今天约 31KB / 61 个工具），越过它就该决定裁掉什么，而不是再抬一次这个数',
  ],
  [
    'tools.schema.readOnly',
    // A ratio rather than a constant, and the difference matters: the invariant is "read-only hides every tool
    // that carries a permission", which stays true as the catalogue grows. "The read-only catalogue is ≤ 12KB"
    // was the size it happened to have when this rule was written, and it went stale the moment read-only tools
    // were added (language servers, knowledge, session queries) — a gate that fails for being old rather than for
    // being broken, which is exactly how a real rule gets deleted.
    (v) => v <= value('tools.schema.all') * 0.6,
    '只读目录必须显著小于全量（今天约 51%）：追平就说明裁剪失效，带权限的工具又回到了只读运行里',
  ],
  [
    'tools.count.readOnlyMode',
    (v) => Number(v) === Number(value('tools.count.readOnly')),
    '同一个只读工具集有两条问法（`readOnly: true` 与只读权限模式），它们必须给出同一个目录',
  ],
  [
    'append.durableRecordsPerMessage',
    (v) => Number(v) === 2,
    'I8：一条消息恰好一行加一条事件，多一条就是又出现了第二个事实来源',
  ],
  [
    'append.perRound',
    (v) => v <= value('append.perRoundUnbatched') * 0.75,
    '批量追加必须真的更便宜：一轮 4 条消息应当比每条一次提交省下至少 25%',
  ],
  [
    'read.threePerRoundCached.10000',
    (v) => v <= 1,
    '缓存命中时一轮三读必须几乎免费（长会话可用性就靠这一条）',
  ],
  [
    'checkpoint.foldedEvents.10000',
    (v) => Number(v) === 0,
    '重启后读检查点就不该折事件：这条一旦不为零，说明检查点没被用上，或版本守卫正在丢弃它（改过折叠就必须在这里体现）',
  ],
  [
    'store.bytesPerMessage.10000',
    (v) => Number(v) <= 1024,
    '一条消息的存储成本必须有界（今天约 440 字节）：把 base64 附件、续接状态或重复文本放进消息体，会让这一项翻倍——那正是"附件内容寻址"要移走的东西',
  ],
  [
    'context.messageSerialisations.cold',
    (v) => Number(v) <= Number(value('context.messages')),
    '一次预测最多把每条消息序列化一次：多于会话长度，说明一次预测又在做多次全量遍历',
  ],
  [
    'context.messageSerialisations.repeat',
    (v) => Number(v) === 0,
    '同一条会话再测一次不得重新序列化任何消息（逐消息缓存必须命中）——这条一旦不为零，长会话的每轮成本就又是「整段会话 × 问题数」',
  ],
  [
    'context.messageSerialisations.tail',
    (v) => Number(v) === 0,
    '测一段「刚才已经测过的尾部切片」同样不该重新序列化：一轮里那几个问题问的正是同一条会话的不同切片',
  ],
  [
    'snapshot.publishes',
    (v) => v <= 8,
    '一分钟进度更新不得再触发全量快照（统计与活动走 delta 通道）',
  ],
  [
    'snapshot.statisticsDeltas',
    (v) => v >= 60,
    '60 次进度更新必须都被送达，否则是把发布省掉而不是换了通道',
  ],
];
if (process.argv.includes('--check')) {
  const failures = RULES.filter(([name, holds]) => !holds(value(name))).map(
    ([name, , why]) => `${name} = ${value(name)}：${why}`,
  );
  if (failures.length) {
    console.error('\nbench:check failed:\n' + failures.map((line) => `  - ${line}`).join('\n'));
    process.exitCode = 1;
  } else console.log(`\nbench:check passed (${RULES.length} rules)`);
}
