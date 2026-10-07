import type { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import type { Plan, PlanStep } from '../protocol/index.ts';
import {
  normalizePlanBody,
  planHash,
  type PlanBody,
  type PlanRepository,
} from '../protocol/plans.ts';
const PLAN_SELECT = `SELECT id,session_id AS sessionId,run_id AS runId,status,title,summary,steps,hash,reason,created_at AS createdAt,updated_at AS updatedAt,approved_at AS approvedAt FROM plans`;
function planFromRow(row: Record<string, unknown>): Plan {
  let steps: PlanStep[] = [];
  try {
    const parsed = JSON.parse(String(row.steps ?? '[]'));
    if (Array.isArray(parsed))
      steps = parsed
        .filter((step) => step && typeof step === 'object' && typeof step.description === 'string')
        .map((step) => ({ description: String(step.description) }));
  } catch {
    /* A plan whose steps no longer parse reads as an empty plan rather than throwing. */
  }
  return {
    id: String(row.id),
    sessionId: String(row.sessionId),
    ...(row.runId ? { runId: String(row.runId) } : {}),
    status: row.status as Plan['status'],
    title: String(row.title ?? ''),
    summary: String(row.summary ?? ''),
    steps,
    hash: String(row.hash ?? ''),
    ...(row.reason ? { reason: String(row.reason) } : {}),
    createdAt: String(row.createdAt),
    updatedAt: String(row.updatedAt),
    ...(row.approvedAt ? { approvedAt: String(row.approvedAt) } : {}),
  };
}

/** Borrows the owner's connection. It never opens/closes a database or runs schema migrations. */
export class SqlitePlanStore implements PlanRepository {
  private readonly db: DatabaseSync;
  private readonly assertSession: (sessionId: string) => void;
  constructor(db: DatabaseSync, assertSession: (sessionId: string) => void) {
    this.db = db;
    this.assertSession = assertSession;
  }

  /**
   * Plans live in their own table rather than on the task row.
   *
   * `replaceTaskDefinition` clears a task's verification, step checkpoints and approvals and forces
   * its status back to `pending`, so an approval stored on the task would be destroyed by any later
   * re-propose. The plan row is independent of the task lifecycle by construction.
   */
  createPlan(sessionId: string, runId?: string): Plan {
    this.assertSession(sessionId);
    const now = new Date().toISOString();
    const plan: Plan = {
      id: randomUUID(),
      sessionId,
      ...(runId ? { runId } : {}),
      status: 'planning',
      title: '',
      summary: '',
      steps: [],
      hash: '',
      createdAt: now,
      updatedAt: now,
    };
    this.db
      .prepare(
        'INSERT INTO plans(id,session_id,run_id,status,title,summary,steps,hash,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)',
      )
      .run(
        plan.id,
        plan.sessionId,
        runId ?? null,
        plan.status,
        plan.title,
        plan.summary,
        '[]',
        plan.hash,
        plan.createdAt,
        plan.updatedAt,
      );
    return plan;
  }
  /** Records which run is filling in a plan, so a stale `planning` row is diagnosable. */
  linkPlanRun(sessionId: string, planId: string, runId: string): void {
    this.db
      .prepare('UPDATE plans SET run_id=?, updated_at=? WHERE session_id=? AND id=?')
      .run(runId, new Date().toISOString(), sessionId, planId);
  }
  getPlan(sessionId: string, planId: string): Plan {
    const row = this.db
      .prepare(`${PLAN_SELECT} WHERE session_id=? AND id=?`)
      .get(sessionId, planId);
    if (!row) throw new Error('Plan not found');
    return planFromRow(row);
  }
  /** The most recent plan for a session, which is the one the UI shows. */
  latestPlan(sessionId: string): Plan | null {
    const row = this.db
      .prepare(`${PLAN_SELECT} WHERE session_id=? ORDER BY created_at DESC, rowid DESC LIMIT 1`)
      .get(sessionId);
    return row ? planFromRow(row) : null;
  }
  /**
   * The plan mode a session is in, as durable state rather than as a request parameter.
   *
   * Plan mode is a promise that a run cannot change anything, and it outlives the request that started it: the
   * planning run can be stopped, killed, or left behind by a restart. The row is the state — a plan still
   * `planning` means nobody has decided anything yet, so the next run of that session is *continuing* the plan —
   * while a row that was submitted, approved, rejected or abandoned has had its decision recorded and is no
   * longer plan mode.
   *
   * A function rather than a method on one call site because the rule is the same everywhere it is asked: the
   * CLI's `resume` and the Host's `run.start` both need it, and a rule written twice is a rule that can come
   * apart (it did: the CLI continued planning and the Host ran with the full tool set).
   */
  planMode(sessionId: string): { planId: string } | null {
    const latest = this.latestPlan(sessionId);
    return latest?.status === 'planning' ? { planId: latest.id } : null;
  }
  /** Records the agent's plan body and moves the row to `proposed`. */
  submitPlan(sessionId: string, planId: string, body: PlanBody): Plan {
    const current = this.getPlan(sessionId, planId);
    if (current.status !== 'planning') throw new Error(`Plan is already ${current.status}`);
    const normalized = normalizePlanBody(body);
    this.db
      .prepare(
        "UPDATE plans SET status='proposed', title=?, summary=?, steps=?, hash=?, updated_at=? WHERE session_id=? AND id=?",
      )
      .run(
        normalized.title,
        normalized.summary,
        JSON.stringify(normalized.steps),
        planHash(normalized),
        new Date().toISOString(),
        sessionId,
        planId,
      );
    return this.getPlan(sessionId, planId);
  }
  /**
   * Approves a plan. `hash` is the digest the human actually reviewed, so approving a plan that was
   * edited in the meantime is refused rather than silently blessing text nobody read.
   */
  approvePlan(sessionId: string, planId: string, hash: string): Plan {
    const current = this.getPlan(sessionId, planId);
    if (current.status !== 'proposed')
      throw new Error(`Only a proposed plan can be approved (this one is ${current.status})`);
    if (!hash || hash !== current.hash)
      throw new Error('Plan changed since it was reviewed; re-read it before approving');
    const now = new Date().toISOString();
    this.db
      .prepare(
        "UPDATE plans SET status='approved', approved_at=?, reason=NULL, updated_at=? WHERE session_id=? AND id=?",
      )
      .run(now, now, sessionId, planId);
    return this.getPlan(sessionId, planId);
  }
  rejectPlan(sessionId: string, planId: string, reason?: string): Plan {
    const current = this.getPlan(sessionId, planId);
    if (current.status === 'approved' || current.status === 'rejected')
      throw new Error(`Plan is already ${current.status}`);
    this.db
      .prepare(
        "UPDATE plans SET status='rejected', reason=?, updated_at=? WHERE session_id=? AND id=?",
      )
      .run(reason?.slice(0, 500) ?? null, new Date().toISOString(), sessionId, planId);
    return this.getPlan(sessionId, planId);
  }
  /**
   * Resolves the plan that an execution run is allowed to follow. Both checks matter: the status
   * proves a human approved it, and the hash proves the approved text is still the text on the row —
   * otherwise an edit between approval and execution would run unreviewed work.
   */
  executablePlan(sessionId: string, planId: string): Plan {
    const plan = this.getPlan(sessionId, planId);
    if (plan.status !== 'approved')
      throw new Error(
        plan.status === 'proposed'
          ? 'The plan has not been approved yet'
          : `The plan is ${plan.status} and cannot be executed`,
      );
    const recomputed = planHash({ title: plan.title, summary: plan.summary, steps: plan.steps });
    if (recomputed !== plan.hash)
      throw new Error('Plan body changed after approval; review and approve it again');
    return plan;
  }
}
