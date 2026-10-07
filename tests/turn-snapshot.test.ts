/**
 * Whole-turn snapshots: the regression net that makes the kernel safe to change.
 *
 * Every other test in this suite asserts *something* about a run — that a tool ran, that an event fired, that a
 * failure carried a code. None of them can answer "did this turn get worse?" A snapshot answers exactly that,
 * because it records the whole observable turn: every request the run sent (model, effort, limits, per-part
 * digests and sizes, the system prompt itself), every answer it was given, the live events a client would see,
 * the durable log a reopened session would read, the final transcript, the run result and the workspace after
 * the turn.
 *
 * Two properties make it a gate rather than a log:
 *
 * - **It is deterministic.** Scripted answers plus a temp workspace remove the model and the machine, and the
 *   normalizer removes the three things that are still random — timestamps, durations, and ids (mapped to
 *   stable tokens, so the *relations* between ids survive while the values do not).
 * - **It fails on drift, loudly.** A changed system prompt, an extra event, a reordered tool result or a
 *   different final text all show up as one line naming the exact path that moved. Reviewing that diff is the
 *   whole point; `npm run snapshot:update` rewrites the file only when the change is intended.
 *
 * A scenario is input (workspace, history, prompt, options) plus the script that models the model: to cover a
 * new behaviour, add a scenario here — no endpoint, no key, no network.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Agent, type AgentOptions } from '../packages/core/agent.ts';
import { SessionStore } from '../packages/storage/sqlite.ts';
import { createTools } from '../packages/tools/index.ts';
import { ToolRegistry } from '../packages/tools/registry.ts';
import type { AgentEvent, Message } from '../packages/protocol/index.ts';
import {
  digest,
  fingerprint,
  toolFingerprint,
  replayProvider,
  type ScriptedCall,
} from './replay.ts';

/** The scripted kinds of turn this net covers today. Each one is a shape of run, not a feature list. */
interface Scenario {
  name: string;
  /** The workspace the run starts in: seed files, relative paths. */
  files?: Record<string, string>;
  /** A conversation that already happened, for scenarios that start mid-session. */
  history?: Message[];
  prompt: string;
  options?: Partial<
    Pick<AgentOptions, 'maxContextChars' | 'maxModelRetries' | 'maxParallelToolCalls'>
  >;
  script: ScriptedCall[];
  /**
   * Which tool set the run is given. `workspace` is the real registry a session gets; `empty` is for the
   * scenarios about the context budget, where the schemas of thirty tools would dwarf the window being tested.
   */
  tools?: 'workspace' | 'empty';
  /** What the scenario is *for*: asserted apart from the snapshot so a regenerated file cannot bless a broken run. */
  expect: { status: string; text: string };
}

