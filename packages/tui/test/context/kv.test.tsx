/** @jsxImportSource @opentui/solid */
import { testRender } from "@opentui/solid"
import { expect, spyOn, test } from "bun:test"
import path from "node:path"
import { KVProvider, useKV } from "../../src/context/kv"
import { tmpdir } from "../fixture/fixture"
import { TestTuiContexts } from "../fixture/tui-environment"

async function mount(state: string) {
  let kv: ReturnType<typeof useKV> | undefined
  function Probe() {
    kv = useKV()
    return <box />
  }
  const app = await testRender(() => (
    <TestTuiContexts paths={{ state }}>
      <KVProvider>
        <Probe />
      </KVProvider>
    </TestTuiContexts>
  ))
  for (let i = 0; i < 100 && !kv?.ready; i++) {
    await app.renderOnce()
    await Bun.sleep(10)
  }
  if (!kv) throw new Error("KV provider never mounted")
  return { app, kv }
}

test("a missing state file starts an empty store without logging an error", async () => {
  await using tmp = await tmpdir()
  const error = spyOn(console, "error").mockImplementation(() => {})
  try {
    const { app, kv } = await mount(path.join(tmp.path, "state"))
    expect(kv.ready).toBe(true)
    expect(kv.get("theme", "fallback")).toBe("fallback")
    expect(error).not.toHaveBeenCalled()
    app.renderer.destroy()
  } finally {
    error.mockRestore()
  }
})

test("an unreadable state file is still reported", async () => {
  await using tmp = await tmpdir()
  const state = path.join(tmp.path, "state")
  await Bun.write(path.join(state, "kv.json"), "{not json")
  const error = spyOn(console, "error").mockImplementation(() => {})
  try {
    const { app, kv } = await mount(state)
    expect(kv.ready).toBe(true)
    expect(error).toHaveBeenCalledWith("Failed to read KV state", expect.anything())
    app.renderer.destroy()
  } finally {
    error.mockRestore()
  }
})
