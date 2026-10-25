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
export function resolvedTarget(input, options = {}) {
  const value =
    input instanceof URL ? fileURLToPath(input) : Buffer.isBuffer(input) ? input.toString() : input;
  if (typeof value !== 'string') return undefined;
  // Named pipes have no filesystem ancestors to lstat. The ownership probe still
  // rejects them unless its exact native-resource rule allows the pipe first.
  if (process.platform === 'win32' && /^\\\\[?.]\\pipe\\/i.test(value))
    return path.normalize(value);
  /**
   * Removing or replacing the last path component does not follow a symlink there: deleting a dangling link is
   * safe, while deleting through it would not be. Resolve the parent and append the name, so an ancestor link is
   * still followed and an outside ancestor is still refused.
   */
  if (options.followFinal === false) {
    const absolute = path.resolve(value);
    const parent = path.dirname(absolute);
    if (parent === absolute) return absolute;
    return path.join(resolvedTarget(parent), path.basename(absolute));
  }
  for (let attempt = 0; attempt < 3; attempt++) {
    let current = path.resolve(value);
    const suffix = [];
    for (;;) {
      try {
        lstat(current);
      } catch (error) {
        if (!['ENOENT', 'ENOTDIR'].includes(error.code)) throw error;
        const parent = path.dirname(current);
        if (parent === current) return path.join(current, ...suffix);
        suffix.unshift(path.basename(current));
        current = parent;
        continue;
      }
      let resolved;
      try {
        resolved = realpath(current);
      } catch (error) {
        if (!['ENOENT', 'ENOTDIR'].includes(error.code)) throw error;
        // The name exists lexically but its target does not: a dangling link, or a concurrent delete. Walking
        // up and appending the name would hand back a path inside the root even though the write lands at the
        // link target, so there is no lexical fallback here — retry, and deny if it still cannot be resolved.
        break;
      }
      // NTFS can move a concurrently deleted lock into its tombstone directory between lstat and realpath.
      // Resolve the original name again: neither that transient name nor a lexical fallback proves ownership.
      if (
        process.platform === 'win32' &&
        /^(?:\\\\\?\\)?[a-z]:\\\$Extend\\\$Deleted(?:\\|$)/i.test(resolved)
      )
        break;
      return path.join(resolved, ...suffix);
    }
    if (attempt < 2) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
  }
  throw Object.assign(
    new Error(`Cannot resolve ownership of a concurrently deleted path: ${value}`),
    { code: 'EAGAIN' },
  );
}
