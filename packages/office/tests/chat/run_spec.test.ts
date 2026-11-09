/** The run specs of a person's main chat, a side chat and the profile manager, and the jobs built from them. */
import { expect, setDefaultTimeout, test } from "bun:test"
import path from "node:path"
import { stringify } from "yaml"
import { personInputs, talkingTo } from "../../src/chat/identity.ts"
import { chatJob, managerSpec, mainSpec, sideSpec } from "../../src/chat/run_spec.ts"
import { HarnessError } from "../../src/chat/state.ts"
import { MAIN_CHAT } from "../../src/chat/turns.ts"
import { CompanyGit } from "../../src/company/git.ts"
import { loadRepo } from "../../src/company/loader.ts"
import { writeCompany } from "../../src/company_template/index.ts"
import { Monitor } from "../../src/perm/monitor.ts"
import { FileMemory, type MemoryBase } from "@ngocbh/yian"
import { SecretStore } from "../../src/secrets.ts"
import { LLM_CONFIG } from "../../src/testing/fake_llm.ts"
import { READ_TOOLS } from "../../src/tools/workspace.ts"
import type { OfficeTool } from "../../src/worker/rpc.ts"
import { groupSpecs, JobError, personFlow } from "../../src/worker/job.ts"
import { tempDir } from "../helpers.ts"
import { openStore, question, session, workItem } from "../store/helpers.ts"
import { advanceJob, Recorder, run, waitsOf } from "../worker/helpers.ts"
import { fakeLlm } from "./helpers.ts"

setDefaultTimeout(30_000)

const SECRET = "sk-run-spec-5c1d7e02"

const MINH = {
  handle: "minh",
  name: "Minh",
  kind: "agent",
  title: "Engineer",
  manager: "ngocbh",
  main: "../../shared/flows/chat.yaml",
  harnesses: ["composer"],
  skills: ["deploy"],
}

/** Stands in for `WorkspaceTools`: building a spec's tools never runs the workspace. */
const NO_WORKSPACE = {
  call: (): never => {
    throw new Error("the workspace is never called")
  },
  interrupt: (): never => {
    throw new Error("the workspace is never interrupted")
  },
}

/** A template company (a git repo) with agent minh, his profile and a granted skill; a store with a session of
 *  minh's; the company's git and a monitor over it. */
async function office() {
  const dir = tempDir()
  const root = path.join(dir, "company")
  const worktrees = path.join(dir, "worktrees")
  await writeCompany(root, worktrees, {
    company: "Acme",
    owner: { handle: "ngocbh", name: "Ngoc" },
    extra: {
      "people/minh/person.yaml": Buffer.from(stringify(MINH)),
      "people/minh/memory/profile.md": Buffer.from("# Minh, Engineer\n"),
      "shared/skills/deploy/SKILL.md": Buffer.from("---\nname: deploy\ndescription: Ship it.\n---\nShip.\n"),
    },
  })
  const store = openStore()
  const repo = loadRepo(root)
  return {
    dir,
    root,
    repo,
    store,
    git: new CompanyGit(root, worktrees),
    session: store.createSession(session({ person: "minh" })),
    monitor: new Monitor(root, store, new SecretStore(path.join(dir, "secrets"))),
    defaults: repo.company!.defaults!,
    minh: repo.people.get("minh")!,
  }
}

type Office = Awaited<ReturnType<typeof office>>

/** The status and code of the `HarnessError` `call` throws. */
function refusal(call: () => unknown): [number, string] {
  try {
    call()
  } catch (error) {
    if (error instanceof HarnessError) return [error.status, error.code]
    throw error
  }
  throw new Error("no HarnessError was thrown")
}

/** The identity and file cap of the memory `memory` opens, and its class's contract. */
async function opened(memory: MemoryBase): Promise<unknown[]> {
  const session = await memory.open({ create: true, itemType: null, signal: new AbortController().signal })
  await session.close()
  const contract = (memory.constructor as typeof MemoryBase).contract
  return [contract, session.info.identity, session.info.settings.max_file_chars]
}

/** minh's main spec in `o`. */
function main(o: Office) {
  return mainSpec({ ...o, workspace: NO_WORKSPACE, carried: () => [] })
}

/** A chat job of `spec` for `o`'s session, pinned at the company dir, logging under `o.dir`. */
function job(o: Office, spec: ReturnType<typeof main>, tools: Record<string, Record<string, OfficeTool>>) {
  return chatJob(spec, tools, {
    kind: "chat",
    session: o.session,
    runId: "r1",
    pin: o.root,
    log: path.join(o.dir, "runs", "r1", "log.jsonl"),
    llmConfig: { ...LLM_CONFIG },
    turns: 0,
  })
}

