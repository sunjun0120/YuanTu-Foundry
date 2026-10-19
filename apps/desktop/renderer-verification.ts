/**
 * The optional completion-contract editor shared by the composer and the plan panel.
 *
 * The carrier has accepted a `verification` on `send` and `planExecute` since the completion contract existed;
 * the window never offered one, so every ordinary request and every approved plan ended as an unverified
 * `completed`. This is the missing entry: a person states the commands that decide "done", and optionally the
 * paths whose changes after those checks invalidate the verdict.
 *
 * It deliberately accepts only command checks. A file-exact/forbidden-path check needs a structured value a plain
 * form cannot state honestly, and the task editor already covers those definitions; a command is the one check a
 * person can write in a text box without guessing what the runner will do with it.
 */
import type { Acceptance } from '../../packages/protocol/index.ts';
import { onLocaleChange, t } from './i18n.ts';

export interface VerificationDraft {
  acceptance: Acceptance[];
  inputs: string[];
  /** Present for an ordinary request; a plan's objective is the plan title. */
  objective?: string;
}

export interface VerificationEditor {
  /** The contract the form currently states, or undefined when the section is closed/hidden. */
  value(): VerificationDraft | undefined;
  /** Plan execution only: the editor is useful on an approved plan and nowhere else. */
  setVisible(visible: boolean): void;
  /** Collapse after a successful send, so the next turn does not silently repeat the same contract. */
  close(): void;
}

const MAX_COMMANDS = 32;

/** The contract a form's raw text states; exported so the conversion is testable without a DOM. */
export function verificationDraft(input: {
  commands: string;
  inputs: string;
  objective?: string;
  includeObjective: boolean;
  defaultObjective: string;
}): VerificationDraft {
  const lines = input.commands
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (!lines.length) throw new Error(t('verification.needCommand'));
  if (lines.length > MAX_COMMANDS) throw new Error(t('verification.tooMany'));
  const acceptance: Acceptance[] = lines.map((command, index) => ({
    description: command,
    met: false,
    check: {
      id: `check-${String(index + 1)}`,
      kind: 'command',
      command,
    },
  }));
  const seen = new Set<string>();
  const paths: string[] = [];
  for (const part of input.inputs.split(/[,，\n]/)) {
    const path = part.trim();
    if (!path || seen.has(path)) continue;
    seen.add(path);
    paths.push(path);
  }
  const stated = input.objective?.trim();
  return {
    acceptance,
    inputs: paths,
    ...(input.includeObjective
      ? {
          objective: stated || input.defaultObjective.trim() || t('verification.defaultObjective'),
        }
      : {}),
  };
}

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className = '',
): HTMLElementTagNameMap[K] {
  const value = document.createElement(tag);
  if (className) value.className = className;
  return value;
}

function labelled(text: string, control: HTMLElement): HTMLLabelElement {
  const label = element('label', 'verification-field');
  label.append(element('span', 'verification-field-label'), control);
  label.firstElementChild!.textContent = text;
  return label;
}

export function createVerificationEditor(options: {
  host: HTMLElement;
  /** False for a plan, whose objective is the approved plan's title. */
  includeObjective: boolean;
  /** What the objective defaults to when the field is empty. */
  defaultObjective: () => string;
}): VerificationEditor {
  const details = element('details', 'verification-editor');
  const summary = element('summary');
  summary.textContent = t('verification.summary');
  details.append(summary);
  const body = element('div', 'verification-body');
  details.append(body);

  let objective: HTMLInputElement | undefined;
  if (options.includeObjective) {
    objective = element('input', 'verification-input');
    objective.type = 'text';
    objective.maxLength = 2000;
    objective.placeholder = t('verification.objectivePlaceholder');
    body.append(labelled(t('verification.objective'), objective));
  }

  const commands = element('textarea', 'verification-commands');
  commands.rows = 3;
  commands.maxLength = 16_000;
  commands.placeholder = t('verification.commandsPlaceholder');
  body.append(labelled(t('verification.commands'), commands));

  const inputs = element('input', 'verification-input');
  inputs.type = 'text';
  inputs.maxLength = 4096;
  inputs.placeholder = t('verification.inputsPlaceholder');
  body.append(labelled(t('verification.inputs'), inputs));

  const hint = element('p', 'verification-hint');
  hint.textContent = t('verification.hint');
  body.append(hint);
  options.host.append(details);
  /**
   * The editor is created once, while the rest of the window is repainted on a language change. Its own labels
   * have to follow the same dictionary, or a panel opened after switching language would keep the old one.
   */
  const applyLabels = (): void => {
    summary.textContent = t('verification.summary');
    const spans = Array.from(body.querySelectorAll('.verification-field-label'));
    let next = 0;
    if (objective) {
      if (spans[next]) spans[next]!.textContent = t('verification.objective');
      next++;
      objective.placeholder = t('verification.objectivePlaceholder');
    }
    if (spans[next]) spans[next]!.textContent = t('verification.commands');
    next++;
    commands.placeholder = t('verification.commandsPlaceholder');
    if (spans[next]) spans[next]!.textContent = t('verification.inputs');
    inputs.placeholder = t('verification.inputsPlaceholder');
    hint.textContent = t('verification.hint');
  };
  applyLabels();
  onLocaleChange(applyLabels);

  return {
    value(): VerificationDraft | undefined {
      if (details.hidden || !details.open) return undefined;
      return verificationDraft({
        commands: commands.value,
        inputs: inputs.value,
        ...(objective ? { objective: objective.value } : {}),
        includeObjective: options.includeObjective,
        defaultObjective: options.defaultObjective(),
      });
    },
    setVisible(visible: boolean): void {
      details.hidden = !visible;
    },
    close(): void {
      details.open = false;
    },
  };
}
