import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { WindowsSandboxSetup, parseSandboxSetupCommand } from '../apps/desktop/sandbox-setup.ts';

const helper = fileURLToPath(
  new URL('../packages/tools/windows-sandbox/yuantu-appcontainer.exe', import.meta.url),
);
const windows = { skip: process.platform !== 'win32' && 'needs Windows' };

test(
  'release helper confines dependency DLL loading to System32 and uses static CRT',
  windows,
  () => {
    const pe = readFileSync(helper);
    const header = pe.readUInt32LE(0x3c);
    assert.equal(pe.toString('ascii', header, header + 4), 'PE\0\0');
    const optional = header + 24;
    const is64 = pe.readUInt16LE(optional) === 0x20b;
    const directories = optional + (is64 ? 112 : 96);
    const count = pe.readUInt16LE(header + 6);
    const sectionTable = optional + pe.readUInt16LE(header + 20);
    const offset = (rva: number) => {
      for (let index = 0; index < count; index++) {
        const section = sectionTable + index * 40;
        const start = pe.readUInt32LE(section + 12);
        const rawSize = pe.readUInt32LE(section + 16);
        if (rva >= start && rva < start + rawSize)
          return pe.readUInt32LE(section + 20) + rva - start;
      }
      throw new Error('PE directory RVA does not point to file data');
    };
    const config = offset(pe.readUInt32LE(directories + 10 * 8));
    const flagOffset = is64 ? 78 : 54;
    assert.ok(pe.readUInt32LE(config) >= flagOffset + 2);
    assert.equal(
      pe.readUInt16LE(config + flagOffset),
      0x800,
      'helper dependencies must use LOAD_LIBRARY_SEARCH_SYSTEM32',
    );
    const imports = offset(pe.readUInt32LE(directories + 8));
    const names: string[] = [];
    for (let entry = imports; pe.readUInt32LE(entry + 12); entry += 20) {
      const name = offset(pe.readUInt32LE(entry + 12));
      names.push(pe.toString('ascii', name, pe.indexOf(0, name)));
    }
    assert.ok(names.length > 0);
    assert.ok(
      !names.some((name) => /^(vcruntime|msvcp|ucrtbase)/i.test(name)),
      `CRT must be statically linked: ${names.join(', ')}`,
    );
  },
);

const inventory = JSON.stringify({
  version: 1,
  profiles: [{ name: 'Yuantu.Sandbox.12345678-1234-1234-1234-123456789abc', sid: 'S-1-15-2-1' }],
});
function service(
  execute: NonNullable<ConstructorParameters<typeof WindowsSandboxSetup>[0]['execute']>,
  options = {},
) {
  return new WindowsSandboxSetup({
    platform: 'win32',
    packaged: true,
    helperPath: 'C:\\protected\\helper.exe',
    nodePath: 'C:\\protected\\node.exe',
    execute,
    ...options,
  });
}

test('initialization IPC requires acknowledgement and rejects all unrecognized input', () => {
  assert.deepEqual(parseSandboxSetupCommand({ type: 'status' }), { type: 'status' });
  assert.deepEqual(parseSandboxSetupCommand({ type: 'initialize', acknowledge: true }), {
    type: 'initialize',
    acknowledge: true,
  });
  for (const input of [
    null,
    [],
    { type: 'initialize' },
    { type: 'initialize', acknowledge: false },
    { type: 'status', path: 'cmd.exe' },
    { type: 'initialize', acknowledge: true, command: 'cmd.exe' },
    { type: 'uninstall', acknowledge: true },
  ]) {
    assert.throws(() => parseSandboxSetupCommand(input));
  }
});

test('unsupported platforms and development installs perform no subprocess or UAC work', async () => {
  let calls = 0;
  const execute = async () => {
    calls++;
    return { stdout: '1.52.1' };
  };
  assert.equal((await service(execute, { platform: 'darwin' }).status()).reason, 'platform');
  assert.equal((await service(execute, { packaged: false }).status()).reason, 'development');
  await assert.rejects(service(execute, { packaged: false }).initialize());
  assert.equal(calls, 0);
});

