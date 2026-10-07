/**
 * Dispatch modes for extension seams.
 *
 * Every seam used to be a hand-written `for` loop, and each loop re-decided the same four questions:
 * does a failure stop the others, does the first answer win, does the value thread through, may a
 * listener wrap the call instead of observing it. Four loops answered them four different ways, by
 * accident. These four functions answer them once, by name, so a seam's semantics are visible at the
 * call site rather than inferred from the loop body.
 *
 * The names are the ones the comparison with DeepSeek Harness used; the semantics are ours and are
 * written down here rather than assumed:
 *
 * - `dispatchEmit` — notify every listener, collect their failures, ignore their results. A listener
 *   that throws does not stop the others: one broken observer must not silence the rest.
 * - `dispatchFirst` — run in order until one returns a result; `undefined` means "no opinion". This is
 *   the shape of a gate: `beforeTool` uses it (`deny`/`failed` win immediately) and so do guards.
 * - `dispatchSerial` — thread a value through every listener, in order. A listener returning
 *   `undefined` keeps the current value. This is the shape of a refinement chain.
 * - `dispatchWaterfall` — around-middleware. Each listener receives `next()`; the innermost call is the
 *   `terminal`. A listener that never delegates is an error rather than an implicit short-circuit:
 *   interception is what the gate and post-execute stages are for, so a wrapper that fabricates a
 *   result would hide the very effect an audit is trying to see. Retries are allowed — a listener may
 *   call `next()` more than once — because that is the whole point of wrapping a dispatch.
 *
 * `invoke` is supplied by the caller and owns cancellation and the per-seam timeout budget, so this
 * module stays free of policy about how long an extension may take.
 */
export type Disposer = () => void;
/**
 * An ordered listener list whose every registration returns its own removal.
 *
 * Ordering is registration order everywhere: a host registers its policies at boot, an embedder adds
 * one for a run, a test adds one for a case, and removing any of them leaves the rest in place.
 */
export class ListenerSet<Listener> {
  private listeners: Listener[] = [];
  get size(): number {
    return this.listeners.length;
  }
  get all(): readonly Listener[] {
    return this.listeners;
  }
  use(listener: Listener): Disposer {
    this.listeners.push(listener);
    return () => {
      const index = this.listeners.indexOf(listener);
      if (index >= 0) this.listeners.splice(index, 1);
    };
  }
}
/**
 * Notifies every listener and collects the failures that the caller's `invoke` reports.
 *
 * The invoke callback returns a failure message instead of throwing when the listener threw, because
 * "which observers failed" is a value this mode is expected to return.
 */
export async function dispatchEmit<Listener>(
  listeners: readonly Listener[],
  invoke: (listener: Listener) => Promise<string | undefined>,
): Promise<string[]> {
  const failures: string[] = [];
  for (const listener of listeners) {
    const failure = await invoke(listener);
    if (failure !== undefined) failures.push(failure);
  }
  return failures;
}
/** Runs listeners in order until one produces a result. `undefined` means "no opinion, keep going". */
export async function dispatchFirst<Listener, Result>(
  listeners: readonly Listener[],
  invoke: (listener: Listener) => Promise<Result | undefined>,
): Promise<Result | undefined> {
  for (const listener of listeners) {
    const result = await invoke(listener);
    if (result !== undefined) return result;
  }
  return undefined;
}
/** Threads a value through every listener in order. `undefined` keeps the current value. */
export async function dispatchSerial<Listener, Value>(
  listeners: readonly Listener[],
  value: Value,
  invoke: (listener: Listener, value: Value) => Promise<Value | undefined>,
): Promise<Value> {
  let current = value;
  for (const listener of listeners) {
    const next = await invoke(listener, current);
    if (next !== undefined) current = next;
  }
  return current;
}
/**
 * Wraps a terminal call in every listener, outermost first.
 *
 * `next()` re-enters the chain with the same value: the value is an identity, not state to rewrite, so
 * a wrapper cannot hand downstream listeners a different call than the one being audited.
 */
export async function dispatchWaterfall<Listener, Value, Result>(
  listeners: readonly Listener[],
  value: Value,
  invoke: (listener: Listener, value: Value, next: () => Promise<Result>) => Promise<Result>,
  terminal: (value: Value) => Promise<Result>,
): Promise<Result> {
  const chain = (index: number): Promise<Result> => {
    if (index >= listeners.length) return terminal(value);
    return invoke(listeners[index]!, value, () => chain(index + 1));
  };
  return chain(0);
}
/**
 * Wraps a terminal call in every listener, outermost first, where a listener may hand the rest of the chain a
 * **replacement** state.
 *
 * This is {@link dispatchWaterfall} with one thing added, and the difference is the whole point of having two:
 * there, `next()` takes no argument because the value being threaded is an *identity* the chain is auditing and
 * must not be rewritten. Here the threaded value is a **call context** — the signal a tool body will observe, the
 * deadline it runs under, the resources it may reach — and a wrapper that cannot replace it can only bound its own
 * waiting: it would report "stopped" while the tool kept running, which is the one lie this pipeline refuses.
 *
 * The contract is therefore: `next(state)` passes that state to the next listener and eventually to the terminal;
 * `next()` with no argument keeps the state this listener was given. Both are legal, and the second is what a
 * pure observer (a metrics span, an audit tap) wants — it delegates unchanged and reads the state on the way past.
 */
export async function dispatchThreaded<Listener, State, Result>(
  listeners: readonly Listener[],
  state: State,
  invoke: (
    listener: Listener,
    state: State,
    next: (replacement?: State) => Promise<Result>,
  ) => Promise<Result>,
  terminal: (state: State) => Promise<Result>,
): Promise<Result> {
  const chain = (index: number, current: State): Promise<Result> => {
    if (index >= listeners.length) return terminal(current);
    return invoke(listeners[index]!, current, (replacement) =>
      chain(index + 1, replacement ?? current),
    );
  };
  return chain(0, state);
}
