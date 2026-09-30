import { InputRenderable } from "@opentui/core"
import type { bootFrame } from "../../fixture/frame"

/** Types `text` once an `<input>` has focus (dialogs focus theirs a tick after they mount). */
export async function typeInto(app: Awaited<ReturnType<typeof bootFrame>>, text: string) {
  await app.until(() => {
    const r = app.setup.renderer.currentFocusedRenderable
    return r instanceof InputRenderable && !r.isDestroyed
  })
  await app.input.typeText(text)
}
