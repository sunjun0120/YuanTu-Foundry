/**
 * The command palette's controller and its seam to the legacy textarea.
 *
 * The menu is React; the textarea it edits is still the composer's. This adapter is the one place that bridges them:
 * it reads the line for filtering, writes the chosen text back, keeps `aria-activedescendant` on the textarea, and
 * answers the composer's `submitSlash` question. When the composer region moves to React (after attachments), the
 * bridge becomes a prop and this file disappears.
 */
import type { CarrierCommand, CarrierSnapshot } from '../../../../packages/carrier/contract.ts';
import { mountRegion } from '../legacy/mount-region.tsx';
import { createStore } from '../stores.ts';
import { CommandPalette } from './CommandPalette.tsx';
import {
  exportPayload,
  paletteItems,
  promptForChoice,
  slashOutcome,
  type CommandPaletteController,
  type CommandPaletteState,
  type PaletteItem,
} from './command-model.ts';

export function mountCommandPalette(deps: {
  getState(): CarrierSnapshot | null;
  invoke(command: CarrierCommand): Promise<CarrierSnapshot | null>;
  requestRender(): void;
  requestComposerUpdate(): void;
}): CommandPaletteController {
  const host = document.getElementById('command-menu-root');
  const prompt = document.getElementById('prompt') as HTMLTextAreaElement | null;
  const store = createStore<CommandPaletteState>({
    text: '',
    skills: [],
    selected: 0,
    dismissed: false,
    disabled: true,
  });
  let disposed = false;
  let disposeRegion: () => void = () => {};
  const update = (patch: Partial<CommandPaletteState>): void => {
    if (!disposed) store.set({ ...store.getSnapshot(), ...patch });
  };
  const refreshPromptAttributes = (): void => {
    if (!prompt) return;
    const state = store.getSnapshot();
    const items = paletteItems(state.text, state.dismissed, state.skills);
    if (!items.length || state.disabled) prompt.removeAttribute('aria-activedescendant');
    else prompt.setAttribute('aria-activedescendant', `command-option-${state.selected}`);
  };
  store.subscribe(refreshPromptAttributes);

  const controller: CommandPaletteController = {
    store,
    onInput() {
      update({
        text: prompt?.value ?? '',
        selected: 0,
        dismissed: false,
        // An input event cannot arrive from a disabled textarea; the menu is open unless a later render says
        // otherwise. Reading `prompt.disabled` here raced a session-loading pass that disabled and re-enabled the
        // composer within one keystroke (desktop-language smoke caught the menu staying shut).
        disabled: false,
      });
      deps.requestComposerUpdate();
    },
    onKeydown(event) {
      const state = store.getSnapshot();
      const items = paletteItems(state.text, state.dismissed, state.skills);
      const open = items.length > 0 && !state.disabled;
      if (open && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
        event.preventDefault();
        const selected =
          event.key === 'ArrowUp'
            ? (state.selected - 1 + items.length) % items.length
            : (state.selected + 1) % items.length;
        update({ selected });
        return true;
      }
      if (open && event.key === 'Enter' && !event.isComposing) {
        event.preventDefault();
        const item = items[state.selected];
        if (item) controller.choose(item);
        return true;
      }
      if (open && event.key === 'Escape') {
        event.preventDefault();
        update({ dismissed: true });
        return true;
      }
      return false;
    },
    choose(item: PaletteItem) {
      const sessionId = deps.getState()?.session.sessionId ?? null;
      update({ dismissed: true, selected: 0 });
      if (!prompt) return;
      const text = promptForChoice(item);
      if (text === null) {
        prompt.value = '';
        update({ text: '' });
        deps.requestRender();
        const payload = exportPayload(sessionId);
        if (payload) void deps.invoke({ type: 'export', ...payload });
        prompt.focus();
        return;
      }
      prompt.value = text;
      update({ text });
      deps.requestRender();
      prompt.focus();
    },
    submitSlash(text, hasAttachments) {
      const sessionId = deps.getState()?.session.sessionId ?? null;
      const outcome = slashOutcome(text, hasAttachments, sessionId);
      if (outcome && 'command' in outcome) {
        if (prompt) prompt.value = '';
        update({ text: '', dismissed: true, selected: 0 });
        deps.requestRender();
      }
      return outcome;
    },
    update(input) {
      update({ skills: input.skills, disabled: input.disabled });
    },
    dispose() {
      disposed = true;
      disposeRegion();
    },
  };

  if (host)
    disposeRegion = mountRegion(
      'command-palette',
      host,
      <CommandPalette controller={controller} />,
    );
  return controller;
}
