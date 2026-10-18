import type {
  Acceptance,
  Task,
  TaskEventName,
  TaskTrigger,
} from '../../packages/protocol/index.ts';
import type { CarrierCommand, CarrierSnapshot } from '../../packages/carrier/contract.ts';
import { normalizeTaskTrigger, initialRunAt } from '../../packages/protocol/task-trigger.ts';
import { clock, el, eventLabel, tr } from './renderer-tasks-format.ts';

/**
 * What an open editor may see of the task panel and do to it.
 *
 * `current` is the panel's record of the open editor, `undefined` once it was cancelled or replaced, and `close`
 * forgets that record and redraws the panel from the snapshot it is given.
 */
export interface EditorHost {
  send(command: CarrierCommand): Promise<CarrierSnapshot | null>;
  button(
    parent: HTMLElement,
    label: string,
    action: () => void,
    disabled?: boolean,
  ): HTMLButtonElement;
  snapshot(): CarrierSnapshot | null;
  busy(): boolean;
  current(): { revision: string } | undefined;
  close(next: CarrierSnapshot | null, locked: boolean): void;
}
interface ScheduleDraft {
  kind: 'none' | TaskTrigger['kind'];
  enabled: boolean;
  everyMinutes: number;
  atMinutes: number;
  on: TaskEventName;
  taskId: string;
  timeZone: string;
  weekdays: number[];
  instant: string;
  afterMinutes: number;
  expression: string;
  misfire: 'legacy' | 'skip' | 'latest';
}
export function taskEditor(task: Task, host: EditorHost) {
  const draft = structuredClone(task),
    form = el('form', '', 'task-editor');
  const fields = el('fieldset');
  form.append(fields);
  const field = (
    parent: HTMLElement,
    label: string,
    value: string,
    update: (value: string) => void,
    multiline = false,
  ) => {
    const wrap = el('label', label, 'task-field');
    const input = multiline ? el('textarea') : el('input');
    input.value = value;
    input.addEventListener('input', () => update(input.value));
    wrap.append(input);
    parent.append(wrap);
    return input;
  };
  field(fields, tr('标题', 'Title'), draft.title, (v) => (draft.title = v));
  field(fields, tr('描述', 'Description'), draft.description, (v) => (draft.description = v), true);
  field(
    fields,
    tr('计划步骤（每行一步）', 'Plan steps (one per line)'),
    draft.steps.map((s) => s.description).join('\n'),
    (v) =>
      (draft.steps = v
        .split('\n')
        .filter((s) => s.trim())
        .map((description) => ({ description, status: 'pending' }))),
    true,
  );
  fields.append(el('h4', tr('验收标准', 'Acceptance criteria')));
  const criteria = el('div', '', 'task-criteria');
  fields.append(criteria);
  const draw = () => {
    criteria.replaceChildren();
    draft.acceptance.forEach((item, index) => {
      const row = el('section', '', 'task-criterion');
      criteria.append(row);
      field(
        row,
        tr('标准描述', 'Criterion description'),
        item.description,
        (v) => (item.description = v),
      );
      const label = el('label', tr('检查方式', 'Check type'), 'task-field'),
        kind = el('select');
      kind.setAttribute('aria-label', label.textContent!);
      label.append(kind);
      row.append(label);
      for (const [value, name] of [
        ['manual', tr('人工确认', 'Manual confirmation')],
        ['file-exact', tr('文件内容完全匹配', 'Exact file contents')],
        ['file-contains', tr('文件包含文本', 'File contains text')],
        ['command', tr('执行验收命令', 'Verification command')],
        ['forbidden-path', tr('路径保护', 'Protected path')],
      ]) {
        const option = el('option', name);
        option.value = value!;
        kind.append(option);
      }
      kind.value = item.check?.kind ?? 'manual';
      kind.addEventListener('change', () => {
        item.check =
          kind.value === 'manual'
            ? undefined
            : {
                id: `criterion-${index}-${Date.now()}`,
                kind: kind.value as NonNullable<Acceptance['check']>['kind'],
              };
        draw();
      });
      const check = item.check;
      if (check?.kind === 'command') {
        field(
          row,
          tr('命令 / 可执行文件', 'Command / executable'),
          check.command ?? '',
          (v) => (check.command = v),
        );
        const args = field(
          row,
          tr('参数（可选，JSON 字符串数组）', 'Arguments (optional JSON string array)'),
          JSON.stringify(check.args ?? []),
          (v) => {
            try {
              const parsed: unknown = JSON.parse(v || '[]');
              if (!Array.isArray(parsed) || parsed.some((x) => typeof x !== 'string'))
                throw new Error();
              check.args = parsed;
              args.setCustomValidity('');
            } catch {
              args.setCustomValidity(
                tr('请输入字符串数组，例如 ["--check"]', 'Enter a string array, e.g. ["--check"]'),
              );
            }
          },
        );
        field(
          row,
          tr('工作目录（可选）', 'Working directory (optional)'),
          check.cwd ?? '',
          (v) => (check.cwd = v || undefined),
        );
      } else if (check) {
        field(
          row,
          tr('相对工作区路径', 'Workspace-relative path'),
          check.path ?? '',
          (v) => (check.path = v),
        );
        if (check.kind === 'forbidden-path') {
          const wrap = el('label', tr('期望状态', 'Expected state'), 'task-field'),
            select = el('select');
          select.setAttribute('aria-label', wrap.textContent!);
          for (const [value, name] of [
            ['absent', tr('不存在', 'Absent')],
            ['unchanged', tr('保持不变', 'Unchanged')],
          ]) {
            const option = el('option', name);
            option.value = value!;
            select.append(option);
          }
          select.value = check.expectation ?? 'absent';
          check.expectation = select.value as 'absent' | 'unchanged';
          select.onchange = () => (check.expectation = select.value as 'absent' | 'unchanged');
          wrap.append(select);
          row.append(wrap);
        } else
          field(
            row,
            tr('期望文本', 'Expected text'),
            check.expected ?? '',
            (v) => (check.expected = v),
            true,
          );
      }
      host.button(row, tr('移除标准', 'Remove criterion'), () => {
        draft.acceptance.splice(index, 1);
        draw();
      });
    });
  };
  draw();
  host.button(fields, tr('添加验收标准', 'Add criterion'), () => {
    draft.acceptance.push({ description: '', met: false });
    draw();
  });
  const warning = el('p', '', 'task-edit-warning');
  form.append(warning);
  const actions = el('div', '', 'task-actions');
  fields.append(actions);
  const save = host.button(actions, tr('保存草稿', 'Save draft'), () => {});
  save.type = 'submit';
  host.button(actions, tr('取消', 'Cancel'), () => {
    host.close(host.snapshot(), host.busy());
  });
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const open = host.current();
    if (
      !open ||
      host.busy() ||
      host.snapshot()?.tasks.find((t) => t.id === task.id)?.updatedAt !== open.revision
    )
      return;
    if (
      !draft.title.trim() ||
      !draft.description.trim() ||
      !draft.acceptance.length ||
      draft.acceptance.some(
        (a) =>
          !a.description.trim() ||
          (a.check &&
            (a.check.kind === 'command' ? !a.check.command?.trim() : !a.check.path?.trim())),
      )
    ) {
      warning.textContent = tr(
        '请填写标题、描述及每项验收标准的必要字段。',
        'Complete the title, description and required criterion fields.',
      );
      return;
    }
    void host
      .send({
        type: 'taskSave',
        taskId: task.id,
        title: draft.title,
        description: draft.description,
        steps: draft.steps.map((s) => ({ ...s, status: 'pending' })),
        acceptance: draft.acceptance.map((a) => ({ ...a, met: false })),
        expectedUpdatedAt: open.revision,
      })
      .then((result) => {
        if (result) {
          host.close(result, false);
        }
      });
  });
  return { form, draft };
}
/**
 * The trigger editor. Scheduled work runs unattended, so the controls spell out exactly when a
 * run will start rather than hiding it behind a cron expression.
 */
