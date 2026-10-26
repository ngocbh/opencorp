/** The chat harness: a start, its run spec, what a start refuses, and how it hands Codex sessions to the Codex
 *  sessions (Python's `tests/chat/test_harness.py`). */
import fs from "node:fs"
import path from "node:path"
import { afterAll, expect, setDefaultTimeout, spyOn, test } from "bun:test"
import { HarnessError } from "../../src/chat/state.ts"
import { MAIN_CHAT } from "../../src/chat/turns.ts"
import type { SessionRecord } from "../../src/store/store.ts"
import type { FakeLLM } from "../../src/testing/fake_llm.ts"
import { person } from "../company/helpers.ts"
import { CODEX_PERSON, allGone } from "../harness/helpers.ts"
import { tempDir, waitFor } from "../helpers.ts"
import { question, session } from "../store/helpers.ts"
import { ASK_MANAGER, ASK_USER, LAN, card, fakeLlm, makeHarness, noWorkersLeft, status, texts } from "./helpers.ts"

setDefaultTimeout(60_000)
afterAll(async () => {
  await allGone()
  await noWorkersLeft()
})

const MINH = {
  name: "Minh",
  handle: "minh",
  title: "Engineer",
  company: "test-corp",
  reports_to: "You report to Hong Ngoc Bui (@ngocbh).",
}
const TALKING_TO_CEO = "You're talking with Hong Ngoc Bui (@ngocbh), the CEO and your manager."

type Harness = Awaited<ReturnType<typeof makeHarness>>

/** What `promise` rejects with; fails the test if it resolves. */
async function rejection(promise: Promise<unknown>): Promise<HarnessError> {
  return promise.then(
    () => {
      throw new Error("expected a rejection")
    },
    (error: unknown) => {
      expect(error).toBeInstanceOf(HarnessError)
      return error as HarnessError
    },
  )
}

/** Starts minh's chat in `h.folder` (`options` as `startSession`'s) and waits for its first turn; returns it as
 *  stored. */
async function start(h: Harness, options: Parameters<Harness["harness"]["startSession"]>[2] = {}) {
  const s = await h.harness.startSession("minh", h.folder, options)
  await waitFor(() => status(h, s.id) === "idle", { what: "the first turn" })
  return h.store.getSession(s.id)!
}

/** A stored idle main chat of minh's in `h.folder` at the company's head, with `over`. */
async function stored(h: Harness, over: Partial<SessionRecord> = {}): Promise<SessionRecord> {
  return h.store.createSession(session({ cwd: h.folder, repo_commit: await h.office.git.head(), ...over }))
}

/** Whether `a` and `b` are equal as JSON. */
function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

/** The messages of the `n`th model request (from 1), as JSON text. */
async function asked(fake: FakeLLM, n: number): Promise<string> {
  return JSON.stringify((await fake.waitForRequests(n))[n - 1]!.messages)
}

/** A model call of the fake toolbox's echo tool. */
const ECHO = { name: "fake__echo", arguments: { text: "x" } }

/** The author of each user message of session `sid`, by its text. */
function authors(h: Harness, sid: string): Record<string, string | null> {
  const by: Record<string, string | null> = {}
  for (const message of h.harness.messages(sid)) {
    if (message.role !== "user") continue
    for (const part of message.parts) if (part.type === "text") by[part.text] = message.author ?? null
  }
  return by
}

/** Waits until session `sid` has no worker: between turns a chat run has none. */
async function asleep(h: Harness, sid: string): Promise<void> {
  await waitFor(() => h.registry.get(sid) === undefined, { what: "the worker to exit" })
}

/** Records the status of each session `h`'s hooks see end. */
function endings(h: Harness): string[] {
  const ended: string[] = []
  h.hooks.sessionEnded.push((s: SessionRecord) => void ended.push(s.status))
  return ended
}

