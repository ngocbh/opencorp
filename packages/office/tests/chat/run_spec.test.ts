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
import { GitProfileStore } from "../../src/profile/store.ts"
import { SecretStore } from "../../src/secrets.ts"
import { LLM_CONFIG } from "../../src/testing/fake_llm.ts"
import { READ_TOOLS } from "../../src/tools/workspace.ts"
import type { OfficeTool } from "../../src/worker/rpc.ts"
import { groupSpecs, JobError, personFlow } from "../../src/worker/job.ts"
import { tempDir } from "../helpers.ts"
import { openStore, session } from "../store/helpers.ts"
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
      "people/minh/profile.md": Buffer.from("# Minh, Engineer\n"),
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
  expect(spec.memory).toEqual({
    profile: { kind: "profile", store: "profile", max_chars: o.defaults.profile_max_chars, llm_config: null },
  })
  expect(Object.keys(spec.stores)).toEqual(["profile"])
  expect(spec.stores.profile).toBeInstanceOf(GitProfileStore)
  expect((spec.stores.profile as GitProfileStore).handle).toBe("minh")
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
  expect(() => mainSpec({ ...o, session: owner, workspace: NO_WORKSPACE, carried: () => [] })).toThrow(
    "ngocbh has no main flow to chat with",
  )
})

test("the side spec has read only lookups and room for its seed", async () => {
  const o = await office()
  const spec = sideSpec({ ...o, workspace: NO_WORKSPACE, question: undefined })
  expect(spec.flow).toBe("shared/flows/side_chat.yaml")
  expect(spec.chat).toBe(MAIN_CHAT)
  const groups = spec.groups({ session: o.session, runId: "r1" })
  expect(Object.keys(groups)).toEqual(["workspace", "work_items"])
  expect(Object.keys(groups.workspace!)).toEqual([...READ_TOOLS])
  expect(spec.skills).toEqual([])
  expect(spec.memory).toEqual({
    profile: { kind: "profile", store: "profile", max_chars: o.defaults.profile_max_chars, llm_config: null },
  })
  expect(spec.stores.profile).toBeInstanceOf(GitProfileStore)
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
  try {
    missing()
  } catch (error) {
    expect([(error as HarnessError).status, (error as HarnessError).code]).toEqual([422, "not_found"])
  }
})

test("the manager spec has only the profile tools", async () => {
  const o = await office()
  const profile: Record<string, OfficeTool> = { read_profile: { description: "Reads.", call: () => "" } }
  const spec = managerSpec({ repo: o.repo, session: o.session, tools: profile })
  expect(spec.flow).toBe("shared/flows/profile_manager.yaml")
  expect(spec.chat).toBe(MAIN_CHAT)
  expect(spec.groups({ session: o.session, runId: "r1" })).toEqual({ profile })
  expect([spec.memory, spec.stores, spec.skills]).toEqual([{}, {}, []])
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
  expect(built.memory.profile!.llm_config).toEqual(llmConfig)
  expect(spec.memory.profile!.llm_config).toBeNull()
  expect(built.llm_config).toEqual(llmConfig)
  expect([built.kind, built.skills, built.flow, built.pin, built.log]).toEqual([
    "chat",
    spec.skills,
    spec.flow,
    o.root,
    args.log,
  ])
  expect([built.run_id, built.session_id, built.person]).toEqual(["r1", o.session.id, "minh"])
  const { llm_config: _llm, memory, ...rest } = built
  const { llm_config: _profile, ...profile } = memory.profile!
  expect(JSON.stringify([rest, profile])).not.toContain(SECRET)
  let thrown: unknown
  try {
    chatJob(spec, tools, { ...args, log: "runs/r1/log.jsonl" })
  } catch (error) {
    thrown = error
  }
  expect(thrown).toBeInstanceOf(JobError)
  expect((thrown as JobError).message).not.toContain(SECRET)
})

test("a job built from a spec runs its flow in a worker", async () => {
  const o = await office()
  const fake = await fakeLlm()
  fake.script({ content: "Hi." })
  const spec = main(o)
  const tools = spec.groups({ session: o.session, runId: "r1" })
  const chat = job(o, spec, tools)
  const first = await run(chat, new Recorder({ tools, stores: spec.stores }), { env: fake.env() })
  expect(first.outcome?.status).toBe("waiting")
  expect(waitsOf(first).map((wait) => wait.node)).toEqual(["chat#0/heard"])
  const said = { role: "user", parts: [{ type: "text", text: "hello" }] }
  const next = await run(
    advanceJob(chat, { deliver: [{ id: "s1", op: "send", inbox: "messages", event: said }] }),
    new Recorder({ tools, stores: spec.stores }),
    { env: fake.env() },
  )
  expect(fake.requests().length).toBe(1)
  // The profile reached the reply through the profile store, and the skill through the job's skills.
  const request = JSON.stringify(fake.requests()[0])
  expect(request).toContain("# Minh, Engineer")
  expect(request).toContain("Ship it.")
  expect(next.outcome?.status).toBe("waiting")
  expect(waitsOf(next).map((wait) => wait.node)).toEqual(["chat#1/heard"])
})
