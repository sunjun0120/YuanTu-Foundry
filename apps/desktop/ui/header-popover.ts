/**
 * Placement for the chat header's popovers: the sub-agent catalog and the background jobs list.
 *
 * Both hang under a chip in the header, and that chip sits one session title away from the session sidebar. A
 * panel aligned to the chip's right edge therefore starts inside the sidebar as soon as the title is short; since
 * the shell migration the sidebar is a fixed, z-indexed navbar painted above the chat column, so the overlap made
 * the panel's controls unclickable. Aligning to the chip's left edge is enough for every width the window allows;
 * the shift exists only for a long title, where the panel would otherwise leave the column on the right.
 */
export function placeHeaderPopover(popover: HTMLElement): void {
  if (popover.hidden) return;
  // Both insets are set here, not left to a sheet: the placement is a measurement of this window, and a
  // breakpoint rule must not be able to win once the panel is open.
  popover.style.right = 'auto';
  popover.style.left = '0px';
  const panel = popover.getBoundingClientRect();
  const column = popover.closest('header')?.getBoundingClientRect();
  const right = (column?.right ?? window.innerWidth) - 12;
  const left = (column?.left ?? 0) + 12;
  const overflow = panel.right - right;
  if (overflow <= 0) return;
  popover.style.left = `${-Math.min(overflow, Math.max(panel.left - left, 0))}px`;
}
