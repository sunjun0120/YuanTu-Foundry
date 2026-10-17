/**
 * `killTree` answers "is the tree stopped", not "did the killer win the race".
 *
 * A caller ends a tree after deciding to stop something, and on Windows the tree can be gone before `taskkill`
 * runs: the tool then exits 128 ("the process was not found"). That answer used to reject, so an ordinary race
 * surfaced as "descendants may still be running" and failed otherwise-correct work under load. These cases pin
 * both halves of the contract: an already-dead tree is success, a live tree is actually stopped, and a pid that
 * never existed is not an error either.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { killTree } from '../packages/tools/process.ts';

/** A child that stays alive until something ends it. */
function liveChild(): ChildProcess {
  return spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    stdio: 'ignore',
    detached: process.platform !== 'win32',
    windowsHide: true,
  });
}

/** Resolve when the child is done, or reject when the deadline passes first. */
function closed(child: ChildProcess, timeoutMs = 10_000): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('the child was still running after killTree resolved')),
      timeoutMs,
    );
    child.once('close', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

test('ending a tree that already exited is success, not a termination failure', async () => {
  const child = spawn(process.execPath, ['-e', 'process.exit(0)'], {
    stdio: 'ignore',
    detached: process.platform !== 'win32',
    windowsHide: true,
  });
  await closed(child);
  assert.ok(child.pid);
  // The regression: on Windows this rejected with "descendants may still be running" because taskkill exits 128
  // once the pid is gone.
  await killTree(child.pid);
});

test('ending a tree that was never running is success', async () => {
  // A pid no process owns; both platforms report the tree as gone.
  await killTree(0x7ffffffe);
});

test('ending a live tree stops it', { timeout: 20_000 }, async () => {
  const child = liveChild();
  try {
    await new Promise<void>((resolve) => child.once('spawn', () => resolve()));
    assert.ok(child.pid);
    await killTree(child.pid);
    await closed(child);
    assert.notEqual(child.exitCode, null, 'the child has exited');
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
});
