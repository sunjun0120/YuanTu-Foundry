import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Agent } from '../packages/core/agent.ts';
import {
  READ_SESSION_EVENTS,
  SEARCH_SESSION_EVENTS,
  SEARCH_SESSIONS,
  TRACE_SESSION,
  sessionQueryTools,
} from '../packages/core/session-query.ts';
import { SessionStore } from '../packages/storage/sqlite.ts';
import { ToolRegistry } from '../packages/tools/registry.ts';
import type {
  ModelRequest,
  ModelResponse,
  Provider,
  Tool,
  ToolContext,
} from '../packages/protocol/index.ts';

/**
 * Session retrieval: the model can search the workspace's own history and walk a session's log.
 *
 * The index has existed since schema v10 and the session list has used it; what was missing was any way for the
 * *model* to reach it, so "how did we set this up last time" had to be answered by the user or re-derived. These
 * tests pin the parts that make the answer trustworthy rather than merely present:
 *
 * - **ranked, with the text that matched** — a list of session ids would tell the model the words exist somewhere
 *   it cannot see;
 * - **bounded everywhere** (query length, sessions, excerpts per session, events per page, characters per page),
 *   because a search that can return the whole database is the failure this exists to avoid;
 * - **the scope is stated** — this workspace only, sub-agent sessions excluded exactly as the session list
 *   excludes them, and a session from another workspace refused by name;
 * - **read-only** — no `permission`, so a planning run keeps both tools.
 */

