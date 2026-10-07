import { createHash } from 'node:crypto';
import type { Plan, PlanStep } from './index.ts';
export interface PlanBody {
  title: string;
  summary?: string;
  steps: (string | PlanStep)[];
}
const planText = (value: unknown, label: string, max: number): string => {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`Plan ${label} is required`);
  const text = value.trim();
  if (text.length > max) throw new Error(`Plan ${label} exceeds ${max} characters`);
  // Control characters would ride into prompts and the database; normalise them away.
  return text.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, ' ').trim();
};
/** Validates and normalises an agent-authored plan body before it is stored. */
export function normalizePlanBody(body: PlanBody): {
  title: string;
  summary: string;
  steps: PlanStep[];
} {
  if (!body || typeof body !== 'object') throw new Error('Invalid plan');
  const title = planText(body.title, 'title', 200);
  const summary = body.summary === undefined ? '' : planText(body.summary, 'summary', 4_000);
  if (!Array.isArray(body.steps) || !body.steps.length)
    throw new Error('Plan needs at least one step');
  if (body.steps.length > 40) throw new Error('Plan exceeds 40 steps');
  const steps = body.steps.map((step) => ({
    description: planText(
      typeof step === 'string' ? step : (step as PlanStep)?.description,
      'step',
      500,
    ),
  }));
  return { title, summary, steps };
}
/**
 * Digest of the plan body, used as the approval witness. Only the human-visible fields participate, so
 * a status change or a new `updatedAt` never invalidates an approval — only an edit to the plan does.
 */
export function planHash(body: { title: string; summary: string; steps: PlanStep[] }): string {
  return createHash('sha256')
    .update(JSON.stringify([body.title, body.summary, body.steps.map((step) => step.description)]))
    .digest('hex');
}

/** The two operations a planning run needs; it cannot query or mutate unrelated session state. */
export interface PlanApprovalStore {
  submitPlan(sessionId: string, planId: string, body: PlanBody): Plan;
  approvePlan(sessionId: string, planId: string, hash: string): Plan;
}
/** Persistent plan lifecycle, independent of the database connection and agent implementation. */
export interface PlanRepository extends PlanApprovalStore {
  createPlan(sessionId: string, runId?: string): Plan;
  linkPlanRun(sessionId: string, planId: string, runId: string): void;
  getPlan(sessionId: string, planId: string): Plan;
  latestPlan(sessionId: string): Plan | null;
  planMode(sessionId: string): { planId: string } | null;
  rejectPlan(sessionId: string, planId: string, reason?: string): Plan;
  executablePlan(sessionId: string, planId: string): Plan;
}
