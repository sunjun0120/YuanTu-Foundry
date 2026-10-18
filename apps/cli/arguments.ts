/** The commands that open the session store; everything else was handled before it is opened. */
const SESSION_COMMANDS = [
  'run',
  'resume',
  'sessions',
  'show',
  'plan',
  'plan-execute',
  'plan-show',
  'task-create',
  'tasks',
  'task',
  'task-attempts',
  'task-steps',
  'task-trigger',
  'task-schedule',
  'task-approval',
  'task-verify',
  'task-retry',
];

/** Refuses an unknown session command, or a known one with the wrong arguments, before the store opens. */
export function assertSessionCommand(command: string, args: string[]): void {
  if (!SESSION_COMMANDS.includes(command)) throw new Error(`Unknown command: ${command}`);
  if (command === 'run' && args.length !== 1) throw new Error('Usage: run "task"');
  if (command === 'plan' && args.length !== 1) throw new Error('Usage: plan "task"');
  if (command === 'plan-execute' && args.length !== 3)
    throw new Error('Usage: plan-execute <session-id> <plan-id> <hash>');
  if (command === 'resume' && args.length !== 2)
    throw new Error('Usage: resume <session-id> "follow-up"');
  if (command === 'show' && args.length !== 1) throw new Error('Usage: show <session-id>');
  if (command === 'task-create' && args.length !== 2)
    throw new Error('Usage: task-create <session-id> <spec.json>');
  if (command === 'tasks' && args.length !== 1) throw new Error('Usage: tasks <session-id>');
  if (command === 'task' && args.length !== 2)
    throw new Error('Usage: task <session-id> <task-id>');
  if (
    (command === 'task-attempts' || command === 'task-verify' || command === 'task-steps') &&
    args.length !== 2
  )
    throw new Error(`Usage: ${command} <session-id> <task-id>`);
  if (command === 'task-trigger' && args.length !== 3)
    throw new Error('Usage: task-trigger <session-id> <task-id> <trigger.json|off>');
  if (command === 'task-schedule' && args.length) throw new Error('Usage: task-schedule');
  if (command === 'task-approval' && (args.length !== 4 || !['allow', 'deny'].includes(args[3]!)))
    throw new Error('Usage: task-approval <session-id> <task-id> <approval-id> <allow|deny>');
  if (command === 'task-retry' && (args.length < 2 || args.length > 3))
    throw new Error('Usage: task-retry <session-id> <task-id> ["prompt"]');
  if (command === 'sessions' && args.length) throw new Error('Usage: sessions');
}