const SCENARIOS: Scenario[] = [
  {
    name: 'plain-answer',
    files: {
      'AGENTS.md': '# 项目规则\n\n- 回答保持简短，先给结论。\n',
      'notes.md': '# 笔记\n\n- 第一条\n- 第二条\n',
    },
    prompt: '用一句话说明这个项目是做什么的。',
    script: [{ text: '这是一个只做笔记的项目。' }],
    expect: { status: 'completed', text: '这是一个只做笔记的项目。' },
  },
  {
    name: 'read-then-edit',
    files: {
      'AGENTS.md': '# 项目规则\n\n- 改动前先读文件。\n',
      'src/app.ts': 'export const version = 1;\n',
    },
    prompt: '读取 src/app.ts，把版本号改成 2。',
    // Two tool rounds and a final answer: the shape a turn takes whenever the model needs to look before it
    // writes. The edit needs approval, so this scenario also covers the approval pair in the process record.
    script: [
      {
        text: '先读一下当前内容。',
        toolCalls: [{ id: 'call-read-1', name: 'read_file', arguments: { path: 'src/app.ts' } }],
      },
      {
        text: '读到了，改这一行。',
        toolCalls: [
          {
            id: 'call-edit-1',
            name: 'edit_file',
            arguments: { path: 'src/app.ts', old_text: 'version = 1', new_text: 'version = 2' },
          },
        ],
      },
      { text: '已把 src/app.ts 的版本号改成 2。' },
    ],
    expect: { status: 'completed', text: '已把 src/app.ts 的版本号改成 2。' },
  },
  {
    name: 'transient-failure-recovered',
    files: { 'notes.md': '# 笔记\n\n- 第一条\n' },
    prompt: '继续。',
    options: { maxModelRetries: 1 },
    // A transient failure and the retry that follows it, offline: the codes, the durable `llm.retry` record and
    // the step that ended as `failed` before the second attempt succeeded are all in the snapshot.
    script: [
      { failure: { code: 'server', message: '端点暂时不可用（503）' } },
      { text: '恢复后继续。' },
    ],
    expect: { status: 'completed', text: '恢复后继续。' },
  },
  {
    name: 'compaction-before-answering',
    files: { 'notes.md': '# 笔记\n\n- 第一条\n' },
    // Seeded history rather than a long run: what matters is that the conversation is over the window when the
    // turn starts, so the summary request comes *before* the round's own request.
    history: [
      { role: 'user', content: 'Keep the blue theme. ' + 'prior discussion '.repeat(587) },
      {
        role: 'assistant',
        content: 'I will retain the blue theme.',
        toolCalls: [{ id: 'read-old', name: 'read_file', arguments: { path: 'notes.md' } }],
      },
      { role: 'tool', toolCallId: 'read-old', isError: false, content: 'old source '.repeat(500) },
      { role: 'assistant', content: 'Inspected the source.', toolCalls: [] },
    ],
    prompt: 'Continue. ' + 'next '.repeat(140),
    // The character budget covers the system prompt and the run's own tool schemas as well as the transcript
    // (see `size()` in packages/core/context.ts), and the kernel installs session retrieval on every run. The
    // summary request replays that same fixed part — system prompt, tool schemas — plus the instruction, so the
    // budget has to leave room for a *batch* of about 10 KB as well; at 14 000 the first turn could not be
    // summarized at all. The seeded turns are sized against that: the first turn is small enough to summarize
    // on its own and the tool result after it is large enough that it cannot come along, so the conversation
    // still takes two summary batches before the round's own request is sent.
    //
    // 21 000 rather than the 20 000 that first cleared it, because 20 000 cleared it by a handful of characters:
    // the prefix this budget has to hold is `system + tool schemas`, which grows whenever *any* tool description
    // grows, so at the boundary the next paragraph added to a schema turns this scenario from "a schema diff to
    // review" into "compaction is impossible" — a failure that names the context budget rather than the cause.
    // The few hundred characters here are that margin, and they do not change the shape: all three scripted
    // answers are still consumed, which is what says the conversation still takes two summary batches.
    options: { maxContextChars: 21_000 },
    tools: 'empty',
    script: [
      {
        // The summary instruction is the request's last message, so that is what identifies it; the system
        // prompt and the tool schemas are the round's own, which is the point of the shape.
        when: { messageIncludes: 'context summary' },
        text: 'Retain the blue theme. Source notes.md was inspected.',
      },
      {
        when: { messageIncludes: 'context summary' },
        text: 'Retain the blue theme; the earlier summary stands and the conversation continues.',
      },
      { text: 'Continued with the blue theme.' },
    ],
    expect: { status: 'completed', text: 'Continued with the blue theme.' },
  },
];

/**
 * Whether a key holds an id.
 *
 * Anchored on the capital `I` of `…Id`/`…Ids` (plus the bare `id`/`ids`), because an unanchored case-insensitive
 * match would also catch `valid` and quietly turn a boolean into a token.
 */
function isIdKey(key: string): boolean {
  return key === 'id' || key === 'ids' || /Ids?$/.test(key);
}

/** `time`/`id`/`ms` are the three things a run cannot do the same way twice; everything else is compared as-is. */
function normalizer(roots: { workspace: string; db: string; memory: string }) {
  const tokens = new Map<string, string>();
  const counters = new Map<string, number>();
  const group = (key: string) =>
    key === 'id' || key === 'ids' ? 'id' : key.slice(0, -2).replace(/^./, (c) => c.toLowerCase());
  const tokenFor = (key: string, value: string) => {
    const existing = tokens.get(value);
    if (existing) return existing;
    const name = group(key);
    const next = (counters.get(name) ?? 0) + 1;
    counters.set(name, next);
    const token = `<${name}:${next}>`;
    tokens.set(value, token);
    return token;
  };
  const replaceRoots = (value: string) =>
    value
      .split(roots.workspace)
      .join('<workspace>')
      .split(roots.workspace.replaceAll('\\', '/'))
      .join('<workspace>')
      .split(roots.db)
      .join('<db>')
      .split(roots.db.replaceAll('\\', '/'))
      .join('<db>')
      .split(roots.memory)
      .join('<memory>')
      .split(roots.memory.replaceAll('\\', '/'))
      .join('<memory>');
  const walk = (value: unknown, key: string): unknown => {
    if (typeof value === 'string') {
      if (isIdKey(key)) return tokenFor(key, value);
      if (/Pid$/i.test(key)) return '<pid>';
      if (key === 'at' || /At$/.test(key)) return '<time>';
      if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(value)) return '<time>';
      return replaceRoots(value);
    }
    if (typeof value === 'number') {
      if (/Ms$/.test(key)) return '<ms>';
      if (/Pid$/i.test(key)) return '<pid>';
      if (key === 'at' || /At$/.test(key)) return '<time>';
      return value;
    }
    if (Array.isArray(value)) return value.map((item) => walk(item, key));
    if (value && typeof value === 'object') {
      const out: Record<string, unknown> = {};
      for (const [inner, item] of Object.entries(value as Record<string, unknown>))
        out[inner] = walk(item, inner);
      return out;
    }
    return value;
  };
  return (value: unknown) => walk(value, '');
}

