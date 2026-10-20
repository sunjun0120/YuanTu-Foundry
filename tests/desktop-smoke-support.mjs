import { tmpdir } from 'node:os';
import path from 'node:path';

/** Helpers the desktop smoke files share. */

/**
 * The text of one wire message.
 *
 * A provider may send a user message as a string or as text blocks, and the smoke fixtures have to read both:
 * keying on `typeof content === 'string'` silently misses every block-shaped prompt.
 */
export function messageText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content))
    return content
      .map((block) =>
        block && typeof block === 'object' && typeof block.text === 'string' ? block.text : '',
      )
      .join('');
  return '';
}

/**
 * Whether this request is the automatic-verification nudge.
 *
 * The nudge is a user-role message, not a user instruction; a fixture that keys on the last tool result would
 * otherwise answer it by starting the same command again. Answer it with the final answer instead.
 */
export function verificationNudge(body) {
  const last = body?.messages?.at(-1);
  return last?.role === 'user' && messageText(last.content).includes('no verification checks yet');
}

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
