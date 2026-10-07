import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { installHookBridge } from '../packages/resources/hook-bridge.ts';
import type { HookDeclaration } from '../packages/resources/hook-config.ts';
import { createTools } from '../packages/tools/index.ts';
import {
  checkSandboxAvailability,
  cleanupSandbox,
  prepareSandbox,
  registerSandboxProvider,
  resolveSandboxConfig,
  sandboxProvider,
  sandboxProviders,
  setSandboxMode,
  type SandboxPlan,
  type SandboxProvider,
} from '../packages/tools/sandbox.ts';

/**
 * The sandbox seam: is the registry the *only* path, and does the category policy actually mix backends?
 *
 * The interesting assertions are the ones that would fail if the seam were decorative — a registered backend
 * being the one that prepares and the one that tears down, and a hook install that the container-only world
 * could not express at all.
 */
async function workspace(): Promise<string> {
  return await mkdtemp(path.join(os.tmpdir(), 'yuantu-sandbox-seam-'));
}
/** A backend that records what it was asked to do instead of running anything. */
function recorder(mode: 'host' | 'docker' | 'sbx'): {
  provider: SandboxProvider;
  prepared: string[];
  cleaned: SandboxPlan[];
  /** A live counter, not a copy of one: the point of the assertion is that it moves. */
  asked: { count: number };
} {
  const prepared: string[] = [];
  const cleaned: SandboxPlan[] = [];
  const asked = { count: 0 };
  const provider: SandboxProvider = {
    mode,
    description: 'test backend',
    async available() {
      asked.count += 1;
      return mode === 'host' ? null : `${mode} is unavailable in this test`;
    },
    async prepare(request) {
      prepared.push(request.command);
      return {
        executable: 'recorded-' + mode,
        args: [request.command],
        cwd: request.cwd,
        env: {},
        windowsVerbatimArguments: false,
        backend: mode,
      };
    },
    async cleanup(plan) {
      cleaned.push(plan);
    },
  };
  return { provider, prepared, cleaned, asked };
}
/** Registers a replacement for one mode and puts the built-in back afterwards, whatever the test does. */
async function withProvider(
  mode: 'host' | 'docker' | 'sbx',
  run: (fake: ReturnType<typeof recorder>) => Promise<void>,
): Promise<void> {
  const builtin = sandboxProvider(mode);
  const fake = recorder(mode);
  registerSandboxProvider(fake.provider);
  try {
    await run(fake);
  } finally {
    registerSandboxProvider(builtin);
  }
}

test('the four backends ship registered, each with something to say about itself', () => {
  assert.deepEqual(
    sandboxProviders().map((provider) => provider.mode),
    ['host', 'docker', 'sbx', 'windows'],
  );
  for (const provider of sandboxProviders()) {
    assert.ok(provider.description.length > 20, `${provider.mode} needs a description`);
  }
});

test('a mode with no backend is refused with a sentence, not a crash deep inside a spawn', () => {
  assert.throws(
    () => sandboxProvider('podman' as 'docker'),
    /No sandbox provider registered for mode podman/,
  );
});

test('prepare goes through the registered backend, not through the built-in it replaced', async () => {
  const root = await workspace();
  await withProvider('docker', async (fake) => {
    const plan = await prepareSandbox(root, root, 'echo hi', undefined, {
      mode: 'docker',
      image: 'node:24-bookworm-slim',
    });
    assert.equal(plan.executable, 'recorded-docker');
    assert.deepEqual(fake.prepared, ['echo hi']);
    assert.equal(plan.backend, 'docker');
  });
});

test('the backend that made a plan is the one that tears it down', async () => {
  const root = await workspace();
  await withProvider('sbx', async (fake) => {
    const plan = await prepareSandbox(root, root, 'echo hi', undefined, {
      mode: 'sbx',
      image: 'node:24-bookworm-slim',
    });
    await cleanupSandbox(plan);
    assert.equal(fake.cleaned.length, 1);
    assert.equal(fake.cleaned[0]?.executable, 'recorded-sbx');
  });
});

test('a host plan needs no teardown, and asking for one is not an error', async () => {
  const root = await workspace();
  const plan = await prepareSandbox(root, root, 'echo hi', undefined, {
    mode: 'host',
    image: 'host',
  });
  assert.equal(plan.backend, undefined);
  await cleanupSandbox(plan);
});

test('availability is asked of the backend, so a replaced backend answers for itself', async () => {
  await withProvider('sbx', async (fake) => {
    assert.equal(await checkSandboxAvailability('sbx'), 'sbx is unavailable in this test');
    assert.equal(fake.asked.count, 1);
  });
});

test('host is always available, and says so without running anything', async () => {
  assert.equal(await checkSandboxAvailability('host'), null);
});

