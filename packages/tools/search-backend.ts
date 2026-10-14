/**
 * The assembly layer's contribution to search: a verified program, and a process to run it in.
 *
 * This is deliberately *not* part of `packages/search`. That package decides what to scan and how to report
 * coverage; deciding whether a program may run at all is an execution-policy question, and the answer lives
 * here — one directory away from the sandbox that implements it, so the search engine can be tested with a
 * temporary directory and no policy at all.
 *
 * Two refusals shape what this returns:
 *
 * - **No verified asset, no backend.** `resolveSearchBinary` answers `null` when this platform has no prepared
 *   binary whose hash matches the lock file, when the only candidate is a link, or when the candidate lives
 *   inside the workspace. A `null` here is not an error: the caller scans with the built-in engine.
 * - **No execution environment, no backend.** If the sandbox for the selected policy cannot be prepared, the
 *   search falls back to the built-in scanner rather than to a host process. Silent escalation from "the sandbox
 *   refused" to "run it on the host anyway" is the one fallback that must never exist.
 */
import { localExecutionEnvironment } from './execution-environment.ts';
import { executionPolicy } from './execution-policy.ts';
import { resolveSandboxConfig } from './sandbox.ts';
import { resolveSearchBinary, type ResolvedSearchBinary } from '../search/ripgrep-assets.ts';
import { runRipgrep, type ManagedSearchProcess } from '../search/ripgrep.ts';
import { emptyCoverage, type SearchBackend } from '../search/types.ts';

/**
 * The ripgrep backend for one workspace.
 *
 * The asset lookup is memoised because it is a file read plus a hash on a path that is checked once per search;
 * an asset cannot change identity inside one process without the lock file changing too, which is a different
 * build.
 */
export function createSearchBackend(root: string): SearchBackend {
  let resolved: ResolvedSearchBinary | null | undefined;
  const asset = async (): Promise<ResolvedSearchBinary | null> => {
    if (resolved === undefined) resolved = await resolveSearchBinary({ workspaceRoot: root });
    return resolved;
  };
  return {
    name: 'ripgrep',
    async available() {
      return (await asset()) !== null;
    },
    async search(input, context) {
      const binary = await asset();
      if (!binary) return input.fallback(input.files, emptyCoverage());
      const config = resolveSandboxConfig();
      let environment;
      try {
        environment = await localExecutionEnvironment(
          root,
          context.executionPolicy ?? executionPolicy(config.mode, config),
        );
      } catch {
        // The policy could not be honoured, so no program runs. The built-in scanner answers instead.
        return input.fallback(input.files, emptyCoverage());
      }
      const processes: ManagedSearchProcess = {
        async start(executable, argv, signal) {
          const started = await environment.processes.start(executable, argv, '.', signal);
          return {
            child: started.child,
            stop: () => started.stop(),
            // `start` already arranges the sandbox cleanup on close; closing twice is a no-op because the stop
            // promise is memoised there.
            close: async () => {
              await started.stop();
            },
          };
        },
      };
      return runRipgrep({
        executable: binary.executable,
        processes,
        files: input.files,
        options: input.options,
        inventory: input.inventory,
        fallback: input.fallback,
      });
    },
  };
}
