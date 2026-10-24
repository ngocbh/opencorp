/** The worker's frame loop: the start frame, closing frames, steers after the last frame, and the linger. */
import path from "node:path"
import { expect, setDefaultTimeout, test } from "bun:test"
import { LLM_CONFIG } from "../../src/testing/fake_llm.ts"
import type { Frame } from "../../src/worker/channel.ts"
import { EXIT_FAILED, EXIT_OK, EXIT_ORPHANED, report } from "../../src/worker/main.ts"
import { tempDir, waitFor } from "../helpers.ts"
import { channelPair, makeJob, startWorker, writePin } from "./helpers.ts"

setDefaultTimeout(30_000)

/** A fresh pin and runs folder for a job. */
function base(): { pin: string; runs: string } {
  const root = tempDir()
  return { pin: writePin(path.join(root, "pin")), runs: path.join(root, "runs") }
}

/** A start frame whose job lacks `run_id`, as with an office and worker of different versions. */
function badStart(): Frame {
  const job: Record<string, unknown> = { ...makeJob(base()) }
  delete job.run_id
  return { type: "start", job }
}

test("a bad start frame is an error that never shows the env", async () => {
  const job: Record<string, unknown> = {
    ...makeJob(base(), "flows/echo.yaml", { llm_config: { ...LLM_CONFIG, api_key: "sk-SECRET" } }),
    env: { OPENAI_API_KEY: "sk-SECRET" },
  }
  delete job.run_id
  const { office } = await startWorker()
  await office.send({ type: "start", job })
  const frame = await office.recv()
  expect(frame.type).toBe("error")
  const message = String(frame.message)
  const traceback = String(frame.traceback)
  expect(message).toContain("run_id")
  expect(message).not.toContain("sk-SECRET")
  expect(traceback).not.toContain("sk-SECRET")
  for (const line of traceback.split("\n")) expect(line).toMatch(/^\s+at /)
})

test("after its last frame a worker answers steers until the office closes", async () => {
  const { office, out } = await startWorker()
  await office.send(badStart())
  expect((await office.recv()).type).toBe("error")
  await office.send({ type: "steer", node_id: "reply", text: "too late" })
  expect(await office.recv()).toEqual({ type: "steer_left", node_id: "reply", texts: ["too late"] })
  expect(out.code).toBeUndefined()
  office.closeSend()
  await waitFor(() => out.code !== undefined, { timeout: 5000, what: "the worker to return" })
  expect(out.code).toBe(EXIT_FAILED)
})

test("a worker stops waiting for the office after a while", async () => {
  const { office, out } = await startWorker({ linger: 200 })
  await office.send(badStart())
  expect((await office.recv()).type).toBe("error")
  await waitFor(() => out.code !== undefined, { timeout: 5000, what: "the worker to return" })
  expect(out.code).toBe(EXIT_FAILED)
})

test("a result too large to send becomes an error", async () => {
  const { office, worker } = await channelPair({ maxFrame: 2000 })
  const left = { type: "steer_left", node_id: "reply", texts: ["x"] }
  const code = await report(worker, [left, { type: "result", output: "x".repeat(5000) }], EXIT_OK)
  expect(code).toBe(EXIT_FAILED)
  expect(await office.recv()).toEqual(left)
  const error = await office.recv()
  expect(error.type).toBe("error")
  expect(String(error.message).startsWith("FrameTooLarge")).toBe(true)
})

test("a worker exits 3 when the office closes before the start frame", async () => {
  const { office, out } = await startWorker()
  office.close()
  await waitFor(() => out.code !== undefined, { timeout: 5000, what: "the worker to return" })
  expect(out.code).toBe(EXIT_ORPHANED)
})

test("a frame other than start is an error", async () => {
  const { office } = await startWorker()
  await office.send({ type: "steer", node_id: "x", text: "y" })
  const frame = await office.recv()
  expect(frame.type).toBe("error")
  expect(frame.message).toBe("TypeError: expected a start frame")
})
