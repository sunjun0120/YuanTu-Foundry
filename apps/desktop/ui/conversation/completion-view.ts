/**
 * The session's completion contract, as one block under the transcript.
 *
 * The point of the block is the distinction the transcript cannot draw: a run that ended is not a request that was
 * met. Four states get four sentences — verified, unverified, needs review, repair limit reached — and a session with
 * no contract says so rather than borrowing any of them. Nothing internal is shown: no hash, no attempt id, no effect
 * id, because none of them help the person decide whether to trust the work.
 *
 * The views are built as plain DOM and rehosted by the transcript's React row: the completion block has no state of
 * its own beyond the open property of its fold, which the browser owns on the row element. The row keeps its key
 * (`data-completion-key`) when the same verdict is repainted, so an expanded evidence block stays expanded.
 */
import type { CarrierSnapshot } from '../../../../packages/carrier/contract.ts';
import { locale, t } from '../../i18n.ts';

/**
 * The element the block is redrawn inside. The completion notice is rehosted into the transcript row, which React owns,
 * so the read is of a seat the shell already rendered rather than of a page this module builds.
 */
function required<T extends HTMLElement = HTMLElement>(id: string): T {
  const value = document.getElementById(id);
  if (!value) throw new Error(`Missing element: ${id}`);
  return value as T;
}
function node<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  text = '',
  className = '',
): HTMLElementTagNameMap[K] {
  const value = document.createElement(tag);
  value.textContent = text;
  value.className = className;
  return value;
}

/** The review reasons `ui.completionReason.*` has a sentence for; see `decideCompletion`. */
const COMPLETION_REASONS = new Set([
  'pending-effects',
  'manual-review',
  'cancelled',
  'definition-changed',
  'repeated-failure',
  'verification-changed-monitored-inputs',
  'empty-acceptance',
  'invalid-definition',
  'protected-path-changed',
  'missing-verification',
  'superseded',
  'environment-error',
]);

