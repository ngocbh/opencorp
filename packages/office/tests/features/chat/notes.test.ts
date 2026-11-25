/** The notes of commands and harness turns that ended: a command, or a Codex turn, the agent was told runs on tells the
 *  session when it ends, as a message signed by its shell or its session. A running reply reads it as a steer, a run at
 *  rest takes it as a new turn, notes that end together share one model call, Esc holds them for the next person's
 *  message, the cost cap holds them for a raise, a note is never sent twice and never answers the model's question, and
 *  nothing is left once the chat ends. A message that reaches the agent ends the wait of the call it is blocked in. */
import fs from "node:fs"
import path from "node:path"
import { afterAll, expect, setDefaultTimeout, test } from "bun:test"
import { stringify } from "yaml"
import { isInstrumentNote } from "@opencorp/protocol"
import { loadRepo } from "../../../src/company/loader.ts"
import { EmployeeCodex } from "../../../src/features/chat/codex.ts"
import type { InstrumentSessions } from "../../../src/features/chat/instrument.ts"
import type { SessionActor } from "../../../src/features/chat/session_actor.ts"
import { speakers } from "../../../src/runtime/sessions/speakers.ts"
import type { SessionRecord } from "../../../src/runtime/store/store.ts"
import type { ThreadEvents } from "../../../src/tools/harness/instrument.ts"
import type { WorkerHandlers } from "../../../src/runtime/worker/rpc.ts"
import type { Worker } from "../../../src/runtime/worker/spawn.ts"
import type { ScriptedReply } from "../../../src/testing/fake_llm.ts"
import { waitFor } from "../../helpers.ts"
import {
  ASK_USER,
  capItem,
  card,
  type ChatOffice,
  chatOffice,
  fakeLlm,
  noWorkersLeft,
  reopen,
  session,
  startActor,
  status,
  texts,
} from "./helpers.ts"

setDefaultTimeout(60_000)
afterAll(noWorkersLeft)

/** A model turn that runs `command` in a new shell and waits `wait` seconds for it. */
function run(command: string, wait = 0): ScriptedReply {
  return { tool_calls: [{ name: "terminal_run", arguments: { command, why: "builds", wait } }] }
}

/** The first line of the note of `command` in `shell` ending with `exit`. */
const heading = (shell: string, command: string, exit: number) => `${shell}: \`${command}\` ended, exit ${exit}`

/** An office whose minh may run `make *`, each command running until `end` ends it or it is stopped; `connections`
 *  are `chatOffice`'s. */
async function notesOffice(fake: Awaited<ReturnType<typeof fakeLlm>>, connections: Record<string, string> = {}) {
  const rules = stringify({ rules: [{ effect: "allow", kind: "command", pattern: "make *" }] })
  const o = await chatOffice(fake, { files: { "people/minh/rules.yaml": rules }, connections })
  const ends = new Map<string, (result: { output?: string; exit: number | null }) => void>()
  o.pipes.run = (command, signal) =>
    new Promise((resolve) => {
      ends.set(command, resolve)
      const stop = () => {
        ends.delete(command)
        resolve({ exit: null })
      }
      signal.addEventListener("abort", stop, { once: true })
    })
  const end = (command: string, exit: number, output = "") => {
    const resolve = ends.get(command)
    if (resolve === undefined) throw new Error(`${command} isn't running`)
    ends.delete(command)
    resolve({ output, exit })
  }
  return { o, end }
}

/** The notes session `sid`'s transcript shows: its user messages the office marks as an instrument's, by their text. */
function notes(o: ChatOffice, sid: string): string[] {
  return o.transcript
    .messages(sid, session(o, sid).run_ids)
    .filter((message) => isInstrumentNote(message))
    .flatMap((message) => message.parts.flatMap((part) => (part.type === "text" ? [part.text] : [])))
}

/** The log lines of the run `runId` of `o` that commit a note to an inbox: a send under a terminal's key. */
function loggedNotes(o: ChatOffice, runId: string): string[] {
  return fs
    .readFileSync(path.join(o.office.paths.runs, runId, "log.jsonl"), "utf8")
    .split("\n")
    .filter((line) => line.includes('"kind":"pool_commit"') && line.includes('"send_key":"terminal:'))
}

/** Whether the model's request `n` (from 1) holds `text`. */
function asked(fake: Awaited<ReturnType<typeof fakeLlm>>, n: number, text: string): boolean {
  return JSON.stringify(fake.requests()[n - 1]?.messages ?? []).includes(JSON.stringify(text).slice(1, -1))
}

/** Starts minh's chat, has the agent start its commands and end its reply ("Started."), and waits for the session to
 *  rest. */
async function started(o: ChatOffice): Promise<{ actor: SessionActor; sid: string }> {
  const { actor, sid } = await startActor(o)
  await actor.prompt("build it")
  await waitFor(() => texts(o, sid).includes("Started.") && status(o, sid) === "idle" && !actor.hasWorker, {
    what: "the first reply",
  })
  return { actor, sid }
}

test("a command that ends while the agent's reply runs reaches it as a steer before its next model call", async () => {
  const fake = await fakeLlm()
  fake.script(
    run("make all"),
    run("make docs", 60),
    { match: heading("shell 1", "make all", 0), content: "Both built." },
    { match: heading("shell 2", "make docs", 0), content: "Docs too." },
  )
  const { o, end } = await notesOffice(fake)
  const { actor, sid } = await startActor(o)
  await actor.prompt("build it")
  // The reply waits on make docs when make all ends.
  await waitFor(() => o.pipes.commands.length === 2, { what: "both commands" })
  end("make all", 0, "built\n")
  await waitFor(() => loggedNotes(o, actor.runId!).length === 1, { what: "the note in the inbox" })
  await waitFor(() => texts(o, sid).includes("Both built.") && status(o, sid) === "idle", { what: "the reply" })
  expect(fake.requests()).toHaveLength(3)
  expect(asked(fake, 3, heading("shell 1", "make all", 0))).toBe(true)
  // The note ended the reply's wait on make docs, which runs on.
  expect(asked(fake, 3, "Your wait ended early")).toBe(true)
  expect(o.pipes.commands).toEqual(["make all", "make docs"])
  // It shows as a note from the office, between the reply's calls and what the model said after reading it.
  const [note] = notes(o, sid)
  expect(note!.split("\n")[0]).toBe(heading("shell 1", "make all", 0))
  expect(note).toContain("built")
  const shown = o.transcript.messages(sid, session(o, sid).run_ids).map((m) => `${m.role}:${m.instrument?.name ?? ""}`)
  expect(shown.slice(-3)).toEqual(["assistant:", "user:shell 1", "assistant:"])
  expect(session(o, sid).turns).toBe(1)
  // make docs gets its own note when it ends.
  end("make docs", 0)
  await waitFor(() => texts(o, sid).includes("Docs too.") && status(o, sid) === "idle", { what: "the docs note's turn" })
})