test("a session records who opened it and its work item is theirs", async () => {
  const h = await makeHarness(await fakeLlm(), { files: LAN })
  const opened = await start(h, { openedBy: "lan" })
  expect([opened.opened_by, h.store.getWorkItem(opened.work_item_id!)!.requester]).toEqual(["lan", "lan"])
  const unsaid = await start(h)
  expect([unsaid.opened_by, h.store.getWorkItem(unsaid.work_item_id!)!.requester]).toEqual([null, "ngocbh"])
})

test("a turn replies and end finishes the session", async () => {
  const fake = await fakeLlm()
  fake.script({ content: "Hello from Minh." })
  const h = await makeHarness(fake)
  const s = await start(h)
  expect([s.kind, s.harness, s.run_ids.length]).toEqual(["main", "composer", 1])

  expect(await h.harness.prompt(s.id, "hi")).toBe("turn")
  await waitFor(() => same(texts(h, s.id), ["Hello from Minh."]) && status(h, s.id) === "idle", {
    what: "the reply",
  })
  expect(texts(h, s.id, "user")).toEqual(["hi"])

  // The work item's status when each session status is stored.
  const seen: [string | undefined, string | undefined][] = []
  const update = h.store.updateSession.bind(h.store)
  spyOn(h.store, "updateSession").mockImplementation((id, changes) => {
    seen.push([changes.status, h.store.getWorkItem(s.work_item_id!)?.status])
    return update(id, changes)
  })
  await h.harness.end(s.id)
  await waitFor(() => status(h, s.id) === "ended", { what: "the end" })
  expect(seen).toContainEqual(["ended", "done"])
  expect(seen).not.toContainEqual(["ended", "in_progress"])
  const late = await rejection(h.harness.prompt(s.id, "late"))
  expect(late.code).toBe("not_live")
})

test("a main run gets the persons identity and who they talk with", async () => {
  const h = await makeHarness(await fakeLlm())
  const spec = await h.harness.spec(await stored(h))
  expect(spec.inputs).toEqual({ person: MINH, talking_to: TALKING_TO_CEO, max_turns: 500 })
})

test("a main run is told who opened it", async () => {
  const h = await makeHarness(await fakeLlm(), { files: LAN })
  const spec = await h.harness.spec(await stored(h, { opened_by: "lan" }))
  expect(spec.inputs.talking_to).toBe("You're talking with Lan (@lan), your peer.")
})

test("the reply speaks as the person", async () => {
  const fake = await fakeLlm()
  fake.script({ content: "I'm Minh." })
  const h = await makeHarness(fake)
  const s = await start(h)
  await h.harness.prompt(s.id, "Who are you?")
  const [first] = (await fake.waitForRequests(1))[0]!.messages as { role: string; content: string }[]
  expect(first!.role).toBe("system")
  expect(first!.content).toStartWith(
    `You are Minh (@minh), Engineer at test-corp. You report to Hong Ngoc Bui (@ngocbh). ${TALKING_TO_CEO}\n`,
  )
  await waitFor(() => same(texts(h, s.id), ["I'm Minh."]), { what: "the reply" })
})

test("a steer reaches the running reply", async () => {
  const fake = await fakeLlm()
  fake.script({ content: "Working", tool_calls: [ECHO], hold: 30 }, { content: "Done." })
  const h = await makeHarness(fake)
  const { id } = await start(h)
  await h.harness.prompt(id, "hi")
  await fake.waitForRequests(1)
  expect(await h.harness.steer(id, "Also mention Rome.")).toBe("steer")
  fake.release()
  expect(await asked(fake, 2)).toContain("Also mention Rome.")
  await waitFor(() => status(h, id) === "idle" && same(texts(h, id).slice(-1), ["Done."]), { what: "the reply" })
  expect(texts(h, id, "user")).toEqual(["hi", "Also mention Rome."])
  // The steer comes after the text streamed before the model read it, and before the text after.
  const shown = h.harness
    .messages(id)
    .map((m) => [m.role, m.parts.flatMap((p) => (p.type === "text" ? [p.text] : []))])
  expect(shown).toEqual([
    ["user", ["hi"]],
    ["assistant", ["Working"]],
    ["user", ["Also mention Rome."]],
    ["assistant", ["Done."]],
  ])
})

