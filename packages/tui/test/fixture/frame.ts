import { mock } from "bun:test"
import { RendererControlState } from "@opentui/core"
import { createTestRenderer, type TestRendererSetup } from "@opentui/core/testing"
import { Effect } from "effect"
import type { TuiInput } from "../../src/app"
import type { Args } from "../../src/context/args"
import { Global } from "../../src/core/global"

/** A terminal's answer to Primary Device Attributes, which it sends after its answers to the queries before it. */
const DA1_REPLY = "\x1b[?1;2c"

/** Runs the app in a test renderer (100x30 unless `size` says) against `input`; returns frame helpers. */
export async function bootFrame(input: Omit<TuiInput, "args">, args: Args = {}, size = { width: 100, height: 30 }) {
  const setup = await createTestRenderer(size)
  await setup.renderer.setupTerminal()
  // The terminal answers its startup queries, as a real one does, with no theme colours: the app then starts at once
  // on its default theme, instead of after waiting a second for colours that never come.
  setup.renderer.stdin.emit("data", Buffer.from(DA1_REPLY))
  const core = await import("@opentui/core")
  mock.module("@opentui/core", () => ({ ...core, createCliRenderer: async () => setup.renderer }))
  const { run } = await import("../../src/app")
  const task = Effect.runPromise(run({ ...input, args }).pipe(Effect.provide(Global.layer)))
  const frame = frameReader(setup)
  return {
    setup,
    frame,
    input: setup.mockInput,
    /** Renders until `pred(frame)` holds; returns the frame, or throws with the last one. */
    async until(pred: (f: string) => boolean, ms = 3000) {
      for (const end = Date.now() + ms; ; await Bun.sleep(20)) {
        await setup.renderOnce()
        if (pred(frame())) return frame()
        if (Date.now() > end) throw new Error("frame never matched:\n" + frame())
      }
    },
    async stop() {
      if (!setup.renderer.isDestroyed) setup.renderer.destroy()
      await task
      mock.restore()
    },
  }
}

/** Reads `setup`'s screen: empty while the renderer is suspended, since it shows nothing then; once destroyed, the
 *  last frame read, when OpenTUI gives no frame any more. */
export function frameReader(setup: TestRendererSetup) {
  let last = ""
  return () => {
    const { renderer } = setup
    if (renderer.controlState === RendererControlState.EXPLICIT_SUSPENDED) return ""
    try {
      return (last = setup.captureCharFrame())
    } catch (error) {
      if (renderer.isDestroyed) return last
      throw error
    }
  }
}
