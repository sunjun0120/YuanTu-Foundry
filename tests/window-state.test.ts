import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  parseWindowState,
  restorableWindowState,
  safeExportName,
  WindowStateStore,
} from '../apps/desktop/window-state.ts';

const primary = { x: 0, y: 0, width: 1920, height: 1040 };
const secondary = { x: 1920, y: 0, width: 1280, height: 1024 };

test('a saved window is restored only while its title bar is on a display', () => {
  const onSecondary = { bounds: { x: 2000, y: 40, width: 1100, height: 800 }, maximized: false };
  assert.deepEqual(restorableWindowState(onSecondary, [primary, secondary]), onSecondary);
  // The second monitor is gone: the window would open where nobody can reach it.
  assert.equal(restorableWindowState(onSecondary, [primary]), null);
  // Above the top of every display, the title bar cannot be grabbed.
  const above = { bounds: { x: 100, y: -300, width: 1100, height: 800 }, maximized: false };
  assert.equal(restorableWindowState(above, [primary]), null);
  assert.equal(restorableWindowState(null, [primary]), null);
});

test('a malformed or undersized saved state is no saved state', () => {
  assert.equal(parseWindowState(null), null);
  assert.equal(parseWindowState({ bounds: { x: 0, y: 0, width: 'wide', height: 800 } }), null);
  assert.equal(parseWindowState({ bounds: { x: 0, y: 0, width: 300, height: 200 } }), null);
  assert.deepEqual(parseWindowState({ bounds: { x: 1, y: 2, width: 900, height: 700 } }), {
    bounds: { x: 1, y: 2, width: 900, height: 700 },
    maximized: false,
  });
});

test('the window state round-trips through its file, and a corrupt file reads as nothing', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'yuantu-window-state-'));
  try {
    const file = path.join(directory, 'window-state.json');
    const store = new WindowStateStore(file);
    assert.equal(store.load(), null);
    const state = { bounds: { x: 10, y: 20, width: 1000, height: 700 }, maximized: true };
    await store.save(state);
    assert.deepEqual(store.load(), state);
    await writeFile(file, '{not json', 'utf8');
    assert.equal(store.load(), null);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('an export name from the renderer cannot move the save dialog out of the workspace', () => {
  assert.equal(safeExportName('notes.md'), 'notes.md');
  assert.equal(safeExportName(undefined), 'yuantu-session.md');
  assert.equal(safeExportName(''), 'yuantu-session.md');
  assert.equal(safeExportName('../../outside.md'), 'outside.md');
  assert.equal(safeExportName('C:\\Windows\\System32\\x.txt'), 'x.txt');
  assert.equal(safeExportName('/etc/passwd'), 'passwd.md');
  assert.equal(safeExportName('..'), 'yuantu-session.md');
  assert.equal(safeExportName('a<b>:c?.md'), 'a_b__c_.md');
  assert.equal(safeExportName('report. '), 'report.md');
  assert.equal(safeExportName('CON'), '_CON.md');
});
