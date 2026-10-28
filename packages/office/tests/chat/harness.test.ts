/** The chat harness: a start, its run spec, what a start refuses, how it hands Codex sessions to the Codex sessions,
 *  its stop, the cost cap and provider changes (Python's `tests/chat/test_harness.py`). */
import fs from "node:fs"
import path from "node:path"
import { afterAll, expect, onTestFinished, setDefaultTimeout, spyOn, test } from "bun:test"
import type { Scheduler } from "@ngocbh/yian/platform"
import { iterRunRecords } from "@ngocbh/yian/run"
import { type RunUpdated, WorkItem, now } from "@opencorp/protocol"
import { INTERRUPTED_CALL, SessionActor } from "../../src/chat/session_actor.ts"
import { HarnessError, LIVE } from "../../src/chat/state.ts"
import { MAIN_CHAT } from "../../src/chat/turns.ts"
import { PING } from "../../src/daemon/bus.ts"
import { CARD_CLOSED } from "../../src/runs/outcomes.ts"
import { writePrivate } from "../../src/secrets.ts"
import { type SessionRecord, type WorkItemRecord, newId } from "../../src/store/store.ts"
import { type FakeLLM, LLM_CONFIG } from "../../src/testing/fake_llm.ts"
import type { Frame } from "../../src/worker/channel.ts"
import type { OfficeTool } from "../../src/worker/rpc.ts"
import type { Worker } from "../../src/worker/spawn.ts"
import { person } from "../company/helpers.ts"
import { CEO } from "../daemon/helpers.ts"
import { CODEX_PERSON, allGone } from "../harness/helpers.ts"
import { tempDir, waitFor } from "../helpers.ts"
import { question, session } from "../store/helpers.ts"
import {
  ASK_MANAGER,
  ASK_USER,
  ASKED,
  EMPTY,
  LAN,
  PRICES,
  PRICEY,
  TAKE,
  capGate,
  card,
  errors,
  fakeLlm,
  free,
  makeHarness,
  noWorkersLeft,
  replyRunning,
  scriptedWorker,
  state,
  status,
  texts,
  waitingResult,
} from "./helpers.ts"

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
  await replyRunning(h)
  expect(await h.harness.steer(id, "Also mention Rome.")).toBe("steer")
  fake.release()
  expect(await asked(fake, 2)).toContain("Also mention Rome.")
  await waitFor(() => status(h, id) === "idle" && same(texts(h, id).slice(-1), ["Done."]), { what: "the reply" })
  expect(texts(h, id, "user")).toEqual(["hi", "Also mention Rome."])
  // Read once the worker has exited, so the messages are the log's alone: a live worker's view adds its calls in
  // flight, and yian names the first call after a steer one step too early, so its text would show twice.
  await asleep(h, id)
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
  await replyRunning(h)
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

