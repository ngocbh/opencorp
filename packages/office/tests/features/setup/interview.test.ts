/** `opencorp init`'s interview: what the model is told, the draft without a chat, and the interview as a chat with
 *  OpenCorp, a built-in session handed to the chat init was given, whose result is the company the owner accepted. */
import fs from "node:fs"
import path from "node:path"
import { expect, setDefaultTimeout, test } from "bun:test"
import { lockFile } from "@ngocbh/yian/platform"
import type { Draft } from "../../../src/company/draft.ts"
import type { BuiltinSession, CardAnswer, ChatEnd } from "../../../src/runtime/sessions/builtin.ts"
import { OWNER } from "../../../src/server/local/host.ts"
import initYaml from "../../../src/features/setup/flows/init.yaml" with { type: "file" }
import {
  facts,
  fallbackDraft,
  INTERVIEW_FIRST,
  interview,
  type InterviewChat,
  type Known,
} from "../../../src/features/setup/interview.ts"
import { type LoginDefaults, setupConnectionFile } from "../../../src/features/setup/onboard.ts"
import { KeyboardInterrupt, OnboardError, clean } from "../../../src/features/setup/prompts.ts"
import { ACCEPTED, CHANGE, CREATE } from "../../../src/features/setup/tools/propose_company.ts"
import { embedded } from "../../../src/platform.ts"
import { LLM_CONFIG } from "../../../src/testing/fake_llm.ts"
import { writePrivate } from "../../../src/util/private_files.ts"
import { pyJson } from "../../../src/util/redact.ts"
import { fakeLlm } from "../chat/helpers.ts"
import { tempDir, waitFor } from "../../helpers.ts"
import { cardBinding, hostChat } from "./helpers.ts"

// The no-office host's worker runs the flow with the fake model.
setDefaultTimeout(60_000)

const login: LoginDefaults = () => ["Me", "me"]
const KEY = "sk-ant-sentinel-1c9e04b7a2d6"
const CEO = { name: "Hong Ngoc Bui", handle: "ngocbh", title: "CEO" }
const MINH = { name: "Minh", handle: "minh", title: "Engineer", about: "Writes the backend." }
const ACME = { company: "Acme", owner: CEO, teammates: [MINH] }
const DRAFT: Draft = { company: "Acme", owner: CEO, team: [MINH] }
const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/
const YES: CardAnswer = { value: CREATE, typed: false }
const NO: CardAnswer = { value: CHANGE, typed: false }

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

/** An office whose setup connection is `provider`: its folder, the connection's `file` and where init's sessions
 *  go. */
async function office(provider: Record<string, unknown>): Promise<{ office: string; file: string; sessions: string }> {
  const office = path.join(tempDir(), "office")
  // 0700, as a connection's folder must be.
  fs.mkdirSync(path.join(office, "connections"), { recursive: true, mode: 0o700 })
  const file = setupConnectionFile(office)
  await writePrivate(file, JSON.stringify(provider))
  return { office, file, sessions: path.join(office, "setup") }
}

/** A chat that binds the session's tools as the host does, the owner answering its cards with `answers`, calls
 *  propose_company with each of `proposals`, and ends as `end` says. It keeps each session it was given, and what each
 *  call returned. */
function chat(
  proposals: Record<string, unknown>[] = [],
  { answers = [], end = { status: "ended", error: null } }: { answers?: (CardAnswer | "dontAsk")[]; end?: ChatEnd } = {},
) {
  const sessions: BuiltinSession<never>[] = []
  const told: unknown[] = []
  const run: InterviewChat = async (session) => {
    sessions.push(session)
    const tools = await session.tools(cardBinding(answers))
    for (const args of proposals) {
      told.push(await tools.groups.propose_company!.propose_company!.call(args, { callId: `r/init/${told.length}/0` }))
    }
    return end
  }
  return { run, sessions, told }
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
  const broken = refusal(() => fallbackDraft({ agent: "Mi\nnh", agent_handle: "minh" }, login))
  expect(broken).toBeInstanceOf(OnboardError)
  expect(broken.message).toMatch(/name can't hold line breaks.*; pass --agent$/)
})

