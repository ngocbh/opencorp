/** The scripted fake LLM, driven by real yian runs and over HTTP (Python's `tests/worker/test_fake_llm.py`). */
import fs from "node:fs"
import path from "node:path"
import { expect, setDefaultTimeout, test } from "bun:test"
import { type ComposedFlow, runFlow, tool } from "@ngocbh/yian"
import { ConnectionFile } from "../../src/chat/connections.ts"
import { listModels } from "../../src/chat/models.ts"
import { loadConfined } from "../../src/company/flows.ts"
import { type FakeLLM, LLM_CONFIG } from "../../src/testing/fake_llm.ts"
import { fakeLlm } from "../chat/helpers.ts"
import { tempDir } from "../helpers.ts"

setDefaultTimeout(30_000)

/** A one-agent flow: input `message`, output the agent's reply (Python's `agent_flow`). */
function agentFlow(name: string, node = ""): string {
  return (
    `id: ${name}\nname: ${name}\ninput:\n  message: !str\nnodes:\n  reply:\n    kind: agent\n` +
    `${node}    input:\n      message: \${input.message}\n    output: str\n` +
    `    prompt: "\${message}"\noutput: \${reply.output}\n`
  )
}

const ECHO = agentFlow("echo")
const TOOLS = agentFlow("tools", "    tools: [toolbox]\n")

/** A fresh pin holding `flows/echo.yaml` and `flows/tools.yaml`. */
function pin(): string {
  const root = tempDir()
  fs.mkdirSync(path.join(root, "flows"))
  fs.writeFileSync(path.join(root, "flows", "echo.yaml"), ECHO)
  fs.writeFileSync(path.join(root, "flows", "tools.yaml"), TOOLS)
  return root
}

const flow = (pin: string, name: string) => loadConfined(pin, path.join(pin, "flows", `${name}.yaml`))

/** Runs `flow` against `fake`. */
function run(
  fake: FakeLLM,
  flow: ComposedFlow,
  inputs: Record<string, unknown>,
  options: Parameters<typeof runFlow>[2] = {},
) {
  return runFlow(flow, inputs, { llmConfig: LLM_CONFIG, env: (name) => fake.env()[name], ...options })
}

/** Starts `call` and tracks whether it has settled. */
function track<T>(call: Promise<T>): { settled: () => boolean; done: Promise<T> } {
  let settled = false
  const done = call.finally(() => {
    settled = true
  })
  return { settled: () => settled, done }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** Resolves with `promise`, or rejects after `ms`. */
function within<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`not settled within ${ms} ms`)), ms)
  })
  return Promise.race([promise, late]).finally(() => clearTimeout(timer))
}

const post = (url: string, body?: unknown) =>
  fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body ?? {}) })

test("a plain reply", async () => {
  const fake = await fakeLlm()
  const root = pin()
  fake.script({ content: "hello there" })
  const result = await run(fake, await flow(root, "echo"), { message: "hi" })
  expect([result.status, result.output]).toEqual(["succeeded", "hello there"])
  const requests = fake.requests()
  expect(requests).toHaveLength(1)
  expect(requests[0]!.model).toBe("stub")
  expect(JSON.stringify(requests[0]!.messages)).toContain("hi")
})

test("a tool call then a reply", async () => {
  const fake = await fakeLlm()
  const root = pin()
  const shout = tool({
    name: "shout",
    description: "Return text in capitals.",
    parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
    execute: ({ text }) => String(text).toUpperCase(),
  })
  fake.script(
    { content: "Working", tool_calls: [{ name: "toolbox_shout", arguments: { text: "hi" } }] },
    { content: "Done." },
  )
  const result = await run(fake, await flow(root, "tools"), { message: "go" }, { tools: { toolbox: [shout] } })
  expect([result.status, result.output]).toEqual(["succeeded", "Done."])
  const requests = fake.requests()
  expect(requests).toHaveLength(2)
  const [first, second] = requests as [Record<string, any>, Record<string, any>]
  expect(first.tools.map((t: any) => t.function.name)).toEqual(["toolbox_shout"])
  expect(JSON.stringify(second.messages)).toContain("HI")
})

test("a streamed reply ends with usage", async () => {
  const fake = await fakeLlm()
  const root = pin()
  fake.script({ content: "hello there", usage: { prompt_tokens: 7, completion_tokens: 2 } })
  const chunks: { chunk: string; final: boolean }[] = []
  const events: { type: string; usage?: any }[] = []
  const result = await run(fake, await flow(root, "echo"), { message: "hi" }, {
    onStream: (chunk) => void chunks.push(chunk),
    onEvent: (event) => void events.push(event as { type: string }),
  })
  expect(result.output).toBe("hello there")
  expect(chunks.map((c) => c.chunk).join("")).toBe("hello there")
  expect(chunks.at(-1)!.final).toBe(true)
  const requests = fake.requests()
  expect(requests).toHaveLength(1)
  expect(requests[0]!.stream).toBeTruthy()
  expect(requests[0]!.stream_options).toEqual({ include_usage: true })
  const usages = events.filter((e) => e.type === "ModelCallFinished").map((e) => e.usage)
  expect(usages).toHaveLength(1)
  expect([usages[0].inputTokens, usages[0].outputTokens]).toEqual([7, 2])
})

