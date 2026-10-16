/**
 * The languages this product writes text in.
 *
 * It lives in the protocol rather than in the app because more than one process has to name the same two values
 * and they sit on opposite sides of a process boundary: the renderer draws the interface, the main process
 * translates its own dialogs, and the *kernel generates content* in one of them — a task draft's default steps
 * are written, not translated, because they land in fields the person then edits. A union declared in the app
 * would have made the kernel depend on the app; named here, each side means the same thing by the same string.
 */
export type Language = 'zh-CN' | 'en-US';