test("a command that ends while the agent rests starts a new turn with its note", async () => {
  const fake = await fakeLlm()
  fake.script(run("make all"), { content: "Started." }, { match: heading("shell 1", "make all", 2), content: "It failed." })
  const { o, end } = await notesOffice(fake)
  const { sid } = await started(o)
  end("make all", 2, "error: no rule\n")
  await waitFor(() => texts(o, sid).includes("It failed.") && status(o, sid) === "idle", { what: "the woken reply" })
  expect(fake.requests()).toHaveLength(3)
  // The model reads it signed by its shell, never by the office.
  expect(asked(fake, 3, 'author="shell 1"')).toBe(true)
  expect(asked(fake, 3, 'author="office"')).toBe(false)
  expect(notes(o, sid).map((note) => note.split("\n")[0])).toEqual([heading("shell 1", "make all", 2)])
  // The protocol carries it as a user message the office marks as its shell's.
  const message = o.transcript.messages(sid, session(o, sid).run_ids).find((m) => isInstrumentNote(m))
  const [shell] = o.office.instruments.list(sid)
  expect(message).toMatchObject({ role: "user", author: null, instrument: { id: shell!.id, name: "shell 1" } })
})

/** The note of the owner, @ngocbh, closing `shell`, with the command it stopped if any. */
const closedNote = (shell: string, command?: string) =>
  command === undefined
    ? `${shell}: closed by @ngocbh.`
    : `${shell}: closed by @ngocbh while \`${command}\` ran; the command was stopped.`

/** How many times the model's request `n` (from 1) holds `text`. */
function times(fake: Awaited<ReturnType<typeof fakeLlm>>, n: number, text: string): number {
  return JSON.stringify(fake.requests()[n - 1]?.messages ?? []).split(JSON.stringify(text).slice(1, -1)).length - 1
}

/** The owner, @ngocbh, closes session `sid`'s shell named `name`, as the instrument route does. */
async function ownerCloses(o: ChatOffice, sid: string, name: string): Promise<string> {
  const shell = o.office.instruments.list(sid).find((i) => i.name === name)!
  await o.office.instruments.get(sid, shell.id)!.close!("ngocbh")
  return shell.id
}

test("the owner's close of a shell never wakes the resting agent: its note goes once, with their next message", async () => {
  const fake = await fakeLlm()
  fake.script(run("make all", 30), { content: "Built." }, { match: closedNote("shell 1"), content: "Noted." }, {
    content: "Still here.",
  })
  const { o, end } = await notesOffice(fake)
  const { actor, sid } = await startActor(o)
  await actor.prompt("build it")
  // The command ends while the reply waits on it: its reply carries the end, so no note of it comes.
  await waitFor(() => o.pipes.commands.length === 1, { what: "the command" })
  end("make all", 0)
  await waitFor(() => texts(o, sid).includes("Built.") && status(o, sid) === "idle" && !actor.hasWorker, {
    what: "the first reply",
  })
  const id = await ownerCloses(o, sid, "shell 1")
  expect(o.office.instruments.list(sid)[0]).toMatchObject({ status: "ended" })
  // No model call reports the owner's own act: the note waits.
  await Bun.sleep(300)
  expect([fake.requests().length, actor.hasWorker, notes(o, sid)]).toEqual([2, false, []])
  await actor.prompt("what's left?")
  await waitFor(() => texts(o, sid).includes("Noted.") && status(o, sid) === "idle", { what: "the next turn" })
  expect(fake.requests()).toHaveLength(3)
  expect(asked(fake, 3, 'author="shell 1"')).toBe(true)
  expect(asked(fake, 3, "what's left?")).toBe(true)
  // The chat shows it as the shell's note, and the shell's record says who closed it.
  expect(notes(o, sid)).toEqual([closedNote("shell 1")])
  const message = o.transcript.messages(sid, session(o, sid).run_ids).find((m) => isInstrumentNote(m))
  expect(message).toMatchObject({ role: "user", author: null, instrument: { id, name: "shell 1" } })
  const meta = path.join(o.office.paths.sessionDir(sid), "terminal", id, "meta.json")
  expect(JSON.parse(fs.readFileSync(meta, "utf8"))).toMatchObject({ state: "ended", closedBy: "ngocbh" })
  // Sent once: the turn after reads it once, in the history.
  await actor.prompt("and now?")
  await waitFor(() => texts(o, sid).includes("Still here.") && status(o, sid) === "idle", { what: "the turn after" })
  expect(times(fake, 4, closedNote("shell 1"))).toBe(1)
  expect(notes(o, sid)).toEqual([closedNote("shell 1")])
})

test("the owner's close of a shell while the agent's reply runs reaches it as a steer, naming the command it stopped", async () => {
  const fake = await fakeLlm()
  fake.script(
    run("make all"),
    run("make docs", 60),
    { match: closedNote("shell 1", "make all"), content: "Shell 1 is gone." },
    { match: heading("shell 2", "make docs", 0), content: "Docs built." },
  )
  const { o, end } = await notesOffice(fake)
  const { actor, sid } = await startActor(o)
  await actor.prompt("build it")
  // The reply waits on make docs when the owner closes make all's shell.
  await waitFor(() => o.pipes.commands.length === 2, { what: "both commands" })
  await ownerCloses(o, sid, "shell 1")
  await waitFor(() => texts(o, sid).includes("Shell 1 is gone.") && status(o, sid) === "idle", { what: "the reply" })
  expect(fake.requests()).toHaveLength(3)
  expect(asked(fake, 3, closedNote("shell 1", "make all"))).toBe(true)
  // It ended the reply's wait on make docs, which runs on; make all got no note of its own.
  expect(asked(fake, 3, "Your wait ended early")).toBe(true)
  expect(notes(o, sid)).toEqual([closedNote("shell 1", "make all")])
  end("make docs", 0)
  await waitFor(() => texts(o, sid).includes("Docs built.") && status(o, sid) === "idle", { what: "the docs note" })
  expect(notes(o, sid).map((note) => note.split("\n")[0])).toEqual([
    closedNote("shell 1", "make all"),
    heading("shell 2", "make docs", 0),
  ])
})

