import { expect, mock, test } from "bun:test"
import { createTestRenderer } from "@opentui/core/testing"
import { Effect } from "effect"
import { Global } from "../src/core/global"
import { createStub } from "../script/stub"

test("the home screen shows the logo and the prompt against the stub server", async () => {
  const setup = await createTestRenderer({ width: 100, height: 30, useThread: false })
  const core = await import("@opentui/core")
  mock.module("@opentui/core", () => ({ ...core, createCliRenderer: async () => setup.renderer }))

  try {
    const { run } = await import("../src/app")
    const task = Effect.runPromise(run({ ...createStub(), args: {} }).pipe(Effect.provide(Global.layer)))

    // Startup is async (config, sync bootstrap), so render until the home screen settles.
    let frame = ""
    for (let i = 0; i < 100 && !frame.includes("Ask anything"); i++) {
      await Bun.sleep(20)
      await setup.renderOnce()
      frame = setup.captureCharFrame()
    }
    expect(frame).toContain("█▀▀█ █▀▀█ █▀▀█ █▀▀▄")
    expect(frame).toContain("Ask anything")
    expect(frame).not.toContain("Connect a provider")

    setup.renderer.destroy()
    await task
  } finally {
    if (!setup.renderer.isDestroyed) setup.renderer.destroy()
    mock.restore()
  }
})