test("a steer the reply never reads is the next turn", async () => {
  const fake = await fakeLlm()
  fake.script({ content: "Done.", hold: 30 }, { content: "Second." })
  const h = await makeHarness(fake)
  const { id } = await start(h)
  await h.harness.prompt(id, "hi")
  await fake.waitForRequests(1)
  expect(await h.harness.steer(id, "one more thing")).toBe("steer")
  fake.release()
  expect(await asked(fake, 2)).toContain("one more thing")
  await waitFor(() => same(texts(h, id), ["Done.", "Second."]), { what: "the second reply" })
  // Written once, when accepted.
  expect(texts(h, id, "user")).toEqual(["hi", "one more thing"])
})

test("esc answers the models question and keeps the run", async () => {
  const fake = await fakeLlm()
  fake.script({ tool_calls: [{ name: "ask_user", arguments: { question: "Which?" } }] }, { content: "Next." })
  const h = await makeHarness(fake)
  const { id } = await start(h)
  await h.harness.prompt(id, "first-turn-text")
  const q = await card(h, id, "ask_user")
  await h.harness.interrupt(id)
  expect(h.store.getQuestion(q.id)!.answer_kind).toBe("interrupted")
  await waitFor(() => status(h, id) === "idle", { what: "the next turn" })
  await h.harness.prompt(id, "again")
  await waitFor(() => same(texts(h, id).slice(-1), ["Next."]), { what: "the next reply" })
  expect(h.store.getSession(id)!.run_ids).toHaveLength(1)
  // The interrupted reply made no more model calls.
  expect(fake.requests()).toHaveLength(2)
  // The run's memory kept the interrupted turn.
  expect(await asked(fake, 2)).toContain("first-turn-text")
})

test("max turns ends the session", async () => {
  const fake = await fakeLlm()
  const h = await makeHarness(fake, { defaults: { max_turns: 2 } })
  fake.script({ content: "one" }, { content: "two" })
  const { id } = await start(h)
  await h.harness.prompt(id, "a")
  await waitFor(() => same(texts(h, id), ["one"]) && status(h, id) === "idle", { what: "turn one" })
  await h.harness.prompt(id, "b")
  await waitFor(() => status(h, id) === "ended", { what: "the end" })
})

test("end while busy interrupts then exits", async () => {
  const fake = await fakeLlm()
  fake.script({ content: "Working", tool_calls: [ECHO], hold: 30 }, { content: "never" })
  const h = await makeHarness(fake)
  const { id } = await start(h)
  await h.harness.prompt(id, "hi")
  await fake.waitForRequests(1)
  await h.harness.end(id)
  expect(status(h, id)).toBe("ending")
  const more = await rejection(h.harness.prompt(id, "more"))
  expect([more.status, more.code]).toEqual([409, "ending"])
  fake.release()
  await waitFor(() => status(h, id) === "ended", { what: "the end" })
  expect(fake.requests()).toHaveLength(1)
})

test("a send that fails leaves the next message the turn", async () => {
  const fake = await fakeLlm()
  fake.script({ content: "Hello." })
  const h = await makeHarness(fake)
  const { id } = await start(h)
  await asleep(h, id)
  h.failNextSpawn()
  const failed = await rejection(h.harness.prompt(id, "hi"))
  expect([failed.status, failed.code]).toEqual([503, "cant_wake"])
  expect(await h.harness.prompt(id, "are you there")).toBe("turn")
  await waitFor(() => same(texts(h, id).slice(-1), ["Hello."]), { what: "the reply" })
  expect(await asked(fake, 1)).toContain("are you there")
  expect(texts(h, id, "user")).toEqual(["are you there"])
})