test("a close note held while the agent rests goes once with the next note that wakes it", async () => {
  const fake = await fakeLlm()
  fake.script(run("make all"), run("make docs"), { content: "Started." }, {
    match: heading("shell 2", "make docs", 0),
    content: "Read both.",
  })
  const { o, end } = await notesOffice(fake)
  const { actor, sid } = await started(o)
  await ownerCloses(o, sid, "shell 1")
  await Bun.sleep(300)
  expect([fake.requests().length, actor.hasWorker]).toEqual([3, false])
  // make docs ends: its note wakes the agent, and the close's note goes first, with it.
  end("make docs", 0)
  await waitFor(() => texts(o, sid).includes("Read both.") && status(o, sid) === "idle", { what: "the woken turn" })
  expect(fake.requests()).toHaveLength(4)
  expect(times(fake, 4, closedNote("shell 1", "make all"))).toBe(1)
  expect(asked(fake, 4, heading("shell 2", "make docs", 0))).toBe(true)
  expect(notes(o, sid).map((note) => note.split("\n")[0])).toEqual([
    closedNote("shell 1", "make all"),
    heading("shell 2", "make docs", 0),
  ])
})

test("two commands that end together send two notes, which one model call reads", async () => {
  const fake = await fakeLlm()
  const both: ScriptedReply = {
    tool_calls: [
      { name: "terminal_run", arguments: { command: "make a", why: "builds", wait: 0 } },
      { name: "terminal_run", arguments: { command: "make b", why: "builds", wait: 0 } },
    ],
  }
  fake.script(both, { content: "Started." }, { content: "Both ended." })
  const { o, end } = await notesOffice(fake)
  const { sid } = await started(o)
  const before = o.jobs.length
  end("make a", 0)
  end("make b", 1)
  await waitFor(() => texts(o, sid).includes("Both ended.") && status(o, sid) === "idle", { what: "the woken reply" })
  // One job takes both to the run, and one turn reads them.
  expect(o.jobs.slice(before).map((job) => job.deliver.map((d) => d.op))).toEqual([["send", "send"]])
  expect(fake.requests()).toHaveLength(3)
  expect(asked(fake, 3, heading("shell 1", "make a", 0)) && asked(fake, 3, heading("shell 2", "make b", 1))).toBe(true)
  expect(notes(o, sid).map((note) => note.split("\n")[0]).sort()).toEqual([
    heading("shell 1", "make a", 0),
    heading("shell 2", "make b", 1),
  ])
})

test("after Esc a note waits for the owner's next message, and goes with it", async () => {
  const fake = await fakeLlm()
  fake.script(run("make all"), { content: "never shown", hold: true }, { content: "It built, and here's why." })
  const { o, end } = await notesOffice(fake)
  const { actor, sid } = await startActor(o)
  await actor.prompt("build it")
  await fake.waitForRequests(2, 30_000)
  await actor.interrupt()
  fake.release()
  await waitFor(() => !actor.hasWorker && status(o, sid) === "idle", { what: "the stopped turn" })
  end("make all", 0)
  await Bun.sleep(300)
  expect(fake.requests()).toHaveLength(2)
  expect(notes(o, sid)).toEqual([])
  await actor.prompt("what happened?")
  await waitFor(() => texts(o, sid).includes("It built, and here's why.") && status(o, sid) === "idle", {
    what: "the reply",
  })
  // One model call reads the note and the message.
  expect(fake.requests()).toHaveLength(3)
  expect(asked(fake, 3, heading("shell 1", "make all", 0)) && asked(fake, 3, "what happened?")).toBe(true)
  expect(notes(o, sid)).toHaveLength(1)
})

test("over the cost cap a note is held, opens no cap item, and the raise runs it", async () => {
  const fake = await fakeLlm()
  fake.script(run("make all"), { content: "Started." }, { content: "It built." })
  const { o, end } = await notesOffice(fake)
  const { actor, sid } = await started(o)
  o.office.store.updateSession(sid, { cost: 6 })
  const before = o.jobs.length
  end("make all", 0)
  await waitFor(() => o.jobs.length > before && !actor.hasWorker, { what: "the delivering job" })
  expect(o.jobs.slice(before)).toMatchObject([{ kind: "advance", advance: false, deliver: [{ op: "send" }] }])
  await Bun.sleep(200)
  expect(fake.requests()).toHaveLength(2)
  expect(capItem(o)).toBeUndefined()
  await actor.setCostCap(20)
  await waitFor(() => texts(o, sid).includes("It built.") && status(o, sid) === "idle", { what: "the reply" })
  expect(asked(fake, 3, heading("shell 1", "make all", 0))).toBe(true)
})

test("a note sent again, or a run resumed after a crash, never doubles it", async () => {
  const fake = await fakeLlm()
  fake.script(
    run("make all"),
    { content: "Started." },
    { content: "lost", hold: true },
    { content: "It built." },
  )
  const { o, end } = await notesOffice(fake)
  const { actor, sid } = await started(o)
  end("make all", 0)
  await fake.waitForRequests(3, 30_000)
  const runId = actor.runId!
  // The same note again, under its key, as a host sending it twice would: the run already has it.
  const [note] = notes(o, sid)
  const [shellId] = fs.readdirSync(path.join(o.office.paths.sessionDir(sid), "terminal"))
  actor.note(note!, `terminal:${shellId}:1`, "shell 1")
  actor.note(note!, `terminal:${shellId}:1`, "shell 1")
  await Bun.sleep(300)
  // The worker dies in the woken turn's model call: the run resumes, and reads its note once.
  o.registry.get(sid)!.kill()
  await waitFor(() => texts(o, sid).includes("It built.") && status(o, sid) === "idle", { what: "the resumed reply" })
  fake.release()
  expect(actor.runId).toBe(runId)
  expect(fake.requests()).toHaveLength(4)
  expect(loggedNotes(o, runId)).toHaveLength(1)
  expect(notes(o, sid)).toEqual([note])
  expect(JSON.stringify(fake.requests()[3]!.messages).split(heading("shell 1", "make all", 0))).toHaveLength(2)
})

test("a note never answers the model's open question: it waits in the inbox, and the answer's call reads it", async () => {
  const fake = await fakeLlm()
  fake.script(run("make all"), ASK_USER, { content: "A it is." })
  const { o, end } = await notesOffice(fake)
  const { actor, sid } = await startActor(o)
  await actor.prompt("build it")
  const q = await card(o, sid, "ask_user")
  await waitFor(() => !actor.hasWorker, { what: "the run asleep on the question" })
  end("make all", 0)
  await waitFor(() => loggedNotes(o, actor.runId!).length === 1, { what: "the note in the inbox" })
  await waitFor(() => !actor.hasWorker, { what: "the delivering worker's exit" })
  expect(o.office.store.getQuestion(q.id)!.status).toBe("open")
  expect(fake.requests()).toHaveLength(2)
  expect(await actor.prompt("A")).toBe("answer")
  await waitFor(() => texts(o, sid).includes("A it is.") && status(o, sid) === "idle", { what: "the reply" })
  expect(fake.requests()).toHaveLength(3)
  expect(asked(fake, 3, heading("shell 1", "make all", 0))).toBe(true)
  expect(o.office.store.getQuestion(q.id)!.status).toBe("consumed")
})

