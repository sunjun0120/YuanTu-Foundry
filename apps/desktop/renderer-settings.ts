import type {
  ModelConnectionView,
  ModelSettingsView,
  ModelGroupInput,
} from './settings-contract.ts';
import { locale, onLocaleChange, t } from './i18n.ts';
import { showSettingsPanel } from './renderer-panels.ts';
import { modelLimitRange } from '../../packages/protocol/settings.ts';

export function setupModelSettings(
  isBusy: () => boolean,
  onBusy: (busy: boolean) => void,
): { updateBusy(): void } {
  const byId = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
  const page = byId('settings-page');
  const form = byId<HTMLFormElement>('settings-form');
  const picker = byId<HTMLSelectElement>('model');
  const switchStatus = byId('model-switch-status');
  const groupPicker = byId<HTMLSelectElement>('settings-connection');
  const endpointName = byId<HTMLInputElement>('settings-endpoint-name');
  const protocol = byId<HTMLSelectElement>('settings-protocol');
  const url = byId<HTMLInputElement>('settings-url');
  const key = byId<HTMLInputElement>('settings-key');
  const list = byId('settings-model-list');
  const feedback = byId('settings-feedback');
  let view: ModelSettingsView | null = null;
  let editingGroupId = '';
  let pending = false;
  let conversationScroll = 0;

  function status(message: string, error = false): void {
    feedback.textContent = message;
    feedback.hidden = !message;
    feedback.dataset.error = String(error);
  }
  function updateBusy(): void {
    const locked = pending || isBusy();
    picker.disabled = locked;
    byId<HTMLButtonElement>('settings-back').disabled = pending;
    byId<HTMLButtonElement>('open-settings').disabled = pending;
    for (const control of form.querySelectorAll<
      HTMLInputElement | HTMLButtonElement | HTMLSelectElement
    >('input, button, select'))
      control.disabled = locked;
    byId<HTMLButtonElement>('settings-save').disabled = locked || !view?.encryptionAvailable;
  }
  function busy(value: boolean): void {
    pending = value;
    onBusy(value);
    updateBusy();
  }
  function groups(next: ModelSettingsView): Map<string, ModelConnectionView[]> {
    const result = new Map<string, ModelConnectionView[]>();
    for (const entry of next.connections) {
      const entries = result.get(entry.groupId) || [];
      entries.push(entry);
      result.set(entry.groupId, entries);
    }
    return result;
  }
  function updatePicker(next: ModelSettingsView): void {
    picker.replaceChildren();
    if (!next.connections.length) picker.add(new Option(t('settings.noModel'), ''));
    for (const entry of next.connections) picker.add(new Option(entry.model, entry.connectionId));
    picker.add(
      new Option(
        locale() === 'en-US' ? 'Model settings' : '\u6a21\u578b\u8bbe\u7f6e',
        '__settings__',
      ),
    );
    picker.value = next.connectionId || '';
    picker.title = next.model || t('settings.addModelConnection');
    updateBusy();
  }
  function refreshGroupOptions(): void {
    if (!view) return;
    groupPicker.replaceChildren();
    for (const [id, entries] of groups(view)) {
      const first = entries[0]!;
      const label = first.groupName;
      groupPicker.add(
        new Option(
          label +
            (entries.some((entry) => entry.connectionId === view?.activeConnectionId)
              ? ` \u00b7 ${t('settings.currentDefault')}`
              : ''),
          id,
        ),
      );
    }
    if (!editingGroupId) groupPicker.add(new Option(t('settings.newEndpointOption'), ''));
    groupPicker.value = editingGroupId;
  }
  function field(row: HTMLElement, key: string): HTMLInputElement {
    return row.querySelector<HTMLInputElement>(`[data-field="${key}"]`)!;
  }
  function addRow(entry?: Partial<ModelConnectionView>, open = false): HTMLElement {
    const row = document.createElement('article');
    row.className = 'settings-model-row';
    row.dataset.connectionId = entry?.connectionId || '';
    row.innerHTML = `
      <div class="settings-model-head">
        <input data-field="model" type="text" maxlength="256" required autocomplete="off" spellcheck="false" />
        <button data-action="expand" type="button" class="model-icon-button" aria-expanded="false" aria-label=""><span class="model-chevron" aria-hidden="true"></span></button>
        <button data-action="remove" type="button" class="model-icon-button" aria-label="">&times;</button>
      </div>
      <div class="settings-model-details" hidden>
        <label><span data-label="context"></span><input data-field="maxContextTokens" type="number" step="1" /></label>
        <label><span data-label="output"></span><input data-field="maxOutputTokens" type="number" step="1" /></label>
        <label><span data-label="compact"></span><input data-field="autoCompactTokens" type="number" step="1" /></label>
        <label><span data-label="idle"></span><input data-field="streamIdleTimeoutMs" type="number" step="1" /></label>
      </div>`;
    field(row, 'model').value = entry?.model || '';
    row.dataset.supportsVision = String(entry?.supportsVision ?? true);
    // The bounds are the ones the host validates against, not a second pair typed into the markup: a form
    // that accepts a number the contract refuses (or refuses one it accepts) is how the two ends drifted apart.
    for (const property of [
      'maxContextTokens',
      'maxOutputTokens',
      'autoCompactTokens',
      'streamIdleTimeoutMs',
    ] as const) {
      const [min, max] = modelLimitRange(property);
      field(row, property).min = String(min);
      field(row, property).max = String(max);
      field(row, property).value = String(entry?.[property] ?? '');
    }
    const first = list.children.length === 0;
    if (first) {
      field(row, 'model').id = 'settings-model';
      field(row, 'maxContextTokens').id = 'settings-context-tokens';
      field(row, 'maxOutputTokens').id = 'settings-output-tokens';
    }
    list.append(row);
    row
      .querySelector<HTMLButtonElement>('[data-action="expand"]')!
      .addEventListener('click', () => toggleRow(row));
    row
      .querySelector<HTMLButtonElement>('[data-action="remove"]')!
      .addEventListener('click', () => {
        if (list.children.length === 1) {
          status(t('settings.atLeastOne'), true);
          return;
        }
        row.remove();
        assignFirstIds();
        status('');
      });
    toggleRow(row, open);
    translateRow(row);
    return row;
  }
  function assignFirstIds(): void {
    for (const old of list.querySelectorAll(
      '[id^="settings-model"], [id^="settings-context-tokens"], [id^="settings-output-tokens"]',
    ))
      old.removeAttribute('id');
    const first = list.firstElementChild as HTMLElement | null;
    if (!first) return;
    for (const [key, id] of [
      ['model', 'settings-model'],
      ['maxContextTokens', 'settings-context-tokens'],
      ['maxOutputTokens', 'settings-output-tokens'],
    ])
      field(first, key!).id = id!;
  }
  function toggleRow(
    row: HTMLElement,
    open = row.querySelector('.settings-model-details')!.hasAttribute('hidden'),
  ): void {
    const details = row.querySelector<HTMLElement>('.settings-model-details')!;
    details.hidden = !open;
    const button = row.querySelector<HTMLButtonElement>('[data-action="expand"]')!;
    button.setAttribute('aria-expanded', String(open));
    button.setAttribute('aria-label', t(open ? 'settings.collapseModel' : 'settings.expandModel'));
  }
  function translateRow(row: HTMLElement): void {
    field(row, 'maxContextTokens').placeholder = t('settings.automaticBudget');
    field(row, 'maxOutputTokens').placeholder = t('settings.automaticBudget');
    field(row, 'autoCompactTokens').placeholder = t('settings.defaultLimit');
    field(row, 'streamIdleTimeoutMs').placeholder = t('settings.defaultLimit');
    field(row, 'model').setAttribute('aria-label', t('settings.modelId'));
    field(row, 'model').placeholder = t('settings.modelNote');
    for (const [name, key] of [
      ['context', 'settings.contextTokens'],
      ['output', 'settings.outputTokens'],
      ['compact', 'settings.autoCompactTokens'],
      ['idle', 'settings.streamIdleTimeoutMs'],
    ])
      row.querySelector<HTMLElement>(`[data-label="${name}"]`)!.textContent = t(key!);
    row
      .querySelector<HTMLButtonElement>('[data-action="remove"]')!
      .setAttribute('aria-label', t('settings.removeModel'));
    const expanded = row.querySelector<HTMLButtonElement>('[data-action="expand"]')!;
    expanded.setAttribute(
      'aria-label',
      t(
        expanded.getAttribute('aria-expanded') === 'true'
          ? 'settings.collapseModel'
          : 'settings.expandModel',
      ),
    );
  }
  function fillGroup(id: string, next: ModelSettingsView): void {
    editingGroupId = id;
    const entries = groups(next).get(id) || [];
    const first = entries[0] || (next.source === 'environment' && !id ? next : null);
    endpointName.value = first?.groupName || '';
    protocol.value = first?.protocol || 'openai';
    url.value = first?.baseUrl || 'https://api.openai.com';
    key.value = '';
    key.placeholder = first?.hasKey ? t('settings.connectionConfigured') : t('settings.apiKey');
    list.replaceChildren();
    if (entries.length) entries.forEach((entry) => addRow(entry));
    else addRow(first || undefined);
    refreshGroupOptions();
    status('');
    updateBusy();
  }
  function fill(next: ModelSettingsView): void {
    view = next;
    updatePicker(next);
    fillGroup(next.groupId || next.connections[0]?.groupId || '', next);
    byId('settings-source').textContent =
      t('settings.currentConfig', {
        source: {
          saved: t('settings.savedLocally'),
          environment: t('settings.fromEnvironment'),
          empty: t('settings.notConfigured'),
        }[next.source],
      }) + (next.model ? ` \u00b7 ${next.model}` : '');
  }
  function translate(): void {
    const setLabel = (id: string, key: string) => {
      const label = byId(id);
      const node = [...label.childNodes].find(
        (item) => item.nodeType === Node.TEXT_NODE && item.textContent?.trim(),
      );
      if (node) node.textContent = t(key!);
      else label.insertBefore(document.createTextNode(t(key)), label.firstChild);
    };
    byId('settings-title').textContent = t('ui.models');
    byId('model-settings-content').querySelector<HTMLElement>(
      '.settings-page-header p',
    )!.textContent = t('settings.description');
    setLabel('settings-endpoint-name-label', 'settings.endpointName');
    setLabel('settings-protocol-label', 'settings.protocol');
    setLabel('settings-url-label', 'settings.url');
    setLabel('settings-key-label', 'settings.apiKey');
    byId('settings-protocol-note').textContent = t('settings.protocolNote');
    byId('settings-url-note').textContent = t('settings.urlNote');
    byId('settings-key-note').textContent = t('settings.apiKeyNote');
    byId('settings-connection-label').textContent = t('settings.endpointGroup');
    byId('settings-test-note').textContent = t('settings.testNote');
    byId<HTMLButtonElement>('settings-new').textContent = t('settings.newEndpoint');
    byId<HTMLButtonElement>('settings-add-model').textContent = t('settings.addModel');
    byId<HTMLButtonElement>('settings-test').textContent = t('settings.test');
    byId<HTMLButtonElement>('settings-discover').textContent = t('settings.discover');
    byId<HTMLButtonElement>('settings-cancel').textContent = t('settings.cancel');
    byId<HTMLButtonElement>('settings-save').textContent = t('settings.saveGroup');
    groupPicker.setAttribute('aria-label', t('settings.endpointGroup'));
    endpointName.setAttribute('aria-label', t('settings.endpointName'));
    endpointName.placeholder = t('settings.endpointNamePlaceholder');
    url.setAttribute('aria-label', t('settings.url'));
    key.setAttribute('aria-label', t('settings.apiKey'));
    for (const row of list.children) translateRow(row as HTMLElement);
    if (view) {
      updatePicker(view);
      refreshGroupOptions();
    }
  }
  onLocaleChange(translate);
  translate();

  groupPicker.addEventListener('change', () => {
    if (view && !pending) fillGroup(groupPicker.value, view);
  });
  byId<HTMLButtonElement>('settings-new').addEventListener('click', () => {
    if (!view || pending) return;
    fillGroup('', view);
    protocol.value = 'openai';
    url.value = 'https://api.openai.com';
    key.placeholder = t('settings.apiKey');
    endpointName.value = '';
    field(list.firstElementChild as HTMLElement, 'model').value = '';
    endpointName.focus();
  });
  byId<HTMLButtonElement>('settings-add-model').addEventListener('click', () => {
    if (pending) return;
    const row = addRow();
    field(row, 'model').focus();
    updateBusy();
  });
  byId<HTMLButtonElement>('settings-cancel').addEventListener('click', () => {
    if (view && !pending) fillGroup(editingGroupId || view.groupId, view);
  });
  async function refresh(): Promise<void> {
    try {
      const reply = await window.yuantu.settings({ type: 'get' });
      if (reply.ok) {
        fill(reply.settings);
        status(reply.settings.error || '', Boolean(reply.settings.error));
      } else status(reply.error, true);
    } catch {
      status(t('settings.connectionError'), true);
    } finally {
      busy(false);
    }
  }
  function openSettings(target: 'general' | 'model' = 'general'): void {
    if (pending) return;
    if (page.hidden) conversationScroll = byId('conversation').scrollTop;
    window.dispatchEvent(new CustomEvent('yuantu-settings-open'));
    byId('chat-page').hidden = true;
    byId('chat-sidebar').hidden = true;
    page.hidden = false;
    document.body.dataset.page = 'settings';
    byId(target === 'model' ? 'model-settings' : 'general-settings').dispatchEvent(
      new Event('click'),
    );
    busy(true);
    void refresh();
    byId<HTMLButtonElement>('settings-back').focus();
  }
  function backToChat(): void {
    if (pending) return;
    key.value = '';
    status('');
    page.hidden = true;
    byId('chat-page').hidden = false;
    byId('chat-sidebar').hidden = false;
    document.body.dataset.page = 'chat';
    window.dispatchEvent(new CustomEvent('yuantu-settings-close'));
    byId('conversation').scrollTop = conversationScroll;
    byId<HTMLButtonElement>('open-settings').focus();
    void window.yuantu
      .settings({ type: 'get' })
      .then((reply) => {
        if (reply.ok) {
          view = reply.settings;
          updatePicker(reply.settings);
        }
      })
      .catch(() => {});
  }
  byId('open-settings').addEventListener('click', () => openSettings('general'));
  byId('settings-back').addEventListener('click', backToChat);
  byId('model-settings').addEventListener('click', () => {
    if (pending) return;
    showSettingsPanel('model-settings-content');
    url.focus();
  });
  picker.addEventListener('change', () => {
    const id = picker.value;
    if (id === '__settings__') {
      picker.value = view?.connectionId || '';
      openSettings('model');
      return;
    }
    if (pending || isBusy() || !id || id === view?.connectionId) {
      picker.value = view?.connectionId || '';
      return;
    }
    switchStatus.hidden = false;
    switchStatus.textContent = t('settings.selectHint');
    busy(true);
    void window.yuantu
      .settings({ type: 'select', connectionId: id })
      .then((reply) => {
        if (reply.ok) {
          fill(reply.settings);
          switchStatus.hidden = true;
        } else {
          picker.value = view?.connectionId || '';
          switchStatus.textContent = reply.error;
        }
      })
      .catch(() => {
        picker.value = view?.connectionId || '';
        switchStatus.textContent = t('settings.connectionError');
      })
      .finally(() => busy(false));
  });

  function rowInput(row: HTMLElement): ModelGroupInput['models'][number] {
    const number = (name: string) => {
      const value = field(row, name).value.trim();
      return value ? Number(value) : null;
    };
    return {
      connectionId: row.dataset.connectionId || '',
      model: field(row, 'model').value,
      name: field(row, 'model').value,
      supportsVision: row.dataset.supportsVision !== 'false',
      maxContextTokens: number('maxContextTokens'),
      maxOutputTokens: number('maxOutputTokens'),
      autoCompactTokens: number('autoCompactTokens'),
      streamIdleTimeoutMs: number('streamIdleTimeoutMs'),
    };
  }
  async function submit(type: 'test' | 'save-group'): Promise<void> {
    if (pending || isBusy() || !form.reportValidity()) return;
    const models = [...list.children].map((row) => rowInput(row as HTMLElement));
    if (new Set(models.map((item) => item.model.trim())).size !== models.length) {
      status(t('settings.duplicateModel'), true);
      return;
    }
    const values: ModelGroupInput = {
      groupId: editingGroupId,
      name: endpointName.value,
      protocol: protocol.value as ModelGroupInput['protocol'],
      baseUrl: url.value,
      apiKey: key.value,
      models,
      activeConnectionId: view?.activeConnectionId || undefined,
    };
    busy(true);
    status('');
    try {
      const reply =
        type === 'test'
          ? await window.yuantu.settings({
              type: 'test',
              values: {
                ...models[0]!,
                connectionId: models[0]!.connectionId,
                protocol: values.protocol,
                baseUrl: values.baseUrl,
                apiKey: values.apiKey,
              },
            })
          : await window.yuantu.settings({ type: 'save-group', values });
      if (!reply.ok) {
        status(reply.error, true);
        return;
      }
      if (type === 'save-group') fill(reply.settings);
      status(reply.message || t('common.done'));
    } catch {
      status(t('settings.connectionError'), true);
    } finally {
      busy(false);
    }
  }
  /**
   * Ask the endpoint what it serves, and fill in the numbers only it can answer.
   *
   * The window is the one limit a run refuses to invent, and most endpoints publish it; this is the desktop
   * form of the CLI's `models`. Nothing is saved: the fields the operator can still edit are filled, and
   * anything the catalogue does not answer is said out loud rather than left looking configured.
   */
  async function discover(): Promise<void> {
    if (pending || isBusy() || !form.reportValidity()) return;
    const rows = [...list.children] as HTMLElement[];
    const models = rows.map((row) => rowInput(row));
    const missingIds: string[] = [];
    busy(true);
    status(t('settings.discovering'));
    try {
      const reply = await window.yuantu.settings({
        type: 'discover',
        values: {
          ...models[0]!,
          connectionId: models[0]!.connectionId,
          protocol: protocol.value as ModelGroupInput['protocol'],
          baseUrl: url.value,
          apiKey: key.value,
        },
      });
      if (!reply.ok) {
        status(reply.error, true);
        return;
      }
      const catalogue = reply.discovered?.models ?? [];
      if (!catalogue.length) {
        status(t('settings.discoverEmpty'), true);
        return;
      }
      const filled: string[] = [];
      const noWindow: string[] = [];
      rows.forEach((row, index) => {
        const id = models[index]!.model.trim();
        const found = catalogue.find((entry) => entry.id === id);
        if (!found) {
          missingIds.push(id || '—');
          return;
        }
        let wrote = false;
        if (found.contextWindow !== undefined) {
          field(row, 'maxContextTokens').value = String(found.contextWindow);
          wrote = true;
        }
        if (found.maxOutputTokens !== undefined) {
          field(row, 'maxOutputTokens').value = String(found.maxOutputTokens);
          wrote = true;
        }
        if (wrote) filled.push(id);
        else noWindow.push(id);
      });
      const parts = [
        filled.length ? t('settings.discoverFilled', { models: filled.join(', ') }) : '',
        noWindow.length ? t('settings.discoverNoWindow', { models: noWindow.join(', ') }) : '',
        missingIds.length
          ? t('settings.discoverMissing', {
              models: missingIds.join(', '),
              list: catalogue
                .map((entry) => entry.id)
                .slice(0, 12)
                .join(', '),
            })
          : '',
      ].filter(Boolean);
      status(parts.join(' '), noWindow.length > 0 || missingIds.length > 0);
    } catch {
      status(t('settings.discoverError'), true);
    } finally {
      busy(false);
    }
  }
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    void submit('save-group');
  });
  byId('settings-discover').addEventListener('click', () => void discover());
  byId('settings-test').addEventListener('click', () => void submit('test'));
  form.addEventListener('input', () => status(''));
  protocol.addEventListener('change', () => {
    if (['https://api.anthropic.com', 'https://api.openai.com'].includes(url.value))
      url.value =
        protocol.value === 'anthropic' ? 'https://api.anthropic.com' : 'https://api.openai.com';
    key.value = '';
  });
  void refresh();
  return { updateBusy };
}
