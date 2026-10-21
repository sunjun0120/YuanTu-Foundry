import { locale, onLocaleChange } from './i18n.ts';
import {
  CUSTOM_PRESET,
  PERMISSION_PRESETS,
  isPermissionPresetId,
  type PermissionPresetId,
  type PermissionPresetView,
} from './permission-presets.ts';

/**
 * The composer's permission chip: **one** choice that moves both security knobs.
 *
 * This control used to list the four approval modes and nothing else, while the sandbox and the pair of them
 * together were set on a form inside the general settings page. That form is gone (the ledger records the
 * decision): a page that writes both knobs with two dropdowns and two "apply" buttons invites exactly the
 * combinations `permission-presets.ts` exists to prevent — `host` + `ask` reads as "no isolation, but ask me",
 * which is a sentence nobody means. What replaces it is the shape DSH uses: the **preset is the unit**, it is
 * offered where the operator already is (the composer), and applying one writes both halves or neither.
 *
 * Three consequences of that shape are visible below and deliberate:
 *
 * **`custom` is a reading, not a choice.** A pair no preset declares (an operator's own `YUANTU_SANDBOX`, an
 * older policy file, a hand-edited settings file) shows as the current value and cannot be selected as a
 * target. DSH draws the same line, and it is what makes the control honest: "you are in the guarded preset" and
 * "you are somewhere we have no name for" are different answers.
 *
 * **A preset the launch environment forbids is disabled, with the reason on it.** The sandbox mode is pinned
 * when `YUANTU_SANDBOX` is set for the desktop process (`sandbox-settings-store.ts`), so a preset that writes a
 * different mode cannot be applied — and a control that offered it anyway would fail on click. Saying so before
 * the click is the only version of this that is not a lie.
 *
 * **The confirmation is the confirmation.** `unconfined` is the one preset that gives up isolation, so it goes
 * through the same acknowledge-the-risk dialog a full-access switch has always used, with the host sentence the
 * deleted form used to carry. No preset is a way around it: the main process re-checks the same rule.
 */
