/** Loading a job's flow, office tools, skills and profile memory in the worker. */
import fs from "node:fs"
import path from "node:path"
import { expect, setDefaultTimeout, test } from "bun:test"
import { groupSpecs } from "../../src/worker/job.ts"
import { pickSkills } from "../../src/worker/main.ts"
import type { OfficeTool } from "../../src/worker/rpc.ts"
import { fakeLlm, nextRun, TemplateOffice, send, templateJob } from "../chat/helpers.ts"
import { tempDir } from "../helpers.ts"
import { openStore } from "../store/helpers.ts"
import { base, makeJob, makeRegistry, profileMemory, Recorder, run, runWorker, writeFiles } from "./helpers.ts"

setDefaultTimeout(30_000)

const SKILLS = {
  "people/minh/skills/code-review/SKILL.md": "---\nname: code-review\ndescription: Personal review.\n---\nMine.\n",
  "shared/skills/code-review/SKILL.md": "---\nname: code-review\ndescription: Shared review.\n---\nOurs.\n",
  "shared/skills/deploy/SKILL.md": "---\nname: deploy\ndescription: Ship it.\n---\nShip.\n",
}

const CHILD = 'id: echo\nname: echo\ninput:\n  text: !str\noutput: str\nkind: agent\nprompt: "${text}"\n'
const ESCAPE =
  "id: escape\nname: escape\nuses:\n  echo: ../../echo\nnodes:\n  reply:\n    kind: call\n    call: echo\n" +
  "    input:\n      text: hi\noutput: ${reply.output}\n"

// A flow whose one CODE node returns PLANTED from the worker's live environment, which the node shares.
const PLANTED =
  "id: planted\nname: planted\nnodes:\n  peek:\n    kind: code\n    output: Optional(str)\n" +
  '    code: "return process.env.PLANTED ?? null"\noutput: ${peek.output}\n'

/** The parts of a chat request these tests read. */
type ChatRequest = { tools: { function: { name: string } }[]; messages: unknown }

test("office tool groups run in the office", async () => {
  const fake = await fakeLlm()
  fake.script(
    { content: "Working", tool_calls: [{ name: "toolbox_shout", arguments: { text: "hi" } }] },
    { content: "Done." },
  )
  const shout: OfficeTool = {
    description: "Return text in capitals.",
    parameters: { type: "object", required: ["text"], properties: { text: { type: "string" } } },
    call: ({ text }) => String(text).toUpperCase(),
  }
  const tools = { toolbox: { shout } }
  const job = makeJob(base(), "flows/tools.yaml", { groups: groupSpecs(tools) })
  const rec = await run(job, new Recorder({ tools }), { env: fake.env() })
  expect(rec.outcome?.output).toBe("Done.")
  const [first, second] = fake.requests() as [ChatRequest, ChatRequest]
  expect(first.tools.map((t) => t.function.name)).toEqual(["toolbox_shout"])
  expect(JSON.stringify(second.messages)).toContain("HI")
  const toolEvents = rec.frames.filter((f) => f.name === "ToolCallFinished").map((f) => f.data as { name: string })
  expect(toolEvents.map((e) => e.name)).toEqual(["toolbox_shout"])
})

test("a missing group fails before any model call", async () => {
  const fake = await fakeLlm()
  const rec = await run(makeJob(base(), "flows/tools.yaml"), new Recorder(), { env: fake.env() })
  expect(rec.returncode).toBe(1)
  expect(String(rec.outcome?.message)).toStartWith(
    "RangeError: AGENT node 'reply' grants unknown tool or group 'toolbox'",
  )
  expect(fake.requests()).toEqual([])
})

test("a flow reaching outside the pin is refused", async () => {
  const fake = await fakeLlm()
  const where = base()
  fs.writeFileSync(path.join(where.root, "echo.yaml"), CHILD)
  writeFiles(where.pin, { "flows/escape.yaml": ESCAPE })
  const rec = await run(makeJob(where, "flows/escape.yaml", { inputs: {} }), new Recorder(), { env: fake.env() })
  expect(rec.returncode).toBe(1)
  expect(String(rec.outcome?.message)).toStartWith("FlowOutsideRepo")
  expect(fake.requests()).toEqual([])
})

test("pick skills filters and prefers personal skills", () => {
  const pin = writeFiles(path.join(tempDir(), "pin"), SKILLS)
  const picked = pickSkills(pin, "minh", ["code-review", "missing"])
  expect([...picked.keys()]).toEqual(["code-review"])
  expect(picked.get("code-review")?.description).toBe("Personal review.")
  expect(pickSkills(pin, "nobody", ["deploy"]).get("deploy")?.description).toBe("Ship it.")
})