test("a chat that ends before a note is delivered leaves nothing behind", async () => {
  const fake = await fakeLlm()
  fake.script(run("make all"), { content: "Started." })
  const { o, end } = await notesOffice(fake)
  // A note held after Esc goes with the chat's end.
  const { actor, sid } = await started(o)
  await actor.interrupt()
  end("make all", 0)
  await Bun.sleep(200)
  await actor.end()
  await waitFor(() => session(o, sid).status === "ended", { what: "the chat's end" })
  expect(notes(o, sid)).toEqual([])
  expect(fake.requests()).toHaveLength(2)
  // A command still running when the chat ends is stopped, and nobody is told.
  const again = await fakeLlm()
  again.script(run("make more"), { content: "Started." })
  const second = await notesOffice(again)
  const other = await started(second.o)
  await other.actor.end()
  await waitFor(() => session(second.o, other.sid).status === "ended", { what: "the second chat's end" })
  expect(() => second.end("make more", 0)).toThrow("isn't running")
  await Bun.sleep(200)
  expect(notes(second.o, other.sid)).toEqual([])
  expect(loggedNotes(second.o, other.actor.runId!)).toEqual([])
})

test("Esc holds a note already in the inbox, and the owner's queued messages go on in order, each shown once", async () => {
  const fake = await fakeLlm()
  fake.script(run("make all"), { content: "never shown", hold: true }, { content: "On both." }, { content: "Built too." })
  const { o, end } = await notesOffice(fake)
  const { actor, sid } = await startActor(o)
  await actor.prompt("build it")
  await fake.waitForRequests(2, 30_000)
  // While the model answers: the note, then two messages of the owner's, all unread when Esc comes.
  end("make all", 0)
  await waitFor(() => loggedNotes(o, actor.runId!).length === 1, { what: "the note in the inbox" })
  expect(await actor.prompt("first")).toBe("steer")
  expect(await actor.prompt("second")).toBe("steer")
  await actor.interrupt()
  fake.release()
  await waitFor(() => texts(o, sid).includes("On both.") && status(o, sid) === "idle" && !actor.hasWorker, {
    what: "the owner's messages answered",
  })
  // The next call reads the owner's messages, in order, and no note.
  const third = JSON.stringify(fake.requests()[2]!.messages)
  expect(third.indexOf("first")).toBeGreaterThan(-1)
  expect(third.indexOf("first")).toBeLessThan(third.indexOf("second"))
  expect(asked(fake, 3, heading("shell 1", "make all", 0))).toBe(false)
  await Bun.sleep(300)
  expect(fake.requests()).toHaveLength(3)
  // Each shows once, and the clients were told to drop what was taken back.
  expect(texts(o, sid, "user").filter((text) => text === "first" || text === "second")).toEqual(["first", "second"])
  expect(notes(o, sid)).toEqual([])
  expect(o.lives.filter((e) => e.type === "message.removed" && e.session_id === sid)).toHaveLength(3)
  // The note goes with the owner's next message.
  await actor.prompt("and the build?")
  await waitFor(() => texts(o, sid).includes("Built too.") && status(o, sid) === "idle", { what: "the reply" })
  expect(fake.requests()).toHaveLength(4)
  expect(asked(fake, 4, heading("shell 1", "make all", 0)) && asked(fake, 4, "and the build?")).toBe(true)
  expect(notes(o, sid)).toHaveLength(1)
})

test("Esc takes back the queue's messages too, so the turn after it reads the owner's steers and queued ones in order", async () => {
  const fake = await fakeLlm()
  fake.script(run("make all"), { content: "never shown", hold: true }, { content: "In order." })
  const { o, end } = await notesOffice(fake)
  const { actor, sid } = await startActor(o)
  await actor.prompt("build it")
  await fake.waitForRequests(2, 30_000)
  end("make all", 0)
  await waitFor(() => loggedNotes(o, actor.runId!).length === 1, { what: "the note in the inbox" })
  expect(await actor.prompt("first")).toBe("steer")
  expect(await actor.queue("later")).toBe("queued")
  expect(await actor.prompt("second")).toBe("steer")
  await actor.interrupt()
  fake.release()
  await waitFor(() => texts(o, sid).includes("In order.") && status(o, sid) === "idle" && !actor.hasWorker, {
    what: "the owner's messages answered",
  })
  const third = JSON.stringify(fake.requests()[2]!.messages)
  const at = ["first", "later", "second"].map((text) => third.indexOf(text))
  expect(at.every((i) => i > -1)).toBe(true)
  expect(at).toEqual([...at].sort((a, b) => a - b))
  expect(asked(fake, 3, heading("shell 1", "make all", 0))).toBe(false)
  // Each shows once, read, in the order sent.
  expect(texts(o, sid, "user").filter((text) => ["first", "later", "second"].includes(text))).toEqual([
    "first",
    "later",
    "second",
  ])
})

test("Esc on the model's question holds the note waiting behind it", async () => {
  const fake = await fakeLlm()
  fake.script(run("make all"), ASK_USER, { content: "Going on; it built." })
  const { o, end } = await notesOffice(fake)
  const { actor, sid } = await startActor(o)
  await actor.prompt("build it")
  const q = await card(o, sid, "ask_user")
  await waitFor(() => !actor.hasWorker, { what: "the run asleep on the question" })
  end("make all", 0)
  await waitFor(() => loggedNotes(o, actor.runId!).length === 1, { what: "the note in the inbox" })
  await waitFor(() => !actor.hasWorker, { what: "the delivering worker's exit" })
  await actor.interrupt({ question: q.id })
  await waitFor(() => !actor.hasWorker && status(o, sid) === "idle", { what: "the stopped turn" })
  await Bun.sleep(300)
  expect(fake.requests()).toHaveLength(2)
  expect(o.office.store.getQuestion(q.id)!.status).not.toBe("open")
  await actor.prompt("go on")
  await waitFor(() => texts(o, sid).includes("Going on; it built.") && status(o, sid) === "idle", { what: "the reply" })
  expect(fake.requests()).toHaveLength(3)
  expect(asked(fake, 3, heading("shell 1", "make all", 0)) && asked(fake, 3, "go on")).toBe(true)
})

test("after Esc, a card answer that resumes the agent takes the held notes with it", async () => {
  const fake = await fakeLlm()
  fake.script(run("make all"), { content: "never shown", hold: true }, ASK_USER, { content: "A, and it built." })
  const { o, end } = await notesOffice(fake)
  const { actor, sid } = await startActor(o)
  await actor.prompt("build it")
  await fake.waitForRequests(2, 30_000)
  // The owner's queued message goes on after Esc, and the agent asks them.
  expect(await actor.prompt("then ask me")).toBe("steer")
  await actor.interrupt()
  fake.release()
  const q = await card(o, sid, "ask_user")
  end("make all", 0)
  await Bun.sleep(300)
  expect(notes(o, sid)).toEqual([])
  await actor.answer(q.id, "A", "option")
  await waitFor(() => texts(o, sid).includes("A, and it built.") && status(o, sid) === "idle", { what: "the reply" })
  expect(fake.requests()).toHaveLength(4)
  expect(asked(fake, 4, heading("shell 1", "make all", 0))).toBe(true)
})