export function setupPermissionSettings(
  onBusy: (busy: boolean) => void,
  /** Whether the desktop can accept a change yet; the rungs are locked until it can. */
  isReady: () => boolean,
): {
  updateBusy(): void;
  refresh(): void;
  /**
   * Open the full-access confirmation from outside the chip — the completion card's way out when a check could
   * not run inside the sandbox. It is the same dialog with the same acknowledgement; nothing is switched silently.
   */
  requestFullAccess(): void;
} {
  const byId = <T extends HTMLElement = HTMLElement>(id: string): T => {
    const value = document.getElementById(id);
    if (!value) throw new Error(`Missing element: ${id}`);
    return value as T;
  };
  const trigger = byId<HTMLButtonElement>('permission-trigger');
  const menu = byId('permission-menu');
  const select = byId<HTMLSelectElement>('permission-mode');
  const environment = byId('permission-environment');
  const dialog = byId<HTMLDialogElement>('full-access-dialog');
  const acknowledge = byId<HTMLInputElement>('full-access-acknowledge');
  const enable = byId<HTMLButtonElement>('full-access-enable');
  let view: PermissionPresetView | undefined;
  let pending = true;
  /**
   * The last read of the session's pair failed, so the chip does not know what is enforced.
   *
   * Without this the chip fell through to `custom`, which is a claim — "the operator set a pair no rung matches" —
   * about a pair nobody read. A security control that cannot read its state says so, keeps its rungs shut, and
   * offers to read again; it does not guess.
   */
  let unreadable = false;
  /** The preset the open dialog is asking about; `undefined` when no dialog is open. */
  let confirming: PermissionPresetId | undefined;
  /** The `custom` reading inside the menu, drawn by `translate()` and shown by `render()`. */
  let customReading: HTMLElement | undefined;

  const text = (zh: string, en: string) => (locale() === 'en-US' ? en : zh);
  const current = (): PermissionPresetId | typeof CUSTOM_PRESET => view?.current ?? CUSTOM_PRESET;
  /**
   * A failure is a dialog, and a success is nothing at all.
   *
   * The chip used to announce "预设已应用，当前会话已保留。" over the composer after every switch. The chip
   * itself is the announcement — it redraws with the rung that is now in force, and a message that repeats what
   * the control already says is one more line to read on the way to typing. What still needs words is the case
   * where the switch did *not* happen.
   */
  const fail = (error: unknown) => {
    window.alert(
      error instanceof Error
        ? error.message
        : text('预设切换失败。', 'Unable to apply the preset.'),
    );
  };
  /**
   * The four rungs, named the way the interface says them, each with one short line saying what it asks for.
   *
   * The names follow Codex's approval menu ("请求批准 / 帮我批准 / 完全访问权限"), which people already know; the
   * line under each is the promise in a sentence. What each name stands for is in
   * `apps/desktop/permission-presets.ts`, where it is enforced rather than described.
   */
  const label = (id: PermissionPresetId | typeof CUSTOM_PRESET): string =>
    id === 'observe'
      ? text('仅可查看', 'Read only')
      : id === 'guarded'
        ? text('请求批准', 'Ask for approval')
        : id === 'auto'
          ? text('帮我批准', 'Approve for me')
          : id === 'unconfined'
            ? text('完全访问权限', 'Full access')
            : text('自定义', 'Custom');
  const summary = (id: PermissionPresetId): string =>
    id === 'observe'
      ? text('只读取和搜索，不修改文件、不运行命令', 'Read and search only; no edits, no commands')
      : id === 'guarded'
        ? text(
            '修改文件和运行命令时始终询问',
            'Always ask before editing files or running commands',
          )
        : id === 'auto'
          ? text('仅对检测到的风险操作请求批准', 'Only ask for operations detected as risky')
          : text(
              '可不受限制地访问互联网和你电脑上的任何文件',
              'Unrestricted access to the internet and any file on this computer',
            );
  /**
   * What the rung's sandbox does and does not stop, as the rung's tooltip.
   *
   * The names stay short (see `label`), but "请求批准" on Windows is a partial write boundary that leaves
   * reads and the network open, and a person choosing it should be able to learn that without opening the README.
   * A tooltip is the place that keeps the menu a choice while not letting the name promise more than the backend
   * does. The platform is the renderer's own: the `native` mode resolves to the token backend on Windows and to
   * Seatbelt on macOS.
   */
  const windowsHost = /Windows/i.test(navigator.userAgent);
  const sandboxNote = (): string =>
    windowsHost
      ? text(
          '命令在 Windows 受限令牌中运行：只部分限制写入，仍可读取本机文件、访问网络。',
          'Commands run under a restricted Windows token: writes are only partly confined, and they can still read files on this machine and reach the network.',
        )
      : text(
          '命令在 Seatbelt 沙箱中运行：只能写入工作区，默认断网。',
          'Commands run in the Seatbelt sandbox: writes stay in the workspace and the network is off by default.',
        );
  const boundary = (id: PermissionPresetId): string =>
    id === 'observe'
      ? text(
          '只读：不修改文件、不执行命令；读取与搜索工作区无需确认。',
          'Read only: no file changes and no commands; reading and searching the workspace need no confirmation.',
        )
      : id === 'guarded'
        ? text('写入与命令逐项确认。', 'Writes and commands are confirmed one by one. ') +
          sandboxNote()
        : id === 'auto'
          ? text(
              '工作区写入和普通命令自动批准；删除、推送、提权、下载执行等风险命令及联网工具仍会询问。',
              'Workspace writes and ordinary commands are approved automatically; risky commands (deleting, pushing, raising privileges, downloading and running code) and network tools still ask. ',
            ) + sandboxNote()
          : text(
              '不再逐项确认；命令直接在本机运行，没有任何系统隔离。',
              'No confirmations; commands run directly on this machine with no operating-system isolation.',
            );
  /**
   * One shield per rung, saying what the rung lets through: a check (nothing is written), a pencil (writing is
   * the point), an exclamation (the sandbox is gone). The same shield for all three, so the rows read as one
   * scale rather than three unrelated controls.
   */
  const SHIELD = 'm12 3 8 4v6c0 4-4 7-8 9-4-2-8-5-8-9V7l8-4Z';
  const icon = (id: PermissionPresetId | typeof CUSTOM_PRESET): SVGElement => {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    svg.innerHTML =
      id === 'observe'
        ? `<path d="${SHIELD}"/><path d="m9.2 12.1 1.9 1.9 3.7-3.7"/>`
        : id === 'guarded'
          ? `<path d="${SHIELD}"/><path d="m15.1 9.6 1.3 1.3-4.4 4.4-1.9.6.6-1.9z"/>`
          : id === 'auto'
            ? `<path d="${SHIELD}"/><path d="m9 10.2 2 1.8-2 1.8"/><path d="M12.6 14.4h2.6"/>`
            : `<path d="${SHIELD}"/><path d="M12 10.2v3.6"/><path d="M12 16.4h.01"/>`;
    return svg;
  };
  const closeMenu = () => {
    menu.hidden = true;
    trigger.setAttribute('aria-expanded', 'false');
  };
  function render(): void {
    const id = current();
    const locked = pending || !isReady() || unreadable;
    trigger.replaceChildren(
      icon(id),
      document.createTextNode(unreadable ? text('权限未读取', 'Permissions unknown') : label(id)),
    );
    trigger.dataset.preset = unreadable ? 'unknown' : id;
    trigger.title = unreadable
      ? text(
          '未能读取当前会话的权限设置，点击重试。',
          "This session's permissions could not be read. Click to try again.",
        )
      : id === CUSTOM_PRESET
        ? ''
        : boundary(id);
    select.value = id;
    /**
     * Nothing is disabled but a control that cannot move yet. The launch environment used to *pin* the mode, so
     * presets that would write a different one were greyed out with the reason on them; it is the default a new
     * session starts from now, and every session may move off it — which is the difference between a deployment
     * stating where to begin and a deployment forbidding where to go.
     */
    for (const item of menu.querySelectorAll<HTMLButtonElement>('[data-preset]')) {
      const checked = item.dataset.preset === id;
      item.setAttribute('aria-checked', String(checked));
      item.querySelector('.permission-check')!.textContent = checked ? '✓' : '';
      item.disabled = locked;
    }
    if (customReading) customReading.hidden = id !== CUSTOM_PRESET;
    drawEnvironment();
    select.disabled = locked;
    // Still clickable when unreadable: the click is the retry (see the trigger's listener).
    trigger.disabled = pending || !isReady();
  }
  function translate(): void {
    const aria = text('权限与隔离', 'Permissions and isolation');
    for (const element of [select, trigger, menu]) element.setAttribute('aria-label', aria);
    select.replaceChildren(
      ...PERMISSION_PRESETS.map((preset) => {
        const option = document.createElement('option');
        option.value = preset.id;
        option.textContent = label(preset.id);
        return option;
      }),
      (() => {
        const option = document.createElement('option');
        option.value = CUSTOM_PRESET;
        option.textContent = label(CUSTOM_PRESET);
        return option;
      })(),
    );
    const heading = document.createElement('p');
    heading.className = 'permission-heading';
    heading.setAttribute('role', 'presentation');
    heading.textContent = text('应如何批准操作？', 'How should actions be approved?');
    menu.replaceChildren(
      heading,
      ...PERMISSION_PRESETS.map((preset) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.dataset.preset = preset.id;
        button.setAttribute('role', 'menuitemradio');
        button.title = boundary(preset.id);
        const copy = document.createElement('span');
        copy.className = 'permission-copy';
        const name = document.createElement('span');
        name.textContent = label(preset.id);
        const line = document.createElement('small');
        line.textContent = summary(preset.id);
        copy.append(name, line);
        const check = document.createElement('span');
        check.className = 'permission-check';
        button.append(icon(preset.id), copy, check);
        button.addEventListener('click', () => {
          closeMenu();
          choose(preset.id);
        });
        return button;
      }),
      /**
       * The current reading when no preset matches, and a line only when there is something wrong.
       *
       * `custom` is text rather than a control because it has no target to click. The environment gets a line
       * only when the backend behind the rung answered that it cannot run: the rung's name already says what the
       * choice is, and "which program would confine it" is a detail of that choice, not a second choice — the
       * settings page this replaced was the place that made it look like one.
       */
      (() => {
        const footer = document.createElement('div');
        footer.className = 'permission-environment';
        footer.setAttribute('role', 'presentation');
        const reading = document.createElement('p');
        reading.id = 'permission-custom';
        reading.textContent = label(CUSTOM_PRESET);
        customReading = reading;
        footer.append(reading, environment);
        return footer;
      })(),
    );
    /**
     * The rung that gives up isolation, announced the way a risk is announced: what changes, and when to choose
     * it. The paragraph is the whole reason this dialog exists — the checkbox is what makes it an acknowledgement
     * rather than a notification.
     */
    byId('full-access-title').textContent = text('确认启用完全访问权限？', 'Enable full access?');
    byId('full-access-description').textContent = text(
      '启用完全访问权限后，智能体将减少确认步骤，并且可以直接执行更多操作，包括敏感操作、文件修改或外部命令。仅建议在你信任当前任务时使用。',
      'With full access the agent skips most confirmation steps and can act directly — sensitive operations, file changes, external commands. Use it only when you trust the current task.',
    );
    byId('full-access-acknowledge-label').textContent = text(
      '我已了解风险，并愿意继续',
      'I understand the risks and want to continue',
    );
    byId('full-access-close').setAttribute('aria-label', text('关闭', 'Close'));
    byId('full-access-cancel').textContent = text('取消', 'Cancel');
    enable.textContent = text('启用完全访问权限', 'Enable full access');
    render();
  }
  /**
   * The one line the menu may add under the rungs: why the backend behind the current one cannot run here.
   *
   * It says nothing when there is nothing wrong — not the backend's name, not the image, not "no OS isolation" —
   * because those are details of a choice already made, and a menu that explains itself under every option is a
   * menu read instead of used. A backend that *cannot* run is different: that is the one fact that changes what
   * the choice will do, and it is worth a sentence. `null` covers both "nobody has asked yet" and "it answered
   * yes", so the line never claims a backend was found.
   */
  function drawEnvironment(): void {
    if (!view) return;
    const availability = view.sandbox.availability;
    environment.hidden = !availability;
    environment.textContent = availability
      ? text('沙箱不可用：', 'Sandbox unavailable: ') + availability
      : '';
  }
  function updateBusy(): void {
    render();
  }
  function closeConfirmation(): void {
    confirming = undefined;
    acknowledge.checked = false;
    enable.disabled = true;
    if (dialog.open) dialog.close();
    render();
    trigger.focus();
  }
  async function apply(preset: PermissionPresetId, acknowledgeHost: boolean): Promise<void> {
    if (pending) return;
    let failed = false;
    pending = true;
    onBusy(true);
    render();
    try {
      const reply = await window.yuantu.presets({
        type: 'set',
        preset,
        ...(acknowledgeHost ? { acknowledgeHost: true } : {}),
      });
      if (!reply.ok) throw new Error(reply.error);
      view = reply.view;
    } catch (error) {
      failed = true;
      fail(error);
    } finally {
      pending = false;
      onBusy(false);
      render();
      trigger.focus();
    }
    // A switch is two writes (the sandbox, then the approval policy), and one that failed between them leaves a
    // pair that is neither the old rung nor the new one. Drawing the old rung would be the chip lying, so the
    // pair actually in force is read back.
    if (failed) void read();
  }
  function choose(next: PermissionPresetId): void {
    if (pending || next === current()) {
      render();
      return;
    }
    if (next === 'unconfined') {
      confirming = next;
      acknowledge.checked = false;
      enable.disabled = true;
      dialog.showModal();
      acknowledge.focus();
      return;
    }
    void apply(next, false);
  }
  trigger.addEventListener('click', () => {
    if (unreadable) {
      void read();
      return;
    }
    menu.hidden = !menu.hidden;
    trigger.setAttribute('aria-expanded', String(!menu.hidden));
    if (!menu.hidden) menu.querySelector<HTMLButtonElement>('[aria-checked="true"]')?.focus();
  });
  trigger.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      menu.hidden = false;
      trigger.setAttribute('aria-expanded', 'true');
      const buttons = menu.querySelectorAll<HTMLButtonElement>('button');
      buttons[event.key === 'ArrowDown' ? 0 : buttons.length - 1]?.focus();
    }
  });
  menu.addEventListener('keydown', (event) => {
    const buttons = [...menu.querySelectorAll<HTMLButtonElement>('button')];
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      buttons[
        (index + (event.key === 'ArrowDown' ? 1 : buttons.length - 1)) % buttons.length
      ]?.focus();
    } else if (event.key === 'Tab') closeMenu();
  });
  /**
   * Escape closes an open menu wherever focus is. It used to be heard only inside the menu, so a re-render that
   * replaced the focused item — or an item still disabled when the menu opened — sent the key to the body and left
   * the menu open over the composer, catching the clicks meant for the attachments beneath it.
   */
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || menu.hidden) return;
    event.preventDefault();
    closeMenu();
    trigger.focus();
  });
  document.addEventListener('pointerdown', (event) => {
    if (!trigger.parentElement!.contains(event.target as Node)) closeMenu();
  });
  select.addEventListener('change', () => {
    if (isPermissionPresetId(select.value)) choose(select.value);
  });
  acknowledge.addEventListener('change', () => {
    enable.disabled = !acknowledge.checked || pending;
  });
  byId('full-access-cancel').addEventListener('click', closeConfirmation);
  // The × in the corner is the same act as 取消: withdraw the question, change nothing. Escape does it too
  // (`cancel` below), so the dialog has one meaning for every way out.
  byId('full-access-close').addEventListener('click', closeConfirmation);
  dialog.addEventListener('cancel', (event) => {
    if (pending) event.preventDefault();
    else closeConfirmation();
  });
  byId<HTMLFormElement>('full-access-form').addEventListener('submit', (event) => {
    event.preventDefault();
    if (!acknowledge.checked || pending || !confirming) return;
    const preset = confirming;
    dialog.close();
    confirming = undefined;
    void apply(preset, true);
  });
  /**
   * Reads the pair the main process is enforcing for the session on screen.
   *
   * Read again whenever the *session* changes, because the choice belongs to the session now: moving to another
   * conversation moves the chip with it, and a new one starts at the default. Nothing about the conversation
   * changes — only which of the three rungs it is on.
   */
  async function read(): Promise<void> {
    pending = true;
    render();
    try {
      const reply = await window.yuantu.presets({ type: 'get' });
      if (!reply.ok) throw new Error(reply.error);
      view = reply.view;
      unreadable = false;
    } catch (error) {
      // The previous view may be another session's: it is dropped rather than shown as this one's.
      view = undefined;
      unreadable = true;
      fail(error);
    } finally {
      pending = false;
      translate();
    }
  }
  /** Follow the window to another session: the chip answers "which sandbox is *this* conversation in". */
  const refresh = (): void => {
    void read();
  };
  void read();
  /**
   * The desktop pushes the pair once a session has actually moved into it.
   *
   * A read taken while the move is in flight answers with the pair *before* it — which is what the chip would
   * then draw and keep, since nothing else changes afterwards. The desktop is the only party that knows when
   * the move is done, so it says so and this is the listener.
   */
  window.yuantu.subscribePresets((next) => {
    view = next;
    unreadable = false;
    translate();
  });
  onLocaleChange(translate);
  translate();
  return { updateBusy, refresh, requestFullAccess: () => choose('unconfined') };
}
