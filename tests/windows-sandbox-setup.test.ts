import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { parseSandboxSetupCommand } from '../apps/desktop/sandbox-setup.ts';

const helper = fileURLToPath(
  new URL('../packages/sandbox/windows-sandbox/yuantu-sandbox.exe', import.meta.url),
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

test('initialization IPC requires acknowledgement and rejects all unrecognized input', () => {
  assert.deepEqual(parseSandboxSetupCommand({ type: 'status' }), { type: 'status' });
  assert.deepEqual(parseSandboxSetupCommand({ type: 'verify' }), { type: 'verify' });
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
    { type: 'verify', path: 'cmd.exe' },
    { type: 'initialize', acknowledge: true, command: 'cmd.exe' },
    { type: 'uninstall', acknowledge: false },
  ]) {
    assert.throws(() => parseSandboxSetupCommand(input));
  }
});