/**
 * Which difference to report first.
 *
 * Alphabetical order would report a derived counter (a token estimate that moved by five because a sentence
 * appeared) before the sentence itself. A reviewer wants the cause: the system prompt, then what the run asked,
 * then the outcome — and only then the numbers that follow from them.
 */
const REPORT_FIRST = ['system', 'requests', 'result', 'log', 'events', 'messages', 'files'];
function rank(key: string): number {
  const index = REPORT_FIRST.indexOf(key);
  return index === -1 ? REPORT_FIRST.length : index;
}

/** The first difference between two JSON values, as one readable line. `null` means they agree. */
function firstMismatch(expected: unknown, actual: unknown, at = 'snapshot'): string | null {
  if (expected === actual) return null;
  if (Array.isArray(expected) || Array.isArray(actual)) {
    if (!Array.isArray(expected) || !Array.isArray(actual))
      return `${at}: expected ${show(expected)}, got ${show(actual)}`;
    if (expected.length !== actual.length)
      return `${at}: expected ${expected.length} item(s), got ${actual.length}`;
    for (const [index, item] of expected.entries()) {
      const mismatch = firstMismatch(item, actual[index], `${at}[${index}]`);
      if (mismatch) return mismatch;
    }
    return null;
  }
  if (expected && actual && typeof expected === 'object' && typeof actual === 'object') {
    const left = expected as Record<string, unknown>;
    const right = actual as Record<string, unknown>;
    const keys = [...new Set([...Object.keys(left), ...Object.keys(right)])].sort(
      (a, b) => rank(a) - rank(b) || a.localeCompare(b),
    );
    for (const key of keys) {
      const inLeft = key in left;
      const inRight = key in right;
      if (!inLeft || !inRight)
        return `${at}.${key}: ${inLeft ? `expected ${show(left[key])}, key is gone` : `key is new, got ${show(right[key])}`}`;
      const mismatch = firstMismatch(left[key], right[key], `${at}.${key}`);
      if (mismatch) return mismatch;
    }
    return null;
  }
  return `${at}: expected ${show(expected)}, got ${show(actual)}`;
}
const show = (value: unknown) => {
  const text = JSON.stringify(value) ?? String(value);
  return text.length > 160 ? `${text.slice(0, 157)}…` : text;
};

/** Every file the turn left behind, so a scenario cannot hide a stray write. */
async function workspaceTree(
  root: string,
  normalize: (value: unknown) => unknown,
): Promise<{ path: string; content: unknown }[]> {
  const out: { path: string; content: unknown }[] = [];
  const walk = async (dir: string, prefix: string) => {
    const entries = (await readdir(dir, { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name),
    );
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(full, relative);
      else if (entry.isFile()) {
        const bytes = await readFile(full);
        out.push({
          path: relative,
          content: bytes.includes(0)
            ? `<binary: ${bytes.length} bytes>`
            : normalize(bytes.toString('utf8')),
        });
      }
    }
  };
  await walk(root, '');
  return out;
}

