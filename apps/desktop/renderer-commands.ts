/**
 * The command palette above the composer, and the slash commands it is the discoverable half of.
 *
 * Everything starts with `/`: typing `/` opens a menu of the window's own commands and the session's skills,
 * filtering as the line grows, and Enter either runs the highlighted row or — for `/compact`, `/export`,
 * `/goal` and `/plan` — is recognised as a command the palette never lists when it is typed in full. The menu
 * and the typed form are one vocabulary, so they are one module: `commandItems` feeds the menu and the same four
 * names are matched here.
 *
 * Selection and dismissal (`selectedCommand`, `menuDismissed`) live here rather than in the DOM because the menu
 * is rebuilt on every keystroke and a highlight is not something an element can be trusted to remember. `onInput`
 * and `onKeydown` are the composer's listeners, handed back rather than registered, so the hub keeps the one
 * place where the composer's events are wired.
 */
import type { CarrierCommand, CarrierSnapshot } from '../../packages/carrier/contract.ts';
import { t } from './i18n.ts';

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

type PaletteItem = {
  kind: 'command' | 'skill';
  name: string;
  description: string;
  value: string;
};
/** What a typed slash line asked for: a command to run, or a line the window has to refuse and explain. */
export type SlashOutcome = { command: CarrierCommand } | { error: string };

