/** `opencorp init`'s interview: what the model is told, the draft without a terminal, the summary the owner
 *  confirms, the questions the model asks the owner, and the init flow run with the fake model. */
import path from "node:path"
import { expect, setDefaultTimeout, test } from "bun:test"
import { loadFlow } from "@ngocbh/yian"
import { checkPassword } from "../../src/auth/passwords.ts"
import { Provider } from "../../src/chat/provider.ts"
import { type Draft, type InitOutput, draftFromOutput, draftProblems } from "../../src/company/draft.ts"
import { readFlow } from "../../src/company/flow_yaml.ts"
import type { Owner } from "../../src/company_template/index.ts"
import initYaml from "../../src/install/flows/init.yaml" with { type: "file" }
import {
  Asking, CHANGE, CONFIRM, CREATE, type Known, ModelError, REMOTE, WHAT_TO_CHANGE, askUser, confirm, facts,
  fallbackDraft, initFlow, runInitFlow, summary,
} from "../../src/install/interview.ts"
import type { LoginDefaults } from "../../src/install/onboard.ts"
import { KeyboardInterrupt, OnboardError, type Prompter, TRIES, clean } from "../../src/install/prompts.ts"
import { pyJson } from "../../src/perm/redact.ts"
import { embedded } from "../../src/platform.ts"
import { writePrivate } from "../../src/secrets.ts"
import { LLM_CONFIG, type ScriptedReply } from "../../src/testing/fake_llm.ts"
import { fakeLlm } from "../chat/helpers.ts"
import { tempDir } from "../helpers.ts"
import { Script, flowReplies } from "./helpers.ts"

// The init flow runs scrypt and many model rounds.
setDefaultTimeout(30_000)

const login: LoginDefaults = () => ["Me", "me"]

const ME: Owner = { handle: "ngocbh", name: "Hong Ngoc Bui", title: "CEO" }
const GOOD: Draft = {
  company: "Acme",
  owner: ME,
  team: [
    { name: "Minh", handle: "minh", title: "Engineer", about: "Writes the backend." },
    { name: "Lan", handle: "lan", title: "QA", about: "" },
  ],
}
const OUT: InitOutput = {
  company: "Acme",
  owner: { name: "Hong Ngoc Bui", handle: "ngocbh", title: "CEO" },
  teammates: [{ name: "Minh", handle: "minh", title: "Engineer", about: "Writes the backend." }],
}
const PASSWORD = "pw-sentinel-5d1f"
const FLOW = embedded(initYaml).toString("utf8")
const RAW = readFlow(FLOW) as any // the YAML as written; readFlow leaves it untyped
const MAX = RAW.nodes.rounds.max as number

/** The fake model, and a provider for it. */
async function model(): Promise<{ fake: Awaited<ReturnType<typeof fakeLlm>>; provider: Provider }> {
  const fake = await fakeLlm()
  return { fake, provider: Provider.parse({ llm_config: LLM_CONFIG, env: fake.env() }) }
}

/** An interview round that returns `output` without asking or checking. */
function roundReplies(output: InitOutput): ScriptedReply[] {
  return [{ content: "Done." }, { tool_calls: [{ name: "Record", arguments: output }] }]
}

/** The owner for one accepted run: `answers` to the model's questions, "1" (create) to confirm, `PASSWORD` twice,
 *  and `remote` typed (none when empty). */
function owner(answers: string[] = [], remote = ""): Script {
  return new Script([...answers, "1", PASSWORD, PASSWORD, remote || "1"])
}

function run(provider: Provider, prompter: Prompter, known: Known = {}) {
  return runInitFlow(provider, prompter, known, login)
}

/** Each message's content in a model request, as text. */
function contents(request: Record<string, unknown>): string[] {
  return (request.messages as { content: unknown }[]).map((m) =>
    typeof m.content === "string" ? m.content : JSON.stringify(m.content),
  )
}

/** What `promise` rejects with; fails the test when it resolves. */
async function rejection(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise
  } catch (error) {
    return error as Error
  }
  throw new Error("expected a rejection")
}

/** What `call` throws; fails the test when it returns. */
function refusal(call: () => void): Error {
  try {
    call()
  } catch (error) {
    return error as Error
  }
  throw new Error("expected a throw")
}

/** A prompter whose input has ended. */
class Closed extends Script {
  static readonly error = new OnboardError("no answer to 'Company?' (stdin closed)")

  override async ask(question: string): Promise<string> {
    this.seen.push(question)
    throw Closed.error
  }

  override async choose(question: string): Promise<string> {
    this.seen.push(question)
    throw Closed.error
  }
}

