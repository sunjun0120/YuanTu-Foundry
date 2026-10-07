import path from 'node:path';
import { AgentHostClient, HostRequestError } from 'yuantu-agent/sdk';

const workspace = path.resolve(process.argv[2] ?? '.');
const hostPath = path.resolve(process.argv[3] ?? 'dist/apps/agent-host/main.js');
const client = new AgentHostClient({ nodePath: process.execPath, hostPath, workspace });
const controller = new AbortController();
const cancel = () => controller.abort();
process.once('SIGINT', cancel);
try {
  await client.start();
  const session = await client.request('session.create', {});
  client.subscribe((event) => {
    if (event.type === 'message.delta') process.stdout.write(String(event.data.text ?? ''));
    // This unattended example denies writes. Applications may ask a human and respond explicitly.
    if (event.type === 'approval.required')
      void client
        .request('approval.respond', { approvalId: String(event.data.approvalId), allow: false })
        .catch(() => controller.abort());
  });
  await client.run(
    session.id,
    process.argv[4] ?? 'Describe the workspace without modifying files.',
    { signal: controller.signal },
  );
  let afterSeq = 0;
  while (true) {
    const page = await client.request('session.events', {
      sessionId: session.id,
      afterSeq,
      limit: 100,
    });
    afterSeq = page.nextSeq;
    if (!page.more) break;
  }
  console.error(`\nSession ${session.id}, durable cursor ${afterSeq}`);
} catch (error) {
  console.error(
    error instanceof HostRequestError && error.outcomeUnknown
      ? 'Outcome unknown; inspect durable state before retrying.'
      : String(error),
  );
  process.exitCode = 1;
} finally {
  process.removeListener('SIGINT', cancel);
  await client.stop();
}
