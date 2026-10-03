import { mock } from "bun:test"
import { createTestRenderer } from "@opentui/core/testing"
import type { SetupPrompt } from "@agent-corp/protocol"
import type { SetupChild } from "../../src/setup/child"

/** A setup child the test drives: it pushes prompts, ends with a code, and records what the screen did. */
export class FakeChild implements SetupChild {
  answers: string[] = []
  interrupts = 0
  closed = 0
  /** Whether `close()` ends it with 130, as SIGINT ends the real install. */
  endOnClose = true
  stderrText = ""
  private listener?: (prompt: SetupPrompt) => void
  private queued: SetupPrompt[] = []
  private resolve!: (code: number) => void
  done = new Promise<number>((resolve) => (this.resolve = resolve))

  onPrompt(listener: (prompt: SetupPrompt) => void) {
    this.listener = listener
    for (const prompt of this.queued.splice(0)) listener(prompt)
  }
  push(prompt: SetupPrompt) {
    if (this.listener) this.listener(prompt)
    else this.queued.push(prompt)
  }
  answer(text: string) {
    this.answers.push(text)
  }
  interrupt() {
    this.interrupts++
  }
  close() {
    this.closed++
    if (this.endOnClose) this.end(130)
  }
  end(code: number) {
    this.resolve(code)
  }
  stderr() {
    return this.stderrText
  }
}

/** Runs the setup screen for `child` in a 100x30 test renderer; returns frame helpers and what it printed. */
export async function bootSetup(child: FakeChild) {
  // As the real renderer: opentui's default destroys the renderer on the first Ctrl-C.
  const setup = await createTestRenderer({ width: 100, height: 30, useThread: false, exitOnCtrlC: false })
  const core = await import("@opentui/core")
  mock.module("@opentui/core", () => ({ ...core, createCliRenderer: async () => setup.renderer }))
  const { runSetupWith } = await import("../../src/setup/run")
  const outText: string[] = []
  const errText: string[] = []
  const task = runSetupWith(
    child,
    { write: (s) => void outText.push(s) },
    { write: (s) => void errText.push(s) },
  )
  const frames: string[] = []
  const frame = () => setup.captureCharFrame()
  return {
    setup,
    frame,
    input: setup.mockInput,
    task,
    /** What the screen printed on stdout once it was gone. */
    out: () => outText.join(""),
    /** What it printed on stderr. */
    err: () => errText.join(""),
    /** Every frame `until` rendered. */
    frames,
    /** Renders until `pred(frame)` holds; returns the frame, or throws with the last one. */
    async until(pred: (f: string) => boolean, ms = 3000) {
      for (const end = Date.now() + ms; ; await Bun.sleep(20)) {
        if (!setup.renderer.isDestroyed) await setup.renderOnce()
        frames.push(frame())
        if (pred(frames.at(-1)!)) return frames.at(-1)!
        if (Date.now() > end) throw new Error("frame never matched:\n" + frame())
      }
    },
    async stop() {
      if (!setup.renderer.isDestroyed) setup.renderer.destroy()
      child.end(130)
      await task
      mock.restore()
    },
  }
}