/** The state of a run whose owner gives `replies`, and its prompter. */
function confirming(...replies: string[]): { state: Asking; prompter: Script } {
  const prompter = new Script(replies)
  return { state: new Asking(prompter), prompter }
}

function badOutput(handle = "Minh"): InitOutput {
  return { ...OUT, teammates: [{ ...OUT.teammates[0]!, handle }] }
}

test("the flow takes what init knows and the remote flag", async () => {
  const flow = await loadFlow(FLOW, { sourceLabel: "install/flows/init.yaml" })
  expect(Object.fromEntries(flow.input.map((p) => [p.name, p.contract?.type.kind]))).toEqual({
    known: "str",
    remote: "str",
  })
})

test("known facts are the given flags and suggestions but never the remote", () => {
  const known: Known = { company: "Acme", agent_handle: "bo", remote: "https://user:secret@example.com/acme.git" }
  expect(facts(known, login)).toEqual({
    given: { company: "Acme", agent_handle: "bo" },
    suggested: { name: "Me", handle: "me", title: "CEO" },
  })
})

test("without flags the fallback is a default company", () => {
  expect(fallbackDraft({}, login)).toEqual({
    company: "My company",
    owner: { handle: "me", name: "Me", title: "CEO" },
    team: [{ name: "Minh", handle: "minh", title: "Engineer", about: "" }],
  })
})

test("the fallback uses every flag", () => {
  const known: Known = { company: "Acme", name: "Lan", handle: "lan", title: "CTO", agent: "Bo", agent_handle: "bo-1" }
  expect(fallbackDraft(known, login)).toEqual({
    company: "Acme",
    owner: { handle: "lan", name: "Lan", title: "CTO" },
    team: [{ name: "Bo", handle: "bo-1", title: "Engineer", about: "" }],
  })
})

test("the fallback slugs the agents name for a handle", () => {
  expect(fallbackDraft({ agent: "Minh Anh" }, login).team[0]!.handle).toBe("minh-anh")
  expect(fallbackDraft({ agent: "Đ" }, login).team[0]!.handle).toBe("agent")
})

test("a fallback with problems names the flag to pass", () => {
  const taken = refusal(() => fallbackDraft({ handle: "minh" }, login))
  expect(taken).toBeInstanceOf(OnboardError)
  expect(taken.message).toMatch(/@minh is taken; pass --agent-handle/)
  const bad = refusal(() => fallbackDraft({ handle: "Me" }, login))
  expect(bad).toBeInstanceOf(OnboardError)
  expect(bad.message).toMatch(/@Me .*; pass --handle/)
})

test("the summary lists the company you and each teammate", () => {
  expect(summary(GOOD)).toEqual([
    "Company: Acme", "You: Hong Ngoc Bui (@ngocbh), CEO", "Teammates:",
    "  Minh (@minh), Engineer: Writes the backend.", "  Lan (@lan), QA",
  ])
  expect(summary({ company: "Acme", owner: ME, team: [] }).at(-1)).toBe("Teammates: none yet")
})

test("the summary strips control characters from model text", () => {
  const answers: Draft = {
    company: "Ac\x1b[2Jme",
    owner: { handle: "ngocbh", name: "Hong\nNgoc\x07 Bui" },
    team: [{ name: "Mi\rnh", handle: "minh", title: "Eng\tineer", about: "Writes\x7f the backend." }],
  }
  expect(summary(answers)).toEqual([
    "Company: Ac[2Jme", "You: Hong Ngoc Bui (@ngocbh), CEO", "Teammates:",
    "  Mi nh (@minh), Eng ineer: Writes the backend.",
  ])
})

test("clean turns line breaks and tabs into spaces and drops other control characters", () => {
  expect(clean("a\nb\rc\td\x00e\x1bf\x7fg")).toBe("a b c defg")
})

test("clean drops c1 control characters which some terminals read as escapes", () => {
  expect(clean("a\x80b\x9b2Jc\x9fd\xa0e")).toBe("ab2Jcd\xa0e")
})

test("the fallback needs an account even with every flag", () => {
  const unknown: LoginDefaults = () => {
    throw new OnboardError("user id 501 has no account in the password database")
  }
  const known: Known = { company: "Acme", name: "Lan", handle: "lan", title: "CTO", agent: "Bo", agent_handle: "bo" }
  const error = refusal(() => fallbackDraft(known, unknown))
  expect(error).toBeInstanceOf(OnboardError)
  expect(error.message).toMatch(/no account/)
})

