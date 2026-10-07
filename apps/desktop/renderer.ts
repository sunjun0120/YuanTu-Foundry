import {
  splitAttachmentPrompt,
  attachmentPrompt,
  MAX_DOCUMENT_BYTES,
  type DocumentAttachment,
} from './attachment-contract.ts';
import { setupTasks } from './renderer-tasks.ts';
import { setupStatistics } from './renderer-statistics.ts';
import { setupWorkspace } from './renderer-workspace.ts';
import { setupSubAgents } from './renderer-subagents.ts';
import { setupMcpSettings } from './renderer-mcp.ts';
import type { DesktopBridge } from './contract.ts';
import type { CarrierCommand, CarrierSnapshot } from '../../packages/carrier/contract.ts';
import type { Message, ImageAttachment, Plan, TodoItem } from '../../packages/protocol/index.ts';
import type { PresentedFile } from '../../packages/protocol/deliverables.ts';
import type { Goal } from '../../packages/protocol/goals.ts';
import type { PendingQuestion } from '../../packages/client/session-controller.ts';
import { isRuntimeContext } from '../../packages/protocol/context.ts';
import { fileChangeAction, undoConfirmKey } from '../../packages/client/change-actions.ts';
import { validateImages, MAX_IMAGE_BYTES } from '../../packages/protocol/images.ts';
import { setupModelSettings } from './renderer-settings.ts';
import { renderMarkdown } from './markdown.ts';
import { diffView } from './diff-view.ts';
import { toolCardModel, toolCardView } from './tool-cards.ts';
import { setupSessionManagement } from './session-management.ts';
import { setupGeneralSettings } from './renderer-general-settings.ts';
import { setupPermissionSettings } from './renderer-permissions.ts';
import { locale, t, format, onLocaleChange } from './i18n.ts';
import { SlotRegistry, mountSlot, type SlotMount } from './slots.ts';
declare global {
  interface Window {
    yuantu: DesktopBridge;
  }
}

function element<T extends HTMLElement = HTMLElement>(id: string): T {
  const value = document.getElementById(id);
  if (!value) throw new Error(`Missing element: ${id}`);
  return value as T;
}
/**
 * What the kernel writes into `error` when the signal it was given aborted.
 *
 * The string is the kernel's, so it is matched here rather than re-worded there: `agent.ts` uses it as the
 * reason on the run result, the CLI prints it, and a second spelling of "the user stopped this" is a second
 * thing to keep in step.
 */
const RUN_CANCELLED = 'Run cancelled';
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
const statisticsView = setupStatistics();
const workspaceView = setupWorkspace();
/** What a panel-level slot is given: the carrier snapshot a panel draws from, and nothing else. */
interface PanelSlotContext {
  readonly session: CarrierSnapshot['session'];
  readonly workspace: string;
}
/** What a slot inside one message is given: the message it sits on. */
interface MessageSlotContext {
  readonly message: Message;
}
/**
 * Every slot this window renders, and what each hands a contribution.
 *
 * Declared as one map so the registry can check a registration against the slot it names: a contribution to
 * `sidebar.right` that expects a message is a type error here rather than a panel that receives something it
 * cannot read. A slot missing from this map is a type error too.
 */
interface DesktopSlotContexts {
  'composer.above': PanelSlotContext;
  'message.actions': MessageSlotContext;
  'message.footer': MessageSlotContext;
  'sidebar.right': PanelSlotContext;
  'tool.result.extra': MessageSlotContext;
}
/**
 * The window's combination point.
 *
 * The panels used to be called by name from `render()`, in the order the calls happened to be written, which
 * left exactly one way to add a view: edit this file. They now register into a named slot, through the same call
 * a contributed view would use — a built-in that bypassed its own slot would be a second path that drifts from
 * the first. Which slot exists, what order it renders in and how a contribution leaves are pinned by
 * `tests/slots.test.ts`; the composition itself is exercised by the desktop smoke.
 *
 * The frames the mount creates are nesting, not ownership: each panel still builds its own subtree by id, so
 * moving one into the slot changed where it sits and who decides the order, not what it renders.
 */
const slots = new SlotRegistry<DesktopSlotContexts>();
slots.register('composer.above', {
  order: 10,
  render: (_frame, context) => statisticsView.update(context.session),
});
slots.register('sidebar.right', {
  order: 10,
  render: (_frame, context) => workspaceView.update(context.workspace),
});
// Extra material beside a tool result: the pictures it produced and the change it made to a file. A contributed
// view can add more here — a chart, a rendered document — without this file learning about it.
slots.register('tool.result.extra', {
  order: 10,
  render: (frame, context) => {
    const message = context.message;
    if (message.role !== 'tool') return;
    frame.replaceChildren(
      ...(message.images?.length ? [imageGallery(message.images)] : []),
      ...(message.change && !message.isError ? [diffView(message.change)] : []),
    );
  },
});
// The two halves of a user message's meta row: when it was sent, and what can be done with it. They are two
// slots because they are two questions — a contributed view that wants to act on a message registers next to the
// copy button, and one that wants to annotate it registers beside the timestamp.
slots.register('message.footer', {
  order: 10,
  render: (frame, context) => frame.replaceChildren(messageTimeView(context.message)),
});
slots.register('message.actions', {
  order: 20,
  render: (frame, context) => frame.replaceChildren(messageCopyView(context.message)),
});
const subagentView = setupSubAgents(
  () => state,
  (command) => void invoke(command),
  messageView,
);
const prompt = element<HTMLTextAreaElement>('prompt');
const sendButton = element<HTMLButtonElement>('send');
const conversation = element('conversation');
/** Mounted once: a slot's frames are stable across renders, so re-rendering cannot stack a panel twice. */
const slotMounts: SlotMount<PanelSlotContext>[] = [
  mountSlot(document, element('composer-statistics'), slots, 'composer.above'),
  mountSlot(document, element('workspace-panel'), slots, 'sidebar.right'),
];
/**
 * Mount a message-level slot into a container this view just built.
 *
 * Called from `messageView`, which runs once per message per transcript rebuild (`render()` replaces the whole
 * list when the revision or the language changes), so each message element gets its own frames and nothing has
 * to be disposed: they are removed with the element they live in.
 */
function mountMessageSlot(
  container: HTMLElement,
  slot: 'message.actions' | 'message.footer' | 'tool.result.extra',
  message: Message,
): void {
  mountSlot(document, container, slots, slot).render({ message });
}
let state: CarrierSnapshot | null = null;

let mcpSettings: ReturnType<typeof setupMcpSettings> | undefined;
let permissionSettings: ReturnType<typeof setupPermissionSettings> | undefined;
let modelSettings: ReturnType<typeof setupModelSettings> | undefined;
let localError: string | null = null;
let operation = false;
let sending = false;
let stopping = false;
let approvalBusy = new Set<string>();
let transcriptKey = '';
let changesKey = '';
let sessionKey = '';
let approvalKey = '';
let questionKey = '';
let todoKey = '';
let todoSessionId = '';
let goalKey = '';
let deliverablesKey = '';
const questionBusy = new Set<string>();
let queueBusy = false;
let imageBusy = false;
let attachments: ImageAttachment[] = [];
let documentAttachments: DocumentAttachment[] = [];
let selectedCommand = 0;
let menuDismissed = false;
let liveKey = '';
let liveTimer: ReturnType<typeof setTimeout> | undefined;
let planKey = '';
/**
 * Streamed text accumulated from the delta channel. Snapshots no longer arrive per token, so the
 * live bubble reads from this buffer and falls back to the snapshot's own copy (which the controller
 * also keeps current) whenever the two disagree — for example right after a session reload.
 *
 * `reasoning` is a second buffer, not a second half of the first: the two channels are painted into
 * different places, and mixing them here is how thinking would end up rendered as the answer.
 */
