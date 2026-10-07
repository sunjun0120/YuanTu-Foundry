/**
 * What a parent still owes its attention: work it started that finished without anybody reading the result.
 *
 * Delegation with `wait: false` is the one place where work escapes the turn that started it, and the parent
 * model's context is the only place its outcome can be delivered. Without a notice, the parent has to *poll*
 * — and a parent that has already answered the user has nothing to poll from: the coordinator that knew about
 * the child lived inside the run that just ended, so `collect_subagents` on the next turn answers "no
 * outstanding sub-agents" while the child's finished work sits in its own session, unread.
 *
 * This module reads the parent's own log, which is the only place that survives the run: `subagent.assigned`
 * names the child, `subagent.finished` and `subagent.interrupted` say how it ended, and `subagent.collected`
 * says the parent has already been told. The difference is the notice.
 *
 * A background command is the same gap with a different shape (`commandNotices`, below): the process outlives
 * the call that started it, so the exit code and the output have nowhere to be announced. Both are folded from
 * the log rather than from anything in memory, both repeat until the model reads the result, and both are
 * bounded per call so a session with a hundred delegations and a hundred commands cannot turn every request
 * into a wall of text.
 */
import type { CommandRecord } from '../protocol/jobs.ts';
import type { SubAgentRole, SubAgentSummary } from '../protocol/index.ts';
import type { SessionStore } from '../storage/sqlite.ts';
import { unsettledCommands } from './command-jobs.ts';
/** A settled child the parent has not been told about, in the shape the notice and `collect` both use. */
export interface SettlementNotice {
  /** The delegation's task id: what `collect_subagents` takes. */
  id: string;
  /** The child's own session: what `job_output` and `send_message` take. */
  childSessionId: string;
  role: SubAgentRole;
  objective: string;
  status: SubAgentSummary['status'] | 'interrupted';
  /** Why it ended that way, when the settlement recorded a reason (a cancellation, a failure, a timeout). */
  reason?: string;
  /** The structured report, when the child submitted one. The full text always lives in the child session. */
  report?: SubAgentSummary['report'];
}
/**
 * Children whose settlement the parent has not read, oldest first.
 *
 * A child is listed once it has settled and until a `subagent.collected` record names it. A child that is
 * still working is deliberately absent: it is not a result the parent is missing, and announcing it would make
 * every request carry the list of things that have not happened yet.
 */
export function settlementNotices(
  store: SessionStore,
  sessionId: string,
  limit = 8,
): SettlementNotice[] {
  const assigned = new Map<
    string,
    { childSessionId: string; role: SubAgentRole; objective: string }
  >();
  const settled = new Map<string, SettlementNotice>();
  for (const event of store.events(sessionId)) {
    if (event.type === 'subagent.assigned') {
      const id = String(event.data.id ?? '');
      const childSessionId = String(event.data.childSessionId ?? '');
      if (!id || !childSessionId || assigned.has(id)) continue;
      assigned.set(id, {
        childSessionId,
        role: (event.data.role as SubAgentRole | undefined) ?? 'explore',
        objective: String(event.data.objective ?? ''),
      });
      continue;
    }
    if (event.type === 'subagent.finished') {
      const id = String(event.data.id ?? '');
      if (!id) continue;
      const known = assigned.get(id);
      const childSessionId = String(event.data.sessionId ?? known?.childSessionId ?? '');
      if (!childSessionId) continue;
      settled.set(id, {
        id,
        childSessionId,
        role: (event.data.role as SubAgentRole | undefined) ?? known?.role ?? 'explore',
        objective: String(event.data.objective ?? known?.objective ?? ''),
        status: (event.data.status as SubAgentSummary['status']) ?? 'failed',
        ...(event.data.error ? { reason: String(event.data.error) } : {}),
        ...(event.data.report ? { report: event.data.report as SubAgentSummary['report'] } : {}),
      });
      continue;
    }
    if (event.type === 'subagent.interrupted') {
      // Crash recovery knows the child session but not the task id, so the assignment is what names it.
      const childSessionId = String(event.data.childSessionId ?? '');
      const entry = [...assigned.entries()].find(
        ([id, child]) => child.childSessionId === childSessionId && !settled.has(id),
      );
      if (!entry) continue;
      const [id, child] = entry;
      settled.set(id, {
        id,
        childSessionId,
        role: child.role,
        objective: child.objective,
        status: 'interrupted',
        ...(event.data.reason ? { reason: String(event.data.reason) } : {}),
      });
      continue;
    }
    if (event.type === 'subagent.collected') {
      const ids = Array.isArray(event.data.ids) ? event.data.ids : [];
      for (const id of ids)
        for (const [taskId, notice] of settled) {
          if (String(id) === taskId || String(id) === notice.childSessionId) settled.delete(taskId);
        }
    }
  }
  const pending: SettlementNotice[] = [];
  for (const notice of settled.values()) {
    pending.push(notice);
    if (pending.length >= limit) break;
  }
  return pending;
}
/**
 * The notice as the parent model reads it.
 *
 * Prose rather than JSON because it is an instruction: it has to say what happened, that the child is still
 * reachable, and which of the two id spaces each follow-up tool wants — a parent that has to guess between a
 * task id and a child session id will guess wrong.
 *
 * It deliberately carries **no report text**, not even the summary. This block goes into the system prompt,
 * and a child's prose is not the parent's instruction: an `explore` child reads files it did not write, so its
 * report is exactly the kind of text that must reach the parent as *data*, which is the position a tool result
 * has and a system prompt does not. The notice says what happened and points at the tool; `collect_subagents`
 * hands over the report itself.
 */