test("a restart while a command runs on holds a note of it for the next message, and none is ever doubled", async () => {
  const fake = await fakeLlm()
  const both: ScriptedReply = {
    tool_calls: [
      { name: "terminal_run", arguments: { command: "make all", why: "builds", wait: 0 } },
      { name: "terminal_run", arguments: { command: "make docs", why: "builds", wait: 0 } },
    ],
  }
  fake.script(both, { content: "Started." }, { content: "Docs done." }, { content: "Noted." }, { content: "Again." })
  const { o, end } = await notesOffice(fake)
  const { actor: first, sid } = await started(o)
  // make docs ends and its note is sent; make all still runs when the office stops.
  end("make docs", 0)
  await waitFor(() => texts(o, sid).includes("Docs done.") && status(o, sid) === "idle", { what: "the docs note's turn" })
  const restarted = await reopen(o, first)
  await restarted.restore()
  await Bun.sleep(300)
  expect(fake.requests()).toHaveLength(3)
  await restarted.prompt("hello")
  await waitFor(() => texts(o, sid).includes("Noted.") && status(o, sid) === "idle", { what: "the reply" })
  const gone = "shell 1 (gone): `make all` ended with no exit code: it was stopped, maybe when the office stopped"
  expect(asked(fake, 4, gone) && asked(fake, 4, "hello")).toBe(true)
  // The docs note, already sent, isn't sent again.
  expect(notes(o, sid).map((note) => note.split("\n")[0])).toEqual([heading("shell 2", "make docs", 0), gone])
  // Another restart: the same notes, under the same keys, append nothing.
  const again = await reopen(o, restarted)
  await again.restore()
  await again.prompt("again")
  await waitFor(() => texts(o, sid).includes("Again.") && status(o, sid) === "idle", { what: "the last reply" })
  expect(notes(o, sid)).toHaveLength(2)
})

test("a message sent just after Esc goes after the owner's messages Esc took back", async () => {
  const fake = await fakeLlm()
  fake.script(run("make all"), { content: "never shown", hold: true }, { content: "On both." })
  const { o, end } = await notesOffice(fake)
  const { actor, sid } = await startActor(o)
  await actor.prompt("build it")
  await fake.waitForRequests(2, 30_000)
  end("make all", 0)
  await waitFor(() => loggedNotes(o, actor.runId!).length === 1, { what: "the note in the inbox" })
  expect(await actor.prompt("first")).toBe("steer")
  // Esc, and the next message at once, before the run has answered the withdraw.
  const stopped = actor.interrupt()
  const second = actor.prompt("second")
  await stopped
  fake.release()
  await second
  await waitFor(() => texts(o, sid).includes("On both.") && status(o, sid) === "idle" && !actor.hasWorker, {
    what: "the messages answered",
  })
  const third = JSON.stringify(fake.requests()[2]!.messages)
  expect(third.indexOf("first")).toBeGreaterThan(-1)
  expect(third.indexOf("first")).toBeLessThan(third.indexOf("second"))
  // The message after Esc takes the note with it.
  expect(asked(fake, 3, heading("shell 1", "make all", 0))).toBe(true)
  expect(texts(o, sid, "user").filter((text) => text === "first" || text === "second")).toEqual(["first", "second"])
  // What Esc took back goes again as its sender's: each of the owner's sends names who sent it, a note no one.
  const sends = fs
    .readFileSync(path.join(o.office.paths.runs, actor.runId!, "log.jsonl"), "utf8")
    .split("\n")
    .filter((line) => line.includes('"key":"__start__.messages"'))
    .map((line) => (JSON.parse(line) as { payload: { send_key?: string; by?: { name: string } } }).payload)
  const kind = (key: string | undefined) => (key === undefined ? "message" : key.startsWith("terminal:") ? "note" : key)
  const owner = sends[0]!.by!.name
  expect(sends.map((send) => [kind(send.send_key?.replace(/:.*/, ":")), send.by?.name ?? null])).toEqual([
    ["message", owner], ["note", null], ["message", owner], ["note", null], ["withdrawn:", owner], ["message", owner],
  ])
})

test("a worker that dies between applying Esc's withdraw and answering it loses none of the owner's messages", async () => {
  const fake = await fakeLlm()
  fake.script(run("make all"), { content: "never shown", hold: true }, ...Array.from({ length: 4 }, () => ({ content: "ok" })))
  const { o, end } = await notesOffice(fake)
  // The withdraw's answer never reaches the office: its worker dies first.
  let died = false
  const dying = (handlers: WorkerHandlers<Worker>) => {
    const reply = handlers.deliverReply.bind(handlers)
    handlers.deliverReply = (w, frame) => {
      if (!died && Array.isArray(frame.withdrawn)) {
        died = true
        w.kill()
        return
      }
      reply(w, frame)
    }
    return handlers
  }
  const { spawn, next } = o.registry
  o.registry.spawn = (job, sessionDir, handlers, options) => spawn(job, sessionDir, dying(handlers), options)
  o.registry.next = (worker, job, handlers) => next(worker, job, dying(handlers))
  const { actor, sid } = await startActor(o)
  await actor.prompt("build it")
  await fake.waitForRequests(2, 30_000)
  end("make all", 0)
  await waitFor(() => loggedNotes(o, actor.runId!).length === 1, { what: "the note in the inbox" })
  expect(await actor.prompt("first")).toBe("steer")
  await actor.interrupt().catch(() => {})
  await waitFor(() => died, { what: "the worker's death" })
  const answered = () => fake.requests().some((r) => JSON.stringify(r.messages).includes("first"))
  await waitFor(() => answered() && status(o, sid) === "idle" && !actor.hasWorker, {
    timeout: 30_000,
    what: "the owner's message answered",
  })
  fake.release()
  expect(texts(o, sid, "user").filter((text) => text === "first")).toEqual(["first"])
  expect(fake.requests().some((r) => JSON.stringify(r.messages).includes(heading("shell 1", "make all", 0)))).toBe(false)
  // The note waits for the owner's next message.
  const before = fake.requests().length
  await actor.prompt("and the build?")
  await waitFor(() => fake.requests().length > before && status(o, sid) === "idle", { what: "the reply" })
  expect(JSON.stringify(fake.requests().at(-1)!.messages)).toContain(heading("shell 1", "make all", 0))
})