async function runScenario(t: test.TestContext, scenario: Scenario) {
  const workspace = await mkdtemp(path.join(tmpdir(), 'yuantu-snap-ws-'));
  const db = await mkdtemp(path.join(tmpdir(), 'yuantu-snap-db-'));
  const memory = await mkdtemp(path.join(tmpdir(), 'yuantu-snap-memory-'));
  /**
   * The two directories a run reads that are *not* the workspace. Both default to the machine's home directory,
   * which would make a snapshot depend on whose machine produced it — the one thing a committed snapshot must
   * never do.
   */
  const previous = {
    memory: process.env.YUANTU_MEMORY_DIR,
    knowledge: process.env.YUANTU_KNOWLEDGE_DB,
  };
  process.env.YUANTU_MEMORY_DIR = memory;
  process.env.YUANTU_KNOWLEDGE_DB = path.join(db, 'knowledge.sqlite');
  const store = new SessionStore(path.join(db, 'sessions.sqlite'));
  t.after(async () => {
    store.close();
    if (previous.memory === undefined) delete process.env.YUANTU_MEMORY_DIR;
    else process.env.YUANTU_MEMORY_DIR = previous.memory;
    if (previous.knowledge === undefined) delete process.env.YUANTU_KNOWLEDGE_DB;
    else process.env.YUANTU_KNOWLEDGE_DB = previous.knowledge;
    await rm(workspace, { recursive: true, force: true });
    await rm(db, { recursive: true, force: true });
    await rm(memory, { recursive: true, force: true });
  });
  for (const [relative, content] of Object.entries(scenario.files ?? {})) {
    const full = path.join(workspace, relative);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, content);
  }
  const session = store.create(workspace);
  for (const message of scenario.history ?? []) store.append(session.id, message);

  const provider = replayProvider(scenario.script);
  const events: AgentEvent[] = [];
  const agent = new Agent({
    store,
    provider,
    tools: scenario.tools === 'empty' ? new ToolRegistry() : createTools(workspace),
    approve: async () => true,
    onEvent: (event) => events.push(event),
    // One tool at a time: a parallel batch finishes in completion order, which is not a fact about the turn.
    maxParallelToolCalls: 1,
    /**
     * A window, because a real run has one: the entry points refuse a connection that declared none, so a
     * scenario without one would be snapshotting a configuration the product does not allow — and the
     * window-dependent facts (`windowRoom`, the output clamp) would silently leave the record.
     */
    maxContextTokens: 1_000_000,
    ...scenario.options,
  });
  const result = await agent.run({ sessionId: session.id, prompt: scenario.prompt });
  // Half the contract of replay: every scripted answer was used, and no request went unanswered. Reported with
  // the run's own outcome, because "the run asked nothing" and "the run failed before it could ask" are the
  // same failure here and completely different problems to fix.
  try {
    provider.assertConsumed();
  } catch (cause) {
    throw new Error(
      `${(cause as Error).message}; the run ended ${result.status}${result.error ? `: ${result.error}` : ''}`,
    );
  }

  const normalize = normalizer({ workspace, db, memory });
  const first = provider.requests[0];
  /**
   * The transcript and the log are read back through a **second connection**, because that is what a reopened
   * session sees. It costs one open, and it makes the snapshot cover durability as well as shape: a run that
   * ended with appends still sitting in the writer's buffer would show up here as missing events rather than as
   * a session that looks fine until the process exits.
   */
  const reopened = new SessionStore(path.join(db, 'sessions.sqlite'));
  const log = reopened.events(session.id);
  const messages = reopened.messages(session.id);
  reopened.close();
  return {
    observed: {
      system: first
        ? { chars: first.system.length, digest: digest(first.system), text: first.system }
        : null,
      requests: provider.requests.map(fingerprint),
      result: normalize(result),
      events: events.map((event) =>
        normalize({
          type: event.type,
          sessionId: event.sessionId,
          runId: event.runId,
          data: event.data,
        }),
      ),
      log: log.map((event) =>
        normalize({
          seq: event.seq,
          type: event.type,
          /**
           * A recorded envelope carries the whole tool catalogue — it has to, or a replayed request could not match
           * the round it replays (`context.compact`). Summarised here the same way the request's own catalogue is,
           * by the same function, because inlining the schemas would put tens of kilobytes into every snapshot and
           * turn one description tweak into a wall of diff while the digest notices it in one line.
           */
          data:
            event.type === 'context.envelope' && Array.isArray(event.data.tools)
              ? { ...event.data, tools: toolFingerprint(event.data.tools as { name: string }[]) }
              : event.data,
        }),
      ),
      messages: normalize(messages),
      files: await workspaceTree(workspace, normalize),
    },
    result,
  };
}

for (const scenario of SCENARIOS) {
  test(`snapshot: ${scenario.name}`, async (t) => {
    const { observed, result } = await runScenario(t, scenario);
    // A snapshot of a run that ended in an error would happily lock the error in, so the scenario's own
    // expectation is asserted first and separately.
    assert.equal(result.status, scenario.expect.status, result.error);
    assert.equal(result.text, scenario.expect.text);

    const snapshot = { scenario, script: scenario.script, observed };
    const file = path.join('tests', 'snapshots', `${scenario.name}.json`);
    // Through JSON and back on both sides: `undefined` properties are simply absent in a file, and a comparison
    // that forgot that would report a difference the file can never express.
    const actual: unknown = JSON.parse(JSON.stringify(snapshot));
    if (process.env.UPDATE_SNAPSHOTS === '1') {
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, `${JSON.stringify(snapshot, null, 2)}\n`);
      t.diagnostic(`updated ${file}`);
      return;
    }
    const expected: unknown = JSON.parse(await readFile(file, 'utf8'));
    const mismatch = firstMismatch(expected, actual);
    assert.equal(
      mismatch,
      null,
      mismatch
        ? `turn snapshot drifted at ${mismatch}\nReview the change; if it is intended, run \`npm run snapshot:update\` and diff ${file}.`
        : '',
    );
  });
}
