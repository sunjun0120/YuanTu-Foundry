import { tmpdir } from 'node:os';
import path from 'node:path';

/** Helpers the desktop smoke files share. */

/** Polls `check` every 100 ms until it is truthy, failing after `ms`. */
export async function waitFor(check, ms = 15000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('Launcher did not reach expected state');
}

/** Where a smoke run writes screenshots and other artifacts a person may want to look at. */
export function artifactPath(relative) {
  return path.join(
    process.env.FOUNDRY_TEST_ARTIFACTS ||
      path.join(tmpdir(), 'yuantu-smoke-artifacts-' + process.pid),
    relative,
  );
}