test("a delivered note is owed no more: after a model switch and a restart, it isn't sent again", async () => {
  const fake = await fakeLlm()
  fake.script(run("make all"), { content: "Started." }, { content: "It built." }, { content: "On two." }, { content: "Again." })
  const { o, end } = await notesOffice(fake, { second: "stub-2" })
  const { actor: first, sid } = await started(o)
  end("make all", 0)
  await waitFor(() => texts(o, sid).includes("It built.") && status(o, sid) === "idle", { what: "the woken turn" })
  await first.setModel("second", "stub-2")
  await first.prompt("on two")
  await waitFor(() => texts(o, sid).includes("On two.") && status(o, sid) === "idle", { what: "the fresh run's reply" })
  expect(session(o, sid).run_ids).toHaveLength(2)
  const restarted = await reopen(o, first)
  await restarted.restore()
  await restarted.prompt("again")
  await waitFor(() => texts(o, sid).includes("Again.") && status(o, sid) === "idle", { what: "the last reply" })
  expect(notes(o, sid)).toHaveLength(1)
  expect(asked(fake, 5, "(gone)")).toBe(false)
})

test("a note unread at a model switch arrives in the new run signed by its shell, exactly once", async () => {
  const fake = await fakeLlm()
  fake.script(run("make all"), ASK_USER, { match: heading("shell 1", "make all", 0), content: "On two." }, { content: "Again." })
  const { o, end } = await notesOffice(fake, { second: "stub-2" })
  const { actor, sid } = await startActor(o)
  await actor.prompt("build it")
  await card(o, sid, "ask_user")
  await waitFor(() => !actor.hasWorker, { what: "the run asleep on the question" })
  // The note waits unread in the inbox behind the question when the owner switches the model.
  end("make all", 0)
  const old = actor.runId!
  await waitFor(() => loggedNotes(o, old).length === 1, { what: "the note in the inbox" })
  await waitFor(() => !actor.hasWorker, { what: "the delivering worker's exit" })
  await actor.setModel("second", "stub-2")
  await waitFor(() => texts(o, sid).includes("On two.") && status(o, sid) === "idle", { what: "the fresh run's reply" })
  const fresh = actor.runId!
  expect(fresh).not.toBe(old)
  // The fresh run has it under the shell's key, and the model reads it signed by the shell.
  expect(loggedNotes(o, fresh)).toHaveLength(1)
  expect(asked(fake, 3, 'author="shell 1"')).toBe(true)
  const shown = o.transcript
    .messages(sid, session(o, sid).run_ids)
    .filter((m) => m.parts.some((part) => part.type === "text" && part.text.startsWith(heading("shell 1", "make all", 0))))
  expect(shown.map((m) => [m.role, m.author, m.instrument?.name ?? null])).toEqual([["user", null, "shell 1"]])
  // A restart sends nothing again.
  const restarted = await reopen(o, actor)
  await restarted.restore()
  await restarted.prompt("again")
  await waitFor(() => texts(o, sid).includes("Again.") && status(o, sid) === "idle", { what: "the last reply" })
  expect(notes(o, sid)).toHaveLength(1)
  expect(loggedNotes(o, fresh)).toHaveLength(1)
})

test("after Esc, a model switch moves none of what Esc took back: each message and the note reach the model once", async () => {
  const fake = await fakeLlm()
  fake.script(run("make all"), { content: "never shown", hold: true }, { content: "On both." }, { content: "On two." })
  const { o, end } = await notesOffice(fake, { second: "stub-2" })
  const { actor, sid } = await startActor(o)
  await actor.prompt("build it")
  await fake.waitForRequests(2, 30_000)
  // While the model answers: the note, then two messages of the owner's, all unread when Esc takes them back.
  end("make all", 0)
  await waitFor(() => loggedNotes(o, actor.runId!).length === 1, { what: "the note in the inbox" })
  expect(await actor.prompt("msg-one")).toBe("steer")
  expect(await actor.prompt("msg-two")).toBe("steer")
  await actor.interrupt()
  fake.release()
  await waitFor(() => texts(o, sid).includes("On both.") && status(o, sid) === "idle" && !actor.hasWorker, {
    what: "the owner's messages answered",
  })
  // The fresh run on the new model reads the old turns once, and the held note once, with the next message.
  await actor.setModel("second", "stub-2")
  await actor.prompt("and the build?")
  await waitFor(() => texts(o, sid).includes("On two.") && status(o, sid) === "idle", { what: "the fresh run's reply" })
  expect(session(o, sid).run_ids).toHaveLength(2)
  const fourth = JSON.stringify(fake.requests()[3]!.messages)
  const count = (text: string) => fourth.split(JSON.stringify(text).slice(1, -1)).length - 1
  expect([count("msg-one"), count("msg-two"), count(heading("shell 1", "make all", 0)), count("and the build?")]).toEqual([
    1, 1, 1, 1,
  ])
  expect(texts(o, sid, "user").filter((text) => text.startsWith("msg-"))).toEqual(["msg-one", "msg-two"])
  expect(notes(o, sid)).toHaveLength(1)
})

/** Codex as a chat's instrument opens it, scripted in this process: each message starts a turn, or joins the one under
 *  way, which runs until the test answers it (`answer`). `threads` are the sessions opened, by id. */
function scriptedCodex() {
  const threads = new Map<string, { events: ThreadEvents; busy: boolean }>()
  let n = 0
  const message = (sid: string, role: "user" | "assistant", text: string, author: string | null) => ({
    id: `m${++n}`, session_id: sid, role, author, parts: [{ id: `p${n}`, type: "text" as const, text }],
    created_at: new Date().toISOString(),
  })
  const open = async (_chat: SessionRecord, id: string, o: { observer: ThreadEvents }) => {
    threads.set(id, { events: o.observer, busy: false })
    o.observer.state("idle")
  }
  /** Codex answers `text`, and its turn under way ends. */
  const answer = (text: string) => {
    for (const [id, thread] of threads) {
      if (!thread.busy) continue
      thread.events.event({ type: "message", message: message(id, "assistant", text, null) })
      thread.busy = false
      thread.events.state("idle")
    }
  }
  const sessions: InstrumentSessions = {
    store: { getSession: (id: string) => ({ harness_session_id: `thr-${id}` }) as SessionRecord },
    log: () => {},
    startInstrument: open,
    resumeInstrument: (chat, id, _thread, o) => open(chat, id, o),
    resumable: () => {},
    prompt: async (id, text, { by }) => {
      const thread = threads.get(id)!
      thread.events.event({ type: "message", message: message(id, "user", text, by) })
      if (!thread.busy) {
        thread.busy = true
        thread.events.state("busy")
      }
      return "turn"
    },
    interrupt: async () => answer("Half done.\n\n[interrupted]"),
    end: async (id) => threads.get(id)?.events.state("ended"),
  }
  const busy = () => [...threads.values()].some((thread) => thread.busy)
  /** The instruments made, the latest last. */
  const made: EmployeeCodex[] = []
  /** The chat's Codex instrument over these sessions, for chatOffice's spec. */
  const make = async (session: SessionRecord, folder: string, office: ChatOffice["office"]) => {
    const repo = loadRepo(await office.git.pin(session.repo_commit))
    const instrument = new EmployeeCodex({
      chat: session, sessions, folder, instruments: office.instruments, speakers: speakers(repo, session),
    })
    made.push(instrument)
    return instrument
  }
  return { threads, answer, busy, make, made }
}