export function setupCommandPalette(actions: {
  getState(): CarrierSnapshot | null;
  select(command: CarrierCommand): Promise<CarrierSnapshot | null>;
  invoke(command: CarrierCommand): Promise<CarrierSnapshot | null>;
  requestRender(): void;
  /** Clicking the send button while a run is live is how a run is stopped. */
  onStop(): void;
}): {
  render(): void;
  onInput(): void;
  onKeydown(event: KeyboardEvent): boolean;
  submitSlash(text: string, hasAttachments: boolean): SlashOutcome | null;
} {
  const prompt = required<HTMLTextAreaElement>('prompt');
  let selectedCommand = 0;
  let menuDismissed = false;
  function commandItems(): PaletteItem[] {
    return [
      {
        kind: 'command',
        name: t('ui.switchModel'),
        description: t('command.modelDescription'),
        value: 'model',
      },
      {
        kind: 'command',
        name: t('ui.permissions'),
        description: t('command.permissionsDescription'),
        value: 'permissions',
      },
      {
        kind: 'command',
        name: t('ui.newSession'),
        description: t('command.newSessionDescription'),
        value: 'new-session',
      },
      {
        kind: 'command',
        name: t('ui.stop'),
        description: t('command.stopDescription'),
        value: 'stop',
      },
      {
        kind: 'command',
        name: t('ui.refreshSkills'),
        description: t('command.refreshSkillsDescription'),
        value: 'refresh-resources',
      },
      {
        kind: 'command',
        name: t('ui.compactContext'),
        description: t('command.compactDescription'),
        value: 'compact',
      },
      {
        kind: 'command',
        name: t('ui.exportSession'),
        description: t('command.exportDescription'),
        value: 'export',
      },
      {
        kind: 'command',
        name: t('ui.createGoal'),
        description: t('command.goalDescription'),
        value: 'goal',
      },
      {
        kind: 'command',
        name: t('ui.createPlan'),
        description: t('command.planDescription'),
        value: 'plan',
      },
    ];
  }
  function commandQuery(): string | undefined {
    const match = prompt.value.match(/^\/([^\s:]*)$/);
    return match?.[1]?.toLowerCase();
  }
  function paletteItems(): PaletteItem[] {
    const query = commandQuery();
    if (query === undefined || menuDismissed) return [];
    const skills = (actions.getState()?.resources.skills ?? []).map((skill) => ({
      kind: 'skill' as const,
      name: skill.name,
      description: skill.description,
      value: skill.name,
    }));
    return [...commandItems(), ...skills].filter((item) =>
      `${item.name} ${item.description} ${item.value}`.toLowerCase().includes(query),
    );
  }
  function openSettingsPage(kind: 'model' | 'permissions'): void {
    if (kind === 'model') {
      document.getElementById('open-settings')?.dispatchEvent(new Event('click'));
      document.getElementById('model-settings')?.dispatchEvent(new Event('click'));
    } else {
      document.getElementById('permission-trigger')?.focus();
    }
  }
  function exportConversation(): string {
    const state = actions.getState();
    if (!state) return '';
    const title =
      state.sessions.find((item) => item.id === state?.session.sessionId)?.title || '新会话';
    return `# ${title}\n\n${state.session.messages
      .map(
        (message) =>
          `## ${message.role === 'user' ? '你' : message.role === 'assistant' ? '助手' : '工具'}\n\n${message.content}`,
      )
      .join('\n\n')}`;
  }
  function choosePaletteItem(item: PaletteItem): void {
    menuDismissed = true;
    if (item.kind === 'skill') {
      prompt.value = `/skill:${item.value} `;
      selectedCommand = 0;
      renderPalette();
      actions.requestRender();
      prompt.focus();
      return;
    }
    selectedCommand = 0;
    if (item.value === 'model' || item.value === 'permissions') {
      prompt.value = '';
      renderPalette();
      actions.requestRender();
      openSettingsPage(item.value);
      return;
    }
    if (item.value === 'new-session') {
      prompt.value = '';
      renderPalette();
      void actions.select({ type: 'create' });
    } else if (item.value === 'stop') {
      prompt.value = '';
      renderPalette();
      if (actions.getState()?.session.running) actions.onStop();
    } else if (item.value === 'refresh-resources') {
      prompt.value = '';
      renderPalette();
      void actions.select({ type: 'refreshResources' });
    } else if (item.value === 'export') {
      prompt.value = '';
      renderPalette();
      void actions.invoke({
        type: 'export',
        content: exportConversation(),
        suggestedName: 'yuantu-session.md',
      });
    } else {
      prompt.value = `/${item.value} `;
      renderPalette();
      actions.requestRender();
      prompt.focus();
    }
  }
  function renderPalette(): void {
    const menu = required('command-menu');
    menu.setAttribute('aria-label', t('ui.commandAndSkills'));
    const items = paletteItems();
    selectedCommand = Math.min(selectedCommand, Math.max(0, items.length - 1));
    menu.hidden = !items.length || prompt.disabled;
    if (items.length) {
      const activeId = `command-option-${selectedCommand}`;
      menu.setAttribute('aria-activedescendant', activeId);
      prompt.setAttribute('aria-activedescendant', activeId);
    } else {
      menu.removeAttribute('aria-activedescendant');
      prompt.removeAttribute('aria-activedescendant');
    }
    menu.replaceChildren();
    if (!items.length) return;
    let lastKind: PaletteItem['kind'] | undefined;
    items.forEach((item, index) => {
      if (item.kind !== lastKind) {
        menu.append(
          node(
            'div',
            item.kind === 'command' ? t('ui.commands') : t('ui.skills'),
            'command-menu-group',
          ),
        );
        lastKind = item.kind;
      }
      const button = node('button', '', index === selectedCommand ? 'selected' : '');
      button.id = `command-option-${index}`;
      button.type = 'button';
      button.setAttribute('role', 'option');
      button.setAttribute('aria-selected', String(index === selectedCommand));
      button.append(
        node('strong', item.kind === 'command' ? `/${item.value}` : item.name),
        node('small', item.description),
      );
      button.addEventListener('pointerdown', (event) => event.preventDefault());
      button.addEventListener('click', () => choosePaletteItem(item));
      menu.append(button);
    });
    const active = menu.querySelector<HTMLButtonElement>(`#command-option-${selectedCommand}`);
    active?.scrollIntoView({ block: 'nearest' });
  }
  /** A keystroke in the composer while the menu is open. `@returns` whether the palette consumed it. */
  function onKeydown(event: KeyboardEvent): boolean {
    const menu = required('command-menu');
    const options = menu.querySelectorAll<HTMLButtonElement>('button');
    if (!menu.hidden && options.length && ['ArrowDown', 'ArrowUp'].includes(event.key)) {
      event.preventDefault();
      selectedCommand =
        event.key === 'ArrowUp'
          ? (selectedCommand - 1 + options.length) % options.length
          : (selectedCommand + 1) % options.length;
      renderPalette();
      return true;
    }
    if (!menu.hidden && options.length && event.key === 'Enter' && !event.isComposing) {
      event.preventDefault();
      const items = paletteItems();
      const selected = items[selectedCommand];
      if (selected) choosePaletteItem(selected);
      return true;
    }
    if (!menu.hidden && event.key === 'Escape') {
      event.preventDefault();
      menuDismissed = true;
      menu.hidden = true;
      return true;
    }
    return false;
  }
  /** A new line in the composer: the menu opens, and any previous dismissal is forgotten. */
  function onInput(): void {
    selectedCommand = 0;
    menuDismissed = false;
    renderPalette();
    actions.requestRender();
  }
  /**
   * A submitted line that names one of the window's own commands.
   *
   * `@returns` the command to run — the palette has already cleared the composer and dismissed the menu — a
   * refusal to show, or `null` when the line is an ordinary message. It is handed back rather than run here
   * because running it means holding the composer's send state, which belongs to the composer.
   */
  function submitSlash(text: string, hasAttachments: boolean): SlashOutcome | null {
    if (hasAttachments) return null;
    const slash = text.match(/^\/(compact|export|goal|plan)(?:\s+([\s\S]*))?$/i);
    if (!slash) return null;
    const name = slash[1]!.toLowerCase();
    const argument = slash[2]?.trim() || '';
    if ((name === 'goal' || name === 'plan') && !argument)
      return { error: `/${name} 需要描述内容。` };
    prompt.value = '';
    menuDismissed = true;
    const command: CarrierCommand =
      name === 'compact'
        ? { type: 'compact' }
        : name === 'export'
          ? { type: 'export', content: exportConversation(), suggestedName: 'yuantu-session.md' }
          : name === 'goal'
            ? { type: 'goal', prompt: argument }
            : { type: 'plan', prompt: argument };
    return { command };
  }
  return { render: renderPalette, onInput, onKeydown, submitSlash };
}
