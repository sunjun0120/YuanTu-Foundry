/**
 * The read-before-write gate.
 *
 * A change tool computes its new content *from the file as it is on disk*, but the model's reason for wanting the
 * change describes the file as it was when the model last saw it — or as the model imagines it. Those are two
 * different files, and every failure in this area comes from the gap between them: an edit whose `old_text` no
 * longer matches (so the model is told "must match exactly once", concludes it guessed the text wrong, and guesses
 * again), or worse, one that does match because the file has two similar regions, or the snippet also exists in a
 * file the model never opened. A delete or a rename has the same shape with no content check at all.
 *
 * So: a change that is computed from a file's content requires that this run has **read** that file, and that what
 * it read is still what is there. The gate runs where a change is prepared — before the approval prompt — because
 * the point is that a person is never asked to approve a change based on a picture the model never verified.
 *
 * Four decisions are deliberate:
 *
 * - **Only content-changing tools.** `edit_file`, `apply_patch` and `batch_edit` replace text that came from the
 *   file, so the model's memory of that text *is* the claim being checked. `delete_file` and `move_file` name a
 *   path and nothing else: a read would not make deleting the wrong file safer, and the approval prompt already
 *   shows exactly what will be removed or renamed. `write_file` only ever creates a file that does not exist, so
 *   there is nothing to have read.
 * - **A partial read counts.** A slice, a page, the spilled output of an earlier tool — all of them are the model
 *   having looked. Refusing to edit a file the model has partly read would push it toward guessing more, not less.
 *   A `search_files` hit does not count: three matching lines are a pointer to the file, not the file.
 * - **Staleness is a stat, not a promise.** The record keeps size and mtime from the read; if either moved, the
 *   model is told to read again rather than being allowed to edit content that changed under it. That is a
 *   heuristic — a same-size write inside one filesystem timestamp tick is invisible to it — and it is deliberately
 *   not the hard guarantee: exact-match and the post-approval byte recheck remain the things that make a wrong
 *   change impossible. This one makes it *unlikely to be attempted*.
 * - **This run, and no further back.** The record belongs to the tool set built for one run, so a resumed session
 *   re-reads before it edits. The conservative direction is the cheap one here: one extra read costs a round,
 *   a blind edit costs the file.
 *
 * A change this run made itself counts as having seen the result — the model authored those bytes — and a change
 * that removed a file forgets it. A language-server edit does not count (see `noFileObservations`): those bytes
 * were computed by a server against live documents, not remembered by the model.
 */
import path from 'node:path';
import { lstat } from 'node:fs/promises';
import { parseSetting } from '../protocol/settings.ts';

/**
 * The token a client, a test or a human can branch on.
 *
 * The message also explains itself in prose — the model is the primary reader — but prose changes and a marker
 * does not, so the first word is fixed here rather than spelled out at the throw site.
 */
export const FS_NOT_OBSERVED = 'FS_NOT_OBSERVED';

/** What the file looked like when it was read, which is all it takes to notice it is not that file any more. */
interface Observation {
  size: number;
  mtimeMs: number;
}

/** The slice of `Workspace` this needs, so the policy does not have to import the tool module to be usable. */
export interface ObservableWorkspace {
  root: string;
  resolve(input: string, allowNew?: boolean, allowSpill?: boolean): Promise<string>;
}

/** What a prepared change asks before it rewrites a file the model can only know from memory. */
export interface FileObservationLog {
  /** Resolves and refuses a change to a file this run has not read, or has read and has since changed. */
  assertRead(input: string): Promise<void>;
  /** The change happened: remember what this run wrote itself, forget what it removed. */
  settle(changes: { written?: readonly string[]; removed?: readonly string[] }): Promise<void>;
}

/**
 * The two read-first gates every model-authored change passes, in order.
 *
 * Bundled because they answer the same question — "has the model looked at what it is about to change?" — about
 * the directory's instructions and about the file itself, and because a change that checked one and forgot the
 * other is exactly the kind of half-applied policy this project refuses to ship.
 *
 * A caller that wants neither simply does not pass `gates`, which is what the language-server workspace edit does:
 * those bytes are computed by a server against the documents it is serving, so they are not the model's memory of
 * the file and there is nothing here to check.
 */
export interface MutationGates {
  /** Project instructions that apply to this path, or `''` when they have already been read. */
  instructions(input: string): Promise<string>;
  observations: FileObservationLog;
}

/** `YUANTU_FS_OBSERVATION=0` turns the gate off; anything else (including unset) leaves it on. */
export function fileObservationEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return parseSetting(env, 'YUANTU_FS_OBSERVATION') !== false;
}

/**
 * What this run has read, keyed by canonical path.
 *
 * Recording is best-effort on purpose: a read that already succeeded has already handed its content to the model,
 * so failing to remember it must not turn a good read into an error. The worst case is one extra read later —
 * the same direction every other failure in this module errs toward.
 */
export class FileObservations implements FileObservationLog {
  private seen = new Map<string, Observation>();
  private workspace: ObservableWorkspace;
  private enabled: boolean;
  constructor(workspace: ObservableWorkspace, enabled = true) {
    this.workspace = workspace;
    this.enabled = enabled;
  }
  /** Records a read the model asked for and got. */
  async record(input: string): Promise<void> {
    if (!this.enabled) return;
    try {
      this.remember(await this.workspace.resolve(input, false, true));
    } catch {
      // A path that cannot be resolved or stat'ed now was not observed; the read itself already succeeded and
      // reported what it saw, and this gate is about later changes, not about that one.
    }
  }
  async assertRead(input: string): Promise<void> {
    if (!this.enabled) return;
    // `allowNew` because a file that is gone is a legitimate outcome here: there is no content to have observed,
    // and the change tool has its own, better error ("no such file") than anything this gate could say.
    const file = await this.workspace.resolve(input, true);
    const relative = path.relative(this.workspace.root, file).split(path.sep).join('/');
    let current: Observation;
    try {
      current = await statFile(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    const observed = this.seen.get(file);
    if (!observed)
      throw new Error(
        `${FS_NOT_OBSERVED}: ${relative} has not been read in this run. Read it first, then make the change.`,
      );
    if (observed.size !== current.size || observed.mtimeMs !== current.mtimeMs)
      throw new Error(
        `${FS_NOT_OBSERVED}: ${relative} changed on disk since it was read (${observed.size} bytes then, ${current.size} now). Read it again, then make the change.`,
      );
  }
  async settle(changes: {
    written?: readonly string[];
    removed?: readonly string[];
  }): Promise<void> {
    if (!this.enabled) return;
    try {
      for (const input of changes.written ?? [])
        this.remember(await this.workspace.resolve(input, true));
      for (const input of changes.removed ?? []) {
        // `allowNew` because the point is to name a path that is now gone; a resolve that still fails cannot be
        // about a file this run just changed, so leaving the record alone is the honest outcome.
        try {
          this.seen.delete(await this.workspace.resolve(input, true));
        } catch {
          /* nothing to forget */
        }
      }
    } catch {
      // The change already happened. Failing to remember it must not turn it into a failure; the cost is one
      // more read before the next change to the same file.
    }
  }
  private async remember(file: string): Promise<void> {
    this.seen.set(file, await statFile(file));
  }
}

async function statFile(file: string): Promise<Observation> {
  const stat = await lstat(file);
  if (!stat.isFile()) throw new Error('Expected a regular file');
  return { size: stat.size, mtimeMs: stat.mtimeMs };
}
