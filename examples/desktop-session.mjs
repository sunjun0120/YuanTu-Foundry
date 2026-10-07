// Run `npm run build` first. This is a main-process-style integration example.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AgentHostClient, SessionController } from '../dist/packages/client/index.js';

const [workspace, ...parts] = process.argv.slice(2);
if (!workspace || !parts.length || workspace === '--help') {
  process.stdout.write('Usage: node examples/desktop-session.mjs <workspace> "read-only task"\n');
  process.exit(0);
}
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const client = new AgentHostClient({
  nodePath: process.execPath,
  hostPath: path.join(root, 'dist/apps/agent-host/main.js'),
  workspace: path.resolve(workspace),
});
const session = new SessionController(client);
const answered = new Set();
const unsubscribe = session.subscribe((snapshot) => {
  process.stdout.write(JSON.stringify({ type: 'snapshot', snapshot }) + '\n');
  // A real UI should display the full parameters and ask the user. This example is read-only.
  for (const approval of snapshot.approvals) {
    if (answered.has(approval.id)) continue;
    answered.add(approval.id);
    void session.approve(approval.id, false).catch(() => {});
  }
});
/**
 * Streamed text arrives on its own channel, so a client that only took snapshots would see the answer
 * appear only once it is complete. Both channels are shown here because they are complementary: the
 * snapshot says what the session *is*, the delta says what is being typed right now.
 */
const unsubscribeDelta = session.subscribeDelta((delta) => {
  process.stdout.write(JSON.stringify({ type: 'delta', delta }) + '\n');
});
const cancel = () => {
  void session.cancel();
};
process.on('SIGINT', cancel);
process.on('SIGTERM', cancel);
try {
  await client.start();
  await session.create();
  const result = await session.send(parts.join(' '));
  process.stdout.write(JSON.stringify({ type: 'result', result }) + '\n');
  process.exitCode = result.status === 'completed' ? 0 : result.status === 'cancelled' ? 130 : 1;
} catch (error) {
  process.stderr.write((error instanceof Error ? error.message : 'Session failed') + '\n');
  process.exitCode = 1;
} finally {
  process.off('SIGINT', cancel);
  process.off('SIGTERM', cancel);
  unsubscribe();
  unsubscribeDelta();
  session.dispose();
  await client.stop();
}