test("the main spec runs the persons main flow with their tools memory and skills", async () => {
  const o = await office()
  const spec = main(o)
  expect(spec.flow).toBe(personFlow("minh", "../../shared/flows/chat.yaml"))
  expect(spec.chat).toBe(MAIN_CHAT)
  expect(Object.keys(spec.groups({ session: o.session, runId: "r1" }))).toEqual(["toolbox", "workspace", "company"])
  expect(Object.keys(spec.memories)).toEqual(["profile"])
  // minh's memory folder, with the same settings in every company.
  expect(await opened(spec.memories.profile!)).toEqual([FileMemory.contract, "people/minh", 1_000_000n])
  expect(spec.skills).toEqual(["deploy"])
  expect(spec.skills).toEqual(o.minh.skills)
  expect(spec.names).toEqual(["minh", "Minh"])
  expect(spec.inputs).toEqual({
    person: personInputs(o.repo, o.minh),
    talking_to: talkingTo(o.repo, o.minh, o.session.opened_by),
    max_turns: o.defaults.max_turns,
  })
  expect(spec.workspace).toBe(NO_WORKSPACE)
  const owner = o.store.createSession(session({ person: "ngocbh" }))
  const ownerSpec = () => mainSpec({ ...o, session: owner, workspace: NO_WORKSPACE, carried: () => [] })
  // A 422 says which field failed, never its value.
  expect(ownerSpec).toThrow(/^the person has no main flow to chat with$/)
  expect(refusal(ownerSpec)).toEqual([422, "not_an_agent"])
})

test("the side spec has read only lookups and room for its seed", async () => {
  const o = await office()
  // A question about someone else's work item: the side chat's work items show it only through the question.
  const item = o.store.createWorkItem(workItem({ title: "Ship v2", requester: "ngocbh", assignee: "lan" }))
  const asked = o.store.addQuestion(question(o.session.id, { work_item_id: item.id }))
  const spec = sideSpec({ ...o, workspace: NO_WORKSPACE, question: asked })
  expect(spec.flow).toBe("shared/flows/side_chat.yaml")
  expect(spec.chat).toBe(MAIN_CHAT)
  const groups = spec.groups({ session: o.session, runId: "r1" })
  expect(Object.keys(groups)).toEqual(["workspace", "work_items"])
  expect(Object.keys(groups.workspace!)).toEqual([...READ_TOOLS])
  const listed = JSON.parse(groups.work_items!.list_work_items!.call({}) as string) as { title: string }[]
  expect(listed.map((i) => i.title)).toEqual(["Ship v2"])
  expect(spec.skills).toEqual([])
  expect(await opened(spec.memories.profile!)).toEqual([FileMemory.contract, "people/minh", 1_000_000n])
  expect(spec.names).toEqual(["minh", "Minh"])
  expect(spec.inputs).toEqual({
    person: personInputs(o.repo, o.minh),
    talking_to: talkingTo(o.repo, o.minh, o.session.opened_by),
    max_turns: o.defaults.max_turns,
    history_budget: o.defaults.side_seed_max_chars + 32000,
  })
  const nobody = o.store.createSession(session({ person: "nobody" }))
  const missing = () => sideSpec({ ...o, session: nobody, workspace: NO_WORKSPACE, question: undefined })
  expect(missing).toThrow(HarnessError)
  expect(refusal(missing)).toEqual([422, "not_found"])
})

test("the side specs parent is the cards run and node", async () => {
  const o = await office()
  const asked = o.store.addQuestion(question(o.session.id, { run_id: "run-card", node_id: "chat#0/ask" }))
  const spec = sideSpec({ ...o, workspace: NO_WORKSPACE, question: asked })
  expect(spec.parent).toEqual({ run_id: "run-card", node: "chat#0/ask" })
  expect(job(o, spec, spec.groups({ session: o.session, runId: "r1" })).parent).toEqual(spec.parent!)
  const unasked = sideSpec({ ...o, workspace: NO_WORKSPACE, question: undefined })
  expect(unasked.parent).toBeNull()
  expect(job(o, unasked, unasked.groups({ session: o.session, runId: "r1" })).parent).toBeNull()
  const mainChat = main(o)
  expect(mainChat.parent ?? null).toBeNull()
  expect(job(o, mainChat, mainChat.groups({ session: o.session, runId: "r1" })).parent).toBeNull()
  expect(managerSpec({ repo: o.repo, tools: {} }).parent ?? null).toBeNull()
})

test("an advance job carries no parent", async () => {
  const o = await office()
  const asked = o.store.addQuestion(question(o.session.id, { run_id: "run-card", node_id: "chat#0/ask" }))
  const spec = sideSpec({ ...o, workspace: NO_WORKSPACE, question: asked })
  const built = chatJob(spec, spec.groups({ session: o.session, runId: "r1" }), {
    kind: "advance",
    session: o.session,
    runId: "r1",
    pin: o.root,
    log: path.join(o.dir, "runs", "r1", "log.jsonl"),
    llmConfig: { ...LLM_CONFIG },
    turns: 1,
  })
  expect(built.kind).toBe("advance")
  expect(built.parent).toBeNull()
})

test("the manager spec has only the profile tools", async () => {
  const o = await office()
  const profile: Record<string, OfficeTool> = { read_profile: { description: "Reads.", call: () => "" } }
  const spec = managerSpec({ repo: o.repo, tools: profile })
  expect(spec.flow).toBe("shared/flows/profile_manager.yaml")
  expect(spec.chat).toBe(MAIN_CHAT)
  expect(spec.groups({ session: o.session, runId: "r1" })).toEqual({ profile })
  expect([spec.memories, spec.skills]).toEqual([{}, []])
  expect(spec.inputs).toEqual({ max_turns: o.defaults.max_turns })
})

