import { RendererControlState, type CliRenderer } from "@opentui/core"

/** Sets the terminal's title, unless OpenTUI would refuse it: while suspended (the terminal handed to `$EDITOR` or a
 *  child, until resume completes) or once destroyed. */
export function setTerminalTitle(
  renderer: Pick<CliRenderer, "isDestroyed" | "controlState" | "setTerminalTitle">,
  title: string,
) {
  if (renderer.isDestroyed || renderer.controlState === RendererControlState.EXPLICIT_SUSPENDED) return
  renderer.setTerminalTitle(title)
}

export function destroyRenderer(renderer: Pick<CliRenderer, "isDestroyed" | "setTerminalTitle" | "destroy">) {
  // OpenTUI refuses terminal control while the renderer is suspended or destroyed; the renderer must still go.
  try {
    renderer.setTerminalTitle("")
  } catch {}
  if (renderer.isDestroyed) return
  renderer.destroy()
}
