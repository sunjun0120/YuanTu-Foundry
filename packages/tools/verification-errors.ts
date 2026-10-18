/**
 * The two failures a verifier can tell apart without reading its own prose.
 *
 * `verifyOne` has always caught every error and turned it into a failed check whose `detail` is the message. That
 * is the right shape for a person and the wrong one for a policy: a repair loop that has to decide "is this worth
 * another model round" cannot match on text, because the same failure is phrased differently by every layer it
 * passes through and an unrelated message can contain the same word.
 *
 * So the layer that already knows the semantics says so structurally:
 *
 * - {@link VerificationDefinitionError} — the acceptance definition cannot be executed as written (a path
 *   outside the workspace, a link, a malformed check). Repairing the *code* cannot fix it, and executing more of
 *   it is not something to retry.
 * - {@link VerificationAssertionError} — the definition was executable and the assertion it states is false (a
 *   missing deliverable, content that does not match, an exit code that differs from the expected one). This is
 *   the one class of failure another model round may legitimately address.
 *
 * Everything else a verifier throws — a spawn that could not start, an I/O error, a cleanup failure — stays an
 * ordinary `Error` and is classified as an environment problem by the caller. That is deliberately the *residual*
 * class: an unknown failure must not be assumed repairable.
 */
export class VerificationDefinitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VerificationDefinitionError';
  }
}

export class VerificationAssertionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VerificationAssertionError';
  }
}
