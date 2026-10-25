/** The worker job: round trips, refusals with value-free errors, person flows and tool specs from declared tools. */
import { expect, test } from "bun:test"
import { inspect } from "node:util"
import { workspaceToolFunctions } from "../../src/tools/workspace.ts"
import { decode, encode } from "../../src/worker/codec.ts"
import { groupSpecs, JobError, parseJob, personFlow, toolSpec } from "../../src/worker/job.ts"

const BASE = {
  kind: "chat",
  session_id: "s1",
  run_id: "r1",
  person: "minh",
  pin: "/pins/abc",
  flow: "people/minh/../../shared/flows/chat.yaml",
  log: "/runs/r1.jsonl",
}

test("a job round trips through json", () => {
  const job = parseJob({
    ...BASE,
    inputs: { big: 2n ** 64n + 1n, text: "hi" },
    memory: { profile: { store: "profile" } },
    groups: { workspace: [{ name: "shell" }] },
  })
  expect(job.memory.profile).toEqual({ kind: "profile", store: "profile", max_chars: 32000, llm_config: null })
  const shell = { name: "shell", description: "", parameters: { type: "object", properties: {} } }
  expect(job.groups.workspace).toEqual([shell])
  expect(job.inputs.big).toBe(2n ** 64n + 1n)
  expect(job.skills).toEqual([])
  expect(job.num_workers).toBe(8)
  expect(job.llm_config).toBeNull()
  expect(parseJob(decode(encode(job)))).toEqual(job)

  const plain = parseJob(BASE)
  expect(plain.inputs).toEqual({})
  // Defaults are fresh per parse, so one job's change can't reach another.
  plain.inputs.x = 1
  plain.skills.push("s")
  expect(parseJob(BASE).inputs).toEqual({})
  expect(parseJob(BASE).skills).toEqual([])
})

test("bad jobs are refused", () => {
  const cases: [Record<string, unknown>, string][] = [
    [{ pin: "pins/abc" }, "pin"],
    [{ log: "r1.jsonl" }, "log"],
    [{ flow: "/etc/flow.yaml" }, "flow"],
    [{ groups: { ask_user: [] } }, "groups"],
    [{ groups: { ask: [] } }, "groups"],
    [{ extra: 1 }, "an extra field"],
    [{ kind: "debrief" }, "kind"],
    [{ kind: "backward" }, "kind"],
    [{ memory: { session: { kind: "session", storage: "/s.db" } } }, "memory"],
    [{ env: { VLLM_BASE_URL: "http://x/v1" } }, "an extra field"],
    [{ feedback: 1 }, "an extra field"],
    [{ learnable: true }, "an extra field"],
    [{ num_workers: 1.5 }, "num_workers"],
    [{ kind: "resume" }, "kind"],
    [{ advance: false }, "advance"],
    [{ deliver: [{ id: "d1", op: "steer", inbox: "steers", event: "hi" }] }, "deliver"],
    [{ deliver: [{ id: "", op: "cancel" }] }, "deliver"],
    [{ deliver: [{ op: "cancel" }] }, "deliver"],
    [{ deliver: [{ id: "d1", op: "send", inbox: "steers" }] }, "deliver"],
    [{ deliver: [{ id: "d1", op: "send", event: "hi" }] }, "deliver"],
    [{ deliver: [{ id: "d1", op: "complete", call_id: "r1/ask", result: {} }] }, "deliver"],
    [{ deliver: [{ id: "d1", op: "complete", call_id: "r1/ask", result: { output: 1, error: "x" } }] }, "deliver"],
    [{ deliver: [{ id: "d1", op: "complete", call_id: "r1/ask", result: { error: 3 } }] }, "deliver"],
    [{ deliver: [{ id: "d1", op: "complete", result: { output: 1 } }] }, "deliver"],
    [{ deliver: [{ id: "d1", op: "cancel", inbox: "steers" }] }, "deliver"],
  ]
  for (const [change, field] of cases) {
    const label = JSON.stringify(change)
    expect(() => parseJob({ ...BASE, ...change }), label).toThrow(JobError)
    expect(() => parseJob({ ...BASE, ...change }), label).toThrow(new RegExp(`^${field}: `))
  }
})

