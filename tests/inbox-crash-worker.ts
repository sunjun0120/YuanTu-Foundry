import { Agent } from '../packages/core/agent.ts';
import { SessionStore } from '../packages/storage/sqlite.ts';
import { createTools } from '../packages/tools/index.ts';
import type { ModelResponse } from '../packages/protocol/index.ts';
/**
 * A process that dies holding a queued follow-up.
 *
 * The point is the window the durable inbox exists for: the input has been *accepted* — the log says so — and
 * the run it was queued for never folds it into a turn, because the process stops existing. Nothing here
 * settles the entry, so what the parent reads afterwards is exactly what a crash leaves behind.
 *
 * The provider never answers, so the run is parked in its first request; that is what keeps the queue open
 * without any timing assumption about how fast a model would have replied.
 */
const [db, root] = process.argv.slice(2);
if (!db || !root) throw new Error('Expected db and root');
const store = new SessionStore(db);
const session = store.create(root);
let started!: () => void;
const running = new Promise<void>((resolve) => (started = resolve));
const agent = new Agent({
  store,
  tools: createTools(root),
  approve: async () => true,
  provider: { complete: () => new Promise<ModelResponse>(() => {}) },
  // `run.started` is emitted after the run registered its queue, so this is the deterministic point at which
  // `enqueue` is legal — no polling, no sleep.
  onEvent: (event) => {
    if (event.type === 'run.started') started();
  },
});
void agent.run({ sessionId: session.id, prompt: 'first' });
await running;
agent.enqueue(session.id, { prompt: 'queued follow-up' }, 'follow-up');
process.stdout.write(session.id + '\n');
// Simulates a crash while the input is queued and never delivered.
process.exit(74);