test("a message with no sender is authored by the ceo of the pinned company", async () => {
  const fake = await fakeLlm()
  fake.script({ content: "Hello." })
  const h = await makeHarness(fake)
  const { id } = await start(h)
  await h.harness.prompt(id, "hi")
  await waitFor(() => same(texts(h, id).slice(-1), ["Hello."]), { what: "the reply" })
  expect(authors(h, id)).toEqual({ hi: "ngocbh" })
})

test("a message is authored by the sessions opener", async () => {
  const fake = await fakeLlm()
  fake.script({ content: "Hello." })
  const h = await makeHarness(fake, { files: LAN })
  const { id } = await start(h, { openedBy: "lan" })
  await h.harness.prompt(id, "hi")
  await waitFor(() => same(texts(h, id).slice(-1), ["Hello."]), { what: "the reply" })
  expect(authors(h, id)).toEqual({ hi: "lan" })
})

test("an answer off a live run is credited to the opener else the ceo", async () => {
  const h = await makeHarness(await fakeLlm(), { files: LAN })
  for (const [openedBy, credited] of [
    ["lan", "lan"],
    [null, "ngocbh"],
  ] as const) {
    const s = await stored(h, { opened_by: openedBy })
    const q = h.store.addQuestion(question(s.id))
    expect((await h.harness.answer(q.id, "yes", "text")).answered_by).toBe(credited)
  }
})

test("messages and answers are credited to who sent them", async () => {
  const fake = await fakeLlm()
  fake.script(
    { tool_calls: [{ name: "ask_user", arguments: { question: "Which?" } }] },
    { content: "Done." },
    { content: "Bye." },
  )
  const h = await makeHarness(fake)
  // Opened by no one: the owner is the CEO.
  const { id } = await start(h)
  expect(await h.harness.prompt(id, "pick one", { by: "lan" })).toBe("turn")
  const q = await card(h, id, "ask_user")
  expect(await h.harness.prompt(id, "A", { by: "lan" })).toBe("answer")
  await waitFor(() => same(texts(h, id).slice(-1), ["Done."]) && status(h, id) === "idle", { what: "the reply" })
  expect(await h.harness.prompt(id, "thanks", { by: "kai" })).toBe("turn")
  await waitFor(() => same(texts(h, id).slice(-1), ["Bye."]), { what: "the last reply" })
  expect(authors(h, id)).toEqual({ "pick one": "lan", thanks: "kai" })
  expect(h.store.getQuestion(q.id)!.answered_by).toBe("lan")
})

test.each([
  ["queued-steer", "queued", "steer"],
  ["queued-prompt", "queued", "prompt"],
  ["steer_never_read-steer", "steer", "steer"],
  ["steer_never_read-prompt", "steer", "prompt"],
] as const)(
  "a message that waits for the next turn is credited to who sent it [%s]",
  async (_case, reply, send) => {
    const fake = await fakeLlm()
    fake.script({ content: "Done.", hold: 30 }, { content: "Second." }, { content: "spare" })
    const h = await makeHarness(fake)
    const { id } = await start(h)
    let sent: Promise<string>
    if (reply === "queued") {
      // The wake's spawn is held: the message waits behind it, for the turn after "hi".
      await asleep(h, id)
      const held = h.hold()
      const hi = h.harness.prompt(id, "hi")
      await held.entered
      sent = h.harness[send](id, "one more thing", { by: "lan" })
      held.release()
      await hi
    } else {
      await h.harness.prompt(id, "hi")
      await fake.waitForRequests(1)
      sent = h.harness[send](id, "one more thing", { by: "lan" })
    }
    expect(await sent).toBe(reply)
    await fake.waitForRequests(1)
    fake.release()
    await waitFor(() => same(texts(h, id, "user"), ["hi", "one more thing"]) && status(h, id) === "idle", {
      what: "both messages answered",
    })
    expect(authors(h, id)).toEqual({ hi: "ngocbh", "one more thing": "lan" })
  },
)

