import fs from 'node:fs';
const open = fs.openSync;
const write = fs.writeSync;
const close = fs.closeSync;

/** Only the probe uses these original primitives for its parent-owned control records. */
export function record(file, value) {
  const descriptor = open(file, 'a', 0o600);
  try {
    write(descriptor, JSON.stringify(value) + '\n');
  } finally {
    close(descriptor);
  }
}
