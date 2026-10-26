import type {
  AcceptanceEvidence,
  Task,
  TaskEventName,
  TaskStepCheckpoint,
} from '../../packages/protocol/index.ts';
import { locale } from './i18n.ts';
import {
  clockReading,
  evidenceReading,
  stepJournalReading,
  taskEventReading,
  taskStatusReading,
  triggerSummaryReading,
} from './ui/panels/task-view.ts';

/** The task panel's small DOM pieces; the words themselves come from `ui/panels/task-view.ts`. */
export const tr = (zh: string, en: string) => (locale() === 'zh-CN' ? zh : en);
export function el<K extends keyof HTMLElementTagNameMap>(tag: K, text = '', cls = '') {
  const result = document.createElement(tag);
  result.textContent = text;
  result.className = cls;
  return result;
}
export function statusLabel(status: string): string {
  return taskStatusReading(status, locale());
}
export function clock(minutes: number): string {
  return clockReading(minutes);
}
export function eventLabel(on: TaskEventName): string {
  return taskEventReading(on, locale());
}
export function triggerSummary(task: Task): string {
  return triggerSummaryReading(task, locale());
}
export function evidence(parent: HTMLElement, value?: AcceptanceEvidence) {
  const reading = evidenceReading(value, locale());
  if (!reading) return;
  const details = el('details', '', 'task-evidence');
  details.append(el('summary', reading.summary));
  for (const check of reading.checks) {
    details.append(
      el('strong', `${check.mark} ${check.id} · ${check.kind}`),
      el('pre', check.detail),
    );
    if (check.command) details.append(el('pre', check.command));
  }
  parent.append(details);
}
/** The durable step journal: what actually survived, independent of the current step list. */
export function stepJournal(parent: HTMLElement, steps: TaskStepCheckpoint[]) {
  const reading = stepJournalReading(steps, locale());
  if (!reading) return;
  const details = el('details', '', 'task-step-journal');
  details.append(el('summary', reading.summary));
  for (const entry of reading.entries) details.append(el('p', entry));
  parent.append(details);
}