/** An office whose minh may run `make *` (`notesOffice`'s), and drives scripted Codex sessions. */
async function codexOffice(fake: Awaited<ReturnType<typeof fakeLlm>>) {
  const codex = scriptedCodex()
  const rules = stringify({ rules: [{ effect: "allow", kind: "command", pattern: "make *" }] })
  const o = await chatOffice(fake, { files: { "people/minh/rules.yaml": rules }, codexInstrument: codex.make })
  const ends = new Map<string, (result: { exit: number | null }) => void>()
  o.pipes.run = (command, signal) =>
    new Promise((resolve) => {
      ends.set(command, resolve)
      signal.addEventListener("abort", () => resolve({ exit: null }), { once: true })
    })
  const end = (command: string, exit: number) => ends.get(command)?.({ exit })
  return { o, codex, end }
}

/** A model turn that starts a Codex session with `message`, waiting `wait` seconds for its turn. */
function startCodex(message: string, wait: number): ScriptedReply {
  return { tool_calls: [{ name: "codex_start", arguments: { message, wait } }] }
}

/** The log lines of run `runId` of `o` that commit a Codex session's note to an inbox. */
function loggedCodexNotes(o: ChatOffice, runId: string): string[] {
  return fs
    .readFileSync(path.join(o.office.paths.runs, runId, "log.jsonl"), "utf8")
    .split("\n")
    .filter((line) => line.includes('"kind":"pool_commit"') && line.includes('"send_key":"codex:'))
}

const CODEX_DONE = "codex 1: the turn on `Fix the build.` completed"

test("a Codex turn that ends while the agent's reply runs steers it once, signed by the session, and ends its wait", async () => {
  const fake = await fakeLlm()
  fake.script(startCodex("Fix the build.", 0), run("make docs", 120), { match: CODEX_DONE, content: "Codex fixed it." })
  const { o, codex } = await codexOffice(fake)
  const { actor, sid } = await startActor(o)
  await actor.prompt("hand the build to Codex")
  // The reply waits on make docs when Codex's turn ends.
  await waitFor(() => o.pipes.commands.length === 1 && codex.busy(), { what: "make docs, with Codex at work" })
  const at = performance.now()
  codex.answer("Fixed: the test passes.")
  await waitFor(() => texts(o, sid).includes("Codex fixed it.") && status(o, sid) === "idle", { what: "the reply" })
  // The note's arrival ended the 120-second wait at once; make docs runs on.
  expect(performance.now() - at).toBeLessThan(10_000)
  expect(o.pipes.commands).toEqual(["make docs"])
  expect(fake.requests()).toHaveLength(3)
  expect(asked(fake, 3, CODEX_DONE)).toBe(true)
  expect(asked(fake, 3, 'author="codex 1"')).toBe(true)
  expect(asked(fake, 3, "Your wait ended early")).toBe(true)
  expect(loggedCodexNotes(o, actor.runId!)).toHaveLength(1)
  const message = o.transcript.messages(sid, session(o, sid).run_ids).find((m) => isInstrumentNote(m))
  const [listed] = o.office.instruments.list(sid).filter((i) => i.kind === "codex")
  expect(message).toMatchObject({ role: "user", author: null, instrument: { id: listed!.id, name: "codex 1" } })
  expect(session(o, sid).turns).toBe(1)
})

test("a Codex turn that ends while the agent rests wakes it once with the turn's note", async () => {
  const fake = await fakeLlm()
  fake.script(startCodex("Fix the build.", 0), { content: "Codex is on it." }, { match: CODEX_DONE, content: "Done." })
  const { o, codex } = await codexOffice(fake)
  const { actor, sid } = await startActor(o)
  await actor.prompt("hand the build to Codex")
  await waitFor(() => texts(o, sid).includes("Codex is on it.") && status(o, sid) === "idle" && !actor.hasWorker, {
    what: "the first reply",
  })
  codex.answer("Fixed: the test passes.")
  await waitFor(() => texts(o, sid).includes("Done.") && status(o, sid) === "idle", { what: "the woken reply" })
  await Bun.sleep(300)
  expect(fake.requests()).toHaveLength(3)
  expect(notes(o, sid).map((note) => note.split("\n")[0])).toEqual([CODEX_DONE])
  expect(notes(o, sid)[0]).toContain("Fixed: the test passes.")
})

test("no note when the agent waited on the turn and its reply carried the end", async () => {
  const fake = await fakeLlm()
  fake.script(startCodex("Fix the build.", 60), { content: "Codex fixed it." })
  const { o, codex } = await codexOffice(fake)
  const { actor, sid } = await startActor(o)
  await actor.prompt("hand the build to Codex")
  await waitFor(() => codex.busy(), { what: "Codex at work" })
  codex.answer("Fixed: the test passes.")
  await waitFor(() => texts(o, sid).includes("Codex fixed it.") && status(o, sid) === "idle", { what: "the reply" })
  await Bun.sleep(300)
  expect(fake.requests()).toHaveLength(2)
  expect(asked(fake, 2, "Fixed: the test passes.")).toBe(true)
  expect(notes(o, sid)).toEqual([])
})

test("the owner's message ends a 120-second wait on Codex within a second; Codex's turn goes on and its note still comes", async () => {
  const fake = await fakeLlm()
  fake.script(
    { tool_calls: [{ name: "codex_start", arguments: { message: "Fix the build.", wait: 120 } }] },
    { match: "Use the staging database.", content: "I'll tell Codex." },
    { match: CODEX_DONE, content: "Codex fixed it." },
  )
  const { o, codex } = await codexOffice(fake)
  const { actor, sid } = await startActor(o)
  await actor.prompt("hand the build to Codex")
  await waitFor(() => codex.busy(), { what: "Codex at work" })
  const at = performance.now()
  expect(await actor.prompt("Use the staging database.")).toBe("steer")
  await waitFor(() => fake.requests().length === 2, { what: "the next model call" })
  expect(performance.now() - at).toBeLessThan(1_500)
  expect(asked(fake, 2, "Your wait ended early")).toBe(true)
  expect(codex.busy()).toBe(true)
  await waitFor(() => texts(o, sid).includes("I'll tell Codex.") && status(o, sid) === "idle", { what: "the reply" })
  codex.answer("Fixed: the test passes.")
  await waitFor(() => texts(o, sid).includes("Codex fixed it.") && status(o, sid) === "idle", { what: "the woken reply" })
  expect(notes(o, sid).map((note) => note.split("\n")[0])).toEqual([CODEX_DONE])
})

