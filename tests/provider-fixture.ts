import type {
  ModelRequest,
  ModelResponse,
  Provider,
  ToolCall,
} from '../packages/protocol/index.ts';

/** The usage every scripted answer reports unless a test is about usage. */
export const FIXTURE_USAGE = { inputTokens: 10, outputTokens: 5 };

/**
 * An answer from the model. A response that carries calls has to say so: the kernel refuses "stop reason
 * conflicts with tool calls" rather than guessing which of the two the provider meant.
 */
export const reply = (text = 'Done', toolCalls: ToolCall[] = []): ModelResponse => ({
  text,
  toolCalls,
  finishReason: toolCalls.length ? 'tool_calls' : 'stop',
  usage: { ...FIXTURE_USAGE },
});

/** One tool call and no text, the shape most scripted rounds take. */
export const toolCall = (
  id: string,
  name: string,
  args: Record<string, unknown>,
  text = '',
): ModelResponse => reply(text, [{ id, name, arguments: args }]);

type Step =
  | ModelResponse
  | ((request: ModelRequest, round: number) => ModelResponse | Promise<ModelResponse>);

/**
 * A provider that answers each round with the next step, then keeps repeating the last one.
 *
 * Repeating rather than failing matches what the hand-written `rounds++ ? reply() : …` providers did: the
 * final answer is the one a run that loops back for verification or a follow-up still has to see. Every
 * request is kept so a test can assert on what the model was actually sent.
 */
export function scriptedProvider(...steps: Step[]): Provider & { requests: ModelRequest[] } {
  if (!steps.length) throw new Error('scriptedProvider needs at least one step');
  const requests: ModelRequest[] = [];
  return {
    requests,
    async complete(request) {
      const round = requests.push(request) - 1;
      const step = steps[Math.min(round, steps.length - 1)]!;
      return typeof step === 'function' ? step(request, round) : structuredClone(step);
    },
  };
}