export function completionNotice(
  snapshot: CarrierSnapshot | null,
  onRequestFullAccess?: () => void,
): HTMLElement | null {
  const completion = snapshot?.session.completion ?? null;
  if (!completion) return null;
  const summary = completion.summary;
  const automatic = completion.source === 'automatic';
  // Successful automatic checks keep their evidence in session state without adding transcript UI.
  if (automatic && summary.state === 'verified') return null;
  // An environment limit leaves verification unknown; it cannot establish whether the code is correct.
  const environmentLimited =
    summary.state === 'needs_review' &&
    summary.reason.split(':')[0]!.trim() === 'environment-error';
  const sandboxSpawn =
    environmentLimited &&
    (completion.evidence?.checks ?? []).some(
      (check) => !check.passed && /spawn EPERM|EPERM \(-4048\)/u.test(check.detail),
    );
  const element = node(
    'div',
    '',
    automatic
      ? 'completion-details'
      : `completion-notice completion-${environmentLimited ? 'unverified' : summary.state}`,
  );
  const stateKey = environmentLimited
    ? 'ui.completionState.environment'
    : `ui.completionState.${summary.state}`;
  const title = `${t(automatic ? 'ui.automaticVerificationTitle' : 'ui.completionTitle')} · ${t(stateKey)}`;
  if (!automatic) element.append(node('strong', title));
  // Why it is waiting, for the two states that wait on a person. Known reasons get their own sentence; any other one
  // says only that a person has to look — the reason code itself is the runtime's bookkeeping.
  if (
    summary.state === 'needs_review' ||
    summary.state === 'limited' ||
    (automatic &&
      summary.state === 'unverified' &&
      COMPLETION_REASONS.has(summary.reason.split(':')[0]!.trim())) ||
    summary.reason === 'missing-verification' ||
    summary.reason === 'superseded'
  ) {
    const code = summary.reason.split(':')[0]!.trim();
    const known = COMPLETION_REASONS.has(code) ? code : 'other';
    element.append(node('p', t(`ui.completionReason.${known}`), 'completion-reason'));
    if (sandboxSpawn) {
      element.append(node('p', t('ui.completionReason.sandboxSpawn'), 'completion-reason'));
      if (onRequestFullAccess) {
        const button = node(
          'button',
          t('ui.completionFullAccess'),
          'secondary completion-full-access',
        );
        button.type = 'button';
        button.addEventListener('click', () => onRequestFullAccess());
        element.append(button);
      }
    }
  }
  if (completion.definition.objective)
    element.append(
      node('p', t('ui.completionObjective', { objective: completion.definition.objective })),
    );
  const done = completion.steps.filter((step) => step.status === 'completed').length;
  if (completion.steps.length)
    element.append(
      node(
        'p',
        t('ui.completionSteps', { done: String(done), total: String(completion.steps.length) }),
      ),
    );
  if (summary.unfinishedStepIds.length)
    element.append(
      node('p', t('ui.completionUnfinished', { steps: summary.unfinishedStepIds.join(', ') })),
    );
  if (!automatic && summary.failedCheckIds.length) {
    const descriptions = summary.failedCheckIds.map(
      (id) =>
        completion.definition.acceptance.find((item) => item.check?.id === id)?.description ?? id,
    );
    element.append(node('p', t('ui.completionFailedChecks', { checks: descriptions.join(', ') })));
  }
  // A budget is only worth showing once it is being spent: a verified contract with no repairs does not need to tell
  // the reader how many attempts it was allowed.
  if (!environmentLimited && completion.policy.maxRepairRounds > 0 && summary.repairRounds > 0)
    element.append(
      node(
        'p',
        t('ui.completionRepairs', {
          used: String(summary.repairRounds),
          max: String(completion.policy.maxRepairRounds),
        }),
      ),
    );
  for (const check of completion.evidence?.checks ?? []) {
    const criterion = completion.definition.acceptance.find((item) => item.check?.id === check.id);
    const spec = criterion?.check;
    const command =
      spec?.kind === 'command' ? [spec.command, ...(spec.args ?? [])].join(' ') : undefined;
    const shown = command && command.length > 160 ? `${command.slice(0, 157)}…` : command;
    const description = criterion?.description ?? check.id;
    const notRun =
      check.kind === 'command' &&
      !check.command &&
      (check.failureReason === 'environment-error' || check.failureReason === 'permission-denied');
    const resultKey = check.passed
      ? 'ui.verificationCheckPassed'
      : notRun
        ? 'ui.verificationCheckNotRun'
        : 'ui.verificationCheckFailed';
    const line = node('p', '', `completion-check ${check.passed ? 'passed' : 'failed'}`);
    line.append(node('strong', t(resultKey)), ' ', node('span', description));
    if (shown)
      line.append(
        ' · ',
        node(
          'span',
          t(notRun ? 'ui.verificationPlannedCommand' : 'ui.verificationCommand', {
            command: shown,
          }),
          'completion-command',
        ),
      );
    // The check description naming `npm test` while the command is a directly-run file is the substitution this round
    // produced; naming it is more honest than letting a green tick speak for a command nobody ran.
    const substitute =
      spec?.kind === 'command' &&
      /npm\s+(?:run\s+)?test/i.test(description) &&
      !/^npm(?:\.cmd)?\s+(?:run\s+)?test/i.test(command ?? '');
    if (substitute)
      line.append(' ', node('span', t('ui.verificationSubstitute'), 'completion-substitute'));
    element.append(line);
    if (automatic) {
      element.append(node('p', check.detail));
      if (check.command) {
        element.append(
          node('p', t('ui.verificationExitCode', { code: String(check.command.exitCode ?? '—') })),
        );
        const output = [check.command.stdout, check.command.stderr].filter(Boolean).join('\n');
        if (output) element.append(node('pre', output));
      }
    }
  }
  if (!automatic && completion.evidence?.checks.length) {
    const details = node('details', '', 'completion-evidence');
    details.append(
      node(
        'summary',
        t('ui.verificationDetails', { count: String(completion.evidence.checks.length) }),
      ),
    );
    for (const check of completion.evidence.checks) {
      const criterion = completion.definition.acceptance.find(
        (item) => item.check?.id === check.id,
      );
      details.append(
        node(
          'p',
          `${t(check.passed ? 'ui.verificationCheckPassed' : 'ui.verificationCheckFailed')} · ${criterion?.description ?? check.id}`,
        ),
      );
      if (check.command) {
        details.append(
          node('p', t('ui.verificationExitCode', { code: String(check.command.exitCode ?? '—') })),
        );
        const output = [check.command.stdout, check.command.stderr].filter(Boolean).join('\n');
        if (output) details.append(node('pre', output));
      } else details.append(node('p', check.detail));
    }
    element.append(details);
  }
  if (automatic) {
    const details = node(
      'details',
      '',
      `completion-notice completion-summary completion-inline completion-${environmentLimited ? 'unverified' : summary.state}`,
    );
    const key = `${completion.sessionId}:${completion.contractId}:${completion.latestRunId}:${locale()}`;
    const previous = required('messages').querySelector<HTMLDetailsElement>('.completion-inline');
    details.dataset.completionKey = key;
    details.open = previous?.dataset.completionKey === key && previous.open;
    const label = node('summary');
    label.append(node('span', title, 'completion-inline-status'));
    details.append(label, element);
    return details;
  }
  return element;
}