test("esc right after sending stops that reply before it calls the model and the next prompt is answered", async () => {
  const fake = await fakeLlm()
  fake.script({ content: "Answering both." })
  const h = await makeHarness(fake)
  const { id } = await start(h)
  await asleep(h, id)
  // Not awaited: the Esc is queued behind the send, so it reaches the run before the reply starts.
  const sent = h.harness.prompt(id, "first-turn-text")
  await h.harness.interrupt(id)
  expect(await sent).toBe("turn")
  await waitFor(() => status(h, id) === "idle", { what: "the stopped reply" })
  await asleep(h, id)
  expect(fake.requests()).toEqual([])
  expect(texts(h, id)).toEqual(["[interrupted]"])
  expect(texts(h, id, "user")).toEqual(["first-turn-text"])
  expect(await h.harness.prompt(id, "again")).toBe("turn")
  await waitFor(() => same(texts(h, id), ["[interrupted]", "Answering both."]) && status(h, id) === "idle", {
    what: "the next reply",
  })
  expect(fake.requests()).toHaveLength(1)
  expect(texts(h, id, "user")).toEqual(["first-turn-text", "again"])
  // The run's memory kept the stopped turn's message.
  expect(await asked(fake, 1)).toContain("first-turn-text")
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
  await replyRunning(h)
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
      await replyRunning(h)
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
  // The provider error names the connection's file: it goes to the office log, not to the caller.
  expect(error.message).toBe(`session ${s!.id} failed to start: its connection can't be used; see the office log`)
  expect(h.logs.some((line) => line.includes(file) && line.includes("private"))).toBe(true)
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
  // A 422 says which field failed, never its value; the office log says why a workspace was refused.
  if (error.status === 422) {
    expect(error.message).not.toContain(handle)
    expect(error.message).not.toContain(cwd ?? h.folder)
  }
  if (code === "unsafe_workspace") expect(h.logs.some((line) => line.includes("workspace / "))).toBe(true)
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
  expect(error.message).toBe("cwd can't be a workspace; use a project folder (the office log says why)")
  expect(h.logs.some((line) => line.includes(fs.realpathSync(cwd)))).toBe(true)
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

test("restore restores the chat sessions then the codex sessions", async () => {
  const h = await makeHarness(await fakeLlm(), { codex: true })
  const s = await start(h)
  await asleep(h, s.id)
  // Neither a Codex session nor an ended chat is a chat session's actor's to restore.
  h.store.createSession(session({ harness: "codex", harness_session_id: "thr_1", status: "idle" }))
  await stored(h, { status: "ended" })
  const order: string[] = []
  const restore = SessionActor.prototype.restore
  const actors = spyOn(SessionActor.prototype, "restore").mockImplementation(function (this: SessionActor) {
    order.push(this.sessionId)
    return restore.call(this)
  })
  onTestFinished(() => actors.mockRestore())
  spyOn(h.codex!.sessions, "restore").mockImplementation(async () => void order.push("codex"))
  await h.harness.restore()
  expect(order).toEqual([s.id, "codex"])
  expect([status(h, s.id), h.registry.get(s.id)]).toEqual(["idle", undefined])
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
  await h.harness.closeAll()
  await h.harness.closeAll()
  expect(workers).toHaveBeenCalledTimes(1)
  expect(h.logs.filter((line) => line.includes("the codex sessions didn't close (Error)"))).toHaveLength(1)
  expect(h.logs.some((line) => line.includes("sentinel"))).toBe(false)
})

// --- the stop -------------------------------------------------------------------------------

/** Runs `fn` in place of `h`'s registry's next `closeAll`, which `fn` gets to call. */
function duringClose(h: Harness, fn: (close: () => Promise<void>) => Promise<void>): void {
  const close = h.registry.closeAll.bind(h.registry)
  h.registry.closeAll = async (ms) => {
    h.registry.closeAll = close
    await fn(() => close(ms))
  }
}

/** A worker request from a scripted worker's handlers: what it answers or rejects with. */
function request(call: () => unknown): Promise<unknown> {
  return Promise.resolve().then(call)
}

test("nothing the harness does touches the store after close all", async () => {
  const h = await makeHarness(await fakeLlm(), { prices: PRICES })
  const workers = scriptedWorker(h)
  const s = await h.harness.startSession("minh", h.folder)
  const exited: unknown[] = []
  h.hooks.workerExited.push((...args) => void exited.push(args))
  await h.harness.closeAll()
  const stored = () =>
    JSON.stringify([h.store.getSession(s.id), h.store.getRun(s.run_ids[0]!), h.store.listWorkItems()])
  const before = stored()
  const { worker, handlers } = workers[0]!
  // A model call over the cap, then the worker's exit: each would write had the harness not stopped.
  const usage = { input_tokens: 6, output_tokens: 0 }
  handlers.event(worker, { type: "event", name: "ModelCallFinished", data: { model: "stub", usage } })
  handlers.exited(worker, 1)
  await Bun.sleep(50)
  expect(stored()).toBe(before)
  expect(exited).toEqual([])
})

test("close all refuses and cancels worker requests only once the channels are closed", async () => {
  let release!: () => void
  const gate = new Promise<void>((resolve) => (release = resolve))
  const toolbox: Record<string, OfficeTool> = {
    slow: { description: "Waits.", parameters: EMPTY, call: () => gate.then(() => "late") },
    quick: { description: "Answers.", parameters: EMPTY, call: () => "ok" },
  }
  const h = await makeHarness(await fakeLlm(), { groups: { toolbox } })
  const workers = scriptedWorker(h)
  const s = await h.harness.startSession("minh", h.folder)
  const { worker, handlers } = workers[0]!
  const call = (name: string, n: number) =>
    request(() => handlers.toolCall(worker, "toolbox", name, {}, `${s.run_ids[0]}/c${n}`))
  let answered: unknown = "unanswered"
  const slow = call("slow", 1).then((result) => (answered = result))
  const seen: unknown[] = []
  duringClose(h, async (close) => {
    // A request arriving before the workers' channels close is served; the office call in flight still runs.
    seen.push(await call("quick", 2), answered)
    await close()
  })
  let stopped = false
  const stopping = h.harness.closeAll().then(() => (stopped = true))
  expect(await slow).toBe(INTERRUPTED_CALL)
  expect(seen).toEqual(["ok", "unanswered"])
  await expect(call("quick", 3)).rejects.toThrow("the office is stopping")
  // The cut call's body still runs, and the stop waits for it.
  await Bun.sleep(50)
  expect(stopped).toBe(false)
  release()
  await stopping
})

test("a stopping harness refuses new worker requests", async () => {
  const h = await makeHarness(await fakeLlm())
  const workers = scriptedWorker(h)
  const s = await h.harness.startSession("minh", h.folder)
  const { worker, handlers } = workers[0]!
  await h.harness.closeAll()
  const asked = request(() => handlers.askUser(worker, ASKED, `${s.run_ids[0]}/c1`))
  await expect(asked).rejects.toThrow("the office is stopping")
  const echoed = request(() => handlers.toolCall(worker, "toolbox", "fake__echo", { text: "x" }, `${s.run_ids[0]}/c2`))
  await expect(echoed).rejects.toThrow("the office is stopping")
  expect(h.store.listQuestions({ sessionId: s.id, source: "ask_user" })).toEqual([])
})

test("an office stop leaves its sessions live for the next office", async () => {
  const fake = await fakeLlm()
  const working = { content: "Working", tool_calls: [ECHO], hold: true }
  fake.script(working, working, { content: "spare" })
  const h = await makeHarness(fake)
  const ended = endings(h)
  const { id } = await start(h)
  await h.harness.prompt(id, "hi")
  await fake.waitForRequests(1)
  process.kill(-h.registry.get(id)!.pgid, "SIGKILL")
  // The first death gets its one retry, which resumes the reply.
  await fake.waitForRequests(2)
  expect(h.kinds).toEqual(["chat", "advance", "advance"])
  await h.office.stop()
  const s = h.store.getSession(id)!
  expect(LIVE).toContain(s.status)
  expect(h.store.getRun(s.run_ids.at(-1)!)?.endReason).toBeNull()
  expect(ended).toEqual([])
})

test("a message the worker took as the stop began is answered with its seq", async () => {
  const h = await makeHarness(await fakeLlm())
  const workers = scriptedWorker(h)
  const s = await h.harness.startSession("minh", h.folder)
  const scripted = workers[0]!
  const sent = h.harness.prompt(s.id, "hi")
  await waitFor(() => scripted.deliveries.length === 1, { what: "the send" })
  duringClose(h, async (close) => {
    const id = scripted.deliveries[0]!.id
    scripted.handlers.deliverReply(scripted.worker, { type: "deliver_reply", id, seq: 3 })
    await close()
  })
  await h.harness.closeAll()
  // No node event came: the run isn't at its turn, so the message waits for one.
  expect(await sent).toBe("queued")
})

test("a wake at timer firing during the stop spawns nothing", async () => {
  const start = Date.parse("2026-10-25T00:00:00.000Z")
  const clock = { now: start }
  const sleeps: (() => void)[] = []
  const scheduler: Scheduler = {
    now: () => clock.now,
    sleep: (_ms, signal) =>
      new Promise<void>((resolve, reject) => {
        if (signal?.aborted) return reject(signal.reason)
        signal?.addEventListener("abort", () => reject(signal.reason), { once: true })
        sleeps.push(resolve)
      }),
  }
  const h = await makeHarness(await fakeLlm(), { scheduler })
  const workers = scriptedWorker(h)
  const s = await h.harness.startSession("minh", h.folder)
  const deadline = new Date(start + 3_600_000).toISOString()
  const { worker, handlers } = workers[0]!
  handlers.result(worker, waitingResult(s.run_ids[0]!, [{ ...TAKE, deadline }]))
  handlers.exited(worker, 0)
  await waitFor(() => sleeps.length === 1, { what: "the timer" })
  let release!: () => void
  const held = new Promise<void>((resolve) => (release = resolve))
  duringClose(h, async (close) => {
    await held
    await close()
  })
  // The stop has begun, the registry's close is held: the deadline comes.
  const stopping = h.harness.closeAll()
  clock.now = Date.parse(deadline)
  sleeps.at(-1)!()
  await waitFor(() => h.logs.some((line) => line.includes("a worker can't start (RegistryClosed)")), {
    what: "the wake refused",
  })
  release()
  await stopping
  expect(h.kinds).toEqual(["chat"])
})

test("a finished session leaves no actor for the stop", async () => {
  const fake = await fakeLlm()
  const h = await makeHarness(fake)
  const ended = endings(h)
  const { id } = await start(h)
  await h.harness.end(id)
  await waitFor(() => ended.length === 1 && h.registry.get(id) === undefined, { what: "the end" })
  const close = spyOn(SessionActor.prototype, "close")
  onTestFinished(() => close.mockRestore())
  await h.harness.closeAll()
  expect(close).not.toHaveBeenCalled()
})

test("a start racing the stop stores nothing", async () => {
  const h = await makeHarness(await fakeLlm())
  let release!: () => void
  const held = new Promise<void>((resolve) => (release = resolve))
  let entered!: () => void
  const opening = new Promise<void>((resolve) => (entered = resolve))
  const commit = h.office.git.commitHandEdits.bind(h.office.git)
  spyOn(h.office.git, "commitHandEdits").mockImplementation(async () => {
    entered()
    await held
    return commit()
  })
  const started = rejection(h.harness.startSession("minh", h.folder))
  await opening
  const stopping = h.harness.closeAll()
  release()
  const error = await started
  expect([error.status, error.code]).toEqual([503, "stopping"])
  await stopping
  expect(h.store.listSessions()).toEqual([])
  expect(h.store.listWorkItems()).toEqual([])
})

// --- the cost cap ---------------------------------------------------------------------------

/** `h`'s "raise the cost cap" work items, oldest first. */
function capItems(h: Harness): WorkItemRecord[] {
  return h.store
    .listWorkItems()
    .filter((item) => item.title.startsWith("Raise the cost cap"))
    .sort((a, b) => (a.id < b.id ? -1 : 1))
}

/** Whether session `sid` is held at its cap with `cost` spent and no worker. */
function atTheHold(h: Harness, sid: string, cost: number): boolean {
  const s = h.store.getSession(sid)!
  return s.cost === cost && s.status === "waiting" && s.capped && h.registry.get(sid) === undefined
}

/** The actor each session command runs on, by session id: `SessionActor.prototype.prompt`, spied. */
function actorsOf(): Map<string, SessionActor> {
  const seen = new Map<string, SessionActor>()
  const prompt = SessionActor.prototype.prompt
  const spy = spyOn(SessionActor.prototype, "prompt").mockImplementation(function (
    this: SessionActor,
    ...args: Parameters<SessionActor["prompt"]>
  ) {
    seen.set(this.sessionId, this)
    return prompt.apply(this, args)
  })
  onTestFinished(() => spy.mockRestore())
  return seen
}

/** A harness whose model costs $1 an input token, its `noop` tool answering once the cap stopped its worker. */
async function cappedHarness(fake: FakeLLM) {
  const gate = capGate()
  const h = await makeHarness(fake, { prices: PRICES, groups: gate.groups })
  return { h, gate }
}

test("the cost cap holds turns until raised", async () => {
  const fake = await fakeLlm()
  fake.script(PRICEY, free("after the raise"), free("spare"))
  const { h, gate } = await cappedHarness(fake)
  const { id } = await start(h)
  gate.watch(h)
  await h.harness.prompt(id, "hi")
  await waitFor(() => atTheHold(h, id, 6) && capItems(h).length === 1, { what: "the stop at the cap" })
  // The reply was stopped, not interrupted.
  expect(gate.stops()).toBe(1)
  expect(state(h, id)).toEqual({ status: "waiting", waiting_on: [CEO], capped: true })
  expect(capItems(h)[0]!.assignee).toBe(CEO)
  const before = h.jobs.length
  expect(await h.harness.prompt(id, "held")).toBe("queued")
  expect(h.jobs.slice(before)).toMatchObject([{ kind: "advance", advance: false, deliver: [{ op: "send" }] }])
  const low = await rejection(h.harness.setCostCap(id, 6))
  expect(low.code).toBe("cap_too_low")
  await h.harness.setCostCap(id, 20)
  await waitFor(() => same(texts(h, id).slice(-1), ["after the raise"]) && status(h, id) === "idle", {
    what: "the held turn",
  })
  expect(await asked(fake, 2)).toContain("held")
})

test("raising the cap closes its work item and going over again opens one", async () => {
  const fake = await fakeLlm()
  fake.script(...[0, 1, 2].map((n) => ({ content: `reply ${n}`, usage: { prompt_tokens: 6, completion_tokens: 1 } })))
  fake.script(free("spare"))
  const h = await makeHarness(fake, { prices: PRICES })
  const actors = actorsOf()
  const { id, work_item_id: parent } = await start(h)
  const statuses = () => capItems(h).map((item) => item.status)
  for (const [n, cap] of [
    [0, null],
    [1, 7],
    [2, 13],
  ] as const) {
    if (cap === null) await h.harness.prompt(id, "hi")
    else {
      // Held at the cap: sent, not advanced.
      expect(await h.harness.prompt(id, `more ${n}`)).toBe("queued")
      await h.harness.setCostCap(id, cap)
      // Raising it closes the item.
      expect(statuses()).toEqual(Array(n).fill("done"))
    }
    await waitFor(() => atTheHold(h, id, 6 * (n + 1)) && statuses().length === n + 1, { what: `charge ${n}` })
    if (n < 2) {
      // Over again: one open item, however often the cap check runs.
      await actors.get(id)!.checkCap()
      expect(statuses()).toEqual([...Array(n).fill("done"), "open"])
    }
  }
  const items = capItems(h)
  expect(items.map((item) => item.status)).toEqual(["done", "done", "open"])
  expect(new Set(items.map((item) => item.parent_id))).toEqual(new Set([parent]))
})

test("a cap item belongs to one session even without a work item", async () => {
  const h = await makeHarness(await fakeLlm(), { prices: PRICES })
  const workers = scriptedWorker(h)
  const s = await h.harness.startSession("minh", h.folder)
  h.store.updateSession(s.id, { work_item_id: null })
  const t = now()
  const other = h.store.createWorkItem(
    WorkItem.parse({
      id: newId(),
      title: "Raise the cost cap of @someone's session",
      kind: "task",
      status: "open",
      requester: "p-x",
      parent_id: null,
      summary: "Session s-other reached its cap.",
      created_at: t,
      updated_at: t,
    }),
  )
  // A model call over the cap: the session opens its own item, not s-other's.
  const { worker, handlers } = workers[0]!
  const usage = { input_tokens: 6, output_tokens: 0 }
  handlers.event(worker, { type: "event", name: "ModelCallFinished", data: { model: "stub", usage } })
  await waitFor(() => capItems(h).length === 2, { what: "the cap item" })
  const mine = capItems(h).find((item) => item.id !== other.id)!
  expect(mine).toMatchObject({ status: "open", parent_id: null })
  expect(mine.summary).toStartWith(`Session ${s.id} `)
  expect(h.store.getWorkItem(other.id)).toEqual(other)
})

const SENTINEL = "sk-sentinel-7c2a51"

/** A harness on `fake` whose model key is `SENTINEL`. */
function keyed(fake: FakeLLM) {
  return makeHarness(fake, { llmConfig: { ...LLM_CONFIG, api_key: SENTINEL } })
}

test("the model key goes to the job llm config not its env", async () => {
  const h = await keyed(await fakeLlm())
  const envs: unknown[] = []
  const spawn = h.registry.spawn.bind(h.registry)
  h.registry.spawn = (job, dir, handlers, options) => {
    envs.push(options?.env)
    return spawn(job, dir, handlers, options)
  }
  const s = await start(h)
  expect(h.jobs).toHaveLength(1)
  expect(h.jobs[0]!.llm_config).toMatchObject({ api_key: SENTINEL })
  expect(envs).toHaveLength(1)
  expect(JSON.stringify(envs)).not.toContain(SENTINEL)
  expect(JSON.stringify(h.store.getSession(s.id))).not.toContain(SENTINEL)
})

test("the model key appears in no frame event or office file", async () => {
  const fake = await fakeLlm()
  fake.script({ content: "ok" })
  const h = await keyed(fake)
  const frames: Frame[] = []
  const spawn = h.registry.spawn.bind(h.registry)
  h.registry.spawn = (job, dir, handlers, options) => {
    const record =
      (name: "event" | "stream" | "result" | "error") =>
      (worker: Worker, frame: Frame): void => {
        frames.push(frame)
        handlers[name](worker, frame)
      }
    const recorded = { ...handlers, event: record("event"), stream: record("stream") }
    return spawn(job, dir, { ...recorded, result: record("result"), error: record("error") }, options)
  }
  const live = spyOn(h.office.bus, "publishLive")
  const meta = spyOn(h.office.bus, "publishMeta")
  const hooked: unknown[] = []
  h.hooks.runFinished.push((...args) => void hooked.push(args))
  h.hooks.sessionEnded.push((...args) => void hooked.push(args))
  h.hooks.workerExited.push((...args) => void hooked.push(args))
  const { id } = await start(h)
  await h.harness.prompt(id, "hi")
  // The next turn, not just the text: the text part is stored at its first chunk, before it ends.
  await waitFor(
    () =>
      (same(texts(h, id), ["ok"]) && status(h, id) === "idle") ||
      h.store.getSession(id)!.run_ids.length > 1 ||
      status(h, id) === "failed",
    { what: "the next turn or a failed run" },
  )
  await h.harness.closeAll()
  const hasKey = (value: unknown) =>
    JSON.stringify(value, (_key, v) => (typeof v === "bigint" ? String(v) : v)).includes(SENTINEL)
  const leaks: string[] = []
  for (const frame of frames) if (hasKey(frame)) leaks.push(`frame ${frame.type} ${frame.name ?? ""}`)
  for (const [event] of [...live.mock.calls, ...meta.mock.calls]) if (hasKey(event)) leaks.push(`live ${event.type}`)
  // Where the key is kept.
  const keys = path.join(h.office.connections.dir, "office.json")
  for (const root of [h.office.paths.home, h.folder]) {
    for (const rel of fs.readdirSync(root, { recursive: true }) as string[]) {
      const file = path.join(root, rel)
      if (file === keys || !fs.statSync(file).isFile()) continue
      if (fs.readFileSync(file).includes(SENTINEL)) leaks.push(`file ${rel}`)
    }
  }
  if (hasKey(hooked)) leaks.push("hook")
  if (fake.requests().some(hasKey)) leaks.push("model request")
  expect(leaks).toEqual([])
  expect(texts(h, id)).toEqual(["ok"])
})

test("a held session keeps a queued message until the cap is raised", async () => {
  const fake = await fakeLlm()
  fake.script(PRICEY, free("after the raise"), free("spare"))
  const { h, gate } = await cappedHarness(fake)
  const { id } = await start(h)
  gate.watch(h)
  await h.harness.prompt(id, "hi")
  await waitFor(() => atTheHold(h, id, 6), { what: "the stop at the cap" })
  const before = h.jobs.length
  expect(await h.harness.prompt(id, "please continue")).toBe("queued")
  await waitFor(() => h.registry.get(id) === undefined, { what: "the delivering worker to exit" })
  // An unread send in the run's inbox: delivered, not advanced.
  expect(h.jobs.slice(before)).toMatchObject([{ kind: "advance", advance: false, deliver: [{ op: "send" }] }])
  expect(state(h, id)).toEqual({ status: "waiting", waiting_on: [CEO], capped: true })
  expect(fake.requests()).toHaveLength(1)
  await h.harness.setCostCap(id, 20)
  await waitFor(() => same(texts(h, id).slice(-1), ["after the raise"]) && status(h, id) === "idle", {
    what: "the held turn",
  })
  expect(await asked(fake, 2)).toContain("please continue")
})

test("a turn that opens held keeps the messages queued before it", async () => {
  const fake = await fakeLlm()
  fake.script({ ...PRICEY, hold: 30 }, free("after the raise"), free("spare"))
  const { h, gate } = await cappedHarness(fake)
  const { id } = await start(h)
  gate.watch(h)
  await h.harness.prompt(id, "hi")
  await fake.waitForRequests(1)
  await replyRunning(h)
  // The reply runs: it reads the message before its next model call, which the cap's stop comes before.
  expect(await h.harness.prompt(id, "more")).toBe("steer")
  fake.release()
  await waitFor(() => atTheHold(h, id, 6), { what: "the stop at the cap" })
  expect(fake.requests()).toHaveLength(1)
  await h.harness.setCostCap(id, 20)
  await waitFor(() => same(texts(h, id).slice(-1), ["after the raise"]) && status(h, id) === "idle", {
    what: "the held turn",
  })
  expect(await asked(fake, 2)).toContain("more")
  expect(texts(h, id, "user")).toEqual(["hi", "more"])
})

// --- provider changes -----------------------------------------------------------------------

/** Gives the office connection the model key `key`. */
async function rekey(h: Harness, key: string): Promise<void> {
  const file = path.join(h.office.connections.dir, "office.json")
  const provider = JSON.parse(fs.readFileSync(file, "utf8"))
  await writePrivate(file, JSON.stringify({ ...provider, llm_config: { ...provider.llm_config, api_key: key } }))
}

test("a turn after the provider changes runs on the new provider", async () => {
  const fake = await fakeLlm()
  fake.script({ content: "One." }, { content: "Two." })
  const h = await makeHarness(fake)
  const { id } = await start(h)
  await h.harness.prompt(id, "first")
  await waitFor(() => same(texts(h, id), ["One."]) && status(h, id) === "idle", { what: "the first reply" })
  await asleep(h, id)
  const before = h.jobs.length
  await rekey(h, "sk-new")
  expect(await h.harness.prompt(id, "second", { by: "lan" })).toBe("turn")
  await waitFor(() => same(texts(h, id), ["One.", "Two."]) && status(h, id) === "idle", {
    what: "the reply on the new provider",
  })
  expect(authors(h, id)).toEqual({ first: "ngocbh", second: "lan" })
  expect(h.jobs.slice(before).map((job) => [job.kind, job.llm_config?.api_key])).toEqual([["chat", "sk-new"]])
  expect(h.store.getSession(id)!.run_ids).toHaveLength(2)
  expect(texts(h, id, "user")).toEqual(["first", "second"])
})

test("ending while a new provider takes over ends the session", async () => {
  const fake = await fakeLlm()
  fake.script({ content: "spare" })
  const h = await makeHarness(fake)
  const { id } = await start(h)
  await rekey(h, "sk-new")
  expect(await h.harness.prompt(id, "hi")).toBe("turn")
  await h.harness.end(id)
  await waitFor(() => status(h, id) === "ended", { what: "the end" })
})

// --- failures -------------------------------------------------------------------------------

/** A `failed` result frame of run `runId`, failed with `failure`. */
function failedResult(runId: string, failure: Record<string, unknown>): Frame {
  return { type: "result", status: "failed", run_id: runId, output: null, failure, waits: [] }
}

test("a failed run says so and starts a new run", async () => {
  const fake = await fakeLlm()
  fake.script({ error: 500 }, { content: "Back." })
  const h = await makeHarness(fake)
  const { id } = await start(h)
  await h.harness.prompt(id, "hi")
  await waitFor(() => h.store.getSession(id)!.run_ids.length === 2 && status(h, id) === "idle", {
    what: "the new run",
  })
  const [error, ...rest] = errors(h, id)
  expect(rest).toEqual([])
  expect(error).toStartWith("The reply failed (")
  expect(error).toEndWith("Send your message again.")
  expect(texts(h, id)).toEqual([])
  // The notice is never in the transcript.
  expect(h.harness.messages(id).flatMap((m) => m.parts.filter((p) => p.type === "error"))).toEqual([])
  await h.harness.prompt(id, "again")
  await waitFor(() => same(texts(h, id).slice(-1), ["Back."]), { what: "the reply" })
})

test("a message sent during a reply that then fails is answered by the fresh run", async () => {
  const fake = await fakeLlm()
  fake.script({ error: 500, hold: true }, { content: "Got it." })
  const h = await makeHarness(fake)
  const { id } = await start(h)
  await h.harness.prompt(id, "hi")
  await fake.waitForRequests(1)
  await replyRunning(h)
  expect(await h.harness.prompt(id, "more")).toBe("steer")
  fake.release()
  // The reply failed at its first model call, so it never read the message, which moves to the fresh run.
  await waitFor(
    () => h.store.getSession(id)!.run_ids.length === 2 && same(texts(h, id), ["Got it."]) && status(h, id) === "idle",
    { what: "the fresh run's reply" },
  )
  expect(errors(h, id)).toHaveLength(1)
  expect(errors(h, id)[0]).toStartWith("The reply failed (")
  expect(await asked(fake, 2)).toContain("more")
})

test("a failed reply is no longer the running reply", async () => {
  const h = await makeHarness(await fakeLlm())
  const workers = scriptedWorker(h)
  const s = await h.harness.startSession("minh", h.folder)
  const scripted = workers[0]!
  const { worker, handlers } = scripted
  /** Sends `text` and answers its delivery as the run taking it at `seq`; resolves to its reply. */
  const sent = async (text: string, seq: number) => {
    const reply = h.harness.prompt(s.id, text)
    await waitFor(() => scripted.deliveries.length === seq, { what: `the send of ${text}` })
    handlers.deliverReply(worker, { type: "deliver_reply", id: scripted.deliveries[seq - 1]!.id, seq })
    return reply
  }
  handlers.event(worker, { type: "event", name: "NodeStarted", data: { node_id: "chat#0/reply" } })
  expect(await sent("more", 1)).toBe("steer")
  const failure = { node_id: "chat#0/reply", message: "boom" }
  handlers.event(worker, { type: "event", name: "NodeFailed", data: { failure } })
  expect(await sent("again", 2)).not.toBe("steer")
})

test("run finished hooks never see the model key", async () => {
  const h = await keyed(await fakeLlm())
  const workers = scriptedWorker(h)
  const seen: Frame[] = []
  h.hooks.runFinished.push((_s, _runId, result) => void seen.push(result as Frame))
  const s = await h.harness.startSession("minh", h.folder)
  const { worker, handlers } = workers[0]!
  // Not the reply: a failed reply starts a fresh run, and this run's failure fails the session.
  const failure = {
    node_id: "chat",
    message: `1 validation error: api_key Input: '${SENTINEL}'`,
    details: [{ input: { api_key: SENTINEL } }, SENTINEL],
  }
  handlers.result(worker, failedResult(s.run_ids[0]!, failure))
  handlers.exited(worker, 1)
  await waitFor(() => seen.length === 1, { what: "the run's end" })
  expect(JSON.stringify(seen)).not.toContain(SENTINEL)
  const reported = seen[0]!.failure as typeof failure
  expect(reported.message).toBe("1 validation error: api_key Input: '[redacted]'")
  expect(reported.details).toEqual([{ input: { api_key: "[redacted]" } }, "[redacted]"])
})

test("a failed session says why without the model key", async () => {
  const h = await keyed(await fakeLlm())
  const workers = scriptedWorker(h)
  const s = await h.harness.startSession("minh", h.folder)
  const { worker, handlers } = workers[0]!
  const failure = { node_id: "chat", cause_type: "AuthError", message: `bad key ${SENTINEL} ${"x".repeat(900)}` }
  handlers.result(worker, failedResult(s.run_ids[0]!, failure))
  handlers.exited(worker, 1)
  await waitFor(() => status(h, s.id) === "failed", { what: "the failure" })
  const [error, ...rest] = errors(h, s.id)
  expect(rest).toEqual([])
  expect(error).toStartWith("The session failed (AuthError: bad key [redacted] xxx")
  expect(error).not.toContain(SENTINEL)
  expect(error!.length).toBeLessThan(600)
  expect(error).toEndWith("Start a new chat.")
})

test("a session whose worker keeps dying says so", async () => {
  const h = await makeHarness(await fakeLlm())
  const workers = scriptedWorker(h)
  const s = await h.harness.startSession("minh", h.folder)
  workers[0]!.handlers.exited(workers[0]!.worker, 1)
  await waitFor(() => workers.length === 2, { what: "the retry" })
  workers[1]!.handlers.exited(workers[1]!.worker, 1)
  await waitFor(() => status(h, s.id) === "failed", { what: "the failure" })
  expect(errors(h, s.id)).toEqual([
    "The session failed (its worker stopped or couldn't start; see the office log). Start a new chat.",
  ])
})

/** Whether `nodes` holds a reply node. */
function replying(nodes: readonly string[] | undefined): boolean {
  return (nodes ?? []).some((n) => n.endsWith("/reply"))
}

test("the harness gives run logs its live runs", async () => {
  const fake = await fakeLlm()
  fake.script({ content: "Hello.", hold: true })
  const h = await makeHarness(fake)
  const s = await start(h)
  const runId = s.run_ids[0]!
  await h.harness.prompt(s.id, "hi")
  await fake.waitForRequests(1, 30_000)
  await waitFor(() => replying(h.harness.live().runs.get(runId)?.nodes), { what: "the reply's start" })
  expect(h.harness.live().runs.get(runId)!.status).toBe("running")
  // Its running nodes come only from the harness's memory.
  const listed = h.office.runs.page().runs.find((r) => r.run_id === runId)
  expect([listed?.status, replying(listed?.current_nodes)]).toEqual(["running", true])
  fake.release()
  await waitFor(() => status(h, s.id) === "idle", { what: "the next turn" })
})

test("the harness actors tell the office when their run changed", async () => {
  const fake = await fakeLlm()
  fake.script({ content: "Hello.", hold: true })
  const h = await makeHarness(fake)
  const sub = h.office.bus.subscribe(null, { types: ["run.updated"] })
  const s = await start(h)
  const runId = s.run_ids[0]!
  await h.harness.prompt(s.id, "hi")
  await fake.waitForRequests(1, 30_000)
  const seen: RunUpdated[] = []
  await waitFor(
    async () => {
      while (sub.queued > 0) {
        const item = await sub.next(0)
        if (item !== null && item !== PING) seen.push(item[1].data as RunUpdated)
      }
      return seen.some((u) => u.run_id === runId && replying(u.current_nodes))
    },
    { what: "the run's run.updated" },
  )
  fake.release()
  await waitFor(() => status(h, s.id) === "idle", { what: "the next turn" })
})

test("a profile manager spec has only the profile tools and no workspace", async () => {
  const h = await makeHarness(await fakeLlm())
  // Its folder is the company's own, which no chat's workspace may be: a profile manager has none to check.
  const s = await stored(h, { kind: "profile_manager", cwd: h.office.paths.company, status: "starting" })
  const spec = await h.harness.spec(s)
  expect([spec.flow, spec.workspace, spec.memory]).toEqual(["shared/flows/profile_manager.yaml", undefined, {}])
  const groups = spec.groups({ session: s, runId: "run-1" })
  expect(Object.entries(groups).map(([group, tools]) => [group, Object.keys(tools)])).toEqual([
    ["profile", ["read", "propose_edit"]],
  ])
  expect(((await groups.profile!.read!.call({})) as { text: string }).text).toBe("# Minh, Engineer\n")
})

test("start run starts a stored starting session and refuses one that is not starting", async () => {
  const fake = await fakeLlm()
  fake.script({ content: "Hello." })
  const h = await makeHarness(fake)
  const s = await stored(h, { status: "starting" })
  const starting = h.harness.startRun(s.id)
  // Claimed at once: a second call while the first starts would start a second run.
  const twice = await rejection(h.harness.startRun(s.id))
  expect([twice.status, twice.code, twice.message]).toEqual([409, "live", `session ${s.id} is already starting`])
  const runId = await starting
  expect(h.store.getSession(s.id)!.run_ids).toEqual([runId])
  expect(h.store.getRun(runId)).toMatchObject({ driver: CEO, replacesRunId: null })
  await waitFor(() => status(h, s.id) === "idle", { what: "the first turn" })
  const again = await rejection(h.harness.startRun(s.id))
  expect([again.status, again.code, again.message]).toEqual([409, "live", `session ${s.id} is idle`])
  await h.harness.prompt(s.id, "hi")
  await waitFor(() => same(texts(h, s.id), ["Hello."]), { what: "the reply" })
  const missing = await rejection(h.harness.startRun(newId()))
  expect([missing.status, missing.code]).toEqual([404, "not_found"])
})

test("a reopened session starts a fresh run seeded from its last run and driven by its opener", async () => {
  const fake = await fakeLlm()
  fake.script({ content: "First." }, { content: "Second." })
  const h = await makeHarness(fake, { files: LAN })
  const s = await start(h)
  const [first] = s.run_ids
  await h.harness.prompt(s.id, "remember-this-text")
  await waitFor(() => same(texts(h, s.id), ["First."]) && status(h, s.id) === "idle", { what: "the reply" })
  await h.harness.end(s.id)
  await waitFor(() => status(h, s.id) === "ended", { what: "the end" })
  await asleep(h, s.id)
  h.store.updateSession(s.id, { status: "starting", opened_by: "lan" })
  const second = await h.harness.startRun(s.id)
  expect(h.store.getSession(s.id)!.run_ids).toEqual([first!, second])
  expect(h.store.getRun(first!)!.driver).toBe(CEO)
  expect(h.store.getRun(second)).toMatchObject({ driver: "lan", replacesRunId: null })
  await waitFor(() => status(h, s.id) === "idle", { what: "the reopened run's turn" })
  await h.harness.prompt(s.id, "and now")
  // The second run's first model request holds the first run's turn.
  const request = await asked(fake, 2)
  expect(request).toContain("remember-this-text")
  expect(request).toContain("First.")
  await waitFor(() => same(texts(h, s.id), ["First.", "Second."]), { what: "the second reply" })
})

test("a reopened session whose start fails leaves its earlier run untouched", async () => {
  const fake = await fakeLlm()
  const h = await makeHarness(fake)
  const s = await start(h)
  const [first] = s.run_ids
  await h.harness.end(s.id)
  await waitFor(() => status(h, s.id) === "ended", { what: "the end" })
  await asleep(h, s.id)
  expect(h.store.getRun(first!)!.endReason).toBeNull()
  // Reopened in the office's own files: its spec is refused.
  h.store.updateSession(s.id, { status: "starting", cwd: h.office.paths.company })
  const error = await rejection(h.harness.startRun(s.id))
  expect([error.status, error.code]).toEqual([422, "unsafe_workspace"])
  expect(error.message).not.toContain(fs.realpathSync(h.office.paths.company))
  expect(h.logs.some((line) => line.includes(fs.realpathSync(h.office.paths.company)))).toBe(true)
  expect(status(h, s.id)).toBe("failed")
  expect(h.store.getSession(s.id)!.run_ids).toEqual([first!])
  expect(h.store.getRun(first!)!.endReason).toBeNull()
})

/** The kinds of the records in run `runId`'s log. */
function recordKinds(h: Harness, runId: string): string[] {
  const log = path.join(h.office.paths.runs, runId, "log.jsonl")
  return fs.existsSync(log) ? [...iterRunRecords(log)].map((entry) => entry.kind) : []
}

test("abandon ends a live session with the reason and cancels its run", async () => {
  const h = await makeHarness(await fakeLlm())
  const ended = endings(h)
  const s = await start(h)
  const [runId] = s.run_ids
  await h.harness.abandon(s.id, CARD_CLOSED)
  expect(status(h, s.id)).toBe("ended")
  expect(h.store.getRun(runId!)!.endReason).toBe(CARD_CLOSED)
  await waitFor(() => recordKinds(h, runId!).includes("run_cancelled"), { what: "the run's cancel" })
  expect(ended).toEqual(["ended"])
  const late = await rejection(h.harness.abandon(s.id, CARD_CLOSED))
  expect([late.status, late.code]).toEqual([409, "not_live"])
})