test("hooks see the session", async () => {
  const fake = await fakeLlm()
  const h = await makeHarness(fake)
  const seen: [string, unknown][] = []
  h.hooks.runStarted.push((_s, runId) => void seen.push(["runStarted", runId]))
  h.hooks.questionStored.push((q) => void seen.push(["questionStored", q.source]))
  h.hooks.runFinished.push((_s, _runId, result) => void seen.push(["runFinished", result?.status]))
  h.hooks.sessionEnded.push((s) => void seen.push(["sessionEnded", s.status]))
  h.hooks.answerCheck.push((_q, answer) => (answer === "darn" ? "no swearing" : null))
  fake.script(ASK_USER, { content: "ok" })
  const { id } = await start(h)
  await h.harness.prompt(id, "hi")
  const q = await card(h, id, "ask_user")
  const refused = await rejection(h.harness.answer(q.id, "darn", "text"))
  expect([refused.code, refused.message]).toEqual(["invalid_answer", "no swearing"])
  await h.harness.answer(q.id, "A", "option")
  await waitFor(() => same(texts(h, id), ["ok"]) && status(h, id) === "idle", { what: "the reply" })
  await h.harness.end(id)
  await waitFor(() => seen.some((s) => same(s, ["sessionEnded", "ended"])), { what: "session ended" })
  const runId = h.store.getSession(id)!.run_ids[0]
  expect(seen[0]).toEqual(["runStarted", runId])
  expect(seen.slice(-2)).toEqual([
    ["runFinished", "succeeded"],
    ["sessionEnded", "ended"],
  ])
  expect(seen).toContainEqual(["questionStored", "ask_user"])
})

test("esc racing the end of a reply leaves the run at its turn", async () => {
  const fake = await fakeLlm()
  fake.script({ content: "Done.", hold: true }, { content: "Next." }, { content: "spare" })
  const h = await makeHarness(fake)
  const { id } = await start(h)
  await h.harness.prompt(id, "hi")
  await fake.waitForRequests(1)
  fake.release()
  // Esc again and again as the reply ends and the next turn opens.
  for (let i = 0; i < 20; i++) await h.harness.interrupt(id)
  await waitFor(() => status(h, id) === "idle", { what: "the next turn" })
  await h.harness.interrupt(id)
  expect(await h.harness.prompt(id, "again")).toBe("turn")
  await waitFor(() => same(texts(h, id).slice(-1), ["Next."]), { what: "the next reply" })
})

test("a failing hook does not stop the session", async () => {
  const fake = await fakeLlm()
  const h = await makeHarness(fake)
  const broken = () => {
    throw new Error("boom")
  }
  h.hooks.questionStored.push(broken)
  h.hooks.runStarted.push(broken)
  h.hooks.runFinished.push(broken)
  h.hooks.sessionEnded.push(broken)
  fake.script({ content: "ok" })
  const { id } = await start(h)
  await h.harness.prompt(id, "hi")
  await waitFor(() => same(texts(h, id), ["ok"]) && status(h, id) === "idle", { what: "the reply" })
  await h.harness.end(id)
  await waitFor(() => status(h, id) === "ended", { what: "the end" })
})

test("ask manager opens a work item and waits for the answer", async () => {
  const fake = await fakeLlm()
  fake.script(ASK_MANAGER, { content: "Thanks." })
  const h = await makeHarness(fake)
  const { id } = await start(h)
  await h.harness.prompt(id, "hi")
  const q = await card(h, id, "ask_manager")
  expect(h.store.getWorkItem(q.work_item_id!)!.assignee).toBe("ngocbh")
  await h.harness.answer(q.id, "Yes", "text")
  await waitFor(() => same(texts(h, id).slice(-1), ["Thanks."]), { what: "the reply" })
  expect(h.store.getWorkItem(q.work_item_id!)!.status).toBe("done")
})

