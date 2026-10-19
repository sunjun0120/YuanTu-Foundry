/**
 * System notifications for the two moments a session wants the person back: a run ended, or a run is waiting on
 * an approval or a question.
 *
 * The main process sees every snapshot the window does, so it compares each one with the last: a session that was
 * running and no longer is has finished, and an approval or question id it had not seen before is new. Only the
 * comparison lives here (`RunWatch`), so it can be tested without Electron; `main.ts` decides whether to show the
 * result (only while the window is not in front) and what clicking it does.
 */
import type { CarrierSnapshot } from '../../packages/carrier/contract.ts';

/** The kernel's marker for a run the user stopped; see `agent.ts`. Stopping is not news to the person who did it. */
const RUN_CANCELLED = 'Run cancelled';

export type RunNotice =
  | { kind: 'done'; sessionId: string; title: string }
  | { kind: 'failed'; sessionId: string; title: string; error: string }
  | { kind: 'approval' | 'question'; sessionId: string; title: string; count: number };

interface SessionWatch {
  running: boolean;
  approvals: Set<string>;
  questions: Set<string>;
}

function watchOf(snapshot: CarrierSnapshot): Map<string, SessionWatch> {
  const sessions = new Map<string, SessionWatch>();
  const entry = (id: string) => {
    let value = sessions.get(id);
    if (!value) {
      value = { running: false, approvals: new Set(), questions: new Set() };
      sessions.set(id, value);
    }
    return value;
  };
  // Three witnesses, newest wins, as in the session list: the list's own `activeRun`, the runs followed in the
  // background, and the session on screen.
  for (const item of snapshot.sessions) if (item.activeRun) entry(item.id).running = true;
  for (const run of snapshot.session.otherRuns ?? []) {
    const value = entry(run.sessionId);
    value.running = true;
    for (const item of run.approvals) value.approvals.add(item.id);
    for (const item of run.questions) value.questions.add(item.id);
  }
  const current = snapshot.session;
  if (current.sessionId) {
    const value = entry(current.sessionId);
    value.running = current.running;
    value.approvals = new Set(current.approvals.map((item) => item.id));
    value.questions = new Set(current.questions.map((item) => item.id));
  }
  return sessions;
}

export class RunWatch {
  private sessions: Map<string, SessionWatch> | undefined;
  private workspace: string | undefined;

  /** Forget everything: a replaced Host or another workspace starts a new comparison, with nothing to report. */
  reset(): void {
    this.sessions = undefined;
    this.workspace = undefined;
  }

  /** What changed since the last snapshot that the person should be told about. The first snapshot reports nothing. */
  update(snapshot: CarrierSnapshot): RunNotice[] {
    // A loading session is between two states; the snapshot after it is the one to compare.
    if (!snapshot.ready || snapshot.session.loading) return [];
    const next = watchOf(snapshot);
    const previous = this.sessions;
    const sameWorkspace = this.workspace === snapshot.workspace;
    this.sessions = next;
    this.workspace = snapshot.workspace;
    if (!previous || !sameWorkspace) return [];
    const titles = new Map(snapshot.sessions.map((item) => [item.id, item.title]));
    const title = (id: string) => titles.get(id) || id.slice(0, 8);
    const notices: RunNotice[] = [];
    for (const [sessionId, before] of previous) {
      const after = next.get(sessionId);
      if (!before.running || after?.running) continue;
      // A session that left the list's window did not finish; it only stopped being visible.
      if (!titles.has(sessionId) && sessionId !== snapshot.session.sessionId) continue;
      const error = sessionId === snapshot.session.sessionId ? snapshot.session.error : null;
      if (error === RUN_CANCELLED) continue;
      notices.push(
        error
          ? { kind: 'failed', sessionId, title: title(sessionId), error }
          : { kind: 'done', sessionId, title: title(sessionId) },
      );
    }
    for (const [sessionId, after] of next) {
      const before = previous.get(sessionId);
      const fresh = (ids: Set<string>, seen: Set<string> | undefined) =>
        [...ids].filter((id) => !seen?.has(id)).length;
      // A question is the more specific ask, so it names the notice when both arrive together.
      if (fresh(after.questions, before?.questions))
        notices.push({
          kind: 'question',
          sessionId,
          title: title(sessionId),
          count: after.approvals.size + after.questions.size,
        });
      else if (fresh(after.approvals, before?.approvals))
        notices.push({
          kind: 'approval',
          sessionId,
          title: title(sessionId),
          count: after.approvals.size + after.questions.size,
        });
    }
    return notices;
  }
}
