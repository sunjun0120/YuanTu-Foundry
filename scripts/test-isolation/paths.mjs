import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Capture before probes replace public methods.
const realpath = fs.realpathSync.native;
const lstat = fs.lstatSync;
export const inside = (root, target) => {
  const relative = path.relative(root, target);
  return (
    relative === '' ||
    (relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative))
  );
};
export function resolvedTarget(input) {
  const value =
    input instanceof URL ? fileURLToPath(input) : Buffer.isBuffer(input) ? input.toString() : input;
  if (typeof value !== 'string') return undefined;
  // Named pipes have no filesystem ancestors to lstat. The ownership probe still
  // rejects them unless its exact native-resource rule allows the pipe first.
  if (process.platform === 'win32' && /^\\\\[?.]\\pipe\\/i.test(value))
    return path.normalize(value);
  let current = path.resolve(value);
  const suffix = [];
  for (;;) {
    try {
      lstat(current);
      return path.join(realpath(current), ...suffix);
    } catch (error) {
      if (!['ENOENT', 'ENOTDIR'].includes(error.code)) throw error;
      const parent = path.dirname(current);
      if (parent === current) return path.join(current, ...suffix);
      suffix.unshift(path.basename(current));
      current = parent;
    }
  }
}