test("the interview asks on the terminal and returns the flows output", async () => {
  const { fake, provider } = await model()
  fake.script(...flowReplies("What's the company called?", OUT))
  const prompter = owner(["Acme"])
  const out = await run(provider, prompter)
  expect({ company: out.company, owner: out.owner, teammates: out.teammates }).toEqual(OUT)
  expect(await checkPassword(PASSWORD, out.password_hash)).toBe(true)
  expect(out.remote).toBe("")
  expect(prompter.seen).toContain("What's the company called?")
  expect(contents(fake.requests()[1]!).at(-1)).toContain("Acme")
  const after = prompter.seen.slice(prompter.seen.indexOf(CONFIRM))
  expect(after.filter((line) => line.startsWith("Step "))).toEqual(["Step 3 of 5: Password", "Step 4 of 5: Remote"])
})

test.each(["2", "Founder"])("a question with options is a list with a way to type an answer [%s]", async (answer) => {
  const { fake, provider } = await model()
  fake.script(...flowReplies("Your title?", OUT, ["CEO", "Founder"]))
  const prompter = owner([answer])
  await run(provider, prompter)
  expect([prompter.seen[0], prompter.offered[0], prompter.typed[0]]).toEqual(["Your title?", ["CEO", "Founder"], true])
  expect(contents(fake.requests()[1]!).at(-1)).toBe("Founder")
})

test("a typed answer to a question with options goes back as typed", async () => {
  const { fake, provider } = await model()
  fake.script(...flowReplies("Your title?", OUT, ["CEO", "Founder"]))
  const prompter = owner(["Chair"])
  await run(provider, prompter)
  expect(prompter.seen.filter((line) => line === "Your title?")).toHaveLength(1)
  expect(contents(fake.requests()[1]!).at(-1)).toBe("Chair")
})

test("questions and options are asked without control characters", async () => {
  const { fake, provider } = await model()
  fake.script(...flowReplies("Clear\x1b[2J?", OUT, ["a\x9bb", "c"]))
  const prompter = owner(["2"])
  await run(provider, prompter)
  expect([prompter.seen[0], prompter.offered[0]]).toEqual(["Clear[2J?", ["ab", "c"]])
})

test("an option goes back to the model as it wrote it", async () => {
  const { fake, provider } = await model()
  fake.script(...flowReplies("Pick?", OUT, ["a\x9bb", "c"]))
  await run(provider, owner(["1"]))
  expect(contents(fake.requests()[1]!).at(-1)).toBe("a\x9bb")
})

test("a long option is offered and goes back whole", async () => {
  const label = Array(4).fill("Keep the CI pipeline we have and add a nightly run").join(" ")
  const prompter = new Script(["1"])
  expect(await askUser({ question: "Which plan?", options: [label, "b"] }, new Asking(prompter))).toBe(label)
  expect(prompter.offered).toEqual([[label, "b"]])
  expect(prompter.typed).toEqual([true])
})

/** A prompter whose lists give an empty answer, as an empty line does when there's no default. */
class Blank extends Script {
  override async choose(question: string): Promise<string> {
    this.seen.push(question)
    return ""
  }
}

test("an answer that isnt an option goes back as typed", async () => {
  const { fake, provider } = await model()
  fake.script(...flowReplies("Pick?", OUT, ["a", "b"]))
  await run(provider, new Blank([PASSWORD, PASSWORD, ""]))
  expect(contents(fake.requests()[1]!).at(-1)).toBe("")
})

test("the providers env is set only during the run", async () => {
  const before = { ...process.env }
  const { fake, provider } = await model()
  fake.script(...flowReplies("Company?", OUT))
  await run(provider, owner(["Acme"]))
  expect({ ...process.env }).toEqual(before)
  expect(fake.requests()).toHaveLength(4)
})

/** A prompter whose questions throw `error`. */
class Raising extends Script {
  constructor(readonly error: Error) {
    super()
  }

  override async ask(question: string): Promise<string> {
    this.seen.push(question)
    throw this.error
  }
}

const BOOM = new Error("boom")
const INTERRUPT = new KeyboardInterrupt()

test.each([
  ["error", BOOM],
  ["interrupt", INTERRUPT],
] as const)("the env is restored when the run raises [%s]", async (kind, error) => {
  const before = { ...process.env }
  const { fake, provider } = await model()
  fake.script({ tool_calls: [{ name: "ask_user", arguments: { question: "Company?" } }] })
  const raised = await rejection(run(provider, new Raising(error)))
  if (kind === "error") {
    expect(raised).toBeInstanceOf(ModelError)
    expect(raised.message).toContain("boom")
  } else {
    expect(raised).toBe(INTERRUPT)
  }
  expect(fake.requests()).toHaveLength(1)
  expect({ ...process.env }).toEqual(before)
})

