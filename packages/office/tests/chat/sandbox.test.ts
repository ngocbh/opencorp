/** Harness tests that run workspace calls under the OS sandbox (Python's `tests/chat/test_sandbox.py`). */
import fs from "node:fs"
import path from "node:path"
import { afterAll, expect, setDefaultTimeout, test } from "bun:test"
import type { ToolPart } from "@opencorp/protocol"
import { waitFor } from "../helpers.ts"
import { gone, sandboxAvailable } from "../sandbox/helpers.ts"
import { fakeLlm, makeHarness, noWorkersLeft, status } from "./helpers.ts"

setDefaultTimeout(60_000)
afterAll(noWorkersLeft)

type Harness = Awaited<ReturnType<typeof makeHarness>>

/** The tool parts of session `sid`'s messages, as the transcript shows them. */
function tools(h: Harness, sid: string): ToolPart[] {
  return h.harness.messages(sid).flatMap((m) => m.parts.filter((p): p is ToolPart => p.type === "tool"))
}

/** Starts minh's chat in `h.folder`, waits for its first turn, sends "run it" and waits for the reply's shell call to
 *  run; returns the session's id. */
async function shellRunning(h: Harness): Promise<string> {
  const { id } = await h.harness.startSession("minh", h.folder)
  await waitFor(() => status(h, id) === "idle", { what: "the first turn" })
  await h.harness.prompt(id, "run it")
  await waitFor(() => tools(h, id).some((p) => p.state === "running"), { what: "the shell call" })
  // The part runs from the model call's step; the shell starts a moment later.
  await Bun.sleep(500)
  return id
}

/** A model reply that runs `command` in the shell. */
function shell(command: string) {
  return { tool_calls: [{ name: "shell", arguments: { command } }] }
}

test.if(sandboxAvailable())("esc kills a running shell call", async () => {
  const fake = await fakeLlm()
  fake.script(shell("echo started; sleep 60.1"), { content: "Next." })
  const h = await makeHarness(fake)
  const id = await shellRunning(h)
  const began = performance.now()
  await h.harness.interrupt(id)
  await waitFor(() => status(h, id) === "idle", { what: "the next turn" })
  expect(performance.now() - began).toBeLessThan(10_000)
  const [tool] = tools(h, id)
  expect(tool).toMatchObject({ tool: "shell", state: "completed" })
  expect(JSON.stringify(tool!.output)).toContain("[interrupted]")
  expect(await gone("60.1")).toBe(true)
  expect(fake.requests()).toHaveLength(1)
  await h.harness.prompt(id, "again")
  await fake.waitForRequests(2)
})

test.if(sandboxAvailable())("end kills a running shell call", async () => {
  const fake = await fakeLlm()
  fake.script(shell("sleep 60.3; echo done > after_end.txt"), { content: "Next." })
  const h = await makeHarness(fake)
  const id = await shellRunning(h)
  const began = performance.now()
  await h.harness.end(id)
  await waitFor(() => status(h, id) === "ended", { what: "the end" })
  expect(performance.now() - began).toBeLessThan(10_000)
  expect(await gone("60.3")).toBe(true)
  expect(fs.existsSync(path.join(h.folder, "after_end.txt"))).toBe(false)
})

test.if(sandboxAvailable())("close all kills a running shell call", async () => {
  const fake = await fakeLlm()
  fake.script(shell("sleep 41.7"), { content: "x" })
  const h = await makeHarness(fake)
  await shellRunning(h)
  const began = performance.now()
  await h.harness.closeAll()
  expect(performance.now() - began).toBeLessThan(5_000)
  expect(await gone("41.7")).toBe(true)
})

test.if(sandboxAvailable())("a killed worker leaves no shell call or tool part running", async () => {
  const fake = await fakeLlm()
  fake.script(shell("sleep 43.9"), { content: "x" })
  const h = await makeHarness(fake)
  const id = await shellRunning(h)
  const spawns = h.kinds.length
  process.kill(-h.registry.get(id)!.pgid, "SIGKILL")
  // One worker per run call: the death's retry is one advance.
  await waitFor(() => h.kinds.length > spawns, { what: "the retry" })
  expect(h.kinds[spawns]).toBe("advance")
  await waitFor(() => tools(h, id)[0]?.state === "interrupted", { what: "the cut call shown interrupted" })
  expect(tools(h, id)[0]!.tool).toBe("shell")
  expect(await gone("43.9")).toBe(true)
})
