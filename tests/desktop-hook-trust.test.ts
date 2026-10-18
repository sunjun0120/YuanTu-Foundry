/**
 * The desktop half of workspace-hook trust: the review that runs before a Host starts.
 *
 * The dialog itself is Electron's; what is tested is the decision around it — when it asks, what it records,
 * and that "not this time" is neither persisted nor asked again until the declarations change.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  HookTrustReview,
  type HookTrustAnswer,
  type HookTrustQuestion,
} from '../apps/desktop/hook-trust-review.ts';
import { loadHookDeclarations } from '../packages/resources/hook-config.ts';
import {
  hookDeclarationsDigest,
  hookTrustFile,
  trustWorkspaceHooks,
  workspaceHookTrust,
} from '../packages/resources/hook-trust.ts';
import { tempRoot } from './temp-fixture.ts';

async function workspace(t: test.TestContext, command = 'echo start') {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-desktop-hooks-'));
  const state = await mkdtemp(path.join(tmpdir(), 'yuantu-hook-trust-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(state, { recursive: true, force: true });
  });
  const write = (next: string) =>
    writeFile(
      path.join(root, '.claude/settings.json'),
      JSON.stringify({
        hooks: { SessionStart: [{ hooks: [{ type: 'command', command: next }] }] },
      }),
    );
  await mkdir(path.join(root, '.claude'), { recursive: true });
  await write(command);
  return { root, env: { YUANTU_STATE_DIR: state } as NodeJS.ProcessEnv, write };
}
function asker(answers: HookTrustAnswer[]) {
  const questions: HookTrustQuestion[] = [];
  return {
    questions,
    ask: async (question: HookTrustQuestion) => {
      questions.push(question);
      return answers.shift() ?? 'skip';
    },
  };
}

test('the desktop asks with every command and its file, and records trust outside the workspace', async (t) => {
  const { root, env } = await workspace(t);
  const { questions, ask } = asker(['trust']);
  const review = new HookTrustReview(ask, env);
  assert.equal(await review.review(root), 'trusted');
  assert.equal(questions.length, 1);
  assert.equal(questions[0]!.reason, 'untrusted');
  assert.deepEqual(
    questions[0]!.declarations.map((entry) => [entry.file, entry.event, entry.command]),
    [['.claude/settings.json', 'SessionStart', 'echo start']],
  );
  const file = hookTrustFile(env);
  assert.ok(existsSync(file));
  assert.ok(path.relative(root, file).startsWith('..'), 'the record is outside the workspace');
  assert.equal(workspaceHookTrust(root, loadHookDeclarations(root), file).trusted, true);
  assert.equal(await review.review(root), 'trusted', 'trusted declarations are not asked again');
  assert.equal(questions.length, 1);
});

test('"not this time" records nothing and is not asked again until the declarations change', async (t) => {
  const { root, env, write } = await workspace(t);
  const { questions, ask } = asker(['skip', 'trust']);
  const review = new HookTrustReview(ask, env);
  assert.equal(await review.review(root), 'skipped');
  assert.equal(existsSync(hookTrustFile(env)), false, 'declining persists nothing');
  assert.equal(await review.review(root), 'skipped', 'a Host restart does not ask again');
  assert.equal(questions.length, 1);
  assert.equal(
    await new HookTrustReview(asker([]).ask, env).review(root),
    'skipped',
    'a new desktop process asks again',
  );

  await write('echo changed');
  assert.equal(await review.review(root), 'trusted');
  assert.equal(questions.length, 2, 'a change is a new question');
  await write('echo changed again');
  const later = asker(['skip']);
  assert.equal(await new HookTrustReview(later.ask, env).review(root), 'skipped');
  assert.equal(later.questions[0]!.reason, 'changed', 'the prompt says the trusted set changed');
});

test('editing a referenced script invalidates trust even when the command is unchanged', async (t) => {
  for (const command of [
    'node .hooks/check.js',
    'node ".hooks/check file.js"',
    "node '.hooks/check file.js'",
  ]) {
    const { root, env } = await workspace(t, command);
    const script = path.join(
      root,
      '.hooks',
      command.includes('file') ? 'check file.js' : 'check.js',
    );
    await mkdir(path.dirname(script));
    await writeFile(script, 'console.log("trusted");');
    const { questions, ask } = asker(['trust', 'skip', 'trust']);
    const review = new HookTrustReview(ask, env);
    assert.equal(await review.review(root), 'trusted');
    await writeFile(script, 'console.log("changed");');
    assert.deepEqual(workspaceHookTrust(root, loadHookDeclarations(root), hookTrustFile(env)), {
      trusted: false,
      reason: 'changed',
    });
    assert.equal(await review.review(root), 'skipped');
    assert.equal(questions[1]!.reason, 'changed');
    assert.equal(await review.review(root), 'skipped');
    await writeFile(script, 'console.log("changed again");');
    assert.equal(
      await review.review(root),
      'trusted',
      'changing the script also invalidates a remembered skip',
    );
  }
});

test('oversized hook references fail closed both when checking and when recording trust', async (t) => {
  const { root, env } = await workspace(t, 'node check.js');
  const script = path.join(root, 'check.js');
  await writeFile(script, 'console.log("trusted");');
  const declarations = loadHookDeclarations(root);
  const file = hookTrustFile(env);
  trustWorkspaceHooks(root, declarations, file);
  await writeFile(script, Buffer.alloc(4 * 1024 * 1024 + 1));
  assert.throws(() => hookDeclarationsDigest(root, declarations), /exceeds 4 MiB/);
  assert.throws(() => trustWorkspaceHooks(root, declarations, file), /exceeds 4 MiB/);
  const state = workspaceHookTrust(root, declarations, file);
  assert.equal(state.trusted, false);
  assert.equal(state.trusted === false && state.reason, 'unavailable');
  assert.equal(await new HookTrustReview(asker(['trust']).ask, env).review(root), 'error');
});

test('a script changed while the confirmation is open is not silently trusted', async (t) => {
  const { root, env } = await workspace(t, 'node check.js');
  const script = path.join(root, 'check.js');
  await writeFile(script, 'console.log("reviewed");');
  const review = new HookTrustReview(async () => {
    await writeFile(script, 'console.log("not reviewed");');
    return 'trust';
  }, env);
  assert.equal(await review.review(root), 'error');
  assert.equal(existsSync(hookTrustFile(env)), false);
});

test('nothing is asked when there are no hooks, the bridge is off, or trust is forced', async (t) => {
  const { root, env } = await workspace(t);
  const { questions, ask } = asker([]);
  assert.equal(
    await new HookTrustReview(ask, { ...env, YUANTU_HOOK_BRIDGE: '0' }).review(root),
    'none',
  );
  assert.equal(
    await new HookTrustReview(ask, { ...env, YUANTU_TRUST_WORKSPACE_HOOKS: '1' }).review(root),
    'none',
  );
  const bare = await tempRoot(t, 'yuantu-desktop-hooks-');
  assert.equal(await new HookTrustReview(ask, env).review(bare), 'none');
  assert.deepEqual(questions, []);
});
