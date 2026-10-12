/** Run functional OS probes with the same standalone Node runtime used by the Host. */
import { checkSandboxAvailability, parseSandboxMode } from '../../packages/tools/sandbox.ts';

async function main(): Promise<void> {
  const mode = parseSandboxMode(process.argv[2], 'sandbox probe mode');
  const availability = await checkSandboxAvailability(mode, process.env);
  process.stdout.write(JSON.stringify({ availability }));
}

void main().catch((error: unknown) => {
  process.stdout.write(
    JSON.stringify({
      availability: `Native sandbox probe failed: ${String(error).slice(0, 2048)}`,
    }),
  );
  process.exitCode = 1;
});
