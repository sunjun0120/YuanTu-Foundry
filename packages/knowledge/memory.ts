import { mkdirSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { atomicWriteFile } from '../tools/write-all.ts';

/**
 * Durable memory is a markdown file the user can read and edit, not a database row.
 * Two files are used: `<workspace>/.yuantu/memory.md` for project decisions and
 * `~/.yuantu/memory.md` for user-wide preferences. Only the entry bullets are managed;
 * anything else the user writes is preserved verbatim.
 */
export interface MemoryEntry {
  key: string;
  text: string;
  updatedAt: string;
}
export interface MemoryFile {
  /** User-written markdown that is not a managed entry; preserved across writes. */
  preamble: string;
  entries: MemoryEntry[];
}
export interface MemoryScopeEntry extends MemoryEntry {
  scope: 'global' | 'workspace';
}
const keyPattern = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const entryPattern = /^- \*\*([a-z0-9][a-z0-9._-]{0,63})\*\*: (.*) \((\d{4}-\d{2}-\d{2})\)$/;
const header = '# YuanTu memory';
const note =
  '<!-- One bullet per managed memory. Text outside these bullets is kept as written. -->';
export const memoryLimits = {
  entries: 64,
  text: 500,
  bytes: 32_768,
  injectedEntries: 12,
  injectedChars: 4000,
};

export function memoryPaths(
  root: string,
  globalDir = process.env.YUANTU_MEMORY_DIR || path.join(os.homedir(), '.yuantu'),
): { workspace: string; global: string } {
  return {
    workspace: path.join(root, '.yuantu', 'memory.md'),
    global: path.join(globalDir, 'memory.md'),
  };
}
export function parseMemory(text: string): MemoryFile {
  const entries: MemoryEntry[] = [];
  const preamble: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const match = entryPattern.exec(line);
    if (match) entries.push({ key: match[1]!, text: match[2]!, updatedAt: match[3]! });
    else if (line.trim() === header || line.trim() === note) continue;
    else preamble.push(line);
  }
  while (preamble.length && !preamble[0]!.trim()) preamble.shift();
  while (preamble.length && !preamble.at(-1)!.trim()) preamble.pop();
  return { preamble: preamble.join('\n'), entries };
}
export function renderMemory(memory: MemoryFile): string {
  const lines = [header, '', note];
  if (memory.preamble) lines.push('', memory.preamble);
  if (memory.entries.length)
    lines.push(
      '',
      ...memory.entries.map((entry) => `- **${entry.key}**: ${entry.text} (${entry.updatedAt})`),
    );
  return lines.join('\n') + '\n';
}
export function readMemoryFile(file: string): MemoryFile {
  try {
    return parseMemory(readFileSync(file, 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { preamble: '', entries: [] };
    throw error;
  }
}
function normalizeKey(value: unknown): string {
  if (typeof value !== 'string' || !keyPattern.test(value))
    throw new Error(
      'Invalid memory key; use lowercase letters, digits, dot, dash or underscore (max 64)',
    );
  return value;
}
function normalizeText(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Invalid memory content');
  const text = value.replace(/\s+/g, ' ').trim();
  if (!text) throw new Error('Memory content must not be empty');
  if (text.length > memoryLimits.text)
    throw new Error(`Memory content exceeds ${memoryLimits.text} characters`);
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(text))
    throw new Error('Memory content contains control characters');
  return text;
}
function today(now: Date): string {
  return now.toISOString().slice(0, 10);
}
async function writeMemoryFile(file: string, memory: MemoryFile): Promise<void> {
  const text = renderMemory(memory);
  if (Buffer.byteLength(text, 'utf8') > memoryLimits.bytes)
    throw new Error(`Memory file would exceed ${memoryLimits.bytes} bytes; forget entries first`);
  mkdirSync(path.dirname(file), { recursive: true });
  await atomicWriteFile(file, Buffer.from(text, 'utf8'));
}
/**
 * Create or replace one entry. There is no version check: the file is meant to be edited
 * by hand, so the last write wins per key. Replacing keeps the entry's position.
 */
export async function saveMemoryEntry(
  file: string,
  key: unknown,
  text: unknown,
  now = new Date(),
): Promise<MemoryEntry> {
  const name = normalizeKey(key);
  const content = normalizeText(text);
  const memory = readMemoryFile(file);
  const index = memory.entries.findIndex((entry) => entry.key === name);
  if (index === -1 && memory.entries.length >= memoryLimits.entries)
    throw new Error(`Memory limit reached (${memoryLimits.entries}); forget an entry first`);
  const entry: MemoryEntry = { key: name, text: content, updatedAt: today(now) };
  if (index === -1) memory.entries.push(entry);
  else memory.entries[index] = entry;
  await writeMemoryFile(file, memory);
  return entry;
}
export async function forgetMemoryEntry(file: string, key: unknown): Promise<void> {
  const name = normalizeKey(key);
  const memory = readMemoryFile(file);
  const entries = memory.entries.filter((entry) => entry.key !== name);
  if (entries.length === memory.entries.length) throw new Error(`No memory named ${name}`);
  await writeMemoryFile(file, { ...memory, entries });
}
export function listMemoryEntries(
  root: string,
  globalDir?: string,
): { workspace: MemoryEntry[]; global: MemoryEntry[] } {
  const paths = memoryPaths(root, globalDir);
  return {
    workspace: readMemoryFile(paths.workspace).entries,
    global: readMemoryFile(paths.global).entries,
  };
}
/**
 * Bounded reminder for the conversation. Workspace entries come first because they are
 * the ones most likely to change the current task; the budget stops at injectedEntries.
 */
export function memorySummary(root: string, globalDir?: string): string {
  const listed = listMemoryEntries(root, globalDir);
  const selected: MemoryScopeEntry[] = [
    ...listed.workspace.map((entry) => ({ ...entry, scope: 'workspace' as const })),
    ...listed.global.map((entry) => ({ ...entry, scope: 'global' as const })),
  ];
  if (!selected.length) return '';
  const kept: MemoryScopeEntry[] = [];
  let chars = 0;
  for (const entry of selected) {
    if (kept.length >= memoryLimits.injectedEntries) break;
    const size = entry.key.length + entry.text.length;
    if (kept.length && chars + size > memoryLimits.injectedChars) break;
    kept.push(entry);
    chars += size;
  }
  const omitted = selected.length - kept.length;
  return (
    '\nSaved memories from markdown files the user can also edit; they may be outdated, so the latest user request wins. Use recall_knowledge for indexed documents and save_memory or forget_memory to maintain these entries: ' +
    JSON.stringify(
      kept.map((entry) => ({
        scope: entry.scope,
        key: entry.key,
        text: entry.text.slice(0, memoryLimits.text),
        updatedAt: entry.updatedAt,
      })),
    ) +
    (omitted > 0 ? ` (${omitted} further entries omitted from this reminder)` : '')
  );
}
/** Case-insensitive substring match over both memory files, for recall_knowledge. */
export function searchMemories(
  root: string,
  query: string,
  globalDir?: string,
): MemoryScopeEntry[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  const listed = listMemoryEntries(root, globalDir);
  return [
    ...listed.workspace.map((entry) => ({ ...entry, scope: 'workspace' as const })),
    ...listed.global.map((entry) => ({ ...entry, scope: 'global' as const })),
  ].filter(
    (entry) =>
      entry.key.toLowerCase().includes(needle) || entry.text.toLowerCase().includes(needle),
  );
}
