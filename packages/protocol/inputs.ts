/** How a queued input joins a run: folded into the live turn, or held for the turn after it. */
export type InputMode = 'steer' | 'follow-up';
/** What a client is shown for one queued input: identity, mode, text and how many pictures. */
export interface QueuedInput {
  id: string;
  mode: InputMode;
  prompt: string;
  imageCount: number;
  createdAt: string;
}