test("an end status hook picks the status of a normal end", async () => {
  const h = await makeHarness(await fakeLlm())
  const ended: string[] = []
  h.hooks.endStatus.push(
    () => null,
    (s) => (s.kind === "main" ? "debriefing" : null),
    () => "failed",
  )
  h.hooks.sessionEnded.push((s) => void ended.push(s.status))
  const { id } = await start(h)
  await h.harness.end(id)
  await waitFor(() => ended.length > 0, { what: "session ended" })
  const s = h.store.getSession(id)!
  expect([ended, s.status]).toEqual([["debriefing"], "debriefing"])
  expect(h.store.getWorkItem(s.work_item_id!)!.status).toBe("done")
})

test("a prompt check refuses a message before it reaches the session", async () => {
  const fake = await fakeLlm()
  const h = await makeHarness(fake)
  h.hooks.promptCheck.push((_s, text) => (text === "/exit" ? "use /back" : null))
  fake.script({ content: "ok" })
  const { id } = await start(h)
  for (const call of [() => h.harness.prompt(id, "/exit"), () => h.harness.steer(id, "/exit")]) {
    const error = await rejection(call())
    expect([error.status, error.code, error.message]).toEqual([422, "refused", "use /back"])
  }
  expect(texts(h, id, "user")).toEqual([])
  expect(await h.harness.prompt(id, "hi")).toBe("turn")
  await waitFor(() => same(texts(h, id), ["ok"]), { what: "the reply" })
})

test("turn text takes only a str and skips the exit command", async () => {
  const fake = await fakeLlm()
  const h = await makeHarness(fake)
  const seen: string[] = []
  h.hooks.turnContext.push(
    (_s, text) => {
      seen.push(text)
      return 42 as unknown as string
    },
    (_s, text) => `<${text}>`,
  )
  fake.script({ content: "one" })
  const { id } = await start(h)
  await h.harness.prompt(id, "hi")
  await waitFor(() => same(texts(h, id), ["one"]) && status(h, id) === "idle", { what: "the reply" })
  // 42 isn't text, so the next result wins.
  expect(await asked(fake, 1)).toContain("<hi>")
  // The person typed the exit command.
  expect(await h.harness.prompt(id, MAIN_CHAT.exit)).toBe("turn")
  await waitFor(() => status(h, id) === "ended", { what: "the end" })
  expect(seen).toEqual(["hi"])
})

test("a main run offers toolbox workspace and company in that order", async () => {
  const h = await makeHarness(await fakeLlm())
  const s = await stored(h)
  const groups = (await h.harness.spec(s)).groups({ session: s, runId: "run-1" })
  expect(Object.entries(groups).map(([group, tools]) => [group, Object.keys(tools)])).toEqual([
    ["toolbox", ["fake__echo"]],
    ["workspace", ["read_file", "write_file", "edit_file", "list", "search", "shell"]],
    ["company", ["ask_manager", "create_work_item", "comment"]],
  ])
})

test("the run spec keeps its tmp dir private under the session folder", async () => {
  const h = await makeHarness(await fakeLlm())
  const s = await stored(h)
  await h.harness.spec(s)
  const tmp = path.join(h.office.paths.office, "sessions", s.id, "tmp")
  expect(fs.statSync(tmp).mode & 0o777).toBe(0o700)
})

test("a session records the resolved folder", async () => {
  const h = await makeHarness(await fakeLlm())
  const link = path.join(tempDir(), "link")
  fs.symlinkSync(h.folder, link)
  const s = await h.harness.startSession("minh", link)
  await waitFor(() => status(h, s.id) === "idle", { what: "the first turn" })
  const real = fs.realpathSync(h.folder)
  expect(s.cwd).toBe(real)
  expect(h.store.workedFolders("minh").map((f) => f.cwd)).toEqual([real])
})

test("a person with no harnesses list chats on the composer", async () => {
  const h = await makeHarness(await fakeLlm(), { files: { "people/minh/person.yaml": person("minh", { harnesses: [] }) } })
  expect((await start(h)).harness).toBe("composer")
})