test("a new chats job starts with an empty history", async () => {
  const o = await office()
  const spec = main(o)
  const tools = spec.groups({ session: o.session, runId: "r1" })
  const llmConfig = { ...LLM_CONFIG, api_key: SECRET }
  const args = {
    kind: "chat" as const,
    session: o.session,
    runId: "r1",
    pin: o.root,
    log: path.join(o.dir, "runs", "r1", "log.jsonl"),
    llmConfig,
    turns: 3,
  }
  const built = chatJob(spec, tools, args)
  expect(built.inputs).toEqual({ ...spec.inputs, summary: "", history: [], turns: 3 })
  expect(built.groups).toEqual(groupSpecs(tools))
  expect(Object.hasOwn(built.groups, "ask_user")).toBe(false)
  expect(built.memory).toEqual(["profile"])
  expect(built.llm_config).toEqual(llmConfig)
  expect([built.kind, built.skills, built.flow, built.pin, built.log]).toEqual([
    "chat",
    spec.skills,
    spec.flow,
    o.root,
    args.log,
  ])
  expect([built.run_id, built.session_id, built.person]).toEqual(["r1", o.session.id, "minh"])
  const { llm_config: _llm, ...rest } = built
  expect(JSON.stringify(rest)).not.toContain(SECRET)
  let thrown: unknown
  try {
    chatJob(spec, tools, { ...args, log: "runs/r1/log.jsonl" })
  } catch (error) {
    thrown = error
  }
  expect(thrown).toBeInstanceOf(JobError)
  expect((thrown as JobError).message).not.toContain(SECRET)
})

test("a job built with a seed carries it and an empty history", async () => {
  const o = await office()
  const spec = main(o)
  const tools = spec.groups({ session: o.session, runId: "r1" })
  const args = {
    kind: "chat" as const,
    session: o.session,
    runId: "r1",
    pin: o.root,
    log: path.join(o.dir, "runs", "r1", "log.jsonl"),
    llmConfig: { ...LLM_CONFIG },
    turns: 2,
  }
  const seed = { log: path.join(o.dir, "runs", "r0", "log.jsonl"), env: { PATH: "/bin" }, cancel: true }
  const built = chatJob(spec, tools, { ...args, seed })
  expect(built.seed).toEqual(seed)
  expect(built.inputs.history).toEqual([])
  expect(built.inputs.summary).toBe("")
  expect(chatJob(spec, tools, args).seed).toBeNull()
})

test("chat job carries its deliveries and advance", async () => {
  const o = await office()
  const spec = main(o)
  const tools = spec.groups({ session: o.session, runId: "r1" })
  const args = {
    kind: "advance" as const,
    session: o.session,
    runId: "r1",
    pin: o.root,
    log: path.join(o.dir, "runs", "r1", "log.jsonl"),
    llmConfig: { ...LLM_CONFIG },
    turns: 1,
  }
  const send = { id: "d1", op: "send" as const, inbox: "chat", event: { role: "user", parts: ["hi"] } }
  const built = chatJob(spec, tools, { ...args, deliver: [send], advance: false })
  expect([built.deliver, built.advance]).toEqual([[send], false])
  const plain = chatJob(spec, tools, args)
  expect([plain.deliver, plain.advance]).toEqual([[], true])
})

test("a job built from a spec runs its flow in a worker", async () => {
  const o = await office()
  const fake = await fakeLlm()
  fake.script({ content: "Hi." })
  const spec = main(o)
  const tools = spec.groups({ session: o.session, runId: "r1" })
  const chat = job(o, spec, tools)
  const first = await run(chat, new Recorder({ tools, memories: spec.memories }), { env: fake.env() })
  expect(first.outcome?.status).toBe("waiting")
  expect(waitsOf(first).map((wait) => wait.node)).toEqual(["chat#0/heard"])
  const said = { role: "user", parts: [{ type: "text", text: "hello" }] }
  const next = await run(
    advanceJob(chat, { deliver: [{ id: "s1", op: "send", inbox: "messages", event: said }] }),
    new Recorder({ tools, memories: spec.memories }),
    { env: fake.env() },
  )
  expect(fake.requests().length).toBe(1)
  // The profile reached the reply's system prompt through the profile memory, and the skill through the job's skills.
  const [system] = fake.requests()[0]!.messages as { role: string; content: string }[]
  expect(system!.role).toBe("system")
  expect(system!.content).toContain("Your profile, in the memory below,")
  const frame = '<memory name="profile">\n# Minh, Engineer\n\n</memory>'
  expect(system!.content).toContain(`older turns (empty while it is short): \n\n${frame}`)
  expect(JSON.stringify(fake.requests()[0])).toContain("Ship it.")
  expect(next.outcome?.status).toBe("waiting")
  expect(waitsOf(next).map((wait) => wait.node)).toEqual(["chat#1/heard"])
})
