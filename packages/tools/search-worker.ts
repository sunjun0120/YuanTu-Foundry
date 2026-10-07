import { parentPort, workerData } from 'node:worker_threads';
import { open } from 'node:fs/promises';

interface SearchInput {
  files: { path: string; label: string }[];
  query: string;
  sensitive: boolean;
  limit: number;
}

/**
 * One match, as data.
 *
 * The worker used to format each hit into `label:line: text` and the tool printed that string. The tool now
 * builds the text form itself, from these fields, for two reasons: a result has to carry the match as a value
 * for a client to list, and re-parsing `path:line: text` back out of a string would break on the first path
 * that contains a colon — which on Windows is every absolute path there is.
 */
interface Match {
  path: string;
  line: number;
  text: string;
}

const input = workerData as SearchInput;
const expression = new RegExp(input.query, input.sensitive ? '' : 'i');
const matches: Match[] = [];
let limited = false;

for (const file of input.files) {
  let text: string;
  try {
    const handle = await open(file.path, 'r');
    try {
      const buffer = Buffer.alloc(256_001);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      text = buffer.subarray(0, Math.min(bytesRead, 256_000)).toString('utf8');
    } finally {
      await handle.close();
    }
  } catch {
    continue;
  }
  if (text.includes('\0')) continue;
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    if (!expression.test(line)) continue;
    // 500 characters, kept in step with `MAX_MATCH_TEXT` in `./files.ts`: this file is loaded in a worker
    // thread, and importing the tool module to share one number would load the registry, Ajv and every sibling
    // tool into a thread whose whole job is to read files and match lines.
    matches.push({ path: file.label, line: index + 1, text: line.slice(0, 500) });
    if (matches.length >= input.limit) {
      limited = true;
      break;
    }
  }
  if (limited) break;
}

parentPort!.postMessage({ matches, limited });
