/**
 * The one lock the model form and the composer's model picker share.
 *
 * The two used to live in the same module, so `pending` could be a local variable: a save disabled the picker and a
 * switch disabled the form. They are separate owners now (the form is React, the picker and the page are still the
 * legacy shell), and they must still agree — a switch during a save, or a save during a switch, is the race the old
 * `updateBusy` prevented.
 *
 * `entry` is the picker/page side, `form` is the React form, `busy` is a run using the connection. Each side reads the
 * union and writes only its own flag.
 */
import { createStore } from '../stores.ts';

export interface ModelLockState {
  /** A save, test or discovery is in flight in the React form. */
  form: boolean;
  /** The legacy picker is switching connections or refreshing. */
  entry: boolean;
  /** The window is streaming a run; neither side may change the model. */
  busy: boolean;
}

export const modelLock = createStore<ModelLockState>({ form: false, entry: false, busy: false });

export function modelLocked(state: ModelLockState): boolean {
  return state.form || state.entry || state.busy;
}
