import type { CliRenderer, MouseEvent } from "@opentui/core"

/**
 * Whether `event` is a plain left click. OpenTUI marks the release that ends a selection gesture with `isDragging`,
 * and a fresh "cell" selection means the pointer never moved; other releases, such as the end of a drag that started
 * outside text, are not clicks. Modified clicks are left to the terminal.
 */
export function plainClick(renderer: CliRenderer, event: MouseEvent) {
  if (!event.isDragging || event.modifiers.ctrl || event.modifiers.alt || event.modifiers.shift) return false
  const selection = renderer.getSelection()
  return selection?.isStart === true && selection.behavior === "cell"
}
