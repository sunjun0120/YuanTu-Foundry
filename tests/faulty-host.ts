import { createInterface } from 'node:readline';
import { appendFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
if (process.env.FIXTURE_MODE === 'startup-error') {
  process.stderr.write('secret-fixture-key\nERR_MODULE_NOT_FOUND: missing fixture package\n');
  process.exit(78);
}
const lines = createInterface({ input: process.stdin });
for await (const line of lines) {
  const request = JSON.parse(line);
  if (request.method === 'host.info')
    process.stdout.write(
      JSON.stringify({
        id: request.id,
        result: {
          protocolVersion: 1,
          runtime: 'yuantu',
          workspace: process.cwd(),
          capabilities: ['sessions'],
        },
      }) + '\n',
    );
  else if (request.method === 'run.start' && process.env.FIXTURE_MODE === 'leak-result') {
    const result = {
      runId: 'fixture-run',
      sessionId: request.params.sessionId,
      status: 'failed',
      text: '',
      usage: { inputTokens: 0, outputTokens: 0 },
      error: 'Failed: secret-fixture-key',
    };
    process.stdout.write(
      JSON.stringify({
        event: {
          type: 'run.finished',
          runId: result.runId,
          sessionId: result.sessionId,
          data: { result },
        },
      }) + '\n',
    );
    process.stdout.write(JSON.stringify({ id: request.id, result }) + '\n');
  } else if (request.method === 'session.create') {
    if (process.env.FIXTURE_MARKER) appendFileSync(process.env.FIXTURE_MARKER, 'mutation\n');
    if (process.env.FIXTURE_MODE === 'crash') process.exit(79);
    if (process.env.FIXTURE_MODE === 'malformed') {
      process.stderr.write('secret-fixture-key\n');
      process.stdout.write('invalid output secret-fixture-key\n');
    }
    // timeout mode intentionally leaves the request unanswered.
  } else process.stdout.write(JSON.stringify({ id: request.id, result: [] }) + '\n');
}
if (process.env.FIXTURE_MODE === 'crash-on-eof') {
  // A Host that dies *while* it is being shut down: the client closed stdin and the process answered with an
  // abnormal exit instead of a clean one. That is the case `AgentHostClient.close()` has to report (the
  // cleanup it was promising cannot be confirmed), as opposed to `ignore-eof`, which never exits at all.
  process.exit(79);
}
if (process.env.FIXTURE_MODE === 'ignore-eof') {
  if (process.env.FIXTURE_CHILD_MARKER)
    spawn(
      process.execPath,
      [
        '-e',
        'setTimeout(()=>require("node:fs").writeFileSync(process.env.FIXTURE_CHILD_MARKER,"bad"),1500)',
      ],
      { env: process.env, windowsHide: true, stdio: 'ignore' },
    );
  setInterval(() => {}, 1000);
}