test("a scripted 500 is hit once and keeps the next reply", async () => {
  const fake = await fakeLlm()
  const root = pin()
  fake.script({ error: 500 }, { content: "later" })
  const failed = await run(fake, await flow(root, "echo"), { message: "hi" })
  expect(failed.status).toBe("failed")
  expect(fake.requests()).toHaveLength(1)
  expect(fake.pending()).toEqual([{ content: "later" }])
  expect((await run(fake, await flow(root, "echo"), { message: "hi" })).output).toBe("later")
})

test("an unmatched request fails loudly once", async () => {
  const fake = await fakeLlm()
  const root = pin()
  const result = await run(fake, await flow(root, "echo"), { message: "hi" })
  expect(result.status).toBe("failed")
  expect(result.failure!.message).toContain("no scripted reply")
  expect(fake.requests()).toHaveLength(1)
})

test("match picks a reply out of order", async () => {
  const fake = await fakeLlm()
  const root = pin()
  fake.script({ match: "second", content: "two" }, { match: "first", content: "one" })
  expect((await run(fake, await flow(root, "echo"), { message: "first" })).output).toBe("one")
  expect((await run(fake, await flow(root, "echo"), { message: "second" })).output).toBe("two")
})

test("the http routes script record and release", async () => {
  const fake = await fakeLlm()
  const base = fake.baseUrl
  const queued = await post(`${base}/_script`, { replies: [{ content: "held", hold: 10 }] })
  expect(await queued.json()).toEqual({ queued: 1 })
  const body = { model: "stub", messages: [{ role: "user", content: "x" }] }
  const call = track(post(`${base}/v1/chat/completions`, body).then((r) => r.json()))
  await fake.waitForRequests(1)
  await sleep(200)
  expect(call.settled()).toBe(false)
  await (await post(`${base}/_release`)).json()
  const got = (await within(call.done, 5_000)) as any
  expect(got.choices[0].message.content).toBe("held")
  expect(await (await fetch(`${base}/_requests`)).json()).toEqual([body])
})

test("hold true waits until release", async () => {
  const fake = await fakeLlm()
  fake.script({ content: "held", hold: true })
  const body = { model: "stub", messages: [{ role: "user", content: "x" }] }
  const call = track(post(`${fake.baseUrl}/v1/chat/completions`, body).then((r) => r.json()))
  await fake.waitForRequests(1)
  await sleep(1_500) // longer than Number(true) seconds
  expect(call.settled()).toBe(false)
  fake.release()
  const got = (await within(call.done, 5_000)) as any
  expect(got.choices[0].message.content).toBe("held")
})

test("it lists its model without recording a chat request", async () => {
  const fake = await fakeLlm()
  const listed = await fetch(`${fake.baseUrl}/v1/models`)
  expect(await listed.json()).toEqual({ object: "list", data: [{ id: "stub", object: "model" }] })
  expect(fake.requests()).toEqual([])
  expect(await (await fetch(`${fake.baseUrl}/_requests`)).json()).toEqual([])
})

test("a connection to it is listed cleanly", async () => {
  const fake = await fakeLlm()
  const listed = await listModels(ConnectionFile.parse({ llm_config: { ...LLM_CONFIG }, env: fake.env() }), "office")
  expect([listed.listed, listed.error, listed.models.map((m) => m.id)]).toEqual([true, null, ["stub"]])
})

test("closing releases held replies and ends open connections", async () => {
  const fake = await fakeLlm()
  fake.script({ content: "held", hold: true })
  const body = { model: "stub", messages: [{ role: "user", content: "x" }] }
  const call = track(post(`${fake.baseUrl}/v1/chat/completions`, body).then((r) => r.text()))
  await fake.waitForRequests(1)
  await within(fake.close(), 2_000)
  await within(call.done.then(() => undefined, () => undefined), 2_000)
  await fake.close()
})

test("a cut reply ends its stream without a finish", async () => {
  const fake = await fakeLlm()
  fake.script({ content: "Half an answer", cut: true })
  const body = {
    model: "stub",
    stream: true,
    stream_options: { include_usage: true },
    messages: [{ role: "user", content: "x" }],
  }
  const text = await (await post(`${fake.baseUrl}/v1/chat/completions`, body)).text()
  const data = text
    .split("\n\n")
    .filter((frame) => frame !== "")
    .map((frame) => frame.replace(/^data: /, ""))
  expect(data).not.toContain("[DONE]")
  const chunks = data.map((frame) => JSON.parse(frame))
  expect(chunks.map((chunk) => chunk.choices[0].delta.content ?? "").join("")).toBe("Half an answer")
  expect(chunks.every((chunk) => chunk.choices.length === 1 && chunk.choices[0].finish_reason === null)).toBe(true)
})
