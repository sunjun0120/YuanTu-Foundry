/**
 * What a parent still owes its attention: background work that finished without anyone reading the
 * result. Folded from the parent's log (`subagent.assigned`, `subagent.finished`/`interrupted`,
 * `subagent.collected`), since the coordinator dies with its run. Background commands
 * (`commandNotices`) are the same gap. Both notices repeat until read and are bounded per call.
 */
import type { CommandRecord } from '../../protocol/jobs.ts';
import type { SubAgentRole, SubAgentSummary } from '../../protocol/index.ts';
import type { SessionStore } from '../../storage/sqlite.ts';
import { unsettledCommands } from '../command-jobs.ts';
import { logProjection } from '../log-projection.ts';
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
/** Settled children the parent has not read, oldest first. Children still working are absent. */
export function settlementNotices(
  store: SessionStore,
  sessionId: string,
  limit = 8,
): SettlementNotice[] {
  return settlementBacklog(store, sessionId, limit).notices;
}
/**
 * The uncollected settlements up to `limit`, plus the total so the notice can say more are waiting.
 */
export function settlementBacklog(
  store: SessionStore,
  sessionId: string,
  limit = 8,
): { notices: SettlementNotice[]; total: number } {
  const { settled } = settlementLog.read(store, sessionId);
  const notices: SettlementNotice[] = [];
  for (const notice of settled.values()) {
    if (notices.length >= limit) break;
    // Copied: the fold is kept and continued across calls, and a caller must not be able to edit it.
    notices.push({ ...notice });
  }
  return { notices, total: settled.size };
}
/**
 * The settlement fold, cached per store and continued from the last seq read (see `logProjection`).
 */
const settlementLog = logProjection<{
  assigned: Map<string, { childSessionId: string; role: SubAgentRole; objective: string }>;
  settled: Map<string, SettlementNotice>;
}>(
  () => ({ assigned: new Map(), settled: new Map() }),
  ({ assigned, settled }, event) => {
    if (event.type === 'subagent.assigned') {
      const id = String(event.data.id ?? '');
      const childSessionId = String(event.data.childSessionId ?? '');
      if (!id || !childSessionId || assigned.has(id)) return;
      assigned.set(id, {
        childSessionId,
        role: (event.data.role as SubAgentRole | undefined) ?? 'explore',
        objective: String(event.data.objective ?? ''),
      });
      return;
    }
    if (event.type === 'subagent.finished') {
      const id = String(event.data.id ?? '');
      if (!id) return;
      const known = assigned.get(id);
      const childSessionId = String(event.data.sessionId ?? known?.childSessionId ?? '');
      if (!childSessionId) return;
      settled.set(id, {
        id,
        childSessionId,
        role: (event.data.role as SubAgentRole | undefined) ?? known?.role ?? 'explore',
        objective: String(event.data.objective ?? known?.objective ?? ''),
        status: (event.data.status as SubAgentSummary['status']) ?? 'failed',
        ...(event.data.error ? { reason: String(event.data.error) } : {}),
        ...(event.data.report ? { report: event.data.report as SubAgentSummary['report'] } : {}),
      });
      return;
    }
    if (event.type === 'subagent.interrupted') {
      // Crash recovery knows the child session but not the task id, so the assignment is what names it.
      const childSessionId = String(event.data.childSessionId ?? '');
      const entry = [...assigned.entries()].find(
        ([id, child]) => child.childSessionId === childSessionId && !settled.has(id),
      );
      if (!entry) return;
      const [id, child] = entry;
      settled.set(id, {
        id,
        childSessionId,
        role: child.role,
        objective: child.objective,
        status: 'interrupted',
        ...(event.data.reason ? { reason: String(event.data.reason) } : {}),
      });
      return;
    }
    if (event.type === 'subagent.collected') {
      const ids = Array.isArray(event.data.ids) ? event.data.ids : [];
      for (const id of ids)
        for (const [taskId, notice] of settled) {
          if (String(id) === taskId || String(id) === notice.childSessionId) settled.delete(taskId);
        }
    }
  },
);
/**
 * The notice as the parent model reads it: what happened, that the child is reachable, and which id
 * each follow-up tool takes. It carries no report text: this goes into the system prompt, and child
 * output must reach the parent as data via `collect_subagents`.
 */
export function settlementNoticeText(
  notices: readonly SettlementNotice[],
  total = notices.length,
): string {
  if (!notices.length) return '';
  const lines = notices.map((notice) => {
    const reason = notice.reason ? ` — ${notice.reason}` : '';
    const detail = notice.report ? ' (a structured report is waiting)' : '';
    return `- ${notice.objective || notice.id}: ${notice.status}${reason}${detail}\n  collect_subagents id: ${notice.id}; job_output/send_message childSessionId: ${notice.childSessionId}`;
  });
  const more = total - notices.length;
  if (more > 0)
    lines.push(
      `- …and ${more} more settled sub-agent(s) not listed here; \`collect_subagents\` with no ids returns them all.`,
    );
  return (
    '\n\nSub-agents you delegated to that have settled and whose outcome you have not collected:\n' +
    lines.join('\n') +
    '\nRead a report with `collect_subagents` (by its id) or `job_output` (by its childSessionId); a child that was cancelled or interrupted can be asked to continue with `send_message`, which resumes the same child with its earlier work in its own transcript. Until you collect one it stays on this list.'
  );
}
/** Background commands whose outcome the model has not read. */
export function commandNotices(store: SessionStore, sessionId: string, limit = 8): CommandRecord[] {
  return unsettledCommands(store, sessionId, limit);
}
/**
 * The command notice. No output text, for the same reason; `job_output` returns it. Says whether
 * only the recorded tail survives a restart.
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
