import { TODO_STATUSES } from '../protocol/index.ts';
import type { TodoItem, Tool, ToolContext } from '../protocol/index.ts';
/** One checklist line, in the notation a reader can scan without parsing JSON. */
const MARK: Record<TodoItem['status'], string> = {
  pending: ' ',
  in_progress: '~',
  completed: 'x',
};
/**
 * The list as the model wrote it, so the next turn reads back exactly what it committed to.
 *
 * A tool result is the only place the model sees the list: the event is durable and the checklist is
 * rendered to the user, but neither is injected into the transcript, so an item the model drops is dropped
 * rather than silently re-offered.
 */
export function renderTodos(todos: TodoItem[]): string {
  if (!todos.length) return 'The todo list is now empty.';
  const counts = { pending: 0, in_progress: 0, completed: 0 };
  for (const todo of todos) counts[todo.status]++;
  return [
    ...todos.map((todo) => `- [${MARK[todo.status]}] ${todo.id}: ${todo.content}`),
    `${todos.length} item(s): ${counts.completed} completed, ${counts.in_progress} in progress, ${counts.pending} pending.`,
  ].join('\n');
}
export function todoTool(): Tool {
  return {
    name: 'todo_write',
    description:
      'Replace your session todo list with these items, in order. This is your current checklist, not a durable task. Mark the item you are actively working on in_progress and mark it completed when done. Zero in_progress is valid when work has not started, is paused, or is complete. Send the full list whenever it changes; it is shown to the user.',
    inputSchema: {
      type: 'object',
      properties: {
        todos: {
          type: 'array',
          maxItems: 20,
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', pattern: '^[a-z0-9][a-z0-9_-]{0,31}$' },
              content: { type: 'string', minLength: 1, maxLength: 200 },
              status: { type: 'string', enum: [...TODO_STATUSES] },
            },
            required: ['id', 'content', 'status'],
            additionalProperties: false,
          },
        },
      },
      required: ['todos'],
      additionalProperties: false,
    },
    execute: async (args, context: ToolContext) => {
      const todos = args.todos as TodoItem[];
      const seen = new Set<string>();
      for (const todo of todos) {
        // The schema cannot see across items, so uniqueness is checked here — before anything is written.
        if (seen.has(todo.id))
          return { isError: true, content: `Duplicate todo id "${todo.id}"; ids must be unique.` };
        seen.add(todo.id);
      }
      if (!context.todos)
        return {
          isError: true,
          content:
            'No todo list is wired into this run, so the checklist cannot be recorded here. Continue without it.',
        };
      const written = context.todos.write(todos);
      return { isError: false, content: renderTodos(written) };
    },
  };
}
