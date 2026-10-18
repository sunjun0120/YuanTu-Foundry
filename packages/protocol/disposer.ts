/** Removes one registration; every listener list in the runtime hands one back. */
export type Disposer = () => void;
