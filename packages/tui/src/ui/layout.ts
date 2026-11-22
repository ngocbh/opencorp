export const SESSION_SIDEBAR_WIDTH = 42
const SESSION_CONTENT_MIN_WIDTH = 44
const SESSION_CONTENT_PREFERRED_WIDTH = 64
// A docked panel fits when the session keeps its preferred width beside a minimum-width pane. Narrower, panels take
// over the screen.
export const SESSION_PANEL_SPLIT_MIN_WIDTH = SESSION_CONTENT_PREFERRED_WIDTH + SESSION_CONTENT_MIN_WIDTH

/** A side pane's width, `width` asked for, kept within `total`: at least half of it, or 24 columns, and leaving the
 *  chat its minimum when there is room. */
export function clampSessionPaneWidth(width: number, total: number) {
  const half = Math.max(1, Math.floor(total / 2))
  // Preserve the equal split when there is not enough room for both pane minima.
  return Math.max(Math.min(24, half), Math.min(width, Math.max(half, total - SESSION_CONTENT_MIN_WIDTH)))
}