test('a category inherits the global sandbox until it is told otherwise', () => {
  assert.equal(resolveSandboxConfig({}, 'command').mode, 'host');
  assert.equal(resolveSandboxConfig({}, 'hook').mode, 'host');
  assert.equal(resolveSandboxConfig({ YUANTU_SANDBOX: 'sbx' }, 'command').mode, 'sbx');
  assert.equal(resolveSandboxConfig({ YUANTU_SANDBOX: 'sbx' }, 'hook').mode, 'sbx');
});

test('commands can be confined while hooks stay on the host — the combination that needed a category', () => {
  const env = { YUANTU_SANDBOX: 'sbx', YUANTU_SANDBOX_HOOK: 'host' };
  assert.equal(resolveSandboxConfig(env, 'command').mode, 'sbx');
  assert.equal(resolveSandboxConfig(env, 'hook').mode, 'host');
  // The image is global: the categories differ in *whether* there is a container, not in which one.
  assert.equal(
    resolveSandboxConfig({ ...env, YUANTU_SANDBOX_IMAGE: 'alpine:3' }, 'hook').image,
    'alpine:3',
  );
});

test('a runtime switch outranks the environment, and only for commands', (t) => {
  t.after(() => setSandboxMode(undefined));
  const env = { YUANTU_SANDBOX: 'host', YUANTU_SANDBOX_HOOK: 'host' };
  assert.equal(resolveSandboxConfig(env, 'command').mode, 'host');
  /**
   * The desktop's per-session choice arrives this way, and it has to win: `YUANTU_SANDBOX` is where a deployment
   * starts from, and a default the interface cannot move is what this replaced. Hooks are deliberately left out —
   * the bridge is loaded once per run and no control offers it.
   */
  setSandboxMode('sbx');
  assert.equal(resolveSandboxConfig(env, 'command').mode, 'sbx');
  assert.equal(resolveSandboxConfig(env, 'hook').mode, 'host');
  assert.equal(resolveSandboxConfig(env, 'command').image, 'node:24-bookworm-slim');
  // Switching back is a value, not a deletion: the environment decides again.
  setSandboxMode(undefined);
  assert.equal(resolveSandboxConfig(env, 'command').mode, 'host');
  assert.throws(() => setSandboxMode('podman' as never), /Invalid sandbox mode/);
});

test('a mistyped category setting names the setting it came from', () => {
  assert.throws(
    () => resolveSandboxConfig({ YUANTU_SANDBOX_HOOK: 'podman' }, 'hook'),
    /Invalid YUANTU_SANDBOX_HOOK; use host, docker, sbx, or windows/,
  );
  // A bad value on a category nobody asked about is not an error: the category is what selects the setting.
  assert.equal(resolveSandboxConfig({ YUANTU_SANDBOX_HOOK: 'podman' }, 'command').mode, 'host');
  assert.throws(
    () => resolveSandboxConfig({ YUANTU_SANDBOX_IMAGE: '--privileged' }),
    /Invalid sandbox image/,
  );
});

test('the hook bridge installs when hooks are on the host and commands are sandboxed', async () => {
  const root = await workspace();
  const previousSandbox = process.env.YUANTU_SANDBOX;
  const previousHook = process.env.YUANTU_SANDBOX_HOOK;
  process.env.YUANTU_SANDBOX = 'sbx';
  try {
    const declaration: HookDeclaration = {
      file: '.yuantu/hooks.json',
      event: 'PreToolUse',
      command: 'echo allow',
      timeoutMs: 1000,
    };
    const registry = createTools(root);
    // Container hooks are refused: the two requests are incompatible and only one can be honoured.
    assert.throws(
      () =>
        installHookBridge({
          workspace: root,
          hooks: registry.extensions,
          declarations: [declaration],
        }),
      /YUANTU_SANDBOX_HOOK=sbx cannot run them/,
    );
    process.env.YUANTU_SANDBOX_HOOK = 'host';
    const disposers = installHookBridge({
      workspace: root,
      hooks: registry.extensions,
      declarations: [declaration],
    });
    assert.equal(disposers.length, 1);
    for (const dispose of disposers) dispose();
    // The refusal is specific about the way out, because the alternative (turn the sandbox off entirely) is
    // what an operator would otherwise reach for.
    assert.throws(() => {
      process.env.YUANTU_SANDBOX_HOOK = 'sbx';
      installHookBridge({
        workspace: root,
        hooks: registry.extensions,
        declarations: [declaration],
      });
    }, /YUANTU_SANDBOX_HOOK=host/);
  } finally {
    if (previousSandbox === undefined) delete process.env.YUANTU_SANDBOX;
    else process.env.YUANTU_SANDBOX = previousSandbox;
    if (previousHook === undefined) delete process.env.YUANTU_SANDBOX_HOOK;
    else process.env.YUANTU_SANDBOX_HOOK = previousHook;
    await rm(root, { recursive: true, force: true });
  }
});