test.each([
  ["--company", { company: " " }], ["--name", { name: " " }], ["--handle", { handle: "Me" }],
  ["--agent", { agent: " " }], ["--agent-handle", { agent_handle: "Bad_Handle" }],
] as [string, Known][])("each fallback problem names the flag that sets its field [%s]", (flag, known) => {
  const error = refusal(() => fallbackDraft(known, login))
  expect(error).toBeInstanceOf(OnboardError)
  expect(error.message).toMatch(new RegExp(`; pass ${flag}$`))
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

test("clean turns line breaks and tabs into spaces and drops other control characters", () => {
  expect(clean("a\nb\rc\td\x00e\x1bf\x7fg")).toBe("a b c defg")
})

test("clean drops c1 control characters which some terminals read as escapes", () => {
  expect(clean("a\x80b\x9b2Jc\x9fd\xa0e")).toBe("ab2Jcd\xa0e")
})

test("the interview hands chat a session on the setup model in office/setup/<id>, its first message the owner's", async () => {
  const llm_config = { ...LLM_CONFIG, api_key: KEY }
  const env = { OPENAI_BASE_URL: "http://127.0.0.1:9/v1" }
  const { file, sessions } = await office({ llm_config, env })
  const told = facts({ company: "Acme", remote: "https://user:remote-sentinel@example.com/a.git" }, login)
  const c = chat([ACME], { answers: [YES] })
  expect(await interview(c.run, { file, sessions, facts: told })).toEqual(DRAFT)
  const [session] = c.sessions
  expect(session!.agent).toEqual({ handle: "opencorp", name: "OpenCorp" })
  expect(session!.flow).toEqual({ name: "init", text: embedded(initYaml).toString("utf8") })
  expect(session!.inputs).toEqual({ known: pyJson(told, true) })
  expect(JSON.stringify(session!.inputs)).not.toContain("remote-sentinel")
  expect(session!.first).toBe(INTERVIEW_FIRST)
  expect(INTERVIEW_FIRST).toBe("Set up my company")
  expect(session!.model).toEqual({ llm_config, env })
  // Its own folder under office/setup, apart from the daemon's sessions, so a host locks and recovers only setup's.
  expect(path.dirname(session!.folder)).toBe(sessions)
  expect(path.basename(session!.folder)).toMatch(ULID)
  // Its one tool is propose_company, a group of one; it drives no terminal.
  const tools = await session!.tools(cardBinding([]))
  expect(Object.keys(tools.groups)).toEqual(["propose_company"])
  expect(Object.keys(tools.groups.propose_company!)).toEqual(["propose_company"])
  expect(tools.terminal).toBeUndefined()
  // Each interview gets a folder of its own.
  const again = chat([ACME], { answers: [YES] })
  await interview(again.run, { file, sessions, facts: told })
  expect(again.sessions[0]!.folder).not.toBe(session!.folder)
})

test("an interview on a subscription runs on the sign-in beside office.json", async () => {
  const { office: dir, file, sessions } = await office({
    method: "subscription",
    llm_config: { provider: "openai", model: "gpt-5.5" },
  })
  const c = chat([ACME], { answers: [YES] })
  await interview(c.run, { file, sessions, facts: facts({}, login) })
  expect(c.sessions[0]!.model.env).toEqual({ YIAN_AUTH_FILE: path.join(dir, "connections", "office.auth.json") })
})

test("the accepted draft is the interview's result", async () => {
  const { file, sessions } = await office({ llm_config: LLM_CONFIG })
  // A No first, then a Yes: the result is the company the owner said Yes to.
  const c = chat([{ ...ACME, company: "Acme Labs" }, ACME], { answers: [NO, YES] })
  expect(await interview(c.run, { file, sessions, facts: facts({}, login) })).toEqual(DRAFT)
  expect(c.told).toEqual(["The owner wants changes; ask what to change", ACCEPTED])
  // Accepted on its card, the company is made however the chat ends after.
  for (const end of [
    { status: "left", error: null },
    { status: "failed", error: "scripted error 400" },
  ] as ChatEnd[]) {
    const after = chat([ACME], { answers: [YES], end })
    expect(await interview(after.run, { file, sessions, facts: facts({}, login) })).toEqual(DRAFT)
  }
})

test("on the no-office host, the init flow's chat ends once the owner says Yes on the company's card", async () => {
  const fake = await fakeLlm()
  fake.script(
    { match: INTERVIEW_FIRST, content: "What's the company called?" },
    { match: "Acme Robotics", tool_calls: [{ id: "call_propose", name: "propose_company", arguments: ACME }] },
    { match: '"tool_call_id":"call_propose"', content: "Acme is ready." },
  )
  const { file, sessions } = await office({ llm_config: LLM_CONFIG, env: fake.env() })
  const run = hostChat(async (host) => {
    const said = async () => JSON.stringify(await host.messages())
    await waitFor(async () => (await said()).includes("What's the company called?"), { what: "the agent's question" })
    await host.prompt("Acme Robotics", OWNER)
    const card = await waitFor(() => host.questions({ status: ["open"] })[0], { what: "the company's card" })
    expect(card.question).toContain("Company: Acme")
    host.answer(card.id, CREATE, "option", OWNER)
    await host.ended
    expect(await said()).toContain("Acme is ready.")
  })
  expect(await interview(run, { file, sessions, facts: facts({}, login) })).toEqual(DRAFT)
  expect(fake.pending()).toEqual([])
})

test("a failed session stops init naming why, the key redacted, and says init checks the model next time", async () => {
  const { file, sessions } = await office({ llm_config: { ...LLM_CONFIG, api_key: KEY } })
  const c = chat([], { end: { status: "failed", error: `401 from the server: bad key ${KEY}` } })
  const error = await rejection(interview(c.run, { file, sessions, facts: facts({}, login) }))
  expect(error).toBeInstanceOf(OnboardError)
  expect(error.message).toContain("the model couldn't run the interview: 401 from the server: bad key")
  expect(error.message).not.toContain(KEY)
  expect(error.message).toEndWith("; run `opencorp init` again: it checks the model first and offers to set it up again")
})

test("a refused sign-in says once to run init again", async () => {
  const { file, sessions } = await office({ llm_config: LLM_CONFIG })
  const refused = "OpenAI refused the sign-in (HTTP 401). Run 'yian auth openai' and start a new run"
  const c = chat([], { end: { status: "failed", error: refused } })
  const error = await rejection(interview(c.run, { file, sessions, facts: facts({}, login) }))
  expect(error.message).toContain("(HTTP 401): sign in to ChatGPT again;")
  expect(error.message).not.toContain("yian auth")
  expect(error.message.split("run `opencorp init` again")).toHaveLength(2)
})

/** What init says when its chat can't open: why, then the two ways to make the company without it. */
const NO_CHAT_HINT =
  "; run `opencorp init` with TERM=dumb to make the company from your flags, or pass the provider with --provider-stdin"

test("a chat that can't start stops init naming why and the ways without it, the key redacted", async () => {
  const { file, sessions } = await office({ llm_config: { ...LLM_CONFIG, api_key: KEY } })
  const broken: InterviewChat = async () => {
    throw new Error(`the TUI wouldn't load (${KEY})`)
  }
  const error = await rejection(interview(broken, { file, sessions, facts: facts({}, login) }))
  expect(error).toBeInstanceOf(OnboardError)
  expect(error.message).toStartWith("can't run the interview's chat: the TUI wouldn't load (")
  expect(error.message).not.toContain(KEY)
  expect(error.message).toEndWith(NO_CHAT_HINT)
  // So does a host that can't start: here another host holds office/setup.
  fs.mkdirSync(sessions, { mode: 0o700 })
  const held = lockFile(path.join(sessions, "lock"), { private: true })
  try {
    const run = hostChat(async () => {
      throw new Error("the host started")
    })
    const busy = await rejection(interview(run, { file, sessions, facts: facts({}, login) }))
    expect(busy).toBeInstanceOf(OnboardError)
    expect(busy.message).toStartWith(`can't run the interview's chat: another host is running the sessions in ${sessions}`)
    expect(busy.message).toEndWith(NO_CHAT_HINT)
  } finally {
    held.release()
  }
})

test("leaving the chat is a KeyboardInterrupt, and ending it with nothing accepted says so", async () => {
  const { file, sessions } = await office({ llm_config: LLM_CONFIG })
  const left = chat([ACME], { answers: [NO], end: { status: "left", error: null } })
  const interrupted = await rejection(interview(left.run, { file, sessions, facts: facts({}, login) }))
  expect(interrupted).toBeInstanceOf(KeyboardInterrupt)
  const ended = chat([], { end: { status: "ended", error: null } })
  const error = await rejection(interview(ended.run, { file, sessions, facts: facts({}, login) }))
  expect(error).toBeInstanceOf(OnboardError)
  expect(error.message).toBe("the interview ended before a company was accepted; run `opencorp init` again")
})
