import { expect, mock, test } from "bun:test"
import { createTestRenderer, type TestRendererSetup } from "@opentui/core/testing"
import { Effect } from "effect"
import { Global } from "../src/core/global"
import { createTuiResolvedConfig } from "./fixture/tui-runtime"
import { createEventSource, createFetch, directory, json } from "./fixture/tui-sdk"
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
  const events = createEventSource()
  const calls = createFetch((url) => {
    if (url.pathname === "/project/proj_test/directories") return json([])
  })

  try {
    const { run } = await import("../src/app")
    const task = Effect.runPromise(
      run({
        socket: "/tmp/act-none/o.sock",
        cwd: "/tmp/proj",
        url: "http://test",
        directory,
        config: createTuiResolvedConfig(),
        fetch: calls.fetch,
        events: events.source,
        args: {},
      }).pipe(Effect.provide(Global.layer)),
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

test("fatal startup errors set a nonzero exit after scoped cleanup", async () => {
  const setup = await createTestRenderer({ width: 80, height: 24, useThread: false })
  const core = await import("@opentui/core")
  await mock.module("@opentui/core", () => ({ ...core, createCliRenderer: async () => setup.renderer }))
  const events = createEventSource()
  const calls = createFetch((url) => {
    if (url.pathname === "/config")
      return json(
        {
          name: "ConfigRemoteAuthError",
          data: {
            url: "https://example.com",
            remote: "https://config.example.com/opencode.json",
          },
        },
        { status: 400 },
      )
    return undefined
  })
  const originalWrite = process.stderr.write.bind(process.stderr)
  const originalExitCode = process.exitCode ?? 0
  let stderr = ""

  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderr += String(chunk)
    return true
  }) as typeof process.stderr.write

  try {
    const { run } = await import("../src/app")
    const task = Effect.runPromise(
      run({
        socket: "/tmp/act-none/o.sock",
        cwd: "/tmp/proj",
        url: "http://test",
        directory,
        config: createTuiResolvedConfig(),
        fetch: calls.fetch,
        events: events.source,
        args: {},
      }).pipe(Effect.provide(Global.layer)),
    )

    await task
    expect(stderr).toContain("Sign in to https://example.com again, then restart.")
    expect(stderr).not.toContain("opencode auth login")
    expect(stderr).not.toContain("Unexpected server error")
    expect(process.exitCode).toBe(1)
    expect(setup.renderer.isDestroyed).toBe(true)
  } finally {
    process.stderr.write = originalWrite
    process.exitCode = originalExitCode
    if (!setup.renderer.isDestroyed) setup.renderer.destroy()
    mock.restore()
  }
})
