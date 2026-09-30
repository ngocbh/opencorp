import { expect, mock, test } from "bun:test"
import { createTestRenderer, type TestRendererSetup } from "@opentui/core/testing"
import { Effect } from "effect"
import { Global } from "../src/core/global"
import { createFakeOffice, createStub } from "../script/stub"

async function renderUntil(setup: TestRendererSetup, text: string) {
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    await Bun.sleep(20)
    await setup.renderOnce()
    if (setup.captureCharFrame().includes(text)) return
  }
  throw new Error(`frame never showed ${JSON.stringify(text)}:\n${setup.captureCharFrame()}`)
}

test("SIGHUP destroys the renderer, clears the title and removes its listener", async () => {
  const setup = await createTestRenderer({ width: 80, height: 24, useThread: false })
  const core = await import("@opentui/core")
  mock.module("@opentui/core", () => ({ ...core, createCliRenderer: async () => setup.renderer }))
  const titles: string[] = []
  const setTitle = setup.renderer.setTerminalTitle.bind(setup.renderer)
  setup.renderer.setTerminalTitle = (title) => {
    titles.push(title)
    setTitle(title)
  }
  const listeners = new Set(process.listeners("SIGHUP"))
  const office = createFakeOffice()

  try {
    const { run } = await import("../src/app")
    // The shape `ac` calls it with: no config, so the defaults apply.
    const task = Effect.runPromise(
      run({ socket: office.socket, cwd: "/tmp/proj", args: {} }).pipe(Effect.provide(Global.layer)),
    )
    await renderUntil(setup, "Ask anything")
    process.emit("SIGHUP")
    await task

    expect(setup.renderer.isDestroyed).toBe(true)
    expect(titles.at(-1)).toBe("")
    expect(process.listeners("SIGHUP").every((listener) => listeners.has(listener))).toBe(true)
  } finally {
    if (!setup.renderer.isDestroyed) setup.renderer.destroy()
    mock.restore()
    office.stop()
  }
})

test("app.exit prints the session epilogue after scoped cleanup", async () => {
  const setup = await createTestRenderer({ width: 80, height: 24, useThread: false })
  const core = await import("@opentui/core")
  mock.module("@opentui/core", () => ({ ...core, createCliRenderer: async () => setup.renderer }))
  const office = createFakeOffice()
  const s = office.state.sessions[0]
  const originalWrite = process.stdout.write.bind(process.stdout)
  let stdout = ""

  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdout += String(chunk)
    return true
  }) as typeof process.stdout.write

  try {
    const { run } = await import("../src/app")
    const task = Effect.runPromise(
      run({ ...createStub(office), args: { sessionID: s.id } }).pipe(Effect.provide(Global.layer)),
    )

    await renderUntil(setup, "@minh · idle")
    // Leaving a chat takes a second press.
    setup.mockInput.pressKey("d", { ctrl: true })
    await renderUntil(setup, "again to leave")
    setup.mockInput.pressKey("d", { ctrl: true })
    await task

    expect(stdout).toContain("@minh · /tmp/proj")
    expect(stdout).toContain(`ac -s ${s.id}`)
  } finally {
    process.stdout.write = originalWrite
    if (!setup.renderer.isDestroyed) setup.renderer.destroy()
    mock.restore()
    office.stop()
  }
})
