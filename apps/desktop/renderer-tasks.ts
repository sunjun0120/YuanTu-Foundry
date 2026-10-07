import type {
  Acceptance,
  Task,
  AcceptanceEvidence,
  TaskEventName,
  TaskStepCheckpoint,
  TaskTrigger,
} from '../../packages/protocol/index.ts';
import type { CarrierCommand, CarrierSnapshot } from '../../packages/carrier/contract.ts';
import { normalizeTaskTrigger, initialRunAt } from '../../packages/core/task-trigger.ts';
import { locale } from './i18n.ts';
const tr = (zh: string, en: string) => (locale() === 'zh-CN' ? zh : en);
function el<K extends keyof HTMLElementTagNameMap>(tag: K, text = '', cls = '') {
  const result = document.createElement(tag);
  result.textContent = text;
  result.className = cls;
  return result;
}
function statusLabel(status: string): string {
  const labels: Record<string, [string, string]> = {
    pending: ['\u5f85\u786e\u8ba4\u8349\u7a3f', 'Draft'],
    in_progress: ['\u6267\u884c\u4e2d', 'In progress'],
    completed: ['\u5df2\u5b8c\u6210', 'Completed'],
    needs_review: ['\u5f85\u9a8c\u6536', 'Needs review'],
    blocked: ['\u53d7\u963b', 'Blocked'],
    cancelled: ['\u5df2\u53d6\u6d88', 'Cancelled'],
    skipped: ['\u5df2\u8df3\u8fc7', 'Skipped'],
  };
  const label = labels[status];
  return label ? tr(...label) : status;
}
function clock(minutes: number): string {
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}
function eventLabel(on: TaskEventName): string {
  const labels: Record<TaskEventName, [string, string]> = {
    'run.finished': ['任一任务执行结束', 'Any run finishes'],
    'task.completed': ['任务通过验收', 'A task passes verification'],
    'session.created': ['新建会话', 'A session is created'],
  };
  return tr(...labels[on]);
}
function triggerSummary(task: Task): string {
  const trigger = task.trigger;
  if (!trigger) return tr('无自动触发', 'No automatic trigger');
  const paused =
    (trigger.enabled ? '' : ` · ${tr('已暂停', 'paused')}`) +
    ('misfire' in trigger && trigger.misfire
      ? ` · ${trigger.misfire === 'skip' ? tr('漏跑跳过', 'skip missed') : tr('漏跑合并最新', 'latest missed')}`
      : '');
  if (trigger.kind === 'interval')
    return tr(`每 ${trigger.everyMinutes} 分钟`, `Every ${trigger.everyMinutes} min`) + paused;
  if (trigger.kind === 'daily')
    return (
      tr(`每天 ${clock(trigger.atMinutes)}`, `Daily at ${clock(trigger.atMinutes)}`) +
      ` (${trigger.timeZone ?? tr('本机时区', 'local time')})` +
      paused
    );
  if (trigger.kind === 'weekly')
    return (
      tr(
        `每周 ${trigger.weekdays.join(',')} ${clock(trigger.atMinutes)}`,
        `Weekly ${trigger.weekdays.join(',')} at ${clock(trigger.atMinutes)}`,
      ) +
      ` (${trigger.timeZone})` +
      paused
    );
  if (trigger.kind === 'cron') return `Cron ${trigger.expression} (${trigger.timeZone})` + paused;
  if (trigger.kind === 'at') return tr('仅一次：', 'Once: ') + trigger.at + paused;
  if (trigger.kind === 'after')
    return (
      tr(
        `保存后 ${trigger.afterMinutes} 分钟，仅一次`,
        `Once, ${trigger.afterMinutes} minutes after saving`,
      ) + paused
    );
  return eventLabel(trigger.on) + paused;
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
export function setupTasks(send: (command: CarrierCommand) => Promise<CarrierSnapshot | null>) {
  const list = document.getElementById('task-list')!;
  let snapshot: CarrierSnapshot | null = null,
    busy = false,
    key = '',
    session = '';
  let edit: { task: Task; form: HTMLFormElement; revision: string } | undefined;
  let schedule: { taskId: string; form: HTMLFormElement; revision: string } | undefined;
  const button = (parent: HTMLElement, label: string, action: () => void, disabled = false) => {
    const b = el('button', label, 'secondary');
    b.type = 'button';
    b.disabled = busy || disabled;
    b.addEventListener('click', action);
    parent.append(b);
    return b;
  };
  function evidence(parent: HTMLElement, value?: AcceptanceEvidence) {
    if (!value) return;
    const details = el('details', '', 'task-evidence');
    details.append(
      el(
        'summary',
        tr('验收证据', 'Verification evidence') +
          ` · ${value.passed ? tr('通过', 'Passed') : tr('未通过', 'Not passed')}`,
      ),
    );
    for (const check of value.checks) {
      details.append(
        el('strong', `${check.passed ? '✓' : '×'} ${check.id} · ${check.kind}`),
        el('pre', check.detail),
      );
      if (check.command)
        details.append(
          el(
            'pre',
            `exit: ${check.command.exitCode} · timeout: ${check.command.timedOut}\n${check.command.stdout}\n${check.command.stderr}`,
          ),
        );
    }
    parent.append(details);
  }
  function editor(task: Task) {
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
    field(
      fields,
      tr('描述', 'Description'),
      draft.description,
      (v) => (draft.description = v),
      true,
    );
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
                  tr(
                    '请输入字符串数组，例如 ["--check"]',
                    'Enter a string array, e.g. ["--check"]',
                  ),
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
        button(row, tr('移除标准', 'Remove criterion'), () => {
          draft.acceptance.splice(index, 1);
          draw();
        });
      });
    };
    draw();
    button(fields, tr('添加验收标准', 'Add criterion'), () => {
      draft.acceptance.push({ description: '', met: false });
      draw();
    });
    const warning = el('p', '', 'task-edit-warning');
    form.append(warning);
    const actions = el('div', '', 'task-actions');
    fields.append(actions);
    const save = button(actions, tr('保存草稿', 'Save draft'), () => {});
    save.type = 'submit';
    button(actions, tr('取消', 'Cancel'), () => {
      edit = undefined;
      key = '';
      render(snapshot, busy);
    });
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      if (
        !edit ||
        busy ||
        snapshot?.tasks.find((t) => t.id === task.id)?.updatedAt !== edit.revision
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
      void send({
        type: 'taskSave',
        taskId: task.id,
        title: draft.title,
        description: draft.description,
        steps: draft.steps.map((s) => ({ ...s, status: 'pending' })),
        acceptance: draft.acceptance.map((a) => ({ ...a, met: false })),
        expectedUpdatedAt: edit.revision,
      }).then((result) => {
        if (result) {
          edit = undefined;
          key = '';
          render(result, false);
        }
      });
    });
    edit = { task: draft, form, revision: task.updatedAt };
    return form;
  }
  /**
   * The trigger editor. Scheduled work runs unattended, so the controls spell out exactly when a
   * run will start rather than hiding it behind a cron expression.
   */
  function scheduleEditor(task: Task) {
    const current = task.trigger;
    const draft: ScheduleDraft = {
      kind: current?.kind ?? 'none',
      enabled: current?.enabled ?? true,
      everyMinutes: current?.kind === 'interval' ? current.everyMinutes : 60,
      atMinutes:
        current?.kind === 'daily' || current?.kind === 'weekly' ? current.atMinutes : 9 * 60,
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
    for (const other of snapshot?.tasks ?? []) {
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
    const save = button(actions, tr('保存触发设置', 'Save trigger'), () => {});
    save.type = 'submit';
    button(actions, tr('取消', 'Cancel'), () => {
      schedule = undefined;
      key = '';
      render(snapshot, busy);
    });
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      if (!schedule || busy) return;
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
      void send({ type: 'taskTrigger', taskId: task.id, trigger }).then((result) => {
        if (result) {
          schedule = undefined;
          key = '';
          render(result, false);
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
    schedule = { taskId: task.id, form, revision: task.updatedAt };
    return form;
  }
  /** The durable step journal: what actually survived, independent of the current step list. */
  function stepJournal(parent: HTMLElement, steps: TaskStepCheckpoint[]) {
    if (!steps.length) return;
    const details = el('details', '', 'task-step-journal');
    details.append(el('summary', tr('步骤检查点', 'Step checkpoints') + ` (${steps.length})`));
    for (const step of steps)
      details.append(
        el(
          'p',
          `${step.index} · ${step.status} · ${step.createdAt}${step.note ? ` · ${step.note}` : ''}`,
        ),
      );
    parent.append(details);
  }
  function render(next: CarrierSnapshot | null, locked: boolean) {
    snapshot = next;
    busy = locked || !!next?.session.running || !!next?.session.loading;
    const nextSession = `${next?.workspace}:${next?.session.sessionId}`;
    if (session !== nextSession) {
      edit = undefined;
      schedule = undefined;
      session = nextSession;
      key = '';
    }
    document.getElementById('tasks-panel')!.hidden = !next?.tasks.length;
    const newKey = JSON.stringify([next?.tasks, next?.taskAttempts, next?.taskSteps, locale()]);
    if (edit || schedule) {
      const target = edit?.task.id ?? schedule!.taskId;
      const current = next?.tasks.find((t) => t.id === target);
      const stale = current?.updatedAt !== (edit?.revision ?? schedule!.revision);
      const form = edit?.form ?? schedule!.form;
      form.querySelector('fieldset')!.disabled = busy;
      const save = form.querySelector<HTMLButtonElement>('button[type=submit]')!;
      save.disabled = busy || stale;
      if (stale)
        form.querySelector('.task-edit-warning')!.textContent = tr(
          '任务已更新；请取消后重新编辑。当前输入仍保留。',
          'Task changed. Cancel and reopen to edit the latest version. Your input is preserved.',
        );
      return;
    }
    if (key === newKey) {
      list
        .querySelectorAll<HTMLButtonElement>('button')
        .forEach((b) => (b.disabled = busy || b.dataset.unavailable === 'true'));
      list
        .querySelectorAll<HTMLInputElement>('input[type=checkbox]')
        .forEach((input) => (input.disabled = busy));
      return;
    }
    key = newKey;
    list.replaceChildren();
    for (const task of next?.tasks ?? []) {
      const card = el('article', '', 'task-card');
      card.dataset.taskId = task.id;
      const header = el('div', '', 'task-card-header');
      header.append(
        el('h3', task.title),
        el('span', statusLabel(task.status), `task-status ${task.status}`),
      );
      card.append(header, el('p', task.description, 'task-description'));
      const timeline = el('p', '', 'task-schedule-summary');
      timeline.textContent =
        triggerSummary(task) +
        (task.nextRunAt
          ? ` · ${tr('下次', 'Next')} ${new Date(task.nextRunAt).toLocaleString()}`
          : '') +
        (task.lastRunAt
          ? ` · ${tr('上次', 'Last')} ${new Date(task.lastRunAt).toLocaleString()}`
          : '');
      card.append(timeline);
      /**
       * Why this one is late, when it is.
       *
       * The host writes down a scheduled moment it was too busy to start, and this is the only place a person can
       * see it: without the line, a task that fired while another run was in flight looks like a task that simply
       * ran late. The reason is shown as the host recorded it (`busy` / `closed`) rather than reinterpreted here.
       */
      if (task.waiting)
        card.append(
          el(
            'p',
            `${tr('等待中', 'Waiting')} · ${task.waiting.reason} · ${new Date(task.waiting.since).toLocaleString()}`,
            'task-waiting',
          ),
        );
      if (task.lastTriggerError) card.append(el('p', task.lastTriggerError, 'task-schedule-error'));
      if (task.pendingApproval) {
        const review = el('section', '', 'task-approval');
        const pending = task.pendingApproval;
        review.append(
          el(
            'strong',
            pending.state === 'pending'
              ? tr('等待操作审批', 'Awaiting operation approval')
              : pending.state === 'approved'
                ? tr('已批准，等待续跑', 'Approved; waiting to resume')
                : tr('已拒绝，自动触发已暂停', 'Rejected; automatic trigger paused'),
          ),
        );
        review.append(el('p', `${pending.kind} · ${pending.tool}`));
        review.append(el('pre', pending.description));
        if (pending.state === 'pending') {
          const actions = el('div', '', 'task-actions');
          button(
            actions,
            tr('拒绝并暂停', 'Reject and pause'),
            () =>
              void send({
                type: 'taskApproval',
                taskId: task.id,
                approvalId: pending.id,
                allow: false,
              }),
          );
          button(
            actions,
            tr('批准并续跑', 'Approve and resume'),
            () =>
              void send({
                type: 'taskApproval',
                taskId: task.id,
                approvalId: pending.id,
                allow: true,
              }),
          );
          review.append(actions);
        }
        card.append(review);
      }
      const steps = el('ol', '', 'task-steps');
      task.steps.forEach((step) => steps.append(el('li', `${step.status} · ${step.description}`)));
      card.append(steps);
      const indices = new Set<number>();
      const manual = task.acceptance.some((a) => !a.check);
      const canConfirm =
        !!task.latestRunId &&
        !!task.verification &&
        !['pending', 'in_progress'].includes(task.status);
      task.acceptance.forEach((item, index) => {
        const row = el('label', '', 'task-acceptance-row');
        if (!item.check && canConfirm && !item.met) {
          const input = el('input');
          input.type = 'checkbox';
          input.disabled = busy;
          input.addEventListener('change', () => {
            input.checked ? indices.add(index) : indices.delete(index);
          });
          row.append(input);
        }
        row.append(
          el(
            'span',
            `${item.met ? '✓' : '○'} ${item.description} · ${item.check?.kind ?? tr('人工确认', 'Manual')}`,
          ),
        );
        card.append(row);
      });
      evidence(card, task.verification);
      const actions = el('div', '', 'task-actions');
      card.append(actions);
      const action = (zh: string, en: string, command: CarrierCommand, unavailable = false) => {
        const b = button(actions, tr(zh, en), () => void send(command), unavailable);
        b.dataset.unavailable = String(unavailable);
      };
      button(actions, tr('编辑', 'Edit'), () => {
        list.querySelectorAll<HTMLButtonElement>('button').forEach((b) => (b.disabled = true));
        card.replaceChildren(header, editor(task));
      });
      button(actions, tr('触发设置', 'Trigger settings'), () => {
        list.querySelectorAll<HTMLButtonElement>('button').forEach((b) => (b.disabled = true));
        card.replaceChildren(header, scheduleEditor(task));
      });
      if (!task.latestRunId)
        action('开始执行', 'Start execution', { type: 'taskStart', taskId: task.id });
      else action('重试', 'Retry', { type: 'taskRetry', taskId: task.id });
      action('重新制定计划', 'Regenerate plan', { type: 'taskPropose', taskId: task.id });
      action('验收', 'Verify', { type: 'taskVerify', taskId: task.id }, !task.latestRunId);
      if (manual && canConfirm)
        button(actions, tr('确认勾选的人工结果', 'Confirm selected manual results'), () => {
          if (indices.size)
            void send({
              type: 'taskConfirm',
              taskId: task.id,
              indices: [...indices],
              expectedUpdatedAt: task.updatedAt,
            });
        });
      action('历史', 'History', { type: 'taskHistory', taskId: task.id });
      stepJournal(card, next?.taskSteps[task.id] ?? []);
      const attempts = next?.taskAttempts[task.id] ?? [];
      if (attempts.length) {
        const history = el('details', '', 'task-history');
        history.append(el('summary', tr('历史尝试', 'Attempt history') + ` (${attempts.length})`));
        for (const attempt of attempts) {
          history.append(
            el(
              'p',
              `${attempt.kind} · ${attempt.status} · ${attempt.startedAt}` +
                `${attempt.trigger && attempt.trigger !== 'manual' ? ` · ${attempt.trigger}` : ''}` +
                `${attempt.resume ? ` · ${tr('续跑', 'resumed')}` : ''}` +
                `${attempt.error ? ` · ${attempt.error}` : ''}`,
            ),
          );
          evidence(history, attempt.verification);
        }
        card.append(history);
      }
      list.append(card);
    }
  }
  return render;
}