test("a chat starts on the picked connection and stores the connections own model as null", async () => {
  const h = await makeHarness(await fakeLlm(), { connections: { alt: "alt-model" } })
  const picks = [
    { connection: "alt", model: "other" },
    { connection: "alt", model: "alt-model" },
    { connection: "nope", model: "other" },
  ]
  const started = []
  for (const pick of picks) started.push(await start(h, pick))
  expect(started.map((s) => [s.connection, s.model])).toEqual([
    ["alt", "other"],
    ["alt", null],
    ["office", null],
  ])
})

test("a provider error at start fails the session", async () => {
  const h = await makeHarness(await fakeLlm())
  const file = path.join(h.office.connections.dir, "office.json")
  fs.chmodSync(file, 0o644) // not private: the connection is refused
  const ended = endings(h)
  const error = await rejection(h.harness.startSession("minh", h.folder))
  const [s, ...rest] = h.store.listSessions()
  expect(rest).toEqual([])
  expect([error.status, error.code]).toEqual([500, "start_failed"])
  expect(error.message.startsWith(`session ${s!.id} failed to start: `)).toBe(true)
  expect(error.message).toContain(file)
  expect(error.message).toContain("private")
  expect(s!.status).toBe("failed")
  await waitFor(() => ended.length > 0, { what: "the session to end" })
  expect(ended).toEqual(["failed"])
  const late = await rejection(h.harness.prompt(s!.id, "hi"))
  expect(late.code).toBe("not_live")
})

test("a run that cant be set up fails the session and says so", async () => {
  const h = await makeHarness(await fakeLlm())
  const ended = endings(h)
  spyOn(h.store, "addSessionRun").mockImplementation(() => {
    throw new Error("disk full")
  })
  const error = await rejection(h.harness.startSession("minh", h.folder))
  expect([error.status, error.code]).toEqual([500, "start_failed"])
  expect(error.message).not.toContain("disk full")
  await waitFor(() => ended.length > 0, { what: "the session to end" })
  expect([h.store.listSessions().map((s) => s.status), ended]).toEqual([["failed"], ["failed"]])
})

test("a start that fails otherwise names the session but not the error", async () => {
  const h = await makeHarness(await fakeLlm())
  spyOn(h.registry, "spawn").mockRejectedValue(new Error("sentinel detail"))
  const error = await rejection(h.harness.startSession("minh", h.folder))
  const [s, ...rest] = h.store.listSessions()
  expect(rest).toEqual([])
  expect([error.status, error.code, s!.status]).toEqual([500, "start_failed", "failed"])
  expect(error.message).toContain(s!.id)
  expect(error.message).not.toContain("sentinel")
})

test.each([
  ["unknown person", "nobody", null, "not_found"],
  ["human", "ngocbh", null, "not_an_agent"],
  ["relative cwd", "minh", "relative/path", "invalid_body"],
  ["root cwd", "minh", "/", "unsafe_workspace"],
] as const)("start refuses bad requests [%s]", async (_case, handle, cwd, code) => {
  const h = await makeHarness(await fakeLlm())
  const error = await rejection(h.harness.startSession(handle, cwd ?? h.folder))
  expect(error.code).toBe(code)
  expect(h.store.listSessions()).toEqual([])
  // Refused before anything of the session is written.
  expect(fs.existsSync(h.office.paths.runs)).toBe(false)
})

test.each([
  ["home", ""],
  ["company", "company"],
  ["office", "office"],
  ["office/runs", "office/runs"],
])("start refuses the offices own folders [%s]", async (_label, where) => {
  const h = await makeHarness(await fakeLlm())
  const paths = h.office.paths
  const cwd = path.join(paths.home, where)
  fs.mkdirSync(cwd, { recursive: true })
  const error = await rejection(h.harness.startSession("minh", cwd))
  expect([error.status, error.code]).toEqual([422, "unsafe_workspace"])
  expect(h.store.listSessions()).toEqual([])
  expect(!fs.existsSync(paths.runs) || fs.readdirSync(paths.runs).length === 0).toBe(true)
})

