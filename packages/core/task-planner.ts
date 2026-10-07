import type { Provider, Task, Usage } from '../protocol/index.ts';
import { normalizeTaskDraft, type TaskDraft } from './task-spec.ts';
export async function proposeTask(
  provider: Provider,
  task: Task,
  signal: AbortSignal,
  onText: (text: string) => void = () => {},
  executionEnvironment = '',
): Promise<{ draft: TaskDraft; usage: Usage }> {
  const response = await provider.complete({
    system:
      'You draft a task plan. You have no tools and must not execute anything. Return only JSON with title, description, steps:[{description,status:"pending"}], acceptance:[{description,met:false,check?:{id,kind,path,expected,command,args,expectation}}]. Keep the original goal. Use manual criteria when verification is subjective; never invent successful results. Automatic kinds: file-exact, file-contains, command, forbidden-path. The user will review and edit every check before explicitly starting execution. Write in the language of the request.' +
      '\n' +
      executionEnvironment,
    messages: [
      {
        role: 'user',
        content: JSON.stringify({ title: task.title, description: task.description }),
      },
    ],
    tools: [],
    maxOutputTokens: 4096,
    signal,
    onText,
  });
  if (response.toolCalls.length || response.finishReason !== 'stop')
    throw new Error('Planning must return a complete draft without tool calls');
  const raw = response.text
    .trim()
    .replace(/^\`\`\`(?:json)?\s*/i, '')
    .replace(/\s*\`\`\`$/, '');
  if (raw.length > 100000) throw new Error('Task proposal is too large');
  return { draft: normalizeTaskDraft(JSON.parse(raw)), usage: response.usage };
}