let liveDelta: { id: string; text: string; reasoning: string } | null = null;
const markdownActions = {
  async copy(text: string) {
    if (!(await invoke({ type: 'copyText', text }))) throw new Error('Copy failed');
  },
  async open(url: string) {
    if (!(await invoke({ type: 'openLink', url }))) throw new Error('Open failed');
  },
};
type PaletteItem = {
  kind: 'command' | 'skill';
  name: string;
  description: string;
  value: string;
};
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
  const skills = (state?.resources.skills ?? []).map((skill) => ({
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
    render();
    prompt.focus();
    return;
  }
  selectedCommand = 0;
  if (item.value === 'model' || item.value === 'permissions') {
    prompt.value = '';
    renderPalette();
    render();
    openSettingsPage(item.value);
    return;
  }
  if (item.value === 'new-session') {
    prompt.value = '';
    renderPalette();
    void select({ type: 'create' });
  } else if (item.value === 'stop') {
    prompt.value = '';
    renderPalette();
    if (state?.session.running) sendButton.click();
  } else if (item.value === 'refresh-resources') {
    prompt.value = '';
    renderPalette();
    void select({ type: 'refreshResources' });
  } else if (item.value === 'export') {
    prompt.value = '';
    renderPalette();
    void invoke({
      type: 'export',
      content: exportConversation(),
      suggestedName: 'yuantu-session.md',
    });
  } else {
    prompt.value = `/${item.value} `;
    renderPalette();
    render();
    prompt.focus();
  }
}
function renderPalette(): void {
  const menu = element('command-menu');
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
let backgroundEntrySeen = false;
try {
  backgroundEntrySeen = localStorage.getItem('yuantu.backgroundEntrySeen') === '1';
} catch {
  /* Storage is optional. */
}
function renderBackground(): void {
  const list = element('background-list');
  const existing = new Map(
    Array.from(list.querySelectorAll<HTMLElement>('.background-card[data-job-id]')).map(
      (item) => [item.dataset.jobId, item] as const,
    ),
  );
  const jobs = state?.background ?? [];
  const openBackground = element<HTMLButtonElement>('open-background');
  const backgroundPopover = element<HTMLElement>('background-popover');
  if (jobs.length && !backgroundEntrySeen) {
    backgroundEntrySeen = true;
    try {
      localStorage.setItem('yuantu.backgroundEntrySeen', '1');
    } catch {
      /* Keep it for this window. */
    }
  }
  openBackground.hidden = !backgroundEntrySeen;
  if (openBackground.hidden) backgroundPopover.hidden = true;
  openBackground.setAttribute('aria-expanded', String(!backgroundPopover.hidden));
  const runningCount = jobs.filter((job) => ['starting', 'running'].includes(job.status)).length;
  element('background-label').textContent = format(
    t(runningCount ? 'background.runningCount' : 'background.totalCount'),
    { count: runningCount || jobs.length },
  );
  if (!jobs.length) element('background-label').textContent = t('background.title');
  if (!jobs.length) {
    list.replaceChildren(node('p', t('background.empty'), 'background-empty'));
    return;
  }
  list.querySelector('.background-empty')?.remove();
  const statusLabel = (status: string) => t(`background.${status}`);
  const elapsed = (createdAt: string, finishedAt?: string): string => {
    const start = Date.parse(createdAt);
    const end = finishedAt ? Date.parse(finishedAt) : Date.now();
    if (!Number.isFinite(start) || !Number.isFinite(end)) return '—';
    const total = Math.floor(Math.max(0, end - start) / 1000);
    const seconds = total % 60;
    const minutes = Math.floor(total / 60) % 60;
    const hours = Math.floor(total / 3600);
    return locale() === 'en-US'
      ? `${hours ? `${hours}h ` : ''}${hours || minutes ? `${minutes}m ` : ''}${seconds}s`
      : `${hours ? `${hours}小时` : ''}${hours || minutes ? `${minutes}分` : ''}${seconds}秒`;
  };
  for (const [index, job] of jobs.entries()) {
    let card = existing.get(job.id);
    if (!card) {
      card = node('div', '', 'background-card');
      card.dataset.jobId = job.id;
      const header = node('div', '', 'background-card-header');
      header.append(
        node('span', '', 'background-dot'),
        node('span', '', 'background-shell'),
        node('span', '', 'background-command'),
        node('span', '', 'background-status'),
        node('span', '', 'background-duration'),
      );
      card.append(header);
    }
    const header = card.querySelector<HTMLElement>('.background-card-header')!;
    const shell = /^(pwsh|powershell|bash|zsh|cmd|sh)(?:\.exe)?(?=\s|$)/i.exec(
      job.command.trim(),
    )?.[1];
    const command = header.querySelector<HTMLElement>('.background-command')!;
    command.textContent = job.command;
    command.title = job.command;
    const finished = !['starting', 'running'].includes(job.status);
    header.querySelector<HTMLElement>('.background-dot')!.className =
      `background-dot ${job.status}`;
    header.querySelector<HTMLElement>('.background-shell')!.textContent =
      shell ?? t('background.commandLabel');
    const status = header.querySelector<HTMLElement>('.background-status')!;
    status.textContent =
      job.status !== 'cancelled' && job.exitCode !== null
        ? format(t('background.exitCodeValue'), { code: job.exitCode })
        : statusLabel(job.status);
    status.className = `background-status ${job.status}`;
    header.querySelector<HTMLElement>('.background-duration')!.textContent =
      !finished || job.finishedAt ? elapsed(job.createdAt, job.finishedAt) : '—';
    /**
     * The way out of a running job, on the line it belongs to.
     *
     * It is revealed by the row's own hover or focus: a popover listing
     * seventeen jobs needs the command and the outcome on every line and a column of buttons on none of
     * them, and the one job somebody wants to stop is the one their pointer is already on. A finished job
     * has nothing to stop, so it gets no button at all — an empty control is worse than no control.
     */
    const previousStop = header.querySelector<HTMLButtonElement>('.background-stop');
    if (finished) previousStop?.remove();
    else if (!previousStop) {
      const stop = node('button', t('background.stop'), 'background-stop');
      stop.type = 'button';
      stop.title = t('background.stop');
      stop.addEventListener('click', () => {
        stop.disabled = true;
        void invoke({ type: 'stopBackground', id: job.id, sessionId: job.sessionId });
      });
      header.append(stop);
    }
    const current = list.children[index];
    if (current !== card) list.insertBefore(card, current ?? null);
  }
  for (const [id, card] of existing) if (!jobs.some((job) => job.id === id)) card.remove();
}

function renderAttachments(): void {
  element('attachments').replaceChildren(
    ...documentAttachments.map((file, index) => {
      const card = node('div', '', 'attachment document-attachment');
      const label = node('span', file.name);
      label.title = file.name + '\n' + file.text.length + ' 字符';
      const remove = node('button', '×', 'attachment-remove');
      remove.type = 'button';
      remove.setAttribute('aria-label', '移除附件 ' + file.name);
      remove.addEventListener('click', () => {
        documentAttachments.splice(index, 1);
        renderAttachments();
        render();
      });
      card.append(node('span', '▤', 'document-icon'), label, remove);
      return card;
    }),
    ...attachments.map((image, index) => {
      const card = node('div', '', 'attachment');
      const preview = node('img');
      preview.src = `data:${image.mimeType};base64,${image.data}`;
      preview.alt = image.name || t('ui.image');
      preview.title = image.name || t('ui.image');
      preview.addEventListener('click', () => {
        const dialog = document.createElement('dialog');
        dialog.className = 'image-preview-dialog';
        const enlarged = document.createElement('img');
        enlarged.src = preview.src;
        enlarged.alt = preview.alt;
        dialog.append(enlarged);
        dialog.addEventListener('click', () => dialog.close());
        dialog.addEventListener('close', () => dialog.remove(), { once: true });
        document.body.append(dialog);
        dialog.showModal();
      });
      const remove = node('button', '×', 'attachment-remove');
      remove.type = 'button';
      remove.setAttribute('aria-label', t('ui.removeImage', { name: image.name || t('ui.image') }));
      remove.title = t('ui.removeImage', { name: image.name || t('ui.image') });
      remove.addEventListener('click', (event) => {
        event.stopPropagation();
        attachments.splice(index, 1);
        renderAttachments();
        render();
      });
      card.append(preview, remove);
      return card;
    }),
  );
}

const taskView = setupTasks(select);
function renderTasks(): void {
  taskView(state, operation || sending);
}

async function invoke(command: CarrierCommand): Promise<CarrierSnapshot | null> {
  try {
    const reply = await window.yuantu.invoke(command);
    if (!reply.ok) {
      localError = reply.error;
      render();
      return null;
    }
    if (command.type === 'snapshot') state = reply.state;
    return reply.state;
  } catch {
    localError = '桌面连接中断，请重新启动后检查会话记录。';
    render();
    return null;
  }
}
async function select(command: CarrierCommand): Promise<CarrierSnapshot | null> {
  if (operation || sending || state?.session.running || state?.session.loading) return null;
  if (command.type === 'searchSessions') {
    localError = null;
    return invoke(command);
  }
  operation = true;
  localError = null;
  const previousWorkspace = state?.workspace;
  const previousSession = state?.session.sessionId;
  render();
  try {
    const next = await invoke(command);
    if (
      next &&
      (next.workspace !== previousWorkspace || next.session.sessionId !== previousSession)
    ) {
      prompt.value = '';
      attachments = [];
      documentAttachments = [];
      renderAttachments();
    }
    return next;
  } finally {
    operation = false;
    render();
    prompt.focus();
  }
}
/**
 * The pictures a message carries, whichever role carries them.
 *
 * A user's attachment and a tool's output are shown the same way on purpose: from a person's side both are
 * "there is a picture in this conversation", and a screenshot the model was shown must be visible to the person
 * reading along — otherwise the model's answer about a layout is unverifiable.
 */
function imageGallery(images: readonly ImageAttachment[]): HTMLElement {
  const gallery = node('div', '', 'message-images');
  for (const image of images) {
    const preview = node('img');
    preview.src = `data:${image.mimeType};base64,${image.data}`;
    preview.alt = image.name || t('ui.image');
    gallery.append(preview);
  }
  return gallery;
}
/**
 * When a user message was sent, as the `message.footer` slot draws it.
 *
 * Its own function because it is now a contribution rather than a line inside `messageView`: the slot owns
 * *where* it appears and in what order, and this owns what it says.
 */
function messageTimeView(message: Message): HTMLElement {
  const time = node('time', '—');
  // Only a user message carries a send time; another role in this slot says so rather than showing a fake one.
  const createdAt = 'createdAt' in message ? message.createdAt : undefined;
  const date = createdAt ? new Date(createdAt) : null;
  if (date && Number.isFinite(date.getTime())) {
    time.dateTime = date.toISOString();
    time.textContent = date.toLocaleTimeString(locale(), {
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    });
    time.title = date.toLocaleString(locale());
  } else {
    time.title = t('ui.sendTimeUnavailable');
  }
  return time;
}
/** The copy button and its feedback, as the `message.actions` slot draws them. */
function messageCopyView(message: Message): HTMLElement {
  const content =
    message.role === 'user' ? (message.displayContent ?? message.content) : message.content;
  const copy = node('button', '', 'copy-user-message');
  copy.type = 'button';
  const label = () => t('ui.copyMessage');
  copy.title = label();
  copy.setAttribute('aria-label', label());
  copy.innerHTML =
    '<svg viewBox="0 0 20 20" aria-hidden="true"><rect x="4" y="6" width="10" height="11" rx="2"/><path d="M7 6V5a2 2 0 0 1 2-2h5a3 3 0 0 1 3 3v6a2 2 0 0 1-2 2h-1"/></svg>';
  const feedback = node('span', '', 'user-copy-feedback');
  feedback.setAttribute('role', 'status');
  let reset: ReturnType<typeof setTimeout> | undefined;
  copy.addEventListener('click', async () => {
    copy.disabled = true;
    clearTimeout(reset);
    try {
      await markdownActions.copy(content);
      feedback.textContent = t('ui.copied');
    } catch {
      feedback.textContent = t('ui.copyFailed');
    } finally {
      copy.disabled = false;
      reset = setTimeout(() => {
        feedback.textContent = '';
      }, 1600);
    }
  });
  const actions = node('span', '', 'user-message-actions');
  actions.append(feedback, copy);
  return actions;
}
function processIcon(kind: string): HTMLElement {
  const paths: Record<string, string> = {
    reasoning: '<path d="M9 18h6m-5 3h4M8 14a6 6 0 1 1 8 0c-1 1-1 2-1 2H9s0-1-1-2Z"/>',
    read: '<path d="M14 3H6v18h12V7Zm0 0v4h4M9 11h6m-6 4h6"/>',
    search: '<circle cx="10" cy="10" r="6"/><path d="m15 15 6 6"/>',
    edit: '<path d="m15 4 5 5M4 20l5-1L21 7l-5-5L4 14Z"/>',
    command: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="m7 9 3 3-3 3m6 0h4"/>',
    tool: '<path d="m8 5-5 7 5 7m8-14 5 7-5 7m-3-16-2 18"/>',
    result: '<circle cx="12" cy="12" r="9"/><path d="m7 12 3 3 7-7"/>',
    failed: '<circle cx="12" cy="12" r="9"/><path d="M12 7v6m0 3v1"/>',
  };
  const icon = node('span', '', 'process-icon');
  icon.dataset.kind = kind;
  icon.setAttribute('aria-hidden', 'true');
  icon.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${paths[kind] ?? paths.tool}</svg>`;
  return icon;
}

let processSession: string | null = null;
let processMessageCount = 0;
let processTail: HTMLDetailsElement | undefined;
let processOpen = new Map<string, boolean>();
let processScroll = new Map<string, number>();
let runningProcessCalls = new Set<string>();

function updateProcessSummary(
  group: HTMLDetailsElement,
  source = group
    .querySelector('.process-steps')
    ?.lastElementChild?.querySelector(':scope > summary'),
): void {
  const summary = group.querySelector(':scope > summary')!;
  if (!source) return;
  summary.className = `${source.className} process-group-summary`;
  summary.replaceChildren(...Array.from(source.childNodes, (child) => child.cloneNode(true)));
  summary.append(node('span', '', 'process-chevron'));
}

function processGroup(key: string): HTMLDetailsElement {
  const group = node('details', '', 'process-group');
  group.dataset.processKey = key;
  group.open = processOpen.get(key) ?? false;
  group.append(node('summary'), node('div', '', 'process-steps'));
  return group;
}

/** Consecutive operations share one fold; actual replies keep their own place in the transcript. */
function transcriptViews(messages: Message[]): HTMLElement[] {
  const sameSession = processSession === state?.session.sessionId;
  processSession = state?.session.sessionId ?? null;
  processOpen = new Map();
  processScroll = new Map();
  if (!sameSession) runningProcessCalls.clear();
  if (sameSession) {
    for (const previous of document.querySelectorAll<HTMLDetailsElement>('[data-process-key]')) {
      processOpen.set(previous.dataset.processKey!, previous.open);
      const steps = previous.querySelector<HTMLElement>(':scope > .process-steps');
      if (steps) processScroll.set(previous.dataset.processKey!, steps.scrollTop);
    }
  }
  processMessageCount = messages.length;
  const views: HTMLElement[] = [];
  let group: HTMLDetailsElement | undefined;
  const add = (step: HTMLElement, key: string) => {
    step.dataset.processKey = key;
    (step as HTMLDetailsElement).open = processOpen.get(key) ?? false;
    if (!group) {
      group = processGroup(`group:${key}`);
      views.push(group);
    }
    group.querySelector('.process-steps')!.append(step);
    updateProcessSummary(group);
  };
  for (const [index, message] of messages.entries()) {
    const view = messageView(message);
    if (message.role === 'tool') add(view, `${index}:result`);
    else if (message.role === 'assistant') {
      const thought = view.querySelector<HTMLElement>(':scope > .message-reasoning');
      if (thought) add(thought, `${index}:reasoning`);
      const calls = Array.from(view.querySelectorAll<HTMLElement>(':scope > .tool-call'));
      for (const call of calls) call.remove();
      if (message.content.trim() || message.interrupted) {
        group = undefined;
        views.push(view);
      }
      for (const [callIndex, call] of calls.entries()) add(call, `${index}:call:${callIndex}`);
    } else {
      group = undefined;
      views.push(view);
    }
  }
  processTail = group;
  return views;
}

function updateRunningProcess(): void {
  const calls = state?.session.tools ?? [];
  const started = calls.filter((call) => !runningProcessCalls.has(call.id));
  runningProcessCalls = new Set(calls.map((call) => call.id));
  for (const call of started) {
    const step = Array.from(document.querySelectorAll<HTMLElement>('#messages .tool-call')).find(
      (item) => item.dataset.callId === call.id,
    );
    const group = step?.closest<HTMLDetailsElement>('.process-group');
    if (group) updateProcessSummary(group, step!.querySelector(':scope > summary'));
  }
}

/** The live thought joins the last interval, without rebuilding or closing a reader's open fold. */
function updateLiveProcess(thought: HTMLElement, visible: boolean): void {
  if (!visible) {
    if (thought.parentElement?.classList.contains('process-steps')) {
      const group = thought.closest<HTMLDetailsElement>('.process-group')!;
      element('live').prepend(thought);
      if (!group.querySelector('.process-steps')!.children.length) {
        group.remove();
        if (processTail === group) processTail = undefined;
      } else updateProcessSummary(group);
    }
    return;
  }
  thought.dataset.processKey = `${processMessageCount}:reasoning`;
  if (!processTail) {
    processTail = processGroup(`group:${thought.dataset.processKey}`);
    element('messages').append(processTail);
  }
  processTail.querySelector('.process-steps')!.append(thought);
  updateProcessSummary(processTail);
}

function messageView(message: Message): HTMLElement {
  if (message.role === 'tool') {
    const details = node('details', '', `tool-result${message.isError ? ' tool-error' : ''}`);
    const card = toolCardModel(message.output);
    const outputKind = card?.kind;
    const label = message.isError
      ? t('ui.operationFailed')
      : outputKind === 'file-read'
        ? t('ui.read')
        : outputKind === 'search-results'
          ? t('ui.search')
          : t(message.isError ? 'ui.operationFailed' : 'ui.toolResult');
    const summary = node('summary', '', `process-summary process-${outputKind ?? 'tool'}`);
    summary.append(
      processIcon(
        message.isError
          ? 'failed'
          : outputKind === 'file-read'
            ? 'read'
            : outputKind === 'search-results'
              ? 'search'
              : 'result',
      ),
      node('span', label, 'process-label'),
      node(
        'span',
        `· ${card?.kind === 'file-read' ? card.path : card?.kind === 'search-results' ? card.query : card?.kind === 'command-output' ? card.command : message.toolCallId}`,
        'process-preview',
      ),
    );
    details.append(summary);
    // A card is drawn *beside* the text, never instead of it: the text is what the model was shown, and a view
    // that replaced it would be a second account of the same result that nobody could check. The payload is
    // validated before anything is drawn, so an unknown or half-written value falls through to the text below.
    if (card) {
      details.append(toolCardView(card));
      const raw = node('details', '', 'tool-result-raw');
      raw.append(node('summary', t('ui.toolCardRaw')), node('pre', message.content));
      details.append(raw);
    } else {
      details.append(node('pre', message.content));
    }
    if (message.images?.length || (message.change && !message.isError))
      mountMessageSlot(details, 'tool.result.extra', message);
    return details;
  }
  const article = node(
    'article',
    '',
    `message ${message.role}${message.role === 'assistant' && !message.content.trim() ? ' process-only' : ''}`,
  );
  const body = message.role === 'user' ? node('div', '', 'user-bubble') : article;
  if (message.role === 'user') article.append(body);
  // The thought comes before the answer, folded: it is what explains the answer, not the answer. Rendering it
  // closed is also what keeps a reopened session's reasoning out of the way until it is asked for.
  if (message.role === 'assistant' && message.reasoning)
    body.append(reasoningView(message.reasoning));
  const content =
    message.role === 'user' ? (message.displayContent ?? message.content) : message.content;
  const display =
    message.role === 'user' ? splitAttachmentPrompt(content) : { prompt: content, files: [] };
  if (display.prompt)
    body.append(
      message.role === 'assistant'
        ? renderMarkdown(content, markdownActions)
        : node('div', display.prompt, 'message-content'),
    );
  for (const file of display.files) {
    const details = node('details', '', 'message-document');
    details.append(node('summary', '▤ ' + file.file), node('pre', file.content));
    body.append(details);
  }
  if (message.role === 'user' && message.images?.length) body.append(imageGallery(message.images));
  if (message.role === 'user') {
    const meta = node('div', '', 'user-message-meta');
    article.append(meta);
    // Both halves of the row are slots: the order between them is the slots' decision now, not this line's.
    mountMessageSlot(meta, 'message.footer', message);
    mountMessageSlot(meta, 'message.actions', message);
  }
  if (message.role === 'assistant' && message.interrupted)
    article.append(node('p', t('ui.interruptedReply'), 'interrupted-reply'));
  if (message.role === 'assistant')
    for (const call of message.toolCalls ?? []) {
      const details = node('details', '', 'tool-call');
      details.dataset.callId = call.id;
      const kind =
        call.name === 'read_file'
          ? 'read'
          : call.name === 'search_files'
            ? 'search'
            : ['edit_file', 'write_file', 'apply_patch'].includes(call.name)
              ? 'edit'
              : ['run_command', 'start_command', 'run_code'].includes(call.name)
                ? 'command'
                : 'tool';
      const label =
        kind === 'read'
          ? t('ui.read')
          : kind === 'search'
            ? t('ui.search')
            : kind === 'edit'
              ? t('ui.edit')
              : t('ui.toolCall');
      const target =
        typeof call.arguments.path === 'string'
          ? call.arguments.path
          : typeof call.arguments.query === 'string'
            ? call.arguments.query
            : typeof call.arguments.command === 'string'
              ? call.arguments.command
              : call.name;
      const summary = node('summary', '', `process-summary process-${kind}`);
      summary.append(
        processIcon(kind),
        node('span', label, 'process-label'),
        node('span', `· ${target}`, 'process-preview'),
      );
      details.append(summary, node('pre', JSON.stringify(call.arguments, null, 2)));
      article.append(details);
    }
  return article;
}
/** The text the live bubble should show: the streamed buffer when it matches, else the snapshot. */
function liveText(): string {
  const live = state?.session.liveMessage;
  if (!live) return '';
  return liveDelta?.id === live.id ? liveDelta.text : live.text;
}
/** The same rule for the folded thought, read from its own buffer. */
function liveReasoning(): string {
  const live = state?.session.liveMessage;
  if (!live) return '';
  return liveDelta?.id === live.id ? liveDelta.reasoning : live.reasoning;
}
/** Reasoning is kept complete; only its one-line preview is shortened. */
function reasoningView(text: string): HTMLElement {
  const details = node('details', '', 'message-reasoning');
  const summary = node('summary', '', 'process-summary process-reasoning');
  summary.append(
    processIcon('reasoning'),
    node('span', t('ui.reasoning'), 'process-label'),
    node('span', text.replace(/\s+/g, ' ').slice(0, 240), 'process-preview'),
  );
  details.append(summary, node('pre', text, 'reasoning-content'));
  return details;
}
/** Markdown rendering is far too expensive to run per token, so paints stay coalesced at 100ms. */
function livePlaceholder(): string {
  const phase = state?.session.statisticsActivity?.phase;
  return phase === 'reasoning'
    ? t('ui.modelReasoning')
    : phase === 'tool_call'
      ? t('ui.modelToolCall')
      : t('ui.thinking');
}
function scheduleLivePaint(): void {
  if (liveTimer) return;
  liveTimer = setTimeout(() => {
    liveTimer = undefined;
    const nearBottom =
      conversation.scrollHeight - conversation.scrollTop - conversation.clientHeight < 90;
    // The folded thought is painted in place rather than replaced: it is a `<details>` the user may have
    // expanded, and swapping the node would close it under them on every paint.
    const thought = element('live-reasoning');
    const reasoning = liveReasoning();
    thought.hidden = !reasoning;
    if (reasoning) thought.replaceChildren(...Array.from(reasoningView(reasoning).childNodes));
    updateLiveProcess(thought, Boolean(reasoning));
    const full = liveText();
    element('live').hidden = !state?.session.liveMessage || !full;
    const target = element('live').querySelector('.message-content');
    if (target && state?.session.liveMessage) {
      const preview =
        full.length > 120_000
          ? `${format(t('ui.liveTail'), { count: full.length })}\n\n${full.slice(-120_000)}`
          : full || livePlaceholder();
      target.replaceWith(renderMarkdown(preview, markdownActions));
    } else target?.replaceWith(node('div', '', 'message-content'));
    if (nearBottom && !childPageOpen()) conversation.scrollTop = conversation.scrollHeight;
    updateJumpButton();
  }, 100);
}
/**
 * The plan panel and its approval gate.
 *
 * Approve is the only path to execution, and it sends back the plan's digest: the host re-checks that
 * digest when execution starts, so a plan edited between the two steps cannot run unreviewed.
 */
function renderPlan(plan: Plan | null): void {
  const panel = element('plan-panel');
  panel.hidden = !plan;
  if (!plan) return;
  const key = JSON.stringify([
    plan.id,
    plan.status,
    plan.hash,
    plan.title,
    plan.steps,
    plan.reason ?? '',
    operation,
    // The locale is part of the key: without it a language change left the panel in the old language,
    // because the guard treated an unchanged plan as an unchanged panel.
    locale(),
  ]);
  if (key === planKey) return;
  planKey = key;
  element('plan-title').textContent = plan.title || t('plan.title');
  element('plan-status').textContent = t(`plan.status.${plan.status}`);
  element('plan-summary').textContent = plan.summary;
  element('plan-summary').hidden = !plan.summary;
  element('plan-steps').replaceChildren(...plan.steps.map((step) => node('li', step.description)));
  const reason = element('plan-reason');
  reason.textContent = plan.reason ?? '';
  reason.hidden = !plan.reason;
  const actions = element('plan-actions');
  actions.replaceChildren();
  const busy = Boolean(state?.session.running || operation);
  if (plan.status === 'proposed') {
    const approve = node('button', t('plan.approve'), 'plan-approve');
    approve.disabled = busy;
    approve.addEventListener(
      'click',
      () => void select({ type: 'planApprove', planId: plan.id, hash: plan.hash }),
    );
    const reject = node('button', t('plan.reject'), 'plan-reject');
    reject.disabled = busy;
    reject.addEventListener('click', () => void select({ type: 'planReject', planId: plan.id }));
    actions.append(approve, reject, node('span', t('plan.gateHint'), 'plan-hint'));
  } else if (plan.status === 'approved') {
    const execute = node('button', t('plan.execute'), 'plan-execute');
    execute.disabled = busy;
    execute.addEventListener('click', () => void select({ type: 'planExecute', planId: plan.id }));
    actions.append(execute, node('span', t('plan.approvedHint'), 'plan-hint'));
  } else if (plan.status === 'rejected') {
    actions.append(node('span', t('plan.rejectedHint'), 'plan-hint'));
  } else if (plan.status === 'abandoned') {
    // The run that was filling this plan is gone, so nothing is in progress: saying "planning" here was the one
    // reading a person could not act on, because there is no plan to wait for and no run to stop.
    actions.append(node('span', t('plan.abandonedHint'), 'plan-hint'));
  } else {
    /**
     * A plan still being written keeps the session in plan mode, so it needs the one action that leaves it.
     *
     * The host continues planning for a session whose newest plan is `planning` — that is what the row means, and
     * it is the same rule the CLI's `resume` follows — so a person who changed their mind would otherwise be
     * pinned to a read-only session with nothing to click. Discarding is a rejection with a different label: the
     * row never carried a body to approve, so there is nothing to keep.
     */
    const discard = node('button', t('plan.discard'), 'plan-discard');
    discard.disabled = busy;
    discard.addEventListener('click', () => void select({ type: 'planReject', planId: plan.id }));
    actions.append(discard, node('span', t('plan.discardHint'), 'plan-hint'));
  }
}
function render(): void {
  if (!state) return;
  const session = state.session;
  // Every panel in a slot renders here, in the order the slot decides — the built-ins included. Nothing below
  // this line calls a panel directly; adding one is a `register`, not an edit to this function.
  const slotContext: PanelSlotContext = { session, workspace: state.workspace };
  for (const mount of slotMounts) mount.render(slotContext);
  const blocked = !state.ready || session.running || session.loading || operation || sending;
  const nearBottom =
    conversation.scrollHeight - conversation.scrollTop - conversation.clientHeight < 90;
  element('workspace').textContent = state.workspace;
  element('workspace').title = state.workspace;
  const title =
    state.sessions.find((item) => item.id === session.sessionId)?.title || t('ui.newSession');
  element('chat-title').textContent = title;
  element('chat-title').title = title;
  element<HTMLTextAreaElement>('prompt').placeholder = t('ui.promptPlaceholder');
  element('background-label').textContent = t('background.title');
  element('background-popover').setAttribute('aria-label', t('background.title'));
  renderBackground();

  renderTasks();
  modelSettings?.updateBusy();
  mcpSettings?.updateBusy();
  permissionSettings?.updateBusy();
  element('configuration').hidden = !state.ready || state.configured;
  const stopError = localError || state.error || session.error;
  /**
   * A run the user stopped is not an error, and the kernel's marker for it is not shown as one.
   *
   * `agent.ts` sets `error = 'Run cancelled'` when the signal aborted, which the banner drew as a failure in
   * English across the top of a Chinese interface. What happened is that somebody pressed 停止: the conversation
   * says so at its end (`renderPaused`), and a red band is the wrong shape for a thing the user did on purpose.
   */
  const error = stopError === RUN_CANCELLED ? '' : stopError;
  element('error').hidden = !error;
  element('error').textContent = error || '';
  // A recovery is reported, not hidden: the window came back by itself, and the reason the reply the user was
  // waiting for never arrived is exactly what they need to be told.
  const notice = state.recovery
    ? format(t('ui.hostRecovered'), {
        attempts: state.recovery.attempts,
        // A pid that could not be read is shown as a dash rather than as 0, which is a real process id.
        pid: state.recovery.pid ?? '—',
      })
    : '';
  element('notice').hidden = !notice;
  element('notice').textContent = notice;
  sessionManagement.render(state, blocked);
  element<HTMLButtonElement>('new-session').disabled = blocked;
  element<HTMLButtonElement>('choose-workspace').disabled = blocked;
  const composerBlocked =
    !state.ready ||
    !state.configured ||
    session.loading ||
    operation ||
    stopping ||
    queueBusy ||
    imageBusy ||
    (sending && !session.running);
  prompt.disabled = composerBlocked;
  for (const button of element('attachments').querySelectorAll<HTMLButtonElement>('button'))
    button.disabled = imageBusy;
  renderPalette();
  sendButton.disabled = session.running
    ? stopping
    : composerBlocked ||
      (!prompt.value.trim() && !attachments.length && !documentAttachments.length);
  sendButton.dataset.mode = session.running ? 'stop' : 'send';
  const sendLabel = session.running ? (stopping ? t('ui.stopping') : t('ui.stop')) : t('ui.send');
  sendButton.setAttribute('aria-label', sendLabel);
  sendButton.title = sendLabel;
  element<HTMLButtonElement>('attach-image').disabled = composerBlocked;
  element('attach-image').title = t('ui.addAttachment');
  element('attach-image').setAttribute('aria-label', t('ui.addAttachment'));
  /**
   * There is no enqueue-mode control any more: a message typed while the run is live is queued for after the
   * turn, always. The select that chose between that and steering the live run was one more thing in the
   * composer during exactly the moments the composer is not what you are looking at (a question is up, an
   * approval is waiting), and the queue below still says what will happen.
   */
  element('queue').textContent = session.queue
    .map((item) =>
      format(t('ui.queueItem'), {
        mode: item.mode === 'steer' ? t('ui.steerTask') : t('ui.followUp'),
        prompt: item.prompt.slice(0, 100),
      }),
    )
    .join('\n');
  element('clear-queue').hidden = !session.queue.length;
  element<HTMLButtonElement>('clear-queue').disabled = queueBusy;
  const labels = {
    idle: '准备就绪',
    running: '正在处理',
    completed: '本轮已结束',
    needs_review: '验收未通过，需检查',
    cancelled: '已停止',
    limited: '已达到运行限制',
    failed: '运行失败',
  };
  element('run-status').textContent = session.compacting
    ? '正在整理上下文…'
    : session.approvals.length
      ? '等待你的确认'
      : !state.ready
        ? '连接未就绪'
        : session.loading
          ? '正在加载会话…'
          : labels[session.status];
  if (session.running && !session.compacting && !session.approvals.length) {
    const phase = session.statisticsActivity?.phase;
    if (phase === 'reasoning') element('run-status').textContent = t('ui.modelReasoning');
    if (phase === 'tool_call') element('run-status').textContent = t('ui.modelToolCall');
  }
  element('session-short').textContent = session.sessionId
    ? t('ui.sessionShort', { id: session.sessionId.slice(0, 8) })
    : '';
  element('welcome').hidden = Boolean(session.messages.length || session.running);
  // locale() belongs in the key: these rows carry a formatted date and a
  // translated aria-label, so a language switch has to rebuild them.
  const nextSessionKey = JSON.stringify([state.sessions, session.sessionId, blocked, locale()]);
  if (nextSessionKey !== sessionKey) {
    sessionKey = nextSessionKey;
    element('session-count').textContent = String(state.sessions.length);
    element('sessions').replaceChildren(
      ...state.sessions.map((item) => {
        const button = node(
          'button',
          '',
          `session-item${item.id === session.sessionId ? ' selected' : ''}`,
        );
        button.dataset.sessionId = item.id;
        button.disabled = blocked;
        button.title = item.id;
        button.append(
          node('strong', item.title || `会话 ${item.id.slice(0, 8)}`),
          node(
            'small',
            new Date(item.createdAt).toLocaleString(locale(), {
              month: 'short',
              day: 'numeric',
              hour: '2-digit',
              minute: '2-digit',
            }),
          ),
        );
        button.setAttribute('aria-current', item.id === session.sessionId ? 'true' : 'false');
        button.addEventListener('click', () => void select({ type: 'load', id: item.id }));
        const row = node('div', '', 'session-row');
        row.append(button, sessionManagement.createMenuButton(item, blocked));
        return row;
      }),
    );
  }
  // Message timestamps are locale-formatted, so they follow the language too.
  const paused = session.error === RUN_CANCELLED;
  const nextTranscriptKey = `${session.sessionId}:${session.messageRevision}:${locale()}:${paused}`;
  if (nextTranscriptKey !== transcriptKey) {
    transcriptKey = nextTranscriptKey;
    scheduleLivePaint();
    /**
     * The transcript is the conversation, and a runtime snapshot is not part of it: it is bookkeeping the *model*
     * needs (a memory or workspace outline it must be told about when it changes), wrapped in a tag that says so.
     * Drawn as an ordinary user message it reads as though somebody said it, and it buries the two things a
     * person scrolls for. The message stays in the session — the model still receives it, the log still holds it,
     * and `export` still writes it — the window simply does not draw it.
     */
    element('live').prepend(element('live-reasoning'));
    element('messages').replaceChildren(
      ...transcriptViews(
        session.messages.filter(
          (message) => !(message.role === 'user' && isRuntimeContext(message.content)),
        ),
      ),
      /**
       * Where the run stopped, not at the top of the window: a stop is the end of what happened, so it belongs
       * after the last thing that happened. `renderPaused` is the only place this sentence is written.
       */
      ...(paused ? [node('p', t('ui.runPaused'), 'run-paused')] : []),
    );
    for (const group of document.querySelectorAll<HTMLElement>('#messages > .process-group')) {
      const steps = group.querySelector<HTMLElement>('.process-steps');
      if (steps) steps.scrollTop = processScroll.get(group.dataset.processKey!) ?? 0;
    }
  }
  const nextChangesKey = JSON.stringify([
    state.changes,
    session.messages.length,
    blocked,
    locale(),
  ]);
  if (nextChangesKey !== changesKey) {
    changesKey = nextChangesKey;
    const changes = state.changes;
    const legacy = session.messages.filter(
      (m): m is Message & { role: 'tool' } =>
        m.role === 'tool' && !m.isError && Boolean(m.change) && !m.change?.id,
    );
    element('changes').hidden = !changes.length && !legacy.length;
    element('changes-count').textContent = format(t('ui.sessionChanges'), {
      count: changes.length + legacy.length,
    });
    element('changes-list').replaceChildren(
      ...changes.map((item) => {
        const panel = diffView(item.change);
        // A sub-agent's write is journaled against this session, so without the badge it would read as
        // the parent's own step; the objective is bounded because it is model-written text.
        if (item.change.subagent)
          panel.prepend(
            node(
              'p',
              format(t('subagent.attribution'), {
                objective: item.change.subagent.objective.slice(0, 120),
              }),
              'subagent-badge',
            ),
          );
        // The affordance comes from fileChangeAction so the "an interrupted undo can still be
        // resumed" rule lives in one tested place instead of in this render function.
        const action = fileChangeAction(item.status);
        panel.append(node('p', t(action.noticeKey), 'diff-notice'));
        if (action.kind !== 'none') {
          const undo = node('button', t(action.actionKey), 'undo-change');
          undo.disabled = blocked;
          undo.addEventListener('click', () => {
            const confirm = node('button', t(undoConfirmKey(item.change.kind)), 'confirm-undo');
            const cancel = node('button', '取消');
            confirm.disabled = Boolean(state?.session.running || operation);
            confirm.addEventListener('click', () => void select({ type: 'undo', id: item.id }));
            cancel.addEventListener('click', () => {
              confirm.remove();
              cancel.remove();
              undo.hidden = false;
            });
            undo.hidden = true;
            panel.append(confirm, cancel);
          });
          panel.append(undo);
        }
        return panel;
      }),
      ...legacy.map((m) => {
        const panel = diffView(m.change!);
        panel.append(node('p', '这条记录没有本会话的恢复快照，仅可查看差异。', 'diff-notice'));
        return panel;
      }),
    );
  }
  const live = session.liveMessage;
  element('live').hidden = !live || !liveText();
  // Drop the buffer once the run stops (or a reload replaced the message) so stale text can never
  // reappear under a new message id.
  if (!live) {
    liveDelta = null;
    const target = element('live').querySelector<HTMLElement>('.message-content')!;
    if (target.childNodes.length || target.className !== 'message-content')
      target.replaceWith(node('div', '', 'message-content'));
  } else if (liveDelta && liveDelta.id !== live.id) liveDelta = null;
  const nextLive = live?.id ?? '';
  if (nextLive !== liveKey) {
    liveKey = nextLive;
    scheduleLivePaint();
  }
  renderPlan(session.plan);
  subagentView.update(session.subagents);
  updateRunningProcess();
  element('tools').hidden = true;
  const nextApprovalKey = JSON.stringify([session.approvals, [...approvalBusy], locale()]);
  if (nextApprovalKey !== approvalKey) {
    approvalKey = nextApprovalKey;
    element('approvals').replaceChildren(
      ...session.approvals.map((item) => {
        const panel = node('section', '', 'approval');
        panel.append(
          node('div', '需要你的确认', 'approval-label'),
          node(
            'h2',
            item.approval.kind === 'external'
              ? '访问外部服务'
              : item.approval.kind === 'command'
                ? '执行命令'
                : '修改文件',
          ),
        );
        if (item.approval.subagent)
          panel.append(
            node(
              'p',
              format(t('subagent.attribution'), {
                objective: item.approval.subagent.objective.slice(0, 120),
              }),
              'subagent-badge',
            ),
          );
        if (item.approval.change) panel.append(diffView(item.approval.change, true));
        const raw = node('details', '', 'approval-raw');
        raw.open = !item.approval.change;
        raw.append(
          node('summary', '完整操作参数'),
          node('p', item.approval.description),
          node('pre', JSON.stringify(item.approval.toolCall.arguments, null, 2)),
        );
        panel.append(raw);
        const actions = node('div', '', 'approval-actions');
        for (const allow of [false, true]) {
          const button = node(
            'button',
            allow ? '允许一次' : '拒绝',
            allow ? 'primary' : 'secondary',
          );
          button.disabled = approvalBusy.has(item.id);
          button.addEventListener('click', () => {
            approvalBusy.add(item.id);
            localError = null;
            render();
            void invoke({ type: 'approve', id: item.id, allow }).finally(() => {
              approvalBusy.delete(item.id);
              render();
            });
          });
          actions.append(button);
        }
        panel.append(actions);
        return panel;
      }),
    );
  }
  renderQuestions(session.questions);
  renderTodos(session.todos);
  renderGoal(session.goal);
  renderDeliverables(session.deliverables);
  if (nearBottom && !childPageOpen()) conversation.scrollTop = conversation.scrollHeight;
  updateJumpButton();
}
function updateJumpButton(): void {
  const button = element<HTMLButtonElement>('jump-to-latest');
  button.hidden =
    conversation.scrollHeight - conversation.scrollTop - conversation.clientHeight < 120;
  button.title = t('ui.jumpToLatest');
  button.setAttribute('aria-label', t('ui.jumpToLatest'));
}
/**
 * Whether a sub-agent's record has taken the viewport.
 *
 * The conversation keeps being rendered while a child's page is on screen — the snapshot arrives either way —
 * and its auto-scroll is the one thing that must not run then: following the parent's tail would drag the
 * record the reader is looking at down to the bottom of a conversation they cannot even see.
 */
function childPageOpen(): boolean {
  return document.body.dataset.subagentPage === 'open';
}
/**
 * The checklist panel.
 *
 * The model replaces the whole list on every `todo_write`, so the panel is a pure function of the latest
 * list and a keyed rebuild keeps a streaming run from thrashing the DOM. It is hidden rather than emptied
 * when there is no list: an empty panel would read as "the plan is empty" rather than "there is no plan".
 *
 * A saved list remains available after the turn ends and through later turns until the model replaces or
 * clears it. Switching sessions folds the panel, so each session starts from the requested collapsed state.
 *
 * One item may be in progress at a time by convention and the renderer does not enforce it — the list is the
 * model's statement of what it is doing, and rewriting it to look tidier would hide what it actually said.
 *
 * It shows the list as it stands, and *only* as it stands. A "since the previous version: 3 added" strip used to
 * sit above it, describing the last write instead of the current list; that is a diff, and a diff answers a
 * question nobody asked while the panel is open ("what is the plan now?"), in a place where the answer — the
 * list itself — is right below it. The CLI still prints that summary (`describeTodoChange`), where a scrollback
 * has no list to look at and the change is the only thing a reader can see.
 */
function renderTodos(todos: TodoItem[]): void {
  const sessionId = state?.session.sessionId ?? '';
  if (sessionId !== todoSessionId) {
    element<HTMLDetailsElement>('todos-panel').open = false;
    todoSessionId = sessionId;
  }
  /**
   * The list belongs to the question being answered, not to the session.
   *
   * A plan written while answering one question says nothing about the next one, so the panel shows a list only
   * while it is newer than the last thing the person asked: the position of the newest `todo_write` against the
   * newest user message, both read off the transcript. That is what makes "ask something new and the old list
   * goes away, until the model writes a new one" fall out of the data — and it holds after a reload, where a
   * timer or a baseline remembered in this process would have nothing to go on.
   */
  const messages = state?.session.messages ?? [];
  const newestUser = messages.findLastIndex(
    (message) => message.role === 'user' && !isRuntimeContext(message.content),
  );
  const newestPlan = messages.findLastIndex(
    (message) =>
      message.role === 'assistant' &&
      (message.toolCalls ?? []).some((call) => call.name === 'todo_write'),
  );
  const belongsToThisQuestion = newestPlan > newestUser;
  const nextKey = JSON.stringify([sessionId, todos, belongsToThisQuestion, locale()]);
  if (nextKey === todoKey) return;
  todoKey = nextKey;
  const panel = element('todos-panel');
  panel.hidden = todos.length === 0 || !belongsToThisQuestion;
  const counts = { pending: 0, in_progress: 0, completed: 0 };
  for (const todo of todos) counts[todo.status]++;
  element('todos-title').textContent = t('ui.todosTitle');
  element('todos-summary').textContent = format(t('ui.todosSummary'), {
    completed: counts.completed,
    inProgress: counts.in_progress,
    pending: counts.pending,
  });
  element('todos').replaceChildren(
    ...todos.map((todo) => {
      const item = node('li', '', `todo todo-${todo.status.replace('_', '-')}`);
      item.append(
        node(
          'span',
          todo.status === 'completed' ? '✓' : todo.status === 'in_progress' ? '◌' : '◌',
          'todo-mark',
        ),
        node('span', todo.content, 'todo-content'),
      );
      return item;
    }),
    node(
      'li',
      format(t('ui.todosCount'), {
        total: todos.length,
        completed: counts.completed,
        inProgress: counts.in_progress,
        pending: counts.pending,
      }),
      'todo-count',
    ),
  );
}
/**
 * The session goal, when a run declared one.
 *
 * A goal is the one piece of session state that answers "what is all of this for", so it is rendered above the
 * checklist rather than inside it: the goal outlives the run, the checklist belongs to it. It is a banner and
 * not a control — pausing or completing a goal is a tool call the model makes, and a button here would be a
 * second way to change a thing this window does not own. The status is shown because it is the reason the next
 * turn may not continue: a blocked or completed goal is a statement, not a spinner.
 */
function renderGoal(goal: Goal | null): void {
  const nextKey = JSON.stringify([goal, locale()]);
  if (nextKey === goalKey) return;
  goalKey = nextKey;
  const panel = element('goal-panel');
  panel.hidden = goal === null;
  if (!goal) return;
  element('goal-title').textContent = t('ui.goalTitle');
  const status = element('goal-status');
  status.textContent = t(`ui.goalStatus.${goal.status}`);
  status.className = `goal-status goal-${goal.status}`;
  element('goal-objective').textContent = goal.objective;
  const meta = [
    format(t('ui.goalRounds'), {
      spent: Math.min(goal.roundsStarted, goal.maxGoalRounds),
      max: goal.maxGoalRounds,
    }),
    goal.blockedReason ? format(t('ui.goalBlockedReason'), { reason: goal.blockedReason }) : '',
    t('ui.goalNotice'),
  ].filter(Boolean);
  element('goal-meta').textContent = meta.join(' · ');
}
/**
 * The files a run marked as its deliverables.
 *
 * A presentation record: each line is what `present` named and the reason it gave. Absent entirely when nothing
 * has been presented, because an empty panel would read as "the run produced nothing" rather than "no run has
 * said what it produced yet".
 */
function renderDeliverables(files: PresentedFile[]): void {
  const nextKey = JSON.stringify([files, locale()]);
  if (nextKey === deliverablesKey) return;
  deliverablesKey = nextKey;
  const panel = element('deliverables-panel');
  panel.hidden = files.length === 0;
  if (!files.length) return;
  element('deliverables-title').textContent = t('ui.deliverablesTitle');
  element('deliverables').replaceChildren(
    ...files.map((file) => {
      const item = node('li', '', 'deliverable');
      item.append(node('span', file.path, 'deliverable-path'));
      if (file.description)
        item.append(
          document.createTextNode(' — '),
          node('span', file.description, 'deliverable-description'),
        );
      // The size and the digest are what make an entry a claim about a *revision* rather than about a path, so
      // they are one hover away instead of turning the panel into a hash listing.
      item.title = `${file.bytes} B · sha256 ${file.sha256.slice(0, 12)}… · ${file.at}`;
      return item;
    }),
  );
}
/**
 * The question panel: one card per pending request, one question at a time inside it.
 *
 * An approval's answer is a boolean; a question's is a shape — options, possibly several of them, plus optional
 * free text. What the user has chosen therefore lives outside the render (`questionAnswers`, `questionPages`,
 * `questionCollapsed`) rather than in this closure: progress events arrive constantly during a run, and with a
 * pager a re-render is a normal event, not an edge case — losing a selection because the run reported progress
 * would be the panel lying about what it will submit.
 */
const questionAnswers = new Map<
  string,
  { selected: Map<string, string[]>; text: Map<string, string> }
>();
const questionPages = new Map<string, number>();
const questionCollapsed = new Set<string>();
function questionState(id: string): { selected: Map<string, string[]>; text: Map<string, string> } {
  const existing = questionAnswers.get(id);
  if (existing) return existing;
  const created = { selected: new Map<string, string[]>(), text: new Map<string, string>() };
  questionAnswers.set(id, created);
  return created;
}
function renderQuestions(questions: PendingQuestion[]): void {
  /**
   * Progress state belongs to a request that is still pending: a request that has been answered keeps its page
   * and selections in these maps otherwise, and the next question would open on the previous one's page.
   */
  const pending = new Set(questions.map((item) => item.id));
  for (const id of [...questionAnswers.keys()]) if (!pending.has(id)) questionAnswers.delete(id);
  for (const id of [...questionPages.keys()]) if (!pending.has(id)) questionPages.delete(id);
  for (const id of [...questionCollapsed]) if (!pending.has(id)) questionCollapsed.delete(id);
  // The pending ids are part of the key so state for a finished request is dropped rather than remembered.
  const nextKey = JSON.stringify([
    questions,
    [...questionBusy],
    locale(),
    [...questionPages],
    [...questionCollapsed],
    [...questionAnswers].map(([id, state]) => [id, [...state.selected], [...state.text]]),
  ]);
  if (nextKey === questionKey) return;
  questionKey = nextKey;
  element('questions').replaceChildren(
    ...questions.map((item) => {
      const state = questionState(item.id);
      const total = item.request.questions.length;
      const page = Math.min(questionPages.get(item.id) ?? 0, total - 1);
      const question = item.request.questions[page]!;
      const collapsed = questionCollapsed.has(item.id);
      const card = node('section', '', 'question-card');
      const head = node('div', '', 'question-head');
      const headings = node('div', '', 'question-headings');
      headings.append(
        node('span', question.header || t('ui.questionLabel'), 'question-eyebrow'),
        node('h2', question.question, 'question-title'),
      );
      const chrome = node('div', '', 'question-chrome');
      const collapse = node('button', collapsed ? '⌄' : '⌃', 'question-collapse');
      collapse.type = 'button';
      collapse.setAttribute('aria-expanded', String(!collapsed));
      collapse.setAttribute('aria-label', t('ui.questionCollapse'));
      collapse.addEventListener('click', () => {
        if (collapsed) questionCollapsed.delete(item.id);
        else questionCollapsed.add(item.id);
        render();
      });
      const close = node('button', '✕', 'question-close');
      close.type = 'button';
      close.setAttribute('aria-label', t('ui.questionClose'));
      close.addEventListener('click', () => cancelQuestion(item.id));
      chrome.append(collapse, close);
      head.append(headings, chrome);
      card.append(head);
      const body = node('div', '', 'question-body');
      body.hidden = collapsed;
      if (item.request.subagent)
        headings.append(
          node(
            'p',
            format(t('subagent.attribution'), {
              objective: item.request.subagent.objective.slice(0, 120),
            }),
            'subagent-badge',
          ),
        );
      const options = question.options ?? [];
      /**
       * The choices as numbered rows with their own descriptions, rather than one button whose text is
       * "label — description": the number is what the answer is *about* when there are three of them, and the
       * description belongs under the label it explains. `recommended` is drawn as a badge and nothing else — it
       * is the asker's opinion, not a default that answers the question for the user.
       */
      if (options.length) {
        const list = node('ol', '', 'question-options');
        options.forEach((option, index) => {
          const selected = (state.selected.get(question.id) ?? []).includes(option.label);
          const button = node('button', '', 'question-option');
          button.type = 'button';
          button.setAttribute('aria-pressed', String(selected));
          if (selected) button.classList.add('selected');
          const text = node('span', '', 'question-option-text');
          const label = node('span', '', 'question-option-head');
          label.append(node('span', option.label, 'question-option-label'));
          if (option.recommended)
            label.append(node('span', t('ui.questionRecommended'), 'question-recommended'));
          text.append(label);
          if (option.description)
            text.append(node('span', option.description, 'question-option-description'));
          button.append(node('span', String(index + 1), 'question-index'), text);
          button.addEventListener('click', () => {
            const current = state.selected.get(question.id) ?? [];
            const chosen = current.includes(option.label);
            state.selected.set(
              question.id,
              question.multiSelect
                ? chosen
                  ? current.filter((entry) => entry !== option.label)
                  : [...current, option.label]
                : chosen
                  ? []
                  : [option.label],
            );
            render();
          });
          const row = node('li', '', 'question-option-row');
          row.append(button);
          list.append(row);
        });
        body.append(list);
      }
      if (!options.length || question.allowFreeText !== false) {
        const free = node('label', '', 'question-free');
        free.append(node('span', '✎', 'question-free-icon'));
        const input = node('input', '', 'question-input');
        input.type = 'text';
        input.placeholder = t('ui.questionFreeText');
        input.value = state.text.get(question.id) ?? '';
        /**
         * Typing does not re-render: the value is kept where the submit reads it, so the input keeps focus and
         * the caret stays where the user left it.
         */
        input.addEventListener('input', () => state.text.set(question.id, input.value));
        free.append(input);
        body.append(free);
      }
      card.append(body);
      const actions = node('div', '', 'question-actions');
      const pager = node('div', '', 'question-pager');
      const previous = node('button', '‹', 'question-prev');
      previous.type = 'button';
      previous.setAttribute('aria-label', t('ui.questionPrevious'));
      previous.disabled = page === 0;
      previous.addEventListener('click', () => {
        questionPages.set(item.id, page - 1);
        render();
      });
      const next = node('button', '›', 'question-next');
      next.type = 'button';
      next.setAttribute('aria-label', t('ui.questionNext'));
      next.disabled = page >= total - 1;
      next.addEventListener('click', () => {
        questionPages.set(item.id, page + 1);
        render();
      });
      pager.append(previous, node('span', `${page + 1}/${total}`, 'question-count'), next);
      const skip = node('button', t('ui.questionSkip'), 'secondary question-skip');
      skip.type = 'button';
      skip.disabled = questionBusy.has(item.id);
      skip.addEventListener('click', () => cancelQuestion(item.id));
      const submit = node('button', t('ui.questionSubmit'), 'primary question-submit');
      submit.type = 'button';
      submit.disabled = questionBusy.has(item.id);
      submit.addEventListener('click', () => {
        const answers = item.request.questions.map((entry) => {
          const typed = state.text.get(entry.id)?.trim();
          return {
            id: entry.id,
            selected: state.selected.get(entry.id) ?? [],
            ...(typed ? { freeText: typed } : {}),
          };
        });
        questionBusy.add(item.id);
        localError = null;
        render();
        void invoke({ type: 'questionAnswer', id: item.id, answers }).finally(() => {
          questionBusy.delete(item.id);
          render();
        });
      });
      actions.append(pager, skip, submit);
      card.append(actions);
      return card;
    }),
  );
}
/**
 * Ending a question without an answer: the model is told nobody answered and proceeds on its own assumption.
 *
 * Both the × in the corner and 跳过本题 do this, because they are the same act — the request is what the run is
 * waiting on, so there is no such thing as answering "some of it" by leaving.
 */
function cancelQuestion(id: string): void {
  questionBusy.add(id);
  localError = null;
  render();
  void invoke({ type: 'questionAnswer', id, cancelled: true }).finally(() => {
    questionBusy.delete(id);
    render();
  });
}
const sessionManagement = setupSessionManagement({ select });
element('composer').addEventListener('submit', (event) => {
  event.preventDefault();
  if (
    prompt.disabled ||
    (!prompt.value.trim() && !attachments.length && !documentAttachments.length)
  )
    return;
  const text = prompt.value.trim();
  const slash = text.match(/^\/(compact|export|goal|plan)(?:\s+([\s\S]*))?$/i);
  if (slash && !attachments.length && !documentAttachments.length) {
    const name = slash[1]!.toLowerCase();
    const argument = slash[2]?.trim() || '';
    if ((name === 'goal' || name === 'plan') && !argument) {
      localError = `/${name} 需要描述内容。`;
      render();
      return;
    }
    prompt.value = '';
    menuDismissed = true;
    localError = null;
    sending = true;
    render();
    const command: CarrierCommand =
      name === 'compact'
        ? { type: 'compact' }
        : name === 'export'
          ? { type: 'export', content: exportConversation(), suggestedName: 'yuantu-session.md' }
          : name === 'goal'
            ? { type: 'goal', prompt: argument }
            : { type: 'plan', prompt: argument };
    void invoke(command).finally(() => {
      sending = false;
      render();
      prompt.focus();
    });
    return;
  }
  const textToSend = prompt.value;
  const files = documentAttachments;
  let outgoingText: string;
  try {
    outgoingText = attachmentPrompt(textToSend, files);
  } catch (error) {
    localError = error instanceof Error ? error.message : String(error);
    render();
    return;
  }
  const images = attachments;
  prompt.value = '';
  attachments = [];
  documentAttachments = [];
  renderAttachments();
  localError = null;
  const queuing = Boolean(state?.session.running);
  if (queuing) queueBusy = true;
  else sending = true;
  render();
  const command: CarrierCommand = queuing
    ? { type: 'enqueue', prompt: outgoingText, images, mode: 'follow-up' }
    : { type: 'send', prompt: outgoingText, images };
  void invoke(command)
    .then((ok) => {
      if (!ok && !prompt.value) {
        prompt.value = textToSend;
        attachments = images;
        documentAttachments = files;
        renderAttachments();
      }
    })
    .finally(() => {
      if (queuing) queueBusy = false;
      else sending = false;
      render();
      prompt.focus();
    });
});
const addAttachmentFiles = (files: File[]) => {
  if (!files.length || imageBusy || prompt.disabled) return;
  imageBusy = true;
  localError = null;
  const sessionId = state?.session.sessionId;
  const workspace = state?.workspace;
  render();
  void (async () => {
    if (files.length + attachments.length + documentAttachments.length > 8)
      throw new Error('每条消息最多附加 8 个文件（其中图片最多 4 张）');
    const nextImages = [...attachments];
    const nextDocuments = [...documentAttachments];
    for (const file of files) {
      try {
        const extension = file.name.split('.').pop()?.toLowerCase();
        const imageTypes: Record<string, ImageAttachment['mimeType']> = {
          png: 'image/png',
          jpg: 'image/jpeg',
          jpeg: 'image/jpeg',
          gif: 'image/gif',
          webp: 'image/webp',
        };
        const mimeType =
          imageTypes[extension || ''] || (file.type.startsWith('image/') ? file.type : undefined);
        if (mimeType) {
          if (!state?.supportsVision)
            throw new Error('当前模型未启用图片输入，请切换支持图片的模型');
          if (file.size > MAX_IMAGE_BYTES) throw new Error('单张图片不能超过 5MB');
          const data = await new Promise<string>((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
            reader.onerror = () => reject(new Error('图片读取失败'));
            reader.readAsDataURL(file);
          });
          nextImages.push({
            mimeType: mimeType as ImageAttachment['mimeType'],
            data,
            name: file.name || 'pasted-image.png',
          });
          validateImages(nextImages);
        } else {
          if (file.size > MAX_DOCUMENT_BYTES) throw new Error('单个文件不能超过 20MB');
          const reply = await window.yuantu.readAttachment({
            name: file.name,
            data: new Uint8Array(await file.arrayBuffer()),
          });
          if (!reply.ok) throw new Error(reply.error);
          nextDocuments.push(reply.file);
          attachmentPrompt(prompt.value, nextDocuments);
        }
      } catch (error) {
        throw new Error(
          file.name + '：' + (error instanceof Error ? error.message : String(error)),
        );
      }
    }
    if (sessionId !== state?.session.sessionId || workspace !== state?.workspace) return;
    attachments = validateImages(nextImages);
    documentAttachments = nextDocuments;
    renderAttachments();
  })()
    .catch((error) => {
      localError = error instanceof Error ? error.message : String(error);
    })
    .finally(() => {
      imageBusy = false;
      render();
    });
};
element('attach-image').addEventListener('click', () =>
  element<HTMLInputElement>('image-input').click(),
);
element('image-input').addEventListener('change', () => {
  const input = element<HTMLInputElement>('image-input');
  const files = Array.from(input.files ?? []);
  input.value = '';
  addAttachmentFiles(files);
});
prompt.addEventListener('paste', (event) => {
  const files = Array.from(event.clipboardData?.files ?? []);
  if (files.length) {
    event.preventDefault();
    addAttachmentFiles(files);
  }
});
element('composer').addEventListener('dragover', (event) => {
  if ((event as DragEvent).dataTransfer?.types.includes('Files')) event.preventDefault();
});
element('composer').addEventListener('drop', (event) => {
  const files = Array.from((event as DragEvent).dataTransfer?.files ?? []);
  if (files.length) {
    event.preventDefault();
    addAttachmentFiles(files);
  }
});
element('refresh-tasks').addEventListener('click', () => void invoke({ type: 'taskRefresh' }));
element('clear-queue').addEventListener('click', () => {
  queueBusy = true;
  render();
  void invoke({ type: 'clearQueue' }).finally(() => {
    queueBusy = false;
    render();
  });
});
prompt.addEventListener('input', () => {
  selectedCommand = 0;
  menuDismissed = false;
  renderPalette();
  render();
});
prompt.addEventListener('keydown', (event) => {
  const menu = element('command-menu');
  const options = menu.querySelectorAll<HTMLButtonElement>('button');
  if (!menu.hidden && options.length && ['ArrowDown', 'ArrowUp'].includes(event.key)) {
    event.preventDefault();
    selectedCommand =
      event.key === 'ArrowUp'
        ? (selectedCommand - 1 + options.length) % options.length
        : (selectedCommand + 1) % options.length;
    renderPalette();
    return;
  }
  if (!menu.hidden && options.length && event.key === 'Enter' && !event.isComposing) {
    event.preventDefault();
    const items = paletteItems();
    const selected = items[selectedCommand];
    if (selected) choosePaletteItem(selected);
    return;
  }
  if (!menu.hidden && event.key === 'Escape') {
    event.preventDefault();
    menuDismissed = true;
    menu.hidden = true;
    return;
  }
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    element<HTMLFormElement>('composer').requestSubmit();
  }
});
element('new-session').addEventListener('click', () => void select({ type: 'create' }));
element('choose-workspace').addEventListener(
  'click',
  () => void select({ type: 'chooseWorkspace' }),
);
sendButton.addEventListener('click', (event) => {
  if (!state?.session.running) return;
  event.preventDefault();
  if (stopping) return;
  stopping = true;
  render();
  void invoke({ type: 'cancel' }).finally(() => {
    stopping = false;
    render();
  });
});
for (const button of document.querySelectorAll<HTMLButtonElement>('[data-prompt]')) {
  button.addEventListener('click', () => {
    if (!prompt.disabled) {
      prompt.value = button.dataset.prompt!;
      render();
      prompt.focus();
    }
  });
}
const backgroundAnchor = document.querySelector<HTMLElement>('.background-anchor')!;
let backgroundCloseTimer: ReturnType<typeof setTimeout> | undefined;
function openBackgroundList(): void {
  if (element<HTMLButtonElement>('open-background').hidden) return;
  clearTimeout(backgroundCloseTimer);
  const backgroundPopover = element<HTMLElement>('background-popover');
  backgroundPopover.hidden = false;
  element('open-background').setAttribute('aria-expanded', 'true');
}
function closeBackgroundList(): void {
  clearTimeout(backgroundCloseTimer);
  element('background-popover').hidden = true;
  element('open-background').setAttribute('aria-expanded', 'false');
}
backgroundAnchor.addEventListener('pointerenter', openBackgroundList);
element('background-popover').addEventListener('pointerenter', () =>
  clearTimeout(backgroundCloseTimer),
);
backgroundAnchor.addEventListener('pointerleave', () => {
  clearTimeout(backgroundCloseTimer);
  backgroundCloseTimer = setTimeout(closeBackgroundList, 180);
});
element('open-background').addEventListener('click', openBackgroundList);
document.addEventListener('pointerdown', (event) => {
  const backgroundPopover = element<HTMLElement>('background-popover');
  if (
    !backgroundPopover.contains(event.target as Node) &&
    !element('open-background').contains(event.target as Node)
  ) {
    closeBackgroundList();
  }
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !element('background-popover').hidden) {
    closeBackgroundList();
    element('open-background').focus();
  }
});
window.addEventListener('yuantu-settings-open', () => {
  closeBackgroundList();
});
window.addEventListener('yuantu-settings-close', () => {
  closeBackgroundList();
});

window.yuantu.subscribe((next) => {
  state = next;
  // A recovery notice supersedes the error that caused it: both describe the same crash, and "the app came
  // back and rebuilt the session" is the more useful of the two to leave on screen. Without this the window
  // recovered silently and kept an error banner from the request that died with the Host.
  if (state.recovery) localError = null;
  render();
});
// Streamed text arrives on its own channel rather than as a snapshot per token. Accumulating it
// here keeps a token cheap: nothing is cloned, nothing is re-serialised, and only the live bubble is
// repainted (coalesced) instead of the whole surface. The channel says which of a message's two
// streams a slice belongs to — the answer or the thinking — and a slice must never be added to the
// wrong one.
window.yuantu.subscribeDelta((delta) => {
  const live = state?.session.liveMessage;
  const channel = delta.channel === 'reasoning' ? 'reasoning' : 'text';
  if (!live || live.id !== delta.messageId) {
    // The snapshot that announces this message has not been rendered yet. Buffer the slice; render()
    // shows it from the buffer as soon as that snapshot arrives, and later deltas take the cheap
    // path. Calling render() here would be wrong — with no live message it clears the buffer.
    liveDelta = { id: delta.messageId, text: '', reasoning: '' };
    liveDelta[channel] = delta.reset ? '' : delta.text;
    return;
  }
  if (liveDelta?.id !== delta.messageId)
    liveDelta = { id: delta.messageId, text: '', reasoning: '' };
  // A reset means the attempt that produced what is buffered was thrown away, so the buffer is replaced
  // rather than appended to. The answer's buffer can only be reset while it is still empty.
  liveDelta[channel] = delta.reset ? delta.text : liveDelta[channel] + delta.text;
  scheduleLivePaint();
});
// Sub-agent text takes the same cheap path: one child can stream for minutes while the parent idles,
// and repainting a single card is what keeps that free.
window.yuantu.subscribeSubAgentDelta((delta) => {
  subagentView.delta(delta);
});
// Usage and activity, likewise: the numbers change once a second while a model call runs, and the panel
// that shows them is the only surface that needs the update.
window.yuantu.subscribeStatisticsDelta((delta) => {
  statisticsView.delta(delta);
});
// Every other renderer re-renders on a language change; without this the chat
// surface kept its old locale-formatted timestamps and labels.
onLocaleChange(render);
conversation.addEventListener('scroll', updateJumpButton, { passive: true });
element<HTMLButtonElement>('jump-to-latest').addEventListener('click', () => {
  conversation.scrollTo({ top: conversation.scrollHeight, behavior: 'smooth' });
});
new ResizeObserver(() => {
  element('chat-page').style.setProperty(
    '--composer-height',
    `${element('chat-page').querySelector('.composer-area')!.getBoundingClientRect().height}px`,
  );
  updateJumpButton();
}).observe(element('chat-page').querySelector('.composer-area')!);
setupGeneralSettings();
modelSettings = setupModelSettings(
  () => Boolean(operation || sending || state?.session.running || state?.session.loading),
  (busy) => {
    operation = busy;
    render();
  },
);
mcpSettings = setupMcpSettings(
  () => Boolean(operation || sending || state?.session.running || state?.session.loading),
  (busy) => {
    operation = busy;
    render();
  },
  () => state?.workspace,
);
permissionSettings = setupPermissionSettings(
  (busy) => {
    operation = busy;
    render();
  },
  // The chip is drawn by the main process's own answer, which arrives before the Host can accept a change: the
  // rungs stay locked until the desktop says it is ready, instead of a click failing with a startup message.
  () => Boolean(state?.ready),
);
void invoke({ type: 'snapshot' }).then(render);
