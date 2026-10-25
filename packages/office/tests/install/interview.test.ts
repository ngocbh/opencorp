/** The init interview's helpers: what the model is told, the draft without a terminal, the summary the owner
 *  confirms, and the questions the model asks the owner. */
import { expect, test } from "bun:test"
import { type Draft, type InitOutput, draftFromOutput, draftProblems } from "../../src/company/draft.ts"
import type { Owner } from "../../src/company_template/index.ts"
import {
  Asking, CHANGE, CONFIRM, CREATE, type Known, WHAT_TO_CHANGE, askUser, clean, confirm, facts, fallbackDraft, summary,
} from "../../src/install/interview.ts"
import type { LoginDefaults } from "../../src/install/onboard.ts"
import { OnboardError } from "../../src/install/prompts.ts"
import { pyJson } from "../../src/perm/redact.ts"
import { Script } from "./helpers.ts"

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
const KEY = "sk-SENTINEL-not-a-real-key"
const PASSWORD = "pw-sentinel-5d1f"

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

test("a long option is offered and goes back whole", async () => {
  const label = Array(4).fill("Keep the CI pipeline we have and add a nightly run").join(" ")
  const prompter = new Script(["1"])
  expect(await askUser({ question: "Which plan?", options: [label, "b"] }, new Asking(prompter))).toBe(label)
  expect(prompter.offered).toEqual([[label, "b"]])
  expect(prompter.typed).toEqual([true])
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

test.each([
  ["--company", { company: " " }], ["--name", { name: " " }], ["--handle", { handle: "Me" }],
  ["--agent", { agent: " " }], ["--agent-handle", { agent_handle: "Bad_Handle" }],
] as [string, Known][])("each fallback problem names the flag that sets its field [%s]", (flag, known) => {
  const error = refusal(() => fallbackDraft(known, login))
  expect(error).toBeInstanceOf(OnboardError)
  expect(error.message).toMatch(new RegExp(`; pass ${flag}$`))
})
