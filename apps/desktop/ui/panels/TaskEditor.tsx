import { useState, type ReactNode } from 'react';
import type { Acceptance, Task } from '../../../../packages/protocol/index.ts';
import type { CarrierCommand } from '../../../../packages/carrier/contract.ts';
import { t } from '../../i18n.ts';
import { useLocale } from '../i18n.ts';
import { Button, Select, Textarea, TextInput } from '../primitives.tsx';

export interface TaskEditorProps {
  task: Task;
  revision: string;
  busy: boolean;
  stale: boolean;
  onSave(command: CarrierCommand): Promise<void>;
  onCancel(): void;
}

interface CriterionDraft {
  key: string;
  item: Acceptance;
  args: string;
}
type Check = NonNullable<Acceptance['check']>;
const newCriterion = (item: Acceptance): CriterionDraft => ({
  key: crypto.randomUUID(),
  item: structuredClone(item),
  args: JSON.stringify(item.check?.args ?? []),
});
function parsedArgs(raw: string): string[] | null {
  try {
    const value: unknown = JSON.parse(raw || '[]');
    return Array.isArray(value) && value.every((item) => typeof item === 'string')
      ? (value as string[])
      : null;
  } catch {
    return null;
  }
}

/** Draft state belongs to this keyed editor; snapshots and locale changes never recreate it. */
export function TaskEditor({
  task,
  revision,
  busy,
  stale,
  onSave,
  onCancel,
}: TaskEditorProps): ReactNode {
  useLocale();
  const [title, setTitle] = useState(task.title);
  const [description, setDescription] = useState(task.description);
  const [steps, setSteps] = useState(task.steps.map((step) => step.description).join('\n'));
  const [criteria, setCriteria] = useState(() => task.acceptance.map(newCriterion));
  const [required, setRequired] = useState(false);
  const [saving, setSaving] = useState(false);
  const locked = busy || saving;
  const update = (key: string, change: Partial<CriterionDraft>) =>
    setCriteria((rows) => rows.map((row) => (row.key === key ? { ...row, ...change } : row)));
  const submit = async () => {
    if (locked || stale) return;
    const acceptance = criteria.map((row) => ({
      ...row.item,
      met: false,
      ...(row.item.check?.kind === 'command'
        ? { check: { ...row.item.check, args: parsedArgs(row.args) ?? [] } }
        : {}),
    }));
    if (
      !title.trim() ||
      !description.trim() ||
      !acceptance.length ||
      acceptance.some(
        (item) =>
          !item.description.trim() ||
          (item.check &&
            (item.check.kind === 'command'
              ? !item.check.command?.trim()
              : !item.check.path?.trim())),
      ) ||
      criteria.some((row) => row.item.check?.kind === 'command' && parsedArgs(row.args) === null)
    ) {
      setRequired(true);
      return;
    }
    setRequired(false);
    setSaving(true);
    try {
      await onSave({
        type: 'taskSave',
        taskId: task.id,
        title,
        description,
        steps: steps
          .split('\n')
          .filter((step) => step.trim())
          .map((description) => ({ description, status: 'pending' })),
        acceptance,
        expectedUpdatedAt: revision,
      });
    } finally {
      setSaving(false);
    }
  };
  return (
    <form
      className="task-editor"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <fieldset disabled={locked}>
        <TextInput
          label={t('task.editor.title')}
          value={title}
          onChange={(event) => setTitle(event.currentTarget.value)}
        />
        <Textarea
          label={t('task.editor.description')}
          value={description}
          onChange={(event) => setDescription(event.currentTarget.value)}
        />
        <Textarea
          label={t('task.editor.steps')}
          value={steps}
          onChange={(event) => setSteps(event.currentTarget.value)}
        />
        <h4>{t('task.editor.criteria')}</h4>
        <div className="task-criteria">
          {criteria.map((row) => {
            const { item, key } = row;
            const check = item.check;
            const edit = (patch: Partial<Acceptance>) =>
              update(key, { item: { ...item, ...patch } });
            const editCheck = (patch: Partial<Check>) => edit({ check: { ...check!, ...patch } });
            return (
              <section key={key} className="task-criterion">
                <TextInput
                  label={t('task.editor.criterion')}
                  value={item.description}
                  onChange={(event) => edit({ description: event.currentTarget.value })}
                />
                <Select
                  label={t('task.editor.checkKind')}
                  value={check?.kind ?? 'manual'}
                  disabled={locked}
                  allowDeselect={false}
                  data={[
                    { value: 'manual', label: t('task.editor.manual') },
                    { value: 'file-exact', label: t('task.editor.fileExact') },
                    { value: 'file-contains', label: t('task.editor.fileContains') },
                    { value: 'command', label: t('task.editor.commandKind') },
                    { value: 'forbidden-path', label: t('task.editor.forbiddenPath') },
                  ]}
                  onChange={(kind) => {
                    if (kind)
                      edit({
                        check:
                          kind === 'manual'
                            ? undefined
                            : {
                                id: `criterion-${key}`,
                                kind: kind as Check['kind'],
                                ...(kind === 'forbidden-path'
                                  ? { expectation: 'absent' as const }
                                  : {}),
                              },
                      });
                  }}
                />
                {check?.kind === 'command' ? (
                  <>
                    <TextInput
                      label={t('task.editor.command')}
                      value={check.command ?? ''}
                      onChange={(event) => editCheck({ command: event.currentTarget.value })}
                    />
                    <TextInput
                      label={t('task.editor.args')}
                      value={row.args}
                      error={
                        parsedArgs(row.args) === null ? t('task.editor.argsInvalid') : undefined
                      }
                      onChange={(event) => update(key, { args: event.currentTarget.value })}
                    />
                    <TextInput
                      label={t('task.editor.cwd')}
                      value={check.cwd ?? ''}
                      onChange={(event) =>
                        editCheck({ cwd: event.currentTarget.value || undefined })
                      }
                    />
                  </>
                ) : check ? (
                  <>
                    <TextInput
                      label={t('task.editor.path')}
                      value={check.path ?? ''}
                      onChange={(event) => editCheck({ path: event.currentTarget.value })}
                    />
                    {check.kind === 'forbidden-path' ? (
                      <Select
                        label={t('task.editor.expectation')}
                        value={check.expectation ?? 'absent'}
                        disabled={locked}
                        allowDeselect={false}
                        data={[
                          { value: 'absent', label: t('task.editor.absent') },
                          { value: 'unchanged', label: t('task.editor.unchanged') },
                        ]}
                        onChange={(value) => {
                          if (value) editCheck({ expectation: value as 'absent' | 'unchanged' });
                        }}
                      />
                    ) : (
                      <Textarea
                        label={t('task.editor.expected')}
                        value={check.expected ?? ''}
                        onChange={(event) => editCheck({ expected: event.currentTarget.value })}
                      />
                    )}
                  </>
                ) : null}
                <Button
                  variant="default"
                  onClick={() => setCriteria((rows) => rows.filter((entry) => entry.key !== key))}
                >
                  {t('task.editor.remove')}
                </Button>
              </section>
            );
          })}
        </div>
        <Button
          variant="default"
          onClick={() =>
            setCriteria((rows) => [...rows, newCriterion({ description: '', met: false })])
          }
        >
          {t('task.editor.add')}
        </Button>
        <div className="task-actions">
          <Button type="submit" disabled={locked || stale}>
            {t('task.editor.save')}
          </Button>
          <Button variant="default" onClick={onCancel}>
            {t('task.editor.cancel')}
          </Button>
        </div>
      </fieldset>
      <p className="task-edit-warning" role="status">
        {stale ? t('task.staleWarning') : required ? t('task.editor.required') : ''}
      </p>
    </form>
  );
}
