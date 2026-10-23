import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

// Controllers share this tiny lease implementation; it never removes another owner's lease.
// The bootstrap loads this before patching fs. Copied nested-runner fixtures use the same
// controller primitives, without granting workers general writes to the machine lock root.
const key = Symbol.for('foundry.test.resource-lease.primitives');
const primitives = (globalThis[key] ??= Object.fromEntries(
  ['mkdirSync', 'writeFileSync', 'readFileSync', 'unlinkSync', 'linkSync'].map((name) => [
    name,
    fs[name],
  ]),
));
const { mkdirSync, writeFileSync, readFileSync, unlinkSync, linkSync } = primitives;
/**
 * One lock file per machine resource, so runs that need different resources (a desktop window, the Windows sandbox
 * ACLs) proceed side by side. Every caller takes its resources in the same sorted order, which is what keeps two runs
 * holding overlapping sets from deadlocking; a run that cannot get them all gives back the ones it got.
 */
export async function acquireResourceLease(
  directory,
  resources,
  { signal, timeoutMs = 120000 } = {},
) {
  if (!resources.length) return () => {};
  mkdirSync(directory, { recursive: true });
  const token = randomUUID();
  const deadline = Date.now() + timeoutMs;
  const releases = [];
  try {
    for (const resource of [...new Set(resources)].sort())
      releases.push(await acquireOne(directory, resource, token, deadline, signal));
  } catch (error) {
    releaseAll(releases);
    throw error;
  }
  return () => releaseAll(releases);
}

/** Releases in reverse order and reports the first failure only after every lease had its chance to go. */
function releaseAll(releases) {
  let failure;
  for (const release of releases.splice(0).reverse()) {
    try {
      release();
    } catch (error) {
      failure ??= error;
    }
  }
  if (failure) throw failure;
}

async function acquireOne(directory, resource, token, deadline, signal) {
  const file = path.join(directory, `${resource}.lock`);
  const candidate = path.join(directory, `${process.pid}-${token}-${resource}.pending`);
  // Publish a fully written lease atomically: contenders can never observe an empty owner file.
  writeFileSync(candidate, JSON.stringify({ token, pid: process.pid, resource }), {
    flag: 'wx',
    mode: 0o600,
  });
  try {
    for (;;) {
      signal?.throwIfAborted();
      try {
        linkSync(candidate, file);
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        let owner;
        try {
          owner = JSON.parse(readFileSync(file, 'utf8'));
        } catch (error) {
          if (error.code === 'ENOENT') continue; // The owner released between link and read.
          throw Error(`Machine resource lease has unknown ownership: ${file}`);
        }
        if (!Number.isSafeInteger(owner.pid) || !owner.token)
          throw Error(`Machine resource lease has unknown ownership: ${file}`);
        let ownerGone = false;
        try {
          process.kill(owner.pid, 0);
        } catch (error) {
          // A pid the operating system says does not exist is *verifiably* dead — that is exactly what a failed
          // run leaves behind, and refusing to reclaim it wedged the machine until somebody deleted the file by
          // hand. Anything else (EPERM: alive but not ours to signal) stays unverifiable and still fails closed.
          if (error.code === 'ESRCH') ownerGone = true;
          else
            throw Error(
              `Machine resource lease owner is not verifiable; refusing to delete ${file}`,
            );
        }
        if (ownerGone) {
          // Reclaim only the lease that was just observed: a contender can replace the file between the read and
          // the unlink, and this must not delete the replacement's lease.
          let observed;
          try {
            observed = JSON.parse(readFileSync(file, 'utf8'));
          } catch (error) {
            if (error.code === 'ENOENT') continue;
            throw error;
          }
          if (observed.token === owner.token) {
            try {
              unlinkSync(file);
            } catch (error) {
              if (error.code !== 'ENOENT') throw error;
            }
          }
          continue;
        }
        if (Date.now() >= deadline)
          throw Error(`Timed out waiting for machine resource lease: ${file}`);
        await new Promise((resolve) => setTimeout(resolve, 100));
        continue;
      }
      return () => {
        const current = JSON.parse(readFileSync(file, 'utf8'));
        if (current.token !== token || current.pid !== process.pid)
          throw Error(`Machine resource lease changed ownership: ${file}`);
        unlinkSync(file);
      };
    }
  } finally {
    unlinkSync(candidate);
  }
}
