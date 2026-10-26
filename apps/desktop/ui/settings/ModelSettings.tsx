/**
 * The model settings panel: connection groups, the endpoint form, model rows and the four host actions.
 *
 * The state lives in `createModelSettingsController`; this file draws it. Two rules are carried over verbatim from
 * the legacy form because they are easy to lose in a rewrite:
 *
 * - a row's limits use the host's own bounds (`limitsFor`), never a second pair typed into the markup;
 * - while a write is in flight, or a run is streaming, nothing on the form (or the picker beside it) may change the
 *   model. That is what `locked` below and `modelLock` in the adapter enforce.
 *
 * The panel keeps the legacy element ids the settings smoke drives (`#settings-endpoint-name`, `#settings-save`, …)
 * even though the controls are Mantine's. The smoke is about behaviour, not about `<select>`; keeping the ids means
 * the migration does not have to rewrite every assertion that is still true.
 */
import { useEffect, useState, type ReactNode } from 'react';
import { t } from '../../i18n.ts';
import { useReadable } from '../context.tsx';
import { useLocale } from '../i18n.ts';
import { ActionIcon, Button, Group, Select, Stack, Text, TextInput } from '../primitives.tsx';
import { PanelTransition } from '../transitions.tsx';
import {
  groupChoices,
  limitsFor,
  protocolDefaultUrl,
  type ModelDraftModel,
  type ModelSettingsController,
} from './model-settings-model.ts';

const NEW_GROUP = '__new__';

function protocolOptions(): { value: string; label: string }[] {
  return [
    { value: 'openai', label: t('settings.protocolOpenai') },
    { value: 'anthropic', label: t('settings.protocolAnthropic') },
    { value: 'openai-responses', label: t('settings.protocolResponses') },
  ];
}

type LimitKey =
  'maxContextTokens' | 'maxOutputTokens' | 'autoCompactTokens' | 'streamIdleTimeoutMs';

function ModelRow({
  index,
  model,
  disabled,
  controller,
  resetKey,
}: {
  index: number;
  model: ModelDraftModel;
  disabled: boolean;
  controller: ModelSettingsController;
  resetKey: unknown;
}): ReactNode {
  const [expanded, setExpanded] = useState(false);
  // A saved group replaces the view; the legacy form rebuilt its rows collapsed. Reset on that identity change only.
  useEffect(() => setExpanded(false), [resetKey]);
  const first = index === 0;
  const limit = (key: LimitKey, label: string, id?: string): ReactNode => {
    const bounds = limitsFor(key);
    // A plain `type="number"` input, not Mantine's NumberInput: an emptied NumberInput is a controlled-input edge
    // case that restored the previous number, and the form must be able to say "use the host default" by sending
    // null. The bounds are still the host's own, and the host validates them again.
    return (
      <TextInput
        id={id}
        data-field={key}
        label={label}
        type="number"
        value={model[key] ?? ''}
        min={bounds.min}
        max={bounds.max}
        step={1}
        placeholder={
          key === 'autoCompactTokens' || key === 'streamIdleTimeoutMs'
            ? t('settings.defaultLimit')
            : t('settings.automaticBudget')
        }
        disabled={disabled}
        onChange={(event) => {
          const raw = event.currentTarget.value.trim();
          const value = raw === '' ? null : Number(raw);
          controller.updateModel(index, {
            [key]: value === null || Number.isFinite(value) ? value : null,
          } as Partial<ModelDraftModel>);
        }}
      />
    );
  };
  return (
    <article
      className="settings-model-row"
      data-connection-id={model.connectionId}
      data-supports-vision={String(model.supportsVision)}
    >
      <div className="settings-model-head">
        <TextInput
          id={first ? 'settings-model' : undefined}
          data-field="model"
          aria-label={t('settings.modelId')}
          placeholder={t('settings.modelNote')}
          value={model.model}
          maxLength={256}
          required
          disabled={disabled}
          onChange={(event) => controller.updateModel(index, { model: event.currentTarget.value })}
        />
        <ActionIcon
          type="button"
          variant="subtle"
          className="model-icon-button"
          data-action="expand"
          aria-expanded={expanded}
          aria-label={t(expanded ? 'settings.collapseModel' : 'settings.expandModel')}
          disabled={disabled}
          onClick={() => setExpanded((value) => !value)}
        >
          <span className="model-chevron" aria-hidden="true" />
        </ActionIcon>
        <ActionIcon
          type="button"
          variant="subtle"
          className="model-icon-button"
          data-action="remove"
          aria-label={t('settings.removeModel')}
          disabled={disabled}
          onClick={() => controller.removeModel(index)}
        >
          ×
        </ActionIcon>
      </div>
      <PanelTransition opened={expanded}>
        <div className="settings-model-details">
          {limit(
            'maxContextTokens',
            t('settings.contextTokens'),
            first ? 'settings-context-tokens' : undefined,
          )}
          {limit(
            'maxOutputTokens',
            t('settings.outputTokens'),
            first ? 'settings-output-tokens' : undefined,
          )}
          {limit('autoCompactTokens', t('settings.autoCompactTokens'))}
          {limit('streamIdleTimeoutMs', t('settings.streamIdleTimeoutMs'))}
        </div>
      </PanelTransition>
    </article>
  );
}