export function settlementNoticeText(notices: readonly SettlementNotice[]): string {
  if (!notices.length) return '';
  const lines = notices.map((notice) => {
    const reason = notice.reason ? ` — ${notice.reason}` : '';
    const detail = notice.report ? ' (a structured report is waiting)' : '';
    return `- ${notice.objective || notice.id}: ${notice.status}${reason}${detail}\n  collect_subagents id: ${notice.id}; job_output/send_message childSessionId: ${notice.childSessionId}`;
  });
  return (
    '\n\nSub-agents you delegated to that have settled and whose outcome you have not collected:\n' +
    lines.join('\n') +
    '\nRead a report with `collect_subagents` (by its id) or `job_output` (by its childSessionId); a child that was cancelled or interrupted can be asked to continue with `send_message`, which resumes the same child with its earlier work in its own transcript. Until you collect one it stays on this list.'
  );
}
/**
 * The background commands a session started whose outcome the model has not read.
 *
 * The other half of the same gap, in the same shape: a command is started inside a turn and finishes outside it,
 * so the tool result that would have carried the exit code belongs to a call nobody is making any more. This is
 * what makes "the build failed ten minutes ago" something the next turn can know.
 */
export function commandNotices(store: SessionStore, sessionId: string, limit = 8): CommandRecord[] {
  return unsettledCommands(store, sessionId, limit);
}
/**
 * The command notice as the model reads it.
 *
 * Like the sub-agent notice and for the same reason, this carries **no output text**: a command's output is
 * whatever the program printed, which is exactly the kind of text that must reach the model as *data* — the
 * position a tool result has — rather than as a line of its instructions. The notice says which command finished
 * and how, and `job_output` hands over the output itself.
 *
 * It also says what is left of that output after a restart, because that changes what the model should expect:
 * the tail recorded at settlement is answerable from the log forever, while the full ring lived in the process
 * that ran the command. A model that knows which of the two it is reading does not conclude the command was
 * quiet when it was merely gone.
 */
export function commandNoticeText(notices: readonly CommandRecord[]): string {
  if (!notices.length) return '';
  const lines = notices.map((notice) => {
    const exit =
      notice.exitCode === undefined || notice.exitCode === null ? '' : ` (exit ${notice.exitCode})`;
    return `- ${notice.command || notice.id}: ${notice.status}${exit}\n  job_output id: ${notice.id}`;
  });
  return (
    '\n\nBackground commands you started that have finished and whose output you have not read:\n' +
    lines.join('\n') +
    '\nRead one with `job_output` (by its id). Its recorded tail is in this session’s log, so that read still answers after the process that ran the command is gone; the rest of its output lived in that process.'
  );
}