interface Fixture {
  root: string;
  /** The workspace the store resolves sessions into: the temp directory itself, as a real path. */
  workspace: string;
  store: SessionStore;
  /** The session the tools are scoped to. */
  session: ReturnType<SessionStore['create']>;
  tools: Tool[];
  context: ToolContext;
}
async function fixture(t: test.TestContext): Promise<Fixture> {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-session-query-'));
  const store = new SessionStore(path.join(root, 'sessions.sqlite'));
  t.after(async () => {
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  // A workspace is a path: the store resolves what it is given, so a literal like "ws" would come back as
  // `<cwd>/ws` and compare unequal to the value this test passes in. The temp directory is the real thing.
  const workspace = root;
  const session = store.create(workspace);
  return {
    root,
    workspace,
    store,
    session,
    tools: sessionQueryTools({ store, workspace, sessionId: session.id }),
    context: { signal: new AbortController().signal, approve: async () => true },
  };
}
function toolNamed(tools: readonly Tool[], name: string): Tool {
  const tool = tools.find((entry) => entry.name === name);
  assert.ok(tool, `${name} is registered`);
  return tool;
}
/** Records a session the way a conversation would: a title, some messages, in order. */
function record(
  store: SessionStore,
  workspace: string,
  title: string,
  messages: string[],
  parentSessionId?: string,
): ReturnType<SessionStore['create']> {
  const session = store.create(workspace, parentSessionId);
  // Explicit rather than derived from the first message: a title that does *not* appear in the body is exactly
  // the case one of these tests is about.
  store.rename(session.id, title);
  for (const content of messages) store.append(session.id, { role: 'user', content });
  return session;
}

test('a search returns ranked sessions with the text that matched', async (t) => {
  const { workspace, store, session, tools, context } = await fixture(t);
  record(store, workspace, 'unrelated', ['nothing to see here']);
  const rich = record(store, workspace, 'deploy checklist', [
    'the deploy checklist says to run migrations first',
    'and the deploy checklist also mentions the smoke suite',
  ]);
  // Both words, once: a weaker match than `rich`, so the ranking has something to rank.
  const thin = record(store, workspace, 'one mention', ['the deploy checklist is short']);
  const result = await toolNamed(tools, SEARCH_SESSIONS).execute!(
    { query: 'deploy checklist' },
    context,
  );
  assert.equal(result.isError, false);
  const lines = result.content.split('\n');
  assert.match(lines[0]!, /match "deploy checklist", best first/);
  // Ranked by bm25 rather than by date: the session that mentions both words twice comes first.
  assert.ok(
    result.content.indexOf(rich.id) < result.content.indexOf(thin.id),
    `the best match is first: ${result.content}`,
  );
  assert.match(result.content, /«deploy»/, 'the matched text is marked, not left implicit');
  assert.match(result.content, /«checklist»/);
  assert.match(result.content, /2 matching message\(s\), showing 2:/);
  assert.match(result.content, /\(seq \d+\)/, 'each excerpt carries the position to continue from');
  assert.ok(
    !result.content.includes(session.id),
    'the current session has nothing to do with the query',
  );
  assert.ok(!result.content.includes('unrelated'), 'a session with no match is not returned');
});

test('a session that matches only by title is still findable', async (t) => {
  const { workspace, store, tools, context } = await fixture(t);
  const named = record(store, workspace, 'release runbook', [
    'nothing in the body says those words',
  ]);
  const result = await toolNamed(tools, SEARCH_SESSIONS).execute!({ query: 'runbook' }, context);
  assert.equal(result.isError, false);
  assert.match(result.content, new RegExp(named.id));
  assert.match(result.content, /matched by title; no message repeats those words/);
});

test('search never leaves the workspace, and never reads a sub-agent’s session', async (t) => {
  const { root, workspace, store, tools, context } = await fixture(t);
  const other = record(store, path.join(root, 'somewhere-else'), 'other workspace', [
    'deploy checklist elsewhere',
  ]);
  // A child session, not a fork: the session list hides these and the search does too.
  const parent = store.create(workspace);
  store.rename(parent.id, 'parent');
  const realChild = record(
    store,
    workspace,
    'sub-agent',
    ['deploy checklist from a sub-agent'],
    parent.id,
  );
  const visible = record(store, workspace, 'mine', ['the deploy checklist we agreed on']);
  const result = await toolNamed(tools, SEARCH_SESSIONS).execute!(
    { query: 'deploy checklist' },
    context,
  );
  assert.ok(result.content.includes(visible.id), 'the workspace’s own conversation is there');
  assert.ok(!result.content.includes(other.id), 'another workspace is not searched');
  assert.ok(!result.content.includes(realChild.id), 'a sub-agent’s session is not a conversation');
  // Asked for explicitly, they are readable — the store can answer a question the tool chose not to ask.
  const withChildren = store.searchSessions('deploy checklist', {
    workspace,
    includeChildren: true,
  });
  assert.ok(withChildren.hits.some((hit) => hit.session.id === realChild.id));
});

test('a parent filter follows one session’s children instead of the workspace’s conversations', async (t) => {
  const { root, workspace, store, tools, context } = await fixture(t);
  const delegator = record(store, workspace, 'delegator', [
    'the deploy checklist is over here somewhere',
  ]);
  const child = record(
    store,
    workspace,
    'sub-agent',
    ['deploy checklist, as handed to the sub-agent'],
    delegator.id,
  );
  const conversation = record(store, workspace, 'mine', ['the deploy checklist we agreed on']);
  const search = toolNamed(tools, SEARCH_SESSIONS);
  const unfiltered = await search.execute!({ query: 'deploy checklist' }, context);
  assert.ok(!unfiltered.content.includes(child.id), 'a sub-agent’s session is not a conversation');
  const filtered = await search.execute!(
    { query: 'deploy checklist', parent: delegator.id },
    context,
  );
  assert.equal(filtered.isError, false);
  assert.match(filtered.content, new RegExp(child.id), 'the child is what the filter asked for');
  assert.ok(
    !filtered.content.includes(conversation.id),
    'and the workspace’s own conversations are out of scope for it',
  );
  assert.match(
    filtered.content,
    new RegExp(`the sessions started by ${delegator.id}`),
    'what was searched is stated, so an empty answer cannot read as "this workspace has nothing"',
  );
  // The filter is a scope rather than a hint: an id this run may not read is refused by name, because "no
  // session started that" and "that session is elsewhere" are different answers.
  const elsewhere = record(store, path.join(root, 'somewhere-else'), 'other', ['deploy checklist']);
  const foreign = await search.execute!(
    { query: 'deploy checklist', parent: elsewhere.id },
    context,
  );
  assert.equal(foreign.isError, true);
  assert.match(foreign.content, /another workspace/);
  const missing = await search.execute!({ query: 'deploy checklist', parent: 'nope' }, context);
  assert.equal(missing.isError, true);
  assert.match(missing.content, /No session "nope"/);
});

test('the active filter reads the recorded run, and an empty one still says what it searched', async (t) => {
  const { workspace, store, tools, context } = await fixture(t);
  const running = record(store, workspace, 'running now', [
    'the deploy checklist is being applied',
  ]);
  record(store, workspace, 'idle', ['the deploy checklist was applied last week']);
  const search = toolNamed(tools, SEARCH_SESSIONS);
  const none = await search.execute!({ query: 'deploy checklist', active: true }, context);
  assert.equal(none.isError, false);
  assert.match(
    none.content,
    /Nothing in the sessions with a run in flight matches/,
    'the empty answer names the set it searched, not the workspace',
  );
  store.beginRun(running.id);
  const filtered = await search.execute!({ query: 'deploy checklist', active: true }, context);
  assert.ok(filtered.content.includes(running.id), 'the session with a run in flight is there');
  assert.ok(!filtered.content.includes('idle'), 'a session with no run in flight is not "active"');
  assert.match(filtered.content, /the sessions with a run in flight/);
});

test('a trace names the session it descends from and the sub-agent sessions under it', async (t) => {
  const { workspace, store, tools, context } = await fixture(t);
  const delegator = record(store, workspace, 'delegator', ['do the thing']);
  const child = record(store, workspace, 'sub-agent', ['did the thing'], delegator.id);
  const trace = toolNamed(tools, TRACE_SESSION);
  const under = await trace.execute!({ sessionId: delegator.id }, context);
  assert.equal(under.isError, false);
  assert.match(under.content, /1 sub-agent session\(s\) recorded under this one/);
  assert.match(under.content, new RegExp(child.id), 'the child is named, not just counted');
  assert.match(under.content, /Nothing has run in this session yet/);
  const from = await trace.execute!({ sessionId: child.id }, context);
  assert.match(
    from.content,
    new RegExp(`lineage: started from ${delegator.id} · delegator`),
    'the other direction is answered from the same column',
  );
  // Capped, and the count stays the real one when it is: the list is orientation, not the answer.
  for (let index = 0; index < 11; index += 1)
    record(store, workspace, `helper ${index}`, ['helped'], delegator.id);
  const many = await trace.execute!({ sessionId: delegator.id }, context);
  assert.match(many.content, /12 sub-agent session\(s\) recorded under this one, first 10 shown:/);
  assert.equal((many.content.match(/^ {2}\S+ · .* · created /gm) ?? []).length, 10, 'ten lines');
});

test('an empty or unindexable query matches nothing instead of throwing', async (t) => {
  const { workspace, store, tools, context } = await fixture(t);
  record(store, workspace, 'anything', ['some words']);
  const search = toolNamed(tools, SEARCH_SESSIONS);
  const punctuation = await search.execute!({ query: '??? *** "NEAR' }, context);
  assert.equal(punctuation.isError, false, 'FTS5 syntax never reaches MATCH verbatim');
  assert.match(punctuation.content, /Nothing in this workspace matches/);
  const blank = await search.execute!({ query: '   ' }, { ...context });
  assert.equal(blank.isError, true);
  const tooLong = await search.execute!({ query: 'x'.repeat(201) }, context);
  assert.equal(tooLong.isError, true, 'the store refuses an unbounded query');
});

test('the search bounds the sessions and the excerpts it returns', async (t) => {
  const { workspace, store, context, tools } = await fixture(t);
  for (let index = 0; index < 12; index += 1)
    record(store, workspace, `session ${index}`, [
      `needle number ${index}`,
      `needle again ${index}`,
    ]);
  const result = await toolNamed(tools, SEARCH_SESSIONS).execute!(
    { query: 'needle', limit: 50 },
    context,
  );
  assert.equal(result.isError, false);
  assert.equal(
    (result.content.match(/^### /gm) ?? []).length,
    10,
    'the session ceiling holds even when the caller asks for more',
  );
  for (const line of result.content.split('\n').filter((entry) => entry.startsWith('- [')))
    assert.ok(!line.includes('needle again'), 'three excerpts per session, not all of them');
});

test('read_session_events walks the log with a cursor and says when it is done', async (t) => {
  const { store, session, tools, context } = await fixture(t);
  store.recordEvent(session.id, 'run.started', { runId: 'r1' });
  store.recordEvent(session.id, 'message.user', {
    message: { role: 'user', content: 'hello there' },
  });
  store.recordEvent(session.id, 'step.finished', { step: 0, reason: 'final' });
  const read = toolNamed(tools, READ_SESSION_EVENTS);
  const first = await read.execute!({ sessionId: session.id, limit: 2 }, context);
  assert.equal(first.isError, false);
  assert.match(first.content, /from seq 0/);
  assert.match(first.content, /2 event\(s\) shown/);
  assert.match(first.content, /seq \d+ {2}run\.started/);
  assert.match(
    first.content,
    /user: hello there/,
    'a message event is shown as the message it carries',
  );
  assert.match(
    first.content,
    /more remain — call read_session_events\(\{ sessionId: "[^"]+", afterSeq: \d+ \}\)/,
  );
  const cursor = Number(/afterSeq: (\d+)/.exec(first.content)![1]);
  const second = await read.execute!({ sessionId: session.id, afterSeq: cursor }, context);
  assert.match(second.content, /that is the end of the log\./);
  assert.match(second.content, /final/, 'the event after the cursor is the one that was left out');
});

test('a read can be narrowed by event type, and an unknown type is refused', async (t) => {
  const { store, session, tools, context } = await fixture(t);
  store.recordEvent(session.id, 'run.started', { runId: 'r1' });
  store.recordEvent(session.id, 'message.user', { message: { role: 'user', content: 'kept' } });
  store.recordEvent(session.id, 'message.assistant', {
    message: { role: 'assistant', content: 'also kept' },
  });
  store.recordEvent(session.id, 'run.finished', { status: 'completed' });
  const read = toolNamed(tools, READ_SESSION_EVENTS);
  const filtered = await read.execute!(
    { sessionId: session.id, types: ['message.user', 'message.assistant'] },
    context,
  );
  assert.equal(filtered.isError, false);
  assert.match(filtered.content, /filtered to message\.user, message\.assistant/);
  assert.match(filtered.content, /kept/);
  assert.ok(!filtered.content.includes('run.started'), 'the other types are not shown');
  const unknown = await read.execute!(
    { sessionId: session.id, types: ['message.whisper'] },
    context,
  );
  assert.equal(unknown.isError, true);
  assert.match(unknown.content, /Unknown event type "message.whisper"/);
  assert.match(unknown.content, /Known types: /);
});

test('a session from another workspace is refused by name, and an unknown one is an error', async (t) => {
  const { root, store, tools, context } = await fixture(t);
  const elsewhere = record(store, path.join(root, 'other-workspace'), 'not mine', ['secret']);
  const read = toolNamed(tools, READ_SESSION_EVENTS);
  const refused = await read.execute!({ sessionId: elsewhere.id }, context);
  assert.equal(refused.isError, true);
  assert.match(refused.content, /belongs to another workspace \([^)]*other-workspace\)/);
  const missing = await read.execute!({ sessionId: 'no-such-session' }, context);
  assert.equal(missing.isError, true);
});

test('a page bounds what one event may spend', async (t) => {
  const { store, session, tools, context } = await fixture(t);
  store.recordEvent(session.id, 'message.tool', {
    message: { role: 'tool', toolCallId: 'call-1', content: 'x'.repeat(5_000) },
  });
  const page = await toolNamed(tools, READ_SESSION_EVENTS).execute!(
    { sessionId: session.id },
    context,
  );
  assert.equal(page.isError, false);
  const line = page.content.split('\n').find((entry) => entry.includes('message.tool'))!;
  assert.ok(
    line.length < 700,
    `one event cannot spend the page's budget: ${line.length} characters`,
  );
  assert.match(line, /…$/, 'the cut is announced rather than hidden');
});

test('search_session_events finds a durable fact inside the log, and pages with a cursor', async (t) => {
  const { store, session, tools, context } = await fixture(t);
  store.recordEvent(session.id, 'run.started', { runId: 'r1' });
  store.recordEvent(session.id, 'approval.decided', {
    approval: { id: 'a1', tool: 'write_file', description: 'write report.md' },
    allow: false,
    reason: 'user',
  });
  store.recordEvent(session.id, 'message.user', { message: { role: 'user', content: 'carry on' } });
  store.recordEvent(session.id, 'approval.decided', {
    approval: { id: 'a2', tool: 'run_command', description: 'run the suite' },
    allow: true,
    reason: 'user',
  });
  const search = toolNamed(tools, SEARCH_SESSION_EVENTS);
  const all = await search.execute!({ query: 'approval' }, context);
  assert.equal(all.isError, false);
  assert.match(all.content, /2 match\(es\) in \d+ event\(s\) scanned/);
  const first = await search.execute!({ query: 'approval', limit: 1 }, context);
  const cursor = Number(/afterSeq: (\d+)/.exec(first.content)![1]);
  const rest = await search.execute!({ query: 'approval', afterSeq: cursor }, context);
  assert.match(rest.content, /run the suite/, 'the second decision is past the cursor');
  assert.ok(!rest.content.includes('write report.md'), 'and the first one is not repeated');
  const filtered = await search.execute!({ query: 'write', types: ['approval.decided'] }, context);
  assert.match(filtered.content, /write report\.md/);
  const unknownType = await search.execute!(
    { query: 'write', types: ['message.whisper'] },
    context,
  );
  assert.equal(unknownType.isError, true);
  const nothing = await search.execute!({ query: 'not-anywhere-in-this-log' }, context);
  assert.match(nothing.content, /No match in the scanned part of the log\./);
});
test('trace_session outlines each run: rounds, tools, failures and how it ended', async (t) => {
  const { store, session, tools, context } = await fixture(t);
  store.recordEvent(session.id, 'run.started', { runId: 'r1' });
  store.recordEvent(session.id, 'message.assistant', {
    message: {
      role: 'assistant',
      content: '',
      toolCalls: [{ id: 'c1', name: 'read_file', arguments: {} }],
    },
  });
  store.recordEvent(session.id, 'message.tool', {
    message: { role: 'tool', toolCallId: 'c1', content: 'ENOENT: no such file', isError: true },
  });
  store.recordEvent(session.id, 'step.finished', { runId: 'r1', step: 0, reason: 'final' });
  store.recordEvent(session.id, 'step.finished', { runId: 'r1', step: 1, reason: 'final' });
  store.recordEvent(session.id, 'subagent.assigned', {
    runId: 'r1',
    id: 'task-1',
    role: 'explore',
    objective: 'survey the loader',
    childSessionId: 'child-1',
  });
  store.recordEvent(session.id, 'run.finished', {
    runId: 'r1',
    status: 'failed',
    error: 'provider refused',
    code: 'PROVIDER_ERROR',
  });
  // A second run that started and never finished: the trace has to show it as open, not as absent.
  store.recordEvent(session.id, 'run.started', { runId: 'r2' });
  const trace = await toolNamed(tools, TRACE_SESSION).execute!({}, context);
  assert.equal(trace.isError, false);
  assert.match(trace.content, /2 run\(s\) recorded, 2 shown/);
  assert.match(
    trace.content,
    /run r1 — 2 round\(s\), 1 tool call\(s\), 1 sub-agent\(s\), ended failed/,
  );
  assert.match(trace.content, /tools: read_file×1/);
  assert.match(trace.content, /failed: read_file: ENOENT: no such file/);
  assert.match(trace.content, /delegated: survey the loader/);
  assert.match(trace.content, /error: provider refused/);
  assert.match(trace.content, /failure code: PROVIDER_ERROR/);
  assert.match(trace.content, /run r2 — 0 round\(s\), 0 tool call\(s\), still open or cut off/);
  assert.match(trace.content, /error: provider refused/);
});
test('trace_session keeps the newest runs when a session has more than the limit', async (t) => {
  const { store, session, tools, context } = await fixture(t);
  for (let index = 0; index < 5; index += 1) {
    store.recordEvent(session.id, 'run.started', { runId: `r${index}` });
    store.recordEvent(session.id, 'run.finished', { runId: `r${index}`, status: 'completed' });
  }
  const trace = await toolNamed(tools, TRACE_SESSION).execute!({ limit: 2 }, context);
  assert.match(trace.content, /5 run\(s\) recorded, 2 shown \(oldest 3 omitted\)/);
  assert.match(trace.content, /run r4/);
  assert.ok(!trace.content.includes('run r2'), 'the trimmed runs are not listed');
});
test('a trace of another workspace’s session is refused by name', async (t) => {
  const { root, store, tools, context } = await fixture(t);
  const elsewhere = record(store, path.join(root, 'other-workspace'), 'not mine', ['secret']);
  const trace = await toolNamed(tools, TRACE_SESSION).execute!(
    { sessionId: elsewhere.id },
    context,
  );
  assert.equal(trace.isError, true);
  assert.match(trace.content, /belongs to another workspace/);
  const missing = await toolNamed(tools, TRACE_SESSION).execute!(
    { sessionId: 'no-such-session' },
    context,
  );
  assert.equal(missing.isError, true);
  assert.match(missing.content, /No session "no-such-session"/);
});
test('every session-query tool is read-only, so a planning run keeps them all', async (t) => {
  const { tools } = await fixture(t);
  assert.deepEqual(
    tools.map((tool) => tool.name).sort(),
    [READ_SESSION_EVENTS, SEARCH_SESSION_EVENTS, SEARCH_SESSIONS, TRACE_SESSION].sort(),
  );
  for (const tool of tools) {
    assert.equal(tool.permission, undefined, `${tool.name} asks for no permission`);
    assert.equal(typeof tool.execute, 'function');
  }
});

test('a running agent is offered both tools and can search an earlier session', async (t) => {
  const { workspace, store } = await fixture(t);
  const earlier = record(store, workspace, 'deploy checklist', [
    'the deploy checklist says run the migrations first',
  ]);
  const session = store.create(workspace);
  const seen: ModelRequest[] = [];
  let round = 0;
  const provider: Provider = {
    async complete(request) {
      seen.push(request);
      round++;
      if (round === 1) return toolCall('search-1', SEARCH_SESSIONS, { query: 'deploy checklist' });
      if (request.messages.some((message) => message.content.includes(earlier.id)))
        return reply('Found it: migrations first');
      return reply('Done');
    },
  };
  const agent = new Agent({
    store,
    provider,
    tools: new ToolRegistry(),
    approve: async () => true,
  });
  const result = await agent.run({ sessionId: session.id, prompt: 'How did we deploy last time?' });
  assert.equal(result.status, 'completed', result.error);
  assert.ok(seen[0]?.tools.some((tool) => tool.name === SEARCH_SESSIONS));
  assert.ok(seen[0]?.tools.some((tool) => tool.name === READ_SESSION_EVENTS));
  assert.ok(seen[0]?.tools.some((tool) => tool.name === SEARCH_SESSION_EVENTS));
  assert.ok(seen[0]?.tools.some((tool) => tool.name === TRACE_SESSION));
  const output = store
    .messages(session.id)
    .filter((message) => message.role === 'tool')
    .map((message) => String(message.content))
    .join('\n');
  assert.match(output, new RegExp(earlier.id));
  assert.match(
    output,
    /run the migrations first/,
    'the excerpt is in the tool result the model reads',
  );
  assert.equal(round, 2);
});

const reply = (text = 'Done'): ModelResponse => ({
  text,
  toolCalls: [],
  finishReason: 'stop',
  usage: { inputTokens: 10, outputTokens: 5 },
});
const toolCall = (id: string, name: string, args: Record<string, unknown>): ModelResponse => ({
  text: '',
  finishReason: 'tool_calls',
  toolCalls: [{ id, name, arguments: args }],
  usage: { inputTokens: 10, outputTokens: 5 },
});

test('a search walks its ranked list page by page without repeating or skipping a session', async (t) => {
  /**
   * The claim a cursor has to earn: page two is the *continuation* of page one.
   *
   * The ordering is recomputed on every call (it is a summed relevance over a bounded row slice, not a stored
   * index), so the property worth asserting is that the pages together are exactly the ranked list, in order and
   * with no session appearing twice — which is what the id tie-break in the ordering exists for.
   */
  const { workspace, store } = await fixture(t);
  const created = Array.from({ length: 6 }, (_, index) =>
    record(store, workspace, `deploy run ${index}`, [`the deploy checklist step ${index}`]),
  );
  const whole = store.searchSessions('deploy checklist', { workspace, limit: 6 });
  assert.ok(whole.rankedTotal >= 5, `the window has the sessions in it: ${whole.rankedTotal}`);

  const first = store.searchSessions('deploy checklist', { workspace, limit: 2 });
  assert.equal(first.hits.length, 2);
  assert.ok(first.cursor, 'a page with more behind it hands back a cursor');
  const second = store.searchSessions('deploy checklist', {
    workspace,
    limit: 2,
    cursor: first.cursor!,
  });
  const third = store.searchSessions('deploy checklist', {
    workspace,
    limit: 2,
    cursor: second.cursor!,
  });
  const walked = [...first.hits, ...second.hits, ...third.hits].map((hit) => hit.session.id);
  assert.equal(new Set(walked).size, walked.length, 'no session is on two pages');
  assert.deepEqual(
    walked,
    whole.hits.map((hit) => hit.session.id),
    'the pages are the ranked list, in order',
  );
  // Every session the fixture created is reachable by walking, which is the point of a cursor.
  for (const session of created) assert.ok(walked.includes(session.id), session.id);
});

test('the last page says it is the last, and a cursor from another shape is refused', async (t) => {
  const { workspace, store } = await fixture(t);
  record(store, workspace, 'deploy checklist', [
    'the deploy checklist says to run migrations first',
  ]);
  const only = store.searchSessions('deploy checklist', { workspace, limit: 5 });
  assert.equal(only.hits.length, 1);
  assert.equal(only.cursor, undefined, 'nothing behind it, so no cursor to hand back');
  // Refused rather than ignored: silently starting from the top is how "the next page" becomes the first one
  // again, with no sign that anything went wrong.
  for (const bad of [
    '',
    '   ',
    'not-base64-at-all',
    Buffer.from('{"v":2,"offset":0}').toString('base64url'),
    Buffer.from('{"v":1,"offset":-1}').toString('base64url'),
    Buffer.from('{"v":1}').toString('base64url'),
    Buffer.from('{"v":1,"offset":"3"}').toString('base64url'),
  ])
    assert.throws(
      () => store.searchSessions('deploy checklist', { workspace, cursor: bad }),
      /Invalid session search cursor/,
      `cursor ${JSON.stringify(bad)}`,
    );
});

test('a search that returns a page says how big the list it walked was', async (t) => {
  // `rankedTotal` is the size of the window the cursor is a position in, not a claim about the database: a caller
  // showing "N results" must not read it as "N sessions match".
  const { workspace, store } = await fixture(t);
  for (let index = 0; index < 4; index += 1)
    record(store, workspace, `deploy ${index}`, [`the deploy checklist part ${index}`]);
  const page = store.searchSessions('deploy checklist', { workspace, limit: 1 });
  assert.equal(page.hits.length, 1);
  assert.equal(page.rankedTotal, 4, 'all four are in the window even though one was returned');
});