test('runtime and signature preflight failures never dispatch the elevation operation', async () => {
  const operations: string[] = [];
  const invalidRuntime = service(async (_file, args) => {
    operations.push(args[0]!);
    return { stdout: 'unknown' };
  });
  assert.equal((await invalidRuntime.status()).reason, 'runtime');
  await assert.rejects(invalidRuntime.initialize());
  assert.equal(
    operations.every((operation) => operation === '-p'),
    true,
  );
  operations.length = 0;
  const badRelease = service(async (_file, args) => {
    operations.push(args[0]!);
    if (args[0] === '-p') return { stdout: '1.52.1' };
    throw new Error('signature mismatch');
  });
  assert.equal((await badRelease.status()).reason, 'release');
  await assert.rejects(badRelease.initialize());
  assert.ok(!operations.includes('network-setup'));
});

test('initialization uses only captured paths and fixed operations, then verifies real status', async () => {
  const calls: [string, string[], number][] = [];
  let initialized = false;
  const setup = service(async (file, args, timeout) => {
    calls.push([file, args, timeout]);
    if (args[0] === '-p') return { stdout: '1.52.1' };
    if (args[0] === 'network-preflight') return { stdout: '{"version":1,"ready":true}' };
    if (args[0] === 'network-setup') {
      initialized = true;
      return { stdout: '' };
    }
    if (!initialized) throw new Error('not installed');
    return { stdout: inventory };
  });
  assert.deepEqual(await setup.initialize(), {
    supported: true,
    ready: true,
    installed: true,
    reason: null,
  });
  const elevated = calls.filter((call) => call[1][0] === 'network-setup');
  assert.deepEqual(elevated, [['C:\\protected\\helper.exe', ['network-setup'], 0]]);
  assert.equal(calls.at(-1)![1][0], 'network-status');
  assert.deepEqual(await setup.initialize(), {
    supported: true,
    ready: true,
    installed: true,
    reason: null,
  });
  assert.equal(calls.filter((call) => call[1][0] === 'network-setup').length, 1);
});

test('invalid status or a successful process with missing policy is not installation success', async () => {
  for (const invalid of ['{}', '{"version":1,"profiles":[]}', 'not-json']) {
    const setup = service(async (_file, args) => ({
      stdout:
        args[0] === '-p'
          ? '1.52.1'
          : args[0] === 'network-preflight'
            ? '{"version":1,"ready":true}'
            : invalid,
    }));
    await assert.rejects(setup.initialize(), /policy|status/i);
  }
});

test('concurrent initialization is refused and UAC cancellation permits a later retry', async () => {
  let rejectUac!: (reason: Error) => void;
  let announce!: () => void;
  const dispatched = new Promise<void>((resolve) => {
    announce = resolve;
  });
  const pending = new Promise<{ stdout: string }>((_resolve, reject) => {
    rejectUac = reject;
  });
  const setup = service(async (_file, args) => {
    if (args[0] === '-p') return { stdout: '1.52.1' };
    if (args[0] === 'network-preflight') return { stdout: '{"version":1,"ready":true}' };
    if (args[0] === 'network-setup') {
      announce();
      return pending;
    }
    throw new Error('not installed');
  });
  const first = setup.initialize();
  await dispatched;
  await assert.rejects(setup.initialize(), /progress|pending/i);
  rejectUac(new Error('UAC cancelled'));
  await assert.rejects(first, /cancelled/);
  await assert.rejects(setup.initialize(), /cancelled/);
});

test('unsigned development preflight refuses before any UAC or policy mutation', windows, () => {
  const reply = spawnSync(helper, ['network-preflight'], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 5000,
  });
  assert.equal(reply.error, undefined);
  assert.equal(reply.status, 125);
  assert.match(reply.stderr, /pinned signer certificate/);
});

test('unsigned development setup refuses before any UAC or policy mutation', windows, () => {
  const reply = spawnSync(helper, ['network-setup'], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 5000,
  });
  assert.equal(reply.error, undefined);
  assert.equal(reply.status, 125);
  assert.match(reply.stderr, /pinned signer certificate/);
});

test(
  'setup protocol accepts no executable, script, path, account or SID arguments',
  windows,
  () => {
    for (const operation of ['network-preflight', 'network-setup', 'network-initialize']) {
      const reply = spawnSync(helper, [operation, 'cmd.exe'], {
        encoding: 'utf8',
        windowsHide: true,
        timeout: 5000,
      });
      assert.equal(reply.error, undefined);
      assert.equal(reply.status, 125);
      assert.doesNotMatch(reply.stderr, /pinned signer certificate/);
    }
  },
);