export function scheduleEditor(task: Task, host: EditorHost) {
  const current = task.trigger;
  const draft: ScheduleDraft = {
    kind: current?.kind ?? 'none',
    enabled: current?.enabled ?? true,
    everyMinutes: current?.kind === 'interval' ? current.everyMinutes : 60,
    atMinutes: current?.kind === 'daily' || current?.kind === 'weekly' ? current.atMinutes : 9 * 60,
    on: current?.kind === 'event' ? current.on : 'task.completed',
    taskId: (current?.kind === 'event' ? current.taskId : undefined) ?? '',
    timeZone:
      current?.kind === 'weekly' || current?.kind === 'daily' || current?.kind === 'cron'
        ? (current.timeZone ?? '')
        : '',
    weekdays: current?.kind === 'weekly' ? [...current.weekdays] : [1],
    instant: current?.kind === 'at' ? current.at : new Date(Date.now() + 3600000).toISOString(),
    afterMinutes: current?.kind === 'after' ? current.afterMinutes : 60,
    expression: current?.kind === 'cron' ? current.expression : '0 9 * * 1-5',
    misfire: current && 'misfire' in current ? (current.misfire ?? 'legacy') : 'legacy',
  };
  const form = el('form', '', 'task-schedule');
  const grid = el('fieldset', '', 'task-schedule-fields');
  form.append(grid);
  // Declared before the controls so every listener closes over the same binding.
  let refresh = () => {};
  const row = (label: string, control: HTMLElement) => {
    const wrap = el('label', label, 'task-field');
    // A wrapping label's text includes a descendant select's option text, so selects need an
    // explicit accessible name to stay addressable by their own label.
    if (control.tagName === 'SELECT') control.setAttribute('aria-label', label);
    wrap.append(control);
    grid.append(wrap);
    return wrap;
  };
  const kind = el('select');
  for (const [value, name] of [
    ['none', tr('不自动触发', 'No automatic trigger')],
    ['interval', tr('固定间隔', 'Fixed interval')],
    ['daily', tr('每天定时', 'Daily at a time')],
    ['weekly', tr('每周定时', 'Weekly')],
    ['cron', tr('Cron 定时', 'Cron schedule')],
    ['at', tr('指定时刻，仅一次', 'Once at a timestamp')],
    ['after', tr('延迟后，仅一次', 'Once after a delay')],
    ['event', tr('事件触发', 'On an event')],
  ] as const) {
    const option = el('option', name);
    option.value = value;
    kind.append(option);
  }
  kind.value = draft.kind;
  row(tr('触发方式', 'Trigger'), kind);

  const enabled = el('input');
  enabled.type = 'checkbox';
  enabled.checked = draft.enabled;
  enabled.disabled = draft.kind === 'none';
  row(tr('启用', 'Enabled'), enabled);

  const minutes = el('input');
  minutes.type = 'number';
  minutes.min = '1';
  minutes.max = String(7 * 24 * 60);
  minutes.value = String(draft.everyMinutes);
  minutes.disabled = draft.kind !== 'interval';
  row(tr('间隔（分钟，1–10080）', 'Interval in minutes (1–10080)'), minutes);

  const at = el('input');
  at.type = 'time';
  at.value = clock(draft.atMinutes);
  at.disabled = draft.kind !== 'daily';
  row(tr('日历时间', 'Calendar time'), at);
  const zone = el('input');
  zone.value = draft.timeZone;
  zone.placeholder = Intl.DateTimeFormat().resolvedOptions().timeZone;
  row(tr('IANA 时区（每天留空沿用本机）', 'IANA zone (daily: blank keeps local time)'), zone);
  const days = el('div', '', 'task-weekdays');
  for (const day of [1, 2, 3, 4, 5, 6, 0]) {
    const label = el(
      'label',
      tr(
        ['日', '一', '二', '三', '四', '五', '六'][day]!,
        ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][day]!,
      ),
    );
    const checkbox = el('input');
    checkbox.type = 'checkbox';
    checkbox.checked = draft.weekdays.includes(day);
    checkbox.addEventListener('change', () => {
      draft.weekdays = checkbox.checked
        ? [...draft.weekdays, day]
        : draft.weekdays.filter((d) => d !== day);
      refresh();
    });
    label.prepend(checkbox);
    days.append(label);
  }
  row(tr('每周星期', 'Weekdays'), days);
  const instant = el('input');
  instant.value = draft.instant;
  instant.placeholder = '2026-10-07T09:00:00+08:00';
  row(tr('绝对时刻（必须包含 UTC 偏移）', 'Timestamp (UTC offset required)'), instant);
  const delay = el('input');
  delay.type = 'number';
  delay.min = '1';
  delay.max = '525600';
  delay.value = String(draft.afterMinutes);
  row(tr('延迟分钟（1～525600）', 'Delay in minutes (1–525600)'), delay);
  const expression = el('input');
  expression.value = draft.expression;
  row(tr('Cron 表达式（五字段）', 'Cron expression (five fields)'), expression);
  const misfire = el('select');
  for (const [value, name] of [
    ['legacy', tr('沿用旧规则', 'Keep legacy behavior')],
    ['skip', tr('跳过漏跑', 'Skip missed')],
    ['latest', tr('合并为最新一次', 'Merge to latest')],
  ]) {
    const option = el('option', name);
    option.value = value!;
    misfire.append(option);
  }
  misfire.value = draft.misfire;
  row(tr('错过触发', 'Missed schedule'), misfire);
  grid.append(
    el(
      'small',
      tr(
        'Cron：分 时 日 月 星期；支持数字、*、列表、范围和步长，日与星期都受限时匹配任一。晚于目标超过 60 秒才按漏跑策略处理；不逐次补跑。',
        'Cron: minute hour day month weekday; numeric *, lists, ranges and steps. Restricted day and weekday match either. Misfire applies after 60 seconds; no backlog replay.',
      ),
    ),
  );
  const preview = el('p', '', 'task-schedule-preview');
  grid.append(preview);
  grid.append(
    el(
      'small',
      tr(
        '仅 Host 运行时调度。显式时区的缺失时刻跳过，重复时刻只取较早一次。',
        'Schedules require a running Host. Explicit zones skip missing times and use the earlier repeated time.',
      ),
    ),
  );
  const build = (): TaskTrigger | null => {
    const policy = draft.misfire === 'legacy' ? {} : { misfire: draft.misfire };
    if (draft.kind === 'interval')
      return {
        kind: 'interval',
        enabled: draft.enabled,
        everyMinutes: draft.everyMinutes,
        ...policy,
      };
    if (draft.kind === 'daily')
      return {
        kind: 'daily',
        enabled: draft.enabled,
        atMinutes: draft.atMinutes,
        ...(draft.timeZone ? { timeZone: draft.timeZone } : {}),
        ...policy,
      };
    if (draft.kind === 'weekly')
      return {
        kind: 'weekly',
        enabled: draft.enabled,
        atMinutes: draft.atMinutes,
        weekdays: draft.weekdays,
        timeZone: draft.timeZone,
        ...policy,
      };
    if (draft.kind === 'cron')
      return {
        kind: 'cron',
        enabled: draft.enabled,
        expression: draft.expression,
        timeZone: draft.timeZone,
        misfire: draft.misfire === 'skip' ? 'skip' : 'latest',
      };
    if (draft.kind === 'at') return { kind: 'at', enabled: draft.enabled, at: draft.instant };
    if (draft.kind === 'after')
      return {
        kind: 'after',
        enabled: draft.enabled,
        afterMinutes: draft.afterMinutes,
        ...(current?.kind === 'after' &&
        current.afterMinutes === draft.afterMinutes &&
        current.enabled === draft.enabled
          ? { anchorAt: current.anchorAt }
          : {}),
      };
    if (draft.kind === 'event')
      return {
        kind: 'event',
        enabled: draft.enabled,
        on: draft.on,
        ...(draft.on === 'task.completed' && draft.taskId ? { taskId: draft.taskId } : {}),
      };
    return null;
  };

  const on = el('select');
  for (const name of ['run.finished', 'task.completed', 'session.created'] as TaskEventName[]) {
    const option = el('option', eventLabel(name));
    option.value = name;
    on.append(option);
  }
  on.value = draft.on;
  on.disabled = draft.kind !== 'event';
  row(tr('监听事件', 'Listen for'), on);

  const source = el('select');
  const none = el('option', tr('任意任务', 'Any task'));
  none.value = '';
  source.append(none);
  for (const other of host.snapshot()?.tasks ?? []) {
    if (other.id === task.id) continue;
    const option = el('option', other.title);
    option.value = other.id;
    source.append(option);
  }
  source.value = draft.taskId;
  source.disabled = draft.kind !== 'event' || draft.on !== 'task.completed';
  row(
    tr('来源任务（仅“任务通过验收”）', 'Source task (only for a task passing verification)'),
    source,
  );

  kind.addEventListener('change', () => {
    draft.kind = kind.value as ScheduleDraft['kind'];
    if ((draft.kind === 'weekly' || draft.kind === 'cron') && !draft.timeZone) {
      draft.timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
      zone.value = draft.timeZone;
    }
    refresh();
  });
  on.addEventListener('change', () => {
    draft.on = on.value as TaskEventName;
    source.disabled = draft.on !== 'task.completed';
  });
  enabled.addEventListener('change', () => {
    draft.enabled = enabled.checked;
    refresh();
  });
  minutes.addEventListener('input', () => {
    draft.everyMinutes = Number(minutes.value);
    refresh();
  });
  at.addEventListener('input', () => {
    const [hours = '0', mins = '0'] = at.value.split(':');
    draft.atMinutes = Number(hours) * 60 + Number(mins);
    refresh();
  });
  zone.addEventListener('input', () => {
    draft.timeZone = zone.value.trim();
    refresh();
  });
  instant.addEventListener('input', () => {
    draft.instant = instant.value.trim();
    refresh();
  });
  delay.addEventListener('input', () => {
    draft.afterMinutes = Number(delay.value);
    refresh();
  });
  expression.addEventListener('input', () => {
    draft.expression = expression.value;
    refresh();
  });
  misfire.addEventListener('change', () => {
    draft.misfire = misfire.value as ScheduleDraft['misfire'];
    refresh();
  });
  source.addEventListener('change', () => (draft.taskId = source.value));

  const error = el('p', '', 'task-edit-warning');
  form.append(error);
  const actions = el('div', '', 'task-actions');
  grid.append(actions);
  const save = host.button(actions, tr('保存触发设置', 'Save trigger'), () => {});
  save.type = 'submit';
  host.button(actions, tr('取消', 'Cancel'), () => {
    host.close(host.snapshot(), host.busy());
  });
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    if (!host.current() || host.busy()) return;
    if (
      draft.kind === 'interval' &&
      !(
        Number.isInteger(draft.everyMinutes) &&
        draft.everyMinutes >= 1 &&
        draft.everyMinutes <= 10080
      )
    ) {
      error.textContent = tr(
        '间隔需为 1 到 10080 之间的整数分钟。',
        'Interval must be a whole number of minutes between 1 and 10080.',
      );
      return;
    }
    const trigger = build();
    try {
      normalizeTaskTrigger(trigger);
    } catch (cause) {
      error.textContent = cause instanceof Error ? cause.message : String(cause);
      return;
    }
    void host.send({ type: 'taskTrigger', taskId: task.id, trigger }).then((result) => {
      if (result) {
        host.close(result, false);
      }
    });
  });
  // Rebuild the control state in place so switching the trigger kind does not lose the draft.
  refresh = () => {
    enabled.disabled = draft.kind === 'none';
    minutes.disabled = draft.kind !== 'interval';
    at.disabled = !['daily', 'weekly'].includes(draft.kind);
    zone.disabled = !['daily', 'weekly', 'cron'].includes(draft.kind);
    expression.disabled = draft.kind !== 'cron';
    misfire.disabled = !['interval', 'daily', 'weekly', 'cron'].includes(draft.kind);
    misfire.options[0]!.disabled = draft.kind === 'cron';
    if (draft.kind === 'cron' && draft.misfire === 'legacy') {
      draft.misfire = 'latest';
      misfire.value = 'latest';
    }
    for (const input of days.querySelectorAll<HTMLInputElement>('input'))
      input.disabled = draft.kind !== 'weekly';
    instant.disabled = draft.kind !== 'at';
    delay.disabled = draft.kind !== 'after';
    on.disabled = draft.kind !== 'event';
    source.disabled = draft.kind !== 'event' || draft.on !== 'task.completed';
    try {
      const trigger = normalizeTaskTrigger(build());
      const next = trigger?.enabled ? initialRunAt(trigger, new Date()) : undefined;
      preview.textContent = next
        ? tr('预计下次：', 'Next: ') + next
        : tr('没有定时投递', 'No clock delivery');
    } catch (cause) {
      preview.textContent = cause instanceof Error ? cause.message : String(cause);
    }
  };
  refresh();
  return form;
}