test("the owner's message ends a 120-second wait on a command within a second; the command runs on", async () => {
  const fake = await fakeLlm()
  fake.script(run("make all", 120), { match: "Stop and look at this.", content: "Looking." }, {
    match: heading("shell 1", "make all", 0), content: "It built.",
  })
  const { o, end } = await notesOffice(fake)
  const { actor, sid } = await startActor(o)
  await actor.prompt("build it")
  await waitFor(() => o.pipes.commands.length === 1, { what: "the command" })
  const at = performance.now()
  await actor.prompt("Stop and look at this.")
  await waitFor(() => fake.requests().length === 2, { what: "the next model call" })
  expect(performance.now() - at).toBeLessThan(1_500)
  expect(asked(fake, 2, "Your wait ended early") && asked(fake, 2, "Stop and look at this.")).toBe(true)
  await waitFor(() => texts(o, sid).includes("Looking.") && status(o, sid) === "idle", { what: "the reply" })
  // The command was never stopped, and its note comes when it ends.
  end("make all", 0)
  await waitFor(() => texts(o, sid).includes("It built.") && status(o, sid) === "idle", { what: "the woken reply" })
  expect(o.pipes.commands).toEqual(["make all"])
  expect(notes(o, sid).map((note) => note.split("\n")[0])).toEqual([heading("shell 1", "make all", 0)])
})

test("a command waited on in a read ends that read with no note, so its own end never ends the wait early", async () => {
  const fake = await fakeLlm()
  const read: ScriptedReply = { tool_calls: [{ name: "terminal_read", arguments: { shell: "shell 1", wait: 120 } }] }
  fake.script(run("make all"), read, { content: "It built." })
  const { o, end } = await notesOffice(fake)
  const { actor, sid } = await startActor(o)
  await actor.prompt("build it")
  await waitFor(() => fake.requests().length === 2, { what: "the read" })
  await Bun.sleep(100)
  end("make all", 0, "built\n")
  await waitFor(() => texts(o, sid).includes("It built.") && status(o, sid) === "idle", { what: "the reply" })
  await Bun.sleep(300)
  expect(fake.requests()).toHaveLength(3)
  expect(asked(fake, 3, "built")).toBe(true)
  expect(asked(fake, 3, "Your wait ended early")).toBe(false)
  expect(notes(o, sid)).toEqual([])
})

test("a restart while Codex works holds a note of the turn it stopped for the next message, never doubled", async () => {
  const fake = await fakeLlm()
  fake.script(startCodex("Fix the build.", 0), { content: "Codex is on it." }, { content: "Noted." }, { content: "Again." })
  const { o } = await codexOffice(fake)
  const { actor, sid } = await startActor(o)
  await actor.prompt("hand the build to Codex")
  await waitFor(() => texts(o, sid).includes("Codex is on it.") && status(o, sid) === "idle", { what: "the first reply" })
  const restarted = await reopen(o, actor)
  await restarted.restore()
  await Bun.sleep(300)
  // Held, not a wake: the agent hears of it with the next message.
  expect(fake.requests()).toHaveLength(2)
  await restarted.prompt("hello")
  await waitFor(() => texts(o, sid).includes("Noted.") && status(o, sid) === "idle", { what: "the reply" })
  const stopped = "codex 1: its turn was stopped when the office stopped"
  expect(asked(fake, 3, stopped) && asked(fake, 3, "hello")).toBe(true)
  expect(asked(fake, 3, 'author="codex 1"')).toBe(true)
  expect(notes(o, sid).map((note) => note.split("\n")[0])).toEqual([stopped])
  // Delivered, it is owed no more: another restart sends nothing again.
  const again = await reopen(o, restarted)
  await again.restore()
  await again.prompt("again")
  await waitFor(() => texts(o, sid).includes("Again.") && status(o, sid) === "idle", { what: "the last reply" })
  expect(notes(o, sid)).toHaveLength(1)
})

test("Esc holds a Codex note already in the inbox, and it goes with the owner's next message, still the session's", async () => {
  const fake = await fakeLlm()
  fake.script(startCodex("Fix the build.", 0), { content: "never shown", hold: true }, { content: "Codex fixed it." })
  const { o, codex } = await codexOffice(fake)
  const { actor, sid } = await startActor(o)
  await actor.prompt("hand the build to Codex")
  await fake.waitForRequests(2, 30_000)
  // While the model answers, Codex's turn ends: its note waits unread in the inbox when Esc comes.
  codex.answer("Fixed: the test passes.")
  await waitFor(() => loggedCodexNotes(o, actor.runId!).length === 1, { what: "the note in the inbox" })
  await actor.interrupt()
  fake.release()
  await waitFor(() => !actor.hasWorker && status(o, sid) === "idle", { what: "the stopped turn" })
  await Bun.sleep(300)
  expect(fake.requests()).toHaveLength(2)
  expect(notes(o, sid)).toEqual([])
  await actor.prompt("what did Codex say?")
  await waitFor(() => texts(o, sid).includes("Codex fixed it.") && status(o, sid) === "idle", { what: "the reply" })
  expect(asked(fake, 3, CODEX_DONE) && asked(fake, 3, 'author="codex 1"')).toBe(true)
  expect(notes(o, sid).map((note) => note.split("\n")[0])).toEqual([CODEX_DONE])
})

test("one message ends a terminal wait and a Codex wait together; the command and the turn go on", async () => {
  const fake = await fakeLlm()
  fake.script(startCodex("Fix the build.", 0), run("make all", 120), { match: "Look here.", content: "Looking." })
  const { o, codex } = await codexOffice(fake)
  const { actor, sid } = await startActor(o)
  await actor.prompt("hand the build to Codex, and build")
  await waitFor(() => o.pipes.commands.length === 1 && codex.busy(), { what: "make all, with Codex at work" })
  // Another wait on Codex at the same time, on the chat's instrument: the model's calls run one at a time.
  const reading = codex.made.at(-1)!.tools().history.call({ codex: "codex 1", wait: 120 })
  await Bun.sleep(50)
  const at = performance.now()
  await actor.prompt("Look here.")
  const history = JSON.parse(String(await reading)) as Record<string, string>
  await waitFor(() => fake.requests().length === 3, { what: "the next model call" })
  expect(performance.now() - at).toBeLessThan(1_500)
  expect(history.note).toContain("Your wait ended early")
  expect(asked(fake, 3, "Your wait ended early") && asked(fake, 3, "Look here.")).toBe(true)
  await waitFor(() => texts(o, sid).includes("Looking.") && status(o, sid) === "idle", { what: "the reply" })
  expect([o.pipes.commands, codex.busy()]).toEqual([["make all"], true])
})