test("a job carries deliveries and the advance flag", () => {
  const deliver = [
    { id: "d1", op: "send", inbox: "steers", event: "hi" },
    { id: "d2", op: "complete", call_id: "r1/ask", result: { output: "Paris" } },
    { id: "d3", op: "close", inbox: "steers" },
    { id: "d4", op: "interrupt", inbox: "steers" },
    { id: "d5", op: "cancel" },
  ]
  const job = parseJob({ ...BASE, kind: "advance", deliver, advance: false })
  expect(job.kind).toBe("advance")
  expect(job.deliver).toEqual(deliver as typeof job.deliver)
  expect(job.advance).toBe(false)
  expect(parseJob(JSON.parse(JSON.stringify(job)))).toEqual(job)

  const chat = parseJob(BASE)
  expect(chat.deliver).toEqual([])
  expect(chat.advance).toBe(true)
})

test("a bad delivery error holds no input value", () => {
  let caught: unknown
  try {
    parseJob({ ...BASE, deliver: [{ id: "d1", op: "send", inbox: 7, event: "sk-SECRET-123" }] })
  } catch (error) {
    caught = error
  }
  expect(caught).toBeInstanceOf(JobError)
  const error = caught as JobError
  expect(error.message).not.toContain("sk-SECRET-123")
  expect(inspect(error)).not.toContain("sk-SECRET-123")
  expect(error.message).toContain("deliver")
})

test("person flow is relative to the person directory", () => {
  expect(personFlow("minh", "../../shared/flows/chat.yaml")).toBe("people/minh/../../shared/flows/chat.yaml")
})

test("tool spec takes the description and parameters the tool declares", () => {
  const parameters = {
    type: "object",
    properties: {
      path: { type: "string" },
      offset: { type: "integer", default: 0 },
      limit: { anyOf: [{ type: "integer" }, { type: "null" }], default: null },
    },
    required: ["path"],
  }
  const spec = toolSpec("read_file", { description: "Read a file.\n\n`offset` is 0-based.", parameters })
  expect(spec).toEqual({ name: "read_file", description: "Read a file.\n\n`offset` is 0-based.", parameters })

  const empty = { type: "object", properties: {} }
  expect(toolSpec("noop", {})).toEqual({ name: "noop", description: "", parameters: empty })
})

test("tool spec uses the given name", () => {
  const parameters = { type: "object", properties: { text: {} }, required: ["text"] }
  const shout = { description: "Shout it.", parameters }
  const spec = toolSpec("yell", shout)
  expect([spec.name, spec.description, spec.parameters.required]).toEqual(["yell", "Shout it.", ["text"]])
})

test("group specs names tools by their keys", () => {
  const groups = groupSpecs({ workspace: workspaceToolFunctions(async () => "") })
  const names = groups.workspace!.map((s) => s.name)
  expect(names).toEqual(["read_file", "write_file", "edit_file", "list", "search", "shell"])
})

test("a bad job error holds no input value", () => {
  const data = {
    ...BASE,
    llm_config: { api_key: "sk-secret-0123456789" },
    pin: "sk-relative-pin",
    "sk-extra-key": "sk-value",
    groups: { ask_user: [] },
  }
  let caught: unknown
  try {
    parseJob(data)
  } catch (error) {
    caught = error
  }
  expect(caught).toBeInstanceOf(JobError)
  const error = caught as JobError
  expect(error.message).not.toContain("sk-")
  expect(inspect(error)).not.toContain("sk-")
  expect(error.message).toContain("pin")
  expect(error.cause).toBeUndefined()
  expect("cause" in error).toBe(false)
})

test("group specs builds a spec for each tool under its key", () => {
  const groups = groupSpecs({
    workspace: {
      read_file: { description: "Read." },
      shell: { parameters: { type: "object", properties: { cmd: {} } } },
    },
    company: { list_people: {} },
  })
  expect(Object.keys(groups)).toEqual(["workspace", "company"])
  expect(groups.workspace?.map((s) => s.name)).toEqual(["read_file", "shell"])
  expect(groups.workspace?.[0]?.description).toBe("Read.")
  expect(groups.workspace?.[1]?.parameters).toEqual({ type: "object", properties: { cmd: {} } })
  const empty = { type: "object", properties: {} }
  expect(groups.company).toEqual([{ name: "list_people", description: "", parameters: empty }])
})