test("a failed run says the model couldnt run the interview", async () => {
  const { fake, provider } = await model()
  fake.script({ error: 500 })
  const error = await rejection(run(provider, new Script()))
  expect(error).toBeInstanceOf(ModelError)
  expect(error.message).toMatch(/^the model couldn't run the interview: /)
  expect(fake.requests()).toHaveLength(1)
})

test("when the owners input ends its error stops the interview", async () => {
  const { fake, provider } = await model()
  fake.script(...flowReplies("Company?", OUT))
  expect(await rejection(run(provider, new Closed()))).toBe(Closed.error)
  expect(fake.requests()).toHaveLength(1)
})

test("the model is told what is known", async () => {
  const { fake, provider } = await model()
  fake.script(...flowReplies("Company?", OUT))
  await run(provider, owner(["Acme"]), { company: "Acme" })
  expect(contents(fake.requests()[0]!).join("\n")).toContain('"given": {"company": "Acme"}')
})

test("confirm shows the clean draft and accepts on yes", async () => {
  const { state, prompter } = confirming("")
  expect(await confirm({ answers: OUT }, state)).toEqual({ draft: pyJson(OUT, true), changes: "", accepted: true })
  expect(prompter.seen).toEqual([...summary(draftFromOutput(OUT)), CONFIRM])
  expect(prompter.offered).toEqual([[CREATE, CHANGE]])
})

test("confirm sends problems back without asking the owner", async () => {
  const { state, prompter } = confirming()
  expect(await confirm({ answers: badOutput() }, state)).toEqual({
    draft: pyJson(badOutput(), true),
    changes: draftProblems(draftFromOutput(badOutput())).join("\n"),
    accepted: false,
  })
  expect(prompter.seen).toEqual([])
})

test.each(["2", CHANGE])("confirm turns the owners change into changes [%s]", async (pick) => {
  const { state, prompter } = confirming(pick, "rename Minh to Bo")
  expect(await confirm({ answers: OUT }, state)).toEqual({
    draft: pyJson(OUT, true), accepted: false, changes: "The owner wants changes: rename Minh to Bo",
  })
  expect(prompter.seen.slice(-2)).toEqual([CONFIRM, WHAT_TO_CHANGE])
})

test("no change given asks the model to ask", async () => {
  expect(await confirm({ answers: OUT }, confirming("2", "").state)).toEqual({
    draft: pyJson(OUT, true), accepted: false, changes: "The owner wants changes; ask what to change",
  })
})

test("an onboard error inside owner prompter is kept for the caller", async () => {
  const state = new Asking(new Closed())
  expect(await rejection(confirm({ answers: OUT }, state))).toBeInstanceOf(OnboardError)
  expect(state.stopped).toBe(Closed.error)
})

test("the interview offers a handle made from the name as an option", () => {
  const prompt: string = RAW.nodes.rounds.nodes.interview.prompt
  expect(prompt.split(/\s+/).filter(Boolean).join(" ")).toContain(
    "Offer one made from the person's name as an option, such as",
  )
})

test("no agent node reads the password or the remote", () => {
  function* agents(nodes: Record<string, any>): Generator<Record<string, any>> {
    for (const node of Object.values(nodes)) {
      if (node.kind === "agent") yield node
      yield* agents(node.nodes ?? {})
    }
  }
  const found = [...agents(RAW.nodes)]
  expect(found.length).toBeGreaterThan(0)
  for (const node of found) {
    const inputs = JSON.stringify(node.input)
    expect(inputs).not.toContain("password")
    expect(inputs).not.toContain("remote")
  }
})

test("the tools problems go back to the model", async () => {
  const { fake, provider } = await model()
  const partial = { company: "Acme", owner: OUT.owner, teammates: [{ name: "Lan", handle: "lan" }] }
  fake.script(
    { tool_calls: [{ name: "check_company", arguments: badOutput() }] }, // its "about"s are ignored
    { tool_calls: [{ name: "check_company", arguments: partial }] }, // no title yet
    ...roundReplies(OUT),
  )
  await run(provider, owner())
  const reply = contents(fake.requests()[1]!).at(-1)!
  expect(reply.startsWith("Problems; ask the owner")).toBe(true)
  expect(reply).toContain("@Minh can't be a handle")
  expect(contents(fake.requests()[2]!).at(-1)).toContain("the teammate @lan needs a title")
})

test("a result with problems goes back to the interview without asking the owner", async () => {
  const { fake, provider } = await model()
  fake.script(...roundReplies(badOutput()), ...roundReplies(OUT))
  const prompter = owner()
  expect((await run(provider, prompter)).teammates).toEqual(OUT.teammates)
  expect(prompter.seen.filter((line) => line === CONFIRM)).toHaveLength(1)
  const second = contents(fake.requests()[2]!).join("\n")
  expect(second).toContain("@Minh can't be a handle")
  expect(second).toContain('"handle": "Minh"')
})

test("the owners changes start the next round from the draft", async () => {
  const { fake, provider } = await model()
  const renamed = { ...OUT, teammates: [{ ...OUT.teammates[0]!, name: "Bo", handle: "bo" }] }
  fake.script(...flowReplies("Company?", OUT), ...roundReplies(renamed))
  const out = await run(provider, new Script(["Acme", "2", "rename Minh to Bo", "1", PASSWORD, PASSWORD, "1"]))
  expect(out.teammates).toEqual(renamed.teammates)
  const second = contents(fake.requests()[4]!).join("\n")
  expect(second).toContain('"name": "Minh"')
  expect(second).toContain("The owner wants changes: rename Minh to Bo")
})

test("the flow gives up after max rounds", async () => {
  const { fake, provider } = await model()
  for (let i = 0; i < MAX; i++) fake.script(...roundReplies(badOutput()))
  const prompter = new Script()
  const error = await rejection(run(provider, prompter))
  expect(error).toBeInstanceOf(OnboardError)
  expect(error.message).toMatch(/didn't settle on a company; run `opencorp init` again/)
  expect(fake.requests()).toHaveLength(2 * MAX)
  expect(prompter.seen).toEqual([])
})

test("when the input ends at the confirmation its error stops the flow", async () => {
  const { fake, provider } = await model()
  fake.script(...roundReplies(OUT))
  expect(await rejection(run(provider, new Closed()))).toBe(Closed.error)
})

test("no usable password stops the flow with that error", async () => {
  const { fake, provider } = await model()
  fake.script(...roundReplies(OUT))
  const error = await rejection(run(provider, new Script(["1", ...Array<string>(TRIES).fill("short")])))
  expect(error).toBeInstanceOf(OnboardError)
  expect(error.message).toBe("no usable password")
})

class InterruptedAtPassword extends Script {
  static readonly error = new KeyboardInterrupt()

  override async secret(): Promise<string> {
    throw InterruptedAtPassword.error
  }
}

test("ctrl c at the password stops the flow and restores the env", async () => {
  const before = { ...process.env }
  const { fake, provider } = await model()
  fake.script(...roundReplies(OUT))
  expect(await rejection(run(provider, new InterruptedAtPassword(["1"])))).toBe(InterruptedAtPassword.error)
  expect({ ...process.env }).toEqual(before)
})

test("the remote flag is used without asking and never sent", async () => {
  const url = "https://user:tok-sentinel-77@example.com/acme.git"
  const { fake, provider } = await model()
  fake.script(...roundReplies(OUT))
  const prompter = new Script(["1", PASSWORD, PASSWORD])
  expect((await run(provider, prompter, { remote: url })).remote).toBe(url)
  expect(prompter.seen).not.toContain(REMOTE)
  expect(JSON.stringify(fake.requests())).not.toContain("tok-sentinel-77")
})

test("init flow gives the draft with the hash and the remote apart", async () => {
  const { fake, provider } = await model()
  // A temp dir is made 0700, as a provider file's folder must be.
  const file = path.join(tempDir(), "provider.json")
  await writePrivate(file, JSON.stringify({ llm_config: provider.llm_config, env: provider.env }))
  fake.script(...roundReplies(OUT))
  const [draft, url] = await initFlow(file, owner([], "git@example.com:a.git"), {}, login)
  expect(draft.company).toBe("Acme")
  expect(await checkPassword(PASSWORD, draft.owner.passwordHash)).toBe(true)
  expect(url).toBe("git@example.com:a.git")
})

test.each([
  ["--company", { company: " " }], ["--name", { name: " " }], ["--handle", { handle: "Me" }],
  ["--agent", { agent: " " }], ["--agent-handle", { agent_handle: "Bad_Handle" }],
] as [string, Known][])("each fallback problem names the flag that sets its field [%s]", (flag, known) => {
  const error = refusal(() => fallbackDraft(known, login))
  expect(error).toBeInstanceOf(OnboardError)
  expect(error.message).toMatch(new RegExp(`; pass ${flag}$`))
})