export function ModelSettings({ controller }: { controller: ModelSettingsController }): ReactNode {
  useLocale();
  const state = useReadable(controller.store);
  const view = state.view;
  const draft = state.draft;
  const locked = state.pending || state.busy;
  if (!view || !draft)
    return (
      <Stack id="settings-form" gap="md">
        <Text c="dimmed">{t('ui.loading')}</Text>
      </Stack>
    );

  const feedback = state.error ?? state.message;
  const sourceLabel =
    t('settings.currentConfig', {
      source: {
        saved: t('settings.savedLocally'),
        environment: t('settings.fromEnvironment'),
        empty: t('settings.notConfigured'),
      }[view.source],
    }) + (view.model ? ` · ${view.model}` : '');
  const choices = groupChoices(view, draft.groupId, {
    currentDefault: t('settings.currentDefault'),
    newEndpoint: t('settings.newEndpointOption'),
  }).map((choice) => (choice.value === '' ? { ...choice, value: NEW_GROUP } : choice));
  return (
    <form
      id="settings-form"
      onSubmit={(event) => {
        event.preventDefault();
        void controller.save();
      }}
    >
      <Stack gap="md">
        <div className="settings-page-header">
          <div className="eyebrow">
            {t('ui.settingsPage')} / {t('ui.models')}
          </div>
          <h2 id="settings-title">{t('ui.models')}</h2>
          <p>{t('settings.description')}</p>
        </div>

        <div className="model-group-bar">
          <Select
            id="settings-connection"
            label={t('settings.endpointGroup')}
            data={choices}
            value={draft.groupId || NEW_GROUP}
            allowDeselect={false}
            disabled={locked}
            onChange={(value) => {
              if (value === null) return;
              if (value === NEW_GROUP) controller.newGroup();
              else controller.selectGroup(value);
            }}
          />
          <Button
            id="settings-new"
            type="button"
            variant="default"
            disabled={locked}
            onClick={() => controller.newGroup()}
          >
            {t('settings.newEndpoint')}
          </Button>
        </div>

        <TextInput
          id="settings-endpoint-name"
          label={t('settings.endpointName')}
          placeholder={t('settings.endpointNamePlaceholder')}
          value={draft.name}
          maxLength={128}
          required
          disabled={locked}
          onChange={(event) => controller.update({ name: event.currentTarget.value })}
        />

        <TextInput
          id="settings-url"
          label={t('settings.url')}
          description={t('settings.urlNote')}
          type="url"
          placeholder="https://api.anthropic.com"
          value={draft.baseUrl}
          maxLength={2048}
          required
          disabled={locked}
          onChange={(event) => controller.update({ baseUrl: event.currentTarget.value })}
        />

        <div className="settings-protocol">
          <Select
            id="settings-protocol"
            label={<span id="settings-protocol-label">{t('settings.protocol')}</span>}
            description={t('settings.protocolNote')}
            data={protocolOptions()}
            value={draft.protocol}
            allowDeselect={false}
            disabled={locked}
            onChange={(value) => {
              if (value === null) return;
              const protocol = value as typeof draft.protocol;
              const previousDefault = protocolDefaultUrl(draft.protocol);
              controller.update({ protocol });
              if (draft.baseUrl === previousDefault || draft.baseUrl === '')
                controller.update({ baseUrl: protocolDefaultUrl(protocol), apiKey: '' });
            }}
          />
        </div>

        <TextInput
          id="settings-key"
          label={t('settings.apiKey')}
          description={t('settings.apiKeyNote')}
          type="password"
          placeholder={view.hasKey ? t('settings.connectionConfigured') : t('settings.apiKey')}
          value={draft.apiKey}
          maxLength={16384}
          disabled={locked}
          onChange={(event) => controller.update({ apiKey: event.currentTarget.value })}
        />

        <div id="settings-model-list" className="settings-model-list">
          {draft.models.map((model, index) => (
            <ModelRow
              key={index}
              index={index}
              model={model}
              disabled={locked}
              controller={controller}
              resetKey={view}
            />
          ))}
        </div>
        <Button
          id="settings-add-model"
          type="button"
          variant="default"
          className="model-add"
          disabled={locked}
          onClick={() => controller.addModel()}
        >
          {t('settings.addModel')}
        </Button>

        <div id="settings-source" className="settings-source">
          {sourceLabel}
        </div>
        <p id="settings-test-note" className="settings-test-note">
          {t('settings.testNote')}
        </p>
        <p
          id="settings-feedback"
          className="settings-feedback"
          role="status"
          aria-live="polite"
          data-error={String(state.error !== null)}
          hidden={!feedback}
        >
          {feedback}
        </p>
        {!view.encryptionAvailable ? (
          <Text c="red" size="sm">
            {t('settings.encryptionUnavailable')}
          </Text>
        ) : null}

        <Group className="settings-actions">
          <Button
            id="settings-discover"
            type="button"
            variant="default"
            disabled={locked}
            onClick={() => void controller.discover()}
          >
            {t('settings.discover')}
          </Button>
          <Button
            id="settings-test"
            type="button"
            variant="default"
            disabled={locked}
            onClick={() => void controller.test()}
          >
            {t('settings.test')}
          </Button>
          <Button
            id="settings-cancel"
            type="button"
            variant="default"
            disabled={locked}
            onClick={() => controller.cancel()}
          >
            {t('settings.cancel')}
          </Button>
          <Button id="settings-save" type="submit" disabled={locked || !view.encryptionAvailable}>
            {t('settings.saveGroup')}
          </Button>
        </Group>
      </Stack>
    </form>
  );
}