test("a codex chat is stored then handed to the codex sessions", async () => {
  const h = await makeHarness(await fakeLlm(), { codex: true })
  const start = spyOn(h.codex!.sessions, "start")
  const s = await h.harness.startSession("minh", h.folder, { harness: "codex", openedBy: "ngocbh" })
  expect(start.mock.calls.map(([row, options]) => [row.status, row.harness, options?.resume ?? false])).toEqual([
    ["starting", "codex", false],
  ])
  expect([s.harness, s.opened_by]).toEqual(["codex", "ngocbh"])
  expect(s.work_item_id).toBeTruthy()
})

test("codex needs the codex sessions", async () => {
  const h = await makeHarness(await fakeLlm(), { files: CODEX_PERSON })
  const error = await rejection(h.harness.startSession("minh", h.folder, { harness: "codex" }))
  expect([error.status, error.code]).toEqual([422, "unsupported_harness"])
})

test("codex needs a person who uses it", async () => {
  // minh's harnesses: [composer]
  const h = await makeHarness(await fakeLlm(), { codex: true, files: { "people/minh/person.yaml": person("minh") } })
  const error = await rejection(h.harness.startSession("minh", h.folder, { harness: "codex" }))
  expect([error.status, error.code]).toEqual([422, "unsupported_harness"])
})

test("a codex chat that cant be handed over fails with its id", async () => {
  const h = await makeHarness(await fakeLlm(), { codex: true })
  spyOn(h.codex!.sessions, "start").mockRejectedValue(new Error("sentinel"))
  const ended: string[] = []
  h.hooks.sessionEnded.push((s: SessionRecord) => void ended.push(s.status))
  const error = await rejection(h.harness.startSession("minh", h.folder, { harness: "codex" }))
  expect([error.status, error.code]).toEqual([500, "start_failed"])
  expect(error.message).not.toContain("sentinel")
  const [s, ...rest] = h.store.listSessions()
  expect(rest).toEqual([])
  expect([s!.status, ended]).toEqual(["failed", ["failed"]])
  expect(error.message).toContain(s!.id)
})

test("a codex session can not continue without the codex sessions", async () => {
  const h = await makeHarness(await fakeLlm())
  const stored = h.store.createSession(session({ harness: "codex", harness_session_id: "thr_1", status: "ended" }))
  const error = await rejection(h.harness.continueSession(stored.id, { by: "ngocbh" }))
  expect([error.status, error.code, error.message]).toEqual([
    422,
    "unsupported_harness",
    "the codex harness is not supported yet",
  ])
})

test.each(["setCostCap", "setModel"] as const)(
  "a codex sessions cost cap and model are not supported without the codex sessions [%s]",
  async (call) => {
    const h = await makeHarness(await fakeLlm())
    const stored = h.store.createSession(session({ harness: "codex", harness_session_id: "thr_1" }))
    const error = await rejection(
      call === "setCostCap" ? h.harness.setCostCap(stored.id, 5) : h.harness.setModel(stored.id, "default", "gpt-x"),
    )
    expect([error.status, error.code]).toEqual([422, "not_supported"])
  },
)

test("close closes the workers even when the codex sessions fail to close", async () => {
  const h = await makeHarness(await fakeLlm(), { codex: true })
  spyOn(h.codex!.sessions, "closeAll").mockRejectedValueOnce(new Error("sentinel"))
  const workers = spyOn(h.harness.registry, "closeAll")
  await expect(h.harness.closeAll()).rejects.toThrow("sentinel")
  await expect(h.harness.closeAll()).rejects.toThrow("sentinel")
  expect(workers).toHaveBeenCalledTimes(1)
  // The test's end closes this harness again, which would only report the same rejection.
  spyOn(h.harness, "closeAll").mockResolvedValue()
})