test("only listed skills reach the prompt", async () => {
  const fake = await fakeLlm()
  const where = base()
  writeFiles(where.pin, SKILLS)
  fake.script({ content: "ok" })
  const job = makeJob(where, "flows/skilled.yaml", { skills: ["code-review"] })
  const rec = await run(job, new Recorder(), { env: fake.env() })
  expect(rec.outcome?.status).toBe("succeeded")
  const prompt = JSON.stringify(fake.requests()[0])
  expect(prompt).toContain("Personal review.")
  expect(prompt).not.toContain("Shared review.")
  expect(prompt).not.toContain("Ship it.")
})

test("the profile memory is the office's, bound as a flow input", async () => {
  const fake = await fakeLlm()
  const where = base()
  const memory = profileMemory(path.join(where.root, "memory"), "# Minh\nPrefers terse answers.\n")
  fake.script({ content: "ok" })
  const handlers = new Recorder({ memories: { profile: memory } })
  const job = makeJob(where, "flows/profiled.yaml", {}, handlers)
  expect(job.memory).toEqual(["profile"])
  expect((await run(job, handlers, { env: fake.env() })).outcome?.status).toBe("succeeded")
  const [system] = fake.requests()[0]!.messages as { role: string; content: string }[]
  const recall = '<memory name="profile"># Minh\nPrefers terse answers.\n</memory>'
  expect([system!.role, system!.content]).toEqual(["system", recall])
  // The office made the memory's own files in its folder.
  expect(fs.readFileSync(path.join(where.root, "memory", ".yian", "identity"), "utf8")).toBe("people/minh")
})

test("a flow without the memory input is refused before any model call", async () => {
  const fake = await fakeLlm()
  const where = base()
  const handlers = new Recorder({ memories: { profile: profileMemory(path.join(where.root, "memory"), "# Minh\n") } })
  const rec = await run(makeJob(where, "flows/echo.yaml", {}, handlers), handlers, { env: fake.env() })
  expect(rec.returncode).toBe(1)
  expect(String(rec.outcome?.message)).toContain("profile")
  expect(fake.requests()).toEqual([])
})

test("a planted env file or bunfig preload in the worker cwd is not loaded", async () => {
  const fake = await fakeLlm()
  /** Spawns a worker running the planted flow through the registry, in a session dir holding `files`, with `env`
   *  added; returns its last frame, its exit and the session dir. */
  const peek = async (files: Record<string, string>, env: Record<string, string>) => {
    const where = base()
    writeFiles(where.pin, { "flows/planted.yaml": PLANTED })
    const sessionDir = writeFiles(path.join(where.root, "sessions", "s1"), files)
    const job = makeJob(where, "flows/planted.yaml", { inputs: {} })
    const rec = await runWorker(makeRegistry(openStore()), job, new Recorder(), sessionDir, {
      env: { ...fake.env(), ...env },
    })
    return { frame: rec.outcome!, exit: rec.returncode, sessionDir }
  }
  // The control: PLANTED in the worker's environment does reach the node.
  const control = await peek({}, { PLANTED: "from the env" })
  expect(control.frame.output, String(control.frame.message)).toBe("from the env")
  const { frame, exit, sessionDir } = await peek(
    {
      ".env": "PLANTED=1\n",
      "bunfig.toml": 'preload = ["./evil.ts"]\n',
      "evil.ts": 'import { writeFileSync } from "node:fs"\nwriteFileSync("MARKER", "")\n',
    },
    {},
  )
  expect(frame.type, String(frame.message)).toBe("result")
  expect(frame.status).toBe("succeeded")
  expect(frame.output).toBeNull()
  expect(exit).toBe(0)
  expect(fs.existsSync(path.join(sessionDir, "MARKER"))).toBe(false)
  expect(fake.requests()).toEqual([])
})

test("session memory carries history between runs", async () => {
  const fake = await fakeLlm()
  fake.script({ content: "ok" }, { content: "ok" })
  const first = new TemplateOffice()
  const r1 = templateJob("chat", first, {}, { deliver: [send("n1", "remember the word teal")] })
  expect((await run(r1, first, { env: fake.env() })).outcome?.status).toBe("waiting")
  const r2 = nextRun(r1, {
    seed: { log: r1.log, env: fake.env(), cancel: true },
    deliver: [send("n1", "which word?")],
  })
  expect((await run(r2, new TemplateOffice(), { env: fake.env() })).outcome?.status).toBe("waiting")
  expect(JSON.stringify(fake.requests()[1]!.messages)).toContain("teal")
})
